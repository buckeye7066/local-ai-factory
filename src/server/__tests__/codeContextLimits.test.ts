import { describe, expect, it } from "vitest";
import type { FileBuild } from "../../shared/schemas.js";
import { renderBuildCodeContext } from "../agents/codeContext.js";
import {
  MAX_CONTEXT_FILE_CHARS,
  MAX_CONTEXT_TOTAL_CHARS,
} from "../workspace/contextLimits.js";

function build(path: string, contents: string): FileBuild {
  return { files: [{ path, purpose: "fixture", contents, edits: [] }] };
}

describe("changed-code context limits", () => {
  it("shows a 56 KB integration file in full for downstream verification", () => {
    const contents = "x".repeat(56_000);
    const context = renderBuildCodeContext(build("server/api.js", contents));

    expect(MAX_CONTEXT_FILE_CHARS).toBeGreaterThanOrEqual(56_000);
    expect(context.complete).toBe(true);
    expect(context.fullyShownPaths).toEqual(["server/api.js"]);
    expect(context.text).toContain(contents);
  });

  it("still fails closed beyond the shared per-file and total budgets", () => {
    const tooLarge = renderBuildCodeContext(
      build("server/oversized.js", "x".repeat(MAX_CONTEXT_FILE_CHARS + 1)),
    );
    expect(tooLarge.complete).toBe(false);
    expect(tooLarge.omittedPaths).toEqual(["server/oversized.js"]);

    const total = renderBuildCodeContext({
      files: [
        {
          path: "a.js",
          purpose: "fixture",
          contents: "a".repeat(64_000),
          edits: [],
        },
        {
          path: "b.js",
          purpose: "fixture",
          contents: "b".repeat(56_001),
          edits: [],
        },
      ],
    });
    expect(MAX_CONTEXT_TOTAL_CHARS).toBe(120_000);
    expect(total.complete).toBe(false);
    expect(total.omittedPaths).toEqual(["b.js"]);
  });
});
