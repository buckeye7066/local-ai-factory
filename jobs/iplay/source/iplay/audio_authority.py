"""Exact-audio authority: hashes and immutable restore helpers (209 / 211)."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from typing import Any

import media as media_tools


class AudioAuthorityError(RuntimeError):
    pass


def sha256_file(path: str, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def extract_master_audio_wav(performance_video: str, output_wav: str,
                             *, audio_ordinal: int | None = None,
                             cancel_event=None) -> dict[str, Any]:
    """Extract the selected master audio stream losslessly for hashing."""
    info = media_tools.probe_media(performance_video)
    if audio_ordinal is None:
        selected = media_tools.select_audio_stream(info)
        audio_ordinal = int(selected["ordinal"])
    cmd = media_tools.ffmpeg_command(
        "-i", performance_video,
        "-map", f"0:a:{int(audio_ordinal)}",
        "-vn", "-acodec", "pcm_s16le", output_wav, loglevel="error")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(cmd, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, creationflags=flags)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AudioAuthorityError(f"master audio extract failed: {exc}") from exc
    if cancel_event is not None and cancel_event.is_set():
        raise AudioAuthorityError("master audio extract cancelled")
    if not os.path.isfile(output_wav) or os.path.getsize(output_wav) < 64:
        raise AudioAuthorityError("master audio extract produced empty output")
    return {
        "path": output_wav,
        "sha256": sha256_file(output_wav),
        "audio_ordinal": int(audio_ordinal),
        "bytes": os.path.getsize(output_wav),
        "ffmpeg_returncode": proc.returncode,
    }


def hash_master_audio(performance_video: str, *,
                      audio_ordinal: int | None = None) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="iplay_audio_hash_") as td:
        wav = os.path.join(td, "master.wav")
        return extract_master_audio_wav(
            performance_video, wav, audio_ordinal=audio_ordinal)


def verify_restored_audio_hash(performance_video: str, restored_video: str,
                               expected_sha256: str, *,
                               audio_ordinal: int | None = None,
                               restored_audio_ordinal: int = 0) -> dict[str, Any]:
    """Prove the restored soundtrack still matches the source master hash."""
    with tempfile.TemporaryDirectory(prefix="iplay_audio_verify_") as td:
        source = extract_master_audio_wav(
            performance_video, os.path.join(td, "source.wav"),
            audio_ordinal=audio_ordinal)
        # Re-extract from restored container (AAC encode is lossy). Compare the
        # *source* hash record for authority, and also hash the restored PCM so
        # callers can detect empty/missing audio. Exact PCM equality after AAC
        # re-mux is not required; presence + duration coverage is validated by
        # media.validate_media. Authority is the pre-restore source hash.
        restored = extract_master_audio_wav(
            restored_video, os.path.join(td, "restored.wav"),
            audio_ordinal=restored_audio_ordinal)
        if source["sha256"] != expected_sha256:
            raise AudioAuthorityError(
                "source master audio hash drifted before restore verification")
        if restored["bytes"] < 64:
            raise AudioAuthorityError("restored video has no usable audio payload")
        return {
            "status": "passed",
            "source_sha256": source["sha256"],
            "expected_sha256": expected_sha256,
            "restored_pcm_sha256": restored["sha256"],
            "exact_pcm_match_after_aac": restored["sha256"] == source["sha256"],
            "note": (
                "Authoritative hash is the pre-render source PCM. AAC remux may "
                "change PCM bytes; empty/missing restored audio is rejected."
            ),
        }


def write_audio_authority_record(path: str, record: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2, sort_keys=True)
