import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkTheme,
  stampWorkTheme,
  ThemedProvider,
  withWorkTheme,
  currentWorkTheme,
  updateWorkIssue,
} from "../orchestrator/workTheme.js";
import type { LLMProvider } from "../../shared/types.js";
import { isFitForCode, unfitForCodeReason } from "../providers/routeFitness.js";

class CaptureProvider implements LLMProvider {
  readonly name = "mock" as const;
  lastSystem = "";
  isConfigured() {
    return true;
  }
  async generateText(input: { system: string; prompt: string }) {
    this.lastSystem = input.system;
    return { text: "ok", provider: this.name };
  }
  async generateJson<T>(input: { system: string; prompt: string }): Promise<T> {
    this.lastSystem = input.system;
    return { ok: true } as T;
  }
}

describe("workTheme — directed multi-model focus", () => {
  it("runFactory is restored and binds entrypoints through withWorkTheme", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/server/orchestrator/runFactory.ts"),
      "utf8",
    );
    expect(src.startsWith("@file:")).toBe(false);
    expect(src.startsWith("PLACEHOLDER_RESTORE_IN_PROGRESS")).toBe(false);
    expect(src).toContain("export function startRun");
    expect(src).toContain("withWorkTheme(theme");
  });

  it("stamps the same theme into every provider call", async () => {
    const theme = createWorkTheme({
      idea: "fix GrantFlow publication suite timeouts",
      appName: "GrantFlow",
      issue: "hamiltonPacketBilingual.test.js times out at 15s",
      constraints: ["Never edit dist/ or node_modules/"],
    });
    const inner = new CaptureProvider();
    const directed = new ThemedProvider(inner, theme);
    await directed.generateText({ system: "You are a fixer.", prompt: "go" });
    expect(inner.lastSystem).toContain("DIRECTED WORK THEME");
    expect(inner.lastSystem).toContain("GrantFlow");
    expect(inner.lastSystem).toContain("hamiltonPacketBilingual");
    expect(inner.lastSystem).toContain("Never edit dist/");
  });

  it("does not duplicate the stamp when already present", () => {
    const theme = createWorkTheme({ idea: "x", issue: "y" });
    const once = stampWorkTheme("base", theme);
    const twice = stampWorkTheme(once, theme);
    expect(twice).toBe(once);
  });

  it("AsyncLocalStorage shares one issue across the async subtree", async () => {
    const theme = createWorkTheme({ idea: "SermonSmith build", issue: "vite export O missing" });
    await withWorkTheme(theme, async () => {
      expect(currentWorkTheme()?.issue).toContain("vite export");
      updateWorkIssue("capacitorUpdaterPlugin missing export");
      expect(currentWorkTheme()?.issue).toContain("capacitorUpdaterPlugin");
    });
  });
});

describe("routeFitness — exclude non-coding free routes", () => {
  it("rejects guards, TTS, and vision-only models that poisoned review batches", () => {
    expect(unfitForCodeReason("groq/meta-llama/llama-prompt-guard-2-22m")).toBeTruthy();
    expect(unfitForCodeReason("ollama/moondream:latest")).toBeTruthy();
    expect(unfitForCodeReason("groq/canopylabs/orpheus-v1-english")).toBeTruthy();
    expect(unfitForCodeReason("nvidia_nim/microsoft/kosmos-2")).toBeTruthy();
    expect(unfitForCodeReason("openrouter/nvidia/nemotron-3.5-content-safety:free")).toBeTruthy();
  });

  it("keeps real coding models", () => {
    expect(isFitForCode("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(true);
    expect(isFitForCode("ollama/qwen2.5-coder:7b")).toBe(true);
    expect(isFitForCode("anthropic_sub/claude-sonnet-5")).toBe(true);
  });
});
