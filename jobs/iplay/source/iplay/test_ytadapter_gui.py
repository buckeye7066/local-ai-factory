"""Functional test of the IPlay YouTube adapter + its GUI wiring.

Drives the real Tk widgets (no mocks): builds the app, opens the Library
picker, waits for the background scan, selects a row, and clicks "Use
selected" -- then asserts the Music field actually changed.
"""
import os
import sys
import time

IPLAY = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, IPLAY)

import tkinter as tk
from tkinter import ttk

import ytadapter
import iplay_app

FAILURES = []


def check(label, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {detail}" if detail else ""))
    if not cond:
        FAILURES.append(label)


def find(widget, cls, text=None):
    """Depth-first search for a widget of type cls (optionally by label)."""
    for w in widget.winfo_children():
        if isinstance(w, cls):
            if text is None:
                return w
            try:
                if w.cget("text") == text:
                    return w
            except tk.TclError:
                pass
        hit = find(w, cls, text)
        if hit is not None:
            return hit
    return None


def run_until(root, ready, timeout=40):
    """Spin a REAL main loop until ready() or timeout.

    root.update() is not enough: the picker's scan thread returns through
    root.after(), and tkinter only dispatches cross-thread calls while
    mainloop() is actually running.
    """
    state = {"ok": False, "deadline": time.time() + timeout}

    def poll():
        if ready():
            state["ok"] = True
            root.quit()
            return
        if time.time() > state["deadline"]:
            root.quit()
            return
        root.after(100, poll)

    root.after(50, poll)
    root.mainloop()
    return state["ok"]


print("=== 1. adapter surface ===")
check("QUALITY presets have required keys",
      all({"label", "format", "merge"} <= set(v) for v in ytadapter.QUALITY.values()))
check("DEFAULT_QUALITY is a real preset",
      ytadapter.DEFAULT_QUALITY in ytadapter.QUALITY, ytadapter.DEFAULT_QUALITY)
check("is_youtube_url accepts youtu.be",
      ytadapter.is_youtube_url("https://youtu.be/v5y2BBXABvU"))
check("is_youtube_url accepts full watch URL",
      ytadapter.is_youtube_url("https://www.youtube.com/watch?v=abc"))
check("is_youtube_url rejects a bare path",
      not ytadapter.is_youtube_url(r"C:\Users\Example\Downloads\x.mp4"))
check("is_youtube_url rejects vimeo",
      not ytadapter.is_youtube_url("https://vimeo.com/12345"))

print("\n=== 2. library scan ===")
t0 = time.time()
entries = ytadapter.list_library()
print(f"  scanned in {time.time() - t0:.2f}s -> {len(entries)} entries")
for e in entries:
    print(f"    {ytadapter.fmt_res(e):>10} {ytadapter.fmt_duration(e['duration_s']):>8}"
          f" {e['size_mb']:>8.1f}MB  lib={str(e['in_library']):5} {e['title'][:52]}")
check("found at least one download", len(entries) >= 1)
check("titles have the [videoid] stripped",
      all("[" not in (e["title"] or "")[-14:] for e in entries))
check("every entry has a real duration",
      all(e.get("duration_s") for e in entries))
check("every entry resolves a youtube id",
      all(e.get("id") for e in entries), str([e.get("id") for e in entries]))
check("every entry has a usable url",
      all((e.get("url") or "").startswith("http") for e in entries))
check("no .info.json sidecar leaked into the list",
      all(not e["path"].endswith(".json") for e in entries))

print("\n=== 3. GUI construction ===")
root = tk.Tk()
root.geometry("760x760")
app = iplay_app.IPlayApp(root)
root.update()
check("YouTube URL field exists", hasattr(app, "yt_url"))
check("Download button exists", hasattr(app, "dl_btn"))
check("quality var initialised from settings",
      app.yt_quality.get() in [v["label"] for v in ytadapter.QUALITY.values()],
      app.yt_quality.get())

print("\n=== 4. quality label -> key mapping ===")
ok = True
for key, preset in ytadapter.QUALITY.items():
    app.yt_quality.set(preset["label"])
    got = app._quality_key()
    if got != key:
        ok = False
        print(f"    {preset['label']!r} -> {got!r}, expected {key!r}")
check("every preset label maps back to its key", ok)
app.yt_quality.set(ytadapter.QUALITY[ytadapter.get_quality()]["label"])

print("\n=== 5. Library picker end-to-end ===")
app.music_path.set("")
app.open_library()
root.update()
win = None
for w in root.winfo_children():
    if isinstance(w, tk.Toplevel):
        win = w
check("library window opened", win is not None)

tree = find(win, ttk.Treeview) if win else None
check("treeview built", tree is not None)

got_rows = run_until(root, lambda: tree is not None and bool(tree.get_children()))
rows = tree.get_children() if tree is not None else ()
check("scan populated the picker", got_rows, f"{len(rows)} row(s)")

if rows:
    first = rows[0]
    tree.selection_set(first)
    shown = tree.item(first, "text")
    vals = tree.item(first, "values")
    print(f"    row0: {shown[:50]!r} {vals}")
    check("row shows a resolution or 'audio'",
          vals[0] not in ("", "?"), vals[0])
    check("row shows a length", vals[1] != "?", vals[1])

    btn = find(win, tk.Button, "Use selected")
    check("'Use selected' button found", btn is not None)
    if btn is not None:
        btn.invoke()
        root.update()
        picked = app.music_path.get()
        print(f"    music_path -> {picked}")
        check("clicking Use selected fills the Music field", bool(picked))
        check("picked file exists on disk", os.path.exists(picked))
        check("library window closed after pick", not win.winfo_exists())

root.destroy()

print("\n" + "=" * 60)
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    sys.exit(1)
print("ALL CHECKS PASSED")
