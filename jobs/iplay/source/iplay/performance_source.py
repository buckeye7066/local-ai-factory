"""Contracts for preserving a synchronized performance already in the input.

This module deliberately does no motion inference.  When the user explicitly
identifies the selected video as the real, synchronized performance, the
decoded video and audio already share the strongest timeline available.  The
only valid mapping for this first source-preserved slice is therefore a
forward, unit-rate identity mapping.
"""
from __future__ import annotations

from fractions import Fraction
import math
import os

import media as media_tools


MOTION_SOURCE_TIER = "source-preserved"
ACCURACY_STATEMENT = (
    "Real synchronized source motion preserved; contacts not yet classified."
)


class PerformanceSourceError(ValueError):
    """The selected file cannot satisfy the source-preserved contract."""


def _stream_duration_s(stream: dict) -> float | None:
    try:
        value = float(stream.get("duration"))
        if math.isfinite(value) and value > 0:
            return value
    except (TypeError, ValueError):
        pass
    try:
        ticks = int(stream["duration_ts"])
        numerator, denominator = str(stream["time_base"]).split("/", 1)
        value = ticks * int(numerator) / int(denominator)
        if math.isfinite(value) and value > 0:
            return value
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        pass
    return None


def _stream_start_s(stream: dict) -> float | None:
    try:
        value = float(stream.get("start_time"))
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def _exact_video_rate(stream: dict) -> dict | None:
    """Require a positive, constant cadence that can be carried exactly."""
    rates: dict[str, Fraction] = {}
    for key in ("avg_frame_rate", "r_frame_rate"):
        try:
            value = Fraction(str(stream.get(key)))
        except (ValueError, ZeroDivisionError):
            return None
        if value <= 0:
            return None
        rates[key] = value
    if rates["avg_frame_rate"] != rates["r_frame_rate"]:
        return None
    value = rates["avg_frame_rate"]
    return {
        "rational": f"{value.numerator}/{value.denominator}",
        "numerator": value.numerator,
        "denominator": value.denominator,
        "fps": float(value),
        "constant": True,
    }


def validate_performance_media(path: str, *, audio_ordinal: int | None = None,
                               probe_info: dict | None = None) -> dict:
    """Require a real video stream and audio stream in the same container."""
    try:
        info = probe_info or media_tools.probe_media(path)
    except media_tools.MediaValidationError as exc:
        raise PerformanceSourceError(str(exc)) from exc

    streams = info.get("streams") or []
    audios = [stream for stream in streams
              if stream.get("codec_type") == "audio"]
    try:
        selected_video = media_tools.select_video_stream(info)
    except media_tools.MediaValidationError as exc:
        selected_video = None
        video_error = str(exc)
    if selected_video is None or not audios:
        missing = []
        if selected_video is None:
            missing.append(video_error)
        if not audios:
            missing.append("an audio stream")
        raise PerformanceSourceError(
            "Source-preserved performance cannot use this file: "
            + "; ".join(missing)
            + ". Uncheck the performance-source option to use IPlay's beat-only "
              "reference-motion fallback."
        )

    summary = media_tools.summarize_probe(info)
    if audio_ordinal is None:
        selector = getattr(media_tools, "select_audio_stream", None)
        if selector is not None:
            selected = selector(info)
            audio_ordinal = int(selected["ordinal"])
        else:
            audio_ordinal = next(
                (i for i, stream in enumerate(audios)
                 if int((stream.get("disposition") or {}).get("default") or 0) == 1),
                0)
    if audio_ordinal < 0 or audio_ordinal >= len(audios):
        raise PerformanceSourceError(
            f"Selected audio ordinal {audio_ordinal} is unavailable; the file "
            f"contains {len(audios)} audio stream(s)."
        )
    video_ordinal = int(selected_video["ordinal"])
    video = media_tools.video_stream_at(info, video_ordinal)
    audio = audios[audio_ordinal]
    video_duration_s = _stream_duration_s(video)
    audio_duration_s = _stream_duration_s(audio)
    if video_duration_s is None or audio_duration_s is None:
        raise PerformanceSourceError(
            "Source-preserved performance could not prove independent video "
            "and audio stream durations, so IPlay will not claim that real "
            "motion covers the full song."
        )
    frame_rate = _exact_video_rate(video)
    if frame_rate is None:
        raise PerformanceSourceError(
            "Source-preserved performance requires a provable constant video "
            "cadence (matching positive avg_frame_rate and r_frame_rate)."
        )
    fps = float(frame_rate["fps"])
    try:
        display_geometry = media_tools.video_display_geometry(video)
    except media_tools.MediaValidationError as exc:
        raise PerformanceSourceError(
            "Source-preserved performance could not prove the selected "
            f"video's display geometry: {exc}.") from exc
    duration_tolerance_s = max(0.050, 2.0 / fps)
    duration_gap_s = abs(video_duration_s - audio_duration_s)
    if duration_gap_s > duration_tolerance_s:
        raise PerformanceSourceError(
            "Source-preserved performance requires video and audio to cover "
            "the same timeline. The video is "
            f"{video_duration_s:.3f}s and the audio is {audio_duration_s:.3f}s "
            f"(allowed difference {duration_tolerance_s:.3f}s). Uncheck the "
            "performance-source option to use IPlay's beat-only reference-motion "
            "fallback."
        )

    video_start_s = _stream_start_s(video)
    audio_start_s = _stream_start_s(audio)
    start_tolerance_s = min(0.010, 0.5 / fps)
    if video_start_s is None or audio_start_s is None:
        raise PerformanceSourceError(
            "Source-preserved performance could not prove independent video "
            "and audio stream starts, so a zero-origin identity timeline is "
            "unavailable."
        )
    if (abs(video_start_s) > start_tolerance_s
            or abs(audio_start_s) > start_tolerance_s
            or abs(video_start_s - audio_start_s) > start_tolerance_s):
        raise PerformanceSourceError(
            "Source-preserved performance requires independently proven, "
            "zero-origin synchronized stream starts. "
            f"Video begins at {video_start_s:.3f}s and audio begins at "
            f"{audio_start_s:.3f}s (allowed start tolerance "
            f"{start_tolerance_s:.3f}s)."
        )
    try:
        audio_sample_rate = int(audio.get("sample_rate"))
    except (TypeError, ValueError):
        audio_sample_rate = 0
    if audio_sample_rate <= 0:
        raise PerformanceSourceError(
            "Source-preserved performance could not prove the original master "
            "audio sample rate, so a sample-accurate identity map is unavailable."
        )

    # The shorter independently proven endpoint is conservative; the duration
    # equality check above ensures this can remove at most a frame-scale tail.
    source_duration_s = min(video_duration_s, audio_duration_s)
    return {
        "has_video": True,
        "has_audio": True,
        "container_duration_s": float(summary.get("duration_s") or 0.0),
        "video_duration_s": video_duration_s,
        "audio_duration_s": audio_duration_s,
        "source_duration_s": source_duration_s,
        "duration_tolerance_s": duration_tolerance_s,
        "start_tolerance_s": start_tolerance_s,
        "start_policy": "independently-proven-zero-origin",
        "video_start_s": video_start_s,
        "audio_start_s": audio_start_s,
        "video_stream_index": video.get("index"),
        "video_stream_ordinal": video_ordinal,
        "audio_stream_index": audio.get("index"),
        "audio_stream_ordinal": audio_ordinal,
        "video_codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name"),
        "audio_sample_rate_hz": audio_sample_rate,
        "video_fps": fps,
        "video_frame_rate": frame_rate["rational"],
        "video_cadence": frame_rate,
        # ``width``/``height`` are retained as display-raster aliases for
        # callers predating the explicit geometry record. Encoded dimensions
        # remain separately available and are never used as display geometry.
        "width": display_geometry["display_width"],
        "height": display_geometry["display_height"],
        "encoded_width": display_geometry["encoded_width"],
        "encoded_height": display_geometry["encoded_height"],
        "display_width": display_geometry["display_width"],
        "display_height": display_geometry["display_height"],
        "video_display_geometry": display_geometry,
    }


def identity_sample_mapping(duration_s: float, sample_rate_hz: int) -> dict:
    """Describe the only allowed source-to-master timing transform."""
    duration_s = float(duration_s)
    sample_rate_hz = int(sample_rate_hz)
    if duration_s <= 0 or sample_rate_hz <= 0:
        raise PerformanceSourceError(
            "Identity mapping requires positive duration and sample rate."
        )
    end_sample = max(1, round(duration_s * sample_rate_hz))
    points = [
        {"source_sample": 0, "master_sample": 0},
        {"source_sample": end_sample, "master_sample": end_sample},
    ]
    monotonic = all(
        left["source_sample"] < right["source_sample"]
        and left["master_sample"] < right["master_sample"]
        for left, right in zip(points, points[1:])
    )
    return {
        "kind": "same-media-identity",
        "clock": "original_master_audio_samples",
        "sample_rate_hz": sample_rate_hz,
        "duration_s": duration_s,
        "rate": 1.0,
        "monotonic": monotonic,
        "points": points,
        "retimed": False,
        "reversed": False,
    }


def build_performance_source_record(
        path: str, timing: dict, *, rights_acknowledged: bool,
        probe: dict | None = None) -> dict:
    """Build path-redacted provenance for a protected source performance."""
    if not rights_acknowledged:
        raise PerformanceSourceError(
            "Confirm that you have permission to use this synchronized "
            "performance before enabling source-preserved mode."
        )
    probe = dict(probe or validate_performance_media(path))
    analysis_duration_s = float(timing["duration_s"])
    source_duration_s = float(probe["source_duration_s"])
    duration_tolerance_s = float(probe["duration_tolerance_s"])
    duration_delta_s = abs(analysis_duration_s - source_duration_s)
    if duration_delta_s > duration_tolerance_s:
        raise PerformanceSourceError(
            "The extracted analysis audio does not match the independently "
            "probed source timeline: "
            f"{analysis_duration_s:.3f}s analyzed versus "
            f"{source_duration_s:.3f}s source (allowed difference "
            f"{duration_tolerance_s:.3f}s)."
        )
    mapping = identity_sample_mapping(
        source_duration_s, int(probe["audio_sample_rate_hz"]))
    return {
        "motion_source_tier": MOTION_SOURCE_TIER,
        "source_file": {
            "basename": os.path.basename(path),
            "size_bytes": os.path.getsize(path),
        },
        "provenance": {
            "selection_method": "explicit_user_checkbox",
            "user_declared_actual_synchronized_performance": True,
            "rights_acknowledged": True,
            "rights_not_verified_by_iplay": True,
        },
        "probe": probe,
        "duration_reconciliation": {
            "analysis_duration_s": analysis_duration_s,
            "source_duration_s": source_duration_s,
            "difference_s": duration_delta_s,
            "tolerance_s": duration_tolerance_s,
            "within_tolerance": True,
        },
        "timeline_mapping": mapping,
        "motion_contract": {
            "real_source_motion_preserved": True,
            "display_geometry_preserved": True,
            "contacts_classified": False,
            "accuracy_statement": ACCURACY_STATEMENT,
            "retime_allowed": False,
            "reverse_allowed": False,
        },
    }
