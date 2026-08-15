"""Verify (a) the quality presets really select different streams, and
(b) a downloaded YouTube file feeds IPlay's audio analysis."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ytadapter
import pipeline

URL = "https://youtu.be/v5y2BBXABvU"
FAIL = []


def check(label, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {detail}" if detail else ""))
    if not cond:
        FAIL.append(label)


print("=== A. what each preset actually selects (simulate, no download) ===")
import yt_dlp

picked = {}
for key, preset in ytadapter.QUALITY.items():
    opts = {"format": preset["format"], "quiet": True, "no_warnings": True,
            "simulate": True, "noplaylist": True,
            "remote_components": ["ejs:github"]}
    if preset.get("sort"):
        opts["format_sort"] = list(preset["sort"])
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(URL, download=False)
    reqs = info.get("requested_formats") or [info]
    ids = "+".join(str(f.get("format_id")) for f in reqs)
    vid = next((f for f in reqs if f.get("vcodec") not in (None, "none")), None)
    aud = next((f for f in reqs if f.get("acodec") not in (None, "none")), None)
    vbr = (vid or {}).get("tbr") or 0
    picked[key] = {
        "ids": ids,
        "height": (vid or {}).get("height"),
        "vcodec": ((vid or {}).get("vcodec") or "none").split(".")[0],
        "vbr": vbr,
        "acodec": ((aud or {}).get("acodec") or "none").split(".")[0],
        "abr": (aud or {}).get("abr") or 0,
    }
    p = picked[key]
    print(f"  {key:14} -> fmt {p['ids']:10} {str(p['height']) + 'p':>7} "
          f"{p['vcodec']:6} {p['vbr']:7.0f}k video | {p['acodec']:5} {p['abr']:6.1f}k audio")

check("all presets reach the same top resolution (1080p here)",
      picked["best"]["height"] == picked["best_bitrate"]["height"] == 1080)
check("best_bitrate picks a FATTER video stream than best",
      picked["best_bitrate"]["vbr"] > picked["best"]["vbr"],
      f"{picked['best_bitrate']['vbr']:.0f}k vs {picked['best']['vbr']:.0f}k")
check("best picks the efficient codec (av01)",
      picked["best"]["vcodec"].startswith("av01"), picked["best"]["vcodec"])
check("best_mp4 picks H.264", picked["best_mp4"]["vcodec"].startswith("avc1"),
      picked["best_mp4"]["vcodec"])
check("audio preset selects no video stream",
      picked["audio"]["height"] in (None, 0), str(picked["audio"]["height"]))
check("every preset still gets an audio stream",
      all(p["acodec"] != "none" for p in picked.values()))
# Regression guard: bv* + sort(res,br) used to select a pre-muxed HLS stream
# (fmt 96) whose audio track we neither chose nor could measure.
for k in ("best", "best_bitrate", "best_mp4"):
    check(f"{k} merges SEPARATE video+audio (not a muxed stream)",
          "+" in picked[k]["ids"], picked[k]["ids"])
    check(f"{k} has a known, non-zero audio bitrate",
          picked[k]["abr"] > 0, f"{picked[k]['abr']:.1f}k")

print("\n=== B. downloaded file -> IPlay audio analysis ===")
entries = [e for e in ytadapter.list_library() if e["in_library"]]
check("a file exists in the library", bool(entries))
if entries:
    src = entries[0]["path"]
    print(f"  source: {os.path.basename(src)}")
    wav = os.path.join(os.environ["TEMP"], "iplay_yt_probe.wav")
    t0 = time.time()
    try:
        pipeline.extract_audio(src, wav)
        ok = os.path.exists(wav) and os.path.getsize(wav) > 1000
    except Exception as e:
        ok = False
        print(f"  extract_audio raised: {type(e).__name__}: {e}")
    check("extract_audio handles the downloaded container", ok,
          f"{os.path.getsize(wav) / 1048576:.1f} MB wav in {time.time() - t0:.1f}s"
          if ok else "")
    if ok:
        t0 = time.time()
        timing = pipeline.ms.analyze_audio(wav)
        print(f"  analyze_audio: bpm={timing['bpm']} "
              f"duration={timing['duration_s']}s beats={len(timing['beats'])} "
              f"({time.time() - t0:.1f}s)")
        check("beat analysis returns a plausible bpm",
              20 < float(timing["bpm"]) < 250, str(timing["bpm"]))
        check("analysed duration matches the video (318s)",
              abs(float(timing["duration_s"]) - 317.95) < 1.5,
              f"{timing['duration_s']}s")
        check("beat grid is non-empty", len(timing["beats"]) > 10)
        for inst in pipeline.INSTRUMENTS:
            pol = pipeline.choose_policy(timing, inst)
            print(f"    {inst:7} -> policy={pol['policy']} ({pol['reason']})")
        check("a policy resolves for every instrument",
              all(pipeline.choose_policy(timing, i).get("policy")
                  for i in pipeline.INSTRUMENTS))
        try:
            os.remove(wav)
        except OSError:
            pass

print("\n" + "=" * 60)
if FAIL:
    print(f"FAILED ({len(FAIL)}): " + "; ".join(FAIL))
    sys.exit(1)
print("ALL CHECKS PASSED")
