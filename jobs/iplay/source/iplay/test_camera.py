"""Tests for camera.py.

Records from the SYNTHETIC test pattern, never the real webcam, so running
this does not film anyone. Device enumeration is still exercised against the
real DirectShow stack.
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camera

FAIL = []
TMP = os.environ.get("TEMP", ".")


def check(label, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {detail}" if detail else ""))
    if not cond:
        FAIL.append(label)


print("=== 1. device enumeration ===")
cams = camera.list_cameras()
mics = camera.list_microphones()
print("  cameras    :", cams)
print("  microphones:", mics)
print("  default    :", camera.default_camera())
check("at least one camera found", bool(cams))
check("enumeration excludes 'Alternative name' junk",
      all(not c.startswith("@device_") for c in cams + mics))
check("default prefers a physical camera over a virtual one",
      camera.default_camera() is None
      or "virtual" not in camera.default_camera().lower(),
      str(camera.default_camera()))

print("\n=== 2. bitrate budget stays under the 32 MB upload cap ===")
for secs in (15, 30, 60, 120, camera.MAX_RECORD_S):
    kbps = camera.bitrate_for(secs)
    mb = kbps * 1000 * secs / 8 / 1048576
    flag = "" if mb <= camera.MAX_UPLOAD_MB else "  <-- OVER CAP"
    print(f"  {secs:4}s -> {kbps:5}k = {mb:6.1f} MB{flag}")
    check(f"{secs}s fits under {camera.MAX_UPLOAD_MB} MB",
          mb <= camera.MAX_UPLOAD_MB, f"{mb:.1f} MB")
check("bitrate is clamped to a sane ceiling",
      camera.bitrate_for(1) <= 3000, str(camera.bitrate_for(1)))
check("bitrate never drops below the usable floor",
      camera.bitrate_for(camera.MAX_RECORD_S) >= 1200,
      str(camera.bitrate_for(camera.MAX_RECORD_S)))
# Durations that could not fit at usable quality must be refused, not
# silently recorded at an unusable bitrate.
try:
    camera.record(camera.TEST_PATTERN, os.path.join(TMP, "nope.mp4"),
                  camera.MAX_RECORD_S + 60)
    check("record() refuses durations beyond MAX_RECORD_S", False, "no error raised")
except camera.CameraError as e:
    check("record() refuses durations beyond MAX_RECORD_S", True)
    check("refusal explains the 32 MB cap", "32" in str(e), str(e)[:70])

print("\n=== 3. record from the synthetic pattern (16s) ===")
out = os.path.join(TMP, "iplay_cam_test.mp4")
seen = {"frames": 0, "sizes": set()}


def on_frame(buf, w, h):
    seen["frames"] += 1
    seen["sizes"].add((len(buf), w, h))


t0 = time.time()
rep = camera.record(camera.TEST_PATTERN, out, 16, mic="synthetic",
                    preview_cb=on_frame, progress_cb=lambda m: print("  " + m))
print(f"  wall time: {time.time() - t0:.1f}s")
print(f"  report   : {rep}")
check("file exists", os.path.exists(out))
check("duration is about 16s", abs(rep["duration_s"] - 16) < 1.5,
      f"{rep['duration_s']:.2f}s")
check("stayed under the upload cap", rep["size_mb"] <= camera.MAX_UPLOAD_MB,
      f"{rep['size_mb']} MB")
check("video was captured at 720p", rep["height"] == 720,
      f"{rep['width']}x{rep['height']}")
check("preview frames were delivered", seen["frames"] > 50, str(seen["frames"]))
check("every preview frame is exactly one fixed-size rgb24 buffer",
      seen["sizes"] == {(camera.PREVIEW_W * camera.PREVIEW_H * 3,
                         camera.PREVIEW_W, camera.PREVIEW_H)},
      str(seen["sizes"]))
check("recording was not marked truncated", rep["truncated"] is False)

print("\n=== 4. footage validation ===")
ok, msg = camera.check_footage(out)
print("  16s clip ->", ok, "|", msg)
check("a valid 16s clip passes validation", ok, msg)

print("\n=== 5. early stop via stop_event (and the short-clip REJECTION) ===")
# This doubles as proof that check_footage can actually fail: a 5s clip is
# below HeyGen's 15s minimum, so it must be refused.
short = os.path.join(TMP, "iplay_cam_short.mp4")
ev = threading.Event()
threading.Timer(5.0, ev.set).start()
t0 = time.time()
rep2 = camera.record(camera.TEST_PATTERN, short, 60, preview_cb=None,
                     progress_cb=lambda m: print("  " + m), stop_event=ev)
elapsed = time.time() - t0
print(f"  stopped after {elapsed:.1f}s wall, clip is {rep2['duration_s']:.2f}s")
check("stop_event ended a 60s recording early", elapsed < 25, f"{elapsed:.1f}s")
check("report flags it as truncated", rep2["truncated"] is True)
check("the early-stopped file is still valid/playable",
      rep2["duration_s"] > 1, f"{rep2['duration_s']:.2f}s")
ok2, msg2 = camera.check_footage(short)
print("  short clip ->", ok2, "|", msg2)
check("check_footage REJECTS footage under 15s", not ok2, msg2)
check("rejection message names the limit", "15" in msg2, msg2)

for f in (out, short):
    try:
        os.remove(f)
    except OSError:
        pass

print("\n" + "=" * 60)
if FAIL:
    print(f"FAILED ({len(FAIL)}): " + "; ".join(FAIL))
    sys.exit(1)
print("ALL CHECKS PASSED")
