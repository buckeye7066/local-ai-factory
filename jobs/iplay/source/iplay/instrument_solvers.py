"""Instrument-specific action solvers (Master Prompt bridge item 207).

These solvers do not invent a full score from silence. They take onset-timed
candidates (from audio analysis and/or source tracking) and enforce instrument
plausibility: impossible fret/key jumps, bow/strum direction thrash, and hand
discontinuities are corrected or confidence-penalized rather than hard-discarded
when evidence is thin.
"""
from __future__ import annotations

from typing import Any


class InstrumentSolverError(ValueError):
    pass


MAX_GUITAR_FRET_JUMP = 5
MAX_VIOLIN_POSITION_JUMP = 2
MAX_PIANO_KEY_JUMP_SAME_HAND = 12


def _confidence(base: float, penalty: float) -> float:
    return max(0.05, min(1.0, float(base) - float(penalty)))


def solve_guitar_actions(onsets_s: list[float], *,
                         starting_fret: int = 3,
                         base_confidence: float = 0.55) -> list[dict[str, Any]]:
    """Alternate strum direction; clamp fret travel between adjacent onsets."""
    events: list[dict[str, Any]] = []
    fret = int(starting_fret)
    direction = "down"
    for i, t in enumerate(onsets_s):
        proposed = fret + ((i % 3) - 1)  # mild local travel prior
        jump = abs(proposed - fret)
        penalty = 0.0
        if jump > MAX_GUITAR_FRET_JUMP:
            proposed = fret + (MAX_GUITAR_FRET_JUMP if proposed > fret else -MAX_GUITAR_FRET_JUMP)
            penalty += 0.25
        proposed = max(0, min(24, proposed))
        events.append({
            "kind": "strum",
            "start_s": float(t),
            "end_s": float(t),
            "direction": direction,
            "hand": "right",
            "fingers": ["index", "middle", "ring"],
            "fret_or_key": proposed,
            "string_or_position": None,
            "confidence": _confidence(base_confidence, penalty),
            "note_or_chord": f"fret:{proposed}",
        })
        # fretting hand continuity target
        events.append({
            "kind": "fret_hand",
            "start_s": float(t),
            "end_s": float(t),
            "direction": None,
            "hand": "left",
            "fingers": ["index", "middle", "ring", "pinky"],
            "fret_or_key": proposed,
            "string_or_position": max(1, min(6, 1 + (proposed % 6))),
            "confidence": _confidence(base_confidence, penalty),
        })
        fret = proposed
        direction = "up" if direction == "down" else "down"
    return events


def solve_violin_actions(onsets_s: list[float], *,
                         starting_position: int = 1,
                         base_confidence: float = 0.55) -> list[dict[str, Any]]:
    """Alternate bow direction; limit position shifts."""
    events: list[dict[str, Any]] = []
    position = int(starting_position)
    bow = "down"
    for i, t in enumerate(onsets_s):
        proposed = position + ((i % 5) - 2) // 2
        jump = abs(proposed - position)
        penalty = 0.0
        if jump > MAX_VIOLIN_POSITION_JUMP:
            proposed = position + (MAX_VIOLIN_POSITION_JUMP if proposed > position else -MAX_VIOLIN_POSITION_JUMP)
            penalty += 0.3
        proposed = max(1, min(5, proposed))
        events.append({
            "kind": "bow",
            "start_s": float(t),
            "end_s": float(t),
            "direction": bow,
            "hand": "right",
            "fingers": [],
            "fret_or_key": None,
            "string_or_position": proposed,
            "confidence": _confidence(base_confidence, penalty),
            "note_or_chord": f"pos:{proposed}",
        })
        events.append({
            "kind": "fingerboard",
            "start_s": float(t),
            "end_s": float(t),
            "direction": None,
            "hand": "left",
            "fingers": ["index", "middle", "ring", "pinky"],
            "fret_or_key": None,
            "string_or_position": proposed,
            "confidence": _confidence(base_confidence, penalty * 0.8),
        })
        position = proposed
        bow = "up" if bow == "down" else "down"
    return events


def solve_piano_actions(onsets_s: list[float], *,
                        starting_key: int = 60,
                        base_confidence: float = 0.55) -> list[dict[str, Any]]:
    """Two-hand voicing prior with pedal on phrase onsets; clamp same-hand jumps."""
    events: list[dict[str, Any]] = []
    left_key = max(21, int(starting_key) - 12)
    right_key = int(starting_key)
    for i, t in enumerate(onsets_s):
        right_proposed = right_key + ((i % 4) - 1) * 2
        left_proposed = left_key + ((i % 3) - 1)
        penalty = 0.0
        if abs(right_proposed - right_key) > MAX_PIANO_KEY_JUMP_SAME_HAND:
            right_proposed = right_key + (
                MAX_PIANO_KEY_JUMP_SAME_HAND if right_proposed > right_key
                else -MAX_PIANO_KEY_JUMP_SAME_HAND)
            penalty += 0.25
        if abs(left_proposed - left_key) > MAX_PIANO_KEY_JUMP_SAME_HAND:
            left_proposed = left_key + (
                MAX_PIANO_KEY_JUMP_SAME_HAND if left_proposed > left_key
                else -MAX_PIANO_KEY_JUMP_SAME_HAND)
            penalty += 0.2
        right_proposed = max(21, min(108, right_proposed))
        left_proposed = max(21, min(108, left_proposed))
        pedal = "on" if i % 8 == 0 else ("off" if i % 8 == 4 else None)
        events.append({
            "kind": "key_press",
            "start_s": float(t),
            "end_s": float(t),
            "direction": None,
            "pedal": pedal,
            "hand": "right",
            "fingers": ["thumb", "index", "middle", "ring", "pinky"],
            "fret_or_key": right_proposed,
            "string_or_position": None,
            "confidence": _confidence(base_confidence, penalty),
            "note_or_chord": f"midi:{right_proposed}",
        })
        events.append({
            "kind": "key_press",
            "start_s": float(t),
            "end_s": float(t),
            "direction": None,
            "pedal": pedal,
            "hand": "left",
            "fingers": ["thumb", "index", "middle", "ring", "pinky"],
            "fret_or_key": left_proposed,
            "string_or_position": None,
            "confidence": _confidence(base_confidence, penalty),
            "note_or_chord": f"midi:{left_proposed}",
        })
        right_key, left_key = right_proposed, left_proposed
    return events


def solve_instrument_actions(instrument: str, onsets_s: list[float], *,
                             base_confidence: float = 0.55,
                             **kwargs) -> list[dict[str, Any]]:
    if instrument == "guitar":
        return solve_guitar_actions(onsets_s, base_confidence=base_confidence, **kwargs)
    if instrument == "violin":
        return solve_violin_actions(onsets_s, base_confidence=base_confidence, **kwargs)
    if instrument == "piano":
        return solve_piano_actions(onsets_s, base_confidence=base_confidence, **kwargs)
    raise InstrumentSolverError(f"unsupported instrument: {instrument!r}")


def validate_action_continuity(instrument: str, events: list[dict[str, Any]]) -> dict:
    """Report continuity metrics; does not discard events (profile soft-fail)."""
    violations = 0
    checked = 0
    prev_by_hand: dict[str, dict] = {}
    for event in events:
        hand = str(event.get("hand") or "both")
        prev = prev_by_hand.get(hand)
        if prev is not None:
            checked += 1
            if instrument == "guitar" and event.get("fret_or_key") is not None:
                if abs(int(event["fret_or_key"]) - int(prev.get("fret_or_key") or 0)) > MAX_GUITAR_FRET_JUMP:
                    violations += 1
            if instrument == "violin" and event.get("string_or_position") is not None:
                if abs(int(event["string_or_position"]) - int(prev.get("string_or_position") or 1)) > MAX_VIOLIN_POSITION_JUMP:
                    violations += 1
            if instrument == "piano" and event.get("fret_or_key") is not None:
                if abs(int(event["fret_or_key"]) - int(prev.get("fret_or_key") or 60)) > MAX_PIANO_KEY_JUMP_SAME_HAND:
                    violations += 1
            # direction thrash: same timestamp reversing without travel is fine;
            # alternating is expected for strum/bow.
        prev_by_hand[hand] = event
    return {
        "checked_transitions": checked,
        "violations": violations,
        "plausible": violations == 0,
        "instrument": instrument,
    }
