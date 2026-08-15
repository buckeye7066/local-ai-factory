"""IPlay Exact Performance UI: full-character avatar replacement only."""
from __future__ import annotations

import os
import queue
import threading
import traceback
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import performance_transfer as transfer

BG = "#1e2126"; PANEL = "#282c33"; FG = "#e6e6e6"; DIM = "#9aa4b0"
ACCENT = "#4f9cf0"; BTN = "#3a7bd5"


class ExactAvatarApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("IPlay — Full Avatar Exact Performance")
        root.configure(bg=BG); root.geometry("840x740"); root.minsize(720, 620)
        self.performance = tk.StringVar(); self.avatar = tk.StringVar()
        self.instrument = tk.StringVar(value="guitar"); self.variant = tk.StringVar(value="electric")
        self.wan_home = tk.StringVar(value=os.environ.get("IPLAY_WAN_HOME", ""))
        self.wan_ckpt = tk.StringVar(value=os.environ.get("IPLAY_WAN_ANIMATE_CKPT", ""))
        self.output = tk.StringVar(value=os.path.join(
            transfer.pipeline.default_videos_dir("IPlay"), "full_avatar_performance.mp4"))
        self.uhd = tk.BooleanVar(value=True)
        self.rights = tk.BooleanVar(value=False)
        self._cancel = None; self._busy = False
        self._queue: queue.Queue = queue.Queue()

        self._path_row("Performance", self.performance, self._pick_performance,
                       "Real synchronized performance of the target song. It drives motion only; the source performer is not the final character.")
        self._path_row("Avatar", self.avatar, self._pick_avatar,
                       "Photo or footage defining the complete final performer: face, body, clothing and instrument appearance.")
        self._path_row("Wan2.2", self.wan_home, self._pick_wan,
                       "Official local Wan2.2 checkout used for full-character replacement preprocessing.")
        self._path_row("Animate model", self.wan_ckpt, self._pick_ckpt,
                       "Wan2.2-Animate-14B checkpoint folder containing process_checkpoint.")
        self._path_row("Output", self.output, self._pick_output,
                       "Final avatar-only performance. Exact mode never falls back to the original musician.")

        row = tk.Frame(root, bg=BG); row.pack(fill="x", padx=14, pady=6)
        tk.Label(row, text="Instrument", width=14, anchor="w", bg=BG, fg=FG).pack(side="left")
        for name in transfer.pipeline.INSTRUMENTS:
            tk.Radiobutton(row, text=name.capitalize(), value=name, variable=self.instrument,
                           bg=BG, fg=FG, selectcolor=PANEL, activebackground=BG,
                           activeforeground=FG).pack(side="left", padx=(0, 10))
        tk.Label(row, text="Guitar", bg=BG, fg=DIM).pack(side="left", padx=(12, 4))
        menu = tk.OptionMenu(row, self.variant, "acoustic", "electric", "bass")
        menu.configure(bg=PANEL, fg=FG, activebackground=ACCENT, relief="flat", highlightthickness=0)
        menu["menu"].configure(bg=PANEL, fg=FG, activebackground=ACCENT); menu.pack(side="left")
        tk.Checkbutton(row, text="UHD", variable=self.uhd, bg=BG, fg=FG,
                       selectcolor=PANEL, activebackground=BG, activeforeground=FG).pack(side="right")

        rights_row = tk.Frame(root, bg=BG); rights_row.pack(fill="x", padx=14, pady=(4, 0))
        tk.Checkbutton(
            rights_row,
            text="I have rights/consent to use this performance and avatar (required for export)",
            variable=self.rights, bg=BG, fg=FG, selectcolor=PANEL,
            activebackground=BG, activeforeground=FG, wraplength=780, justify="left",
            anchor="w").pack(fill="x")

        notice = ("FULL REPLACEMENT: IPlay regenerates the entire visible performer scene-by-scene from the avatar reference while the real performance drives motion. "
                  "No source head, torso, arms, hands or clothing are intentionally preserved. If a scene fails or truncates, rendering stops instead of exposing the source musician.")
        tk.Label(root, text=notice, bg=BG, fg=DIM, justify="left", wraplength=800,
                 anchor="w").pack(fill="x", padx=14, pady=(6, 10))

        buttons = tk.Frame(root, bg=BG); buttons.pack(fill="x", padx=14, pady=(0, 8))
        self.render_btn = tk.Button(buttons, text="Render Full Avatar Performance", command=self.render,
                                    bg=BTN, fg="white", activebackground=ACCENT, relief="flat",
                                    font=("Segoe UI", 12, "bold"), pady=9)
        self.render_btn.pack(side="left", fill="x", expand=True)
        self.cancel_btn = tk.Button(buttons, text="Cancel", command=self.cancel, bg=PANEL, fg=FG,
                                    relief="flat", padx=18, state="disabled")
        self.cancel_btn.pack(side="left", padx=(8, 0))
        self.progress = ttk.Progressbar(root, maximum=1000, mode="determinate")
        self.progress.pack(fill="x", padx=14, pady=(0, 4))
        self.progress_label = tk.Label(root, text="Idle", bg=BG, fg=DIM, anchor="w")
        self.progress_label.pack(fill="x", padx=14)
        frame = tk.Frame(root, bg=BG); frame.pack(fill="both", expand=True, padx=14, pady=10)
        self.log = tk.Text(frame, bg="#15171b", fg="#c8e0c8", relief="flat",
                           font=("Consolas", 9), state="disabled", wrap="word")
        scroll = tk.Scrollbar(frame, command=self.log.yview); self.log.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y"); self.log.pack(side="left", fill="both", expand=True)
        root.after(50, self._drain)

    def _path_row(self, label, var, picker, help_text):
        row = tk.Frame(self.root, bg=BG); row.pack(fill="x", padx=14, pady=(8, 0))
        tk.Label(row, text=label, width=14, anchor="w", bg=BG, fg=FG).pack(side="left")
        tk.Entry(row, textvariable=var, bg=PANEL, fg=FG, insertbackground=FG,
                 relief="flat").pack(side="left", fill="x", expand=True, padx=(0, 8), ipady=4)
        tk.Button(row, text="Browse", command=picker, bg=PANEL, fg=FG,
                  activebackground=ACCENT, relief="flat").pack(side="left")
        tk.Label(self.root, text=help_text, bg=BG, fg=DIM, anchor="w", justify="left",
                 wraplength=800).pack(fill="x", padx=14, pady=(2, 0))

    def _pick_performance(self):
        p = filedialog.askopenfilename(title="Choose synchronized performance video")
        if p:
            self.performance.set(p); stem = os.path.splitext(os.path.basename(p))[0]
            self.output.set(os.path.join(transfer.pipeline.default_videos_dir("IPlay"),
                                         transfer.pipeline.safe_output_stem(stem) + "_full_avatar.mp4"))
    def _pick_avatar(self):
        p = filedialog.askopenfilename(title="Choose avatar photo or footage")
        if p: self.avatar.set(p)
    def _pick_wan(self):
        p = filedialog.askdirectory(title="Choose official Wan2.2 folder")
        if p: self.wan_home.set(p)
    def _pick_ckpt(self):
        p = filedialog.askdirectory(title="Choose Wan2.2-Animate-14B checkpoint folder")
        if p: self.wan_ckpt.set(p)
    def _pick_output(self):
        p = filedialog.asksaveasfilename(title="Final video", defaultextension=".mp4",
                                         filetypes=[("MP4 video", "*.mp4")])
        if p: self.output.set(p)

    def _append(self, text):
        self.log.configure(state="normal"); self.log.insert("end", text + "\n"); self.log.see("end")
        self.log.configure(state="disabled")
    def log_line(self, text): self._queue.put(("log", str(text)))
    def stage(self, fraction, label): self._queue.put(("stage", (float(fraction), str(label))))
    def _drain(self):
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == "log": self._append(payload)
                elif kind == "stage":
                    frac, label = payload; self.progress.configure(value=max(0, min(1000, int(frac * 1000))))
                    self.progress_label.configure(text=f"{frac * 100:.0f}% — {label}")
                elif kind == "done": self._finish(payload)
                elif kind == "error": self._fail(payload)
        except queue.Empty: pass
        self.root.after(50, self._drain)

    def render(self):
        if self._busy: return
        performance = self.performance.get().strip(); avatar = self.avatar.get().strip()
        output = self.output.get().strip(); instrument = self.instrument.get()
        variant = self.variant.get() if instrument == "guitar" else None
        wan_home = self.wan_home.get().strip() or None; wan_ckpt = self.wan_ckpt.get().strip() or None
        uhd = bool(self.uhd.get())
        for label, path in (("Performance", performance), ("Avatar", avatar)):
            if not path or not os.path.isfile(path):
                messagebox.showerror("IPlay", f"Choose an existing {label.lower()} file."); return
        if not output: messagebox.showerror("IPlay", "Choose an output file."); return
        if not bool(self.rights.get()):
            messagebox.showerror(
                "IPlay",
                "Confirm rights/consent to use the performance and avatar before rendering.")
            return
        out_dir = os.path.dirname(os.path.abspath(output))
        if out_dir: os.makedirs(out_dir, exist_ok=True)
        self._busy = True; self._cancel = threading.Event(); self.render_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal"); self._append("=== Full-avatar exact-performance render ===")
        threading.Thread(target=self._worker,
                         args=(performance, avatar, output, instrument, variant, wan_home, wan_ckpt, uhd,
                               True, self._cancel),
                         daemon=True).start()

    def _worker(self, performance, avatar, output, instrument, variant, wan_home, wan_ckpt, uhd,
                rights_acknowledged, cancel_event):
        try:
            report = transfer.render_exact_avatar_performance(
                performance, avatar, instrument, output, wan_home=wan_home,
                wan_checkpoint=wan_ckpt, uhd=uhd, guitar_variant=variant,
                rights_acknowledged=rights_acknowledged,
                progress_cb=self.log_line, stage_cb=self.stage, cancel_event=cancel_event)
            self._queue.put(("done", report))
        except Exception as exc:
            self.log_line(traceback.format_exc()); self._queue.put(("error", str(exc) or repr(exc)))
    def cancel(self):
        if self._cancel is not None: self._cancel.set(); self.log_line("Cancellation requested...")
    def _finish(self, report):
        self._busy = False; self.render_btn.configure(state="normal"); self.cancel_btn.configure(state="disabled")
        self.progress.configure(value=1000); self.progress_label.configure(text="100% — Complete")
        self._append("OUTPUT: " + str(report.get("out"))); self._append("MOTION: " + str(report.get("motion_accuracy")))
        messagebox.showinfo("IPlay", "Full avatar performance completed.\n\n" + str(report.get("out")))
    def _fail(self, message):
        self._busy = False; self.render_btn.configure(state="normal"); self.cancel_btn.configure(state="disabled")
        self.progress_label.configure(text="Stopped — source performer was not substituted")
        messagebox.showerror("IPlay — full avatar performance", message[:1800])


def main():
    root = tk.Tk(); ExactAvatarApp(root); root.mainloop()

if __name__ == "__main__": main()
