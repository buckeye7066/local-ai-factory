import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_PREAMBLE } from "../agents/types.js";
import { productSpecAgent } from "../agents/productSpecAgent.js";
import { qaCriticAgent } from "../agents/qaCriticAgent.js";
import type { LLMProvider } from "../../shared/types.js";

/**
 * Owner directive 2026-08-15: "user friendliness and ease is a top priority
 * for the apps and programs that come out of factory deck and the foundry."
 * The directive lives in SYSTEM_PREAMBLE so EVERY pipeline agent carries it
 * (Foundry is the same pipeline in ?mode=foundry). These tests pin it there —
 * a refactor that drops the mandate, or an agent that stops embedding the
 * preamble, goes red.
 */

describe("usability mandate", () => {
  it("SYSTEM_PREAMBLE carries the owner's user-friendliness directive", () => {
    expect(SYSTEM_PREAMBLE).toMatch(/USER-FRIENDLINESS IS A TOP PRIORITY/);
    expect(SYSTEM_PREAMBLE).toMatch(/non-technical everyday user/i);
    expect(SYSTEM_PREAMBLE).toMatch(/what to do\s*next/i);
  });

  it("every pipeline agent embeds SYSTEM_PREAMBLE (totality — new agents included)", () => {
    const dir = resolve(process.cwd(), "src/server/agents");
    const agents = readdirSync(dir).filter(
      (f) => f.endsWith("Agent.ts") && !f.endsWith(".test.ts"),
    );
    expect(agents.length).toBeGreaterThanOrEqual(10);
    for (const file of agents) {
      const src = readFileSync(resolve(dir, file), "utf8");
      expect(src, `${file} must embed SYSTEM_PREAMBLE`).toMatch(/SYSTEM_PREAMBLE/);
    }
  });

  function capturingProvider(result: unknown) {
    const captured: { system?: string; prompt?: string } = {};
    const provider = {
      name: "stub",
      generateJson: async (args: { system: string; prompt: string }) => {
        captured.system = args.system;
        captured.prompt = args.prompt;
        return result;
      },
    } as unknown as LLMProvider;
    return { provider, captured };
  }

  it("the spec agent demands checkable ease-of-use acceptance criteria", async () => {
    const { provider, captured } = capturingProvider({
      appName: "X",
      tagline: "t",
      targetUser: "u",
      coreFeatures: ["f"],
      dataModel: [],
      userFlows: ["flow"],
      acceptanceCriteria: ["a"],
    });
    await productSpecAgent({ provider }, "an idea");
    expect(captured.system).toMatch(/USER-FRIENDLINESS IS A TOP PRIORITY/);
    expect(captured.prompt).toMatch(/at least two ease-of-use criteria/i);
    expect(captured.prompt).toMatch(/without instructions/i);
  });

  it("the QA critic treats first-run usability blockers as flaggable", async () => {
    const { provider, captured } = capturingProvider({
      summary: "s",
      passed: true,
      issues: [],
    });
    await qaCriticAgent(
      { provider },
      { files: [{ path: "a.ts", purpose: "p", contents: "x", edits: [] }] },
      "",
    );
    expect(captured.system).toMatch(/usability blockers/i);
    expect(captured.system).toMatch(/raw technical error/i);
    expect(captured.system).toMatch(/not flag subjective styling/i);
  });
});
