import { describe, expect, it } from "vitest";
import {
  createWorkTheme,
  resumeWorkTheme,
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
    const theme = createWorkTheme({
      idea: "SermonSmith build",
      issue: "vite export O missing",
    });
    await withWorkTheme(theme, async () => {
      expect(currentWorkTheme()?.issue).toContain("vite export");
      updateWorkIssue("capacitorUpdaterPlugin missing export");
      expect(currentWorkTheme()?.issue).toContain("capacitorUpdaterPlugin");
    });
  });
});

describe("resumeWorkTheme — a resume keeps the run's ORIGINAL purpose", () => {
  it("themes the resume with the stored idea and app name, not the run id", () => {
    // Live 2026-08-23: IPlay run 751546a5 resumed after a deck relaunch and every
    // rotation selection read "for resume 751546a5-..." instead of the purpose.
    const input = resumeWorkTheme(
      {
        idea: "IPlay: make the avatar play the notes actually heard",
        appName: "iplay",
      },
      "751546a5-6a9f-4e7b-a3f8-b64210c21333",
    );
    const theme = createWorkTheme(input);
    expect(theme.theme).toBe(
      "iplay: IPlay: make the avatar play the notes actually heard",
    );
    expect(theme.theme).not.toMatch(/751546a5/);
    expect(input.stage).toBe("resume");
    expect(resumeWorkTheme({ idea: "x" }, "id", "epic-resume").stage).toBe(
      "epic-resume",
    );
  });

  it("falls back to a resume label only when no record (or idea) exists", () => {
    expect(resumeWorkTheme(null, "abc").idea).toBe("resume abc");
    expect(resumeWorkTheme({ idea: "   " }, "abc").idea).toBe("resume abc");
  });
});

describe("routeFitness — exclude non-coding free routes", () => {
  it("rejects guards, TTS, and vision-only models that poisoned review batches", () => {
    expect(unfitForCodeReason("groq/meta-llama/llama-prompt-guard-2-22m")).toBeTruthy();
    expect(unfitForCodeReason("ollama/moondream:latest")).toBeTruthy();
    expect(unfitForCodeReason("groq/canopylabs/orpheus-v1-english")).toBeTruthy();
    expect(unfitForCodeReason("nvidia_nim/microsoft/kosmos-2")).toBeTruthy();
    expect(
      unfitForCodeReason("openrouter/nvidia/nemotron-3.5-content-safety:free"),
    ).toBeTruthy();
  });

  it("keeps real coding models", () => {
    expect(isFitForCode("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(
      true,
    );
    expect(isFitForCode("ollama/qwen2.5-coder:7b")).toBe(true);
    expect(isFitForCode("anthropic_sub/claude-sonnet-5")).toBe(true);
  });
});
