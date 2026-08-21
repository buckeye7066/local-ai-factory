"""Offline regression checks for observable rendering and master-audio muxing."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import media  # noqa: E402
import pipeline  # noqa: E402


def run(*args: str) -> None:
    subprocess.run(list(args), check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.PIPE, text=True)


def make_fixtures(tmp: str) -> tuple[str, str]:
    analysis = os.path.join(tmp, "analysis_mezzanine.mp4")
    master = os.path.join(tmp, "master_stereo_48k.wav")
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=2",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
        "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-ac", "1", "-shortest", analysis)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i",
        "aevalsrc=sin(2*PI*440*t)|sin(2*PI*660*t):s=48000:d=2",
        "-c:a", "pcm_s16le", master)
    return analysis, master


with tempfile.TemporaryDirectory(prefix="iplay_resilience_") as tmp:
    # Mirrors the user's Windows title shape: spaces, a video-id in brackets,
    # and Unicode. Every subprocess receives an argv list, never a shell string.
    case_dir = os.path.join(tmp, "Igor Paspalj [v5y2BBXABvU] – piano")
    os.makedirs(case_dir)
    source, master = make_fixtures(case_dir)

    native = os.path.join(case_dir, "Ballad Improvisation [local edit].mp4")
    report = pipeline._deliver_final(source, master, native, 2.0, False,
                                     progress_cb=lambda _msg: None)
    summary = report["summary"]
    assert summary["audio_channels"] == 2, summary
    assert summary["audio_sample_rate"] == 48000, summary
    assert summary["width"] == 160 and summary["height"] == 90, summary
    assert not report["fallback"], report

    # Explicit video ordinals survive the final mux command; FFmpeg must not
    # silently fall back to the first video program.
    captured_final = {}
    original_runner = pipeline.media_tools.run_logged
    def capture_final(command, **_kwargs):
        captured_final["command"] = command
        return media.CommandResult(
            tuple(command), 1, 0.01, os.path.join(tmp, "capture.log"), "")
    pipeline.media_tools.run_logged = capture_final
    try:
        pipeline._attempt_final_render(
            source, master, os.path.join(tmp, "capture.mp4"), 2.0,
            stage="capture", video_ordinal=1, audio_ordinal=0,
            width=160, height=90, copy_video=True)
    finally:
        pipeline.media_tools.run_logged = original_runner
    mapped_video = captured_final["command"].index("-map")
    assert captured_final["command"][mapped_video + 1] == "0:v:1", \
        captured_final

    # A direct source fallback (director disabled/failed) must normalize the
    # selected source's display raster before target scaling. Otherwise the
    # final setsar=1 step would squash anamorphic performance frames.
    captured_geometry_final = {}
    def capture_geometry_final(command, **_kwargs):
        captured_geometry_final["command"] = command
        return media.CommandResult(
            tuple(command), 1, 0.01,
            os.path.join(tmp, "capture-geometry.log"), "")
    pipeline.media_tools.run_logged = capture_geometry_final
    try:
        pipeline._attempt_final_render(
            source, master, os.path.join(tmp, "capture-geometry.mp4"), 2.0,
            stage="capture-geometry", width=1920, height=1080,
            source_display_geometry={"display_width": 320,
                                     "display_height": 90})
    finally:
        pipeline.media_tools.run_logged = original_runner
    geometry_vf = captured_geometry_final["command"][
        captured_geometry_final["command"].index("-vf") + 1]
    assert geometry_vf.startswith(
        "scale=320:90:flags=lanczos,setsar=1,"
        "scale=1920:1080:force_original_aspect_ratio=decrease:"), geometry_vf

    # A director that already produced the requested UHD raster is copied
    # into the one-master-audio mux. It is not scaled or encoded a second time.
    uhd_info = {"streams": [{
        "index": 0, "codec_type": "video", "width": 3840, "height": 2160,
        "avg_frame_rate": "60000/1001", "r_frame_rate": "60000/1001",
        "duration": "2", "disposition": {"attached_pic": 0, "default": 1},
    }], "format": {"duration": "2"}}
    original_probe = pipeline.media_tools.probe_media
    original_attempt = pipeline._attempt_final_render
    original_preflight = pipeline.media_tools.uhd_preflight
    uhd_calls = []
    pipeline.media_tools.probe_media = lambda _path, **_kwargs: uhd_info
    def copy_uhd(*_args, **kwargs):
        uhd_calls.append(kwargs)
        return ({"width": 3840, "height": 2160,
                 "duration_s": 2.0, "audio_channels": 2,
                 "audio_sample_rate": 48000}, None)
    pipeline._attempt_final_render = copy_uhd
    pipeline.media_tools.uhd_preflight = lambda *_args: (
        (_ for _ in ()).throw(AssertionError("copy path ran UHD preflight")))
    try:
        copied_uhd = pipeline._deliver_final(
            "directed-uhd.mp4", "master.wav", "final.mp4", 2.0, True,
            video_ordinal=0, audio_ordinal=0,
            progress_cb=lambda _message: None)
    finally:
        pipeline.media_tools.probe_media = original_probe
        pipeline._attempt_final_render = original_attempt
        pipeline.media_tools.uhd_preflight = original_preflight
    assert len(uhd_calls) == 1 and uhd_calls[0]["copy_video"] is True, uhd_calls
    assert uhd_calls[0]["stage"] == "uhd_master_mux", uhd_calls
    assert copied_uhd["delivered_uhd"] and not copied_uhd["video_reencoded_in_final"]

    fallback1080_info = {"streams": [{
        **uhd_info["streams"][0], "width": 1920, "height": 1080,
    }], "format": {"duration": "2"}}
    fallback_calls = []
    pipeline.media_tools.probe_media = lambda _path, **_kwargs: fallback1080_info
    def copy_fallback(*_args, **kwargs):
        fallback_calls.append(kwargs)
        return ({"width": 1920, "height": 1080,
                 "duration_s": 2.0, "audio_channels": 2,
                 "audio_sample_rate": 48000}, None)
    pipeline._attempt_final_render = copy_fallback
    pipeline.media_tools.uhd_preflight = lambda *_args: (
        (_ for _ in ()).throw(AssertionError("known decline reran preflight")))
    try:
        copied_fallback = pipeline._deliver_final(
            "directed-1080.mp4", "master.wav", "final.mp4", 2.0, True,
            video_ordinal=0, audio_ordinal=0,
            uhd_decline_reason="synthetic resource decline",
            progress_cb=lambda _message: None)
    finally:
        pipeline.media_tools.probe_media = original_probe
        pipeline._attempt_final_render = original_attempt
        pipeline.media_tools.uhd_preflight = original_preflight
    assert len(fallback_calls) == 1, fallback_calls
    assert fallback_calls[0]["stage"] == "fallback1080_master_mux"
    assert fallback_calls[0]["copy_video"] is True
    assert copied_fallback["fallback"] and not copied_fallback[
        "video_reencoded_in_final"]

    original_preflight = pipeline.media_tools.uhd_preflight
    pipeline.media_tools.uhd_preflight = lambda *_args: (False, "synthetic decline")
    try:
        fallback = os.path.join(case_dir, "Ballad Improvisation [fallback].mp4")
        report = pipeline._deliver_final(source, master, fallback, 2.0, True,
                                         progress_cb=lambda _msg: None)
    finally:
        pipeline.media_tools.uhd_preflight = original_preflight
    assert report["fallback"] and not report["delivered_uhd"], report
    assert "synthetic decline" in report["failure"], report
    assert report["summary"]["width"] == 1920
    assert report["summary"]["height"] == 1080
    assert report["summary"]["audio_channels"] == 2
    assert report["summary"]["audio_sample_rate"] == 48000

    # Explicitly honor the source's default audio disposition instead of
    # assuming that a:0 is the intended music program.
    multi = os.path.join(case_dir, "two audio programs.mkv")
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=22050:duration=0.5",
        "-f", "lavfi", "-i",
        "aevalsrc=sin(2*PI*440*t)|sin(2*PI*660*t):s=48000:d=2",
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le",
        "-disposition:a:0", "0", "-disposition:a:1", "default", multi)
    selected = media.select_audio_stream(media.probe_media(multi))
    assert selected["ordinal"] == 1 and selected["default"], selected
    selected_analysis = os.path.join(case_dir, "selected analysis.wav")
    pipeline.extract_audio(multi, selected_analysis,
                           audio_ordinal=selected["ordinal"])
    assert not os.path.exists(selected_analysis + ".ffmpeg.log")
    analysis_probe = media.summarize_probe(media.probe_media(selected_analysis))
    assert analysis_probe["duration_s"] > 1.8, analysis_probe
    selected_out = os.path.join(case_dir, "selected default audio.mp4")
    selected_report = pipeline._deliver_final(
        source, multi, selected_out, 2.0, False,
        audio_ordinal=selected["ordinal"], progress_cb=lambda _msg: None)
    assert selected_report["summary"]["audio_channels"] == 2
    assert selected_report["summary"]["audio_sample_rate"] == 48000

    bad_source = os.path.join(case_dir, "not media.bin")
    with open(bad_source, "wb") as fh:
        fh.write(b"not media")
    extraction_log = os.path.join(case_dir, "analysis failure.ffmpeg.log")
    try:
        pipeline.extract_audio(
            bad_source, os.path.join(tmp, "temporary analysis.wav"),
            log_path=extraction_log)
    except pipeline.IPlayError as exc:
        extraction_error = str(exc)
    else:
        raise AssertionError("invalid media unexpectedly extracted")
    assert extraction_log in extraction_error
    assert "Partial output preserved" not in extraction_error
    assert os.path.isfile(extraction_log)

    log_path = os.path.join(tmp, "failed.ffmpeg.log")
    failed = media.run_logged(
        [sys.executable, "-c", "import sys; sys.exit(7)"],
        stage="synthetic failure", log_path=log_path)
    diagnostic = media.format_failure("Synthetic stage", failed)
    assert "exit 7" in diagnostic
    assert "0x00000007" in diagnostic
    assert log_path in diagnostic
    assert os.path.isfile(log_path) and os.path.getsize(log_path) > 0

    windows_crash = media.CommandResult(
        command=("ffmpeg",), returncode=-1073741819, elapsed_s=1.25,
        log_path=os.path.join(case_dir, "windows-crash.log"), tail="")
    high_bit = media.format_failure("Synthetic Windows crash", windows_crash)
    assert "-1073741819" in high_bit
    assert "0xC0000005" in high_bit

    cancel_log = os.path.join(case_dir, "cancelled process.log")
    cancel_event = threading.Event()
    timer = threading.Timer(0.25, cancel_event.set)
    timer.start()
    started = time.monotonic()
    cancelled = media.run_logged(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        stage="synthetic cancellation", log_path=cancel_log,
        cancel_event=cancel_event, terminate_timeout_s=1.0)
    timer.cancel()
    assert cancelled.cancelled and not cancelled.ok, cancelled
    assert time.monotonic() - started < 5.0, cancelled
    with open(cancel_log, encoding="utf-8") as fh:
        assert "cancellation requested" in fh.read().lower()

    already_cancelled = threading.Event()
    already_cancelled.set()
    skipped = media.run_logged(
        [sys.executable, "-c", "raise SystemExit(0)"],
        stage="prelaunch cancellation",
        log_path=os.path.join(case_dir, "prelaunch cancellation.log"),
        cancel_event=already_cancelled)
    assert skipped.cancelled and skipped.returncode is None and not skipped.ok

    cancelled_probe = threading.Event()

    class HangingProbe:
        def __init__(self):
            self.returncode = None
            self.stopped = False

        def communicate(self, timeout=None):
            if self.stopped:
                return ("", "")
            cancelled_probe.set()
            raise subprocess.TimeoutExpired("ffprobe", timeout)

        def terminate(self):
            self.stopped = True
            self.returncode = -15

        def kill(self):
            self.terminate()

    hanging = HangingProbe()
    original_popen = media.subprocess.Popen
    media.subprocess.Popen = lambda *_args, **_kwargs: hanging
    try:
        try:
            media.probe_media(source, cancel_event=cancelled_probe)
        except media.RenderCancelled as exc:
            assert "cancelled" in str(exc).lower(), exc
        else:
            raise AssertionError("cancelled FFprobe remained blocking")
    finally:
        media.subprocess.Popen = original_popen
    assert hanging.stopped, "cancelled FFprobe was not terminated"

    timed_out = HangingProbe()
    cancelled_probe.clear()
    media.subprocess.Popen = lambda *_args, **_kwargs: timed_out
    try:
        try:
            media.probe_media(source, timeout_s=0)
        except media.MediaValidationError as exc:
            assert "timed out" in str(exc).lower(), exc
        else:
            raise AssertionError("FFprobe timeout was unbounded")
    finally:
        media.subprocess.Popen = original_popen
    assert timed_out.stopped, "timed-out FFprobe was not killed"

    # The injected runner is carried all the way through sync.render; this is
    # what makes every loop/cut/warp pass observable and cancellable in IPlay.
    called = {}
    old_analyze = pipeline.sy.ms.analyze_audio
    old_loop = pipeline.sy._render_loop
    try:
        pipeline.sy.ms.analyze_audio = lambda _path: {
            "bpm": 120.0, "beats": [0.0, 0.5, 1.0], "duration_s": 1.0}
        def fake_loop(_ref, _audio, _duration, _plan, _out, runner):
            called["runner"] = runner
            return {"loop_template_dur": 0.5, "loops": 1, "warped_dur": 0.5}
        pipeline.sy._render_loop = fake_loop
        sentinel = object()
        pipeline.sy.render("audio.wav", "ref.mp4", 2.0, "out.mp4",
                           policy="loop", command_runner=sentinel)
    finally:
        pipeline.sy.ms.analyze_audio = old_analyze
        pipeline.sy._render_loop = old_loop
    assert called["runner"] is sentinel

    assert pipeline.safe_output_stem("CON") == "_CON"
    safe = pipeline.safe_output_stem("Igor: Ballad? [v5y] – 琴" + "x" * 300)
    assert len(safe) <= 120 and ":" not in safe and "?" not in safe
    assert "[v5y]" in safe and "琴" in safe

    short_visual = os.path.join(case_dir, "short visual [long audio].mp4")
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=black:size=160x90:rate=12:duration=0.5",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
        "-preset", "ultrafast", "-c:a", "aac", short_visual)
    container = media.summarize_probe(media.probe_media(short_visual))
    assert container["duration_s"] > 1.8, container
    assert container["video_duration_s"] < 1.0, container
    try:
        media.validate_media(short_visual, expected_duration_s=2.0,
                             require_audio=True, duration_tolerance_s=0.1)
    except media.MediaValidationError as exc:
        assert "video stream covers only" in str(exc), exc
    else:
        raise AssertionError("short video stream falsely passed container validation")

print("pipeline resilience checks passed")
