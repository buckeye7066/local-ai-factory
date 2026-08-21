"""IPlay Studio — the intentional front door for musical-performance work.

This screen does not perform rendering itself.  It makes the performance
contract, creative choice, and delivery state understandable before a user
invests GPU time.  The existing exact and approximation applications remain
the execution surfaces.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tkinter as tk
from tkinter import messagebox


INK = "#10172A"
SURFACE = "#18223B"
SURFACE_2 = "#202D4B"
TEXT = "#F5F7FF"
MUTED = "#AFBCD6"
BLUE = "#73A9FF"
MINT = "#69E6C2"
AMBER = "#FFD085"
STROKE = "#314264"


class StudioShell:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        root.title("IPlay Studio")
        root.configure(bg=INK)
        root.geometry("980x700")
        root.minsize(860, 610)
        root.protocol("WM_DELETE_WINDOW", root.destroy)
        self._build()

    def _label(self, parent, text, *, size=11, weight="normal", color=TEXT, **kwargs):
        return tk.Label(parent, text=text, bg=parent.cget("bg"), fg=color,
                        font=("Segoe UI", size, weight), **kwargs)

    def _build(self) -> None:
        header = tk.Frame(self.root, bg=INK)
        header.pack(fill="x", padx=44, pady=(36, 14))
        self._label(header, "IPLAY", size=11, weight="bold", color=BLUE).pack(anchor="w")
        self._label(header, "Turn a real performance into a believable avatar film.",
                    size=26, weight="bold", wraplength=830, justify="left").pack(anchor="w", pady=(4, 4))
        self._label(header,
                    "Musical motion stays anchored to evidence. Your avatar, direction, and final delivery are yours.",
                    size=12, color=MUTED, wraplength=840, justify="left").pack(anchor="w")

        status = tk.Frame(self.root, bg=SURFACE_2, highlightbackground=STROKE,
                          highlightthickness=1)
        status.pack(fill="x", padx=44, pady=(0, 22))
        for title, value, detail, color in (
            ("MOTION AUTHORITY", "Source-led", "Exact mode uses synchronized performance evidence", MINT),
            ("SOUNDTRACK", "Protected", "One continuous master audio track", BLUE),
            ("DELIVERY GATE", "Visual QA", "GPU render must pass scene-level review", AMBER),
        ):
            item = tk.Frame(status, bg=SURFACE_2)
            item.pack(side="left", fill="both", expand=True, padx=18, pady=14)
            self._label(item, title, size=8, weight="bold", color=MUTED).pack(anchor="w")
            self._label(item, value, size=14, weight="bold", color=color).pack(anchor="w", pady=(2, 1))
            self._label(item, detail, size=9, color=MUTED, wraplength=220, justify="left").pack(anchor="w")

        choices = tk.Frame(self.root, bg=INK)
        choices.pack(fill="both", expand=True, padx=44)
        self._mode_card(
            choices, "01  Full Avatar Performance", "For a real, synchronized musician performance",
            "Use this when the source video already contains the actual playing. IPlay treats it as motion evidence, regenerates the entire visible performer as your avatar, preserves the original master audio, and stops if a scene cannot be replaced cleanly.",
            "Create exact performance", BLUE, self._launch_exact, "Recommended")
        self._mode_card(
            choices, "02  Beat-Timed Study", "For audio-only or early concept work",
            "Build a tasteful, beat-synchronized study using instrument-aware direction. This mode is clearly labeled as an approximation; it is not presented as verified fingering, bow contact, or chord performance.",
            "Create timing study", "#415575", self._launch_approx, "Exploratory")

        footer = tk.Frame(self.root, bg=INK)
        footer.pack(fill="x", padx=44, pady=(18, 30))
        tk.Button(footer, text="Open renders folder", command=self._open_renders,
                  bg=INK, fg=BLUE, activebackground=INK, activeforeground=TEXT,
                  relief="flat", cursor="hand2", font=("Segoe UI", 10, "underline")).pack(side="left")
        tk.Button(footer, text="What IPlay verifies", command=self._show_contract,
                  bg=INK, fg=MUTED, activebackground=INK, activeforeground=TEXT,
                  relief="flat", cursor="hand2", font=("Segoe UI", 10, "underline")).pack(side="right")

    def _mode_card(self, parent, title, subtitle, description, action, color, command, tag):
        card = tk.Frame(parent, bg=SURFACE, highlightbackground=STROKE, highlightthickness=1)
        card.pack(side="left", fill="both", expand=True, padx=(0, 10) if "01" in title else (10, 0))
        body = tk.Frame(card, bg=SURFACE)
        body.pack(fill="both", expand=True, padx=24, pady=22)
        self._label(body, tag.upper(), size=8, weight="bold", color=color).pack(anchor="w")
        self._label(body, title, size=17, weight="bold", wraplength=385, justify="left").pack(anchor="w", pady=(7, 2))
        self._label(body, subtitle, size=10, color=MUTED, wraplength=385, justify="left").pack(anchor="w", pady=(0, 15))
        self._label(body, description, size=10, color=MUTED, wraplength=385, justify="left").pack(anchor="w", fill="x")
        tk.Frame(body, bg=SURFACE).pack(fill="both", expand=True)
        tk.Button(body, text=action + "  →", command=command, bg=color,
                  fg=INK if color in (BLUE, AMBER, MINT) else TEXT,
                  activebackground=color, relief="flat", cursor="hand2",
                  font=("Segoe UI", 11, "bold"), padx=16, pady=10).pack(anchor="w", pady=(20, 0))

    def _launch(self, module: str) -> None:
        self.root.destroy()
        __import__(module).main()

    def _launch_exact(self) -> None:
        self._launch("exact_avatar_app")

    def _launch_approx(self) -> None:
        self._launch("iplay_app")

    def _open_renders(self) -> None:
        path = os.path.join(os.path.expanduser("~"), "Videos", "IPlay")
        os.makedirs(path, exist_ok=True)
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
        except OSError as exc:
            messagebox.showerror("IPlay Studio", f"Could not open render folder:\n{exc}")

    def _show_contract(self) -> None:
        messagebox.showinfo(
            "IPlay verification contract",
            "Exact performance mode verifies media coverage, scene duration, a protected master soundtrack, replacement coverage, and timeline continuity.\n\n"
            "It does not claim mathematical proof of every generated finger, fret, bow, pick, string, or key contact. Those require the final visual review gate.\n\n"
            "Beat-Timed Study is intentionally labeled as an approximation.")


def main() -> None:
    root = tk.Tk()
    StudioShell(root)
    root.mainloop()


if __name__ == "__main__":
    main()
