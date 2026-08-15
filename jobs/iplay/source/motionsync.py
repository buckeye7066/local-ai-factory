"""Audio -> motion-timing engine for instrumental motion-sync.

Given an uploaded instrumental track, derive the temporal grid that an avatar's
gross motion (strum / key-press / bow) should align to: tempo, beat times, and
note-onset times. Instrument-agnostic: this knows nothing about which instrument
is playing. The per-instrument part is the stroke-period detector already living
in analyze.ps1 (frame-difference autocorrelation on a real-playing reference clip);
this plan feeds the downstream retime/cut decision.

No avatar rendering here. This is the free, local, shared foundation used by every
downstream rendering path (generic retimed player / Runway motion-transfer /
HeyGen cinematic_avatar). The only paid, optional stage is putting a specific
face/avatar on the player downstream.

CLI:
    python motionsync.py <audio>            -> prints timing JSON to stdout
"""
from __future__ import annotations

import json
import sys

import numpy as np
import librosa

DEFAULT_SR = 22050  # enough for tempo/onset; keeps frame rate ~43 Hz at hop 512

# onset threshold as a fraction of the envelope's robust dynamic range. Tuned
# against a ground-truth synthetic control: delta=0.03 of the (p5..p99) range
# recovered 87% of programmed onsets within 50 ms with ZERO false onsets, where
# librosa's auto-delta recovered only 71%. A percentile range (not max-min)
# keeps one huge transient on a real track from raising the floor so high it
# drops every quieter note.
ONSET_DELTA_FRAC = 0.03

# Tempo-drift threshold (relative change in median inter-beat interval between
# the first and last third of the clip) above which the global-timebase policies
# (warp / loop) are abandoned for per-bar "cut". Rationale: the verification
# harness treats a stroke as "on the beat" within 50 ms. A globally-stretched
# render matched to the clip's MEAN tempo mis-times the ends of the clip by
# roughly (drift/2) x IBI per beat there; at a typical 0.5 s IBI, 5% drift puts
# end-of-clip strokes ~12-25 ms off and accelerating past the 50 ms tolerance
# within a few bars — so 0.05 is where accumulated slip starts to become
# visible, while beat-tracker jitter on genuinely steady tracks stays well
# below it.
TEMPO_DRIFT_THRESHOLD = 0.05

# strokes-per-beat prior per instrument. All default to 1.0 today; kept as a
# per-instrument table so e.g. guitar 8th-note strumming (2.0) is a one-line tune.
STROKES_PER_BEAT = {
    "piano": 1.0,
    "guitar": 1.0,
    "violin": 1.0,
}


def analyze_audio(path: str, sr: int = DEFAULT_SR) -> dict:
    """Return a timing plan for an uploaded track.

    - bpm            : estimated tempo (beats/minute). Beat trackers can lock to
                       an octave; callers may check x2 / /2 against the track.
    - beats          : beat times (s).
    - onset_times    : note-onset times (s). NOT onset_backtrack'd: backtracking
                       shifts events to the envelope's pre-attack minimum, which
                       on this control COST 22 recall points @50 ms (it led the
                       strike by ~20-60 ms). The untracked onset sits at the
                       transient peak, which tracks the strike moment better.
    - onset_strength : per-onset onset-strength value (for ranking which to
                       honor; a quiet syncopated note may sit below a stroke
                       threshold downstream).
    - duration_s     : signal length in seconds.
    """
    y, _ = librosa.load(path, sr=sr, mono=True)
    duration = float(len(y) / sr)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    hi = float(np.percentile(onset_env, 99))
    lo = float(np.percentile(onset_env, 5))
    delta = max(ONSET_DELTA_FRAC * (hi - lo), 1e-6)
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, delta=delta)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    onset_strength = onset_env[onset_frames].astype(float).tolist()

    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, units="frames"
    )
    beats = librosa.frames_to_time(beat_frames, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    return {
        "path": path,
        # The analysis timeline is intentionally mono/low-bandwidth, but its
        # integer sample clock makes every edit boundary reproducible.  The
        # deliverable later maps the untouched original media as its master
        # soundtrack; this field does not describe final audio quality.
        "sample_rate": int(sr),
        "duration_s": round(duration, 4),
        "bpm": round(bpm, 3),
        "beats": [round(float(t), 4) for t in beats],
        "onset_times": [round(float(t), 4) for t in onset_times],
        "onset_strength": [round(float(s), 4) for s in onset_strength],
    }


def _tempo_drift(beats) -> float:
    """Relative change in median inter-beat interval, first third vs last third.

    Chosen over the coefficient of variation of all IBIs because CV conflates
    two very different things: beat-tracker jitter (random, per-beat, harmless
    to a global stretch) and systematic tempo movement (accelerando/ritardando,
    which is what breaks warp/loop). Comparing the MEDIAN IBI of the first third
    of the clip against the last third measures only the systematic component
    and the median makes each side robust to a few mis-tracked beats.

    Returns |median_ibi_last_third - median_ibi_first_third| / overall median.
    Raises ValueError for fewer than 2 beats (no interval exists).
    """
    beats = np.asarray(list(beats), dtype=float)
    if beats.size < 2:
        raise ValueError(
            f"need at least 2 beats to measure tempo drift, got {beats.size}; "
            "the track is too short/degenerate for an alignment plan"
        )
    ibis = np.diff(beats)
    overall = float(np.median(ibis))
    if overall <= 0:
        raise ValueError("non-increasing beat times: inter-beat intervals must be positive")
    if ibis.size < 3:
        # not enough intervals to form two thirds; compare the endpoints.
        return float(abs(ibis[-1] - ibis[0]) / overall)
    third = max(1, ibis.size // 3)
    first = float(np.median(ibis[:third]))
    last = float(np.median(ibis[-third:]))
    return float(abs(last - first) / overall)


def choose_policy(timing: dict, instrument: str) -> dict:
    """Pick the retime policy ("warp" | "loop" | "cut") for an instrument.

    Drift measure: relative spread between the median inter-beat interval of
    the first third and last third of ``timing["beats"]`` (see _tempo_drift).
    This was chosen over the coefficient of variation of IBIs because it
    isolates systematic tempo movement — the thing that actually defeats a
    global stretch or a fixed-period loop — from per-beat tracker jitter,
    which CV would count against a perfectly warp-able steady track.

    Priors (drift threshold = TEMPO_DRIFT_THRESHOLD):
      guitar : "cut" always — stroke direction alternates, so a repeated
               single-cycle loop reads robotic and a global warp smears the
               strum rhythm; cut keeps real alternating motion per bar.
      piano  : "loop" when steady (similar-looking key presses tolerate one
               template), "cut" when tempo drifts.
      violin : "warp" when steady (sustained bow — cut's crossfade seams are
               ugly mid-stroke), "cut" when tempo drifts.

    Returns {"policy", "reason", "tempo_drift", "strokes_per_beat"}.
    Raises ValueError on unknown instrument or fewer than 2 beats.
    """
    if instrument not in STROKES_PER_BEAT:
        raise ValueError(
            f"unknown instrument {instrument!r}; expected one of {sorted(STROKES_PER_BEAT)}"
        )
    drift = _tempo_drift(timing["beats"])
    steady = drift <= TEMPO_DRIFT_THRESHOLD
    if instrument == "guitar":
        policy = "cut"
        reason = (
            "guitar: cut preferred regardless of drift (alternating stroke "
            "direction — loop reads robotic, warp smears strum rhythm); "
            + ("tempo steady" if steady else "tempo drifting, cut also tracks it")
            + f" (drift={drift:.3f}, threshold={TEMPO_DRIFT_THRESHOLD})"
        )
    elif instrument == "piano":
        policy = "loop" if steady else "cut"
        reason = (
            f"piano: {'steady tempo, single key-press template loops cleanly' if steady else 'tempo drift exceeds threshold, per-bar cut tracks it'}"
            f" (drift={drift:.3f}, threshold={TEMPO_DRIFT_THRESHOLD})"
        )
    else:  # violin
        policy = "warp" if steady else "cut"
        reason = (
            f"violin: {'steady tempo, seam-free global stretch suits sustained bow' if steady else 'tempo drift exceeds threshold, per-bar cut tracks it despite seams'}"
            f" (drift={drift:.3f}, threshold={TEMPO_DRIFT_THRESHOLD})"
        )
    return {
        "policy": policy,
        "reason": reason,
        "tempo_drift": round(drift, 6),
        "strokes_per_beat": STROKES_PER_BEAT[instrument],
    }


def make_alignment_plan(timing: dict, reference_stroke_hz: float,
                        ref_clip_duration: float, instrument: str = "guitar") -> dict:
    """Decide, per reference-clip cycle, how to retime/loop/cut so its strokes
    land on the audio's beat/onset grid.

    A real instrumental reference plays at a near-steady stroke rate; an uploaded
    track has a tempo grid that can shift. The matching policy trades:

      warp  - time-stretch the whole reference to the audio's tempo. Cheap,
              one filtergraph, no seams. Drifts if the track's tempo moves or
              if the reference's stroke rate is unrelated to its clip tempo.
      loop  - repeat a single best stroke cycle, one per audio beat/onset.
              Tightest onset alignment, but mechanically "perfect" -> reads as
              robotic; fine for piano's similar-looking key presses, bad for
              guitar strumming where stroke direction should alternate.
      cut   - beat-align by looping each bar then trimming/padding to the next
              onset. Best fidelity-to-motion AND alignment, but visible seams
              at bar boundaries that a crossfade must hide.

    This is the decision point that sets how "believable" the sync reads, and
    the right answer differs per instrument (warp favors violin's sustained
    bow; cut favors guitar's rhythmic strum; loop can pass for steady piano).

    Delegates the policy decision to choose_policy(timing, instrument)
    (instrument defaults to "guitar" for backward compatibility with the
    two-positional-arg call shape) and returns the merged plan.
    """
    plan = choose_policy(timing, instrument)
    return {
        **plan,
        "instrument": instrument,
        "reference_stroke_hz": float(reference_stroke_hz),
        "ref_clip_duration": float(ref_clip_duration),
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python motionsync.py <audio>   -> prints timing JSON")
        sys.exit(2)
    print(json.dumps(analyze_audio(sys.argv[1]), indent=2))
