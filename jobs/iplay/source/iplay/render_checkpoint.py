"""Long-performance chunk continuity + resume checkpoints (bridge item 209)."""
from __future__ import annotations

import json
import os
import time
from typing import Any


class CheckpointError(RuntimeError):
    pass


def checkpoint_path(work_dir: str) -> str:
    return os.path.join(work_dir, "iplay_render_checkpoint.json")


def load_checkpoint(work_dir: str) -> dict[str, Any] | None:
    path = checkpoint_path(work_dir)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("schema_version") != "1.0.0":
        raise CheckpointError(f"unsupported checkpoint schema in {path}")
    return data


def save_checkpoint(work_dir: str, record: dict[str, Any]) -> str:
    os.makedirs(work_dir, exist_ok=True)
    payload = dict(record)
    payload["schema_version"] = "1.0.0"
    payload["updated_at_unix"] = int(time.time())
    path = checkpoint_path(work_dir)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)
    return path


def mark_scene_completed(work_dir: str, scene_index: int,
                         artifact_path: str, *,
                         master_audio_hash_sha256: str | None = None,
                         extra: dict | None = None) -> dict[str, Any]:
    data = load_checkpoint(work_dir) or {
        "completed_scenes": {},
        "status": "in_progress",
    }
    completed = dict(data.get("completed_scenes") or {})
    completed[str(int(scene_index))] = {
        "artifact_path": os.path.abspath(artifact_path),
        "exists": os.path.isfile(artifact_path),
        "bytes": os.path.getsize(artifact_path) if os.path.isfile(artifact_path) else 0,
    }
    data["completed_scenes"] = completed
    if master_audio_hash_sha256:
        existing = data.get("master_audio_hash_sha256")
        if existing and existing != master_audio_hash_sha256:
            raise CheckpointError(
                "checkpoint master audio hash does not match current source; "
                "refusing to resume across different audio")
        data["master_audio_hash_sha256"] = master_audio_hash_sha256
    if extra:
        data.update(extra)
    data["status"] = "in_progress"
    save_checkpoint(work_dir, data)
    return data


def completed_scene_indexes(work_dir: str) -> set[int]:
    data = load_checkpoint(work_dir)
    if not data:
        return set()
    out = set()
    for key, meta in (data.get("completed_scenes") or {}).items():
        if meta.get("exists") and meta.get("artifact_path") and os.path.isfile(meta["artifact_path"]):
            out.add(int(key))
    return out


def mark_render_complete(work_dir: str, output_path: str) -> dict[str, Any]:
    data = load_checkpoint(work_dir) or {"completed_scenes": {}}
    data["status"] = "completed"
    data["output_path"] = os.path.abspath(output_path)
    save_checkpoint(work_dir, data)
    return data
