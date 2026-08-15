"""End-to-end verification of ALL THREE matching policies on ground truth.

verify_sync.py proves the warp path only. This file extends coverage to loop and
cut and adds a MOVING-TEMPO discriminator that can actually FAIL cut — because a
test that can't fail proves nothing.

TIER 1 — STEADY tempo (the existing 99bpm synth track + 2.5Hz brightness ref):
   each policy must render without error, land its strokes on the grid (~1.65Hz
   target stroke rate), differ from the ref's 2.5Hz (retime really happened),
   and carry a real audio track. This is a floor all three share — it proves the
   renderers run and produce on-grid output; it does NOT discriminate cut from
   warp (on a steady tempo, all three agree by design).

TIER 2 — MOVING tempo (the discriminator): cut's reason to exist is per-bar LOCAL
   retime, so on a moving tempo its stroke rate must follow LOCAL beat rate while
   warp's single global factor cannot. We feed a KNOWN ramping beat grid
   (IBI 0.75s -> 0.50s) directly to alignment_plan for both warp and cut, render,
   and measure each output's INSTANTANEOUS stroke rate over time via a sliding
   FFT of the YAVG series. PASS requires cut's stroke rate to ramp measurably
   while warp's stays ~flat. Feeding the grid directly (not via the beat tracker)
   isolates the alignment math + renderer — the tracker is already covered by
   test_motionsync, and a tracker that locks to an average tempo would hide cut's
   advantage, so controlling the grid is the honest way to test the policy itself.
"""
import importlib.util
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# reuse the proven probes + constants from verify_sync (same brightness ref,
# same YAVG/FFT stroke-rate probe) so the detector stays the known-good one.
_spec = importlib.util.spec_from_file_location("vs", os.path.join(HERE, "verify_sync.py"))
vs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vs)

REF_HZ = vs.REF_HZ                       # 2.5 Hz synthetic strum rate
AUDIO = vs.AUDIO                         # 99bpm synth track (built by test_motionsync)
REF = vs.REF                            # _synth_ref.mp4 path the builder writes

_spec2 = importlib.util.spec_from_file_location("sync", os.path.join(HERE, "sync.py"))
sync = importlib.util.module_from_spec(_spec2)
_spec2.loader.exec_module(sync)

POLICIES = ("warp", "loop", "cut")
TARGET_HZ_STEADY = 1.0 / ((60.0 / 99.0) / 1.0)   # ~1.6516 Hz at 99bpm, 1 stroke/beat


def _has_audio(path: str) -> bool:
    # value prints BARE with nokey=1 (e.g. "audio"), not "codec_type=audio".
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_type", "-of",
         "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True).stdout.strip()
    return out == "audio"


def _policy_ok(hz, target_hz: float) -> tuple[bool, str]:
    if hz is None:
        return False, "no stroke detected"
    if abs(hz - target_hz) > 0.30:
        return False, f"stroke {hz:.3f}Hz not on grid (~{target_hz:.2f}Hz)"
    if abs(hz - REF_HZ) < 0.6:
        return False, f"stroke {hz:.3f}Hz still ~ref {REF_HZ}Hz (no retime)"
    return True, "on grid"


def _inst_stroke_rate(path, seg_s=2.0, hop_s=1.0):
    """Instantaneous stroke rate (Hz) over time via the Hilbert analytic signal.

    A sliding-window FFT (bin spacing = 1/win_s) can't resolve the ~0.5Hz-wide
    ramp we're measuring on a 12s clip — the whole ramp fits in one bin. The
    analytic signal's phase derivative gives a per-SAMPLE instantaneous
    frequency with near-continuous resolution, so it actually sees cut's ramp.
    Returns list of (t_center_s, rate) over hop_s-spaced segments.
    """
    from scipy.signal import hilbert
    y = vs._yavg_series(path)
    if len(y) < 16:
        return []
    dur = vs._format_duration(path)
    if dur <= 0:
        return []
    fps = len(y) / dur
    y = y - y.mean()
    phase = np.unwrap(np.angle(hilbert(y)))       # per-sample analytic phase
    ifreq = np.diff(phase) / (2 * np.pi) * fps     # per-sample instantaneous Hz
    slen = max(8, int(seg_s * fps))
    h = max(1, int(hop_s * fps))
    out = []
    i = 0
    while i + slen < len(ifreq):
        chunk = ifreq[i:i + slen]
        keep = chunk[(chunk > 0.2) & (chunk < 5.0)]   # drop wrap/flat outliers
        if keep.size:
            out.append(((i + slen / 2) / fps, float(np.median(keep))))
        i += h
    return out


def _ramped_beats(dur_s=11.0, ibi_start=0.75, ibi_end=0.50):
    """Ground-truth moving-tempo grid: inter-beat interval shrinks linearly.
    ~16 beats over ~11s, a +50% tempo change the renderer must track locally."""
    beats = [0.0]
    t = 0.0
    while True:
        frac = t / dur_s if dur_s > 0 else 0.0
        ibi = ibi_start + (ibi_end - ibi_start) * min(frac, 1.0)
        t += ibi
        if t > dur_s:
            break
        beats.append(round(t, 4))
    return beats


def tier1_steady() -> dict:
    """Floor: all three policies render and land on the steady-tempo grid."""
    if not os.path.exists(AUDIO):
        print("RUN test_motionsync.py FIRST to create _test_track.wav")
        sys.exit(1)
    vs.build_ref()                       # builds REF (the 2.5Hz brightness control)

    ref_hz, ref_r = vs.measure_stroke_hz(REF)
    print(f"[tier1] reference measured: {ref_hz} Hz  r={ref_r}")
    sane_ref = ref_hz is not None and abs(ref_hz - REF_HZ) < 0.35 and ref_r > 0.6
    if not sane_ref:
        print(f"[tier1] FAILED: ref detector not sane on the 2.5Hz control "
              f"(got {ref_hz}Hz r={ref_r}) — ABORT, the probe is lying")
        return {"ok": False, "reason": "ref_probe_not_sane"}

    print(f"[tier1] stroke target = {TARGET_HZ_STEADY:.3f} Hz (99bpm, 1 stroke/beat)")
    per = {}
    for p in POLICIES:
        out = os.path.join(HERE, f"_all_{p}.mp4")
        plan = sync.render(AUDIO, REF, REF_HZ, out, strokes_per_beat=1.0,
                           ref_first_stroke_s=0.0, policy=p)
        hz, r = vs.measure_stroke_hz(out)
        ok, why = _policy_ok(hz, TARGET_HZ_STEADY)
        au = _has_audio(out)
        ok = ok and au
        print(f"[tier1] {p:5s} -> {hz} Hz  r={r}  audio={au}  warp={plan.get('warp')}  {why}")
        per[p] = {"hz": hz, "r": r, "audio": au, "ok": ok, "why": why}
        try:
            os.remove(out)
        except OSError:
            pass
    try:
        os.remove(REF)
    except OSError:
        pass
    overall = all(per[p]["ok"] for p in POLICIES)
    print(f"[tier1] RESULT: {'PASS' if overall else 'FAIL'}")
    return {"ok": overall, "per": per}


def tier2_moving() -> dict:
    """Discriminator: on a ramping beat grid, cut's stroke rate must track local
    tempo (ramp UP) while warp's stays ~flat (one global factor)."""
    vs.build_ref()                       # need REF for the template trim
    beats = _ramped_beats()
    # warp's single target_period = (60/bpm)/1; pick bpm = 60/mean_IBI so warp
    # hits the AVERAGE tempo and must therefore diverge from the moving ends.
    mean_ibi = (0.75 + 0.50) / 2
    bpm = 60.0 / mean_ibi                 # ~96
    n = len(beats)
    # local bar rate at the EARLY and LATE bars (beats[i+4]-beats[i]):
    early_bar = beats[4] - beats[0]
    late_bar = beats[n - 1] - beats[n - 5]
    early_hz = 4.0 / early_bar
    late_hz = 4.0 / late_bar
    print(f"[tier2] ramped grid: {n} beats, IBI 0.75s->0.50s; local bar rate "
          f"early {early_hz:.2f}Hz -> late {late_hz:.2f}Hz")

    res = {}
    for p in ("warp", "cut"):
        ap = sync.alignment_plan(bpm, beats, REF_HZ, 1.0, 0.0, p)
        out = os.path.join(HERE, f"_ramp_{p}.mp4")
        # call the per-policy renderer directly with the KNOWN grid (bypassing
        # analyze_audio's beat tracker) to isolate the alignment math.
        if p == "warp":
            sync._render_warp(REF, AUDIO, _format_dur(AUDIO), ap, out)
        else:
            sync._render_cut(REF, AUDIO, _format_dur(AUDIO), ap, out)
        rates = _inst_stroke_rate(out)
        vals = [(t, r) for t, r in rates if r is not None]
        if len(vals) < 4:
            print(f"[tier2] {p}: too few rate windows ({len(vals)})")
            res[p] = {"ok": False}
            try:
                os.remove(out)
            except OSError:
                pass
            continue
        # early = first windows, late = last windows
        head = [r for _, r in vals[:3]]
        tail = [r for _, r in vals[-3:]]
        early_m = float(np.median(head))
        late_m = float(np.median(tail))
        ramp = late_m - early_m
        print(f"[tier2] {p:5s} stroke rate over time: " +
              ", ".join(f"{r:.2f}" for _, r in vals) +
              f"  (early {early_m:.2f}Hz -> late {late_m:.2f}Hz, ramp {ramp:+.2f}Hz)")
        res[p] = {"early": early_m, "late": late_m, "ramp": ramp, "ok": None}
        try:
            os.remove(out)
        except OSError:
            pass
    try:
        os.remove(REF)
    except OSError:
        pass

    if "warp" not in res or "cut" not in res:
        ok = False
        why = "rendering failed for a policy"
    else:
        warp_flat = abs(res["warp"]["ramp"]) < 0.15      # global factor -> ~no ramp
        cut_tracks = res["cut"]["late"] - res["cut"]["early"] > 0.30  # ramps up
        ok = warp_flat and cut_tracks
        why = (f"warp flat (ramp {res['warp']['ramp']:+.2f}Hz, want |ramp|<0.15) = {warp_flat}; "
               f"cut ramps up ({res['cut']['ramp']:+.2f}Hz, want >0.30) = {cut_tracks}")
        res["warp"]["ok"] = warp_flat
        res["cut"]["ok"] = cut_tracks
    print(f"[tier2] {why}")
    print(f"[tier2] RESULT: {'PASS' if ok else 'FAIL'}")
    return {"ok": ok, "per": res}


def _format_dur(path):
    return vs._format_duration(path)


def main():
    t1 = tier1_steady()
    print()
    t2 = tier2_moving()
    print("\n=== SUMMARY ===")
    print(f"tier1 (steady, all 3 land on grid): {'PASS' if t1['ok'] else 'FAIL'}")
    print(f"tier2 (moving, cut tracks & warp flat): {'PASS' if t2['ok'] else 'FAIL'}")
    ok = t1["ok"] and t2["ok"]
    print("OVERALL:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
