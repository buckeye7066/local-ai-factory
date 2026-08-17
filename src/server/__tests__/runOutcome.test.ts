import { describe, expect, it } from "vitest";
import { runIsReady } from "../../ui/lib/runOutcome.js";
import type { RunRecord } from "../../shared/schemas.js";

const base = {
  status: "completed",
  demo: false,
  finalReport: { testStatus: "passing" },
  destination: {
    kind: "existing-repo",
    status: "delivered",
  },
  release: null,
} as unknown as Pick<
  RunRecord,
  "status" | "demo" | "finalReport" | "destination" | "release"
>;

describe("runIsReady", () => {
  it("requires verified completion and delivery, not narrative test prose", () => {
    expect(runIsReady(base)).toBe(true);
    expect(runIsReady({ ...base, status: "failed" })).toBe(false);
    expect(runIsReady({ ...base, destination: undefined })).toBe(false);
    expect(
      runIsReady({
        ...base,
        destination: { ...base.destination!, status: "failed" },
      }),
    ).toBe(false);
  });

  it("never celebrates simulation or a held release", () => {
    expect(runIsReady({ ...base, demo: true })).toBe(false);
    expect(
      runIsReady({
        ...base,
        release: {
          released: false,
          prUrl: null,
          mergedSha: null,
          reason: "checks failed",
        },
      }),
    ).toBe(false);
  });
});
