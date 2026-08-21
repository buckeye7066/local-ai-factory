"""IPlay pipeline — pure functions, no GUI.

Turns (music file, optional production assets, instrument) into a music video
whose player motion is reference footage retimed so gestures land on the
track's beat grid. Rendering engine = ../sync.py; timing analysis =
../motionsync.py (loaded by file path — the parent dir is not a package).

IPlay owns the protected performance frames and continuous master audio.
Optional identity assets are staged as metadata only; this supported pipeline
makes no HeyGen generation call.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile

import media as media_tools
import performance_source as performance_tools

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
REFS_DIR = os.path.join(HERE, "refs")
MANIFEST_PATH = os.path.join(REFS_DIR, "manifest.json")

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wma"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".wmv", ".flv",
              ".ts", ".mpg", ".mpeg", ".3gp"}
INSTRUMENTS = ("piano", "guitar", "violin")

# Fallback policy table used until motionsync.choose_policy lands (a sibling
# agent is adding it concurrently — code against the contract, fall back on
# AttributeError).
_FALLBACK_POLICY = {"piano": "loop", "guitar": "cut", "violin": "warp"}


def _load_by_path(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(PARENT, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ms = _load_by_path("iplay_motionsync", "motionsync.py")
sy = _load_by_path("iplay_sync", "sync.py")


class IPlayRefMissing(Exception):
    """A reference clip / manifest entry is missing. Message is user-facing."""


class IPlayError(Exception):
    """Pipeline failure with a user-readable message."""


class IPlayCancelled(IPlayError):
    """The user cancelled a render; callers should not start fallbacks."""


def validate_source_performance_input(
        media_path: str, *, audio_ordinal: int | None = None,
        probe_info: dict | None = None) -> dict:
    """GUI-safe preflight for the explicit source-performance checkbox."""
    try:
        return performance_tools.validate_performance_media(
            media_path, audio_ordinal=audio_ordinal, probe_info=probe_info)
    except performance_tools.PerformanceSourceError as exc:
        raise IPlayError(str(exc)) from exc


# --------------------------------------------------------------------------- #
# audio extraction
# --------------------------------------------------------------------------- #

def extract_audio(input_path: str, out_wav: str, *, audio_ordinal: int = 0,
                  log_path: str | None = None, cancel_event=None) -> str:
    """Extract/transcode the music to mono 22050 Hz WAV (what analyze_audio
    expects). Accepts video containers (mp4/mov/mkv) or audio (wav/mp3/m4a)."""
    # Extension gate is advisory only — ffmpeg is the real authority on what
    # decodes. Unknown extensions are attempted anyway so e.g. odd YouTube
    # download containers still work; a genuinely unreadable file surfaces as
    # the ffmpeg error below.
    # Same ffmpeg invocation covers both cases: -vn drops video if present,
    # -ac 1 -ar 22050 gives the mono 22050 Hz PCM the analyzer wants.
    cmd = media_tools.ffmpeg_command(
        "-i", input_path, "-map", f"0:a:{int(audio_ordinal)}", "-vn",
        "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", out_wav,
        loglevel="error")
    log_path = log_path or os.path.abspath(out_wav + ".ffmpeg.log")
    result = media_tools.run_logged(
        cmd, stage="analysis audio extraction", log_path=log_path,
        cancel_event=cancel_event)
    if result.cancelled:
        raise IPlayCancelled(
            media_tools.format_failure("Analysis audio extraction", result))
    if not result.ok or not os.path.exists(out_wav):
        validation = None if os.path.exists(out_wav) else IPlayError(
            "FFmpeg reported success but created no analysis WAV")
        raise IPlayError(media_tools.format_failure(
            "Analysis audio extraction", result, validation_error=validation))
    media_tools.remove_success_log(result)
    return out_wav


# --------------------------------------------------------------------------- #
# reference manifest
# --------------------------------------------------------------------------- #

_MANIFEST_HELP = (
    "Drop a real playing clip (a few seconds of steady strumming / key presses "
    "/ bowing, camera still) into\n  " + REFS_DIR + "\nand describe it in "
    "refs\\manifest.json like:\n"
    '  {"piano": {"file": "piano.mp4", "stroke_hz": 2.0, "first_stroke_s": 0.4,'
    ' "strokes_per_beat": 1.0, "license": "...", "source_url": "..."}}\n'
    "stroke_hz = strokes per second in the clip; first_stroke_s = time of the "
    "first stroke."
)


def load_manifest(instrument: str) -> dict:
    """Return the manifest entry for `instrument` (with resolved clip path in
    key 'file'), or raise IPlayRefMissing with a helpful message."""
    if instrument not in INSTRUMENTS:
        raise IPlayError(f"Unknown instrument {instrument!r}; want one of {INSTRUMENTS}")
    if not os.path.exists(MANIFEST_PATH):
        raise IPlayRefMissing(
            f"No reference manifest found at {MANIFEST_PATH}.\n" + _MANIFEST_HELP)
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        raise IPlayRefMissing(
            f"Could not read {MANIFEST_PATH} ({e}).\n" + _MANIFEST_HELP)
    entry = manifest.get(instrument)
    if not isinstance(entry, dict) or "file" not in entry or "stroke_hz" not in entry:
        raise IPlayRefMissing(
            f"manifest.json has no usable {instrument!r} entry "
            "(need at least \"file\" and \"stroke_hz\").\n" + _MANIFEST_HELP)
    clip = entry["file"]
    if not os.path.isabs(clip):
        clip = os.path.join(REFS_DIR, clip)
    if not os.path.exists(clip):
        raise IPlayRefMissing(
            f"Reference clip for {instrument} not found: {clip}\n" + _MANIFEST_HELP)
    out = dict(entry)
    out["file"] = clip
    cutaways = []
    for item in entry.get("cutaways") or []:
        value = item.get("file") if isinstance(item, dict) else item
        if not isinstance(value, str) or not value.strip():
            continue
        path = value if os.path.isabs(value) else os.path.join(REFS_DIR, value)
        cutaways.append(path)
    out["cutaways"] = cutaways
    return out


# --------------------------------------------------------------------------- #
# policy selection
# --------------------------------------------------------------------------- #

def choose_policy(timing: dict, instrument: str) -> dict:
    """Delegate to motionsync.choose_policy (being added by a sibling agent);
    fall back to a static per-instrument table if it isn't there yet."""
    try:
        return ms.choose_policy(timing, instrument)
    except AttributeError:
        return {"policy": _FALLBACK_POLICY[instrument], "reason": "fallback",
                "strokes_per_beat": 1.0}


# --------------------------------------------------------------------------- #
# optional identity/production-asset boundary (best-effort, never fatal)
# --------------------------------------------------------------------------- #

SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "settings.json")

_DEFAULT_SETTINGS = {
    "youtube_quality": "best_bitrate",
    "youtube_cookies_browser": "none",
    "youtube_solve_challenges": True,
}
_OPTIONAL_SETTING_KEYS = ("youtube_dir", "youtube_scan_dirs")


def load_settings() -> dict:
    settings = dict(_DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as fh:
            saved = json.load(fh)
        if isinstance(saved, dict):
            # Ignore retired/unknown fields (notably the former plaintext
            # HeyGen credential) so a later save cannot resurrect them.
            allowed = set(settings) | set(_OPTIONAL_SETTING_KEYS)
            settings.update({key: saved[key] for key in allowed if key in saved})
    except (OSError, ValueError):
        pass
    return settings


def save_settings(settings: dict) -> None:
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w", encoding="utf-8") as fh:
        safe = {key: settings.get(key, default)
                for key, default in _DEFAULT_SETTINGS.items()}
        safe.update({key: settings[key] for key in _OPTIONAL_SETTING_KEYS
                     if key in settings})
        json.dump(safe, fh, indent=2)
        fh.write("\n")
    # Best effort on POSIX. Windows ACLs remain inherited from the user's
    # profile; the file is local-only and ignored by Git.
    try:
        os.chmod(SETTINGS_PATH, 0o600)
    except OSError:
        pass


def default_videos_dir(*parts: str) -> str:
    """A user-specific Videos path without a checked-in machine username.

    Some Windows installations redirect the home/Videos tree to a failing G:
    drive. Preserve IPlay's existing guard, but derive the fallback from the
    current user and SystemDrive instead of a developer's absolute path.
    """
    home = os.path.expanduser("~")
    out = os.path.join(home, "Videos", *parts)
    if os.path.splitdrive(out)[0].upper() == "G:":
        system_drive = os.environ.get("SystemDrive") or "C:"
        username = os.path.basename(os.path.normpath(home)) or "User"
        out = os.path.join(system_drive + os.sep, "Users", username,
                           "Videos", *parts)
    return out


_WINDOWS_RESERVED_STEMS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def safe_output_stem(value: str, max_chars: int = 120) -> str:
    """Return a Unicode-preserving, Windows-safe filename component.

    FFmpeg receives argv directly, so spaces, brackets, and non-ASCII text are
    safe. Windows still rejects reserved characters/device names and caps each
    path component at 255 characters; keeping the source stem bounded also
    leaves room for IPlay's stage-log and partial suffixes.
    """
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    cleaned = cleaned[:max(1, int(max_chars))].rstrip(" .") or "music"
    if cleaned.split(".", 1)[0].upper() in _WINDOWS_RESERVED_STEMS:
        cleaned = "_" + cleaned
    return cleaned


# --------------------------------------------------------------------------- #
# optional identity sources: a still photo OR footage of the person
# --------------------------------------------------------------------------- #
# These files are staged as metadata only. They do not enter or alter protected
# performance frames and selecting them makes no network request.
FACE_IMAGE_EXTS = {".jpg", ".jpeg", ".png"}
FACE_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"}
def face_source_kind(path: str) -> str:
    """Return image, video, or unknown from the file extension."""
    ext = os.path.splitext(path)[1].lower()
    if ext in FACE_IMAGE_EXTS:
        return "image"
    if ext in FACE_VIDEO_EXTS:
        return "video"
    return "unknown"

def _production_asset_stage(face_sources: list[str], *, mode: str) -> dict:
    """Stage a future HeyGen v3 Video Agent request without submitting it.

    IPlay owns the production timeline and every protected performance frame.
    This adapter boundary can later accept only identity-without-performance,
    background, b-roll, establishing, and mood assets. Merely selecting a face
    source never spends credits or makes a network request.
    """
    if not face_sources:
        return {"status": "skipped", "detail": "no optional identity asset provided",
                "paid_calls_made": False}
    missing = [p for p in face_sources if not os.path.isfile(p)]
    if missing:
        return {"status": "unavailable",
                "detail": "optional identity asset is missing: "
                          + ", ".join(os.path.basename(p) for p in missing),
                "paid_calls_made": False}
    unknown = [p for p in face_sources if face_source_kind(p) == "unknown"]
    if unknown:
        return {"status": "unavailable",
                "detail": "identity assets must be photo or footage files; unsupported: "
                          + ", ".join(os.path.basename(p) for p in unknown),
                "paid_calls_made": False}
    return {
        "status": "staged",
        "detail": ("HeyGen v3 production-asset adapter is staged but not submitted; "
                   "no credits used. Scope is background/b-roll/establishing/mood "
                   "or identity assets without visible playing hands/instrument."),
        "mode": mode,
        "target": "v3_video_agent",
        "heygen_scope": "non_performance_assets_only",
        "motion_source": "iplay",
        "hands_locked": True,
        "instrument_geometry_locked": True,
        "audio_locked": True,
        "paid_calls_made": False,
    }


def face_stage(face_sources: list[str], video_path: str, progress_cb=print, *,
               instrument: str = "piano", audio_dur: float | None = None,
               poll_timeout_s: int = 1800, tmpdir: str | None = None) -> dict:
    """Compatibility name for the safe, non-submitting asset boundary."""
    return _production_asset_stage(face_sources, mode="identity_asset")


def face_scenes_stage(face_sources: list[str], music_wav: str, timing: dict,
                      video_path: str, progress_cb=print, *,
                      instrument: str = "piano", variant: str | None = None,
                      poll_timeout_s: int = 3600, tmpdir: str | None = None,
                      max_retries: int = 1, music_src: str | None = None) -> dict:
    """Compatibility name for a manifest-only v3 production-assets request."""
    return _production_asset_stage(face_sources, mode="production_assets_manifest")


def _attempt_final_render(source_video: str, master_media: str, out_path: str,
                          duration_s: float, *, stage: str,
                          audio_ordinal: int = 0,
                          video_ordinal: int = 0,
                          width: int | None = None,
                          height: int | None = None,
                          source_display_geometry: dict | None = None,
                          copy_video: bool = False,
                          preset: str = "fast", crf: int = 20,
                          cancel_event=None) -> tuple[dict | None, str | None]:
    """Mux one continuous original soundtrack into an atomic final partial."""
    partial = media_tools.partial_path(out_path, stage)
    log_path = media_tools.stage_log_path(out_path, stage)
    cmd = media_tools.ffmpeg_command("-i", source_video, "-i", master_media,
                                     "-map", f"0:v:{int(video_ordinal)}", "-map",
                                     f"1:a:{int(audio_ordinal)}")
    if copy_video:
        cmd += ["-c:v", "copy"]
    else:
        if not width or not height:
            raise ValueError("scaled final render requires width and height")
        normalization = ""
        if source_display_geometry is not None:
            try:
                display_width = int(source_display_geometry["display_width"])
                display_height = int(source_display_geometry["display_height"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(
                    "scaled source-preserved final needs display geometry") from exc
            if display_width <= 0 or display_height <= 0:
                raise ValueError(
                    "scaled source-preserved display geometry must be positive")
            normalization = (
                f"scale={display_width}:{display_height}:flags=lanczos,"
                "setsar=1,")
        vf = (normalization
              + f"scale={width}:{height}:force_original_aspect_ratio=decrease:"
                f"flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
                "setsar=1,format=yuv420p")
        cmd += ["-vf", vf, "-c:v", "libx264", "-crf", str(crf),
                "-preset", preset, "-pix_fmt", "yuv420p"]
    duration_arg = f"{float(duration_s):.9f}".rstrip("0").rstrip(".")
    cmd += ["-c:a", "aac", "-b:a", "256k", "-t", duration_arg,
            "-movflags", "+faststart", partial]
    result = media_tools.run_logged(
        cmd, stage=stage, log_path=log_path, cancel_event=cancel_event)
    if result.cancelled:
        raise IPlayCancelled(media_tools.format_failure(stage, result, partial))
    validation_error = None
    summary = None
    if result.ok:
        try:
            summary = media_tools.validate_media(
                partial, expected_duration_s=duration_s,
                width=width, height=height, require_audio=True,
                duration_tolerance_s=1.0)
        except media_tools.MediaValidationError as exc:
            validation_error = exc
    if not result.ok or validation_error is not None:
        return None, media_tools.format_failure(
            stage, result, partial, validation_error)
    media_tools.promote_partial(partial, out_path)
    media_tools.remove_success_log(result)
    return summary, None


def _deliver_final(source_video: str, master_media: str, out_path: str,
                   duration_s: float, uhd: bool, *, audio_ordinal: int = 0,
                   video_ordinal: int = 0,
                   source_display_geometry: dict | None = None,
                   uhd_decline_reason: str | None = None,
                   progress_cb=print, cancel_event=None) -> dict:
    """Deliver requested UHD or a validated, explicitly reported fallback."""
    failures: list[str] = []
    try:
        source_info = media_tools.probe_media(
            source_video, cancel_event=cancel_event)
    except media_tools.RenderCancelled as exc:
        raise IPlayCancelled(str(exc)) from exc
    source_stream = media_tools.video_stream_at(source_info, video_ordinal)
    source_width = int(source_stream.get("width") or 0)
    source_height = int(source_stream.get("height") or 0)
    if uhd:
        # The local director renders at the requested delivery raster. Mux its
        # original-master audio with a video stream copy instead of degrading
        # that 2160p result through a redundant second H.264 encode.
        if source_width == 3840 and source_height == 2160:
            progress_cb("[5/5] Muxing the original continuous master audio "
                        "into the completed 2160p edit (video stream copy)...")
            summary, failure = _attempt_final_render(
                source_video, master_media, out_path, duration_s,
                stage="uhd_master_mux", width=3840, height=2160,
                video_ordinal=video_ordinal, audio_ordinal=audio_ordinal,
                copy_video=True, cancel_event=cancel_event)
            if summary:
                return {"summary": summary,
                        "label": "directed/native 2160p (video copied; master audio muxed)",
                        "requested_uhd": True, "delivered_uhd": True,
                        "fallback": False, "failure": None,
                        "video_reencoded_in_final": False}
            failures.append(failure or
                            "2160p video-copy mux failed without detail")
        if uhd_decline_reason:
            ok, preflight = False, uhd_decline_reason
        else:
            ok, preflight = media_tools.uhd_preflight(
                os.path.dirname(os.path.abspath(out_path)), source_video)
        if ok:
            progress_cb("[5/5] Upscaling to 3840x2160 "
                        "(lanczos, x264 crf18 medium)...")
            summary, failure = _attempt_final_render(
                source_video, master_media, out_path, duration_s,
                stage="uhd", width=3840, height=2160,
                video_ordinal=video_ordinal,
                audio_ordinal=audio_ordinal, preset="medium", crf=18,
                source_display_geometry=source_display_geometry,
                cancel_event=cancel_event)
            if summary:
                return {"summary": summary,
                        "label": "upscaled to 2160p (lanczos)",
                        "requested_uhd": True, "delivered_uhd": True,
                        "fallback": False, "failure": None,
                        "video_reencoded_in_final": True}
            failures.append(failure or "UHD encode failed without detail")
        else:
            failures.append(f"UHD preflight declined the encode: {preflight}")
        if source_width == 1920 and source_height == 1080:
            progress_cb("[5/5] UHD was not deliverable; muxing the original "
                        "master audio into the completed 1080p edit "
                        "(video stream copy)...")
            summary, failure = _attempt_final_render(
                source_video, master_media, out_path, duration_s,
                stage="fallback1080_master_mux", width=1920, height=1080,
                video_ordinal=video_ordinal, audio_ordinal=audio_ordinal,
                copy_video=True, cancel_event=cancel_event)
            if summary:
                return {"summary": summary,
                        "label": "validated 1080p fallback (video copied; master audio muxed)",
                        "requested_uhd": True, "delivered_uhd": False,
                        "fallback": True, "failure": "\n\n".join(failures),
                        "video_reencoded_in_final": False}
            failures.append(failure or
                            "1080p video-copy mux failed without detail")
        progress_cb("[5/5] UHD was not deliverable; producing a validated "
                    "1920x1080 fallback with the original master audio...")
        summary, failure = _attempt_final_render(
            source_video, master_media, out_path, duration_s,
            stage="fallback1080", width=1920, height=1080,
            video_ordinal=video_ordinal,
            audio_ordinal=audio_ordinal, preset="fast", crf=20,
            source_display_geometry=source_display_geometry,
            cancel_event=cancel_event)
        if summary:
            return {"summary": summary,
                    "label": "validated 1080p fallback (UHD requested)",
                    "requested_uhd": True, "delivered_uhd": False,
                    "fallback": True, "failure": "\n\n".join(failures),
                    "video_reencoded_in_final": True}
        failures.append(failure or "1080p fallback failed without detail")
        raise IPlayError("UHD and its validated 1080p fallback both failed:\n\n"
                         + "\n\n".join(failures))

    # No UHD requested: preserve an already-produced local edit/native H.264
    # stream and replace only its analysis audio with the original master.
    progress_cb("[5/5] Muxing the original continuous master audio...")
    summary, failure = _attempt_final_render(
        source_video, master_media, out_path, duration_s,
        stage="master_mux", width=source_width,
        height=source_height, copy_video=True,
        video_ordinal=video_ordinal,
        audio_ordinal=audio_ordinal, cancel_event=cancel_event)
    if summary:
        return {"summary": summary,
                "label": "native/local-edit resolution (no UHD upscale)",
                "requested_uhd": False, "delivered_uhd": False,
                "fallback": False, "failure": None,
                "video_reencoded_in_final": False}
    progress_cb("[5/5] Stream-copy mux failed validation; normalizing to "
                "1920x1080 with the original master audio...")
    summary, fallback_failure = _attempt_final_render(
        source_video, master_media, out_path, duration_s,
        stage="fallback1080", width=1920, height=1080,
        video_ordinal=video_ordinal,
        audio_ordinal=audio_ordinal, preset="fast", crf=20,
        source_display_geometry=source_display_geometry,
        cancel_event=cancel_event)
    if not summary:
        raise IPlayError("Final mux and validated fallback failed:\n\n"
                         + (failure or "unknown mux failure") + "\n\n"
                         + (fallback_failure or "unknown fallback failure"))
    return {"summary": summary,
            "label": "validated 1080p fallback (native mux failed)",
            "requested_uhd": False, "delivered_uhd": False,
            "fallback": True, "failure": failure,
            "video_reencoded_in_final": True}


def _source_director_profile(source_probe: dict, *, uhd: bool,
                             fallback_1080: bool = False) -> dict:
    """Carry one validated source stream into the local edit unchanged.

    UHD requests render the director once at the delivery raster. Native
    delivery keeps the selected stream's proven *display* dimensions, not its
    raw encoded raster. Both retain the exact validated cadence and explicit
    FFmpeg video ordinal.
    """
    display_geometry = dict(source_probe["video_display_geometry"])
    return {
        "width": (3840 if uhd else
                  (1920 if fallback_1080 else
                   int(display_geometry["display_width"]))),
        "height": (2160 if uhd else
                   (1080 if fallback_1080 else
                    int(display_geometry["display_height"]))),
        "fps": source_probe["video_frame_rate"],
        "performance_video_ordinal": int(
            source_probe["video_stream_ordinal"]),
        "performance_display_geometry": display_geometry,
    }


class _Progress:
    """Maps a sub-stage's own 0..1 progress into its slice of the overall bar.

    Stages report a LOCAL fraction and a label; `slice()` hands a nested stage
    a narrower window without it needing to know where it sits overall. The
    percentage therefore tracks real completed work, not a timer — it says how
    much of the render is DONE, not how long is left.
    """

    def __init__(self, cb=None, base: float = 0.0, span: float = 1.0):
        self._cb = cb
        self.base = base
        self.span = span

    def __call__(self, frac: float, label: str) -> None:
        if self._cb is None:
            return
        frac = 0.0 if frac < 0.0 else (1.0 if frac > 1.0 else frac)
        try:
            self._cb(self.base + self.span * frac, label)
        except Exception:
            pass  # a broken UI callback must never kill a render

    def slice(self, start: float, end: float) -> "_Progress":
        return _Progress(self._cb, self.base + self.span * start,
                         self.span * (end - start))


def _expected_retime_commands(policy: str, beat_count: int) -> int:
    """How many ffmpeg invocations sy.render will issue for this policy.

    Lets the retime stage — the long pole of a local render — report TRUE
    progress by counting completed commands instead of sitting frozen.
    warp renders in one pass; loop builds a template then the final; cut
    builds a template, one segment PER BAR, then the xfade concat.
    """
    if policy == "cut":
        k = max(1, int(getattr(sy, "BAR_BEATS", 4)))
        bars = max(1, -(-max(0, beat_count - 1) // k))   # ceil
        return bars + 2
    return 2 if policy == "loop" else 1


def build_video(media_path: str, face_sources: list[str], instrument: str,
                out_path: str, uhd: bool = True, progress_cb=print,
                stage_cb=None,
                ref_override: dict | None = None,
                full_song_scenes: bool = False,
                guitar_variant: str | None = None,
                local_director: bool = True,
                cutaway_files: list[str] | None = None,
                cancel_event=None,
                source_performance: bool = False) -> dict:
    """Build from a declared synchronized performance or beat-only reference.

    Both paths analyze the music, run the optional local director, mux the
    selected media's original audio exactly once, and validate final delivery.

    full_song_scenes: retained as a settings/API compatibility name. It now
    stages only a non-performance production-assets manifest; it never asks
    HeyGen to generate hands, fingering, bowing, strumming, or instrument
    geometry and makes no paid call.
    guitar_variant: "acoustic" | "electric" | "bass" (guitar only) — shapes
    prompts and the instrument-focused onset band.
    local_director: default-on, no-API virtual-camera/phrase edit over the
    protected full-song performance. It is independent of the optional paid
    HeyGen scene mode and never gates the core deliverable.
    source_performance: the user explicitly confirms that media_path contains
    the real synchronized performance and that they have permission to use it.
    It must contain video plus audio. Its forward, unit-rate timeline bypasses
    the reference manifest and sync.render entirely.

    ref_override: manifest-shaped dict {"file","stroke_hz","first_stroke_s",
    "strokes_per_beat"} to bypass refs/manifest.json (used by tests)."""
    if not os.path.exists(media_path):
        raise IPlayError(f"Music file not found: {media_path}")
    if instrument not in INSTRUMENTS:
        raise IPlayError(f"Unknown instrument {instrument!r}; want one of {INSTRUMENTS}")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    if cancel_event is not None and cancel_event.is_set():
        raise IPlayCancelled("Render cancelled before media inspection.")
    try:
        media_info = media_tools.probe_media(
            media_path, cancel_event=cancel_event)
        master_audio = media_tools.select_audio_stream(media_info)
    except media_tools.RenderCancelled as exc:
        raise IPlayCancelled(str(exc)) from exc
    except media_tools.MediaValidationError as exc:
        raise IPlayError(f"Could not select a master audio stream: {exc}") from exc

    source_probe = None
    ref = None
    if source_performance:
        source_probe = validate_source_performance_input(
            media_path, audio_ordinal=master_audio["ordinal"],
            probe_info=media_info)
    else:
        ref = ref_override if ref_override is not None else load_manifest(instrument)
        if "file" not in ref or "stroke_hz" not in ref:
            raise IPlayError("reference entry needs at least 'file' and 'stroke_hz'")

    prog = _Progress(stage_cb)

    tmpdir = tempfile.mkdtemp(prefix="iplay_")
    try:
        prog(0.00, "Extracting audio")
        progress_cb(f"[1/5] Extracting audio from {os.path.basename(media_path)}...")
        wav = extract_audio(
            media_path, os.path.join(tmpdir, "audio.wav"),
            audio_ordinal=master_audio["ordinal"],
            log_path=media_tools.stage_log_path(out_path, "analysis"),
            cancel_event=cancel_event)

        prog(0.08, "Analyzing beat grid")
        progress_cb("[2/5] Analyzing beat grid (librosa)...")
        timing = ms.analyze_audio(wav)
        if cancel_event is not None and cancel_event.is_set():
            raise IPlayCancelled("Render cancelled after audio analysis.")
        progress_cb(f"      bpm={timing['bpm']}  duration={timing['duration_s']}s  "
                    f"beats={len(timing['beats'])}")

        source_record = None
        motion_source_tier = "beat-only"
        render_timing = timing
        render_timing["timeline_sample_rate_hz"] = int(
            master_audio.get("sample_rate") or timing.get("sample_rate") or 22050)
        delivery_duration_s = float(timing["duration_s"])
        render_video_ordinal = 0
        render_display_geometry = None
        if source_performance:
            try:
                source_record = performance_tools.build_performance_source_record(
                    media_path, timing, rights_acknowledged=True,
                    probe=source_probe)
            except performance_tools.PerformanceSourceError as exc:
                raise IPlayError(str(exc)) from exc
            motion_source_tier = performance_tools.MOTION_SOURCE_TIER
            delivery_duration_s = float(
                source_record["timeline_mapping"]["duration_s"])
            render_timing = dict(timing)
            render_timing["duration_s"] = delivery_duration_s
            pol = {
                "policy": "source-preserved",
                "reason": ("selected video is the user-declared synchronized "
                           "performance; its identity timeline is authoritative"),
            }
            plan = {
                "policy": "source-preserved",
                "timeline_mapping": source_record["timeline_mapping"],
            }
            render_source = media_path
            render_video_ordinal = int(source_probe["video_stream_ordinal"])
            render_display_geometry = dict(
                source_probe["video_display_geometry"])
            progress_cb(f"[3/5] Policy: {pol['policy']}  "
                        f"(reason: {pol['reason']})")
            progress_cb("[4/5] Preserving the synchronized source performance "
                        "at forward unit rate (no reference retime)...")
        else:
            prog(0.28, "Choosing sync policy")
            pol = choose_policy(timing, instrument)
            progress_cb(f"[3/5] Policy: {pol['policy']}  (reason: {pol['reason']})")
            spb = float(pol.get("strokes_per_beat")
                        or ref.get("strokes_per_beat") or 1.0)

            intermediate = os.path.join(tmpdir, "intermediate.mp4")
            progress_cb(f"[4/5] Retiming reference clip to the beat grid "
                        f"({pol['policy']} policy)...")

            # Retime is the long pole of a local render. sy.render issues a
            # known number of ffmpeg commands for this policy, so counting
            # completions gives real movement instead of a frozen bar.
            retime_prog = prog.slice(0.32, 0.78)
            retime_total = _expected_retime_commands(
                pol["policy"], len(timing.get("beats") or []))
            retime_done = {"n": 0}
            retime_prog(0.0, f"Retiming reference ({pol['policy']})")

            def run_retime_command(command: list[str], stage: str) -> None:
                # sync.py is also a standalone CLI. The application injects
                # this observable/cancellable runner so retime failures survive
                # temp cleanup in a stage log beside the requested output.
                observed = list(command)
                if observed and os.path.basename(observed[0]).lower() in {
                        "ffmpeg", "ffmpeg.exe"}:
                    observed[1:1] = ["-hide_banner", "-nostdin", "-nostats"]
                log_path = media_tools.stage_log_path(out_path, f"retime-{stage}")
                result = media_tools.run_logged(
                    observed, stage=f"retime {stage}", log_path=log_path,
                    cancel_event=cancel_event)
                if result.cancelled:
                    raise IPlayCancelled(media_tools.format_failure(
                        f"Retime {stage}", result))
                if not result.ok:
                    raise IPlayError(media_tools.format_failure(
                        f"Retime {stage}", result))
                media_tools.remove_success_log(result)
                retime_done["n"] += 1
                retime_prog(
                    min(1.0, retime_done["n"] / max(1, retime_total)),
                    f"Retiming reference ({pol['policy']}) - "
                    f"{min(retime_done['n'], retime_total)}/{retime_total} passes")

            plan = sy.render(
                wav, ref["file"], float(ref["stroke_hz"]), intermediate,
                strokes_per_beat=spb,
                ref_first_stroke_s=float(ref.get("first_stroke_s", 0.0)),
                policy=pol["policy"], command_runner=run_retime_command)
            render_source = intermediate
            prog(0.80, "Reference retimed; preparing delivery")

        # The mono WAV exists only for timing analysis (and, on the fallback
        # path, reference retiming). It is never the deliverable soundtrack.
        # The final stage maps media_path once and continuously so original
        # channels/sample rate and musical continuity survive every visual cut.
        local_edit = {"status": "disabled",
                      "detail": "local cinematic edit was turned off"}
        directed_path = (os.path.splitext(os.path.abspath(out_path))[0]
                         + ".local-edit.video-only.mp4")
        director_uhd = bool(uhd)
        uhd_decline_reason = None
        if local_director and uhd:
            preflight_ok, preflight_detail = media_tools.uhd_preflight(
                os.path.dirname(os.path.abspath(out_path)), render_source)
            if not preflight_ok:
                director_uhd = False
                uhd_decline_reason = preflight_detail
                progress_cb(
                    "[local edit] UHD preflight declined the 2160p director; "
                    "rendering one validated 1080p edit for video-copy fallback: "
                    + preflight_detail)
        if local_director:
            try:
                import scenes as sc
                requested_cutaways = (cutaway_files if cutaway_files is not None
                                      else (ref or {}).get("cutaways") or [])
                missing = [p for p in requested_cutaways if not os.path.exists(p)]
                if missing:
                    progress_cb("[local edit] ignoring missing optional cutaway(s): "
                                + ", ".join(os.path.basename(p) for p in missing))
                director_profile = (_source_director_profile(
                    source_probe, uhd=director_uhd,
                    fallback_1080=bool(uhd_decline_reason))
                    if source_performance else {
                        "width": 3840 if director_uhd else 1920,
                        "height": 2160 if director_uhd else 1080,
                        "fps": 30,
                        "performance_video_ordinal": render_video_ordinal,
                    })
                local_edit = sc.render_local_director(
                    render_source, render_timing, directed_path,
                    cutaway_files=[p for p in requested_cutaways
                                   if os.path.exists(p)],
                    instrument=instrument, variant=guitar_variant,
                    motion_source_tier=motion_source_tier,
                    **director_profile,
                    cancel_event=cancel_event,
                    progress_cb=progress_cb)
                render_source = directed_path
                render_video_ordinal = 0
                # The director has already autorotated and normalized the
                # protected source to a square-pixel output raster.
                render_display_geometry = None
            except media_tools.RenderCancelled as exc:
                raise IPlayCancelled(str(exc)) from exc
            except IPlayCancelled:
                raise
            except Exception as exc:
                local_edit = {
                    "status": "fallback",
                    "detail": ("local director failed; the protected "
                               f"performance remains the deliverable: {exc}"),
                }
                if uhd and director_uhd:
                    uhd_decline_reason = (
                        "2160p local director failed; IPlay will not launch a "
                        f"second UHD software encode: {exc}")
                progress_cb(f"[local edit] fallback: {exc}")

        final = _deliver_final(render_source, media_path, out_path,
                               delivery_duration_s, uhd,
                               audio_ordinal=master_audio["ordinal"],
                               video_ordinal=render_video_ordinal,
                               source_display_geometry=render_display_geometry,
                               uhd_decline_reason=uhd_decline_reason,
                               progress_cb=progress_cb,
                               cancel_event=cancel_event)
        uhd_label = final["label"]
        final_info = final["summary"]

        # A completed local edit gets a portable, path-redacted scene manifest
        # beside the final video. The working video-only mezzanine is removed
        # only after the final output has passed probe validation.
        if local_edit.get("status") == "completed":
            manifest = dict(local_edit.get("manifest") or {})
            if source_record is not None:
                manifest["performance_source_provenance"] = source_record
            manifest["audio_master"] = {
                "source": os.path.basename(media_path),
                "continuous": True,
                "analysis_wav_used_in_final": False,
                "output_codec": final_info.get("audio_codec"),
                "channels": final_info.get("audio_channels"),
                "sample_rate": final_info.get("audio_sample_rate"),
                "selected_source_stream": dict(master_audio),
            }
            manifest["video_delivery"] = {
                "selected_source_video_ordinal": (
                    int(source_probe["video_stream_ordinal"])
                    if source_probe is not None else 0),
                "final_video_reencoded": final["video_reencoded_in_final"],
                "master_audio_mux_authority": "iplay",
            }
            master_rate = final_info.get("audio_sample_rate")
            if master_rate:
                for scene in manifest.get("scenes") or []:
                    scene["master_audio_sample_range"] = {
                        "sample_rate_hz": master_rate,
                        "start": round(float(scene["start"]) * master_rate),
                        "end": round(float(scene["end"]) * master_rate),
                    }
            manifest_path = os.path.splitext(out_path)[0] + ".scenes.json"
            with open(manifest_path, "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2)
                fh.write("\n")
            local_edit["manifest_path"] = manifest_path
            local_edit.pop("manifest", None)
            try:
                os.remove(directed_path)
            except OSError:
                pass

        if full_song_scenes:
            face = face_scenes_stage(face_sources, wav, render_timing, out_path,
                                     progress_cb, instrument=instrument,
                                     variant=guitar_variant, tmpdir=tmpdir,
                                     music_src=media_path)
        else:
            face = face_stage(face_sources, out_path, progress_cb,
                              instrument=instrument,
                              audio_dur=delivery_duration_s,
                              tmpdir=tmpdir)
        prog(1.0, "Done")
        progress_cb(f"[face] {face['status']}: {face['detail']}")

        progress_cb(f"Done -> {out_path}  "
                    f"({final_info.get('width')}x{final_info.get('height')}, "
                    f"{final_info.get('duration_s'):.2f}s)")
        return {
            "out": out_path,
            "policy": pol["policy"],
            "reason": pol["reason"],
            "bpm": timing["bpm"],
            "duration_s": delivery_duration_s,
            "uhd": uhd_label,
            "uhd_requested": final["requested_uhd"],
            "uhd_delivered": final["delivered_uhd"],
            "render_fallback": final["fallback"],
            "final_video_reencoded": final["video_reencoded_in_final"],
            "uhd_failure": final["failure"],
            "motion_source_tier": motion_source_tier,
            "motion_accuracy": (source_record["motion_contract"]["accuracy_statement"]
                                if source_record is not None else
                                "Beat-timed reference motion; contacts are not inferred."),
            "source_performance": source_record,
            "local_edit": local_edit,
            "audio_master": {
                "source": os.path.basename(media_path),
                "continuous": True,
                "analysis_wav_used_in_final": False,
                "codec": final_info.get("audio_codec"),
                "channels": final_info.get("audio_channels"),
                "sample_rate": final_info.get("audio_sample_rate"),
                "selected_source_stream": dict(master_audio),
            },
            "face_stage": face,
            "plan": {k: plan[k] for k in ("policy", "warp", "first_beat",
                                           "timeline_mapping")
                     if k in plan},
            "output_width": final_info.get("width"),
            "output_height": final_info.get("height"),
            "output_duration_s": final_info.get("duration_s"),
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("usage: python pipeline.py <music> <instrument> <out.mp4> [photo...]")
        sys.exit(2)
    rep = build_video(sys.argv[1], list(sys.argv[4:]), sys.argv[2], sys.argv[3])
    print(json.dumps(rep, indent=2))
