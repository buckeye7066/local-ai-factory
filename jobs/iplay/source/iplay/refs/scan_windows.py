"""Slide a window over a clip's motion-energy signal and report the
window with the strongest periodicity (best autocorr r in 0.5-6 Hz).
Usage: python scan_windows.py clip win_s step_s
"""
import sys
import numpy as np
from measure_stroke import probe_fps, motion_energy, dominant_period

path, win_s, step_s = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
fps = probe_fps(path)
sig = motion_energy(path)
w = int(win_s * fps)
s = int(step_s * fps)
best = None
for start in range(0, max(1, len(sig) - w), s):
    seg = sig[start:start + w]
    hz, r = dominant_period(seg, fps)
    t0 = start / fps
    print(f"t={t0:6.1f}s  hz={hz if hz else 0:5.2f}  r={r:.3f}")
    if best is None or r > best[2]:
        best = (t0, hz, r)
print(f"BEST: start={best[0]:.1f}s hz={best[1]:.2f} r={best[2]:.3f}")
