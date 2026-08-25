import { describe, expect, it } from "vitest";
import { RunOptionsSchema } from "../../shared/schemas.js";

/**
 * The silent-fallback defect (run c72fdb26): a misplaced or misspelled run
 * setting was silently STRIPPED by the options parser, so an
 * extend-this-repo submission quietly became a from-scratch app whose
 * report then fabricated pass counts. Unknown keys must fail loud.
 */
describe("RunOptionsSchema is strict", () => {
  it("rejects an unknown option key by name instead of stripping it", () => {
    const parsed = RunOptionsSchema.safeParse({
      mode: "extend",
      destination: { kind: "existing-repo", target: "https://github.com/x/y" },
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success
      ? ""
      : parsed.error.issues.map((i) => i.message).join(" ");
    expect(message.toLowerCase()).toContain("unrecognized");
  });

  it("still accepts every legitimate option shape", () => {
    const parsed = RunOptionsSchema.safeParse({
      mode: "extend",
      repoSource: { type: "git", location: "https://github.com/x/y" },
      goals: ["fix the failing test"],
      maxRepairLoops: 2,
      pushToOrigin: true,
    });
    expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(
      true,
    );
  });
});
