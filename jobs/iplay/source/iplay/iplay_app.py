"""IPlay — tkinter GUI over pipeline.build_video.

Pick a music file + person photo(s) + instrument, get a beat-synced player
video. Pipeline runs on a background thread; the log pane is the progress_cb.
"""
from __future__ import annotations

import os
import queue
import sys
import threading
import time
import traceback

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import camera  # noqa: E402
import pipeline  # noqa: E402
import ytadapter  # noqa: E402

try:
    from PIL import Image, ImageTk  # live camera preview
    _HAVE_PIL = True
except ImportError:  # recording still works, just without a preview
    _HAVE_PIL = False

# --- palette (dark-ish clean) ---
BG = "#1e2126"
PANEL = "#282c33"
FG = "#e6e6e6"
DIM = "#9aa4b0"
ACCENT = "#4f9cf0"
BTN = "#3a7bd5"
BTN_FG = "#ffffff"
LOG_BG = "#15171b"
LOG_FG = "#c8e0c8"

def _globs(exts) -> str:
    return " ".join(f"*{e}" for e in sorted(exts))


MUSIC_TYPES = [("Music / video", _globs(pipeline.AUDIO_EXTS | pipeline.VIDEO_EXTS)),
               ("Video (incl. YouTube downloads)", _globs(pipeline.VIDEO_EXTS)),
               ("Audio", _globs(pipeline.AUDIO_EXTS)),
               ("All files", "*.*")]
# Optional photos/footage are identity inputs for a future, tightly scoped
# production-asset adapter. They never replace protected hands, instrument
# geometry, or performance motion in the supported pipeline.
FACE_TYPES = [("Photo or footage",
               _globs(pipeline.FACE_IMAGE_EXTS | pipeline.FACE_VIDEO_EXTS)),
              ("Photos", _globs(pipeline.FACE_IMAGE_EXTS)),
              ("Footage (video)", _globs(pipeline.FACE_VIDEO_EXTS)),
              ("All files", "*.*")]
MOOD_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
MOOD_EXTS = MOOD_IMAGE_EXTS | pipeline.VIDEO_EXTS
MOOD_TYPES = [("Mood / B-roll images or video", _globs(MOOD_EXTS)),
              ("Images", _globs(MOOD_IMAGE_EXTS)),
              ("Video", _globs(pipeline.VIDEO_EXTS))]


def default_output_dir() -> str:
    """The current user's Videos/IPlay folder with the shared drive guard."""
    return pipeline.default_videos_dir("IPlay")


class IPlayApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("IPlay")
        _icon = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "assets", "piano.ico")
        if os.path.exists(_icon):
            try:
                root.iconbitmap(default=_icon)
            except tk.TclError:
                pass  # icon is cosmetic; never block startup on it
        root.configure(bg=BG)
        root.geometry("760x680")
        root.minsize(620, 520)

        self.music_path = tk.StringVar()
        self.photos: list[str] = []
        self.cutaway_files: list[str] = []
        self.cutaway_count = tk.StringVar(
            value="0 assets — used locally/uninspected; master audio stays continuous")
        self.instrument = tk.StringVar(value="piano")
        self.uhd = tk.BooleanVar(value=True)
        self.source_performance = tk.BooleanVar(value=False)
        self.local_director = tk.BooleanVar(value=True)
        self.full_scenes = tk.BooleanVar(value=False)
        self.guitar_variant = tk.StringVar(value="acoustic")
        self.out_dir = tk.StringVar(value=default_output_dir())
        self._busy = False
        self._dl_busy = False
        self._lib_entries: list[dict] = []
        self._main_thread_id = threading.get_ident()
        self._ui_queue: queue.Queue = queue.Queue()
        self._closing = False
        self._render_cancel: threading.Event | None = None
        self._render_thread: threading.Thread | None = None
        self._camera_stops: set[threading.Event] = set()

        pad = {"padx": 12, "pady": 4}

        # --- music row ---
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", **pad)
        tk.Label(row, text="Music", width=10, anchor="w", bg=BG, fg=FG).pack(side="left")
        tk.Entry(row, textvariable=self.music_path, bg=PANEL, fg=FG,
                 insertbackground=FG, relief="flat").pack(
            side="left", fill="x", expand=True, padx=(0, 8), ipady=4)
        tk.Button(row, text="Browse", command=self.browse_music,
                  bg=PANEL, fg=FG, activebackground=ACCENT,
                  relief="flat", padx=12).pack(side="left")
        tk.Button(row, text="Library", command=self.open_library,
                  bg=PANEL, fg=ACCENT, activebackground=ACCENT,
                  relief="flat", padx=12).pack(side="left", padx=(4, 0))

        # --- youtube row ---
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", **pad)
        tk.Label(row, text="YouTube", width=10, anchor="w", bg=BG, fg=FG).pack(side="left")
        self.yt_url = tk.StringVar()
        ent = tk.Entry(row, textvariable=self.yt_url, bg=PANEL, fg=FG,
                       insertbackground=FG, relief="flat")
        ent.pack(side="left", fill="x", expand=True, padx=(0, 8), ipady=4)
        ent.bind("<Return>", lambda _e: self.download_youtube())
        self.dl_btn = tk.Button(row, text="Download", command=self.download_youtube,
                                bg=PANEL, fg=FG, activebackground=ACCENT,
                                relief="flat", padx=12)
        self.dl_btn.pack(side="left")

        # --- youtube options row ---
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", padx=12, pady=(0, 4))
        tk.Label(row, text="Quality", width=10, anchor="w", bg=BG, fg=DIM).pack(side="left")
        self._q_label_to_key = {v["label"]: k for k, v in ytadapter.QUALITY.items()}
        q_labels = [v["label"] for v in ytadapter.QUALITY.values()]
        self.yt_quality = tk.StringVar(
            value=ytadapter.QUALITY[ytadapter.get_quality()]["label"])
        qm = tk.OptionMenu(row, self.yt_quality, *q_labels)
        qm.configure(bg=PANEL, fg=FG, activebackground=ACCENT, relief="flat",
                     highlightthickness=0, anchor="w", indicatoron=1)
        qm["menu"].configure(bg=PANEL, fg=FG,
                             activebackground=ACCENT, activeforeground=BTN_FG)
        qm.pack(side="left", fill="x", expand=True, padx=(0, 8))
        tk.Label(row, text="Cookies", bg=BG, fg=DIM).pack(side="left", padx=(0, 4))
        self.yt_cookies = tk.StringVar(value=ytadapter.get_cookie_browser())
        cm = tk.OptionMenu(row, self.yt_cookies, *ytadapter.COOKIE_BROWSERS)
        cm.configure(bg=PANEL, fg=FG, activebackground=ACCENT, relief="flat",
                     highlightthickness=0, width=7, anchor="w")
        cm["menu"].configure(bg=PANEL, fg=FG,
                             activebackground=ACCENT, activeforeground=BTN_FG)
        cm.pack(side="left")

        # --- synchronized performance declaration ---
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", padx=12, pady=(0, 4))
        tk.Label(row, text="Performance", width=10, anchor="w", bg=BG,
                 fg=DIM).pack(side="left")
        tk.Checkbutton(
            row,
            text=("Selected video is the actual synchronized performance, and "
                  "I have permission to use it"),
            variable=self.source_performance, bg=BG, fg=FG, selectcolor=PANEL,
            activebackground=BG, activeforeground=FG, anchor="w",
            justify="left").pack(side="left", fill="x", expand=True)

        # --- photos row ---
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", **pad)
        tk.Label(row, text="Face", width=10, anchor="w", bg=BG, fg=FG).pack(
            side="left", anchor="n")
        self.photo_list = tk.Listbox(row, height=3, bg=PANEL, fg=FG,
                                     relief="flat", selectbackground=ACCENT)
        self.photo_list.pack(side="left", fill="x", expand=True, padx=(0, 8))
        col = tk.Frame(row, bg=BG)
        col.pack(side="left", anchor="n")
        tk.Button(col, text="Browse", command=self.browse_photos,
                  bg=PANEL, fg=FG, activebackground=ACCENT,
                  relief="flat", padx=12).pack(fill="x")
        tk.Button(col, text="Record", command=self.record_face,
                  bg=PANEL, fg=ACCENT, activebackground=ACCENT,
                  relief="flat", padx=12).pack(fill="x", pady=(4, 0))
        tk.Button(col, text="Clear", command=self.clear_photos,
                  bg=PANEL, fg=DIM, relief="flat", padx=12).pack(fill="x", pady=(4, 0))

        # --- instrument + uhd row ---
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", **pad)
        tk.Label(row, text="Instrument", width=10, anchor="w", bg=BG, fg=FG).pack(side="left")
        for name in ("piano", "guitar", "violin"):
            tk.Radiobutton(row, text=name.capitalize(), value=name,
                           variable=self.instrument, bg=BG, fg=FG,
                           selectcolor=PANEL, activebackground=BG,
                           activeforeground=FG).pack(side="left", padx=(0, 10))
        tk.Checkbutton(row, text="UHD (2160p)", variable=self.uhd,
                       bg=BG, fg=FG, selectcolor=PANEL,
                       activebackground=BG, activeforeground=FG).pack(side="right")

        # --- scene direction row ---
        # The local edit is deterministic, always available, and keeps one
        # continuous master soundtrack. The separate HeyGen control only
        # stages a non-performance asset manifest; it makes no paid call yet.
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", padx=12, pady=(0, 4))
        tk.Label(row, text="Guitar type", width=10, anchor="w", bg=BG,
                 fg=DIM).pack(side="left")
        gm = tk.OptionMenu(row, self.guitar_variant,
                           "acoustic", "electric", "bass")
        gm.configure(bg=PANEL, fg=FG, activebackground=ACCENT, relief="flat",
                     highlightthickness=0, width=8, anchor="w")
        gm["menu"].configure(bg=PANEL, fg=FG,
                             activebackground=ACCENT, activeforeground=BTN_FG)
        gm.pack(side="left")
        tk.Checkbutton(
            row, text="Local cinematic edit (no API credits; original audio)",
            variable=self.local_director, bg=BG, fg=FG, selectcolor=PANEL,
            activebackground=BG, activeforeground=FG).pack(
            side="left", padx=(12, 0))

        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", padx=12, pady=(0, 4))
        tk.Label(row, text="", width=10, bg=BG).pack(side="left")
        tk.Checkbutton(
            row, text="HeyGen production assets manifest (b-roll/background "
                      "only; no submission or credits)",
            variable=self.full_scenes, bg=BG, fg=FG, selectcolor=PANEL,
            activebackground=BG, activeforeground=FG).pack(
            side="left", padx=(12, 0))

        # --- optional local mood / b-roll row ---
        # These files are cut into the local video-only director pass. Their
        # contents are not inspected, and the original master audio is muxed
        # once afterwards, so choosing them cannot replace the soundtrack.
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", padx=12, pady=(0, 4))
        tk.Label(row, text="Mood/B-roll", width=10, anchor="w", bg=BG,
                 fg=DIM).pack(side="left")
        tk.Label(row, textvariable=self.cutaway_count, anchor="w", bg=BG,
                 fg=FG).pack(side="left", fill="x", expand=True)
        tk.Button(row, text="Browse", command=self.browse_cutaways,
                  bg=PANEL, fg=FG, activebackground=ACCENT,
                  relief="flat", padx=12).pack(side="left")
        tk.Button(row, text="Clear", command=self.clear_cutaways,
                  bg=PANEL, fg=DIM, activebackground=ACCENT,
                  relief="flat", padx=12).pack(side="left", padx=(4, 0))

        # --- output dir row ---
        row = tk.Frame(root, bg=BG)
        row.pack(fill="x", **pad)
        tk.Label(row, text="Output", width=10, anchor="w", bg=BG, fg=FG).pack(side="left")
        tk.Entry(row, textvariable=self.out_dir, bg=PANEL, fg=FG,
                 insertbackground=FG, relief="flat").pack(
            side="left", fill="x", expand=True, padx=(0, 8), ipady=4)
        tk.Button(row, text="Browse", command=self.browse_outdir,
                  bg=PANEL, fg=FG, activebackground=ACCENT,
                  relief="flat", padx=12).pack(side="left")

        # --- create button ---
        create_row = tk.Frame(root, bg=BG)
        create_row.pack(fill="x", padx=12, pady=(10, 6))
        self.create_btn = tk.Button(
            create_row, text="Create Video", command=self.create_video,
            bg=BTN, fg=BTN_FG, activebackground=ACCENT, relief="flat",
            font=("Segoe UI", 14, "bold"), pady=10)
        self.create_btn.pack(side="left", fill="x", expand=True)
        self.cancel_btn = tk.Button(
            create_row, text="Cancel", command=self.cancel_render,
            bg=PANEL, fg=FG, activebackground=ACCENT, relief="flat",
            padx=18, pady=10, state="disabled")
        self.cancel_btn.pack(side="left", padx=(8, 0))

        # --- progress bar ---
        # Replaces the old "Rendering..." button label. The percentage comes
        # from real pipeline stage boundaries, and inside the long retime stage
        # from the count of ffmpeg passes actually completed - so it tracks work
        # DONE rather than animating a guess at time remaining.
        prog_wrap = tk.Frame(root, bg=BG)
        prog_wrap.pack(fill="x", padx=12, pady=(2, 6))
        pstyle = ttk.Style(root)
        try:
            pstyle.theme_use("clam")   # default themes ignore trough/bar colors
        except tk.TclError:
            pass
        pstyle.configure("IPlay.Horizontal.TProgressbar",
                         troughcolor=LOG_BG, background=ACCENT,
                         bordercolor=LOG_BG, lightcolor=ACCENT,
                         darkcolor=ACCENT, thickness=18)
        self.progress = ttk.Progressbar(
            prog_wrap, style="IPlay.Horizontal.TProgressbar",
            orient="horizontal", mode="determinate", maximum=1000)
        self.progress.pack(fill="x")
        self.progress_label = tk.Label(
            prog_wrap, text="Idle", bg=BG, fg=LOG_FG,
            font=("Segoe UI", 9), anchor="w")
        self.progress_label.pack(fill="x", pady=(3, 0))

        # --- log pane ---
        frame = tk.Frame(root, bg=BG)
        frame.pack(fill="both", expand=True, padx=12, pady=(4, 12))
        self.log = tk.Text(frame, bg=LOG_BG, fg=LOG_FG, relief="flat",
                           font=("Consolas", 9), state="disabled", wrap="word")
        sb = tk.Scrollbar(frame, command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log.pack(side="left", fill="both", expand=True)

        self.log_line("IPlay ready. Pick a music file, choose an instrument, "
                      "and hit Create Video.")
        self.log_line("Identity photos/footage are optional. They are staged "
                      "for future non-performance assets only; no HeyGen "
                      "generation or credits are used.")
        self.root.protocol("WM_DELETE_WINDOW", self._on_root_close)
        self.root.after(50, self._drain_ui_queue)

    # ---------------- helpers ----------------

    def log_line(self, text: str):
        """Thread-safe append to the log pane."""
        self._post_ui(self._append_log, str(text))

    def set_progress(self, frac: float, label: str = ""):
        """Thread-safe progress update; `frac` is 0..1 of the whole render."""
        frac = 0.0 if frac < 0.0 else (1.0 if frac > 1.0 else frac)
        self._post_ui(self._apply_progress, frac, str(label))

    def _apply_progress(self, frac: float, label: str):
        self.progress.configure(value=int(frac * 1000))
        pct = f"{frac * 100:.0f}%"
        self.progress_label.configure(text=f"{pct} — {label}" if label else pct)

    def reset_progress(self, label: str = "Idle"):
        self._post_ui(self._apply_reset, str(label))

    def _apply_reset(self, label: str):
        self.progress.configure(value=0)
        self.progress_label.configure(text=label)

    def _post_ui(self, callback, *args):
        """Marshal worker results without making any Tk call off-thread."""
        if self._closing:
            return
        if threading.get_ident() == self._main_thread_id:
            callback(*args)
        else:
            self._ui_queue.put((callback, args))

    def _drain_ui_queue(self):
        if self._closing:
            return
        while True:
            try:
                callback, args = self._ui_queue.get_nowait()
            except queue.Empty:
                break
            try:
                callback(*args)
            except tk.TclError:
                if not self._closing:
                    raise
        self.root.after(50, self._drain_ui_queue)

    def _append_log(self, text: str):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def browse_music(self):
        # Open IN the YouTube library so downloads are one click away; fall
        # back to home if nothing has been downloaded yet.
        init = ytadapter.library_dir()
        if not os.path.isdir(init):
            init = os.path.expanduser("~")
        p = filedialog.askopenfilename(
            title="Choose music — any video (MP4/WEBM/MKV/…, incl. YouTube "
                  "downloads) or audio (MP3/WAV/M4A/OPUS/…)",
            initialdir=init, filetypes=MUSIC_TYPES)
        if p:
            self.music_path.set(p)

    def browse_photos(self):
        ps = filedialog.askopenfilenames(
            title="Choose optional identity reference photo or footage "
                  "(never used to regenerate playing motion)",
            filetypes=FACE_TYPES)
        for p in ps:
            self.add_face_source(p)

    def add_face_source(self, path: str):
        """Add an optional identity reference without gating core rendering."""
        if path in self.photos:
            return
        kind = pipeline.face_source_kind(path)
        if kind == "video":
            try:
                info = camera._probe(path)
                self.log_line(f"[identity] footage {os.path.basename(path)}: "
                              f"{info.get('duration_s', 0):.1f}s accepted for "
                              "manifest staging; no performance call is made")
            except Exception as exc:
                self.log_line(f"[identity] could not inspect "
                              f"{os.path.basename(path)}: {exc}")
        self.photos.append(path)
        self.photo_list.insert("end", f"[{kind}]  {path}")

    def clear_photos(self):
        self.photos.clear()
        self.photo_list.delete(0, "end")

    def browse_cutaways(self):
        """Add local, uninspected mood assets for the video-only edit pass."""
        paths = filedialog.askopenfilenames(
            title=("Choose local mood / B-roll images or video "
                   "(uninspected; master audio stays continuous)"),
            filetypes=MOOD_TYPES)
        seen = {os.path.normcase(os.path.abspath(path))
                for path in self.cutaway_files}
        ignored: list[str] = []
        for path in paths:
            absolute = os.path.abspath(path)
            key = os.path.normcase(absolute)
            extension = os.path.splitext(absolute)[1].lower()
            if (extension not in MOOD_EXTS or not os.path.isfile(absolute)):
                ignored.append(os.path.basename(path))
                continue
            if key not in seen:
                self.cutaway_files.append(absolute)
                seen.add(key)
        self._update_cutaway_count()
        if ignored:
            self.log_line("[mood] ignored unsupported or missing asset(s): "
                          + ", ".join(ignored))

    def clear_cutaways(self):
        self.cutaway_files.clear()
        self._update_cutaway_count()

    def _update_cutaway_count(self):
        count = len(self.cutaway_files)
        noun = "asset" if count == 1 else "assets"
        self.cutaway_count.set(
            f"{count} {noun} — used locally/uninspected; "
            "master audio stays continuous")

    def record_face(self):
        """Film optional identity footage from the webcam, with a preview."""
        try:
            cams = camera.list_cameras()
            mics = camera.list_microphones()
        except camera.CameraError as e:
            messagebox.showerror("IPlay — camera", str(e))
            return
        if not cams:
            messagebox.showerror(
                "IPlay — camera",
                "No camera was found.\n\nA webcam disabled in Windows privacy "
                "settings, or already in use by another app, will not appear "
                "here — DirectShow devices are exclusive.")
            return

        win = tk.Toplevel(self.root)
        win.title("Record optional identity footage")
        win.configure(bg=BG)
        win.geometry("560x470")
        win.transient(self.root)

        state = {"frame": None, "busy": False, "path": None,
                 "stop": threading.Event(), "t0": 0.0, "want": 0}

        def dev_row(label, options, default):
            row = tk.Frame(win, bg=BG)
            row.pack(fill="x", padx=12, pady=4)
            tk.Label(row, text=label, width=9, anchor="w", bg=BG, fg=FG).pack(side="left")
            var = tk.StringVar(value=default)
            om = tk.OptionMenu(row, var, *options)
            om.configure(bg=PANEL, fg=FG, activebackground=ACCENT, relief="flat",
                         highlightthickness=0, anchor="w")
            om["menu"].configure(bg=PANEL, fg=FG, activebackground=ACCENT,
                                 activeforeground=BTN_FG)
            om.pack(side="left", fill="x", expand=True)
            return var

        cam_var = dev_row("Camera", cams, camera.default_camera() or cams[0])
        mic_var = dev_row("Mic", ["(none)"] + mics,
                          mics[0] if mics else "(none)")

        row = tk.Frame(win, bg=BG)
        row.pack(fill="x", padx=12, pady=4)
        tk.Label(row, text="Seconds", width=9, anchor="w", bg=BG, fg=FG).pack(side="left")
        dur_var = tk.IntVar(value=30)
        tk.Spinbox(row, from_=camera.MIN_FOOTAGE_S, to=camera.MAX_RECORD_S,
                   textvariable=dur_var, width=6, bg=PANEL, fg=FG,
                   insertbackground=FG, relief="flat",
                   buttonbackground=PANEL).pack(side="left")
        tk.Label(row, text=f"  Suggested {camera.MIN_FOOTAGE_S}–"
                           f"{camera.MAX_FOOTAGE_S}s; recorder limit "
                           f"{camera.MAX_RECORD_S}s",
                 bg=BG, fg=DIM).pack(side="left")

        # Fixed-size holder: the preview Label is empty until the first frame
        # arrives, and without a reserved box the whole dialog would jump the
        # moment recording starts.
        holder = tk.Frame(win, bg=LOG_BG, width=camera.PREVIEW_W,
                          height=camera.PREVIEW_H)
        holder.pack(padx=12, pady=(8, 4))
        holder.pack_propagate(False)
        preview = tk.Label(holder, bg=LOG_BG, fg=DIM, wraplength=camera.PREVIEW_W - 20,
                           text=("Live preview appears here\nonce recording starts."
                                 if _HAVE_PIL else
                                 "Preview unavailable\n(Pillow not installed) —\n"
                                 "recording still works."))
        preview.pack(expand=True)

        status = tk.Label(win, text="Ready.", bg=BG, fg=DIM, anchor="w",
                          justify="left", wraplength=520)
        status.pack(fill="x", padx=12, pady=(4, 2))
        tk.Label(win, bg=BG, fg=DIM, anchor="w", justify="left", wraplength=520,
                 text="Tip: face the camera straight on, keep still, even "
                      "lighting, no one else in frame. 30s of steady footage "
                      "is the most useful optional identity reference.").pack(
            fill="x", padx=12, pady=(0, 4))

        def draw():
            if not win.winfo_exists():
                return
            item = state["frame"]
            if item is not None and _HAVE_PIL:
                buf, w, h = item
                try:
                    img = ImageTk.PhotoImage(Image.frombytes("RGB", (w, h), buf))
                    preview.configure(image=img, text="")
                    preview.image = img  # keep a reference or Tk garbage-collects it
                except Exception:
                    pass
            if state["busy"]:
                left = max(0, state["want"] - (time.time() - state["t0"]))
                status.configure(text=f"Recording… {left:0.0f}s left "
                                      "(Stop finishes early)")
            win.after(80, draw)

        # Only the newest frame is kept: the capture thread overwrites this
        # slot while the UI timer samples it, so a slow UI drops frames
        # instead of building an unbounded backlog.
        def on_frame(buf, w, h):
            state["frame"] = (buf, w, h)

        def finish(rep):
            self._camera_stops.discard(state["stop"])
            if not win.winfo_exists():
                return
            state["busy"] = False
            btn_rec.configure(state="normal", text="Record")
            btn_stop.configure(state="disabled")
            ok, msg = camera.check_footage(rep["path"])
            state["path"] = rep["path"] if ok else None
            status.configure(text=("Recorded: " + msg) if ok else ("NOT USABLE — " + msg))
            btn_use.configure(state="normal" if ok else "disabled")
            self.log_line(f"[cam] {'OK' if ok else 'REJECTED'}: {msg}")

        def failed(msg):
            self._camera_stops.discard(state["stop"])
            if not win.winfo_exists():
                return
            state["busy"] = False
            btn_rec.configure(state="normal", text="Record")
            btn_stop.configure(state="disabled")
            status.configure(text="Recording failed — see the log.")
            self.log_line("[cam] FAILED: " + msg)
            messagebox.showerror("IPlay — camera", msg[:1500], parent=win)

        def worker(cam, mic, secs, path):
            try:
                rep = camera.record(cam, path, secs, mic=mic,
                                    preview_cb=on_frame,
                                    progress_cb=self.log_line,
                                    stop_event=state["stop"])
                self._post_ui(finish, rep)
            except Exception as e:
                msg = str(e) or repr(e)
                self._post_ui(failed, msg)

        def start():
            if state["busy"]:
                return
            secs = int(dur_var.get())
            out_dir = os.path.join(default_output_dir(), "face")
            try:
                os.makedirs(out_dir, exist_ok=True)
            except OSError as e:
                messagebox.showerror("IPlay", f"Cannot create {out_dir}:\n{e}",
                                     parent=win)
                return
            path = os.path.join(out_dir,
                                f"face_{time.strftime('%Y%m%d_%H%M%S')}.mp4")
            mic = None if mic_var.get() == "(none)" else mic_var.get()
            state.update({"busy": True, "stop": threading.Event(),
                          "t0": time.time(), "want": secs, "path": None})
            self._camera_stops.add(state["stop"])
            btn_rec.configure(state="disabled", text="Recording…")
            btn_stop.configure(state="normal")
            btn_use.configure(state="disabled")
            threading.Thread(target=worker,
                             args=(cam_var.get(), mic, secs, path),
                             daemon=True).start()

        def stop():
            state["stop"].set()
            status.configure(text="Stopping…")

        def use_clip():
            if state["path"]:
                self.add_face_source(state["path"])
                win.destroy()

        bar = tk.Frame(win, bg=BG)
        bar.pack(fill="x", padx=12, pady=10)
        btn_rec = tk.Button(bar, text="Record", command=start, bg=BTN, fg=BTN_FG,
                            activebackground=ACCENT, relief="flat", padx=18, pady=4)
        btn_rec.pack(side="left")
        btn_stop = tk.Button(bar, text="Stop", command=stop, bg=PANEL, fg=FG,
                             activebackground=ACCENT, relief="flat", padx=14,
                             pady=4, state="disabled")
        btn_stop.pack(side="left", padx=(8, 0))
        btn_use = tk.Button(bar, text="Use this clip", command=use_clip, bg=PANEL,
                            fg=ACCENT, activebackground=ACCENT, relief="flat",
                            padx=14, pady=4, state="disabled")
        btn_use.pack(side="left", padx=(8, 0))
        tk.Button(bar, text="Close", command=win.destroy, bg=PANEL, fg=DIM,
                  activebackground=ACCENT, relief="flat", padx=14,
                  pady=4).pack(side="right")

        # Releasing the camera matters: DirectShow devices are exclusive, so a
        # thread left recording would lock the webcam for every other app.
        def on_close():
            state["stop"].set()
            self._camera_stops.discard(state["stop"])
            win.destroy()

        win.protocol("WM_DELETE_WINDOW", on_close)
        win.after(80, draw)

    def browse_outdir(self):
        d = filedialog.askdirectory(title="Choose output folder",
                                    initialdir=self.out_dir.get())
        if d:
            self.out_dir.set(d)

    # ---------------- youtube ----------------

    def _quality_key(self) -> str:
        return self._q_label_to_key.get(self.yt_quality.get(),
                                        ytadapter.DEFAULT_QUALITY)

    def download_youtube(self):
        if self._dl_busy:
            return
        url = self.yt_url.get().strip()
        if not url:
            messagebox.showerror("IPlay", "Paste a YouTube URL first.")
            return
        if not ytadapter.is_youtube_url(url):
            if not messagebox.askyesno(
                    "IPlay", f"That does not look like a YouTube link:\n\n{url}"
                             "\n\nyt-dlp supports many other sites — try it anyway?"):
                return
        quality = self._quality_key()
        cookies = self.yt_cookies.get()
        # Persist the picks so the next launch remembers them.
        ytadapter.set_quality(quality)
        ytadapter.set_cookie_browser(cookies)

        self._dl_busy = True
        self.dl_btn.configure(state="disabled", text="Downloading…")
        self.log_line("")
        self.log_line(f"=== YouTube download: {url} ===")
        threading.Thread(target=self._dl_worker, args=(url, quality, cookies),
                         daemon=True).start()

    def _dl_worker(self, url: str, quality: str, cookies: str,
                   overwrite: bool = False):
        try:
            rep = ytadapter.download(url, quality=quality,
                                     progress_cb=self.log_line,
                                     cookies_from_browser=cookies,
                                     overwrite=overwrite)
            # After an overwrite there is nothing left to offer, so suppress
            # the re-download prompt to avoid a loop.
            self._post_ui(self._dl_done, rep, not overwrite)
        except Exception as e:
            # Bind the text now: `e` is unbound once the except block exits,
            # so a lambda closing over it would raise NameError on the Tk thread.
            msg = str(e) or repr(e)
            self._post_ui(self._dl_fail, msg)

    def _dl_done(self, rep: dict, allow_prompt: bool = True):
        self._dl_busy = False
        self.dl_btn.configure(state="normal", text="Download")
        verb = "Already in library" if rep.get("already_had") else "Downloaded"
        self.log_line(f"{verb}: {rep['path']}")
        self.log_line(f"        {ytadapter.fmt_res(rep)}  "
                      f"{ytadapter.fmt_duration(rep.get('duration_s'))}  "
                      f"{rep.get('size_mb')} MB  "
                      f"[{rep.get('vcodec')} / {rep.get('acodec')}]")
        self.music_path.set(rep["path"])
        self.yt_url.set("")
        self.log_line("Set as the Music source — pick an instrument and hit "
                      "Create Video.")

        if rep.get("already_had") and allow_prompt:
            # The filename encodes title+id but NOT quality, so yt-dlp skips
            # the download even when the chosen preset differs from what is on
            # disk. Say what is actually there and offer a real re-fetch,
            # rather than quietly handing back a different encode than asked.
            want = ytadapter.QUALITY[rep["quality"]]["label"]
            if messagebox.askyesno(
                    "IPlay — already in library",
                    f"{rep['title']}\n\nThe file on disk is "
                    f"{ytadapter.fmt_res(rep)} "
                    f"{rep.get('vcodec')}/{rep.get('acodec')}, "
                    f"{rep.get('size_mb')} MB.\n\nNothing was downloaded. "
                    f"Re-download and OVERWRITE it using:\n{want}?"):
                self._dl_busy = True
                self.dl_btn.configure(state="disabled", text="Downloading…")
                self.log_line(f"Re-downloading with overwrite at: {want}")
                threading.Thread(
                    target=self._dl_worker,
                    args=(rep["url"], rep["quality"], self.yt_cookies.get(), True),
                    daemon=True).start()

    def _dl_fail(self, msg: str):
        self._dl_busy = False
        self.dl_btn.configure(state="normal", text="Download")
        self.log_line("Download FAILED: " + msg)
        messagebox.showerror("IPlay — YouTube", msg[:1500])

    def open_library(self):
        """Picker listing every YouTube download we can find (library folder
        plus YouTube-named files in ~/Downloads)."""
        win = tk.Toplevel(self.root)
        win.title("YouTube library")
        win.configure(bg=BG)
        win.geometry("920x470")
        win.transient(self.root)

        status = tk.Label(win, text="Scanning…", bg=BG, fg=DIM, anchor="w")
        status.pack(fill="x", padx=12, pady=(10, 4))

        # ttk needs an explicit theme before its colors are honoured; the
        # default Windows theme ignores background/fieldbackground.
        style = ttk.Style(win)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("IPlay.Treeview", background=PANEL, fieldbackground=PANEL,
                        foreground=FG, rowheight=24, borderwidth=0)
        style.configure("IPlay.Treeview.Heading", background=BG, foreground=DIM,
                        relief="flat")
        style.map("IPlay.Treeview", background=[("selected", ACCENT)],
                  foreground=[("selected", BTN_FG)])

        frame = tk.Frame(win, bg=BG)
        frame.pack(fill="both", expand=True, padx=12)
        cols = ("res", "len", "size", "where")
        tree = ttk.Treeview(frame, columns=cols, show="tree headings",
                            style="IPlay.Treeview")
        tree.heading("#0", text="Title")
        tree.column("#0", width=430, anchor="w")
        for key, title, width in (("res", "Resolution", 110), ("len", "Length", 80),
                                  ("size", "Size", 95), ("where", "Folder", 170)):
            tree.heading(key, text=title)
            tree.column(key, width=width, anchor="w", stretch=False)
        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        tree.pack(side="left", fill="both", expand=True)

        def use_selected(_event=None):
            sel = tree.selection()
            if not sel:
                messagebox.showinfo("IPlay", "Pick a video from the list first.",
                                    parent=win)
                return
            entry = self._lib_entries[int(sel[0])]
            self.music_path.set(entry["path"])
            self.log_line(f"Music source set from library: {entry['title']}")
            win.destroy()

        tree.bind("<Double-1>", use_selected)

        def populate(entries: list[dict]):
            if not win.winfo_exists():
                return
            self._lib_entries = entries
            tree.delete(*tree.get_children())
            for i, e in enumerate(entries):
                where = ("library" if e["in_library"]
                         else os.path.basename(e["dir"]) or e["dir"])
                tree.insert("", "end", iid=str(i), text=e["title"], values=(
                    ytadapter.fmt_res(e),
                    ytadapter.fmt_duration(e.get("duration_s")),
                    f"{e.get('size_mb', 0):.1f} MB", where))
            status.configure(
                text=(f"{len(entries)} video(s)   |   library: "
                      f"{ytadapter.library_dir()}") if entries else
                ("Nothing found yet — paste a URL in the YouTube box and hit "
                 "Download."))

        def show_error(msg: str):
            if win.winfo_exists():
                status.configure(text="Scan failed: " + msg)

        def scan():
            # Runs OFF the Tk thread: touch no widget here. Even a read-only
            # winfo_exists() raises "main thread is not in main loop". Hand
            # results back via root.after and do the still-alive check inside
            # the callback, which runs on the Tk thread.
            try:
                entries = ytadapter.list_library()
            except Exception as e:
                msg = f"{type(e).__name__}: {e}"
                self._post_ui(show_error, msg)
                return
            self._post_ui(populate, entries)

        def refresh():
            status.configure(text="Scanning…")
            threading.Thread(target=scan, daemon=True).start()

        def open_folder():
            d = ytadapter.library_dir()
            try:
                os.makedirs(d, exist_ok=True)
                os.startfile(d)
            except OSError as e:
                self.log_line(f"Could not open {d}: {e}")

        bar = tk.Frame(win, bg=BG)
        bar.pack(fill="x", padx=12, pady=10)
        tk.Button(bar, text="Use selected", command=use_selected, bg=BTN,
                  fg=BTN_FG, activebackground=ACCENT, relief="flat",
                  padx=16, pady=4).pack(side="left")
        tk.Button(bar, text="Open folder", command=open_folder, bg=PANEL,
                  fg=FG, activebackground=ACCENT, relief="flat",
                  padx=12, pady=4).pack(side="left", padx=(8, 0))
        tk.Button(bar, text="Refresh", command=refresh, bg=PANEL, fg=FG,
                  activebackground=ACCENT, relief="flat",
                  padx=12, pady=4).pack(side="left", padx=(8, 0))
        tk.Button(bar, text="Close", command=win.destroy, bg=PANEL, fg=DIM,
                  activebackground=ACCENT, relief="flat",
                  padx=12, pady=4).pack(side="right")

        refresh()

    # ---------------- run ----------------

    def create_video(self):
        if self._busy:
            return
        music = self.music_path.get().strip()
        if not music or not os.path.exists(music):
            messagebox.showerror("IPlay", "Pick an existing music file first.")
            return
        source_performance = self.source_performance.get()
        out_dir = self.out_dir.get().strip() or default_output_dir()
        try:
            os.makedirs(out_dir, exist_ok=True)
        except OSError as e:
            messagebox.showerror("IPlay", f"Cannot create output folder:\n{e}")
            return

        base = pipeline.safe_output_stem(
            os.path.splitext(os.path.basename(music))[0])
        instrument = self.instrument.get()
        out_path = os.path.join(out_dir, f"{base}_{instrument}_iplay.mp4")
        n = 1
        while os.path.exists(out_path):
            out_path = os.path.join(out_dir, f"{base}_{instrument}_iplay_{n}.mp4")
            n += 1

        self._busy = True
        self._render_cancel = threading.Event()
        # The progress bar below carries the "working" signal now, so the
        # button keeps its name instead of becoming a status label.
        self.create_btn.configure(state="disabled")
        self.set_progress(0.0, "Starting...")
        self.cancel_btn.configure(state="normal")
        self.log_line("")
        self.log_line(f"=== Creating video: {os.path.basename(out_path)} ===")

        args = (music, list(self.photos), instrument, out_path, self.uhd.get(),
                self.local_director.get(),
                self.full_scenes.get(),
                self.guitar_variant.get() if instrument == "guitar" else None,
                list(self.cutaway_files),
                source_performance)
        self._render_thread = threading.Thread(
            target=self._worker, args=args, daemon=True)
        self._render_thread.start()

    def _worker(self, music, photos, instrument, out_path, uhd, local_director,
                full_scenes, variant, cutaway_files, source_performance):
        try:
            report = pipeline.build_video(
                music, photos, instrument, out_path,
                uhd=uhd, progress_cb=self.log_line,
                stage_cb=self.set_progress,
                local_director=local_director,
                full_song_scenes=full_scenes, guitar_variant=variant,
                cutaway_files=cutaway_files,
                source_performance=source_performance,
                cancel_event=self._render_cancel)
            self._post_ui(self._done, report)
        except pipeline.IPlayCancelled as e:
            self.log_line(str(e))
            self._post_ui(self._cancelled)
        except pipeline.IPlayRefMissing as e:
            self.log_line(str(e))
            self._post_ui(self._fail, "Reference clip missing", str(e))
        except Exception as e:
            tb = traceback.format_exc()
            self.log_line(tb)
            self._post_ui(self._fail, type(e).__name__, str(e) or repr(e))

    def _done(self, report: dict):
        self._busy = False
        self.create_btn.configure(state="normal", text="Create Video")
        self.set_progress(1.0, "Done")
        self.cancel_btn.configure(state="disabled", text="Cancel")
        face = report.get("face_stage", {})
        self.log_line("")
        self.log_line(f"OUTPUT : {report['out']}")
        self.log_line(f"POLICY : {report['policy']} ({report['reason']})   "
                      f"bpm={report['bpm']}  audio={report['duration_s']}s")
        self.log_line(f"VIDEO  : {report.get('output_width')}x"
                      f"{report.get('output_height')}  "
                      f"{report.get('output_duration_s')}s  [{report['uhd']}]")
        self.log_line(f"MOTION : {report.get('motion_source_tier', 'beat-only')} — "
                      f"{report.get('motion_accuracy', 'contacts not classified')}")
        render_warning = report.get("uhd_failure")
        if render_warning:
            if report.get("uhd_requested"):
                self.log_line("UHD WARNING: 2160p was not delivered; the output "
                              "above is the validated fallback.")
            else:
                self.log_line("RENDER WARNING: native stream-copy delivery failed; "
                              "the output above is the validated fallback.")
            for line in str(render_warning).splitlines():
                if line.strip():
                    self.log_line(f"             {line}")
        edit = report.get("local_edit") or {}
        self.log_line(f"LOCAL EDIT: {edit.get('status', 'disabled')} — "
                      f"{edit.get('detail', 'not requested')}")
        master = report.get("audio_master") or {}
        self.log_line(f"AUDIO  : original continuous master; "
                      f"{master.get('channels', '?')} channel(s), "
                      f"{master.get('sample_rate', '?')} Hz")
        self.log_line(f"HEYGEN ASSETS: {face.get('status')} — {face.get('detail')}")
        delivery_warning = ""
        if render_warning:
            prefix = ("UHD was not delivered" if report.get("uhd_requested")
                      else "Native stream-copy delivery failed")
            delivery_warning = (f"\n\n{prefix}. IPlay created a validated "
                                "fallback; full diagnostics are in the log pane "
                                "and FFmpeg log shown there.")
        if messagebox.askyesno(
                "IPlay — done",
                f"Video created:\n{report['out']}\n\n"
                f"Policy: {report['policy']} ({report['reason']})\n"
                f"Delivery: {report['uhd']}\n"
                f"HeyGen assets: {face.get('status')}"
                f"{delivery_warning}\n\nOpen output folder?"):
            try:
                os.startfile(os.path.dirname(report["out"]))
            except OSError as e:
                self.log_line(f"Could not open folder: {e}")

    def _fail(self, title: str, msg: str):
        self._busy = False
        self.create_btn.configure(state="normal", text="Create Video")
        self.reset_progress("Idle")
        self.cancel_btn.configure(state="disabled", text="Cancel")
        messagebox.showerror(f"IPlay — {title}", msg[:1500])

    def cancel_render(self):
        if not self._busy or self._render_cancel is None:
            return
        self._render_cancel.set()
        self.cancel_btn.configure(state="disabled", text="Cancelling...")
        self.log_line("Cancellation requested. IPlay is stopping the active "
                      "FFmpeg stage and will not start a fallback.")

    def _cancelled(self):
        self._busy = False
        self.create_btn.configure(state="normal", text="Create Video")
        self.reset_progress("Idle")
        self.cancel_btn.configure(state="disabled", text="Cancel")
        self.log_line("Render cancelled. Any failed-stage diagnostic log remains "
                      "beside the requested output.")

    def _on_root_close(self):
        if self._busy:
            if not messagebox.askyesno(
                    "IPlay — stop render?",
                    "A render is active. Stop it and close IPlay?"):
                return
            for stop_event in tuple(self._camera_stops):
                stop_event.set()
            self.cancel_render()
            self.root.after(100, self._wait_for_render_close)
            return
        for stop_event in tuple(self._camera_stops):
            stop_event.set()
        self._closing = True
        self.root.destroy()

    def _wait_for_render_close(self):
        worker = self._render_thread
        if worker is not None and worker.is_alive():
            self.root.after(100, self._wait_for_render_close)
            return
        self._closing = True
        self.root.destroy()


def main():
    root = tk.Tk()
    IPlayApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
