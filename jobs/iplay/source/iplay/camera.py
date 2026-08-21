"""IPlay webcam capture -- DirectShow through ffmpeg, no extra Python deps.

ffmpeg is already a hard dependency of the pipeline, so recording goes through
it rather than pulling in OpenCV. One process serves BOTH the recorded file and
the live preview: Windows DirectShow devices are usually exclusive, so opening
the camera twice (once to record, once to preview) fails. ffmpeg supports
multiple outputs from one input, so we write the mp4 and simultaneously emit
small rgb24 frames on stdout for the GUI to draw.

HeyGen constrains what is usable as avatar footage, and those limits drive the
encoder settings here:
  * training footage must be 15-600 s
  * the asset upload endpoint caps at 32 MB
So the bitrate is chosen from the requested duration to land under ~26 MB.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading

# HeyGen limits (see pipeline.face_stage / developers.heygen.com)
MIN_FOOTAGE_S = 15
MAX_FOOTAGE_S = 600        # HeyGen's limit for footage you supply as a file
MAX_UPLOAD_MB = 32
_TARGET_MB = 26.0          # leave headroom under the 32 MB cap
_MAX_VBR_K = 3000
_MIN_VBR_K = 1200          # below this, 720p footage is too mushy to train on

# The RECORDER stops well short of MAX_FOOTAGE_S. Fitting 600 s into 32 MB
# would need ~360 kbps, which is useless as training footage -- so rather than
# silently recording something unusable, long durations are refused outright.
# A pre-recorded file may still run to MAX_FOOTAGE_S if it is already small
# enough; that path is governed by check_footage(), not by this cap.
MAX_RECORD_S = 180

PREVIEW_W, PREVIEW_H = 320, 180
PREVIEW_FPS = 10
TEST_PATTERN = "__lavfi_testsrc__"   # synthetic source, for tests without a camera

_DEVICE_RE = re.compile(r'"([^"]+)"\s+\((video|audio)\)')
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class CameraError(Exception):
    """Capture failure with a user-readable message."""


def _require_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise CameraError("ffmpeg was not found on PATH — it is required to "
                          "record from the camera.")


def list_devices(kind: str = "video") -> list[str]:
    """DirectShow device names, e.g. ['HP Wide Vision HD Camera'].

    ffmpeg reports devices on stderr and always exits non-zero for this probe
    (there is no real input), so the exit code is deliberately ignored.
    """
    _require_ffmpeg()
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow",
         "-i", "dummy"],
        capture_output=True, text=True, creationflags=_NO_WINDOW)
    out = []
    for name, dev_kind in _DEVICE_RE.findall((proc.stderr or "") + (proc.stdout or "")):
        if dev_kind == kind and name not in out:
            out.append(name)
    return out


def list_cameras() -> list[str]:
    return list_devices("video")


def list_microphones() -> list[str]:
    return list_devices("audio")


def default_camera() -> str | None:
    """First real camera, preferring physical devices over virtual ones."""
    cams = list_cameras()
    real = [c for c in cams if "virtual" not in c.lower()]
    return (real or cams or [None])[0]


def bitrate_for(duration_s: float) -> int:
    """Video kbps that keeps `duration_s` of footage under ~26 MB."""
    if duration_s <= 0:
        return _MAX_VBR_K
    kbps = int((_TARGET_MB * 1024 * 1024 * 8) / duration_s / 1000)
    return max(_MIN_VBR_K, min(_MAX_VBR_K, kbps))


def _input_args(camera: str, mic: str | None) -> list[str]:
    if camera == TEST_PATTERN:
        # Synthetic colour bars + tone, so the recorder is testable on a
        # machine with no camera (and without filming anyone).
        # -re is essential: without it lavfi emits frames as fast as the CPU
        # allows, so a "5 second" capture yields ~30 s of footage and any
        # timing behaviour under test is measured against a fiction. A real
        # dshow device is inherently real-time and needs no such flag.
        args = ["-re", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30"]
        if mic:
            args += ["-re", "-f", "lavfi",
                     "-i", "sine=frequency=440:sample_rate=44100"]
        return args
    src = f"video={camera}"
    if mic:
        src += f":audio={mic}"
    return ["-f", "dshow", "-rtbufsize", "512M", "-i", src]


def record(camera: str, out_path: str, duration_s: int, mic: str | None = None,
           preview_cb=None, progress_cb=print,
           stop_event: threading.Event | None = None) -> dict:
    """Record `duration_s` seconds from `camera` to `out_path` (H.264 mp4).

    preview_cb(rgb_bytes, width, height) is called ~PREVIEW_FPS times a second
    with a PREVIEW_W x PREVIEW_H rgb24 frame. It runs on the CALLING thread, so
    a Tk caller must marshal to the UI thread itself.

    stop_event, when set, ends the recording early by asking ffmpeg to quit
    cleanly ('q' on stdin) so the mp4 is still finalised with a valid moov atom
    -- killing the process would leave an unplayable file.

    Returns {path, duration_s, size_mb, width, height, truncated}.
    """
    _require_ffmpeg()
    if duration_s <= 0:
        raise CameraError("Recording duration must be positive.")
    if duration_s > MAX_RECORD_S:
        raise CameraError(
            f"{duration_s}s is longer than IPlay records ({MAX_RECORD_S}s max).\n\n"
            f"The optional-identity asset budget is {MAX_UPLOAD_MB} MB, and "
            "fitting a longer clip under that would drop the bitrate too far. "
            "Use 30–60s of steady, well-lit footage instead.")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)

    # lavfi's synthetic audio is a second input; a dshow mic rides on input 0.
    test_mode = camera == TEST_PATTERN
    amap = "1:a:0" if (test_mode and mic) else "0:a:0"
    vbr = bitrate_for(duration_s)
    dur = str(duration_s)

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    cmd += _input_args(camera, mic)
    # --- output 1: the recording ---
    cmd += ["-t", dur, "-map", "0:v:0"]
    if mic:
        cmd += ["-map", amap]
    cmd += ["-vf", "scale='min(1280,iw)':-2",
            "-c:v", "libx264", "-preset", "veryfast", "-b:v", f"{vbr}k",
            "-maxrate", f"{vbr}k", "-bufsize", f"{vbr * 2}k",
            "-pix_fmt", "yuv420p", "-r", "30"]
    if mic:
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += ["-movflags", "+faststart", out_path]
    # --- output 2: preview frames on stdout ---
    # Letterbox to an EXACT size so the reader can slice fixed-length frames;
    # scale=W:-2 alone would vary with the camera's aspect ratio.
    cmd += ["-t", dur, "-map", "0:v:0",
            "-vf", f"scale={PREVIEW_W}:{PREVIEW_H}:force_original_aspect_ratio"
                   f"=decrease,pad={PREVIEW_W}:{PREVIEW_H}:(ow-iw)/2:(oh-ih)/2",
            "-r", str(PREVIEW_FPS), "-f", "rawvideo", "-pix_fmt", "rgb24",
            "pipe:1"]

    progress_cb(f"[cam] recording {duration_s}s from {camera!r}"
                + (f" + mic {mic!r}" if mic else " (no audio)")
                + f" at {vbr}k")

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stdin=subprocess.PIPE,
                            stderr=subprocess.PIPE, creationflags=_NO_WINDOW)
    err_chunks: list[bytes] = []
    # stderr MUST be drained concurrently: a full pipe buffer would deadlock
    # ffmpeg while we sit blocked reading stdout.
    drain = threading.Thread(
        target=lambda: err_chunks.append(proc.stderr.read() or b""), daemon=True)
    drain.start()

    # Do not rely on the preview reader returning before a stop request can be
    # observed. A stalled DirectShow device can block stdout indefinitely; this
    # watchdog asks FFmpeg to finalize, then terminates/kills it if necessary.
    def stop_watchdog():
        if stop_event is None:
            return
        while proc.poll() is None:
            if stop_event.wait(0.2):
                break
        if proc.poll() is not None:
            return
        try:
            proc.stdin.write(b"q")
            proc.stdin.flush()
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    watchdog = threading.Thread(target=stop_watchdog, daemon=True)
    watchdog.start()

    frame_bytes = PREVIEW_W * PREVIEW_H * 3
    frames = 0
    stopped_early = False
    try:
        while True:
            if stop_event is not None and stop_event.is_set():
                stopped_early = True
            # Accumulate short reads until a full frame is available; a short
            # read is only true EOF when read() returns empty bytes.
            buf = b""
            eof = False
            while len(buf) < frame_bytes:
                chunk = proc.stdout.read(frame_bytes - len(buf))
                if not chunk:
                    eof = True
                    break
                buf += chunk
            if eof or len(buf) < frame_bytes:
                break
            frames += 1
            if preview_cb is not None:
                try:
                    preview_cb(buf, PREVIEW_W, PREVIEW_H)
                except Exception:
                    pass  # a failing preview must never abort the recording
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        drain.join(timeout=5)
        watchdog.join(timeout=1)

    stderr = (b"".join(err_chunks)).decode("utf-8", "replace").strip()
    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
        raise CameraError(
            f"Recording produced no usable file.\n\n{stderr or 'no ffmpeg error output'}"
            + "\n\nIf another app (Teams, Zoom, the Camera app) is using the "
              "webcam, close it and try again — DirectShow devices are exclusive.")

    info = _probe(out_path)
    size_mb = round(os.path.getsize(out_path) / 1048576, 2)
    progress_cb(f"[cam] captured {info['duration_s']:.1f}s, {size_mb} MB, "
                f"{info['width']}x{info['height']} ({frames} preview frames)")
    return {"path": out_path, "duration_s": info["duration_s"],
            "size_mb": size_mb, "width": info["width"],
            "height": info["height"], "truncated": stopped_early}


def _probe(path: str) -> dict:
    """JSON, not csv: csv output would force us to infer which number is which
    from ffprobe's section ordering, which is not contractual."""
    try:
        raw = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "format=duration:stream=width,height",
             "-of", "json", path],
            text=True, creationflags=_NO_WINDOW)
        data = json.loads(raw)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return {"duration_s": 0.0, "width": None, "height": None}
    st = (data.get("streams") or [{}])[0]
    try:
        dur = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        dur = 0.0
    return {"duration_s": dur, "width": st.get("width"), "height": st.get("height")}


def check_footage(path: str) -> tuple[bool, str]:
    """Is `path` usable as HeyGen avatar footage? -> (ok, human message)."""
    if not os.path.exists(path):
        return False, f"File not found: {path}"
    size_mb = os.path.getsize(path) / 1048576
    info = _probe(path)
    dur = info["duration_s"]
    if size_mb > MAX_UPLOAD_MB:
        return False, (f"{size_mb:.1f} MB exceeds HeyGen's {MAX_UPLOAD_MB} MB "
                       "upload limit — trim it or re-encode smaller.")
    if dur and dur < MIN_FOOTAGE_S:
        return False, (f"{dur:.1f}s is shorter than HeyGen's {MIN_FOOTAGE_S}s "
                       "minimum for avatar footage.")
    if dur and dur > MAX_FOOTAGE_S:
        return False, (f"{dur:.1f}s exceeds HeyGen's {MAX_FOOTAGE_S}s maximum "
                       "for avatar footage.")
    return True, (f"{dur:.1f}s, {size_mb:.1f} MB, "
                  f"{info['width']}x{info['height']} — OK")


if __name__ == "__main__":
    import sys
    print("cameras   :", list_cameras())
    print("microphones:", list_microphones())
    print("default   :", default_camera())
    if len(sys.argv) > 1 and sys.argv[1] == "--record":
        cam = sys.argv[2] if len(sys.argv) > 2 else default_camera()
        secs = int(sys.argv[3]) if len(sys.argv) > 3 else 16
        rep = record(cam, os.path.join(os.getcwd(), "camera_test.mp4"), secs)
        print(rep)
        print(check_footage(rep["path"]))
