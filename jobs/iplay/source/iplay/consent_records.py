"""Consent and license provenance records (Master Prompt item 212)."""
from __future__ import annotations

import json
import os
import time
from typing import Any


class ConsentRecordError(ValueError):
    pass


REQUIRED_FIELDS = (
    "performance_basename",
    "avatar_basename",
    "instrument",
    "rights_acknowledged",
    "license_notes",
)


def build_consent_record(
        *,
        performance_path: str,
        avatar_path: str,
        instrument: str,
        rights_acknowledged: bool,
        license_notes: str = "",
        reference_licenses: list[dict] | None = None,
        operator: str = "local-user",
) -> dict[str, Any]:
    if not rights_acknowledged:
        raise ConsentRecordError(
            "Consent/rights acknowledgment is required before export.")
    if not performance_path or not avatar_path:
        raise ConsentRecordError("performance and avatar paths are required")
    return {
        "schema_version": "1.0.0",
        "created_at_unix": int(time.time()),
        "operator": operator,
        "performance_basename": os.path.basename(performance_path),
        "avatar_basename": os.path.basename(avatar_path),
        "instrument": instrument,
        "rights_acknowledged": True,
        "rights_verified_by_iplay": False,
        "license_notes": license_notes or "operator-declared rights",
        "reference_licenses": list(reference_licenses or []),
        "export_allowed": True,
    }


def load_reference_license_inventory(manifest_path: str) -> list[dict]:
    with open(manifest_path, encoding="utf-8") as fh:
        data = json.load(fh)
    inventory = []
    for instrument, entry in data.items():
        inventory.append({
            "instrument": instrument,
            "file": entry.get("file"),
            "license": entry.get("license"),
            "source_url": entry.get("source_url"),
        })
    return inventory


def write_consent_record(path: str, record: dict[str, Any]) -> None:
    for field in REQUIRED_FIELDS:
        if field not in record:
            raise ConsentRecordError(f"consent record missing {field}")
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2, sort_keys=True)
