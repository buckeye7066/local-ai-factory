"""Self-test: synthesize a 100-BPM track with clear note onsets, then verify the
audio->timing engine recovers the tempo and catches the programmed onsets.

This is the evidence that the free, instrument-agnostic foundation works on
real audio (a synthesized control with GROUND-TRUTH tempo and onsets, so pass/fail
is meaningful rather than eyeballed). Run:  python test_motionsync.py
"""
import importlib.util
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
TRK = os.path.join(HERE, "_test_track.wav")

sr = 22050
bpm_truth = 100.0
beat = 60.0 / bpm_truth  # 0.6 s
dur = 12.0               # ~20 beats, ~12 s (take01-length)


def note(freq, t0, decay=6.0, length=0.12):
    seg = np.zeros(int(sr * dur))
    i0 = int(t0 * sr)
    n = int(length * sr)
    if i0 + n < len(seg):
        env = np.exp(-np.linspace(0, decay, n))
        seg[i0:i0 + n] = env * np.sin(2 * np.pi * freq * np.arange(n) / sr)
    return seg


t_idx = np.arange(int(sr * dur))
sig = np.zeros_like(t_idx, dtype=float)
note_freqs = [440.0, 554.0, 659.0, 880.0]  # A C# E A motif
emitted = []
tt = 0.0
beat_count = 0
while tt < dur:
    f = note_freqs[beat_count % len(note_freqs)]
    sig += note(f, tt)
    emitted.append(round(tt, 3))
    # syncopated 8th on half of beats -> exercises off-beat onset detection
    if (beat_count % 4) in (1, 3):
        sig += note(f * 1.5, tt + beat / 2)
        emitted.append(round(tt + beat / 2, 3))
    tt += beat
    beat_count += 1

rng = np.random.default_rng(0)
sig += 0.01 * rng.standard_normal(len(sig))  # non-degenerate spectrum
sig = (sig / (np.max(np.abs(sig)) + 1e-9) * 0.9).astype(np.float32)
sf.write(TRK, sig, sr)

spec = importlib.util.spec_from_file_location("ms", os.path.join(HERE, "motionsync.py"))
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)

plan = ms.analyze_audio(TRK)
bpm = plan["bpm"]
onsets = plan["onset_times"]

print(f"truth BPM: {bpm_truth}   detected BPM: {bpm}")
print(f"truth onsets ({len(emitted)}): {emitted[:8]} ...")
print(f"detected onsets ({len(onsets)}): {[round(o,3) for o in onsets[:8]]} ...")

caught = sum(any(abs(o - d) < 0.05 for d in onsets) for o in emitted)
recall = caught / len(emitted)
print(f"onset recall: {caught}/{len(emitted)} = {recall:.0%}")

# beat trackers can lock an octave high or low; allow x2 and /2.
octave_ok = (abs(bpm - bpm_truth) < 0.10 * bpm_truth
             or abs(bpm - 2 * bpm_truth) < 0.10 * bpm_truth
             or abs(bpm - bpm_truth / 2) < 0.10 * bpm_truth)
print(f"tempo within 10% (or octave x2//2): {octave_ok}")
print(f"onset recall >= 80%: {recall >= 0.80}")

passed = octave_ok and recall >= 0.80
print("RESULT:", "PASS" if passed else "FAIL")
sys.exit(0 if passed else 1)
