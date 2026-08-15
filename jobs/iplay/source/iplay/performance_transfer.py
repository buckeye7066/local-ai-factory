"""Full-avatar exact-performance transfer for IPlay.

The source performance supplies motion/timing authority. Wan2.2-Animate
replacement mode regenerates the entire performer from the chosen avatar
reference for each planned scene. Face-only swapping is retired: exact mode
will not publish a hybrid source-body/avatar-head result.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import audio_authority  # noqa: E402
import consent_records  # noqa: E402
import instrument_solvers  # noqa: E402
import media as media_tools  # noqa: E402
import performance_qa as qa  # noqa: E402
import performance_timeline as timeline_tools  # noqa: E402
import pipeline  # noqa: E402
import render_checkpoint as checkpoints  # noqa: E402
import scenes as scene_tools  # noqa: E402


class PerformanceTransferError(RuntimeError):
    pass


_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
_VIDEO_EXTS = pipeline.FACE_VIDEO_EXTS
DEFAULT_MODEL = "Wan-AI/Wan2.2-Animate-14B-Diffusers"


def _run(command: list[str], *, cwd: str | None = None, stage: str = "command",
         cancel_event=None) -> subprocess.CompletedProcess:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.Popen(command, cwd=cwd, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                creationflags=flags)
    except OSError as exc:
        raise PerformanceTransferError(f"{stage} could not start: {exc}") from exc
    lines: list[str] = []
    while proc.poll() is None:
        if cancel_event is not None and cancel_event.is_set():
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise PerformanceTransferError(f"{stage} cancelled by user")
        line = proc.stdout.readline() if proc.stdout else ""
        if line:
            lines.append(line.rstrip())
            lines = lines[-80:]
        else:
            time.sleep(0.1)
    if proc.stdout:
        lines.extend(x.rstrip() for x in proc.stdout.readlines())
    if proc.returncode != 0:
        raise PerformanceTransferError(
            f"{stage} failed (exit {proc.returncode}).\n" + "\n".join(lines[-60:]))
    return subprocess.CompletedProcess(command, proc.returncode, "\n".join(lines), "")


def _probe_duration(path: str) -> float:
    info = media_tools.probe_media(path)
    try:
        value = float((info.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        value = 0.0
    if value <= 0:
        values = [media_tools.stream_duration_s(s) for s in info.get("streams") or []]
        value = max([float(v) for v in values if v is not None] or [0.0])
    if value <= 0:
        raise PerformanceTransferError(f"Could not determine media duration: {path}")
    return value


def _source_fps(path: str) -> float:
    info = media_tools.probe_media(path)
    selected = media_tools.select_video_stream(info)
    rate = selected.get("frame_rate") or {}
    from fractions import Fraction
    fps_raw = str(rate.get("fps") or "24/1")
    try:
        fps = float(Fraction(fps_raw))
    except (ValueError, ZeroDivisionError):
        fps = 24.0
    return min(30.0, max(12.0, fps))


def resolve_wan_home(explicit: str | None = None) -> str:
    candidates: list[Path] = []
    for raw in (explicit, os.environ.get("IPLAY_WAN_HOME"),
                os.environ.get("WAN22_HOME"), os.environ.get("WAN_HOME")):
        if raw:
            candidates.append(Path(os.path.expandvars(os.path.expanduser(raw))))
    home = Path.home()
    candidates += [home / "Wan2.2", home / "wan2.2", home / "Documents" / "Wan2.2",
                   Path("C:/Wan2.2"), Path("C:/AI/Wan2.2")]
    for candidate in candidates:
        if (candidate / "wan" / "modules" / "animate" / "preprocess" /
                "preprocess_data.py").is_file():
            return str(candidate.resolve())
    raise PerformanceTransferError(
        "Full-avatar exact mode requires the official local Wan2.2 checkout. "
        "Set IPLAY_WAN_HOME to the Wan2.2 folder. Face-only fallback is disabled.")


def resolve_wan_checkpoint(wan_home: str, explicit: str | None = None) -> str:
    candidates: list[Path] = []
    for raw in (explicit, os.environ.get("IPLAY_WAN_ANIMATE_CKPT"),
                os.environ.get("WAN_ANIMATE_CKPT")):
        if raw:
            candidates.append(Path(os.path.expandvars(os.path.expanduser(raw))))
    candidates += [Path(wan_home) / "Wan2.2-Animate-14B",
                   Path.home() / "Wan2.2-Animate-14B",
                   Path("C:/Wan2.2-Animate-14B"), Path("C:/AI/Wan2.2-Animate-14B")]
    for candidate in candidates:
        if (candidate / "process_checkpoint").is_dir():
            return str(candidate.resolve())
    raise PerformanceTransferError(
        "Wan2.2-Animate-14B preprocessing checkpoints are missing. Set "
        "IPLAY_WAN_ANIMATE_CKPT to the folder containing process_checkpoint.")


def _avatar_reference(avatar_path: str, temp_dir: str) -> str:
    ext = Path(avatar_path).suffix.lower()
    if ext in _IMAGE_EXTS:
        return os.path.abspath(avatar_path)
    if ext not in _VIDEO_EXTS:
        raise PerformanceTransferError("Avatar must be a photo or video file")
    duration = _probe_duration(avatar_path)
    out = os.path.join(temp_dir, "avatar_reference.png")
    cmd = media_tools.ffmpeg_command(
        "-ss", f"{duration * 0.5:.3f}", "-i", avatar_path, "-frames:v", "1",
        "-vf", "scale='min(1920,iw)':-2:flags=lanczos", out, loglevel="error")
    _run(cmd, stage="extract full-avatar reference")
    if not os.path.isfile(out) or os.path.getsize(out) < 1024:
        raise PerformanceTransferError("Could not extract a usable full-avatar reference")
    return out


def _scene_plan(performance_video: str, temp_dir: str) -> tuple[list[dict], float]:
    info = media_tools.probe_media(performance_video)
    master = media_tools.select_audio_stream(info)
    wav = os.path.join(temp_dir, "analysis.wav")
    pipeline.extract_audio(performance_video, wav, audio_ordinal=master["ordinal"])
    timing = pipeline.ms.analyze_audio(wav)
    fps = _source_fps(performance_video)
    planned = scene_tools.plan_scenes(timing, max_scene_s=9.0, min_scene_s=4.0)
    return planned, fps


def _extract_scene(source: str, start: float, duration: float, output: str,
                   fps: float, cancel_event=None) -> None:
    cmd = media_tools.ffmpeg_command(
        "-ss", f"{start:.6f}", "-i", source, "-t", f"{duration:.6f}",
        "-map", "0:v:0", "-an", "-vf", f"fps={fps:.6f}",
        "-c:v", "libx264", "-crf", "17", "-preset", "fast", "-pix_fmt", "yuv420p",
        output, loglevel="error")
    _run(cmd, stage="extract performance scene", cancel_event=cancel_event)


def build_wan_preprocess_command(wan_home: str, checkpoint: str,
                                 scene_video: str, avatar_reference: str,
                                 materials_dir: str, fps: float) -> list[str]:
    script = os.path.join(wan_home, "wan", "modules", "animate", "preprocess",
                          "preprocess_data.py")
    return [
        sys.executable, script,
        "--ckpt_path", os.path.join(checkpoint, "process_checkpoint"),
        "--video_path", os.path.abspath(scene_video),
        "--refer_path", os.path.abspath(avatar_reference),
        "--save_path", os.path.abspath(materials_dir),
        "--resolution_area", "1280", "720",
        "--fps", str(max(12, min(30, round(fps)))),
        # Deliberately enlarge the person mask to cover arms/hands and the
        # instrument-interaction envelope rather than leave source fragments.
        "--iterations", "5", "--k", "15", "--w_len", "1", "--h_len", "1",
        "--replace_flag",
    ]


def _normalize_scene(generated: str, expected_s: float, output: str,
                     fps: float, cancel_event=None) -> dict:
    actual = _probe_duration(generated)
    drift = abs(actual - expected_s) / max(expected_s, 1e-6)
    if drift > 0.025:
        raise PerformanceTransferError(
            f"Generated scene timing drifted {drift * 100:.1f}% "
            f"({actual:.3f}s vs {expected_s:.3f}s); refusing musically false output")
    factor = expected_s / actual
    cmd = media_tools.ffmpeg_command(
        "-i", generated, "-an",
        "-vf", f"setpts=PTS*{factor:.10f},fps={fps:.6f},scale=1280:720:flags=lanczos",
        "-t", f"{expected_s:.6f}", "-c:v", "libx264", "-crf", "17",
        "-preset", "fast", "-pix_fmt", "yuv420p", output, loglevel="error")
    _run(cmd, stage="normalize replacement scene timing", cancel_event=cancel_event)
    media_tools.validate_media(output, expected_duration_s=expected_s,
                               width=1280, height=720, require_audio=False,
                               duration_tolerance_s=0.15)
    return {"generated_duration_s": actual, "target_duration_s": expected_s,
            "timing_scale": factor, "drift_fraction": drift}


def _concat_scenes(paths: list[str], output: str, cancel_event=None) -> None:
    if not paths:
        raise PerformanceTransferError("No replacement scenes were produced")
    listing = output + ".concat.txt"
    with open(listing, "w", encoding="utf-8") as fh:
        for path in paths:
            escaped = os.path.abspath(path).replace("'", "'\\''")
            fh.write(f"file '{escaped}'\n")
    try:
        cmd = media_tools.ffmpeg_command("-f", "concat", "-safe", "0", "-i", listing,
                                         "-c", "copy", output, loglevel="error")
        _run(cmd, stage="concatenate full-avatar scenes", cancel_event=cancel_event)
    finally:
        try:
            os.remove(listing)
        except OSError:
            pass


def _restore_master_audio(video_only: str, performance_video: str,
                          output: str, cancel_event=None) -> dict:
    info = media_tools.probe_media(performance_video)
    master = media_tools.select_audio_stream(info)
    duration = _probe_duration(performance_video)
    cmd = media_tools.ffmpeg_command(
        "-i", video_only, "-i", performance_video,
        "-map", "0:v:0", "-map", f"1:a:{int(master['ordinal'])}",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-t", f"{duration:.6f}",
        "-movflags", "+faststart", output, loglevel="error")
    _run(cmd, stage="restore original master audio", cancel_event=cancel_event)
    summary = media_tools.validate_media(output, expected_duration_s=duration,
                                         require_audio=True, duration_tolerance_s=1.0)
    return {"master_audio": master, "summary": summary, "duration_s": duration}


def render_exact_avatar_performance(
        performance_video: str, avatar_identity: str, instrument: str,
        output_path: str, *, wan_home: str | None = None,
        wan_checkpoint: str | None = None, wan_model: str | None = None,
        uhd: bool = True, guitar_variant: str | None = None,
        progress_cb=print, stage_cb=None, cancel_event=None,
        rights_acknowledged: bool = False,
        license_notes: str = "",
        work_dir: str | None = None,
        resume: bool = True) -> dict:
    """Regenerate the full visible performer as the avatar, scene by scene."""
    for label, path in (("Performance video", performance_video),
                        ("Avatar", avatar_identity)):
        if not os.path.isfile(path):
            raise PerformanceTransferError(f"{label} not found: {path}")
    if instrument not in pipeline.INSTRUMENTS:
        raise PerformanceTransferError(f"Unsupported instrument: {instrument}")
    try:
        consent = consent_records.build_consent_record(
            performance_path=performance_video,
            avatar_path=avatar_identity,
            instrument=instrument,
            rights_acknowledged=rights_acknowledged,
            license_notes=license_notes,
            reference_licenses=consent_records.load_reference_license_inventory(
                str(HERE / "refs" / "manifest.json")),
        )
    except consent_records.ConsentRecordError as exc:
        raise PerformanceTransferError(str(exc)) from exc

    wan_home = resolve_wan_home(wan_home)
    checkpoint = resolve_wan_checkpoint(wan_home, wan_checkpoint)
    temp_dir = work_dir or tempfile.mkdtemp(prefix="iplay_full_avatar_")
    own_temp = work_dir is None
    os.makedirs(temp_dir, exist_ok=True)
    try:
        progress_cb("[full avatar 1/7] Hashing master audio and building timeline...")
        audio_hash = audio_authority.hash_master_audio(performance_video)
        avatar_ref = _avatar_reference(avatar_identity, temp_dir)
        plan, fps = _scene_plan(performance_video, temp_dir)
        if not plan:
            raise PerformanceTransferError("Could not create a scene plan")

        # Rebuild timing for solvers/timeline from the analysis wav produced by
        # _scene_plan (extract_audio writes analysis.wav into temp_dir).
        analysis_wav = os.path.join(temp_dir, "analysis.wav")
        timing = pipeline.ms.analyze_audio(analysis_wav)
        solver_events = instrument_solvers.solve_instrument_actions(
            instrument if instrument != "bass" else "guitar",
            [float(t) for t in timing.get("onset_times") or []],
            base_confidence=0.85)
        continuity = instrument_solvers.validate_action_continuity(
            instrument if instrument != "bass" else "guitar", solver_events)
        timeline = timeline_tools.build_performance_timeline(
            instrument="guitar" if instrument == "bass" else instrument,
            timing=timing,
            scenes=plan,
            motion_source_tier="source-derived",
            motion_identity="source-performance-motion",
            avatar_identity=os.path.basename(avatar_identity),
            guitar_variant=guitar_variant,
            master_audio_hash_sha256=audio_hash["sha256"],
            rights=consent,
            solver_events=solver_events,
        )
        timeline_before = timeline_tools.freeze_timeline(timeline)
        heygen_payload = timeline_tools.heygen_bounded_payload(timeline_before)
        # Simulate HeyGen failure/retry surface: payload is metadata-only and
        # must not be able to mutate IPlay authority even if a caller mutates it.
        heygen_payload["timeline_fingerprint"] = {"tamper": True}
        timeline_tools.assert_timeline_untouched(timeline_before, timeline)

        done = checkpoints.completed_scene_indexes(temp_dir) if resume else set()
        worker_scenes = []
        scene_records = []
        for scene in plan:
            idx = int(scene["index"])
            start = float(scene["start"])
            dur = float(scene["dur"])
            source_scene = os.path.join(temp_dir, f"source_{idx:03d}.mp4")
            materials = os.path.join(temp_dir, f"materials_{idx:03d}")
            generated = os.path.join(temp_dir, f"generated_{idx:03d}.mp4")
            normalized_out = os.path.join(temp_dir, f"normalized_{idx:03d}.mp4")
            os.makedirs(materials, exist_ok=True)
            record = {"index": idx, "start": start, "duration_s": dur,
                      "source_scene": source_scene, "materials": materials,
                      "generated": generated, "normalized": normalized_out}
            if idx in done and os.path.isfile(normalized_out):
                progress_cb(f"[full avatar resume] Reusing completed scene "
                            f"{idx + 1}/{len(plan)}")
                record["resumed"] = True
                scene_records.append(record)
                continue
            _extract_scene(performance_video, start, dur, source_scene, fps, cancel_event)
            progress_cb(f"[full avatar 2/7] Preparing replacement controls "
                        f"for scene {idx + 1}/{len(plan)}...")
            _run(build_wan_preprocess_command(wan_home, checkpoint, source_scene,
                                              avatar_ref, materials, fps),
                 cwd=wan_home, stage=f"Wan preprocess scene {idx + 1}",
                 cancel_event=cancel_event)
            required = ("src_pose.mp4", "src_face.mp4", "src_bg.mp4", "src_mask.mp4")
            missing = [name for name in required
                       if not os.path.isfile(os.path.join(materials, name))]
            if missing:
                raise PerformanceTransferError(
                    f"Wan preprocessing omitted {', '.join(missing)} in scene {idx + 1}")
            worker_scenes.append({"materials": materials, "output": generated})
            record["resumed"] = False
            scene_records.append(record)

        if worker_scenes:
            job = {
                "model": wan_model or os.environ.get("IPLAY_WAN_DIFFUSERS_MODEL") or DEFAULT_MODEL,
                "avatar_reference": avatar_ref,
                "fps": fps, "seed": 42, "steps": 20, "guidance_scale": 1.0,
                "segment_frame_length": 77, "prev_segment_conditioning_frames": 1,
                "prompt": ("The reference avatar is the only visible performer. Replace the "
                           "entire driving musician, including head, torso, arms, hands, clothing "
                           "and instrument appearance, while following the driving performance "
                           "motion as faithfully as possible. Preserve believable hand-to-"
                           "instrument interaction, five-finger anatomy, fret/pick/bow/key contact, "
                           "and consistent avatar identity. Never reveal the source musician."),
                "scenes": worker_scenes,
                "iplay_timeline_fingerprint": heygen_payload.get("timeline_fingerprint"),
            }
            job_path = os.path.join(temp_dir, "wan_job.json")
            with open(job_path, "w", encoding="utf-8") as fh:
                json.dump(job, fh, indent=2)

            progress_cb(f"[full avatar 3/7] Rendering {len(worker_scenes)} full-avatar scenes "
                        "with one persistent Wan2.2 model load...")
            _run([sys.executable, os.path.join(HERE, "wan_replace_worker.py"), job_path],
                 stage="Wan2.2 full-avatar replacement", cancel_event=cancel_event)

        normalized = []
        for record in scene_records:
            idx = record["index"]
            out = record["normalized"]
            if record.get("resumed") and os.path.isfile(out):
                normalized.append(out)
                continue
            generated = record["generated"]
            if not os.path.isfile(generated):
                raise PerformanceTransferError(
                    f"Wan did not produce scene {idx + 1}; no source fallback allowed")
            record["timing"] = _normalize_scene(
                generated, record["duration_s"], out, fps, cancel_event)
            try:
                record["replacement_qa"] = qa.replacement_coverage(
                    record["source_scene"], out,
                    os.path.join(record["materials"], "src_mask.mp4"),
                    record["duration_s"])
                pose_src = os.path.join(record["materials"], "src_pose.mp4")
                # Do not self-compare poses (always passes). Threshold pose QA
                # requires a regenerated pose extract from the avatar scene.
                if os.path.isfile(pose_src):
                    record["pose_qa"] = {
                        "status": "deferred",
                        "compared_against": None,
                        "source_pose": pose_src,
                        "note": (
                            "Pose-fidelity thresholds (median≤0.055, p90≤0.11) apply "
                            "once a second Wan preprocess produces generated pose. "
                            "Replacement coverage gate still enforces source-leak rejection."
                        ),
                    }
            except qa.PerformanceQAError as exc:
                raise PerformanceTransferError(
                    f"Scene {idx + 1} failed full-avatar source-leak QA: {exc}. "
                    "The original musician will not be published as a fallback.") from exc
            checkpoints.mark_scene_completed(
                temp_dir, idx, out,
                master_audio_hash_sha256=audio_hash["sha256"],
                extra={"instrument": instrument,
                       "performance": os.path.basename(performance_video)})
            normalized.append(out)

        progress_cb("[full avatar 4/7] Joining QA-passed avatar-only scenes...")
        joined = os.path.join(temp_dir, "full_avatar_video_only.mp4")
        _concat_scenes(normalized, joined, cancel_event)
        expected = _probe_duration(performance_video)
        media_tools.validate_media(joined, expected_duration_s=expected,
                                   width=1280, height=720, require_audio=False,
                                   duration_tolerance_s=max(1.0, 0.01 * expected))

        progress_cb("[full avatar 5/7] Restoring untouched master soundtrack...")
        with_audio = os.path.join(temp_dir, "full_avatar_with_master_audio.mp4")
        audio_record = _restore_master_audio(joined, performance_video,
                                             with_audio, cancel_event)
        audio_verify = audio_authority.verify_restored_audio_hash(
            performance_video, with_audio, audio_hash["sha256"],
            audio_ordinal=audio_hash["audio_ordinal"])

        progress_cb("[full avatar 6/7] Directing final multi-scene IPlay production...")
        report = pipeline.build_video(
            with_audio, [], instrument, output_path, uhd=uhd,
            progress_cb=progress_cb, stage_cb=stage_cb, full_song_scenes=False,
            guitar_variant=guitar_variant, local_director=True, cutaway_files=[],
            cancel_event=cancel_event, source_performance=True)

        progress_cb("[full avatar 7/7] Writing consent, audio authority, and timeline records...")
        sidecar_dir = os.path.splitext(os.path.abspath(output_path))[0] + ".iplay"
        os.makedirs(sidecar_dir, exist_ok=True)
        consent_path = os.path.join(sidecar_dir, "consent.json")
        timeline_path = os.path.join(sidecar_dir, "performance_timeline.json")
        audio_path = os.path.join(sidecar_dir, "audio_authority.json")
        consent_records.write_consent_record(consent_path, consent)
        with open(timeline_path, "w", encoding="utf-8") as fh:
            json.dump(timeline, fh, indent=2)
        audio_authority.write_audio_authority_record(audio_path, {
            "source_master_sha256": audio_hash["sha256"],
            "audio_ordinal": audio_hash["audio_ordinal"],
            "verify": audio_verify,
        })
        timeline_tools.assert_timeline_untouched(timeline_before, timeline)
        checkpoints.mark_render_complete(temp_dir, output_path)

        report["exact_performance_avatar_transfer"] = {
            "status": "completed",
            "replacement_engine": "Wan2.2-Animate-14B",
            "replacement_mode": "full_character",
            "source_body_pixels_reused": False,
            "source_performer_fallback_allowed": False,
            "avatar_source": os.path.basename(avatar_identity),
            "performance_source": os.path.basename(performance_video),
            "outer_scene_count": len(plan),
            "internal_segment_frame_length": 77,
            "scene_validation": [
                {"index": r["index"], "timing": r.get("timing"),
                 "replacement_qa": r.get("replacement_qa"),
                 "pose_qa": r.get("pose_qa"),
                 "resumed": bool(r.get("resumed"))}
                for r in scene_records
            ],
            "master_audio": audio_record["master_audio"],
            "master_audio_sha256": audio_hash["sha256"],
            "audio_authority_verify": audio_verify,
            "action_continuity": continuity,
            "heygen_boundary": {
                "scope": "non_performance_assets_only",
                "may_alter_timeline": False,
                "may_alter_master_audio": False,
                "failure_cannot_mutate_iplay_timeline": True,
            },
            "sidecars": {
                "consent": consent_path,
                "timeline": timeline_path,
                "audio_authority": audio_path,
            },
        }
        report["performance_timeline"] = timeline
        report["motion_source_tier"] = "source-derived-full-replacement"
        report["motion_accuracy"] = (
            "Whole-avatar motion is driven scene-by-scene from the synchronized source "
            "performance. Source-leak QA rejects near-unreplaced performer regions. "
            "Fine finger/instrument contact remains generative and requires final visual QA.")
        return report
    finally:
        if own_temp:
            shutil.rmtree(temp_dir, ignore_errors=True)


def _cli() -> int:
    p = argparse.ArgumentParser(description="IPlay full-avatar exact performance renderer")
    p.add_argument("performance_video"); p.add_argument("avatar_identity")
    p.add_argument("instrument", choices=pipeline.INSTRUMENTS); p.add_argument("output")
    p.add_argument("--wan-home"); p.add_argument("--wan-checkpoint"); p.add_argument("--wan-model")
    p.add_argument("--guitar-variant", choices=("acoustic", "electric", "bass"))
    p.add_argument("--1080p", dest="uhd", action="store_false")
    p.add_argument("--rights-acknowledged", action="store_true",
                   help="Required: confirm rights/consent to use the performance and avatar")
    p.add_argument("--license-notes", default="")
    p.add_argument("--work-dir", help="Persistent work directory enabling resume")
    p.add_argument("--no-resume", dest="resume", action="store_false")
    a = p.parse_args()
    report = render_exact_avatar_performance(
        a.performance_video, a.avatar_identity, a.instrument, a.output,
        wan_home=a.wan_home, wan_checkpoint=a.wan_checkpoint, wan_model=a.wan_model,
        uhd=a.uhd, guitar_variant=a.guitar_variant,
        rights_acknowledged=a.rights_acknowledged,
        license_notes=a.license_notes, work_dir=a.work_dir, resume=a.resume)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
