"""Visual QA gates for IPlay full-avatar replacement scenes.

These checks are deliberately conservative and local. They do not claim to
prove musical note correctness. They catch two catastrophic failures before a
scene can enter the final video:

1. source-performer leakage: a large masked region stayed essentially identical
   to the driving musician instead of being regenerated as the avatar;
2. gross motion drift: whole-body/hand pose guidance extracted from the
   generated scene diverges materially from the source pose guidance.

The pose check uses the official Wan preprocessing pose renders. Those renders
are sparse skeleton images, so a symmetric nearest-neighbour distance is more
meaningful than raw RGB SSIM.
"""
from __future__ import annotations

import math
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

import media as media_tools


class PerformanceQAError(RuntimeError):
    pass


def _frame(video: str, timestamp: float, output: str) -> str:
    cmd = media_tools.ffmpeg_command(
        "-ss", f"{max(0.0, timestamp):.6f}", "-i", video,
        "-frames:v", "1", output, loglevel="error")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, creationflags=flags)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise PerformanceQAError(f"Could not sample QA frame from {video}: {exc}") from exc
    if not os.path.isfile(output):
        raise PerformanceQAError(f"QA frame was not created: {output}")
    return output


def _rgb(path: str, size: tuple[int, int] | None = None) -> np.ndarray:
    with Image.open(path) as image:
        image = image.convert("RGB")
        if size is not None and image.size != size:
            image = image.resize(size, Image.Resampling.BILINEAR)
        return np.asarray(image, dtype=np.float32)


def _mask(path: str, size: tuple[int, int]) -> np.ndarray:
    with Image.open(path) as image:
        image = image.convert("L")
        if image.size != size:
            image = image.resize(size, Image.Resampling.NEAREST)
        arr = np.asarray(image, dtype=np.uint8)
    return arr >= 24


def replacement_coverage(source_video: str, generated_video: str,
                         mask_video: str, duration_s: float) -> dict:
    """Reject scenes whose replacement mask remained source-like.

    A successful full-character replacement should materially alter pixels in
    the masked performer envelope. This gate is intentionally lenient so it
    detects near-no-op/source-leak failures, not artistic similarity.
    """
    samples = []
    with tempfile.TemporaryDirectory(prefix="iplay_replace_qa_") as td:
        for n, fraction in enumerate((0.25, 0.50, 0.75)):
            t = max(0.0, min(duration_s - 0.02, duration_s * fraction))
            sp = _frame(source_video, t, os.path.join(td, f"s{n}.png"))
            gp = _frame(generated_video, t, os.path.join(td, f"g{n}.png"))
            mp = _frame(mask_video, t, os.path.join(td, f"m{n}.png"))
            src = _rgb(sp); h, w = src.shape[:2]
            gen = _rgb(gp, (w, h)); mask = _mask(mp, (w, h))
            count = int(mask.sum())
            if count < max(500, int(h * w * 0.002)):
                raise PerformanceQAError("Replacement mask covers too little of the performer")
            delta = np.abs(src - gen).mean(axis=2) / 255.0
            masked = delta[mask]
            mean_delta = float(masked.mean())
            unchanged = float((masked < (6.0 / 255.0)).mean())

            # Tile the frame so one large unchanged source limb/torso region
            # cannot hide behind a highly changed face/background portion.
            worst_tile_unchanged = 0.0
            for yi in range(3):
                for xi in range(3):
                    y0, y1 = yi * h // 3, (yi + 1) * h // 3
                    x0, x1 = xi * w // 3, (xi + 1) * w // 3
                    tile_mask = mask[y0:y1, x0:x1]
                    if int(tile_mask.sum()) < max(200, int(count * 0.02)):
                        continue
                    tile_delta = delta[y0:y1, x0:x1][tile_mask]
                    worst_tile_unchanged = max(
                        worst_tile_unchanged,
                        float((tile_delta < (6.0 / 255.0)).mean()))
            samples.append({"time_s": t, "mean_masked_delta": mean_delta,
                            "unchanged_fraction": unchanged,
                            "worst_tile_unchanged_fraction": worst_tile_unchanged})

    if any(item["mean_masked_delta"] < 0.012 for item in samples):
        raise PerformanceQAError("Full-avatar replacement is nearly identical to source pixels")
    if any(item["unchanged_fraction"] > 0.965 for item in samples):
        raise PerformanceQAError("Source performer appears to remain inside the replacement mask")
    if any(item["worst_tile_unchanged_fraction"] > 0.985 for item in samples):
        raise PerformanceQAError("A large performer region appears unreplaced")
    return {"status": "passed", "samples": samples}


def _pose_points(path: str) -> tuple[np.ndarray, tuple[int, int]]:
    with Image.open(path) as image:
        arr = np.asarray(image.convert("RGB"), dtype=np.uint8)
    # Wan pose renders are dark-background guidance images. Thresholding by
    # channel max keeps the colored skeleton/keypoint strokes.
    active = arr.max(axis=2) >= 20
    coords = np.argwhere(active).astype(np.float32)  # y, x
    if len(coords) < 50:
        raise PerformanceQAError("Pose QA image contains too few detected guidance pixels")
    return coords, (arr.shape[0], arr.shape[1])


def _symmetric_pose_distance(a: np.ndarray, b: np.ndarray,
                             shape: tuple[int, int]) -> tuple[float, float]:
    ta = cKDTree(a); tb = cKDTree(b)
    da = tb.query(a, k=1)[0]; db = ta.query(b, k=1)[0]
    distances = np.concatenate([da, db])
    diagonal = math.hypot(*shape)
    return (float(np.median(distances) / diagonal),
            float(np.percentile(distances, 90) / diagonal))


def pose_fidelity(source_pose_video: str, generated_pose_video: str,
                  duration_s: float) -> dict:
    """Compare sparse whole-body/hand pose guidance at three scene times."""
    samples = []
    with tempfile.TemporaryDirectory(prefix="iplay_pose_qa_") as td:
        for n, fraction in enumerate((0.25, 0.50, 0.75)):
            t = max(0.0, min(duration_s - 0.02, duration_s * fraction))
            sp = _frame(source_pose_video, t, os.path.join(td, f"sp{n}.png"))
            gp = _frame(generated_pose_video, t, os.path.join(td, f"gp{n}.png"))
            source, shape = _pose_points(sp); generated, _ = _pose_points(gp)
            median, p90 = _symmetric_pose_distance(source, generated, shape)
            samples.append({"time_s": t, "median_normalized_distance": median,
                            "p90_normalized_distance": p90})
    # Broad tolerance: the avatar can have different body proportions, but a
    # generated scene that no longer follows the driving hand/body trajectory
    # should not survive exact-performance mode.
    if any(item["median_normalized_distance"] > 0.055 for item in samples):
        raise PerformanceQAError("Generated avatar body/hand pose drifted from the driving performance")
    if any(item["p90_normalized_distance"] > 0.11 for item in samples):
        raise PerformanceQAError("Generated avatar has large local pose outliers")
    return {"status": "passed", "samples": samples}
