"""Persistent Wan2.2-Animate worker for IPlay full-character replacement.

The expensive 14B model is loaded once, then every planned IPlay performance
scene is rendered sequentially.  Each scene uses Wan-Animate replacement mode:
reference avatar image + source pose/face/background/mask materials -> a newly
generated full character.  No source-performer body pixels are intentionally
composited into the character output.

This module is imported only inside the dedicated worker process so the normal
IPlay application does not require torch/diffusers merely to launch.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def _load_job(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        job = json.load(fh)
    if not isinstance(job, dict) or not isinstance(job.get("scenes"), list):
        raise ValueError("Wan replacement job is missing a scenes list")
    return job


def _require(path: str, label: str) -> str:
    value = os.path.abspath(path)
    if not os.path.isfile(value):
        raise FileNotFoundError(f"{label} not found: {value}")
    return value


def render(job_path: str) -> None:
    job = _load_job(job_path)
    try:
        import torch
        from diffusers import WanAnimatePipeline
        from diffusers.utils import export_to_video, load_image, load_video
    except Exception as exc:
        raise RuntimeError(
            "Wan2.2 exact-avatar rendering needs a current PyTorch + Diffusers "
            "environment with WanAnimatePipeline support. Install the official "
            "Wan/Diffusers runtime in the Python environment selected for IPlay.") from exc

    model = job.get("model") or "Wan-AI/Wan2.2-Animate-14B-Diffusers"
    device = job.get("device") or ("cuda:0" if torch.cuda.is_available() else "cpu")
    if not str(device).startswith("cuda"):
        raise RuntimeError(
            "Wan2.2-Animate-14B full-character replacement requires a CUDA-capable "
            "runtime for practical rendering; no lower-fidelity face-only fallback is allowed.")

    dtype = torch.bfloat16
    pipe = WanAnimatePipeline.from_pretrained(model, torch_dtype=dtype)
    # Prefer CPU offload because a 14B replacement model can exceed consumer
    # VRAM when the VAE/background conditions for a long scene are resident.
    if hasattr(pipe, "enable_model_cpu_offload"):
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(device)

    reference = load_image(_require(job["avatar_reference"], "avatar reference"))
    seed = int(job.get("seed", 42))
    steps = int(job.get("steps", 20))
    guidance = float(job.get("guidance_scale", 1.0))
    segment_frames = int(job.get("segment_frame_length", 77))
    prev_frames = int(job.get("prev_segment_conditioning_frames", 1))
    fps = float(job.get("fps", 24.0))
    prompt = str(job.get("prompt") or (
        "The supplied avatar is the only performer. Reproduce the driving "
        "performance motion faithfully, including both hands and instrument "
        "interaction. Keep one anatomically correct person, consistent clothing, "
        "consistent instrument, realistic fingers, and no appearance of the "
        "source performer."))

    for index, scene in enumerate(job["scenes"]):
        materials = Path(scene["materials"])
        output = os.path.abspath(scene["output"])
        os.makedirs(os.path.dirname(output), exist_ok=True)
        pose = load_video(_require(str(materials / "src_pose.mp4"), "pose video"))
        face = load_video(_require(str(materials / "src_face.mp4"), "face video"))
        background = load_video(_require(str(materials / "src_bg.mp4"), "background video"))
        mask = load_video(_require(str(materials / "src_mask.mp4"), "replacement mask video"))
        generator = torch.Generator(device=device).manual_seed(seed + index)
        result = pipe(
            image=reference,
            pose_video=pose,
            face_video=face,
            background_video=background,
            mask_video=mask,
            prompt=prompt,
            mode="replace",
            segment_frame_length=segment_frames,
            prev_segment_conditioning_frames=prev_frames,
            guidance_scale=guidance,
            num_inference_steps=steps,
            generator=generator,
        ).frames[0]
        export_to_video(result, output, fps=fps)
        print(json.dumps({"scene": index, "status": "rendered", "output": output}),
              flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job")
    args = parser.parse_args()
    render(args.job)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
