"""End-to-end verification of the FREE retime/mux path on GROUND TRUTH.

Build a synthetic strumming reference (full-frame brightness oscillating at a
KNOWN stroke rate — 2.5 Hz, period 0.4 s) and a synthetic track with a KNOWN
tempo (99 bpm, so target stroke period = 60/99 = 0.606 s at strokes_per_beat=1).
Render via sync.py, then independently measure the OUTPUT's oscillation rate by
FFT of the per-frame luminance series (YAVG), and check it landed on the audio's
target grid. PASS requires:

  1. the freshly-built reference measures ~2.5 Hz (the detector is known-good on
     this positive control — same oscillation approach proven in the project
     memory, so a wrong reading here means the probe is lying, not the render);
  2. the retimed output's measured stroke ~ matches the audio's target stroke
     (60/bpm), i.e. ~1.65 Hz — the retime actually moved motion onto the grid;
     AND measured frequency differs from the ref's pre-render 2.5 Hz (so we know
     retiming happened, not a pass-through bug);
  3. the output has a real audio track muxed in (not silence).

YAVG (frame-average luminance) directly carries the brightness oscillation, so
its spectral peak reads the cycle rate with NO frame-difference energy-doubling
to reason around (the 2.5Hz-position→5Hz-energy pitfall documented in the
memory). The probe uses the file's TRUE average fps (frame_count/duration), not
the nominal r_frame_rate, because setpts time-warping drops the real rate away
from the nominal one.
"""
import importlib.util
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

REF = os.path.join(HERE, "_synth_ref.mp4")
OUT = os.path.join(HERE, "_synth_out.mp4")
REF_HZ = 2.5            # the synthetic strum rate (period 0.4 s)
AUDIO = os.path.join(HERE, "_test_track.wav")     # 99 bpm synth, from test_motionsync


def build_ref():
    # Full-frame brightness oscillation at a KNOWN stroke rate. A sliding box was
    # the wrong control: constant-area motion keeps frame-average luma (YAVG)
    # flat, so a YAVG autocorrelator sees nothing (a lesson, not a trap to hide).
    # Real strokes vary frame brightness on the attack; a sinusoid models that
    # AND gives a clean ground-truth rate for the retime to remap.
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30:d=8",
        "-vf", "format=gray,geq=lum='128+80*sin(2*PI*T*2.5)'",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", REF,
    ], check=True)


def _yavg_series(path):
    proc = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", path,
         "-vf", "signalstats,metadata=print", "-f", "null", "-"],
        capture_output=True, text=True)
    return np.asarray(
        [float(ln.split("YAVG=")[1]) for ln in proc.stderr.splitlines()
         if "YAVG=" in ln], dtype=float)


def _format_duration(path):
    # container duration, NOT a stream entry (so no -select_streams, which only
    # takes stream specifiers like v:0/a:0 and would reject "format").
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], text=True).strip() or 0)


def measure_stroke_hz(path):
    """Independent periodicity probe via FFT of the per-frame luma series.

    YAVG (frame-average luminance) IS the brightness oscillation, so its spectral
    peak is the cycle rate directly — no frame-difference energy-doubling to
    reason around (the memory's 2.5Hz-position→5Hz-energy pitfall). Robust to a
    leading flat/lead-in block, which defeats a naive autocorrelation-fundamental
    extractor (the tpad black lead-in self-correlates at lag 0 and swamps it).

    Uses the file's TRUE average fps (decoded-frame count / container duration),
    NOT the nominal r_frame_rate: setpts stretching drops the real rate away from
    the nominal one (a 30-in/13.7s-out clip reports r_frame_rate=30 but plays at
    ~20.4fps), and trusting the nominal would over-count frequency by that ratio.
    Returns (dominant_hz, prominence) where prominence = peak/SNR floor; a
    genuine sinusoid gives a sharp single peak (high prominence), drift gives
    a smeared low-prominence spectrum.
    """
    y = _yavg_series(path)
    n = len(y)
    if n < 16:
        return None, None
    dur = _format_duration(path)
    if dur <= 0:
        return None, None
    fps = n / dur                                   # true average fps, not nominal
    win = np.hanning(n)
    spec = np.abs(np.fft.rfft((y - y.mean()) * win))
    freqs = np.fft.rfftfreq(n, d=1.0 / fps)
    # ignore the DC bin and very-low (<0.4Hz) bin that any lead-in/drift piles into
    band = freqs >= 0.4
    f, s = freqs[band], spec[band]
    if s.size == 0:
        return None, None
    idx = int(np.argmax(s))
    assert 0 <= idx < len(s), f"Index {idx} out of bounds for array of size {len(s)}"
    peak = s[idx]
    floor = np.median(s)
    return float(f[idx]), float(peak / (floor + 1e-9))


def main():
    if not os.path.exists(AUDIO):
        print("RUN test_motionsync.py FIRST to create _test_track.wav"); sys.exit(1)
    build_ref()

    # sanity: the freshly-built ref must measure ~2.5 Hz (detector is good on it)
    ref_hz, ref_r = measure_stroke_hz(REF)
    print(f"reference measured: {ref_hz} Hz  r={ref_r}")
    sane_ref = ref_hz is not None and abs(ref_hz - REF_HZ) < 0.35 and ref_r > 0.6

    spec = importlib.util.spec_from_file_location("sync", os.path.join(HERE, "sync.py"))
    sync = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync)

    plan = sync.render(AUDIO, REF, REF_HZ, OUT, strokes_per_beat=1.0, policy="warp")
    if plan is None or not isinstance(plan, dict):
        raise ValueError(f"sync.render() returned invalid plan: {plan}")
    required_keys = ['warp', 'target_period', 'target_stroke_hz', 'first_beat']
    missing = [k for k in required_keys if k not in plan]
    if missing:
        raise ValueError(f"plan missing keys: {missing}")
    print(f"plan: warp={plan['warp']} target_period={plan['target_period']} "
          f"target_stroke_hz={plan['target_stroke_hz']} first_beat={plan['first_beat']}")

    out_hz, out_r = measure_stroke_hz(OUT)
    print(f"OUTPUT measured stroke: {out_hz} Hz  r={out_r}")

    target_hz = plan["target_stroke_hz"]
    on_target = out_hz is not None and abs(out_hz - target_hz) < 0.30
    reworked = out_hz is not None and abs(out_hz - REF_HZ) > 0.6   # not still ~2.5

    # audio is real (not silent) — check an audio stream is muxed in. With
    # nokey=1 the value prints as bare "audio" (not "codec_type=audio"), so
    # compare to the value, not the key.
    has_audio = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_type", "-of",
         "default=noprint_wrappers=1:nokey=1", OUT],
        capture_output=True, text=True).stdout.strip() == "audio"

    print(f"\nref detector sane (~2.5Hz, r>0.6): {sane_ref}")
    print(f"output stroke on target (~{target_hz:.2f}Hz): {on_target}")
    print(f"retiming actually happened (not ~{REF_HZ}Hz): {reworked}")
    print(f"output muxed audio track present: {has_audio}")
    ok = sane_ref and on_target and reworked and has_audio
    # reap artifacts
    for p in (REF, OUT):
        try: os.remove(p)
        except OSError: pass
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
