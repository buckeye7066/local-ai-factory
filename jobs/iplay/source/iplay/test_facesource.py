"""Tests for photo-or-footage face sources.

Uses SYNTHETIC clips, never the webcam, and makes no avatar-creating API
calls — the digital-twin contract was verified separately against the live
account; creating twins from test patterns would burn credits and litter the
HeyGen account with junk avatar groups.
"""
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camera
import pipeline

FAIL = []
TMP = tempfile.mkdtemp(prefix="iplay_face_test_")


def check(label, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {detail}" if detail else ""))
    if not cond:
        FAIL.append(label)


def make(name, seconds, bitrate="1200k", size="1280x720", cbr=False):
    """cbr=True forces x264 to actually spend the requested bitrate.

    Plain -b:v is only a target: testsrc is so compressible that asking for
    16 Mbps yields ~1.4 Mbps, which is useless for building an over-the-cap
    fixture. nal-hrd=cbr makes the encoder pad to a true constant rate.
    """
    path = os.path.join(TMP, name)
    args = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", f"testsrc=size={size}:rate=30", "-t", str(seconds),
            "-c:v", "libx264", "-preset", "veryfast", "-b:v", bitrate]
    if cbr:
        args += ["-minrate", bitrate, "-maxrate", bitrate, "-bufsize", bitrate,
                 "-x264-params", "nal-hrd=cbr:force-cfr=1"]
    args += ["-pix_fmt", "yuv420p", path]
    subprocess.run(args, check=True)
    return path


print("=== 1. face_source_kind ===")
cases = [("me.jpg", "image"), ("me.JPEG", "image"), ("me.png", "image"),
         ("clip.mp4", "video"), ("clip.WEBM", "video"), ("clip.mov", "video"),
         ("clip.mkv", "video"), ("song.mp3", "unknown"), ("notes.txt", "unknown")]
for name, want in cases:
    got = pipeline.face_source_kind(name)
    check(f"{name:12} -> {want}", got == want, got)

print("\n=== 2. non-submitting production boundary ===")
good = make("good.mp4", 16)
short = make("short.mp4", 5)
unknown = os.path.join(TMP, "notes.txt")
with open(unknown, "w", encoding="utf-8") as fh:
    fh.write("not an identity asset\n")
r = pipeline.face_stage([], "out.mp4")
check("no sources -> skipped", r["status"] == "skipped", str(r))
r = pipeline.face_stage([unknown], "out.mp4")
check("unrecognised source -> unavailable", r["status"] == "unavailable", str(r))
check("the message says what IS accepted",
      "photo" in r["detail"] and "footage" in r["detail"], r["detail"][:80])
r = pipeline.face_stage([short], "out.mp4")
check("short footage can be staged without a paid call",
      r["status"] == "staged" and r["paid_calls_made"] is False, str(r))
check("protected performance stays under IPlay",
      r["motion_source"] == "iplay" and r["hands_locked"]
      and r["instrument_geometry_locked"] and r["audio_locked"], str(r))

print("\n=== 3. GUI: Record dialog builds (NO recording is started) ===")
import tkinter as tk
import iplay_app


def find(widget, cls, text=None):
    for c in widget.winfo_children():
        if isinstance(c, cls):
            if text is None:
                return c
            try:
                if c.cget("text") == text:
                    return c
            except tk.TclError:
                pass
        hit = find(c, cls, text)
        if hit is not None:
            return hit
    return None


root = tk.Tk()
app = iplay_app.IPlayApp(root)
root.update()
check("the Face row has a Record button",
      find(root, tk.Button, "Record") is not None)

app.record_face()
root.update()
tops = [w for w in root.winfo_children() if isinstance(w, tk.Toplevel)]
check("record dialog opened", bool(tops))
if tops:
    win = tops[0]
    for label in ("Record", "Stop", "Use this clip", "Close"):
        check(f"dialog has a {label!r} button",
              find(win, tk.Button, label) is not None)
    # Guard rails: nothing is recordable/usable until a clip actually exists.
    check("'Stop' starts disabled",
          str(find(win, tk.Button, "Stop").cget("state")) == "disabled")
    check("'Use this clip' starts disabled",
          str(find(win, tk.Button, "Use this clip").cget("state")) == "disabled")
    win.destroy()
    root.update()

app.add_face_source(good)
check("adding footage puts it in the source list", good in app.photos)
check("the list labels the source kind",
      app.photo_list.get(0).startswith("[video]"), app.photo_list.get(0))

print("\n=== 6. Record dialog END-TO-END against the synthetic source ===")
# The dialog is driven for real -- Record clicked, frames rendered, clip
# accepted -- but pointed at lavfi instead of the webcam, so nobody is filmed.
_real_list, _real_default = camera.list_cameras, camera.default_camera
camera.list_cameras = lambda: [camera.TEST_PATTERN]
camera.default_camera = lambda: camera.TEST_PATTERN
try:
    app.clear_photos()
    app.record_face()
    root.update()
    win = [w for w in root.winfo_children() if isinstance(w, tk.Toplevel)][0]

    spin = find(win, tk.Spinbox)
    spin.delete(0, "end")
    spin.insert(0, "16")

    labels = []

    def collect(w):
        for c in w.winfo_children():
            if isinstance(c, tk.Label):
                labels.append(c)
            collect(c)

    collect(win)
    btn_use = find(win, tk.Button, "Use this clip")
    find(win, tk.Button, "Record").invoke()
    root.update()
    check("'Stop' becomes enabled while recording",
          str(find(win, tk.Button, "Stop").cget("state")) == "normal")

    # Real mainloop: the capture thread hands frames back via root.after,
    # which only dispatches while mainloop() is running.
    state = {"deadline": time.time() + 90}

    def poll():
        if str(btn_use.cget("state")) == "normal" or time.time() > state["deadline"]:
            root.quit()
            return
        root.after(150, poll)

    root.after(150, poll)
    root.mainloop()

    check("recording finished and the clip was accepted",
          str(btn_use.cget("state")) == "normal",
          str(find(win, tk.Label, None) and ""))
    drew = [l for l in labels if getattr(l, "image", None) is not None]
    check("live preview frames were rendered into the dialog",
          bool(drew), f"{len(drew)} label(s) received an image")

    btn_use.invoke()
    root.update()
    check("'Use this clip' adds the recording as a face source",
          len(app.photos) == 1, str(app.photos))
    if app.photos:
        p = app.photos[0]
        check("the recorded file exists", os.path.exists(p))
        ok, msg = camera.check_footage(p)
        check("the recorded clip passes HeyGen's footage rules", ok, msg)
        check("it is registered as video, not image",
              pipeline.face_source_kind(p) == "video")
        try:
            os.remove(p)
        except OSError:
            pass
finally:
    camera.list_cameras, camera.default_camera = _real_list, _real_default

root.destroy()

import shutil
shutil.rmtree(TMP, ignore_errors=True)

print("\n" + "=" * 60)
if FAIL:
    print(f"FAILED ({len(FAIL)}): " + "; ".join(FAIL))
    sys.exit(1)
print("ALL CHECKS PASSED")

