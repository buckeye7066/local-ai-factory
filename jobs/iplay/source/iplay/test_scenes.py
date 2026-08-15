"""Tests for scenes.py + the pipeline wiring of full-song avatar scenes.

No HeyGen calls are made: the planner/prompt tests are pure math, and the
stitch/verify tests run on synthetic lavfi clips + generated WAVs, so the
suite spends no API credits and films no one. Needs ffmpeg on PATH.
"""
from __future__ import annotations

from fractions import Fraction
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scenes  # noqa: E402

PASS = 0


def check(name: str, cond: bool, detail: str = ""):
    global PASS
    tag = "ok " if cond else "FAIL"
    print(f"[{tag}] {name}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{name}: {detail}"
    PASS += 1


def fake_timing(duration=200.0, beat_s=0.5):
    beats = [round(i * beat_s, 4) for i in range(int(duration / beat_s))]
    onsets = beats[:]  # one onset per beat by default
    return {"duration_s": duration, "sample_rate": 22050,
            "bpm": 60.0 / beat_s, "beats": beats,
            "onset_times": onsets,
            "onset_strength": [1.0] * len(onsets)}


# ---------------------------------------------------------------------------#
print("--- plan_scenes ---")
t = fake_timing(200.0, 0.5)
plan = scenes.plan_scenes(t)
check("covers the whole song",
      plan[0]["start"] == 0.0 and abs(plan[-1]["end"] - 200.0) < 1e-6)
gaps = [abs(a["end"] - b["start"]) for a, b in zip(plan, plan[1:])]
check("no gaps or overlaps", all(g < 1e-6 for g in gaps))
check("every scene <= HeyGen cap",
      all(s["dur"] <= scenes.MAX_SCENE_S + 1e-6 for s in plan),
      f"max={max(s['dur'] for s in plan):.2f}")
check("every scene >= min",
      all(s["dur"] >= scenes.MIN_SCENE_S - 1e-6 for s in plan),
      f"min={min(s['dur'] for s in plan):.2f}")
beats = set(t["beats"])
interior = [s["start"] for s in plan[1:]]
on_beat = sum(1 for b in interior if any(abs(b - x) < 1e-3 for x in beats))
check("interior cuts land on beats", on_beat == len(interior),
      f"{on_beat}/{len(interior)}")
downs = set(t["beats"][::4])
on_down = sum(1 for b in interior if any(abs(b - x) < 1e-3 for x in downs))
check("cuts prefer bar lines (>=80%)", on_down >= 0.8 * len(interior),
      f"{on_down}/{len(interior)}")

short = scenes.plan_scenes(fake_timing(10.0, 0.5))
check("short song -> one scene", len(short) == 1 and short[0]["dur"] == 10.0)

nb = scenes.plan_scenes({"duration_s": 100.0, "bpm": 0, "beats": [],
                         "onset_times": []})
check("no beats still tiles fully",
      abs(nb[-1]["end"] - 100.0) < 1e-6
      and all(s["dur"] <= scenes.MAX_SCENE_S + 1e-6 for s in nb)
      and all(s["dur"] >= scenes.MIN_SCENE_S - 1e-6 for s in nb))

# tail-merge: 16s song with 0.5s beats -> naive cut at 15 leaves a 1s tail
tm = scenes.plan_scenes(fake_timing(16.0, 0.5))
check("no stutter tail", all(s["dur"] >= scenes.MIN_SCENE_S - 1e-6 for s in tm),
      str([s["dur"] for s in tm]))

# ---------------------------------------------------------------------------#
print("--- camera rotation ---")
keys = [s["shot"]["key"] for s in plan]
pairs_ok = all(a != b for a, b in zip(keys, keys[1:]))
check("adjacent scenes never share a shot", pairs_ok)
check("close-ups recur", keys.count("closeup_hands") >= len(plan) // 5)
check("opens wide", keys[0] == "wide")

local_a = scenes.plan_local_scenes(fake_timing(80.0, 0.5),
                                   cutaway_count=2, seed=7,
                                   instrument="guitar", variant="electric")
local_b = scenes.plan_local_scenes(fake_timing(80.0, 0.5),
                                   cutaway_count=2, seed=7,
                                   instrument="guitar", variant="electric")
check("local scene plan is deterministic", local_a == local_b)
check("local edit opens and closes on performance",
      local_a[0]["role"] == local_a[-1]["role"] == "performance")
check("local cutaways are sparse and never adjacent",
      all(not (a["role"] == b["role"] == "cutaway")
          for a, b in zip(local_a, local_a[1:]))
      and sum(s["role"] == "cutaway" for s in local_a) <= math.ceil(len(local_a) * .25))
local_asset_indices = [s["asset_index"] for s in local_a
                       if s["role"] == "cutaway"]
check("local cutaway assets are assigned at most once",
      len(local_asset_indices) == len(set(local_asset_indices))
      and len(local_asset_indices) <= 2)
source_coverage = scenes.plan_local_scenes(
    fake_timing(40.0, 0.5),
    cutaway_assets=[
        {"kind": "video", "duration_s": 3.2},
        {"kind": "video", "duration_s": 12.5},
    ],
    seed=3,
    motion_source_tier="source-preserved",
)
source_cutaways = [scene for scene in source_coverage
                   if scene["role"] == "cutaway"]
check("source-preserved cutaway needs full coverage and one use",
      [scene["asset_index"] for scene in source_cutaways] == [1]
      and source_cutaways[0]["duration_coverage_verified"]
      and source_cutaways[0]["asset_use_policy"] == "once")
check("source-preserved performance remains identity mapped",
      all(scene["motion_timeline_transform"] == {
              "kind": "same-media-identity",
              "rate": 1.0,
              "retimed": False,
              "reversed": False,
          }
          for scene in source_coverage if scene["role"] == "performance"))
drift_timing = fake_timing(317.953, 60.0 / 151.999)
drift_timing["sample_rate"] = 48000
drift_plan = scenes.plan_local_scenes(
    drift_timing, frame_rate="30000/1001",
    motion_source_tier="source-preserved")
drift_samples = [scene["sample_range"] for scene in drift_plan]
drift_endpoint = round(317.953 * 48000)
drift_frames = [scene["output_frame_range"] for scene in drift_plan]
expected_drift_frames = round(
    Fraction(drift_endpoint, 48000) * Fraction(30000, 1001))
check("scene clock is cumulative on the master sample timeline",
      all(left["end"] == right["start"]
          for left, right in zip(drift_samples, drift_samples[1:]))
      and sum(item["end"] - item["start"] for item in drift_samples)
      == drift_endpoint
      and drift_samples[-1]["end"] == drift_endpoint)
check("scene time serialization has no per-scene millisecond drift",
      abs(sum(scene["dur"] for scene in drift_plan)
          - drift_endpoint / 48000) < 1e-9
      and all(left["end"] == right["start"]
              for left, right in zip(drift_plan, drift_plan[1:])))
check("scene render clock uses the same cumulative rational-frame boundaries",
      all(left["end"] == right["start"]
          for left, right in zip(drift_frames, drift_frames[1:]))
      and sum(item["end"] - item["start"] for item in drift_frames)
      == expected_drift_frames
      and drift_frames[-1]["end"] == expected_drift_frames)
check("cutaway re-entry is centered wide",
      all(local_a[i + 1]["shot"]["key"] == "wide"
          for i, s in enumerate(local_a[:-1]) if s["role"] == "cutaway"))
check("local manifest carries phrase/section/continuity state",
      all({"phrase", "section", "energy", "continuity"} <= set(s)
          for s in local_a))
check("local scenes carry exact analysis sample and time ranges",
      all(s["sample_range"]["start"] == round(s["start"] * 22050)
          and s["sample_range"]["end"] == round(s["end"] * 22050)
          and s["time_range"]["start_s"] == s["start"]
          for s in local_a))
check("performance motion is protected from generative services",
      all(s["motion_source"] == "iplay-retimed-performance" and s["hands_locked"]
          and s["instrument_geometry_locked"] and s["audio_locked"]
          and s["heygen_scope"] == "none"
          for s in local_a if s["role"] == "performance"))
check("uninspected local cutaways make no content claim",
      all(s["protected_performance_visible"] is None
          and s["avatar_visible"] is None
          and s["content_verification"] == "not_inspected"
          and s["heygen_scope"] == "none"
          for s in local_a if s["role"] == "cutaway"))
check("current reference path is honestly classified as beat-only",
      all(s["motion_source_tier"] == "beat-only"
          for s in local_a if s["role"] == "performance")
      and all(s["performance_motion_source_tier"] == "beat-only"
              for s in local_a))

# ---------------------------------------------------------------------------#
print("--- prompts ---")
cons = scenes.consistency_block("guitar", "electric")
prompts = [scenes.scene_prompt(s, t, "guitar", "electric") for s in plan[:6]]
check("consistency block verbatim in every prompt",
      all(cons in p for p in prompts))
check("camera varies across prompts",
      len({p.replace(cons, "") for p in prompts}) == len(prompts))
check("instrument-exclusive clause",
      all("Only the electric guitar is played on screen" in p for p in prompts))
check("tempo in prompt", all("120 BPM" in p for p in prompts))
check("bass variant wording",
      "electric bass guitar" in scenes.scene_prompt(plan[0], t, "guitar", "bass"))
check("piano prompt names key presses",
      "key press" in scenes.scene_prompt(plan[0], t, "piano"))
check("violin prompt names bow strokes",
      "bow stroke" in scenes.scene_prompt(plan[0], t, "violin"))

# articulation switches on onset density
dense = fake_timing(20.0, 0.5)
dense["onset_times"] = [i * 0.125 for i in range(160)]  # 4 onsets/beat
sparse = fake_timing(20.0, 0.5)
sparse["onset_times"] = [i * 2.0 for i in range(10)]    # 1 onset / 4 beats
check("dense guitar -> strumming",
      "strum" in scenes.articulation(dense, 0, 20, "guitar")["desc"])
check("sparse guitar -> arpeggiated",
      "arpeggiated" in scenes.articulation(sparse, 0, 20, "guitar")["desc"])
check("dense piano -> runs",
      "runs" in scenes.articulation(dense, 0, 20, "piano")["desc"])
check("sparse violin -> legato",
      "legato" in scenes.articulation(sparse, 0, 20, "violin")["desc"])
check("dense violin -> detache",
      "detache" in scenes.articulation(dense, 0, 20, "violin")["desc"])

# ---------------------------------------------------------------------------#
print("--- instrument-focused onsets (register isolation) ---")
from scipy.io import wavfile  # noqa: E402

sr = 22050
dur_s = 10
n = sr * dur_s
y = np.zeros(n, dtype=np.float64)
tt = np.arange(n) / sr
# "bass" bursts (100 Hz, 60 ms) at integer seconds
for t0 in range(1, dur_s):
    i0 = int(t0 * sr)
    seg = np.arange(int(0.06 * sr))
    y[i0:i0 + len(seg)] += 0.9 * np.sin(2 * np.pi * 100 * seg / sr) \
        * np.exp(-seg / (0.02 * sr))
# distractor "other instrument" bursts (3 kHz) at half-integers
for t0 in range(0, dur_s - 1):
    i0 = int((t0 + 0.5) * sr)
    seg = np.arange(int(0.06 * sr))
    y[i0:i0 + len(seg)] += 0.9 * np.sin(2 * np.pi * 3000 * seg / sr) \
        * np.exp(-seg / (0.02 * sr))

tmp = tempfile.mkdtemp(prefix="iplay_scene_test_")
wav_path = os.path.join(tmp, "band.wav")
wavfile.write(wav_path, sr, (y * 32767 * 0.8).astype(np.int16))

res = scenes.instrument_onsets(wav_path, "guitar", "bass")
ons = res["onset_times"]
near_int = sum(1 for o in ons if abs(o - round(o)) < 0.08)
check("bass focus finds the bass hits", len(ons) >= 6, f"{len(ons)} onsets")
check("bass focus rejects the 3kHz distractor",
      near_int >= 0.8 * len(ons),
      f"{near_int}/{len(ons)} on integer seconds")
check("method reported honestly", res["method"] == "bandpass+energygate"
      and "not" in res["note"])
res_v = scenes.instrument_onsets(wav_path, "violin")
check("violin path (hpss) runs",
      res_v["method"] == "bandpass+hpss+energygate")

# ---------------------------------------------------------------------------#
print("--- scene motion verification ---")


def make_pulse_clip(path, dur=8, period=2.0, flash_at=1.8):
    # luma flash in [flash_at, period) of each cycle -> motion peaks at the
    # flash edges; gives a KNOWN gesture-timing ground truth.
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=black:s=640x360:r=30:d={dur}",
        "-vf", ("format=gray,"
                f"geq=lum='128+110*gt(mod(T,{period}),{flash_at})'"),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", path,
    ], check=True)


clip = os.path.join(tmp, "pulses.mp4")
make_pulse_clip(clip)
good = [1.8 + 2.0 * k for k in range(4)]     # onsets at the flash edge
bad = [0.8 + 2.0 * k for k in range(4)]      # onsets mid-darkness
v_good = scenes.verify_scene_motion(clip, good)
v_bad = scenes.verify_scene_motion(clip, bad)
check("on-beat motion passes", v_good["verdict"] == "pass", str(v_good))
check("off-beat motion fails", v_bad["verdict"] == "fail", str(v_bad))
check("no onsets is not a free pass",
      scenes.verify_scene_motion(clip, [])["verdict"] == "no_onsets")

# ---------------------------------------------------------------------------#
print("--- stitching ---")


def make_color_clip(path, color, dur):
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c={color}:s=1280x720:r=25:d={dur}",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", path,
    ], check=True)


def make_cutaway_geometry_fixtures(directory):
    """Create real rotation, SAR, combined, and rejected display metadata."""
    def color_source(name, color, sar="1/1"):
        path = os.path.join(directory, name)
        subprocess.run([
            "ffmpeg", "-hide_banner", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i",
            f"color=c={color}:s=160x90:r=1:d=15",
            "-vf", f"setsar={sar}", "-c:v", "libx264",
            "-preset", "ultrafast", "-pix_fmt", "yuv420p", path,
        ], check=True)
        return path

    rotation_base = color_source("rotation cutaway base.mp4", "red")
    rotated = os.path.join(directory, "rotation 90 cutaway.mp4")
    subprocess.run([
        "ffmpeg", "-hide_banner", "-y", "-loglevel", "error",
        "-display_rotation", "90", "-i", rotation_base,
        "-map", "0:v:0", "-c", "copy", rotated,
    ], check=True)
    anamorphic = color_source("sar two to one cutaway.mp4", "green", "2/1")
    combined_base = color_source(
        "combined cutaway base.mp4", "blue", "2/1")
    combined = os.path.join(directory, "rotation 90 plus sar two cutaway.mp4")
    subprocess.run([
        "ffmpeg", "-hide_banner", "-y", "-loglevel", "error",
        "-display_rotation", "90", "-i", combined_base,
        "-map", "0:v:0", "-c", "copy", combined,
    ], check=True)
    ordinary = color_source("valid but unscheduled cutaway.mp4", "yellow")
    rejected = color_source("hostile sar cutaway.mp4", "magenta", "100/1")
    return rotated, anamorphic, combined, ordinary, rejected


music = os.path.join(tmp, "music.wav")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                "-i", "sine=frequency=440:sample_rate=44100:duration=8.5",
                music], check=True)
files = []
for i, (c, d) in enumerate([("red", 3.2), ("green", 3.2), ("blue", 2.0)]):
    p = os.path.join(tmp, f"s{i}.mp4")
    make_color_clip(p, c, d)
    files.append(p)

# A cutaway's explicit FFmpeg video ordinal must follow the selected timeline
# stream, not attached cover art or an arbitrary first stream.
old_probe = scenes.media_tools.probe_media
def cutaway_probe(path, **_kwargs):
    common = {
        "codec_type": "video", "duration": "12.5", "start_time": "0",
        "width": 1280, "height": 720, "avg_frame_rate": "25/1",
        "r_frame_rate": "25/1", "sample_aspect_ratio": "1:1",
        "display_aspect_ratio": "16:9",
    }
    if os.path.abspath(path) == os.path.abspath(files[0]):
        return {"streams": [
            {**common, "index": 0,
             "disposition": {"attached_pic": 1, "default": 0}},
            {**common, "index": 1,
             "disposition": {"attached_pic": 0, "default": 1}},
        ], "format": {"duration": "12.5"}}
    if os.path.abspath(path) == os.path.abspath(files[2]):
        invalid_geometry = dict(common)
        invalid_geometry.pop("sample_aspect_ratio")
        invalid_geometry.pop("display_aspect_ratio")
        return {"streams": [{
            **invalid_geometry, "index": 0,
            "disposition": {"attached_pic": 0, "default": 1},
        }], "format": {"duration": "12.5"}}
    return {"streams": [
        {**common, "index": 0,
         "disposition": {"attached_pic": 0, "default": 0}},
        {**common, "index": 1,
         "disposition": {"attached_pic": 0, "default": 0}},
    ], "format": {"duration": "12.5"}}
scenes.media_tools.probe_media = cutaway_probe
try:
    _paths, selected_assets, selected_report = \
        scenes._inspect_cutaway_assets([files[0]])
    _paths, ambiguous_assets, ambiguous_report = \
        scenes._inspect_cutaway_assets([files[1]])
    _paths, invalid_geometry_assets, invalid_geometry_report = \
        scenes._inspect_cutaway_assets([files[2]])
finally:
    scenes.media_tools.probe_media = old_probe
check("cutaway skips cover art and maps the selected timeline ordinal",
      len(selected_assets) == 1
      and selected_assets[0]["kind"] == "video"
      and selected_assets[0]["duration_s"] == 12.5
      and selected_assets[0]["video_ordinal"] == 1
      and selected_assets[0]["display_geometry"]["display_width"] == 1280
      and selected_assets[0]["display_geometry"]["display_height"] == 720
      and selected_report[0]["video_ordinal"] == 1)
check("ambiguous multi-video cutaway fails closed",
      ambiguous_assets == []
      and ambiguous_report[0]["reason_code"] == "invalid_video")
check("invalid optional cutaway geometry fails closed",
      invalid_geometry_assets == []
      and invalid_geometry_report[0]["content_verification"] == "not_inspected"
      and invalid_geometry_report[0]["reason_code"]
      == "invalid_display_geometry"
      and not invalid_geometry_report[0]["display_geometry_normalized"])
# planned durs deliberately differ from real clip durs (3.0/3.0/2.5): the
# stitcher must trim the long ones and clone-pad the short one.
rep = scenes.stitch_scenes(files, [3.0, 3.0, 2.5], music,
                           os.path.join(tmp, "out.mp4"), total_dur=8.5)
check("stitched duration == song duration", abs(rep["duration_s"] - 8.5) < 0.25,
      f"{rep['duration_s']}s")
check("normalized to 1080p", rep["width"] == 1920 and rep["height"] == 1080)
astreams = subprocess.check_output(
    ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
     "stream=codec_name", "-of", "csv=p=0", rep["out"]], text=True).strip()
check("music track present", "aac" in astreams)

# Local director: the performance is one full synchronized timeline; a short
# mood clip may cover selected phrases, while the result stays video-only so
# build_video can map the original high-quality soundtrack exactly once.
performance = os.path.join(tmp, "performance.mp4")
subprocess.run([
    "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc2=size=320x180:rate=10:duration=40",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    performance,
], check=True)
long_mood = os.path.join(tmp, "long_mood.mp4")
make_color_clip(long_mood, "purple", 12.5)
local_out = os.path.join(tmp, "local_director.mp4")
local_messages = []
local_rep = scenes.render_local_director(
    performance, fake_timing(40.0, 0.5), local_out,
    cutaway_files=[files[0], long_mood, long_mood],
    width=320, height=180, fps=10, seed=3,
    instrument="guitar", variant="acoustic",
    progress_cb=local_messages.append)
check("local director tiles a full performance timeline",
      abs(local_rep["summary"]["duration_s"] - 40.0) < 0.25)
local_video_stream = scenes.media_tools.video_stream_at(
    scenes.media_tools.probe_media(local_out), 0)
check("rendered director frame count matches the shared scene clock",
      int(local_video_stream["nb_frames"])
      == local_rep["video_contract"]["output_frame_count"]
      == sum(scene["output_frame_range"]["end"]
             - scene["output_frame_range"]["start"]
             for scene in local_rep["manifest"]["scenes"]))
check("local director stays video-only before master mux",
      local_rep["summary"]["has_audio"] is False)
check("local director uses optional mood footage",
      any(s["role"] == "cutaway" for s in local_rep["manifest"]["scenes"]))
scheduled_cutaways = [s for s in local_rep["manifest"]["scenes"]
                      if s["role"] == "cutaway"]
check("local director uses each cutaway at most once",
      len({s["asset_index"] for s in scheduled_cutaways})
      == len(scheduled_cutaways)
      and all(s["asset_use_policy"] == "once"
              and s["duration_coverage_verified"]
              for s in scheduled_cutaways))
asset_report = local_rep["cutaway_assets"]
short_report = next(r for r in asset_report if r["basename"] == "s0.mp4")
long_report = next(r for r in asset_report
                   if r["basename"] == "long_mood.mp4"
                   and r["state"] == "scheduled")
duplicate_report = next(r for r in asset_report
                        if r.get("reason_code") == "duplicate")
check("too-short video is skipped instead of looped or frozen",
      short_report["state"] == "skipped"
      and short_report["reason_code"] == "too_short_for_slot"
      and "loop/freeze fallback is forbidden" in short_report["detail"]
      and any("skipping s0.mp4" in message for message in local_messages))
check("adequate video covers one complete scene",
      long_report["use_count"] == 1
      and long_report["duration_s"] >= long_report["timeline_slot"]["duration_s"])
check("duplicate path cannot bypass one-use policy",
      duplicate_report["state"] == "skipped")
check("director opens only assets that were actually scheduled",
      local_rep["opened_cutaway_sources"] == ["long_mood.mp4"]
      and short_report.get("director_input_index") is None
      and duplicate_report.get("director_input_index") is None)
check("video cutaway loop/freeze is disabled",
      local_rep["cutaway_policy"] == {
          "max_uses_per_asset": 1,
          "video_looping": False,
          "video_freeze_padding": False,
          "images_may_hold_for_slot": True,
          "master_audio_timeline_unchanged": True,
      }
      and "tpad=stop_mode=clone" not in scenes._normalized_camera_filter(
          {"zoom": 1.0}, 320, 180, 10, 12.0, hold_last_frame=False))
check("local manifest redacts absolute machine paths",
      local_rep["manifest"]["performance_source"] == "performance.mp4"
      and local_rep["manifest"]["cutaway_sources"] == ["long_mood.mp4"]
      and tmp not in json.dumps(local_rep["manifest"]))
check("production manifest records IPlay authority",
      local_rep["manifest"]["authority"]["performance_motion"] == "iplay"
      and local_rep["manifest"]["authority"]["master_audio"] == "iplay")
check("HeyGen adapter is manifest-only and non-performance",
      local_rep["manifest"]["heygen_adapter"]["status"] == "not_submitted"
      and local_rep["manifest"]["heygen_adapter"]["paid_calls_made"] is False
      and "performance_motion" in
          local_rep["manifest"]["heygen_adapter"]["forbidden_scope"])

# Real optional-cutaway geometry regression. Three technically validated but
# still content-uninspected assets are scheduled; a fourth valid asset and one
# hostile-SAR asset must never become FFmpeg inputs. The final director remains
# video-only, so this path cannot replace or alter the separately muxed master.
geometry_performance = os.path.join(tmp, "geometry protected performance.mp4")
subprocess.run([
    "ffmpeg", "-hide_banner", "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=1:d=144",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    geometry_performance,
], check=True)
rotated_cutaway, sar_cutaway, combined_cutaway, unscheduled_cutaway, \
    rejected_cutaway = make_cutaway_geometry_fixtures(tmp)
geometry_out = os.path.join(tmp, "cutaway display geometry director.mp4")
captured_geometry_command = {}
old_scene_runner = scenes.media_tools.run_logged


def capture_geometry_director(command, **kwargs):
    captured_geometry_command["command"] = list(command)
    return old_scene_runner(command, **kwargs)


performance_info = scenes.media_tools.probe_media(geometry_performance)
performance_stream = scenes.media_tools.video_stream_at(performance_info, 0)
performance_geometry = scenes.media_tools.video_display_geometry(
    performance_stream)
scenes.media_tools.run_logged = capture_geometry_director
try:
    geometry_rep = scenes.render_local_director(
        geometry_performance, fake_timing(144.0, 0.5), geometry_out,
        cutaway_files=[rotated_cutaway, sar_cutaway, combined_cutaway,
                       unscheduled_cutaway, rejected_cutaway],
        width=320, height=180, fps=1, seed=0,
        performance_display_geometry=performance_geometry,
        motion_source_tier="source-preserved",
        progress_cb=lambda _message: None)
finally:
    scenes.media_tools.run_logged = old_scene_runner

geometry_command = captured_geometry_command["command"]
geometry_filter = geometry_command[
    geometry_command.index("-filter_complex") + 1]
expected_cutaway_geometry = {
    os.path.basename(rotated_cutaway): (90, 160),
    os.path.basename(sar_cutaway): (320, 90),
    os.path.basename(combined_cutaway): (90, 320),
}
geometry_reports = {
    record["basename"]: record for record in geometry_rep["cutaway_assets"]
}
scheduled_geometry_reports = [
    record for record in geometry_rep["cutaway_assets"]
    if record["state"] == "scheduled"
]
check("real rotated/SAR/combined cutaways validate container geometry",
      len(scheduled_geometry_reports) == 3
      and all((record["display_geometry"]["display_width"],
               record["display_geometry"]["display_height"])
              == expected_cutaway_geometry[record["basename"]]
              for record in scheduled_geometry_reports)
      and all(record["display_geometry_validation"]
              == "validated_for_safe_normalization"
              and record["content_verification"] == "not_inspected"
              and record["display_geometry_normalized"]
              for record in scheduled_geometry_reports))
check("invalid optional geometry is skipped without breaking core render",
      geometry_reports[os.path.basename(rejected_cutaway)]["state"] == "skipped"
      and geometry_reports[os.path.basename(rejected_cutaway)]["reason_code"]
      == "invalid_display_geometry"
      and geometry_rep["status"] == "completed")
check("only scheduled cutaway files become FFmpeg inputs",
      geometry_command.count("-i") == 4
      and all(path in geometry_command for path in
              (geometry_performance, rotated_cutaway, sar_cutaway,
               combined_cutaway))
      and unscheduled_cutaway not in geometry_command
      and rejected_cutaway not in geometry_command
      and geometry_reports[os.path.basename(unscheduled_cutaway)]["state"]
      == "skipped"
      and not geometry_reports[os.path.basename(
          unscheduled_cutaway)]["display_geometry_normalized"]
      and geometry_rep["opened_cutaway_sources"]
      == [os.path.basename(rotated_cutaway),
          os.path.basename(sar_cutaway),
          os.path.basename(combined_cutaway)])
check("only scheduled selected cutaway streams get square-pixel filters",
      all((f"[{input_index}:v:0]scale={display_width}:{display_height}:"
           f"flags=lanczos,setsar=1[cutaway_display_{input_index}]")
          in geometry_filter
          for input_index, (display_width, display_height) in enumerate(
              expected_cutaway_geometry.values(), start=1))
      and "cutaway_display_4" not in geometry_filter
      and "cutaway_display_5" not in geometry_filter)


def visible_content_raster(path, at_s):
    raw = subprocess.check_output([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
        "-ss", f"{at_s:.3f}", "-frames:v", "1", "-f", "rawvideo",
        "-pix_fmt", "rgb24", "pipe:1",
    ])
    frame = np.frombuffer(raw, dtype=np.uint8).reshape(180, 320, 3)
    visible = np.max(frame, axis=2) > 40
    rows, columns = np.where(visible)
    assert len(rows) and len(columns), "scheduled cutaway frame was black"
    return (int(columns.max() - columns.min() + 1),
            int(rows.max() - rows.min() + 1))


rendered_aspects = {}
for scene in geometry_rep["manifest"]["scenes"]:
    if scene["role"] != "cutaway":
        continue
    record = next(item for item in scheduled_geometry_reports
                  if item["asset_index"] == scene["asset_index"])
    frame_range = scene["output_frame_range"]
    midpoint_s = (frame_range["start"] + frame_range["end"]) / 2.0
    raster = visible_content_raster(geometry_out, midpoint_s)
    rendered_aspects[record["basename"]] = raster[0] / raster[1]
check("rendered cutaway pixels retain rotated/SAR/combined display shape",
      all(abs(rendered_aspects[name] / (display_width / display_height) - 1.0)
              < 0.08
              for name, (display_width, display_height)
              in expected_cutaway_geometry.items()),
      str(rendered_aspects))
output_geometry_stream = scenes.media_tools.video_stream_at(
    scenes.media_tools.probe_media(geometry_out), 0)
output_display_geometry = scenes.media_tools.video_display_geometry(
    output_geometry_stream)
check("cutaway director preserves protected source and master-audio authority",
      geometry_rep["summary"]["has_audio"] is False
      and geometry_rep["manifest"]["authority"]["performance_motion"]
      == "selected-source-video"
      and geometry_rep["manifest"]["authority"]["master_audio"] == "iplay"
      and geometry_rep["cutaway_policy"]["master_audio_timeline_unchanged"]
      and output_display_geometry["sample_aspect_ratio"] == "1/1"
      and output_display_geometry["rotation_degrees"] == 0
      and int(output_geometry_stream["nb_frames"]) == 144)

try:
    scenes.stitch_scenes([], [], music, os.path.join(tmp, "x.mp4"), 1.0)
    check("empty stitch raises", False)
except scenes.SceneStitchError:
    check("empty stitch raises", True)

# ---------------------------------------------------------------------------#
print("--- pipeline wiring ---")
import pipeline  # noqa: E402

check("face_scenes_stage exists", hasattr(pipeline, "face_scenes_stage"))
check("skipped without sources",
      pipeline.face_scenes_stage([], music, fake_timing(20), "x.mp4")
      ["status"] == "skipped")
with tempfile.NamedTemporaryFile(suffix=".jpg") as identity:
    staged = pipeline.face_scenes_stage(
        [identity.name], music, fake_timing(20), "x.mp4")
check("HeyGen production path is staged without paid motion generation",
      staged["status"] == "staged"
      and staged["paid_calls_made"] is False
      and staged["motion_source"] == "iplay"
      and staged["heygen_scope"] == "non_performance_assets_only")
import inspect  # noqa: E402
sig = inspect.signature(pipeline.build_video)
check("build_video takes full_song_scenes + guitar_variant",
      "full_song_scenes" in sig.parameters
      and "guitar_variant" in sig.parameters)

print(f"\nALL CHECKS PASSED ({PASS})")
