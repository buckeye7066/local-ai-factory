"""IPlay YouTube adapter -- pull YouTube videos into a local library that the
app's Browse dialog can pick from.

No GUI imports here: every function is callable from tests or the CLI.

Two halves:
  download()      URL -> file on disk (highest quality by default), plus a
                  <base>.info.json sidecar so the library never has to guess
                  a title or re-probe the file.
  list_library()  scan the library dir (everything) + extra dirs such as
                  ~/Downloads (only files that look like YouTube downloads)
                  and return entries the GUI can render.

pipeline is imported for AUDIO_EXTS/VIDEO_EXTS and the settings helpers so
there is exactly ONE definition of "what counts as media" and one allowlisted
writer for local YouTube preferences.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import pipeline  # noqa: E402


class YTError(Exception):
    """Download failure with a user-readable message."""


# --------------------------------------------------------------------------- #
# quality presets
# --------------------------------------------------------------------------- #
# "bv*+ba/b" = best video stream + best audio stream, falling back to the best
# pre-muxed file. This is what actually reaches 1440p/2160p: YouTube only
# serves those as separate DASH streams, and it caps the pre-muxed ("b") and
# H.264 ladders at 1080p. So "highest quality allowed" REQUIRES the merge --
# which is why ffmpeg is a hard dependency of this adapter.
#
# "best" vs "best_bitrate" is a REAL fork, not a cosmetic one. At the same
# 1080p, YouTube commonly offers e.g. AV1 @ 728k, VP9 @ 1061k and H.264 @
# 1519k. yt-dlp's default sort ranks codec efficiency above bitrate, so
# plain "bv*+ba/b" picks the AV1 -- smallest file, nominally equivalent
# quality. Sorting by "res,br" instead picks the fattest stream, which keeps
# more real detail through a downstream re-encode (IPlay re-encodes to x264
# crf18 on the UHD path) and decodes far faster in an ffmpeg filtergraph.
# Every video preset leads with "bv+ba" -- video-ONLY plus audio-only, picked
# and merged independently. The "bv*" spelling (muxed allowed) is only a
# fallback: sorting by bitrate with bv* lets a fat pre-muxed HLS stream win
# the whole selection, which silently surrenders control of the audio track.
# That is the wrong trade here -- extract_audio discards the video, so audio
# is the payload. Verified 2026-08-04: bv* + sort(res,br) chose HLS fmt 96
# (abr unknown); bv + sort(res,br) chooses 137+251 as intended.
QUALITY = {
    "best": {
        "label": "Best available (top res, efficient codec - smallest file)",
        "format": "bv+ba/bv*+ba/b",
        "sort": None,
        "merge": "mp4",
    },
    "best_bitrate": {
        "label": "Highest bitrate (top res, fattest streams - best for re-encode)",
        "format": "bv+ba/bv*+ba/b",
        "sort": ["res", "br"],
        "merge": "mp4",
    },
    "best_mp4": {
        "label": "Best H.264 MP4 (max 1080p, plays everywhere)",
        # avc1 = H.264, mp4a = AAC -- the combination every player and NLE
        # accepts. Fallbacks keep this from failing outright on a video with
        # no H.264 ladder.
        "format": ("bv[vcodec^=avc1]+ba[acodec^=mp4a]/"
                   "b[ext=mp4]/bv+ba/b"),
        "sort": ["res", "br"],
        "merge": "mp4",
    },
    "audio": {
        "label": "Audio only (best, no video)",
        "format": "ba/b",
        "sort": ["abr"],
        "merge": None,
    },
}
DEFAULT_QUALITY = "best_bitrate"

# Browsers yt-dlp can lift cookies from. Cookies matter here for a specific
# reason: a YouTube Premium account is served the "1080p Premium" enhanced-
# bitrate ladder, and members-only / age-gated videos need a signed-in
# session. Without cookies you silently get the ordinary public ladder.
COOKIE_BROWSERS = ("none", "chrome", "edge", "firefox", "brave", "opera", "vivaldi")

_YT_HOSTS = ("youtube.com", "youtu.be", "youtube-nocookie.com", "music.youtube.com")
# yt-dlp names files "<title> [<id>].<ext>"; YouTube ids are 11 chars of
# [A-Za-z0-9_-]. Used to spot YouTube downloads sitting in ~/Downloads.
_YT_ID_RE = re.compile(r"\[([0-9A-Za-z_-]{11})\](?=\.[^.]+$)")
_SKIP_EXTS = {".part", ".ytdl", ".temp", ".json", ".webp", ".jpg", ".png", ".srt", ".vtt"}


def is_youtube_url(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t.startswith(("http://", "https://", "www.")):
        return False
    return any(h in t for h in _YT_HOSTS)


# --------------------------------------------------------------------------- #
# settings / locations
# --------------------------------------------------------------------------- #

def _set_setting(key: str, value) -> None:
    """Read-modify-write so one YouTube preference preserves the others."""
    s = pipeline.load_settings()
    s[key] = value
    pipeline.save_settings(s)


def library_dir() -> str:
    """Where downloads land. Same G:-drive guard as the app's output dir --
    the Videos shell folder on this machine can redirect to a failing G:."""
    d = pipeline.load_settings().get("youtube_dir")
    if not d:
        d = pipeline.default_videos_dir("IPlay", "youtube")
    return d


def scan_dirs() -> list[str]:
    """Library dir first, then extra dirs to sweep for stray YouTube files."""
    extra = pipeline.load_settings().get("youtube_scan_dirs")
    if extra is None:
        extra = [os.path.join(os.path.expanduser("~"), "Downloads")]
    out: list[str] = []
    seen: set[str] = set()
    for d in [library_dir()] + list(extra):
        key = os.path.normcase(os.path.abspath(d))
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def get_quality() -> str:
    q = pipeline.load_settings().get("youtube_quality", DEFAULT_QUALITY)
    return q if q in QUALITY else DEFAULT_QUALITY


def set_quality(q: str) -> None:
    _set_setting("youtube_quality", q if q in QUALITY else DEFAULT_QUALITY)


def get_cookie_browser() -> str:
    c = pipeline.load_settings().get("youtube_cookies_browser", "none")
    return c if c in COOKIE_BROWSERS else "none"


def set_cookie_browser(c: str) -> None:
    _set_setting("youtube_cookies_browser", c if c in COOKIE_BROWSERS else "none")


# --------------------------------------------------------------------------- #
# probing
# --------------------------------------------------------------------------- #

def probe(path: str) -> dict:
    """ffprobe -> {duration_s, width, height, vcodec, acodec}. Tolerant: an
    audio-only file has no video stream, and a missing/failing ffprobe must
    not break the library listing."""
    out: dict = {"duration_s": None, "width": None, "height": None,
                 "vcodec": None, "acodec": None}
    try:
        raw = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=codec_type,codec_name,width,height",
             "-of", "json", path],
            text=True, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        data = json.loads(raw)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return out
    try:
        out["duration_s"] = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        pass
    for st in data.get("streams") or []:
        if st.get("codec_type") == "video" and out["vcodec"] is None:
            # Skip embedded cover art -- yt-dlp's thumbnail lands as a png
            # "video" stream and would otherwise report as the resolution.
            if st.get("codec_name") in ("png", "mjpeg", "bmp"):
                continue
            out["vcodec"] = st.get("codec_name")
            out["width"] = st.get("width")
            out["height"] = st.get("height")
        elif st.get("codec_type") == "audio" and out["acodec"] is None:
            out["acodec"] = st.get("codec_name")
    return out


# --------------------------------------------------------------------------- #
# download
# --------------------------------------------------------------------------- #

class _Logger:
    """yt-dlp logger -> the app's log pane. debug() is the firehose (every
    line yt-dlp would print); only warnings and errors are worth surfacing."""

    def __init__(self, cb):
        self.cb = cb

    def debug(self, msg):
        if msg.startswith("[download] Destination:") or "has already been downloaded" in msg:
            self.cb("[yt] " + msg.strip())

    def info(self, msg):
        pass

    def warning(self, msg):
        self.cb("[yt] warning: " + str(msg).strip())

    def error(self, msg):
        self.cb("[yt] ERROR: " + str(msg).strip())


def _progress_hook(progress_cb):
    """Throttle to one line per 10% -- a raw hook fires per chunk and would
    flood the Text widget (and pin the Tk main thread through .after)."""
    state = {"mark": -1}

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            got = d.get("downloaded_bytes") or 0
            if not total:
                return
            pct = int(got * 100 / total)
            if pct >= state["mark"] + 10:
                state["mark"] = pct - (pct % 10)
                progress_cb(f"[yt]   {pct:3d}%   "
                            f"{got / 1048576:.1f} / {total / 1048576:.1f} MB")
        elif d.get("status") == "finished":
            state["mark"] = -1
            progress_cb("[yt]   stream complete, merging...")

    return hook


def download(url: str, quality: str = None, dest_dir: str = None,
             progress_cb=print, cookies_from_browser: str = None,
             overwrite: bool = False) -> dict:
    """Download `url` into the library. Returns a report dict:
    {path, title, id, url, quality, duration_s, width, height, vcodec,
     acodec, size_mb, already_had}

    Re-downloading a URL already in the library is a no-op: yt-dlp sees the
    destination file and skips it, and we report already_had=True rather than
    burning bandwidth or making a "(1)" duplicate.

    IMPORTANT: the filename carries the title and id but NOT the quality, so
    a skip happens even when the caller asked for a different preset than the
    file on disk was fetched with -- you would silently get the old encode.
    Callers must inspect already_had (plus vcodec/width in the report) and
    re-issue with overwrite=True to actually change quality.
    """
    url = (url or "").strip()
    if not url:
        raise YTError("No URL given.")
    if not url.lower().startswith(("http://", "https://")):
        raise YTError(f"Not a URL: {url!r}\nPaste a full https://... link.")

    quality = quality if quality in QUALITY else get_quality()
    preset = QUALITY[quality]

    if cookies_from_browser is None:
        cookies_from_browser = get_cookie_browser()

    dest = dest_dir or library_dir()
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as e:
        raise YTError(f"Cannot create download folder {dest}:\n{e}")

    try:
        import yt_dlp
    except ImportError:
        raise YTError(
            "yt-dlp is not installed for this Python.\n\n"
            f"Install it with:\n  \"{sys.executable}\" -m pip install -U yt-dlp")

    if not shutil.which("ffmpeg"):
        raise YTError(
            "ffmpeg was not found on PATH. It is required to merge YouTube's "
            "separate video and audio streams -- without it the best quality "
            "available is a 1080p-capped pre-muxed file.")

    opts = {
        "format": preset["format"],
        "outtmpl": {"default": os.path.join(dest, "%(title)s [%(id)s].%(ext)s")},
        "noplaylist": True,      # a ?list= URL must not pull the whole playlist
        "writeinfojson": True,   # sidecar: title/url/duration without re-probing
        "quiet": True,
        "noprogress": True,
        "consoletitle": False,
        "progress_hooks": [_progress_hook(progress_cb)],
        "logger": _Logger(progress_cb),
        "retries": 5,
        "fragment_retries": 10,
        "postprocessors": [{"key": "FFmpegMetadata", "add_metadata": True}],
    }
    if preset["merge"]:
        opts["merge_output_format"] = preset["merge"]
    if preset.get("sort"):
        opts["format_sort"] = list(preset["sort"])
    if overwrite:
        opts["overwrites"] = True
    if pipeline.load_settings().get("youtube_solve_challenges", True):
        # Without a challenge solver yt-dlp warns "Signature solving failed:
        # Some formats may be missing" -- i.e. the top of the ladder can be
        # invisible, and downloads can get throttled. This fetches yt-dlp's
        # EJS solver from GitHub and runs it under deno/node. Verified to
        # clear the warnings on this machine (deno present, 2026-08-04).
        # Set "youtube_solve_challenges": false in settings.json to opt out
        # of the remote script fetch.
        opts["remote_components"] = ["ejs:github"]
    if cookies_from_browser and cookies_from_browser != "none":
        # Tuple form: (browser, profile, keyring, container). Only the browser
        # is set. Chrome/Edge lock their cookie DB while running -- if this
        # throws, the message tells the user to close the browser.
        opts["cookiesfrombrowser"] = (cookies_from_browser, None, None, None)

    progress_cb(f"[yt] quality: {preset['label']}")
    if cookies_from_browser and cookies_from_browser != "none":
        progress_cb(f"[yt] using {cookies_from_browser} cookies "
                    "(Premium / members-only ladders)")
    progress_cb(f"[yt] resolving {url} ...")

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            reqs = info.get("requested_downloads") or []
            first = reqs[0] if reqs else {}
            path = first.get("filepath") or ydl.prepare_filename(info)
            # yt-dlp records "did bytes actually move" on the per-download
            # entry and/or the top-level dict depending on the code path.
            skipped = (first.get("__real_download") is False
                       or info.get("__real_download") is False)
    except YTError:
        raise
    except Exception as e:
        msg = str(e)
        if "could not copy" in msg.lower() or "cookies database" in msg.lower():
            msg += ("\n\nClose the browser fully (check the tray) and retry, "
                    "or set Cookies to 'none'.")
        raise YTError(f"yt-dlp failed: {type(e).__name__}: {msg}")

    if not path or not os.path.exists(path):
        # Merge can change the extension out from under prepare_filename.
        stem = os.path.splitext(path or "")[0]
        cand = [stem + e for e in (".mp4", ".mkv", ".webm", ".m4a", ".opus")
                if os.path.exists(stem + e)]
        if not cand:
            raise YTError("Download reported success but no output file was "
                          f"found (expected near {path!r}).")
        path = cand[0]

    meta = probe(path)
    return {
        "path": path,
        "title": info.get("title") or os.path.basename(path),
        "id": info.get("id"),
        "url": info.get("webpage_url") or url,
        "quality": quality,
        "size_mb": round(os.path.getsize(path) / 1048576, 2),
        "already_had": bool(skipped),
        **meta,
    }


# --------------------------------------------------------------------------- #
# library listing
# --------------------------------------------------------------------------- #

def _read_sidecar(media_path: str) -> dict | None:
    side = os.path.splitext(media_path)[0] + ".info.json"
    if not os.path.exists(side):
        return None
    try:
        with open(side, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _entry(path: str, in_library: bool) -> dict:
    info = _read_sidecar(path)
    m = _YT_ID_RE.search(os.path.basename(path))
    ent = {
        "path": path,
        "dir": os.path.dirname(path),
        "in_library": in_library,
        "title": None, "id": m.group(1) if m else None, "url": None,
        "duration_s": None, "width": None, "height": None,
        "vcodec": None, "acodec": None,
    }
    try:
        st = os.stat(path)
        ent["size_mb"] = round(st.st_size / 1048576, 2)
        ent["mtime"] = st.st_mtime
    except OSError:
        ent["size_mb"] = 0.0
        ent["mtime"] = 0.0

    if info:
        ent["title"] = info.get("title")
        ent["id"] = info.get("id") or ent["id"]
        ent["url"] = info.get("webpage_url")
        ent["duration_s"] = info.get("duration")
        ent["width"] = info.get("width")
        ent["height"] = info.get("height")
        ent["vcodec"] = info.get("vcodec")
        ent["acodec"] = info.get("acodec")

    # The file on disk is the authority -- ALWAYS probe it, never trust the
    # sidecar for anything ffprobe can measure. yt-dlp rewrites .info.json on
    # every call, including calls where it then SKIPPED the download because
    # the file already existed, so the sidecar can describe an encode that was
    # never written (observed 2026-08-04: sidecar said avc1, file was av1).
    # The sidecar is still the only source for title / id / webpage_url.
    ent.update({k: v for k, v in probe(path).items() if v is not None})

    if not ent["title"]:
        # NB: _YT_ID_RE requires a trailing ".ext" (it matches against full
        # filenames); the extension is already gone here, so strip with the
        # end-anchored variant instead.
        base = os.path.splitext(os.path.basename(path))[0]
        ent["title"] = re.sub(r"\s*\[[0-9A-Za-z_-]{11}\]$", "", base).strip() or base
    if not ent["url"] and ent["id"]:
        ent["url"] = f"https://youtu.be/{ent['id']}"
    return ent


def list_library(include_audio: bool = True) -> list[dict]:
    """Every YouTube download we can find, newest first.

    Inclusion rule differs per directory on purpose:
      * the library dir  -> every media file (we put it there, it belongs)
      * extra scan dirs  -> only files with a yt-dlp "[<id>]" name or an
        .info.json sidecar, so a general-purpose folder like ~/Downloads
        does not dump unrelated videos into the picker.
    """
    exts = set(pipeline.VIDEO_EXTS)
    if include_audio:
        exts |= set(pipeline.AUDIO_EXTS)

    entries: list[dict] = []
    seen: set[str] = set()
    lib_key = os.path.normcase(os.path.abspath(library_dir()))

    for d in scan_dirs():
        if not os.path.isdir(d):
            continue
        is_lib = os.path.normcase(os.path.abspath(d)) == lib_key
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            path = os.path.join(d, name)
            ext = os.path.splitext(name)[1].lower()
            if ext in _SKIP_EXTS or ext not in exts:
                continue
            if not os.path.isfile(path):
                continue
            if not is_lib:
                looks_yt = bool(_YT_ID_RE.search(name)) or os.path.exists(
                    os.path.splitext(path)[0] + ".info.json")
                if not looks_yt:
                    continue
            key = os.path.normcase(os.path.abspath(path))
            if key in seen:
                continue
            seen.add(key)
            entries.append(_entry(path, is_lib))

    entries.sort(key=lambda e: e.get("mtime", 0), reverse=True)
    return entries


def fmt_duration(seconds) -> str:
    try:
        s = int(round(float(seconds)))
    except (TypeError, ValueError):
        return "?"
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def fmt_res(entry: dict) -> str:
    w, h = entry.get("width"), entry.get("height")
    if not h:
        return "audio" if entry.get("acodec") else "?"
    return f"{w}x{h}" if w else f"{h}p"


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] not in ("--list", "-l"):
        rep = download(sys.argv[1],
                       quality=sys.argv[2] if len(sys.argv) > 2 else None)
        print(json.dumps(rep, indent=2))
    else:
        print(f"library: {library_dir()}")
        for e in list_library():
            print(f"  {fmt_res(e):>10}  {fmt_duration(e['duration_s']):>8}  "
                  f"{e['size_mb']:>8.1f} MB  {e['title'][:60]}")
