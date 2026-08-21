"""Motion-sync renderer (FREE path): retime a real-playing reference clip so its
strokes land on an uploaded track's beat grid, then mute the reference and mux
the real audio under it.

Path-independence: this retime engine is consumed by EVERY downstream render path
(not only this free self-contained one). The Runway/Kling motion-transfer path
retimes a motion donor the same way before transferring it to your face; the
HeyGen cinematic path retimes its reference clip before passing it as a motion
reference. So the free foundation here is reused wholesale downstream.

It starts from REAL playing (a clip of someone playing the instrument), which is
why its motion fidelity ceiling is higher than any generative avatar — and why
the trade-off is that the player's face is whoever was in the reference.

Three matching policies, each honest about its trade-off:

  warp  (the seam-free baseline) — time-stretch the WHOLE reference by one
        factor so its stroke period maps to the target period, phase-aligned to
        the first beat. Looks natural, seam-free; but if the track's tempo MOVES
        the periodic strokes drift off the beats. Best for near-steady tempo
        (violin's sustained bow over a held-tempo piece).

  loop  (maximally on-grid, mechanically perfect) — trim ONE best stroke cycle
        from the reference, retime it to exactly one beat, and repeat it once per
        audio beat. Every stroke is the identical template → snaps to every beat
        no matter how the tempo moves, but reads as robotic. Passes for piano's
        similar-looking key presses; reads wrong for expressive bowing/strumming.

  cut   (tightest alignment against a moving tempo, with seams) — trim ONE bar
        (K strokes) from the reference as a template, then retime that template
        per audio-bar to the LOCAL bar duration (`beats[i+K]-beats[i]`), so
        strokes snap to local beats even as tempo shifts, and xfade-concatenate
        the per-bar segments. Best fidelity for guitar strumming where stroke
        DIRECTION should alternate and the tempo breathes. Cost: a short
        crossfade at each bar boundary (and a ~ (N-1)*CF global drift — see note).
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("ms", os.path.join(HERE, "motionsync.py"))
ms = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ms)

# cut policy: one bar = this many beats/strokes. Four is the common meter; tuning
# this trades alignment granularity against seam count (more beats/bar = fewer
# seams but coarser local-tempo tracking).
BAR_BEATS = 4
# cut policy crossfade length (s) at each bar boundary to hide the seam flash.
# xfade overlaps adjacent bars by this much, so the output runs (N-1)*CF short of
# the audio span — strokes land ~that much early over the whole clip.
CROSSFADE = 0.06

POLICIES = ("warp", "cut", "loop")

# Windows gives a console-less GUI host (iplay.pyw) a fresh console window for
# every child process unless CREATE_NO_WINDOW is set, which flashes a black
# window over the app. The pipeline's injected command_runner already guards
# this via media.run_logged; these are the paths that bypass it — the probe
# helpers below (called during a render) and the standalone-CLI fallback.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _run_ffmpeg(command: list[str], *, stage: str, command_runner=None) -> None:
    """Run one retime command through the caller's observable runner.

    The standalone CLI keeps its historical behavior. The IPlay pipeline
    supplies a cancellable runner whose logs live beside the requested output.
    """
    if command_runner is not None:
        command_runner(command, stage)
        return
    subprocess.run(command, check=True, creationflags=_NO_WINDOW)


def _ffprobe(path: str, entry: str, stream: str = "stream") -> str:
    sel = "v:0" if stream == "stream" else stream
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", sel,
         "-show_entries", f"{stream}={entry}",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        text=True, creationflags=_NO_WINDOW,
    )
    return out.strip()


def _fps(path: str) -> float:
    s = _ffprobe(path, "r_frame_rate", "stream")
    if not s:
        raise RuntimeError(f"no frame rate found for {path}")
    try:
        num, den = (s.split("/") + ["1", "1"])[:2]
        return float(num) / float(den)
    except (ValueError, ZeroDivisionError) as exc:
        raise RuntimeError(f"invalid frame rate {s!r} for {path}") from exc


def _dur(path: str) -> float:
    # no -select_streams here: "format=duration" is a container entry, and
    # -select_streams only accepts stream specifiers (v:0/a:0)
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], text=True,
        creationflags=_NO_WINDOW).strip() or 0)


def alignment_plan(bpm: float, beats: list[float], ref_stroke_hz: float,
                   strokes_per_beat: float, ref_first_stroke_s: float = 0.0,
                   policy: str = "warp") -> dict:
    """Decide how to warp/loop/cut the reference so its strokes land on the grid.

    THE decision point that sets how believable the sync reads. Three policies,
    with genuinely different trade-offs per instrument — see the module docstring.
    Returns the plan the filtergraph consumes (single global `warp` for warp/loop;
    a per-bar `warp` list for cut).
    """
    if policy not in POLICIES:
        raise ValueError(f"unknown policy {policy!r}; want one of {POLICIES}")
    if not beats:
        raise RuntimeError("no beats detected in audio — cannot align")
    if bpm <= 0:
        raise ValueError("bpm must be > 0")

    target_period = (60.0 / bpm) / strokes_per_beat      # s per stroke target
    ref_period = 1.0 / ref_stroke_hz                     # s per stroke in ref
    warp = ref_period / target_period                    # >1: ref too slow, speed up
    first_beat = beats[0]

    plan = {
        "policy": policy,
        "bpm": round(bpm, 3),
        "target_period": round(target_period, 4),        # s per stroke after retime
        "target_stroke_hz": round(1.0 / target_period, 4),
        "warp": round(warp, 4),
        "first_beat": round(first_beat, 4),
        "ref_first_stroke_s": ref_first_stroke_s,
        "ref_period": round(ref_period, 4),
    }

    if policy in ("warp", "loop"):
        return plan

    # cut: per-bar local warp. Group beats into bars of BAR_BEATS and retime one
    # reference bar to each audio bar's LOCAL duration, so strokes snap to beats
    # even when the tempo moves between bars.
    K = BAR_BEATS
    bars: list[dict] = []
    n = len(beats)
    i = 0
    while i + K < n:                                     # need a closing beat to measure
        bar_dur = beats[i + K] - beats[i]
        bars.append({
            "index": len(bars),
            "start_beat": i,
            "beat_count": K,
            "audio_bar_dur": round(bar_dur, 4),
            "warp": round((K * ref_period) / bar_dur, 4),
        })
        i += K
    if i < n - 1:                                       # trailing partial bar
        rem = (n - 1) - i
        bar_dur = beats[n - 1] - beats[i]
        bars.append({
            "index": len(bars),
            "start_beat": i,
            "beat_count": rem,
            "audio_bar_dur": round(bar_dur, 4),
            "warp": round((rem * ref_period) / bar_dur, 4),
        })
    if not bars:
        raise RuntimeError("audio shorter than one bar — use warp or loop")
    plan["bars"] = bars
    plan["bar_beats"] = K
    return plan


def _mux_common(audio_path: str, out_path: str) -> list[str]:
    """Shared encoder tail flags: map filtergraph [v] + audio input, x264/aac,
    -shortest. Caller supplies the per-policy -filter_complex and input list."""
    return ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-shortest", out_path]


def _render_warp(ref_clip_path: str, audio_path: str, audio_dur: float,
                 ap: dict, out_path: str, command_runner=None) -> dict:
    ref_dur = _dur(ref_clip_path)
    if ref_dur <= 0:
        raise RuntimeError(f"could not probe duration of {ref_clip_path}")
    warped_dur = ref_dur / ap["warp"]
    need = audio_dur + ap["first_beat"] + 1.0
    loops = max(0, math.ceil(need / warped_dur) - 1)
    # setpts=PTS/warp: warp>1 divides PTS → frames sooner → faster playback
    # (ref was too slow). tpad pads the lead-in so the first stroke sits at
    # first_beat. -stream_loop repeats the clip to fill, -shortest cuts to audio.
    filt = (
        f"[0:v]setpts=PTS/{ap['warp']},"
        f"tpad=start_duration={ap['first_beat']}:color=black[v]"
    )
    _run_ffmpeg([
        "ffmpeg", "-y", "-loglevel", "error",
        "-stream_loop", str(loops), "-i", ref_clip_path,
        "-i", audio_path,
        "-filter_complex", filt,
        "-map", "[v]", "-map", "1:a",
        *_mux_common(audio_path, out_path),
    ], stage="warp", command_runner=command_runner)
    return {"ref_dur": ref_dur, "warped_dur": round(warped_dur, 4), "loops": loops}


def _render_loop(ref_clip_path: str, audio_path: str, audio_dur: float,
                 ap: dict, out_path: str, command_runner=None) -> dict:
    """One template cycle, retimed to a beat and repeated per beat. Two passes:
    (1) trim+retime a single ref stroke cycle to exactly one target_period;
    (2) -stream_loop that template indefinitely, tpad the lead-in, mux audio."""
    warp = ap["warp"]
    rfs = ap["ref_first_stroke_s"]
    rp = ap["ref_period"]
    tmpl = out_path + ".tmpl.mp4"
    # trim one cycle starting at the first stroke, retime it to one beat.
    # setpts=PTS-STARTPTS re-base timestamps after trim so tpad/loop see 0-based.
    tmpl_filt = (
        f"trim=start={rfs}:duration={rp},setpts=PTS-STARTPTS,"
        f"setpts=PTS/{warp}"
    )
    try:
        _run_ffmpeg([
            "ffmpeg", "-y", "-loglevel", "error", "-i", ref_clip_path, "-an",
            "-vf", tmpl_filt,
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", tmpl,
        ], stage="loop-template", command_runner=command_runner)
        tmpl_dur = _dur(tmpl)
        need = audio_dur + ap["first_beat"] + 1.0
        loops = max(0, math.ceil(need / tmpl_dur) - 1) if tmpl_dur > 0 else 0
        filt = f"[0:v]tpad=start_duration={ap['first_beat']}:color=black[v]"
        _run_ffmpeg([
            "ffmpeg", "-y", "-loglevel", "error",
            "-stream_loop", str(loops), "-i", tmpl, "-i", audio_path,
            "-filter_complex", filt,
            "-map", "[v]", "-map", "1:a",
            *_mux_common(audio_path, out_path),
        ], stage="loop-final", command_runner=command_runner)
    finally:
        try:
            os.remove(tmpl)
        except OSError:
            pass
    return {"loop_template_dur": round(tmpl_dur, 4), "loops": loops,
            "warped_dur": round(tmpl_dur, 4)}


def _render_cut(ref_clip_path: str, audio_path: str, audio_dur: float,
                ap: dict, out_path: str, command_runner=None) -> dict:
    """One reference bar as a template, retimed per audio-bar, xfade-concatenated.
    Passes: (1) trim one bar (K strokes) from the ref as a template; (2) retime
    that template by each bar's local warp → per-bar temp; (3) xfade-concatenate
    the per-bar temps, tpad the lead-in, mux audio.

    A tempo that moves between bars makes the per-bar warps differ; that is the
    whole point of cut (warp uses one global factor and would drift). The xfade
    overlap means the output runs (N-1)*CROSSFADE short of the audio span.
    """
    K = ap["bar_beats"]
    bars = ap["bars"]
    rfs = ap["ref_first_stroke_s"]
    rp = ap["ref_period"]
    ref_bar_dur = K * rp
    # Force CFR on the per-bar temps at the reference's native fps. setpts=PTS/warp
    # alone yields VFR (fewer frames spread over longer PTS); feeding VFR into the
    # xfade chain makes ffmpeg resample each bar ambiguously and its stroke rate
    # collapses to the global average — which silently defeats cut's local-retime
    # purpose. fps= materializes the resampled frames so each bar's rate survives.
    ref_fps = _fps(ref_clip_path)

    tmpl = out_path + ".tmplbar.mp4"
    bar_files: list[str] = []
    try:
        _run_ffmpeg([
            "ffmpeg", "-y", "-loglevel", "error", "-i", ref_clip_path, "-an",
            "-vf", f"trim=start={rfs}:duration={ref_bar_dur},setpts=PTS-STARTPTS",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", tmpl,
        ], stage="cut-template", command_runner=command_runner)

        for b in bars:
            bf = out_path + f".bar{b['index']}.mp4"
            bar_files.append(bf)
            _run_ffmpeg([
                "ffmpeg", "-y", "-loglevel", "error", "-i", tmpl, "-an",
                "-vf", f"setpts=PTS/{b['warp']},fps={ref_fps}",
                "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", bf,
            ], stage=f"cut-bar-{b['index']}", command_runner=command_runner)

        actual = [_dur(f) for f in bar_files]
        audio_idx = len(bar_files)
        inputs: list[str] = []
        for f in bar_files:
            inputs += ["-i", f]
        inputs += ["-i", audio_path]

        # xfade chain: output_k = xfade(output_{k-1}, bar_k, CF, offset=accum-CF).
        # Single bar → no xfade, just tpad the lone bar.
        cf = CROSSFADE
        filt: str
        if len(bar_files) == 1:
            filt = f"[0:v]tpad=start_duration={ap['first_beat']}:color=black[v]"
        else:
            accum = actual[0]
            parts: list[str] = []
            prev_label = "[0:v]"
            nxt = 1
            for k in range(1, len(bar_files)):
                off = max(0.0, accum - cf)
                label = f"[x{nxt}]"
                parts.append(
                    f"{prev_label}[{k}:v]xfade=transition=fade:duration={cf}"
                    f":offset={off:.4f}{label}"
                )
                accum = accum + actual[k] - cf
                prev_label = label
                nxt += 1
            filt = (";".join(parts)
                    + f";{prev_label}tpad=start_duration={ap['first_beat']}:color=black[v]")

        _run_ffmpeg([
            "ffmpeg", "-y", "-loglevel", "error", *inputs,
            "-filter_complex", filt,
            "-map", "[v]", "-map", f"{audio_idx}:a",
            *_mux_common(audio_path, out_path),
        ], stage="cut-final", command_runner=command_runner)
    finally:
        for path in [tmpl, *bar_files]:
            try:
                os.remove(path)
            except OSError:
                pass
    return {"bars": len(bar_files), "bar_durs": [round(d, 4) for d in actual],
            "crossfade": cf}


def render(audio_path: str, ref_clip_path: str, ref_stroke_hz: float,
           out_path: str, *, strokes_per_beat: float = 1.0,
           ref_first_stroke_s: float = 0.0, policy: str = "warp",
           command_runner=None) -> dict:
    """Render out_path: the reference, retimed so its strokes hit the audio's
    beat grid (one stroke per beat by default), with the audio track muxed over
    a SILENCED reference. Returns the alignment plan used."""
    plan_dict = ms.analyze_audio(audio_path)
    ap = alignment_plan(plan_dict["bpm"], plan_dict["beats"], ref_stroke_hz,
                        strokes_per_beat, ref_first_stroke_s, policy)
    audio_dur = plan_dict["duration_s"]

    if policy == "warp":
        extra = _render_warp(ref_clip_path, audio_path, audio_dur, ap, out_path,
                             command_runner)
    elif policy == "loop":
        extra = _render_loop(ref_clip_path, audio_path, audio_dur, ap, out_path,
                             command_runner)
    elif policy == "cut":
        extra = _render_cut(ref_clip_path, audio_path, audio_dur, ap, out_path,
                            command_runner)
    else:                                               # unreachable — alignment_plan guards
        raise ValueError(policy)
    return {**ap, "out": out_path, "audio_dur": audio_dur, **extra}


if __name__ == "__main__":
    a = sys.argv
    if len(a) < 5:
        print("usage: python sync.py <audio> <ref_clip> <ref_stroke_hz> <out> "
              "[strokes_per_beat] [policy]")
        sys.exit(2)
    spb = float(a[5]) if len(a) > 5 else 1.0
    pol = a[6] if len(a) > 6 else "warp"
    print(json.dumps(render(a[1], a[2], float(a[3]), a[4],
                            strokes_per_beat=spb, policy=pol), indent=2))
