from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import performance_qa as qa
import performance_transfer as pt


class PerformanceTransferTests(unittest.TestCase):
    def test_resolve_wan_home_accepts_official_layout(self):
        with tempfile.TemporaryDirectory() as td:
            script = Path(td, "wan", "modules", "animate", "preprocess", "preprocess_data.py")
            script.parent.mkdir(parents=True)
            script.write_text("# stub\n", encoding="utf-8")
            self.assertEqual(pt.resolve_wan_home(td), str(Path(td).resolve()))

    def test_resolve_wan_home_fails_closed_without_face_fallback(self):
        with tempfile.TemporaryDirectory() as td, \
             mock.patch.object(Path, "home", return_value=Path(td)), \
             mock.patch.dict(os.environ, {"IPLAY_WAN_HOME": td, "WAN22_HOME": td,
                                          "WAN_HOME": td}, clear=False):
            with self.assertRaises(pt.PerformanceTransferError) as ctx:
                pt.resolve_wan_home(td)
        self.assertIn("Face-only fallback is disabled", str(ctx.exception))

    def test_resolve_checkpoint_requires_process_checkpoint(self):
        with tempfile.TemporaryDirectory() as td:
            ckpt = Path(td, "Wan2.2-Animate-14B")
            Path(ckpt, "process_checkpoint").mkdir(parents=True)
            self.assertEqual(pt.resolve_wan_checkpoint(td, str(ckpt)), str(ckpt.resolve()))

    def test_preprocess_command_uses_replacement_and_expanded_mask(self):
        with tempfile.TemporaryDirectory() as td:
            script = Path(td, "wan", "modules", "animate", "preprocess", "preprocess_data.py")
            script.parent.mkdir(parents=True); script.write_text("# stub\n")
            ckpt = Path(td, "ckpt"); Path(ckpt, "process_checkpoint").mkdir(parents=True)
            cmd = pt.build_wan_preprocess_command(
                td, str(ckpt), "scene.mp4", "avatar.png", "materials", 24.0)
        self.assertIn("--replace_flag", cmd)
        self.assertIn("--iterations", cmd); self.assertIn("5", cmd)
        self.assertIn("--k", cmd); self.assertIn("15", cmd)
        self.assertNotIn("facefusion", " ".join(cmd).lower())

    def test_timing_drift_over_2_5_percent_is_rejected(self):
        with mock.patch.object(pt, "_probe_duration", return_value=10.5):
            with self.assertRaises(pt.PerformanceTransferError) as ctx:
                pt._normalize_scene("generated.mp4", 10.0, "out.mp4", 24.0)
        self.assertIn("musically false", str(ctx.exception))

    def test_pose_distance_is_zero_for_identical_guidance(self):
        points = np.array([[0, 0], [10, 10], [20, 20], [20, 25]], dtype=np.float32)
        median, p90 = qa._symmetric_pose_distance(points, points.copy(), (100, 100))
        self.assertEqual(median, 0.0)
        self.assertEqual(p90, 0.0)

    def test_worker_job_requires_full_character_replacement_inputs(self):
        worker = Path(HERE, "wan_replace_worker.py").read_text(encoding="utf-8")
        self.assertIn('mode="replace"', worker)
        self.assertIn('src_pose.mp4', worker)
        self.assertIn('src_bg.mp4', worker)
        self.assertIn('src_mask.mp4', worker)
        self.assertNotIn('face_swapper', worker)
        self.assertNotIn('FaceFusion', worker)

    def test_exact_report_declares_no_source_body_reuse_and_runs_leak_qa(self):
        source = Path(HERE, "performance_transfer.py").read_text(encoding="utf-8")
        self.assertIn('"replacement_mode": "full_character"', source)
        self.assertIn('"source_body_pixels_reused": False', source)
        self.assertIn('"source_performer_fallback_allowed": False', source)
        self.assertIn('qa.replacement_coverage(', source)
        self.assertIn('pose_qa', source)
        self.assertIn('"status": "deferred"', source)
        self.assertIn('failure_cannot_mutate_iplay_timeline', source)
        self.assertIn('def pose_fidelity',
                      (HERE / "performance_qa.py").read_text(encoding="utf-8"))
        self.assertNotIn('resolve_facefusion_home', source)
        self.assertNotIn('build_facefusion_command', source)


if __name__ == "__main__":
    unittest.main()
