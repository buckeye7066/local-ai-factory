import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  process.cwd(),
  ".github",
  "workflows",
  "factory-deck-cloud.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

describe("Factory Deck cloud workflow", () => {
  it("provides a user-dispatchable build input", () => {
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/idea:\s*[\s\S]*required:\s*true/);
    expect(workflow).toContain("FACTORY_IDEA: ${{ inputs.idea }}");
  });

  it("runs the real Factory Deck CLI with both readiness brains", () => {
    expect(workflow).toContain(
      'pnpm exec tsx src/cli/factory.ts "$env:FACTORY_IDEA"',
    );
    expect(workflow).toContain(
      "ANTHROPIC_API_KEY: ${{ secrets.PAID_PRODUCTION_ANTHROPIC_KEY }}",
    );
    expect(workflow).toContain(
      "OPENAI_API_KEY: ${{ secrets.PAID_PRODUCTION_OPENAI_KEY }}",
    );
    expect(workflow).toMatch(/FACTORY_SOL_MODEL:\s*\S+/);
    expect(workflow).toMatch(/FACTORY_FABLE_OR_OPUS_MODEL:\s*\S+/);
  });

  it("verifies generated work only on an isolated runner and preserves evidence", () => {
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('ALLOW_UNTRUSTED_SCRIPTS: "true"');
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain(".factory/**");
    expect(workflow).toContain("workspaces/**");
  });

  it("does not grant generated work repository write permission", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents:\s+read/);
    expect(workflow).not.toMatch(/contents:\s+write/);
  });
});
