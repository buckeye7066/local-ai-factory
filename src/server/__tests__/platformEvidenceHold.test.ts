import { describe, expect, it } from "vitest";
import {
  onlyPlatformEvidenceBlockers,
  platformEvidenceBlockersFromRunError,
} from "../orchestrator/platformEvidenceHold.js";

const windows = "windows compatibility is applicable but lacks executed evidence.";
const macos = "macos compatibility is applicable but lacks executed evidence.";

describe("cross-platform readiness hold", () => {
  it("recognizes only deterministic missing-platform execution blockers", () => {
    expect(onlyPlatformEvidenceBlockers([windows, macos])).toBe(true);
    expect(onlyPlatformEvidenceBlockers([])).toBe(false);
    expect(
      onlyPlatformEvidenceBlockers([windows, "Executable tests did not pass."]),
    ).toBe(false);
  });

  it("recovers the platform-only blocker list from the persisted run error", () => {
    expect(
      platformEvidenceBlockersFromRunError(
        `Production readiness blocked before release review: ${windows}; ${macos}`,
      ),
    ).toEqual([windows, macos]);
    expect(
      platformEvidenceBlockersFromRunError(
        `Production readiness blocked before release review: ${windows}; Executable tests did not pass.`,
      ),
    ).toBeNull();
    expect(platformEvidenceBlockersFromRunError("provider failed")).toBeNull();
  });
});
