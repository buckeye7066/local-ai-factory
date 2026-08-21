"""Observable, fail-safe FFmpeg helpers for IPlay.

Long music renders must not disappear behind an empty ``stderr`` string.  This
module keeps a per-stage log beside the requested output, records the exact
argv and Windows return code, probes partial files, and validates a render
before it is promoted to the user's final filename.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import datetime as _dt
from fractions import Fraction
import json
import math
import os
import shutil
import subprocess
import tempfile
import time

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_GIB = 1024 ** 3
_MAX_VIDEO_DIMENSION = 16384
_MAX_VIDEO_PIXELS = 8192 * 8192
_MAX_DISPLAY_ASPECT = Fraction(32, 1)


class MediaValidationError(Exception):
    """A media file is missing, corrupt, or does not match its contract."""


class RenderCancelled(Exception):
    """A user asked IPlay to stop an active media process."""


@dataclass(frozen=True)
class CommandResult:
    command: tuple[str, ...]
    returncode: int | None
    elapsed_s: float
    log_path: str
    tail: str
    launch_error: str | None = None
    cancelled: bool = False

    @property
    def ok(self) -> bool:
        return (self.returncode == 0 and self.launch_error is None
                and not self.cancelled)


def ffmpeg_command(*args: str, loglevel: str = "warning") -> list[str]:
    """A non-interactive FFmpeg argv suitable for a GUI worker process."""
    return ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-nostats",
            "-loglevel", loglevel, *map(str, args)]


def partial_path(out_path: str, stage: str) -> str:
    base, ext = os.path.splitext(os.path.abspath(out_path))
    return f"{base}.{stage}.partial{ext or '.mp4'}"


def stage_log_path(out_path: str, stage: str) -> str:
    base, _ext = os.path.splitext(os.path.abspath(out_path))
    return f"{base}.{stage}.ffmpeg.log"


def _tail(path: str, lines: int = 120) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return "".join(deque(fh, maxlen=lines)).strip()
    except OSError:
        return ""


def run_logged(command: list[str], *, stage: str, log_path: str,
               cancel_event=None, terminate_timeout_s: float = 5.0) -> CommandResult:
    """Run an argv without a shell and retain a bounded diagnostic log.

    Both output streams are drained directly into a file, so a multi-hour UHD
    encode cannot grow Python memory or deadlock on a full pipe.
    """
    command = [str(part) for part in command]
    os.makedirs(os.path.dirname(os.path.abspath(log_path)), exist_ok=True)
    started = time.monotonic()
    returncode: int | None = None
    launch_error: str | None = None
    cancelled = False
    with open(log_path, "w", encoding="utf-8", errors="replace") as log:
        log.write(f"IPlay FFmpeg stage: {stage}\n")
        log.write(f"Started UTC: {_dt.datetime.now(_dt.timezone.utc).isoformat()}\n")
        log.write(f"Command: {subprocess.list2cmdline(command)}\n\n")
        log.flush()
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            log.write("IPlay cancellation was already requested; process not launched.\n")
        else:
            proc = None
            try:
                proc = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=_NO_WINDOW,
                )
                while True:
                    try:
                        returncode = int(proc.wait(timeout=0.2))
                        break
                    except subprocess.TimeoutExpired:
                        if cancel_event is None or not cancel_event.is_set():
                            continue
                        cancelled = True
                        log.write("\nIPlay cancellation requested; terminating process.\n")
                        log.flush()
                        proc.terminate()
                        try:
                            returncode = int(proc.wait(timeout=terminate_timeout_s))
                        except subprocess.TimeoutExpired:
                            log.write("Process did not terminate in time; killing it.\n")
                            log.flush()
                            proc.kill()
                            returncode = int(proc.wait())
                        break
            except OSError as exc:
                launch_error = f"{type(exc).__name__}: {exc}"
                log.write(f"\nIPlay could not launch the process: {launch_error}\n")
            finally:
                if proc is not None and proc.poll() is None:
                    proc.kill()
                    proc.wait()
        elapsed = time.monotonic() - started
        if cancelled and returncode is None:
            code_text = "not launched (cancelled)"
        else:
            code_text = "launch failed" if returncode is None else str(returncode)
        log.write(f"\nFinished after {elapsed:.3f}s; return code: {code_text}\n")
    return CommandResult(tuple(command), returncode, elapsed, log_path,
                         _tail(log_path), launch_error, cancelled)


def probe_media(path: str, *, cancel_event=None, timeout_s: float = 30.0) -> dict:
    """Return FFprobe JSON with a bounded, cancellable subprocess wait."""
    if not os.path.isfile(path) or os.path.getsize(path) <= 0:
        raise MediaValidationError(f"media file is missing or empty: {path}")
    if cancel_event is not None and cancel_event.is_set():
        raise RenderCancelled("Media inspection cancelled before launch.")
    command = ["ffprobe", "-v", "error", "-show_streams", "-show_format",
               "-of", "json", path]
    try:
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_NO_WINDOW,
        )
    except OSError as exc:
        raise MediaValidationError(
            f"could not launch ffprobe for {path}: {exc}") from exc
    started = time.monotonic()
    stdout = stderr = ""
    while True:
        try:
            stdout, stderr = proc.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            if cancel_event is not None and cancel_event.is_set():
                proc.terminate()
                try:
                    proc.communicate(timeout=1.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                raise RenderCancelled("Media inspection cancelled by user.")
            if time.monotonic() - started > float(timeout_s):
                proc.kill()
                proc.communicate()
                raise MediaValidationError(
                    f"ffprobe timed out after {float(timeout_s):.1f}s for {path}")
    if proc.returncode != 0:
        detail = (stderr or stdout or "no ffprobe diagnostic").strip()
        raise MediaValidationError(f"ffprobe rejected {path}: {detail}")
    try:
        return json.loads(stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise MediaValidationError(f"ffprobe returned invalid JSON for {path}: {exc}")


def select_audio_stream(info: dict) -> dict:
    """Select the source's default audio stream, falling back to its first.

    FFmpeg's ``a:0`` stream specifier means the first audio stream, not the
    stream marked ``disposition.default``.  Music containers can carry an
    alternate/commentary stream first, so analysis and final delivery must use
    the same explicit ordinal.
    """
    streams = info.get("streams") or []
    audio = [(ordinal, stream) for ordinal, stream in enumerate(
        stream for stream in streams if stream.get("codec_type") == "audio")]
    if not audio:
        raise MediaValidationError("source has no audio stream")
    ordinal, stream = next(
        ((ordinal, stream) for ordinal, stream in audio
         if int((stream.get("disposition") or {}).get("default") or 0) == 1),
        audio[0],
    )
    return {
        "ordinal": ordinal,
        "stream_index": stream.get("index"),
        "default": bool(int((stream.get("disposition") or {}).get("default") or 0)),
        "codec": stream.get("codec_name"),
        "channels": stream.get("channels"),
        "sample_rate": (int(stream["sample_rate"])
                        if str(stream.get("sample_rate", "")).isdigit()
                        else None),
        "language": (stream.get("tags") or {}).get("language"),
    }


def video_frame_rate(stream: dict) -> dict | None:
    """Return a positive, reduced frame-rate rational without rounding it."""
    for key in ("avg_frame_rate", "r_frame_rate"):
        try:
            value = Fraction(str(stream.get(key)))
        except (ValueError, ZeroDivisionError):
            continue
        if value > 0:
            return {
                "rational": f"{value.numerator}/{value.denominator}",
                "numerator": value.numerator,
                "denominator": value.denominator,
                "fps": float(value),
                "source_field": key,
            }
    return None


def video_stream_at(info: dict, ordinal: int) -> dict:
    """Resolve an FFmpeg ``v:N`` ordinal against every video stream."""
    videos = [stream for stream in (info.get("streams") or [])
              if stream.get("codec_type") == "video"]
    try:
        return videos[int(ordinal)]
    except (IndexError, TypeError, ValueError) as exc:
        raise MediaValidationError(
            f"selected video ordinal {ordinal!r} is unavailable; the file "
            f"contains {len(videos)} video stream(s)") from exc


def stream_duration_s(stream: dict) -> float | None:
    """Read one independently reported stream duration."""
    try:
        value = float(stream.get("duration"))
        if math.isfinite(value) and value >= 0:
            return value
    except (TypeError, ValueError):
        pass
    try:
        ticks = int(stream.get("duration_ts"))
        numerator, denominator = str(stream.get("time_base")).split("/", 1)
        value = ticks * int(numerator) / int(denominator)
        if math.isfinite(value) and value >= 0:
            return value
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    return None


def _aspect_fraction(value) -> Fraction | None:
    """Parse FFprobe's ``N:D``/``N/D`` aspect fields when they are usable."""
    text = str(value or "").strip()
    if not text or text.upper() in {"N/A", "UNKNOWN"}:
        return None
    if len(text) > 64:
        raise MediaValidationError("video aspect metadata is unreasonably long")
    try:
        ratio = Fraction(text.replace(":", "/"))
    except (ValueError, ZeroDivisionError):
        return None
    return ratio if ratio > 0 else None


def _even_raster(value: Fraction) -> int:
    """Round a positive display extent up to a yuv420p-safe even integer."""
    if value <= 0:
        raise MediaValidationError("video display extent must be positive")
    pixels = math.ceil(value)
    return max(2, pixels + (pixels % 2))


def video_display_geometry(stream: dict) -> dict:
    """Resolve encoded pixels, pixel aspect, and rotation into one display raster.

    FFmpeg autorotates display-matrix video while decoding, and ``setsar=1``
    discards non-square-pixel metadata.  A source-preserved render therefore
    needs an explicit square-pixel target representing the same display shape.
    """
    try:
        encoded_width = int(stream.get("width"))
        encoded_height = int(stream.get("height"))
    except (TypeError, ValueError) as exc:
        raise MediaValidationError(
            "selected video has no provable encoded dimensions") from exc
    if encoded_width <= 0 or encoded_height <= 0:
        raise MediaValidationError(
            "selected video has no provable encoded dimensions")
    if (max(encoded_width, encoded_height) > _MAX_VIDEO_DIMENSION
            or encoded_width * encoded_height > _MAX_VIDEO_PIXELS):
        raise MediaValidationError(
            "selected video's encoded raster exceeds IPlay's supported bounds")

    reported_sar = stream.get("sample_aspect_ratio")
    reported_dar = stream.get("display_aspect_ratio")
    sar = _aspect_fraction(reported_sar)
    dar = _aspect_fraction(reported_dar)
    if sar is not None:
        sar_source = "sample_aspect_ratio"
    elif dar is not None:
        sar = dar * Fraction(encoded_height, encoded_width)
        sar_source = "derived_from_display_aspect_ratio"
    else:
        raise MediaValidationError(
            "selected video has no provable sample or display aspect ratio")

    encoded_dar = Fraction(encoded_width, encoded_height) * sar
    if max(encoded_dar, 1 / encoded_dar) > _MAX_DISPLAY_ASPECT:
        raise MediaValidationError(
            "selected video's display aspect exceeds IPlay's supported 32:1 bound")
    if dar is not None:
        # FFprobe can reduce or lightly round container DAR metadata. Reject a
        # material conflict because choosing either value could visibly distort
        # a performance while still claiming source preservation.
        relative_error = abs(float(encoded_dar / dar) - 1.0)
        if relative_error > 0.01:
            raise MediaValidationError(
                "selected video's sample and display aspect metadata conflict")

    rotations: list[tuple[str, float]] = []
    for side_data in stream.get("side_data_list") or []:
        if "rotation" not in side_data:
            continue
        try:
            value = float(side_data["rotation"])
        except (TypeError, ValueError) as exc:
            raise MediaValidationError(
                "selected video has invalid display-matrix rotation metadata") from exc
        rotations.append(("display_matrix", value))
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        try:
            value = float(tags["rotate"])
        except (TypeError, ValueError) as exc:
            raise MediaValidationError(
                "selected video has invalid rotate metadata") from exc
        rotations.append(("rotate_tag", value))

    normalized_rotations: list[tuple[str, int]] = []
    for source, value in rotations:
        if not math.isfinite(value):
            raise MediaValidationError(
                "selected video has non-finite rotation metadata")
        normalized = value % 360.0
        right_angle = (round(normalized / 90.0) * 90) % 360
        distance = min(abs(normalized - right_angle),
                       abs(normalized - right_angle + 360.0),
                       abs(normalized - right_angle - 360.0))
        if distance > 0.01:
            raise MediaValidationError(
                "source-preserved mode requires a right-angle video rotation")
        normalized_rotations.append((source, int(right_angle)))
    distinct_rotations = {value for _source, value in normalized_rotations}
    if len(distinct_rotations) > 1:
        raise MediaValidationError(
            "selected video has conflicting rotation metadata")
    rotation_degrees = next(iter(distinct_rotations), 0)
    rotation_source = (normalized_rotations[0][0]
                       if normalized_rotations else "none")

    # Avoid reducing either encoded axis while converting non-square pixels to
    # square pixels. This keeps native detail and gives x264 even yuv420p sizes.
    if sar >= 1:
        unrotated_width = _even_raster(Fraction(encoded_width) * sar)
        unrotated_height = _even_raster(Fraction(encoded_height))
    else:
        unrotated_width = _even_raster(Fraction(encoded_width))
        unrotated_height = _even_raster(Fraction(encoded_height) / sar)
    if (max(unrotated_width, unrotated_height) > _MAX_VIDEO_DIMENSION
            or unrotated_width * unrotated_height > _MAX_VIDEO_PIXELS):
        raise MediaValidationError(
            "selected video's square-pixel display raster exceeds IPlay's "
            "supported bounds")
    display_dar = encoded_dar
    if rotation_degrees in {90, 270}:
        display_width, display_height = unrotated_height, unrotated_width
        display_dar = 1 / display_dar
    else:
        display_width, display_height = unrotated_width, unrotated_height

    raster_dar = Fraction(display_width, display_height)
    raster_error = abs(float(raster_dar / display_dar) - 1.0)
    if raster_error > 0.01:
        raise MediaValidationError(
            "selected video's even square-pixel raster would distort its "
            "display aspect by more than one percent")
    return {
        "encoded_width": encoded_width,
        "encoded_height": encoded_height,
        "reported_sample_aspect_ratio": reported_sar,
        "sample_aspect_ratio": f"{sar.numerator}/{sar.denominator}",
        "sample_aspect_ratio_source": sar_source,
        "reported_display_aspect_ratio": reported_dar,
        "encoded_display_aspect_ratio": (
            f"{encoded_dar.numerator}/{encoded_dar.denominator}"),
        "rotation_degrees": rotation_degrees,
        "rotation_source": rotation_source,
        "display_width": display_width,
        "display_height": display_height,
        "display_aspect_ratio": (
            f"{display_dar.numerator}/{display_dar.denominator}"),
        "display_raster_aspect_ratio": (
            f"{raster_dar.numerator}/{raster_dar.denominator}"),
        "display_raster_aspect_error": raster_error,
        "output_sample_aspect_ratio": "1/1",
    }


def select_video_stream(info: dict) -> dict:
    """Select one non-cover timeline video and fail closed on ambiguity.

    The returned ordinal is among *all* video streams, exactly matching
    FFmpeg's ``0:v:N`` syntax even when attached cover art appears first.
    """
    all_videos = [(ordinal, stream) for ordinal, stream in enumerate(
        stream for stream in (info.get("streams") or [])
        if stream.get("codec_type") == "video")]
    candidates = [
        (ordinal, stream) for ordinal, stream in all_videos
        if int((stream.get("disposition") or {}).get("attached_pic") or 0) != 1
    ]
    if not candidates:
        raise MediaValidationError(
            "source has no timeline video stream (attached cover art does not count)")
    if len(candidates) == 1:
        ordinal, stream = candidates[0]
    else:
        defaults = [
            (ordinal, stream) for ordinal, stream in candidates
            if int((stream.get("disposition") or {}).get("default") or 0) == 1
        ]
        if len(defaults) != 1:
            raise MediaValidationError(
                "source has multiple timeline video streams without one unique "
                "default; source-preserved mode cannot infer the intended performance")
        ordinal, stream = defaults[0]
    rate = video_frame_rate(stream)
    return {
        "ordinal": ordinal,
        "stream_index": stream.get("index"),
        "default": bool(int((stream.get("disposition") or {}).get("default") or 0)),
        "codec": stream.get("codec_name"),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "frame_rate": rate,
    }


def summarize_probe(info: dict) -> dict:
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    try:
        duration = float((info.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0

    def stream_duration(stream: dict) -> float | None:
        try:
            value = float(stream.get("duration"))
            if value >= 0:
                return round(value, 3)
        except (TypeError, ValueError):
            pass
        try:
            ticks = int(stream.get("duration_ts"))
            numerator, denominator = str(stream.get("time_base")).split("/", 1)
            value = ticks * int(numerator) / int(denominator)
            if value >= 0:
                return round(value, 3)
        except (TypeError, ValueError, ZeroDivisionError):
            pass
        return None

    return {
        "duration_s": round(duration, 3),
        "video_duration_s": stream_duration(video),
        "audio_duration_s": stream_duration(audio),
        "width": video.get("width"),
        "height": video.get("height"),
        "video_codec": video.get("codec_name"),
        "has_audio": bool(audio),
        "audio_codec": audio.get("codec_name"),
        "audio_channels": audio.get("channels"),
        "audio_sample_rate": (int(audio["sample_rate"])
                              if str(audio.get("sample_rate", "")).isdigit()
                              else None),
    }


def validate_media(path: str, *, expected_duration_s: float,
                   width: int | None = None, height: int | None = None,
                   require_audio: bool = True,
                   duration_tolerance_s: float = 1.0) -> dict:
    info = probe_media(path)
    summary = summarize_probe(info)
    if not summary["width"] or not summary["height"]:
        raise MediaValidationError("render has no decodable video stream")
    if require_audio and not summary["has_audio"]:
        raise MediaValidationError("render has no audio stream")
    if width is not None and summary["width"] != width:
        raise MediaValidationError(
            f"render width is {summary['width']}, expected {width}")
    if height is not None and summary["height"] != height:
        raise MediaValidationError(
            f"render height is {summary['height']}, expected {height}")
    if abs(summary["duration_s"] - float(expected_duration_s)) > duration_tolerance_s:
        raise MediaValidationError(
            f"render duration is {summary['duration_s']:.3f}s, expected "
            f"{float(expected_duration_s):.3f}s ± {duration_tolerance_s:.3f}s")
    # Container duration is the longest stream. A full-length soundtrack can
    # therefore hide a video stream that stopped early after an encoder crash
    # or a too-short source. Require each delivered stream to cover the target
    # whenever FFprobe exposes its own duration.
    visual_duration = summary.get("video_duration_s")
    if (visual_duration is not None
            and visual_duration < float(expected_duration_s) - duration_tolerance_s):
        raise MediaValidationError(
            f"video stream covers only {visual_duration:.3f}s, expected at least "
            f"{float(expected_duration_s) - duration_tolerance_s:.3f}s")
    audio_duration = summary.get("audio_duration_s")
    if (require_audio and audio_duration is not None
            and audio_duration < float(expected_duration_s) - duration_tolerance_s):
        raise MediaValidationError(
            f"audio stream covers only {audio_duration:.3f}s, expected at least "
            f"{float(expected_duration_s) - duration_tolerance_s:.3f}s")
    return summary


def promote_partial(partial: str, final: str) -> None:
    """Atomically publish a validated sibling partial file."""
    os.replace(os.path.abspath(partial), os.path.abspath(final))


def remove_success_log(result: CommandResult) -> None:
    if result.ok:
        try:
            os.remove(result.log_path)
        except OSError:
            pass


def format_failure(stage: str, result: CommandResult,
                   partial: str | None = None,
                   validation_error: Exception | None = None) -> str:
    if result.cancelled:
        suffix = ("before launch" if result.returncode is None
                  else f"with process exit {result.returncode}")
        code = f"cancelled by user {suffix}"
    elif result.returncode is None:
        code = "process did not launch"
    else:
        code = (f"exit {result.returncode} "
                f"(Windows status 0x{result.returncode & 0xffffffff:08X})")
    pieces = [f"{stage} failed: {code} after {result.elapsed_s:.1f}s.",
              f"Diagnostic log: {result.log_path}"]
    if partial and os.path.exists(partial):
        try:
            pieces.append(f"Partial output preserved: {partial} "
                          f"({summarize_probe(probe_media(partial))})")
        except MediaValidationError as exc:
            pieces.append(f"Partial output preserved but is not decodable: "
                          f"{partial} ({exc})")
    if validation_error is not None:
        pieces.append(f"Validation: {validation_error}")
    if result.tail:
        pieces.append("Last FFmpeg log lines:\n" + result.tail)
    elif result.launch_error:
        pieces.append(result.launch_error)
    else:
        pieces.append("FFmpeg produced no diagnostic output; an OS-level "
                      "termination or suppressed logger is possible.")
    return "\n".join(pieces)


def uhd_preflight(output_dir: str, intermediate_path: str) -> tuple[bool, str]:
    """Cheap checks before committing hours to a 2160p software encode."""
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        missing = ", ".join(name for name, value in
                            (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)) if not value)
        return False, f"missing required executable(s): {missing}"
    enc = subprocess.run(
        [ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True,
        encoding="utf-8", errors="replace", creationflags=_NO_WINDOW)
    if enc.returncode != 0 or "libx264" not in (enc.stdout + enc.stderr):
        return False, "this FFmpeg build does not advertise the libx264 encoder"
    try:
        os.makedirs(output_dir, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".iplay_write_test_",
                                         dir=output_dir, delete=True):
            pass
    except OSError as exc:
        return False, f"output directory is not writable: {exc}"
    try:
        free = shutil.disk_usage(output_dir).free
        source_size = os.path.getsize(intermediate_path)
        required = max(2 * _GIB, 2 * source_size + 512 * 1024 ** 2)
        if free < required:
            return False, (f"only {free / _GIB:.2f} GiB free; UHD preflight "
                           f"requires at least {required / _GIB:.2f} GiB")
    except OSError as exc:
        return False, f"could not measure output-disk capacity: {exc}"
    return True, "libx264 available; destination writable; disk reserve available"
