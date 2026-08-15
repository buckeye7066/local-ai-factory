"""Tests for motionsync.choose_policy / make_alignment_plan delegation.

Synthetic beat grids only — no audio needed. Runs under pytest
(`python -m pytest test_choose_policy.py -v`) or standalone
(`python test_choose_policy.py`) with plain asserts.
"""
import os
import sys
import importlib.util

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ms", os.path.join(HERE, "motionsync.py"))
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)


def _timing(beats):
    return {"beats": list(beats), "bpm": 0.0, "onset_times": [], "onset_strength": [],
            "duration_s": (beats[-1] if len(beats) else 0.0)}


def steady_beats(n=24, ibi=0.5):
    return [round(i * ibi, 6) for i in range(n)]


def accelerating_beats(n=24, ibi_start=0.5, ibi_end=0.4):
    """Beat grid whose inter-beat interval shrinks linearly 0.5 s -> 0.4 s."""
    ibis = np.linspace(ibi_start, ibi_end, n - 1)
    return [0.0] + list(np.cumsum(ibis))


def test_steady_piano_loop():
    r = ms.choose_policy(_timing(steady_beats()), "piano")
    assert r["policy"] == "loop", r
    assert r["tempo_drift"] <= ms.TEMPO_DRIFT_THRESHOLD, r
    assert r["strokes_per_beat"] == 1.0
    assert isinstance(r["reason"], str) and r["reason"]


def test_steady_violin_warp():
    r = ms.choose_policy(_timing(steady_beats()), "violin")
    assert r["policy"] == "warp", r
    assert r["strokes_per_beat"] == 1.0


def test_steady_guitar_cut():
    r = ms.choose_policy(_timing(steady_beats()), "guitar")
    assert r["policy"] == "cut", r
    assert r["strokes_per_beat"] == 1.0


def test_accelerating_all_cut():
    t = _timing(accelerating_beats())
    for instrument in ("piano", "guitar", "violin"):
        r = ms.choose_policy(t, instrument)
        assert r["policy"] == "cut", (instrument, r)
        assert r["tempo_drift"] > ms.TEMPO_DRIFT_THRESHOLD, (instrument, r)


def test_degenerate_zero_beats_raises():
    try:
        ms.choose_policy(_timing([]), "piano")
    except ValueError as e:
        assert "beats" in str(e).lower()
    else:
        raise AssertionError("expected ValueError for 0 beats")


def test_degenerate_one_beat_raises():
    try:
        ms.choose_policy(_timing([1.0]), "guitar")
    except ValueError as e:
        assert "beats" in str(e).lower()
    else:
        raise AssertionError("expected ValueError for 1 beat")


def test_unknown_instrument_raises():
    try:
        ms.choose_policy(_timing(steady_beats()), "theremin")
    except ValueError as e:
        assert "instrument" in str(e).lower()
    else:
        raise AssertionError("expected ValueError for unknown instrument")


def test_make_alignment_plan_delegates_and_merges():
    plan = ms.make_alignment_plan(_timing(steady_beats()), 2.0, 5.0)  # default guitar
    assert plan["policy"] == "cut", plan
    assert plan["instrument"] == "guitar"
    assert plan["reference_stroke_hz"] == 2.0
    assert plan["ref_clip_duration"] == 5.0
    for k in ("reason", "tempo_drift", "strokes_per_beat"):
        assert k in plan, plan
    plan_v = ms.make_alignment_plan(_timing(steady_beats()), 2.0, 5.0, instrument="violin")
    assert plan_v["policy"] == "warp", plan_v


if __name__ == "__main__":
    tests = [(name, fn) for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {name}: {e}")
    print(f"RESULT: {'PASS' if failed == 0 else 'FAIL'} ({len(tests) - failed}/{len(tests)})")
    sys.exit(1 if failed else 0)
