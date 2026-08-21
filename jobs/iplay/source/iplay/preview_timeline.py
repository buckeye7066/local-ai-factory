"""Local preview: analyze audio and emit an IPlay timeline without Wan/HeyGen.

Bridge item 209 — local preview of musical motion authority before a GPU render.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import audio_authority  # noqa: E402
import instrument_solvers  # noqa: E402
import media as media_tools  # noqa: E402
import motionsync as ms  # noqa: E402
import performance_timeline as timeline_tools  # noqa: E402
import pipeline  # noqa: E402
import scenes as scene_tools  # noqa: E402


def preview_performance_timeline(
        media_path: str,
        instrument: str,
        output_json: str,
        *,
        guitar_variant: str | None = None,
        motion_source_tier: str = "audio-inferred",
) -> dict:
    if instrument not in pipeline.INSTRUMENTS:
        raise ValueError(f"unsupported instrument: {instrument}")
    if not os.path.isfile(media_path):
        raise FileNotFoundError(media_path)

    with tempfile.TemporaryDirectory(prefix="iplay_preview_") as td:
        wav = os.path.join(td, "analysis.wav")
        info = media_tools.probe_media(media_path)
        selected = media_tools.select_audio_stream(info)
        pipeline.extract_audio(
            media_path, wav, audio_ordinal=int(selected["ordinal"]))
        timing = ms.analyze_audio(wav)
        timing["timeline_sample_rate_hz"] = int(
            selected.get("sample_rate") or timing.get("sample_rate") or 22050)
        plan = scene_tools.plan_scenes(timing)
        events = instrument_solvers.solve_instrument_actions(
            "guitar" if instrument == "bass" else instrument,
            [float(t) for t in timing.get("onset_times") or []],
            base_confidence=0.55 if motion_source_tier == "beat-only" else 0.7)
        continuity = instrument_solvers.validate_action_continuity(
            "guitar" if instrument == "bass" else instrument, events)
        try:
            audio_hash = audio_authority.hash_master_audio(
                media_path, audio_ordinal=int(selected["ordinal"]))
            master_hash = audio_hash["sha256"]
        except Exception as exc:  # analysis-only preview still useful without hash
            master_hash = None
            audio_hash = {"error": str(exc)}

        timeline = timeline_tools.build_performance_timeline(
            instrument="guitar" if instrument == "bass" else instrument,
            timing=timing,
            scenes=plan,
            motion_source_tier=motion_source_tier,  # type: ignore[arg-type]
            motion_identity="iplay-preview-motion",
            avatar_identity="preview-unset",
            guitar_variant=guitar_variant,
            master_audio_hash_sha256=master_hash,
            solver_events=events,
        )
        heygen = timeline_tools.heygen_bounded_payload(timeline)
        os.makedirs(os.path.dirname(os.path.abspath(output_json)) or ".",
                    exist_ok=True)
        with open(output_json, "w", encoding="utf-8") as fh:
            json.dump({
                "preview": True,
                "wan_required": False,
                "heygen_required": False,
                "action_continuity": continuity,
                "audio_authority": audio_hash,
                "heygen_bounded_payload": heygen,
                "performance_timeline": timeline,
            }, fh, indent=2)
        return {
            "out": output_json,
            "scene_count": len(timeline.get("scenes") or []),
            "tempo_bpm": timeline.get("tempo_bpm"),
            "master_audio_hash_sha256": master_hash,
            "action_continuity": continuity,
        }


def _cli() -> int:
    p = argparse.ArgumentParser(description="IPlay local timeline preview")
    p.add_argument("media_path")
    p.add_argument("instrument", choices=pipeline.INSTRUMENTS)
    p.add_argument("output_json")
    p.add_argument("--guitar-variant", choices=("acoustic", "electric", "bass"))
    p.add_argument("--tier", default="audio-inferred",
                   choices=("source-preserved", "source-derived", "score-driven",
                            "audio-inferred", "beat-only"))
    a = p.parse_args()
    report = preview_performance_timeline(
        a.media_path, a.instrument, a.output_json,
        guitar_variant=a.guitar_variant, motion_source_tier=a.tier)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
