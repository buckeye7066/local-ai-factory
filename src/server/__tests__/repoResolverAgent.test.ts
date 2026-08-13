import { describe, it, expect } from "vitest";
import { repoResolverAgent, ResolveError } from "../agents/repoResolverAgent.js";
import type { LLMProvider, GenerateJsonInput } from "../../shared/types.js";

class ScriptedProvider implements LLMProvider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(private script: unknown[]) {}
  isConfigured() {
    return true;
  }
  async generateText() {
    return { text: "", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const raw = this.script[this.calls];
    this.calls += 1;
    if (raw === undefined) throw new Error("ScriptedProvider ran out of script.");
    return input.schema.parse(raw) as T;
  }
}

describe("repoResolverAgent — deterministic fast path (no model call)", () => {
  it("resolves a repo URL found directly in the prompt", async () => {
    const provider = new ScriptedProvider([]); // must never be called
    const result = await repoResolverAgent(
      { provider },
      "here's a repo: https://github.com/example/example — add dark mode support",
    );
    expect(result.repoSource).toEqual({
      type: "git",
      location: "https://github.com/example/example",
    });
    expect(provider.calls).toBe(0);
    expect(result.goals[0]).toContain("add dark mode support");
  });
});

describe("repoResolverAgent — tool loop", () => {
  it("uses list_known_projects then resolves with a concrete path/goals", async () => {
    const provider = new ScriptedProvider([
      { thought: "check the roster", action: "list_known_projects" },
      {
        thought: "found it",
        action: "resolve",
        repoType: "path",
        location: "C:\\fake\\project\\path",
        goals: ["Improve error handling"],
      },
    ]);
    const result = await repoResolverAgent(
      { provider },
      "improve error handling in SomeProject",
    );
    expect(result.repoSource).toEqual({
      type: "path",
      location: "C:\\fake\\project\\path",
    });
    expect(result.goals).toEqual(["Improve error handling"]);
    expect(result.transcript.length).toBe(2);
  });

  it("refuses to guess when resolve is returned without a location", async () => {
    const provider = new ScriptedProvider([{ thought: "", action: "resolve" }]);
    await expect(
      repoResolverAgent({ provider }, "do something to my project"),
    ).rejects.toThrow(ResolveError);
  });

  it("gives up after the step cap rather than looping forever", async () => {
    const infiniteScript = Array.from({ length: 10 }, () => ({
      thought: "still looking",
      action: "list_known_projects",
    }));
    const provider = new ScriptedProvider(infiniteScript);
    await expect(repoResolverAgent({ provider }, "do something vague")).rejects.toThrow(
      ResolveError,
    );
  });
});
