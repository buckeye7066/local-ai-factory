import { describe, expect, it } from "vitest";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
} from "../../shared/types.js";
import type { FileBuild } from "../../shared/schemas.js";
import { repairAgent } from "../agents/repairAgent.js";

class CaptureProvider implements LLMProvider {
  readonly name = "stub" as const;
  lastSystem = "";
  lastPrompt = "";

  isConfigured(): boolean {
    return true;
  }

  async generateText(_input: GenerateTextInput): Promise<GenerateTextResult> {
    return { text: "", provider: "stub" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.lastSystem = input.system;
    this.lastPrompt = input.prompt;
    return input.schema.parse({ notes: "source-only repair", files: [] });
  }
}

describe("repair agent write contract", () => {
  it("advertises product code only while retaining tests as immutable evidence", async () => {
    const provider = new CaptureProvider();
    const build: FileBuild = {
      files: [
        {
          path: "src/commands.ts",
          purpose: "task behavior",
          contents: "export const empty = 'No tasks';",
          edits: [],
        },
        {
          path: "tests/tasktick.test.ts",
          purpose: "acceptance evidence",
          contents: "test('empty', () => expect(empty).toBe('No tasks'));",
          edits: [],
        },
        {
          path: "package.json",
          purpose: "verification command",
          contents: '{"scripts":{"test":"vitest run"}}',
          edits: [],
        },
      ],
    };

    await repairAgent(
      { provider },
      {
        summary: "test failed",
        passed: false,
        issues: [
          {
            severity: "high",
            title: "Generated acceptance test failed",
            detail: "Fix the behavior without changing its expectation.",
            file: "tests/tasktick.test.ts",
            repairInstruction: "Repair the product source.",
          },
        ],
      },
      build,
      "tests/tasktick.test.ts failed",
    );

    const allowedSection = provider.lastPrompt
      .split("ALLOWED PATHS:\n", 2)[1]!
      .split("\n\nEXACT CURRENT CONTENTS:", 1)[0]!;
    expect(allowedSection).toBe("src/commands.ts");
    expect(provider.lastPrompt).toContain("----- tests/tasktick.test.ts -----");
    expect(provider.lastPrompt).toContain("----- package.json -----");
    expect(provider.lastSystem).toContain("exclusive write set");
    expect(provider.lastSystem).toContain("immutable evidence");
  });
});
