"""Repository and local-settings safety checks; no network or API calls."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import pipeline  # noqa: E402


with open(os.path.join(ROOT, ".gitignore"), "rb") as fh:
    ignore_bytes = fh.read()
assert not ignore_bytes.startswith(b"\xef\xbb\xbf"), ".gitignore starts with a UTF-8 BOM"
ignore_lines = ignore_bytes.decode("utf-8").splitlines()
assert ".env" in ignore_lines
assert "iplay/settings.json" in ignore_lines

example_path = os.path.join(HERE, "settings.example.json")
with open(example_path, encoding="utf-8") as fh:
    example = json.load(fh)
assert "heygen_api_key" not in example
assert "youtube_quality" in example

with open(os.path.join(HERE, "refs", "manifest.json"), encoding="utf-8") as fh:
    refs = json.load(fh)
ref_names = [entry["file"] for entry in refs.values()]
assert all(name.endswith("_raw.webm") for name in ref_names), ref_names

git = subprocess.run(["git", "-C", ROOT, "rev-parse", "--is-inside-work-tree"],
                     capture_output=True, text=True)
if git.returncode == 0:
    tracked = subprocess.check_output(
        ["git", "-C", ROOT, "ls-files"], text=True).splitlines()
    assert "iplay/settings.json" not in tracked, "local credential settings are tracked"
    assert not any(path in {".env", "iplay/.env"} for path in tracked)
    for name in ref_names:
        assert f"iplay/refs/{name}" in tracked, f"manifest asset is not tracked: {name}"

old_path = pipeline.SETTINGS_PATH
with tempfile.TemporaryDirectory(prefix="iplay_settings_") as tmp:
    pipeline.SETTINGS_PATH = os.path.join(tmp, "settings.json")
    try:
        defaults = pipeline.load_settings()
        assert "heygen_api_key" not in defaults
        defaults["youtube_quality"] = "best_h264"
        defaults["youtube_dir"] = os.path.join(tmp, "library")
        defaults["heygen_api_key"] = "must-not-be-persisted"
        pipeline.save_settings(defaults)
        assert pipeline.load_settings()["youtube_quality"] == "best_h264"
        with open(pipeline.SETTINGS_PATH, encoding="utf-8") as fh:
            saved = json.load(fh)
        assert "heygen_api_key" not in saved
        assert saved["youtube_dir"] == os.path.join(tmp, "library")
    finally:
        pipeline.SETTINGS_PATH = old_path

print("repository hygiene checks passed")
