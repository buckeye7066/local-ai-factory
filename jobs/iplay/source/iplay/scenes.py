"""IPlay scene planning, local direction, and compatibility helpers.

The supported production path keeps the beat-retimed performance as protected
source footage. IPlay may cut it and apply local crop/pan/zoom transforms, but
no generative service is allowed to redraw hands, fingering, bowing, strumming,
or instrument geometry. Optional generated assets are limited to shots with no
protected performance pixels: backgrounds, b-roll, establishing shots, mood
images, or identity assets that do not show hands or an instrument.

The tracked reference performances are gesture-timed to the music. They are
not note-accurate fingering, fret, string, or bow-placement simulations. Legacy
prompt/verification helpers remain below only to read older reports; the live
pipeline does not submit them to HeyGen.
"""
from __future__ import annotations

from fractions import Fraction
import json
import math
import os
import subprocess

import numpy as np

import media as media_tools

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# HeyGen cinematic generation limits (see pipeline._FACE_MAX_DUR).
MAX_SCENE_S = 15.0
MIN_SCENE_S = 4.0
_CUTAWAY_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

# ---------------------------------------------------------------------------#
# scene planning
# ---------------------------------------------------------------------------#


def plan_scenes(timing: dict, max_scene_s: float = MAX_SCENE_S,
                min_scene_s: float = MIN_SCENE_S,
                *, sample_rate_hz: int | None = None) -> list[dict]:
    """Split the song into scenes of (min, max] seconds with boundaries on the
    beat grid — preferring every-4th-beat "downbeats" (4/4 assumption) so cuts
    land on bar lines when possible.

    Returns [{"index", "start", "end", "dur", "shot"}]; scenes tile the full
    [0, duration_s] with no gaps or overlaps.
    """
    duration = float(timing["duration_s"])
    beats = [float(b) for b in timing.get("beats") or []]
    downbeats = set(beats[::4])

    bounds = [0.0]
    while duration - bounds[-1] > max_scene_s:
        s0 = bounds[-1]
        window = [b for b in beats if s0 + min_scene_s < b <= s0 + max_scene_s]
        in_bar = [b for b in window if b in downbeats]
        # last downbeat in range, else last beat, else a hard cut at the cap
        cut = (in_bar or window or [s0 + max_scene_s])[-1]
        bounds.append(cut)
    bounds.append(duration)

    # A too-short tail reads as a stutter cut: merge it into the previous
    # scene, splitting evenly if the merge would bust the cap.
    if len(bounds) > 2 and (bounds[-1] - bounds[-2]) < min_scene_s:
        bounds.pop(-2)
        if (bounds[-1] - bounds[-2]) > max_scene_s:
            bounds.insert(-1, (bounds[-1] + bounds[-2]) / 2.0)

    # Quantize each shared boundary once on one sample clock. Deriving both
    # adjacent scenes from the same integer tick prevents the millisecond-per-
    # scene drift caused by independently rounding start/end/duration fields.
    rate = int(sample_rate_hz or timing.get("timeline_sample_rate_hz")
               or timing.get("sample_rate") or 22050)
    if rate <= 0:
        raise ValueError("scene sample clock must be positive")
    ticks = [round(value * rate) for value in bounds]
    ticks[0] = 0
    for left, right in zip(ticks, ticks[1:]):
        if right <= left:
            raise ValueError("scene-clock quantization collapsed a boundary")

    scenes = []
    for i, (start_tick, end_tick) in enumerate(zip(ticks, ticks[1:])):
        start = start_tick / rate
        end = end_tick / rate
        scenes.append({
            "index": i,
            "start": start,
            "end": end,
            "dur": (end_tick - start_tick) / rate,
            "clock_sample_range": {
                "sample_rate_hz": rate,
                "start": start_tick,
                "end": end_tick,
            },
            "shot": _SHOT_CYCLE[i % len(_SHOT_CYCLE)],
        })
    return scenes


# ---------------------------------------------------------------------------#
# camera plan
# ---------------------------------------------------------------------------#
# Deterministic rotation (reproducible runs); adjacent scenes never share a
# shot, close-ups on the playing mechanism recur so the performance stays
# credible, and the piece opens wide to establish performer + room.
_SHOT_CYCLE = [
    {"key": "wide",          "directive": "wide establishing shot, the full performer and instrument visible in the room"},
    {"key": "closeup_hands", "directive": "close-up on {focus}, every movement clearly visible"},
    {"key": "medium",        "directive": "medium shot from the front, performer from the waist up"},
    {"key": "side",          "directive": "side-profile medium shot, the playing motion silhouetted"},
    {"key": "push_in",       "directive": "slow cinematic push-in from medium toward {focus}"},
    {"key": "closeup_hands", "directive": "tight close-up on {focus}, shallow depth of field"},
    {"key": "over_shoulder", "directive": "over-the-shoulder shot looking down at {focus}"},
    {"key": "wide_pull",     "directive": "slow pull-back from medium to a wide shot of the whole room"},
]

# What the camera should study, per instrument — the playing mechanism.
_FOCUS = {
    "piano":  "the hands on the piano keys",
    "guitar": "the strumming hand and the fingers on the fretboard",
    "bass":   "the plucking fingers and the fretting hand",
    "violin": "the bow on the strings and the fingers on the fingerboard",
}


# Local virtual-camera grammar.  Unlike the prompt-only HeyGen cycle above,
# these entries are real crops over the already beat-retimed full-song video.
# Centered shots separate left/right framings so the edit never jumps directly
# across the 180-degree line.
_LOCAL_SHOTS = [
    {"key": "wide", "zoom": 1.00, "x": 0.50, "y": 0.50,
     "screen": "center", "framing": "wide", "move": "locked_off"},
    {"key": "medium", "zoom": 1.12, "x": 0.50, "y": 0.55,
     "screen": "center", "framing": "medium", "move": "locked_off"},
    # Generic source footage has no calibrated instrument geometry. This is a
    # lower-frame virtual crop, not a promise that it isolates hands for every
    # instrument; instrument-specific focus calibration is a separate ingest
    # step.
    {"key": "performance_detail", "zoom": 1.34, "x": 0.50, "y": 0.76,
     "screen": "center", "framing": "detail", "move": "locked_off"},
    {"key": "left_detail", "zoom": 1.22, "x": 0.34, "y": 0.64,
     "screen": "left", "framing": "medium_detail", "move": "locked_off"},
    {"key": "wide", "zoom": 1.00, "x": 0.50, "y": 0.50,
     "screen": "center", "framing": "wide", "move": "locked_off"},
    {"key": "right_detail", "zoom": 1.22, "x": 0.66, "y": 0.64,
     "screen": "right", "framing": "medium_detail", "move": "locked_off"},
    {"key": "medium_close", "zoom": 1.18, "x": 0.50, "y": 0.58,
     "screen": "center", "framing": "medium_close", "move": "locked_off"},
]

# Highest-confidence usable motion wins. Source-preserved ingest may select the
# first tier only after independently proving that video and master audio cover
# the same timeline. Keeping this explicit avoids replacing real synchronized
# performance motion with a lower-confidence reconstruction.
MOTION_SOURCE_TIERS = (
    "source-preserved",
    "source-derived",
    "score-driven",
    "audio-inferred",
    "beat-only",
)


def _scene_energy(scene: dict, onsets: list[float]) -> float:
    count = sum(scene["start"] <= float(t) < scene["end"] for t in onsets)
    return count / max(float(scene["dur"]), 1e-9)


def plan_local_scenes(timing: dict, *, cutaway_count: int = 0,
                      cutaway_assets: list[dict] | None = None,
                      seed: int = 0, max_scene_s: float = 12.0,
                      min_scene_s: float = MIN_SCENE_S,
                      instrument: str = "unspecified",
                      variant: str | None = None,
                      motion_source_tier: str = "beat-only",
                      frame_rate: str | int | float | None = None) -> list[dict]:
    """Plan a deterministic, no-API edit over the protected performance.

    Performance scenes always use the same full-song timeline at the same
    timestamps, which preserves playing phase across camera cuts. Optional
    cutaways are sparse, never adjacent, never open/close the piece, and are
    followed by a centered re-establishing shot.
    """
    if motion_source_tier not in MOTION_SOURCE_TIERS:
        raise ValueError(f"unknown motion-source tier: {motion_source_tier}")
    sample_rate = int(timing.get("timeline_sample_rate_hz")
                      or timing.get("sample_rate") or 22050)
    base = plan_scenes(timing, max_scene_s=max_scene_s,
                       min_scene_s=min_scene_s,
                       sample_rate_hz=sample_rate)
    if not base:
        return []
    frame_clock = (Fraction(str(frame_rate))
                   if frame_rate is not None else None)
    if frame_clock is not None and frame_clock <= 0:
        raise ValueError("scene frame clock must be positive")
    if frame_clock is not None:
        sample_boundaries = [base[0]["clock_sample_range"]["start"]]
        sample_boundaries += [scene["clock_sample_range"]["end"]
                              for scene in base]
        frame_boundaries = [
            round(Fraction(int(sample), sample_rate) * frame_clock)
            for sample in sample_boundaries
        ]
        if any(right <= left for left, right in
               zip(frame_boundaries, frame_boundaries[1:])):
            raise ValueError("scene frame-clock quantization collapsed a boundary")
        rate_label = f"{frame_clock.numerator}/{frame_clock.denominator}"
        for scene, start_frame, end_frame in zip(
                base, frame_boundaries, frame_boundaries[1:]):
            scene["output_frame_range"] = {
                "frame_rate": rate_label,
                "start": start_frame,
                "end": end_frame,
            }
            scene["render_duration_s"] = float(
                Fraction(end_frame - start_frame, 1) / frame_clock)
    else:
        default_clock = Fraction(30, 1)
        sample_boundaries = [base[0]["clock_sample_range"]["start"]]
        sample_boundaries += [scene["clock_sample_range"]["end"]
                              for scene in base]
        frame_boundaries = [
            round(Fraction(int(sample), sample_rate) * default_clock)
            for sample in sample_boundaries
        ]
        if any(right <= left for left, right in
               zip(frame_boundaries, frame_boundaries[1:])):
            raise ValueError("scene frame-clock quantization collapsed a boundary")
        rate_label = f"{default_clock.numerator}/{default_clock.denominator}"
        for scene, start_frame, end_frame in zip(
                base, frame_boundaries, frame_boundaries[1:]):
            scene["output_frame_range"] = {
                "frame_rate": rate_label,
                "start": start_frame,
                "end": end_frame,
            }
            scene["render_duration_s"] = float(scene["dur"])
    onsets = [float(t) for t in timing.get("onset_times") or []]
    densities = [_scene_energy(scene, onsets) for scene in base]
    low = float(np.percentile(densities, 35)) if densities else 0.0
    high = float(np.percentile(densities, 70)) if densities else 0.0

    sections: list[str] = []
    for i, density in enumerate(densities):
        if i == 0:
            sections.append("intro")
        elif i == len(base) - 1:
            sections.append("outro")
        elif density >= high and high > low:
            sections.append("peak")
        elif density <= low and high > low:
            sections.append("release")
        else:
            sections.append("flow")

    if cutaway_assets is None:
        assets = [{"index": i, "kind": "image", "duration_s": None,
                   "video_ordinal": 0}
                  for i in range(max(0, int(cutaway_count)))]
    else:
        assets = []
        for i, source in enumerate(cutaway_assets):
            kind = source.get("kind")
            if kind not in {"image", "video"}:
                raise ValueError(f"unknown cutaway asset kind: {kind!r}")
            duration_s = source.get("duration_s")
            if kind == "video":
                try:
                    duration_s = float(duration_s)
                except (TypeError, ValueError) as exc:
                    raise ValueError("video cutaway duration must be proven") from exc
                if not math.isfinite(duration_s) or duration_s <= 0:
                    raise ValueError("video cutaway duration must be positive")
            assets.append({
                "index": i,
                "kind": kind,
                "duration_s": duration_s,
                "video_ordinal": (int(source.get("video_ordinal") or 0)
                                  if kind == "video" else 0),
            })

    # Assignments, rather than a set plus modulo arithmetic, make the one-use
    # contract explicit. Images can cover a slot of any duration; videos must
    # independently prove that their stream covers the whole scene.
    cutaway_assignments: dict[int, int] = {}
    if assets and len(base) >= 4:
        sparse_budget = max(1, min(len(base) // 4,
                                   math.ceil(len(base) * 0.25)))
        budget = min(sparse_budget, len(assets))
        # Energy-section changes are the most musical edit points. Regular
        # phrase positions fill any remaining budget deterministically.
        preferred = [i for i in range(1, len(base) - 1)
                     if sections[i] != sections[i - 1]]
        preferred += [i for i in range(2, len(base) - 1)
                      if (i + seed) % 4 == 3 and i not in preferred]
        remaining = {asset["index"] for asset in assets}
        asset_by_index = {asset["index"]: asset for asset in assets}
        for i in preferred:
            if len(cutaway_assignments) >= budget:
                break
            if (i - 1 in cutaway_assignments
                    or i + 1 in cutaway_assignments):
                continue
            duration_s = float(base[i]["render_duration_s"])
            eligible = [asset_by_index[index] for index in remaining
                        if (asset_by_index[index]["kind"] == "image"
                            or float(asset_by_index[index]["duration_s"])
                            >= duration_s)]
            if not eligible:
                continue
            # Use the shortest video that covers the slot, keeping longer
            # clips available for longer scenes. Images sort last. Seed only
            # breaks equal-duration ties and never causes reuse.
            chosen = min(
                eligible,
                key=lambda asset: (
                    math.inf if asset["kind"] == "image"
                    else float(asset["duration_s"]),
                    (asset["index"] - seed) % max(1, len(assets)),
                ),
            )
            cutaway_assignments[i] = chosen["index"]
            remaining.remove(chosen["index"])

    out: list[dict] = []
    perf_index = 0
    asset_by_index = {asset["index"]: asset for asset in assets}
    reestablish = False
    for i, scene in enumerate(base):
        item = {k: v for k, v in scene.items() if k != "shot"}
        clock_range = dict(item.pop("clock_sample_range"))
        start_sample = int(clock_range["start"])
        end_sample = int(clock_range["end"])
        item.update({
            "phrase": i,
            "section": sections[i],
            "energy": round(densities[i], 4),
            "time_range": {
                "start_s": float(item["start"]),
                "end_s": float(item["end"]),
                "duration_s": float(item["dur"]),
            },
            "sample_range": {
                "clock": ("master_audio_timeline"
                          if timing.get("timeline_sample_rate_hz")
                          else "analysis_timeline"),
                "sample_rate_hz": sample_rate,
                "start": start_sample,
                "end": end_sample,
            },
            "instrument": instrument,
            "variant": variant,
            "timeline_authority": ("selected-source-media"
                                   if motion_source_tier == "source-preserved"
                                   else "iplay"),
            "performance_motion_source_tier": motion_source_tier,
            "hands_locked": True,
            "instrument_geometry_locked": True,
            "audio_locked": True,
        })
        if i in cutaway_assignments:
            asset_index = cutaway_assignments[i]
            asset = asset_by_index[asset_index]
            item.update({
                "role": "cutaway",
                "asset_index": asset_index,
                "asset_id": f"cutaway-{asset_index}",
                "asset_kind": asset["kind"],
                "asset_duration_s": asset["duration_s"],
                "asset_video_ordinal": asset["video_ordinal"],
                "duration_coverage_verified": True,
                "asset_use_policy": "once",
                "remote_asset_id": None,
                "shot": {"key": "mood_cutaway", "screen": "neutral",
                         "framing": "environment", "move": "source_locked"},
                "motion_source": "local-cutaway-asset",
                "motion_source_tier": "unclassified-local-asset",
                # The local renderer does not run content recognition. Unknown
                # is truthful; False would promise that an arbitrary user
                # cutaway contains no person, hands, or instrument.
                "avatar_visible": None,
                "protected_performance_visible": None,
                "content_verification": "not_inspected",
                "heygen_scope": "none",
                "future_heygen_eligible_scope": (
                    "background_broll_establishing_mood_only_after_verification"),
                "allowed_transforms": ["trim", "scale", "crop", "cut"],
                "negative_constraints": [
                    "no visible playing hands",
                    "no visible instrument performance",
                    "do not synthesize or reinterpret fingering, strumming, picking, or bowing",
                    "do not add, remove, or alter protected performance frames",
                ],
                "retry_state": {"attempts": 0,
                                "verification": "local_asset_not_inspected"},
                "continuity": "musical-section accent; master audio remains uncut",
            })
            reestablish = True
        else:
            shot = (_LOCAL_SHOTS[0] if reestablish else
                    _LOCAL_SHOTS[(perf_index + seed) % len(_LOCAL_SHOTS)])
            item.update({
                "role": "performance",
                "asset_index": None,
                "asset_id": ("source-performance-master"
                             if motion_source_tier == "source-preserved"
                             else "retimed-performance-master"),
                "remote_asset_id": None,
                "shot": dict(shot),
                "motion_source": ("selected-source-video"
                                  if motion_source_tier == "source-preserved"
                                  else "iplay-retimed-performance"),
                "motion_source_tier": motion_source_tier,
                "avatar_visible": (None
                                   if motion_source_tier == "source-preserved"
                                   else True),
                "performer_visibility": ("not_inspected"
                                         if motion_source_tier == "source-preserved"
                                         else "visible_in_reference"),
                "content_verification": ("not_inspected"
                                         if motion_source_tier == "source-preserved"
                                         else "protected_reference_performance"),
                "protected_performance_visible": True,
                "heygen_scope": "none",
                "allowed_transforms": ["trim", "crop", "pan", "zoom", "cut"],
                "negative_constraints": [
                    "no generative redraw of hands or instrument",
                    "no synthetic fingering, strumming, picking, or bowing",
                    "no frame interpolation that changes performance geometry",
                    "do not retime, stretch, cut, or replace master audio",
                ],
                "retry_state": {"attempts": 0,
                                "verification": "protected_local_timeline"},
                "continuity": ("centered re-establish after cutaway" if reestablish
                               else ("same source performance timeline"
                                     if motion_source_tier == "source-preserved"
                                     else "same retimed performance timeline")),
                "motion_timeline_transform": {
                    "kind": ("same-media-identity"
                             if motion_source_tier == "source-preserved"
                             else "beat-retimed-reference"),
                    "rate": (1.0 if motion_source_tier == "source-preserved"
                             else None),
                    "retimed": motion_source_tier != "source-preserved",
                    "reversed": False,
                },
            })
            perf_index += 1
            reestablish = False
        out.append(item)
    return out


def _normalized_camera_filter(shot: dict, width: int, height: int,
                              fps: str | int | float, dur: float | None = None,
                              *, frame_count: int | None = None,
                              hold_last_frame: bool = True) -> str:
    """Scale/pad first, then make a bounded virtual-camera crop."""
    chain = (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
             f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2")
    zoom = max(1.0, min(float(shot.get("zoom", 1.0)), 1.5))
    if zoom > 1.0001:
        sw = int(math.ceil(width * zoom / 2.0) * 2)
        sh = int(math.ceil(height * zoom / 2.0) * 2)
        x = max(0.0, min(float(shot.get("x", 0.5)), 1.0))
        y = max(0.0, min(float(shot.get("y", 0.5)), 1.0))
        chain += (f",scale={sw}:{sh},crop={width}:{height}:"
                  f"(iw-ow)*{x:.4f}:(ih-oh)*{y:.4f}")
    # Scaling/cropping sources with different display aspect metadata can
    # produce equal pixel dimensions but unequal sample-aspect ratios, which
    # FFmpeg's concat filter rejects. Normalize every branch explicitly.
    chain += f",setsar=1,fps={fps},format=yuv420p"
    if hold_last_frame:
        chain += ",tpad=stop_mode=clone:stop=-1"
    if frame_count is None:
        if dur is None:
            raise ValueError("camera filter needs a duration or frame count")
        frame_count = round(Fraction(str(dur)) * Fraction(str(fps)))
    if int(frame_count) <= 0:
        raise ValueError("camera filter frame count must be positive")
    return chain + f",trim=end_frame={int(frame_count)},setpts=PTS-STARTPTS"


def _fftime(value: float) -> str:
    """Serialize one timeline boundary without millisecond truncation."""
    return f"{float(value):.9f}".rstrip("0").rstrip(".")


def _inspect_cutaway_assets(paths: list[str], *, cancel_event=None
                            ) -> tuple[list[str], list[dict], list[dict]]:
    """Probe optional assets without turning container length into a claim.

    Video assets need an independently reported video-stream duration plus
    bounded, internally consistent display geometry. Missing, duplicate,
    invalid, or unprovable inputs remain in the report but never reach FFmpeg
    or scene planning. This is technical validation, not content inspection.
    """
    accepted_paths: list[str] = []
    descriptors: list[dict] = []
    report: list[dict] = []
    seen: set[str] = set()
    for requested_index, path in enumerate(paths):
        absolute = os.path.abspath(path)
        key = os.path.normcase(absolute)
        record = {
            "request_index": requested_index,
            "basename": os.path.basename(absolute),
            "content_verification": "not_inspected",
            "use_count": 0,
        }
        if key in seen:
            record.update({"state": "skipped", "reason_code": "duplicate",
                           "detail": "duplicate path is not a second asset"})
            report.append(record)
            continue
        seen.add(key)
        if not os.path.isfile(absolute):
            record.update({"state": "skipped", "reason_code": "missing",
                           "detail": "asset is missing"})
            report.append(record)
            continue
        extension = os.path.splitext(absolute)[1].lower()
        if extension in _CUTAWAY_IMAGE_EXTS:
            kind = "image"
            duration_s = None
            display_geometry = None
        else:
            kind = "video"
            try:
                info = media_tools.probe_media(
                    absolute, cancel_event=cancel_event)
                selected_video = media_tools.select_video_stream(info)
                video_stream = media_tools.video_stream_at(
                    info, selected_video["ordinal"])
            except media_tools.MediaValidationError:
                record.update({
                    "kind": kind, "state": "skipped",
                    "reason_code": "invalid_video",
                    "detail": "video probe failed; asset excluded",
                })
                report.append(record)
                continue
            duration_s = media_tools.stream_duration_s(video_stream)
            if duration_s is None or float(duration_s) <= 0:
                record.update({
                    "kind": kind, "state": "skipped",
                    "reason_code": "unproven_video_duration",
                    "detail": ("video-stream duration could not be proven; "
                               "loop/freeze fallback is forbidden"),
                })
                report.append(record)
                continue
            duration_s = float(duration_s)
            video_ordinal = int(selected_video["ordinal"])
            try:
                display_geometry = media_tools.video_display_geometry(
                    video_stream)
            except media_tools.MediaValidationError:
                # Cutaways are optional and untrusted. Invalid aspect or
                # rotation metadata must exclude only this asset, never turn
                # a protected-performance render into a failed production.
                record.update({
                    "kind": kind, "state": "skipped",
                    "reason_code": "invalid_display_geometry",
                    "display_geometry_validation": "rejected",
                    "display_geometry_normalized": False,
                    "detail": ("video display geometry could not be safely "
                               "normalized; optional asset excluded"),
                })
                report.append(record)
                continue
        asset_index = len(accepted_paths)
        accepted_paths.append(absolute)
        descriptors.append({
            "kind": kind,
            "duration_s": duration_s,
            "video_ordinal": (video_ordinal if kind == "video" else 0),
            "display_geometry": display_geometry,
        })
        record.update({"asset_index": asset_index, "kind": kind,
                       "duration_s": duration_s,
                       "video_ordinal": (video_ordinal if kind == "video" else 0),
                       "display_geometry_validation": (
                           "validated_for_safe_normalization"
                           if kind == "video" else "not_applicable"),
                       "display_geometry": display_geometry,
                       "display_geometry_normalized": False,
                       "state": "accepted"})
        report.append(record)
    return accepted_paths, descriptors, report


class SceneStitchError(Exception):
    """Local-edit / stitch failure with a user-readable message."""


def render_local_director(performance_path: str, timing: dict, out_path: str,
                          *, cutaway_files: list[str] | None = None,
                          width: int = 1920, height: int = 1080,
                          fps: str | int | float = 30,
                          performance_video_ordinal: int = 0,
                          performance_display_geometry: dict | None = None,
                          seed: int = 0,
                          instrument: str = "unspecified",
                          variant: str | None = None,
                          motion_source_tier: str = "beat-only",
                          progress_cb=print, cancel_event=None) -> dict:
    """Render a deterministic video-only local edit.

    The caller muxes the original master audio exactly once afterwards.  Every
    performance branch trims the protected full-song source at the same
    timeline interval, while optional mood assets may visually replace a phrase
    without ever touching the soundtrack or changing source motion rate.
    """
    if not os.path.exists(performance_path):
        raise SceneStitchError(f"Performance video missing: {performance_path}")
    requested_cutaways = [p for p in (cutaway_files or []) if p]
    cutaways, cutaway_assets, cutaway_report = _inspect_cutaway_assets(
        requested_cutaways, cancel_event=cancel_event)
    try:
        performance_video_ordinal = int(performance_video_ordinal)
    except (TypeError, ValueError) as exc:
        raise SceneStitchError("Performance video ordinal must be an integer.") from exc
    if performance_video_ordinal < 0:
        raise SceneStitchError("Performance video ordinal cannot be negative.")
    if motion_source_tier == "source-preserved":
        if not isinstance(performance_display_geometry, dict):
            raise SceneStitchError(
                "Source-preserved director requires validated display geometry.")
        try:
            display_width = int(performance_display_geometry["display_width"])
            display_height = int(performance_display_geometry["display_height"])
            encoded_width = int(performance_display_geometry["encoded_width"])
            encoded_height = int(performance_display_geometry["encoded_height"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SceneStitchError(
                "Source-preserved display geometry is incomplete.") from exc
        if min(display_width, display_height,
               encoded_width, encoded_height) <= 0:
            raise SceneStitchError(
                "Source-preserved display geometry must be positive.")
        source_display_geometry = dict(performance_display_geometry)
    else:
        source_display_geometry = None
    expected_rate = Fraction(str(fps))
    if expected_rate <= 0:
        raise SceneStitchError("Director frame rate must be positive.")
    fps_arg = f"{expected_rate.numerator}/{expected_rate.denominator}"
    plan = plan_local_scenes(timing, cutaway_assets=cutaway_assets, seed=seed,
                             instrument=instrument, variant=variant,
                             motion_source_tier=motion_source_tier,
                             frame_rate=fps_arg)
    if not plan:
        raise SceneStitchError("Local director could not plan any scenes.")

    used_indices = {scene["asset_index"] for scene in plan
                    if scene["role"] == "cutaway"}
    scheduled_indices = [scene["asset_index"] for scene in plan
                         if scene["role"] == "cutaway"]
    input_by_asset = {asset_index: 1 + position
                      for position, asset_index in enumerate(scheduled_indices)}
    video_ordinal_by_input = {
        input_by_asset[asset_index]: int(
            cutaway_assets[asset_index].get("video_ordinal") or 0)
        for asset_index in scheduled_indices
    }
    display_geometry_by_input = {
        input_by_asset[asset_index]: dict(
            cutaway_assets[asset_index]["display_geometry"])
        for asset_index in scheduled_indices
        if cutaway_assets[asset_index]["kind"] == "video"
    }
    scheduled_cutaways = [cutaways[index] for index in scheduled_indices]

    cmd = media_tools.ffmpeg_command("-i", performance_path)
    for asset_index, path in zip(scheduled_indices, scheduled_cutaways):
        if os.path.splitext(path)[1].lower() in _CUTAWAY_IMAGE_EXTS:
            cmd += ["-loop", "1", "-framerate", fps_arg, "-i", path]
        else:
            cmd += ["-i", path]

    internal_scenes = plan[1:-1]
    for record in cutaway_report:
        asset_index = record.get("asset_index")
        if record["state"] != "accepted":
            progress_cb(f"[local edit] skipping {record['basename']}: "
                        f"{record['detail']}")
            continue
        if asset_index in used_indices:
            scene = next(scene for scene in plan
                         if scene.get("asset_index") == asset_index)
            record.update({
                "state": "scheduled", "use_count": 1,
                "director_input_index": input_by_asset[asset_index],
                "display_geometry_normalized": record["kind"] == "video",
                "timeline_slot": {
                    **dict(scene["time_range"]),
                    "render_duration_s": scene["render_duration_s"],
                    "output_frame_range": dict(scene["output_frame_range"]),
                },
                "detail": "one use with full duration coverage",
            })
            continue
        duration_s = record.get("duration_s")
        can_cover = (record["kind"] == "image"
                     or any(float(duration_s) >= float(scene["render_duration_s"])
                            for scene in internal_scenes))
        if can_cover:
            reason_code = "sparse_budget_not_selected"
            detail = "not selected by the sparse one-use cutaway budget"
        else:
            reason_code = "too_short_for_slot"
            shortest = min((float(scene["render_duration_s"])
                            for scene in internal_scenes),
                           default=0.0)
            detail = (f"proven video duration {float(duration_s):.3f}s cannot "
                      f"cover the shortest eligible {shortest:.3f}s scene; "
                      "loop/freeze fallback is forbidden")
        record.update({"state": "skipped", "reason_code": reason_code,
                       "display_geometry_normalized": False,
                       "detail": detail})
        progress_cb(f"[local edit] skipping {record['basename']}: {detail}")

    usage: dict[int, list[int]] = {}
    for scene in plan:
        input_index = (0 if scene["role"] == "performance"
                       else input_by_asset[scene["asset_index"]])
        usage.setdefault(input_index, []).append(scene["index"])

    def input_label(input_index: int) -> str:
        ordinal = (performance_video_ordinal if input_index == 0
                   else video_ordinal_by_input[input_index])
        return f"[{input_index}:v:{ordinal}]"

    parts: list[str] = []
    normalized_input: dict[int, str] = {}
    if source_display_geometry is not None:
        # Default FFmpeg autorotation happens before this filter. Convert the
        # selected performance to its validated square-pixel display raster
        # once before splitting scene branches; otherwise a later ``setsar=1``
        # can squash anamorphic sources at UHD/1080 delivery sizes.
        display_width = int(source_display_geometry["display_width"])
        display_height = int(source_display_geometry["display_height"])
        parts.append(
            f"{input_label(0)}scale={display_width}:{display_height}:"
            "flags=lanczos,setsar=1[performance_display]")
        normalized_input[0] = "[performance_display]"
    for input_index, display_geometry in sorted(
            display_geometry_by_input.items()):
        # Only a scheduled, selected video stream reaches this normalization.
        # Content remains explicitly uninspected; this transform merely
        # materializes bounded, internally consistent container geometry as
        # square pixels before the normal camera crop/pad chain discards
        # sample-aspect metadata.
        display_width = int(display_geometry["display_width"])
        display_height = int(display_geometry["display_height"])
        label = f"cutaway_display_{input_index}"
        parts.append(
            f"{input_label(input_index)}scale={display_width}:"
            f"{display_height}:flags=lanczos,setsar=1[{label}]")
        normalized_input[input_index] = f"[{label}]"
    branch: dict[int, str] = {}
    for input_index, scene_indices in sorted(usage.items()):
        source_label = normalized_input.get(
            input_index, input_label(input_index))
        if len(scene_indices) == 1:
            branch[scene_indices[0]] = source_label
        else:
            labels = []
            for scene_index in scene_indices:
                label = f"src{input_index}_{scene_index}"
                branch[scene_index] = f"[{label}]"
                labels.append(f"[{label}]")
            parts.append(f"{source_label}split={len(labels)}"
                         + "".join(labels))

    for scene in plan:
        source = branch[scene["index"]]
        if scene["role"] == "performance":
            if motion_source_tier == "source-preserved":
                trim = (f"trim=start_frame={scene['output_frame_range']['start']}:"
                        f"end_frame={scene['output_frame_range']['end']},"
                        "setpts=PTS-STARTPTS,")
            else:
                trim = (f"trim=start={_fftime(scene['start'])}:"
                        f"end={_fftime(scene['end'])},"
                        "setpts=PTS-STARTPTS,")
        else:
            trim = "setpts=PTS-STARTPTS,"
        output_frames = (scene["output_frame_range"]["end"]
                         - scene["output_frame_range"]["start"])
        camera = _normalized_camera_filter(scene["shot"], width, height,
                                           fps_arg,
                                           frame_count=output_frames,
                                           hold_last_frame=(
                                               (scene["role"] == "performance"
                                                and motion_source_tier
                                                != "source-preserved")
                                               or scene.get("asset_kind") == "image"))
        parts.append(f"{source}{trim}{camera}[v{scene['index']}]")
    chain = "".join(f"[v{s['index']}]" for s in plan)
    parts.append(f"{chain}concat=n={len(plan)}:v=1:a=0[vcat]")
    cmd += ["-filter_complex", ";".join(parts), "-map", "[vcat]", "-an",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart"]

    partial = media_tools.partial_path(out_path, "director")
    log_path = media_tools.stage_log_path(out_path, "director")
    cmd.append(partial)
    progress_cb(f"[local edit] directing {len(plan)} beat/phrase scenes "
                f"({sum(s['role'] == 'cutaway' for s in plan)} cutaways)...")
    result = media_tools.run_logged(cmd, stage="local cinematic director",
                                    log_path=log_path,
                                    cancel_event=cancel_event)
    if result.cancelled:
        raise media_tools.RenderCancelled(media_tools.format_failure(
            "Local cinematic director", result, partial))
    validation_error = None
    summary = None
    expected_frames = int(plan[-1]["output_frame_range"]["end"])
    expected_video_duration_s = float(
        Fraction(expected_frames, 1) / expected_rate)
    if result.ok:
        try:
            summary = media_tools.validate_media(
                partial, expected_duration_s=expected_video_duration_s,
                width=width, height=height, require_audio=False)
            output_stream = media_tools.video_stream_at(
                media_tools.probe_media(partial), 0)
            output_rate = media_tools.video_frame_rate(output_stream)
            if (output_rate is None
                    or Fraction(output_rate["rational"]) != expected_rate):
                raise media_tools.MediaValidationError(
                    "director cadence is "
                    f"{None if output_rate is None else output_rate['rational']}, "
                    f"expected {fps_arg}")
            frame_count = output_stream.get("nb_frames")
            if (str(frame_count).isdigit()
                    and int(frame_count) != expected_frames):
                raise media_tools.MediaValidationError(
                    f"director emitted {frame_count} frames, expected "
                    f"{expected_frames} shared-clock frames")
        except media_tools.MediaValidationError as exc:
            validation_error = exc
    if not result.ok or validation_error is not None:
        raise SceneStitchError(media_tools.format_failure(
            "Local cinematic director", result, partial, validation_error))
    media_tools.promote_partial(partial, out_path)
    media_tools.remove_success_log(result)
    return {
        "out": out_path,
        "status": "completed",
        "detail": (f"{len(plan)} deterministic local scenes; "
                   f"{sum(s['role'] == 'cutaway' for s in plan)} mood cutaways; "
                   + ("real source motion preserved at forward unit rate; "
                      "contacts not yet classified"
                      if motion_source_tier == "source-preserved" else
                      "performance scenes preserve the beat-retimed reference timeline")),
        "summary": summary,
        "video_contract": {
            "selected_performance_video_ordinal": performance_video_ordinal,
            "source_display_geometry": source_display_geometry,
            "output_width": width,
            "output_height": height,
            "output_frame_rate": fps_arg,
            "output_frame_count": expected_frames,
            "output_duration_s": expected_video_duration_s,
            "cadence_preserved": motion_source_tier == "source-preserved",
            "display_geometry_preserved": (
                motion_source_tier == "source-preserved"),
            "single_video_encode_before_master_mux": True,
        },
        "cutaway_policy": {
            "max_uses_per_asset": 1,
            "video_looping": False,
            "video_freeze_padding": False,
            "images_may_hold_for_slot": True,
            "master_audio_timeline_unchanged": True,
        },
        "cutaway_assets": cutaway_report,
        "opened_cutaway_sources": [os.path.basename(path)
                                    for path in scheduled_cutaways],
        "manifest": {
            "schema_version": "iplay.production.v1",
            "seed": seed,
            "duration_s": float(timing["duration_s"]),
            "bpm": timing.get("bpm"),
            "motion_source_tier": motion_source_tier,
            "motion_source_priority": list(MOTION_SOURCE_TIERS),
            "source_preservation_status": (
                "protected source is preserved" if motion_source_tier == "source-preserved"
                else "no synchronized source-performance input was explicitly selected"
            ),
            "authority": {
                "exact_timing": ("selected-source-media-timeline"
                                 if motion_source_tier == "source-preserved"
                                 else "iplay"),
                "performance_motion": ("selected-source-video"
                                       if motion_source_tier == "source-preserved"
                                       else "iplay"),
                "scene_edit": "iplay",
                "master_audio": "iplay",
                "final_mux": "iplay",
            },
            "protected_performance": {
                "hands_locked": True,
                "instrument_geometry_locked": True,
                "audio_locked": True,
                "allowed_visual_operations": [
                    "trim", "crop", "pan", "zoom", "cut",
                    "display-geometry-normalization"],
                "note_accuracy": (
                    "real synchronized source motion preserved; contacts not yet classified"
                    if motion_source_tier == "source-preserved" else
                    "gesture-timed reference only; exact key, fret, string, picking, bowing, and fingering are not inferred"
                ),
            },
            "heygen_adapter": {
                "target": "v3_video_agent",
                "status": "not_submitted",
                "paid_calls_made": False,
                "scope": ["background", "b-roll", "establishing", "mood",
                          "identity_asset_without_hands_or_instrument"],
                "forbidden_scope": ["performance_motion", "hands", "fingering",
                                    "strumming", "picking", "bowing",
                                    "instrument_geometry", "master_audio"],
                "migration_note": ("legacy direct cinematic-avatar performance calls "
                                   "are retired; a future adapter may submit only "
                                   "unprotected production assets"),
            },
            "performance_source": os.path.basename(performance_path),
            "video_contract": {
                "selected_performance_video_ordinal": performance_video_ordinal,
                "source_display_geometry": source_display_geometry,
                "output_width": width,
                "output_height": height,
                "output_frame_rate": fps_arg,
                "output_frame_count": expected_frames,
                "output_duration_s": expected_video_duration_s,
                "cadence_preserved": motion_source_tier == "source-preserved",
                "display_geometry_preserved": (
                    motion_source_tier == "source-preserved"),
                "single_video_encode_before_master_mux": True,
            },
            "cutaway_sources": [
                record["basename"] for record in cutaway_report
                if record["state"] == "scheduled"],
            "opened_cutaway_sources": [os.path.basename(path)
                                        for path in scheduled_cutaways],
            "cutaway_asset_report": cutaway_report,
            "cutaway_policy": {
                "max_uses_per_asset": 1,
                "video_looping": False,
                "video_freeze_padding": False,
                "images_may_hold_for_slot": True,
                "master_audio_timeline_unchanged": True,
            },
            "audio_contract": "video-only edit; caller maps one continuous original master",
            "scenes": plan,
        },
    }


# ---------------------------------------------------------------------------#
# prompts: one consistent world, per-scene camera + articulation
# ---------------------------------------------------------------------------#

_INSTRUMENT_NOUN = {
    ("guitar", "acoustic"): "acoustic guitar",
    ("guitar", "electric"): "electric guitar",
    ("guitar", "bass"): "electric bass guitar",
    ("piano", None): "grand piano",
    ("violin", None): "violin",
}


def instrument_noun(instrument: str, variant: str | None = None) -> str:
    return (_INSTRUMENT_NOUN.get((instrument, variant))
            or _INSTRUMENT_NOUN.get((instrument, None))
            or instrument)


def consistency_block(instrument: str, variant: str | None = None) -> str:
    """The world description repeated VERBATIM in every scene prompt. Scene-to-
    scene identity comes from (a) the same avatar look_id and (b) this block;
    only the camera directive and articulation vary."""
    noun = instrument_noun(instrument, variant)
    return (f"The same performer in every shot, wearing the same dark casual "
            f"outfit, playing the same {noun} in the same room: a warm, softly "
            f"lit studio with a dark neutral backdrop and a single warm key "
            f"light from the left. Identical lighting, wardrobe, instrument "
            f"and color grade in every shot. Photorealistic.")


def articulation(timing: dict, start: float, end: float, instrument: str,
                 variant: str | None = None,
                 inst_onsets: list[float] | None = None) -> dict:
    """Describe HOW the instrument is being played in [start, end): onset
    density per beat drives strum-vs-pick / legato-vs-detache / runs-vs-chords
    wording. Uses the instrument-focused onsets when given, else the full-mix
    onsets."""
    onsets = inst_onsets if inst_onsets is not None else timing.get("onset_times") or []
    beats = timing.get("beats") or []
    n_on = sum(1 for t in onsets if start <= float(t) < end)
    n_bt = max(1, sum(1 for t in beats if start <= float(t) < end))
    density = n_on / n_bt

    if instrument == "piano":
        if density > 2.0:
            word = ("rapid runs of notes, fingers moving quickly across the "
                    "keys, each key press landing on a note")
        elif density >= 0.75:
            word = ("steady chords and melody, fingers pressing the keys "
                    "cleanly on each beat")
        else:
            word = "slow sustained chords, deliberate unhurried key presses"
        stroke = "key press"
    elif instrument == "guitar" and variant == "bass":
        word = ("plucking single bass notes with the fingers, one clear pluck "
                "per note")
        stroke = "pluck"
    elif instrument == "guitar":
        if density > 1.5:
            word = "strumming steadily across the strings"
            stroke = "strum"
        elif density >= 0.75:
            word = "picking individual notes, one string at a time"
            stroke = "pick"
        else:
            word = "slow arpeggiated picking, letting each note ring"
            stroke = "pick"
    else:  # violin
        if density > 1.5:
            word = "short, quick detache bow strokes"
        else:
            word = "long, smooth legato bow strokes"
        stroke = "bow stroke"
    return {"desc": word, "stroke": stroke, "density": round(density, 2)}


def scene_prompt(scene: dict, timing: dict, instrument: str,
                 variant: str | None = None,
                 inst_onsets: list[float] | None = None) -> str:
    art = articulation(timing, scene["start"], scene["end"], instrument,
                       variant, inst_onsets)
    noun = instrument_noun(instrument, variant)
    camera = scene["shot"]["directive"].format(focus=_FOCUS.get(
        "bass" if (instrument, variant) == ("guitar", "bass") else instrument,
        "the hands"))
    bpm = float(timing.get("bpm") or 0)
    tempo = f" at about {bpm:.0f} BPM" if bpm else ""
    return (consistency_block(instrument, variant) + " "
            f"This person is playing the {noun}{tempo}: {art['desc']}. "
            f"Every visible {art['stroke']} lands exactly on the beat of the "
            f"music, in accurate playing position for the notes. "
            f"Only the {noun} is played on screen, no matter what other "
            f"instruments are heard in the music. {camera}.")


# ---------------------------------------------------------------------------#
# instrument-focused timing: follow the avatar's instrument, not the mix
# ---------------------------------------------------------------------------#

# Register bands (Hz) for onset analysis. This is register FOCUS, not true
# source separation — another instrument sharing the band will bleed in, and
# the report says so via "method".
_BANDS = {
    ("piano", None): (55.0, 3500.0),
    ("guitar", "acoustic"): (80.0, 2500.0),
    ("guitar", "electric"): (80.0, 2500.0),
    ("guitar", "bass"): (35.0, 500.0),
    ("violin", None): (180.0, 3500.0),
}


def instrument_onsets(wav_path: str, instrument: str,
                      variant: str | None = None, sr: int = 22050) -> dict:
    """Onset times for the AVATAR'S instrument: band-pass to its register,
    split harmonic/percussive, and detect onsets on the component that carries
    the playing gesture (bowing = harmonic, keys/strings = full band).

    This is what makes a piano avatar follow the piano line of a full-band
    track instead of the drums."""
    import librosa
    from scipy.signal import butter, sosfiltfilt

    y, _ = librosa.load(wav_path, sr=sr, mono=True)
    lo, hi = (_BANDS.get((instrument, variant))
              or _BANDS.get((instrument, None)) or (55.0, 3500.0))
    hi = min(hi, sr / 2 - 1)
    sos = butter(4, [lo, hi], btype="band", fs=sr, output="sos")
    yb = sosfiltfilt(sos, y)

    if instrument == "violin":
        # Bow changes are melodic-energy events, not broadband transients;
        # percussive residue in the band (e.g. drums) would swamp them.
        yb, _perc = librosa.effects.hpss(yb)

    env = librosa.onset.onset_strength(y=np.ascontiguousarray(yb), sr=sr)
    hi_p = float(np.percentile(env, 99))
    lo_p = float(np.percentile(env, 5))
    delta = max(0.07 * (hi_p - lo_p), 1e-6)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, delta=delta)
    times = librosa.frames_to_time(frames, sr=sr)

    # Energy gate: a sharp transient is BROADBAND (a drum hit has real energy
    # inside the piano's band), so band-passing alone still fires on other
    # instruments' attacks. Keep an onset only when the energy at that moment
    # actually lives in this register: in-band / full-mix energy over an 80 ms
    # window. A true bass note scores ~1, a hi-hat leak scores ~0, and a
    # simultaneous hit (target really played) stays comfortably above gate.
    win = int(0.08 * sr)
    kept = []
    for t in times:
        i0 = max(0, int(float(t) * sr))
        seg_b = yb[i0:i0 + win]
        seg_f = y[i0:i0 + win]
        e_b = float(np.sum(seg_b * seg_b))
        e_f = float(np.sum(seg_f * seg_f))
        if e_f <= 1e-12 or (e_b / e_f) >= 0.2:
            kept.append(float(t))

    method = ("bandpass+hpss+energygate" if instrument == "violin"
              else "bandpass+energygate")
    return {
        "onset_times": [round(t, 4) for t in kept],
        "raw_onsets": len(times),
        "method": method,
        "band_hz": [lo, hi],
        "note": ("register-focused analysis of the avatar's instrument; not "
                 "true source separation — same-register instruments bleed"),
    }


# ---------------------------------------------------------------------------#
# scene verification: do the gestures track the instrument's onsets?
# ---------------------------------------------------------------------------#

def _luma_series(path: str) -> tuple[np.ndarray, float]:
    """(per-frame YAVG array, true average fps). Same probe verify_sync.py
    uses: signalstats YAVG is cheap and needs no ML."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", path,
         "-vf", "signalstats,metadata=print", "-f", "null", "-"],
        capture_output=True, text=True, creationflags=_NO_WINDOW)
    y = np.asarray([float(ln.split("YAVG=")[1])
                    for ln in proc.stderr.splitlines() if "YAVG=" in ln])
    dur = 0.0
    try:
        dur = float(subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path], text=True,
            creationflags=_NO_WINDOW).strip() or 0)
    except (OSError, subprocess.CalledProcessError, ValueError):
        pass
    fps = (len(y) / dur) if dur > 0 and len(y) else 0.0
    return y, fps


def verify_scene_motion(scene_path: str, onsets_rel: list[float],
                        tol_s: float = 0.15) -> dict:
    """Measure whether the scene's visible motion tracks the instrument's
    onsets (times RELATIVE to scene start).

    Motion events = peaks of |d(frame luma)/dt| above median + 1.5*MAD.
    hit_rate = fraction of onsets with a motion peak within tol_s.
    chance    = what a random peak train of the same density would score;
    verdict "pass" needs hit_rate >= 0.5 AND >= 1.5x chance, so a scene that
    flails constantly cannot pass by accident.

    This verifies gesture TIMING only — it cannot see which key/fret/string
    was touched. That limit is stated wherever this verdict is shown."""
    if not onsets_rel:
        return {"verdict": "no_onsets", "hit_rate": None, "chance": None,
                "peaks": 0}
    y, fps = _luma_series(scene_path)
    if len(y) < 8 or fps <= 0:
        return {"verdict": "unmeasurable", "hit_rate": None, "chance": None,
                "peaks": 0}
    motion = np.abs(np.diff(y))
    med = float(np.median(motion))
    mad = float(np.median(np.abs(motion - med))) or 1e-9
    thr = med + 1.5 * mad
    peak_idx = [i for i in range(1, len(motion) - 1)
                if motion[i] >= thr and motion[i] >= motion[i - 1]
                and motion[i] >= motion[i + 1]]
    peak_times = [(i + 1) / fps for i in peak_idx]
    scene_dur = len(y) / fps

    hits = sum(1 for t in onsets_rel
               if any(abs(t - p) <= tol_s for p in peak_times))
    hit_rate = hits / len(onsets_rel)
    chance = min(1.0, (len(peak_times) * 2 * tol_s) / max(scene_dur, 1e-9))
    verdict = "pass" if (hit_rate >= 0.5 and hit_rate >= 1.5 * chance) else "fail"
    return {"verdict": verdict, "hit_rate": round(hit_rate, 3),
            "chance": round(chance, 3), "peaks": len(peak_times),
            "onsets": len(onsets_rel), "tol_s": tol_s}


# ---------------------------------------------------------------------------#
# stitching: scenes -> one video under the original uncut track
# ---------------------------------------------------------------------------#


def stitch_scenes(scene_files: list[str], scene_durs: list[float],
                  music_path: str, out_path: str, total_dur: float,
                  width: int = 1920, height: int = 1080, fps: int = 30,
                  progress_cb=print) -> dict:
    """Concatenate scene videos (video only) and lay the ORIGINAL music over
    the whole thing — the track is never cut, so the music is continuous
    across every camera change.

    Each scene is normalized to width x height @ fps and trimmed/held to its
    PLANNED duration (generated clips rarely match the request exactly; an
    untrimmed drift would push every later scene off its beats). The final
    frame clones out (tpad) so a slightly-short render can never leave black,
    and the output is clamped to total_dur.
    """
    if not scene_files:
        raise SceneStitchError("No scene files to stitch.")
    if len(scene_files) != len(scene_durs):
        raise SceneStitchError("scene_files and scene_durs length mismatch.")

    n = len(scene_files)
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for f in scene_files:
        if not os.path.exists(f):
            raise SceneStitchError(f"Scene file missing: {f}")
        cmd += ["-i", f]
    cmd += ["-i", music_path]

    parts = []
    for i, d in enumerate(scene_durs):
        # normalize -> hold last frame to exactly the planned duration
        parts.append(
            f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=yuv420p,"
            f"tpad=stop_mode=clone:stop=-1,trim=duration={d:.3f},"
            f"setpts=PTS-STARTPTS[v{i}]")
    chain = "".join(f"[v{i}]" for i in range(n))
    parts.append(f"{chain}concat=n={n}:v=1:a=0[vcat]")
    fc = ";".join(parts)

    cmd += ["-filter_complex", fc, "-map", "[vcat]", "-map", f"{n}:a:0",
            "-c:v", "libx264", "-crf", "18", "-preset", "medium",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            "-t", f"{total_dur:.3f}", "-movflags", "+faststart", out_path]

    progress_cb(f"[scenes] stitching {n} scenes -> "
                f"{os.path.basename(out_path)} ({total_dur:.1f}s)...")
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          creationflags=_NO_WINDOW)
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise SceneStitchError(f"ffmpeg stitch failed:\n{proc.stderr.strip()}")

    info = json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-show_entries",
         "format=duration", "-of", "json", out_path], text=True,
        creationflags=_NO_WINDOW))
    st = (info.get("streams") or [{}])[0]
    return {"out": out_path, "scenes": n,
            "width": st.get("width"), "height": st.get("height"),
            "duration_s": round(float(info["format"]["duration"]), 3)}
