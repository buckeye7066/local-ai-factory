"""Offline regressions for the explicit synchronized-performance path.

The tests use only local FFmpeg fixtures.  They make no network, ML, HeyGen,
or other paid-service calls.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import media  # noqa: E402
import iplay_app  # noqa: E402
import performance_source  # noqa: E402
import pipeline  # noqa: E402
import scenes  # noqa: E402


def run(*args: str) -> None:
    subprocess.run(list(args), check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.PIPE, text=True)


def make_fixtures(tmp: str) -> tuple[str, str, str, str, str]:
    performance = os.path.join(tmp, "declared synchronized performance.mp4")
    audio_only = os.path.join(tmp, "audio-only fallback.wav")
    short_video = os.path.join(tmp, "short video long audio.mp4")
    cover_image = os.path.join(tmp, "cover.jpg")
    covered_audio = os.path.join(tmp, "audio with cover art.m4a")
    multi_audio = os.path.join(tmp, "default track is audio ordinal one.mp4")
    stereo = "aevalsrc=sin(2*PI*440*t)|sin(2*PI*660*t):s=48000:d=2"
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
        "-f", "lavfi", "-i", stereo,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
        "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-ar", "48000", "-ac", "2", "-shortest", performance)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", stereo, "-c:a", "pcm_s16le", audio_only)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=blue:size=160x90", "-frames:v", "1",
        cover_image)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", audio_only, "-i", cover_image,
        "-map", "0:a:0", "-map", "1:v:0", "-c:a", "aac", "-c:v", "mjpeg",
        "-disposition:v:0", "attached_pic", covered_audio)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=black:size=160x90:rate=30:duration=0.5",
        "-f", "lavfi", "-i", stereo,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
        "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
        short_video)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=1",
        "-f", "lavfi", "-i", stereo,
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-disposition:a:0", "0",
        "-disposition:a:1", "default", multi_audio)
    return performance, audio_only, short_video, covered_audio, multi_audio


def make_display_geometry_fixtures(tmp: str) -> tuple[str, str]:
    """Create real MP4 display-matrix and non-square-pixel sources."""
    base = os.path.join(tmp, "rotation base.mp4")
    rotated = os.path.join(tmp, "display matrix 90.mp4")
    anamorphic = os.path.join(tmp, "sample aspect two to one.mp4")
    stereo = "aevalsrc=sin(2*PI*440*t)|sin(2*PI*660*t):s=48000:d=2"
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
        "-f", "lavfi", "-i", stereo,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
        "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-ar", "48000", "-ac", "2", "-shortest", base)
    # On current FFmpeg, metadata:s:v rotate does not reliably create a
    # Display Matrix. This input option does, without re-encoding the fixture.
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-display_rotation", "90", "-i", base, "-map", "0", "-c", "copy",
        rotated)
    run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
        "-f", "lavfi", "-i", stereo,
        "-map", "0:v:0", "-map", "1:a:0", "-vf", "setsar=2/1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest",
        anamorphic)
    return rotated, anamorphic


def fake_timing() -> dict:
    return {
        "duration_s": 2.0,
        "sample_rate": 22050,
        "bpm": 120.0,
        "beats": [0.0, 0.5, 1.0, 1.5],
        "onset_times": [0.0, 0.5, 1.0, 1.5],
        "onset_strength": [1.0, 1.0, 1.0, 1.0],
    }


with tempfile.TemporaryDirectory(prefix="iplay_source_preserved_") as tmp:
    performance, audio_only, short_video, covered_audio, multi_audio = \
        make_fixtures(tmp)
    rotated_performance, anamorphic_performance = \
        make_display_geometry_fixtures(tmp)

    probe = pipeline.validate_source_performance_input(performance)
    assert probe["has_video"] and probe["has_audio"], probe
    assert probe["audio_sample_rate_hz"] == 48000, probe
    assert abs(probe["video_duration_s"] - probe["audio_duration_s"]) \
        <= probe["duration_tolerance_s"], probe
    try:
        pipeline.validate_source_performance_input(short_video)
    except pipeline.IPlayError as exc:
        assert "same timeline" in str(exc).lower(), exc
    else:
        raise AssertionError("short video with long audio was accepted as full motion")
    try:
        pipeline.validate_source_performance_input(covered_audio)
    except pipeline.IPlayError as exc:
        assert "cover art" in str(exc).lower(), exc
    else:
        raise AssertionError("attached cover art was accepted as performance video")
    multi_probe = pipeline.validate_source_performance_input(multi_audio)
    assert multi_probe["audio_stream_ordinal"] == 1, multi_probe
    assert multi_probe["audio_sample_rate_hz"] == 48000, multi_probe
    assert abs(multi_probe["audio_duration_s"] - 2.0) < 0.01, multi_probe
    try:
        pipeline.validate_source_performance_input(multi_audio, audio_ordinal=0)
    except pipeline.IPlayError as exc:
        assert "same timeline" in str(exc).lower(), exc
    else:
        raise AssertionError("non-default short audio track passed source validation")

    # Multiple timeline videos are safe only when one is uniquely marked as
    # the intended default. Starts use a separate sub-frame zero-origin policy,
    # not the looser two-frame endpoint tolerance.
    synthetic_probe = {
        "streams": [
            {"index": 0, "codec_type": "video", "duration": "10",
             "start_time": "0", "avg_frame_rate": "60000/1001",
             "r_frame_rate": "60000/1001", "width": 1920, "height": 1080,
             "sample_aspect_ratio": "1:1", "display_aspect_ratio": "16:9",
             "disposition": {"attached_pic": 0, "default": 0}},
            {"index": 1, "codec_type": "video", "duration": "10",
             "start_time": "0", "avg_frame_rate": "60000/1001",
             "r_frame_rate": "60000/1001", "width": 3840, "height": 2160,
             "sample_aspect_ratio": "1:1", "display_aspect_ratio": "16:9",
             "disposition": {"attached_pic": 0, "default": 1}},
            {"index": 2, "codec_type": "audio", "duration": "10",
             "start_time": "0", "sample_rate": "48000",
             "disposition": {"default": 1}},
        ],
        "format": {"duration": "10"},
    }
    selected_video = performance_source.validate_performance_media(
        "synthetic", probe_info=synthetic_probe)
    assert selected_video["video_stream_ordinal"] == 1, selected_video
    assert selected_video["video_stream_index"] == 1, selected_video
    assert selected_video["video_frame_rate"] == "60000/1001", selected_video
    assert selected_video["width"] == 3840 and selected_video["height"] == 2160
    assert selected_video["start_tolerance_s"] < 0.01, selected_video
    assert selected_video["video_display_geometry"] == {
        "encoded_width": 3840,
        "encoded_height": 2160,
        "reported_sample_aspect_ratio": "1:1",
        "sample_aspect_ratio": "1/1",
        "sample_aspect_ratio_source": "sample_aspect_ratio",
        "reported_display_aspect_ratio": "16:9",
        "encoded_display_aspect_ratio": "16/9",
        "rotation_degrees": 0,
        "rotation_source": "none",
        "display_width": 3840,
        "display_height": 2160,
        "display_aspect_ratio": "16/9",
        "display_raster_aspect_ratio": "16/9",
        "display_raster_aspect_error": 0.0,
        "output_sample_aspect_ratio": "1/1",
    }, selected_video

    ambiguous_probe = json.loads(json.dumps(synthetic_probe))
    ambiguous_probe["streams"][1]["disposition"]["default"] = 0
    try:
        performance_source.validate_performance_media(
            "synthetic", probe_info=ambiguous_probe)
    except performance_source.PerformanceSourceError as exc:
        assert "multiple timeline video" in str(exc).lower(), exc
    else:
        raise AssertionError("ambiguous multi-video source was accepted")

    missing_start_probe = json.loads(json.dumps(synthetic_probe))
    missing_start_probe["streams"][2].pop("start_time")
    try:
        performance_source.validate_performance_media(
            "synthetic", probe_info=missing_start_probe)
    except performance_source.PerformanceSourceError as exc:
        assert "prove independent" in str(exc).lower(), exc
    else:
        raise AssertionError("source with unproven audio start was accepted")

    offset_start_probe = json.loads(json.dumps(synthetic_probe))
    offset_start_probe["streams"][2]["start_time"] = "0.049"
    try:
        performance_source.validate_performance_media(
            "synthetic", probe_info=offset_start_probe)
    except performance_source.PerformanceSourceError as exc:
        assert "zero-origin" in str(exc).lower(), exc
    else:
        raise AssertionError("49ms audio offset passed the identity contract")

    # Display geometry is part of the protected source contract. Arbitrary or
    # contradictory rotation and hostile aspect metadata fail before FFmpeg is
    # allowed to allocate an output raster.
    conflicting_rotation = json.loads(json.dumps(synthetic_probe["streams"][1]))
    conflicting_rotation["side_data_list"] = [{"rotation": 90}]
    conflicting_rotation["tags"] = {"rotate": "180"}
    try:
        media.video_display_geometry(conflicting_rotation)
    except media.MediaValidationError as exc:
        assert "conflicting rotation" in str(exc).lower(), exc
    else:
        raise AssertionError("conflicting rotation metadata was accepted")

    tag_rotation = json.loads(json.dumps(synthetic_probe["streams"][1]))
    tag_rotation["tags"] = {"rotate": "90"}
    tag_geometry = media.video_display_geometry(tag_rotation)
    assert tag_geometry["rotation_source"] == "rotate_tag", tag_geometry
    assert tag_geometry["rotation_degrees"] == 90, tag_geometry
    assert tag_geometry["display_width"] == 2160, tag_geometry
    assert tag_geometry["display_height"] == 3840, tag_geometry

    arbitrary_rotation = json.loads(json.dumps(synthetic_probe["streams"][1]))
    arbitrary_rotation["side_data_list"] = [{"rotation": 45}]
    try:
        media.video_display_geometry(arbitrary_rotation)
    except media.MediaValidationError as exc:
        assert "right-angle" in str(exc).lower(), exc
    else:
        raise AssertionError("arbitrary source rotation was accepted")

    extreme_aspect = json.loads(json.dumps(synthetic_probe["streams"][1]))
    extreme_aspect["sample_aspect_ratio"] = "1000000000:1"
    extreme_aspect.pop("display_aspect_ratio")
    try:
        media.video_display_geometry(extreme_aspect)
    except media.MediaValidationError as exc:
        assert "aspect exceeds" in str(exc).lower(), exc
    else:
        raise AssertionError("hostile sample aspect ratio was accepted")

    missing_aspect = json.loads(json.dumps(synthetic_probe["streams"][1]))
    missing_aspect.pop("sample_aspect_ratio")
    missing_aspect.pop("display_aspect_ratio")
    try:
        media.video_display_geometry(missing_aspect)
    except media.MediaValidationError as exc:
        assert "no provable sample or display aspect" in str(exc).lower(), exc
    else:
        raise AssertionError("unproven display aspect was accepted")

    oversized_raster = json.loads(json.dumps(synthetic_probe["streams"][1]))
    oversized_raster.update({"width": 20000, "height": 1080})
    oversized_raster.pop("display_aspect_ratio")
    try:
        media.video_display_geometry(oversized_raster)
    except media.MediaValidationError as exc:
        assert "encoded raster exceeds" in str(exc).lower(), exc
    else:
        raise AssertionError("oversized encoded raster was accepted")

    director_profile = pipeline._source_director_profile(
        selected_video, uhd=True)
    assert director_profile["width"] == 3840, director_profile
    assert director_profile["height"] == 2160, director_profile
    assert director_profile["fps"] == "60000/1001", director_profile
    assert director_profile["performance_video_ordinal"] == 1, director_profile
    assert (director_profile["performance_display_geometry"]
            == selected_video["video_display_geometry"]), director_profile
    fallback_profile = pipeline._source_director_profile(
        selected_video, uhd=False, fallback_1080=True)
    assert fallback_profile["width"] == 1920, fallback_profile
    assert fallback_profile["height"] == 1080, fallback_profile
    assert fallback_profile["fps"] == "60000/1001", fallback_profile
    assert fallback_profile["performance_video_ordinal"] == 1, fallback_profile
    assert (fallback_profile["performance_display_geometry"]
            == selected_video["video_display_geometry"]), fallback_profile
    captured_director = {}
    old_scene_runner = scenes.media_tools.run_logged
    def capture_director(command, **_kwargs):
        captured_director["command"] = command
        return media.CommandResult(
            tuple(command), 1, 0.01, os.path.join(tmp, "captured.log"), "")
    scenes.media_tools.run_logged = capture_director
    try:
        try:
            scenes.render_local_director(
                performance, fake_timing(), os.path.join(tmp, "not-rendered.mp4"),
                width=160, height=90, fps="60000/1001",
                performance_video_ordinal=1,
                performance_display_geometry=(
                    selected_video["video_display_geometry"]),
                motion_source_tier="source-preserved",
                progress_cb=lambda _message: None)
        except scenes.SceneStitchError:
            pass
        else:
            raise AssertionError("synthetic failing director unexpectedly passed")
    finally:
        scenes.media_tools.run_logged = old_scene_runner
    filter_graph = captured_director["command"][
        captured_director["command"].index("-filter_complex") + 1]
    assert "[0:v:1]" in filter_graph, filter_graph
    assert ("scale=3840:2160:flags=lanczos,setsar=1"
            "[performance_display]" in filter_graph), filter_graph
    assert "fps=60000/1001" in filter_graph, filter_graph
    assert "trim=start_frame=0:end_frame=" in filter_graph, filter_graph
    assert "tpad=stop_mode=clone" not in filter_graph, filter_graph

    rotated_probe = pipeline.validate_source_performance_input(
        rotated_performance)
    rotated_geometry = rotated_probe["video_display_geometry"]
    assert rotated_geometry["encoded_width"] == 160, rotated_geometry
    assert rotated_geometry["encoded_height"] == 90, rotated_geometry
    assert rotated_geometry["rotation_degrees"] in {90, 270}, rotated_geometry
    assert rotated_geometry["display_width"] == 90, rotated_geometry
    assert rotated_geometry["display_height"] == 160, rotated_geometry
    assert rotated_geometry["display_aspect_ratio"] == "9/16", rotated_geometry

    anamorphic_probe = pipeline.validate_source_performance_input(
        anamorphic_performance)
    anamorphic_geometry = anamorphic_probe["video_display_geometry"]
    assert anamorphic_geometry["encoded_width"] == 160, anamorphic_geometry
    assert anamorphic_geometry["encoded_height"] == 90, anamorphic_geometry
    assert anamorphic_geometry["sample_aspect_ratio"] == "2/1", \
        anamorphic_geometry
    assert anamorphic_geometry["display_width"] == 320, anamorphic_geometry
    assert anamorphic_geometry["display_height"] == 90, anamorphic_geometry
    assert anamorphic_geometry["display_aspect_ratio"] == "32/9", \
        anamorphic_geometry

    # Real director encodes prove native display geometry becomes square-pixel
    # output without losing the selected source cadence or frame count.
    geometry_cases = [
        (rotated_performance, rotated_probe, "rotated native director.mp4"),
        (anamorphic_performance, anamorphic_probe,
         "anamorphic native director.mp4"),
    ]
    for source_path, source_probe, output_name in geometry_cases:
        native_profile = pipeline._source_director_profile(
            source_probe, uhd=False)
        native_out = os.path.join(tmp, output_name)
        native_report = scenes.render_local_director(
            source_path, fake_timing(), native_out,
            motion_source_tier="source-preserved",
            progress_cb=lambda _message: None,
            **native_profile)
        output_stream = media.video_stream_at(media.probe_media(native_out), 0)
        output_geometry = media.video_display_geometry(output_stream)
        expected_geometry = source_probe["video_display_geometry"]
        assert output_geometry["display_width"] == \
            expected_geometry["display_width"], output_geometry
        assert output_geometry["display_height"] == \
            expected_geometry["display_height"], output_geometry
        assert output_geometry["sample_aspect_ratio"] == "1/1", output_geometry
        assert output_geometry["rotation_degrees"] == 0, output_geometry
        assert media.video_frame_rate(output_stream)["rational"] == "30/1"
        assert int(output_stream["nb_frames"]) == 60, output_stream
        assert native_report["video_contract"]["display_geometry_preserved"]
        assert (native_report["video_contract"]["source_display_geometry"]
                == expected_geometry), native_report

    # Capture (without launching a 4K test encode) proves both real fixture
    # shapes normalize to their display raster *before* UHD framing. This is
    # the path that prevents setsar=1 from squashing an anamorphic performance.
    for source_path, source_probe, _output_name in geometry_cases:
        captured_uhd = {}
        old_scene_runner = scenes.media_tools.run_logged
        def capture_uhd(command, **_kwargs):
            captured_uhd["command"] = command
            return media.CommandResult(
                tuple(command), 1, 0.01,
                os.path.join(tmp, "captured-uhd.log"), "")
        scenes.media_tools.run_logged = capture_uhd
        try:
            try:
                scenes.render_local_director(
                    source_path, fake_timing(),
                    os.path.join(tmp, "not-rendered-uhd.mp4"),
                    motion_source_tier="source-preserved",
                    progress_cb=lambda _message: None,
                    **pipeline._source_director_profile(
                        source_probe, uhd=True))
            except scenes.SceneStitchError:
                pass
            else:
                raise AssertionError("captured UHD director unexpectedly passed")
        finally:
            scenes.media_tools.run_logged = old_scene_runner
        uhd_filter = captured_uhd["command"][
            captured_uhd["command"].index("-filter_complex") + 1]
        source_geometry = source_probe["video_display_geometry"]
        assert (f"scale={source_geometry['display_width']}:"
                f"{source_geometry['display_height']}:flags=lanczos,"
                "setsar=1[performance_display]" in uhd_filter), uhd_filter
        assert "scale=3840:2160:force_original_aspect_ratio=decrease" \
            in uhd_filter, uhd_filter

    mapping = performance_source.identity_sample_mapping(2.0, 22050)
    assert mapping["kind"] == "same-media-identity", mapping
    assert mapping["rate"] == 1.0 and mapping["monotonic"], mapping
    assert not mapping["retimed"] and not mapping["reversed"], mapping
    assert mapping["points"] == [
        {"source_sample": 0, "master_sample": 0},
        {"source_sample": 44100, "master_sample": 44100},
    ], mapping

    try:
        performance_source.build_performance_source_record(
            performance, fake_timing(), rights_acknowledged=False,
            probe=probe)
    except performance_source.PerformanceSourceError as exc:
        assert "permission" in str(exc).lower(), exc
    else:
        raise AssertionError("source-preserved mode accepted no rights acknowledgment")
    mismatched_timing = fake_timing()
    mismatched_timing["duration_s"] = 1.5
    try:
        performance_source.build_performance_source_record(
            performance, mismatched_timing, rights_acknowledged=True,
            probe=probe)
    except performance_source.PerformanceSourceError as exc:
        assert "does not match" in str(exc).lower(), exc
    else:
        raise AssertionError("mismatched analysis/source durations were accepted")

    calls = {"manifest": 0, "sync": 0, "director": 0,
             "analysis_audio_ordinal": [], "uhd_preflight": 0}
    old_manifest = pipeline.load_manifest
    old_render = pipeline.sy.render
    old_analyze = pipeline.ms.analyze_audio
    old_director = scenes.render_local_director
    old_extract = pipeline.extract_audio
    old_preflight = pipeline.media_tools.uhd_preflight

    def forbidden_manifest(*_args, **_kwargs):
        calls["manifest"] += 1
        raise AssertionError("source-preserved path loaded the reference manifest")

    def forbidden_sync(*_args, **_kwargs):
        calls["sync"] += 1
        raise AssertionError("source-preserved path invoked sync.render")

    def observed_director(source_path, *args, **kwargs):
        calls["director"] += 1
        assert os.path.abspath(source_path) == os.path.abspath(multi_audio), source_path
        assert kwargs.get("motion_source_tier") == "source-preserved", kwargs
        assert kwargs.get("performance_video_ordinal") == 0, kwargs
        assert kwargs.get("width") == 1920 and kwargs.get("height") == 1080, kwargs
        assert kwargs.get("fps") == "30/1", kwargs
        geometry = kwargs.get("performance_display_geometry")
        assert geometry["encoded_width"] == 160, geometry
        assert geometry["encoded_height"] == 90, geometry
        assert geometry["display_width"] == 160, geometry
        assert geometry["display_height"] == 90, geometry
        assert geometry["sample_aspect_ratio"] == "1/1", geometry
        return old_director(source_path, *args, **kwargs)

    def observed_extract(input_path, out_wav, **kwargs):
        assert os.path.abspath(input_path) == os.path.abspath(multi_audio)
        calls["analysis_audio_ordinal"].append(kwargs.get("audio_ordinal"))
        return old_extract(input_path, out_wav, **kwargs)

    pipeline.load_manifest = forbidden_manifest
    pipeline.sy.render = forbidden_sync
    pipeline.ms.analyze_audio = lambda _wav: fake_timing()
    pipeline.extract_audio = observed_extract
    def decline_uhd(*_args):
        calls["uhd_preflight"] += 1
        return False, "synthetic source-director resource decline"
    pipeline.media_tools.uhd_preflight = decline_uhd
    scenes.render_local_director = observed_director
    source_out = os.path.join(tmp, "source preserved final.mp4")
    try:
        source_report = pipeline.build_video(
            multi_audio, [], "piano", source_out, uhd=True,
            local_director=True, source_performance=True,
            progress_cb=lambda _message: None)
    finally:
        pipeline.load_manifest = old_manifest
        pipeline.sy.render = old_render
        pipeline.ms.analyze_audio = old_analyze
        pipeline.extract_audio = old_extract
        pipeline.media_tools.uhd_preflight = old_preflight
        scenes.render_local_director = old_director

    assert calls == {"manifest": 0, "sync": 0, "director": 1,
                     "analysis_audio_ordinal": [1], "uhd_preflight": 1}, calls
    assert source_report["policy"] == "source-preserved", source_report
    assert source_report["motion_source_tier"] == "source-preserved", source_report
    assert "contacts not yet classified" in source_report["motion_accuracy"], source_report
    report_mapping = source_report["plan"]["timeline_mapping"]
    assert report_mapping["sample_rate_hz"] == 48000, report_mapping
    assert report_mapping["points"] == [
        {"source_sample": 0, "master_sample": 0},
        {"source_sample": 96000, "master_sample": 96000},
    ], report_mapping
    assert report_mapping["monotonic"] and report_mapping["rate"] == 1.0
    assert not report_mapping["retimed"] and not report_mapping["reversed"]
    assert source_report["render_fallback"], source_report
    assert source_report["final_video_reencoded"] is False, source_report
    assert source_report["output_width"] == 1920, source_report

    output_probe = media.probe_media(source_out)
    output_audio = [stream for stream in output_probe["streams"]
                    if stream.get("codec_type") == "audio"]
    output_video = [stream for stream in output_probe["streams"]
                    if stream.get("codec_type") == "video"]
    assert len(output_audio) == 1 and len(output_video) == 1, output_probe
    output_summary = media.summarize_probe(output_probe)
    assert output_summary["audio_channels"] == 2, output_summary
    assert output_summary["audio_sample_rate"] == 48000, output_summary
    assert source_report["audio_master"]["continuous"], source_report
    assert not source_report["audio_master"]["analysis_wav_used_in_final"]
    assert source_report["audio_master"]["selected_source_stream"]["ordinal"] == 1

    manifest_path = source_report["local_edit"]["manifest_path"]
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    provenance = manifest["performance_source_provenance"]
    declaration = provenance["provenance"]
    assert manifest["motion_source_tier"] == "source-preserved", manifest
    assert declaration["user_declared_actual_synchronized_performance"] is True
    assert declaration["rights_acknowledged"] is True
    assert declaration["rights_not_verified_by_iplay"] is True
    assert provenance["source_file"]["basename"] == os.path.basename(multi_audio)
    assert tmp not in json.dumps(manifest), "scene manifest leaked an absolute path"
    assert provenance["motion_contract"]["real_source_motion_preserved"] is True
    assert provenance["motion_contract"]["display_geometry_preserved"] is True
    assert provenance["motion_contract"]["contacts_classified"] is False
    assert provenance["timeline_mapping"]["sample_rate_hz"] == 48000
    assert provenance["duration_reconciliation"]["within_tolerance"] is True
    performance_scenes = [scene for scene in manifest["scenes"]
                          if scene["role"] == "performance"]
    assert performance_scenes, manifest
    assert all(scene["motion_source"] == "selected-source-video"
               for scene in performance_scenes)
    assert all(scene["avatar_visible"] is None
               and scene["performer_visibility"] == "not_inspected"
               and scene["content_verification"] == "not_inspected"
               for scene in performance_scenes), performance_scenes
    assert all(scene["motion_timeline_transform"] == {
        "kind": "same-media-identity", "rate": 1.0,
        "retimed": False, "reversed": False,
    } for scene in performance_scenes), performance_scenes
    assert all("retime" not in scene["allowed_transforms"]
               and "reverse" not in scene["allowed_transforms"]
               for scene in performance_scenes)
    assert manifest["audio_master"]["continuous"] is True
    assert manifest["video_contract"]["display_geometry_preserved"] is True
    assert manifest["video_contract"]["source_display_geometry"] == \
        provenance["probe"]["video_display_geometry"]

    # Source-preserved mode can still schedule performer-free mood scenes.
    # Local assets remain explicitly uninspected and never become a motion
    # authority or an audio source.
    cutaway_timing = fake_timing()
    cutaway_timing["duration_s"] = 48.0
    cutaway_timing["beats"] = [float(i) for i in range(49)]
    cutaway_timing["onset_times"] = [float(i) for i in range(49)]
    cutaway_plan = scenes.plan_local_scenes(
        cutaway_timing, cutaway_count=1,
        motion_source_tier="source-preserved")
    cutaway_scenes = [scene for scene in cutaway_plan
                      if scene["role"] == "cutaway"]
    assert cutaway_scenes, cutaway_plan
    assert all(scene["motion_source"] == "local-cutaway-asset"
               and scene["motion_source_tier"] == "unclassified-local-asset"
               and scene["avatar_visible"] is None
               and scene["content_verification"] == "not_inspected"
               and scene["audio_locked"] is True
               for scene in cutaway_scenes), cutaway_scenes

    # If a preflight-approved UHD director still fails under real encode load,
    # do not immediately launch a second full-song UHD software encode.
    old_analyze_retry = pipeline.ms.analyze_audio
    old_preflight_retry = pipeline.media_tools.uhd_preflight
    old_director_retry = scenes.render_local_director
    old_deliver_retry = pipeline._deliver_final
    retry_observed = {"preflight": 0, "deliver": []}
    pipeline.ms.analyze_audio = lambda _wav: fake_timing()
    def approve_once(*_args):
        retry_observed["preflight"] += 1
        return True, "synthetic approval"
    pipeline.media_tools.uhd_preflight = approve_once
    scenes.render_local_director = lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(scenes.SceneStitchError("synthetic UHD OOM")))
    def capture_declined_retry(*_args, **kwargs):
        retry_observed["deliver"].append(kwargs)
        return {
            "summary": {"width": 1920, "height": 1080, "duration_s": 2.0,
                        "audio_codec": "aac", "audio_channels": 2,
                        "audio_sample_rate": 48000},
            "label": "synthetic 1080p fallback",
            "requested_uhd": True, "delivered_uhd": False,
            "fallback": True, "failure": kwargs["uhd_decline_reason"],
            "video_reencoded_in_final": False,
        }
    pipeline._deliver_final = capture_declined_retry
    try:
        retry_report = pipeline.build_video(
            multi_audio, [], "piano", os.path.join(tmp, "retry fallback.mp4"),
            uhd=True, local_director=True, source_performance=True,
            progress_cb=lambda _message: None)
    finally:
        pipeline.ms.analyze_audio = old_analyze_retry
        pipeline.media_tools.uhd_preflight = old_preflight_retry
        scenes.render_local_director = old_director_retry
        pipeline._deliver_final = old_deliver_retry
    assert retry_observed["preflight"] == 1, retry_observed
    assert len(retry_observed["deliver"]) == 1, retry_observed
    decline = retry_observed["deliver"][0]["uhd_decline_reason"]
    assert "will not launch a second UHD" in decline and "synthetic UHD OOM" in decline
    retry_geometry = retry_observed["deliver"][0]["source_display_geometry"]
    assert retry_geometry == multi_probe["video_display_geometry"], retry_geometry
    assert retry_report["local_edit"]["status"] == "fallback", retry_report

    # Checked audio-only input is rejected before manifest lookup or rendering.
    rejection_calls = {"manifest": 0}

    def rejection_manifest(*_args, **_kwargs):
        rejection_calls["manifest"] += 1
        raise AssertionError("checked audio-only input reached manifest lookup")

    pipeline.load_manifest = rejection_manifest
    try:
        try:
            pipeline.build_video(
                audio_only, [], "piano", os.path.join(tmp, "must-not-exist.mp4"),
                uhd=False, local_director=False, source_performance=True,
                progress_cb=lambda _message: None)
        except pipeline.IPlayError as exc:
            assert "video stream" in str(exc).lower(), exc
        else:
            raise AssertionError("checked audio-only input was accepted")
    finally:
        pipeline.load_manifest = old_manifest
    assert rejection_calls["manifest"] == 0, rejection_calls

    # The same audio-only file retains the established beat-only fallback when
    # the declaration is unchecked.
    fallback_calls = {"manifest": 0, "sync": 0}

    def fallback_manifest(_instrument):
        fallback_calls["manifest"] += 1
        return {"file": performance, "stroke_hz": 2.0,
                "first_stroke_s": 0.0, "strokes_per_beat": 1.0}

    def fallback_render(_wav, _ref_file, _stroke_hz, out_path, **kwargs):
        fallback_calls["sync"] += 1
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            out_path)
        return {"policy": kwargs["policy"], "warp": False, "first_beat": 0.0}

    pipeline.load_manifest = fallback_manifest
    pipeline.sy.render = fallback_render
    pipeline.ms.analyze_audio = lambda _wav: fake_timing()
    old_choose = pipeline.choose_policy
    pipeline.choose_policy = lambda *_args: {
        "policy": "loop", "reason": "synthetic fallback",
        "strokes_per_beat": 1.0,
    }
    fallback_out = os.path.join(tmp, "audio-only beat fallback.mp4")
    try:
        fallback_report = pipeline.build_video(
            audio_only, [], "piano", fallback_out, uhd=False,
            local_director=False, source_performance=False,
            progress_cb=lambda _message: None)
    finally:
        pipeline.load_manifest = old_manifest
        pipeline.sy.render = old_render
        pipeline.ms.analyze_audio = old_analyze
        pipeline.choose_policy = old_choose
    assert fallback_calls == {"manifest": 1, "sync": 1}, fallback_calls
    assert fallback_report["motion_source_tier"] == "beat-only", fallback_report
    assert fallback_report["source_performance"] is None, fallback_report
    fallback_probe = media.probe_media(fallback_out)
    assert len([stream for stream in fallback_probe["streams"]
                if stream.get("codec_type") == "audio"]) == 1

    # Exercise the GUI picker contract without opening a Tk window. It accepts
    # existing image/video assets, de-duplicates them, reports ignored inputs,
    # and clears both the main-thread list and visible count.
    class FakeStringVar:
        value = ""

        def set(self, value):
            self.value = value

    picker_app = object.__new__(iplay_app.IPlayApp)
    picker_app.cutaway_files = []
    picker_app.cutaway_count = FakeStringVar()
    picker_logs = []
    picker_app.log_line = picker_logs.append
    cover_image = os.path.join(tmp, "cover.jpg")
    missing_video = os.path.join(tmp, "missing.mp4")
    old_picker = iplay_app.filedialog.askopenfilenames
    iplay_app.filedialog.askopenfilenames = lambda **_kwargs: (
        cover_image, performance, cover_image, audio_only, missing_video)
    try:
        picker_app.browse_cutaways()
    finally:
        iplay_app.filedialog.askopenfilenames = old_picker
    assert picker_app.cutaway_files == [
        os.path.abspath(cover_image), os.path.abspath(performance)], \
        picker_app.cutaway_files
    assert picker_app.cutaway_count.value.startswith("2 assets"), \
        picker_app.cutaway_count.value
    assert picker_logs and "ignored" in picker_logs[0], picker_logs
    picker_app.clear_cutaways()
    assert picker_app.cutaway_files == []
    assert picker_app.cutaway_count.value.startswith("0 assets"), \
        picker_app.cutaway_count.value

with open(os.path.join(HERE, "iplay_app.py"), encoding="utf-8") as fh:
    gui_source = fh.read()
assert "Selected video is the actual synchronized performance" in gui_source
assert "I have permission to use it" in gui_source
create_source = gui_source.split("def create_video(self):", 1)[1].split(
    "def _worker", 1)[0]
assert "validate_source_performance_input(music)" not in create_source
assert "source_performance=source_performance" in gui_source
assert "cancel_event=self._render_cancel" in gui_source
assert "Mood/B-roll" in gui_source
assert "filedialog.askopenfilenames" in gui_source
assert "list(self.cutaway_files)" in gui_source
assert "cutaway_files=cutaway_files" in gui_source
assert "used locally/uninspected" in gui_source
assert "master audio stays continuous" in gui_source

print("source-preserved performance checks passed")
