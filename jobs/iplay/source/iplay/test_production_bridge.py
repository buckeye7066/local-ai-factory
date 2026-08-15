"""Offline tests for typed timeline, solvers, audio authority, consent, resume."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import audio_authority as aa
import consent_records as cr
import instrument_solvers as solvers
import performance_timeline as tl
import render_checkpoint as cp
import performance_transfer as pt


class TimelineTests(unittest.TestCase):
    def test_builds_required_fields_for_three_instruments(self):
        timing = {
            "duration_s": 12.0, "bpm": 100.0, "sample_rate": 22050,
            "beats": [0.0, 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2],
            "onset_times": [0.1, 0.7, 1.3, 1.9, 2.5],
        }
        scenes = [
            {"index": 0, "start": 0.0, "end": 6.0, "dur": 6.0,
             "shot": {"key": "wide", "zoom": 1.0, "x": 0.5, "y": 0.5}},
            {"index": 1, "start": 6.0, "end": 12.0, "dur": 6.0,
             "shot": {"key": "medium", "zoom": 1.1, "x": 0.5, "y": 0.5}},
        ]
        for instrument in ("piano", "guitar", "violin"):
            events = solvers.solve_instrument_actions(instrument, timing["onset_times"])
            timeline = tl.build_performance_timeline(
                instrument=instrument, timing=timing, scenes=scenes,
                motion_source_tier="audio-inferred",
                motion_identity="iplay-motion",
                avatar_identity="avatar.png",
                master_audio_hash_sha256="abc",
                solver_events=events,
            )
            self.assertEqual(timeline["schema_version"], "1.0.0")
            self.assertEqual(timeline["instrument"], instrument)
            self.assertTrue(timeline["immutable"]["master_audio_hash_sha256"])
            self.assertEqual(timeline["motion_identity"], "iplay-motion")
            self.assertNotEqual(timeline["motion_identity"], timeline["avatar_identity"])
            self.assertEqual(len(timeline["scenes"]), 2)
            scene0 = timeline["scenes"][0]
            for key in ("tempo_bpm",):
                self.assertIn(key, timeline)
            for key in ("continuity_anchor", "camera", "avatar_render",
                        "phrase", "energy", "articulations", "hand_finger_targets"):
                self.assertIn(key, scene0)
            self.assertFalse(scene0["avatar_render"]["may_alter_timeline"])
            self.assertFalse(scene0["avatar_render"]["may_alter_master_audio"])

    def test_heygen_failure_cannot_mutate_timeline(self):
        timing = {"duration_s": 8.0, "bpm": 90.0, "sample_rate": 22050,
                  "beats": [0.0, 1.0, 2.0, 3.0], "onset_times": [0.2, 1.2]}
        scenes = [{"index": 0, "start": 0.0, "end": 8.0, "dur": 8.0, "shot": "wide"}]
        timeline = tl.build_performance_timeline(
            instrument="guitar", timing=timing, scenes=scenes,
            motion_source_tier="beat-only", master_audio_hash_sha256="deadbeef")
        before = tl.freeze_timeline(timeline)
        payload = tl.heygen_bounded_payload(before)
        payload["timeline_fingerprint"] = {"hacked": True}
        payload["camera_plan"] = []
        # Even after payload tampering, authoritative timeline is unchanged.
        tl.assert_timeline_untouched(before, timeline)
        with self.assertRaises(ValueError):
            mutated = tl.freeze_timeline(timeline)
            mutated["tempo_bpm"] = 1.0
            tl.assert_timeline_untouched(before, mutated)


class SolverTests(unittest.TestCase):
    def test_solvers_prevent_impossible_jumps(self):
        onsets = [i * 0.25 for i in range(40)]
        for instrument in ("piano", "guitar", "violin"):
            events = solvers.solve_instrument_actions(instrument, onsets)
            report = solvers.validate_action_continuity(instrument, events)
            self.assertTrue(report["plausible"], report)
            self.assertGreater(len(events), 0)


class ConsentAndCheckpointTests(unittest.TestCase):
    def test_consent_requires_acknowledgment(self):
        with self.assertRaises(cr.ConsentRecordError):
            cr.build_consent_record(
                performance_path="a.mp4", avatar_path="b.png",
                instrument="guitar", rights_acknowledged=False)

    def test_reference_license_inventory(self):
        inventory = cr.load_reference_license_inventory(
            str(HERE / "refs" / "manifest.json"))
        names = {item["instrument"] for item in inventory}
        self.assertEqual(names, {"piano", "guitar", "violin"})
        self.assertTrue(all(item.get("license") for item in inventory))

    def test_checkpoint_resume_and_audio_hash_guard(self):
        with tempfile.TemporaryDirectory() as td:
            artifact = Path(td, "normalized_000.mp4")
            artifact.write_bytes(b"fake-video")
            cp.mark_scene_completed(td, 0, str(artifact),
                                    master_audio_hash_sha256="hash-a")
            self.assertEqual(cp.completed_scene_indexes(td), {0})
            with self.assertRaises(cp.CheckpointError):
                cp.mark_scene_completed(td, 1, str(artifact),
                                        master_audio_hash_sha256="hash-b")


class AudioAuthorityUnitTests(unittest.TestCase):
    def test_sha256_file(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td, "x.bin")
            path.write_bytes(b"iplay-audio")
            digest = aa.sha256_file(str(path))
            self.assertEqual(len(digest), 64)
            self.assertEqual(digest, aa.sha256_file(str(path)))


class TransferContractTests(unittest.TestCase):
    def test_exact_mode_requires_consent_before_wan(self):
        with tempfile.TemporaryDirectory() as td:
            perf = Path(td, "perf.mp4"); perf.write_bytes(b"x")
            avatar = Path(td, "avatar.png"); avatar.write_bytes(b"y")
            with self.assertRaises(pt.PerformanceTransferError) as ctx:
                pt.render_exact_avatar_performance(
                    str(perf), str(avatar), "guitar", str(Path(td, "out.mp4")),
                    rights_acknowledged=False)
            self.assertIn("rights", str(ctx.exception).lower())

    def test_root_launcher_exists(self):
        self.assertTrue((ROOT / "iplay.pyw").is_file())
        self.assertTrue((ROOT / "Launch-IPlay.cmd").is_file())
        self.assertTrue((HERE / "iplay.pyw").is_file())
        self.assertTrue((HERE / "preview_timeline.py").is_file())
        self.assertTrue((HERE / "READINESS_THRESHOLDS.md").is_file())

    def test_transfer_report_declares_heygen_boundary_and_audio_hash(self):
        source = (HERE / "performance_transfer.py").read_text(encoding="utf-8")
        self.assertIn("master_audio_sha256", source)
        self.assertIn("failure_cannot_mutate_iplay_timeline", source)
        self.assertIn("pose_qa", source)
        self.assertIn('"status": "deferred"', source)
        self.assertIn("rights_acknowledged", source)
        self.assertIn("def pose_fidelity",
                      (HERE / "performance_qa.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
