"""Typed IPlay performance timeline (Master Prompt bridge item 205).

IPlay owns musical motion authority. Avatar/render backends (Wan2.2 locally,
optional HeyGen for non-performance assets only) consume bounded instructions
from this timeline and must not invent instrument performance.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Literal, TypedDict

INSTRUMENTS = ("piano", "guitar", "violin")
MotionTier = Literal[
    "source-preserved",
    "source-derived",
    "score-driven",
    "audio-inferred",
    "beat-only",
]


class ContinuityAnchor(TypedDict):
    kind: str
    sample_rate_hz: int
    start_sample: int
    end_sample: int
    scene_index: int


class HandFingerTarget(TypedDict, total=False):
    hand: Literal["left", "right", "both"]
    fingers: list[str]
    fret_or_key: int | None
    string_or_position: int | None
    confidence: float


class ArticulationEvent(TypedDict, total=False):
    kind: str
    start_s: float
    end_s: float
    direction: str | None  # strum/pick/bow: up|down|none
    pedal: str | None  # piano: on|off|half|None
    confidence: float


class CameraInstruction(TypedDict, total=False):
    shot: str
    lens: str
    motion: str
    framing: str
    screen: str
    zoom: float
    x: float
    y: float


class AvatarRenderInstruction(TypedDict, total=False):
    engine: str
    mode: str
    motion_authority: Literal["iplay"]
    may_alter_timeline: Literal[False]
    may_alter_master_audio: Literal[False]
    prompt_bound: str
    scene_index: int


class TimelineScene(TypedDict, total=False):
    index: int
    start_s: float
    end_s: float
    duration_s: float
    phrase: str
    energy: float
    notes_or_chords: list[str]
    hand_finger_targets: list[HandFingerTarget]
    articulations: list[ArticulationEvent]
    continuity_anchor: ContinuityAnchor
    camera: CameraInstruction
    avatar_render: AvatarRenderInstruction
    motion_confidence: float


class PerformanceTimeline(TypedDict, total=False):
    schema_version: str
    instrument: str
    guitar_variant: str | None
    motion_source_tier: MotionTier
    motion_identity: str
    avatar_identity: str
    tempo_bpm: float
    beats_s: list[float]
    onset_times_s: list[float]
    sample_rate_hz: int
    duration_s: float
    master_audio_hash_sha256: str | None
    scenes: list[TimelineScene]
    rights: dict[str, Any]
    immutable: dict[str, bool]


SCHEMA_VERSION = "1.0.0"


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def build_performance_timeline(
        *,
        instrument: str,
        timing: dict,
        scenes: list[dict],
        motion_source_tier: MotionTier,
        motion_identity: str = "iplay-motion",
        avatar_identity: str = "unset",
        guitar_variant: str | None = None,
        master_audio_hash_sha256: str | None = None,
        rights: dict | None = None,
        solver_events: list[dict] | None = None,
) -> PerformanceTimeline:
    """Assemble an authoritative, typed timeline from analysis + director scenes.

    HeyGen/Wan consumers may read avatar_render instructions. They must not
    mutate tempo, beats, onsets, continuity anchors, or master audio hash.
    """
    if instrument not in INSTRUMENTS:
        raise ValueError(f"unsupported instrument: {instrument!r}")
    if motion_source_tier not in (
            "source-preserved", "source-derived", "score-driven",
            "audio-inferred", "beat-only"):
        raise ValueError(f"unknown motion tier: {motion_source_tier!r}")

    sample_rate = int(timing.get("timeline_sample_rate_hz")
                      or timing.get("sample_rate") or 22050)
    duration_s = float(timing["duration_s"])
    beats = [float(b) for b in timing.get("beats") or []]
    onsets = [float(t) for t in timing.get("onset_times") or []]
    bpm = float(timing.get("bpm") or 0.0)
    events = list(solver_events or [])

    tier_confidence = {
        "source-preserved": 0.95,
        "source-derived": 0.85,
        "score-driven": 0.70,
        "audio-inferred": 0.55,
        "beat-only": 0.35,
    }[motion_source_tier]

    out_scenes: list[TimelineScene] = []
    for scene in scenes:
        idx = int(scene["index"])
        start = float(scene.get("start", scene.get("start_s", 0.0)))
        end = float(scene.get("end", scene.get("end_s", start + float(scene.get("dur", scene.get("duration_s", 0.0))))))
        dur = max(0.0, end - start)
        start_sample = int(round(start * sample_rate))
        end_sample = int(round(end * sample_rate))
        energy = float(scene.get("energy", 0.0))
        if "energy" not in scene and onsets:
            energy = sum(start <= t < end for t in onsets) / max(dur, 1e-9)

        shot = scene.get("shot") or {}
        if isinstance(shot, str):
            camera: CameraInstruction = {
                "shot": shot, "lens": "performance", "motion": "locked_off",
                "framing": shot, "screen": "center",
            }
        else:
            camera = {
                "shot": str(shot.get("key") or "wide"),
                "lens": str(shot.get("lens") or "performance"),
                "motion": str(shot.get("move") or "locked_off"),
                "framing": str(shot.get("framing") or shot.get("key") or "wide"),
                "screen": str(shot.get("screen") or "center"),
                "zoom": float(shot.get("zoom") or 1.0),
                "x": float(shot.get("x") or 0.5),
                "y": float(shot.get("y") or 0.5),
            }

        scene_events = [e for e in events
                        if start <= float(e.get("start_s", -1)) < end]
        articulations: list[ArticulationEvent] = []
        targets: list[HandFingerTarget] = []
        notes: list[str] = []
        for event in scene_events:
            if event.get("note_or_chord"):
                notes.append(str(event["note_or_chord"]))
            articulations.append({
                "kind": str(event.get("kind") or "action"),
                "start_s": float(event.get("start_s", start)),
                "end_s": float(event.get("end_s", start)),
                "direction": event.get("direction"),
                "pedal": event.get("pedal"),
                "confidence": _clamp01(float(event.get("confidence", tier_confidence))),
            })
            if event.get("hand") or event.get("fingers") is not None:
                targets.append({
                    "hand": event.get("hand") or "both",
                    "fingers": list(event.get("fingers") or []),
                    "fret_or_key": event.get("fret_or_key"),
                    "string_or_position": event.get("string_or_position"),
                    "confidence": _clamp01(float(event.get("confidence", tier_confidence))),
                })

        phrase = str(scene.get("section") or scene.get("phrase") or "flow")
        out_scenes.append({
            "index": idx,
            "start_s": start,
            "end_s": end,
            "duration_s": dur,
            "phrase": phrase,
            "energy": float(energy),
            "notes_or_chords": notes,
            "hand_finger_targets": targets,
            "articulations": articulations,
            "continuity_anchor": {
                "kind": "master_audio_samples",
                "sample_rate_hz": sample_rate,
                "start_sample": start_sample,
                "end_sample": end_sample,
                "scene_index": idx,
            },
            "camera": camera,
            "avatar_render": {
                "engine": "wan2.2-animate" if motion_source_tier.startswith("source") else "local-director",
                "mode": "full_character_replace" if motion_source_tier.startswith("source") else "beat_retimed_crop",
                "motion_authority": "iplay",
                "may_alter_timeline": False,
                "may_alter_master_audio": False,
                "prompt_bound": (
                    "Follow IPlay continuity anchors and instrument actions. "
                    "Do not invent tempo, notes, or master audio."
                ),
                "scene_index": idx,
            },
            "motion_confidence": _clamp01(tier_confidence),
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "instrument": instrument,
        "guitar_variant": guitar_variant,
        "motion_source_tier": motion_source_tier,
        "motion_identity": motion_identity,
        "avatar_identity": avatar_identity,
        "tempo_bpm": bpm,
        "beats_s": beats,
        "onset_times_s": onsets,
        "sample_rate_hz": sample_rate,
        "duration_s": duration_s,
        "master_audio_hash_sha256": master_audio_hash_sha256,
        "scenes": out_scenes,
        "rights": dict(rights or {}),
        "immutable": {
            "tempo_bpm": True,
            "beats_s": True,
            "onset_times_s": True,
            "continuity_anchors": True,
            "master_audio_hash_sha256": True,
            "motion_identity_separate_from_avatar": True,
        },
    }


def freeze_timeline(timeline: PerformanceTimeline) -> PerformanceTimeline:
    """Return a deep copy that external renderers must treat as read-only."""
    return deepcopy(timeline)


def assert_timeline_untouched(before: PerformanceTimeline,
                              after: PerformanceTimeline) -> None:
    """Fail closed if a renderer mutated authoritative musical fields (211)."""
    keys = (
        "tempo_bpm", "beats_s", "onset_times_s", "sample_rate_hz",
        "duration_s", "master_audio_hash_sha256", "motion_identity",
        "instrument",
    )
    for key in keys:
        if before.get(key) != after.get(key):
            raise ValueError(f"authoritative timeline field mutated: {key}")
    before_scenes = before.get("scenes") or []
    after_scenes = after.get("scenes") or []
    if len(before_scenes) != len(after_scenes):
        raise ValueError("authoritative scene count mutated")
    for left, right in zip(before_scenes, after_scenes):
        if left.get("continuity_anchor") != right.get("continuity_anchor"):
            raise ValueError("continuity anchor mutated")
        if left.get("start_s") != right.get("start_s") or left.get("end_s") != right.get("end_s"):
            raise ValueError("scene timing mutated")


def heygen_bounded_payload(timeline: PerformanceTimeline) -> dict:
    """Bounded HeyGen payload: identity/scene metadata only, never motion/audio.

    Failures/retries of HeyGen cannot rewrite the timeline because the payload
    does not include mutable musical authority — consumers receive a frozen
    copy and IPlay keeps the original.
    """
    frozen = freeze_timeline(timeline)
    return {
        "scope": "non_performance_assets_only",
        "motion_authority": "iplay",
        "may_alter_timeline": False,
        "may_alter_master_audio": False,
        "avatar_identity": frozen.get("avatar_identity"),
        "camera_plan": [
            {"scene_index": s["index"], "camera": s.get("camera")}
            for s in frozen.get("scenes") or []
        ],
        "timeline_fingerprint": {
            "schema_version": frozen.get("schema_version"),
            "tempo_bpm": frozen.get("tempo_bpm"),
            "duration_s": frozen.get("duration_s"),
            "master_audio_hash_sha256": frozen.get("master_audio_hash_sha256"),
            "scene_count": len(frozen.get("scenes") or []),
        },
    }
