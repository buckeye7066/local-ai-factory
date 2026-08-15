"""Measure dominant stroke rate of an instrument-playing clip.

Pipeline: ffmpeg rawvideo pipe -> downscaled grayscale frames -> mean
absolute frame difference (1-D motion-energy signal) -> normalized
autocorrelation over the musically plausible band 0.5-6 Hz -> dominant
period -> stroke_hz.  Also estimates first_stroke_s = time of the first
prominent motion-energy peak.

Usage: python measure_stroke.py clip.mp4
Prints a JSON dict: {stroke_hz, first_stroke_s, autocorr_r, fps, n_frames, duration_s}
"""
import json
import subprocess
import sys

import numpy as np

W, H = 160, 90
BAND = (0.5, 6.0)  # plausible stroke-rate band in Hz


def probe_fps(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", path],
        text=True).strip()
    num, den = out.split("/")
    return float(num) / float(den)


def motion_energy(path):
    """Return per-frame mean absolute difference signal."""
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H}",
         "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE)
    raw = proc.stdout.read()
    proc.wait()
    n = len(raw) // (W * H)
    frames = np.frombuffer(raw[: n * W * H], dtype=np.uint8).reshape(n, H, W)
    frames = frames.astype(np.float32)
    diffs = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
    return diffs  # length n-1


def dominant_period(sig, fps):
    """Normalized autocorrelation peak within BAND. Returns (hz, r)."""
    x = sig - sig.mean()
    if x.std() < 1e-9:
        return None, 0.0
    x = x / x.std()
    n = len(x)
    ac = np.correlate(x, x, mode="full")[n - 1:]
    ac = ac / ac[0]  # normalize so lag-0 == 1
    lo = max(2, int(round(fps / BAND[1])))          # smallest lag (highest hz)
    hi = min(n - 2, int(round(fps / BAND[0])))      # largest lag (lowest hz)
    if hi <= lo:
        return None, 0.0
    seg = ac[lo:hi + 1]
    # local maxima only, so we don't grab a shoulder of the lag-0 peak
    peaks = [i for i in range(1, len(seg) - 1)
             if seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1]]
    if not peaks:
        i = int(np.argmax(seg))
    else:
        i = max(peaks, key=lambda k: seg[k])
    lag = lo + i
    return fps / lag, float(ac[lag])


def first_stroke(sig, fps):
    """Time of first prominent motion-energy peak."""
    thr = 0.5 * np.percentile(sig, 90)
    for i in range(1, len(sig) - 1):
        if sig[i] > thr and sig[i] >= sig[i - 1] and sig[i] >= sig[i + 1]:
            return (i + 1) / fps  # +1: diff[i] spans frames i..i+1
    return 0.0


def main():
    path = sys.argv[1]
    fps = probe_fps(path)
    sig = motion_energy(path)
    hz, r = dominant_period(sig, fps)
    out = {
        "stroke_hz": round(hz, 4) if hz else None,
        "first_stroke_s": round(first_stroke(sig, fps), 4),
        "autocorr_r": round(r, 4),
        "fps": round(fps, 4),
        "n_frames": int(len(sig) + 1),
        "duration_s": round((len(sig) + 1) / fps, 3),
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
