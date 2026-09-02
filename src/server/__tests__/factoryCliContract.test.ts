import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Factory Deck cloud CLI terminal contract", () => {
  it("fails closed for missing, cancelled, and reportless runs", async () => {
    const source = await readFile(
      new URL("../../../src/cli/factory.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("if (!run) break;");
    expect(source).toMatch(
      /if \(!run\) \{[\s\S]*?disappeared before a terminal result[\s\S]*?process\.exitCode = 1;/,
    );
    expect(source).toContain('run.status === "cancelled"');
    expect(source).toContain("Run was cancelled.");
    expect(source).toContain("Run completed without a final report");
    expect(source).toContain("process.env.FACTORY_PROJECT_ID?.trim()");
    expect(source).toContain("projectId ? { projectId } : {}");
  });
});
