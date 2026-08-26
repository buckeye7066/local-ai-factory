import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ErrorLedger,
  classifyErrorMessage,
  deckFrameFrom,
  errorLedgerPath,
  programFileFrom,
  renderErrorLines,
  routeIdFrom,
} from "../orchestrator/errorLedger.js";
import { groundFinalReport } from "../orchestrator/reportGrounding.js";
import type { LLMProvider } from "../../shared/types.js";

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  vi.stubEnv("FACTORY_DATA_DIR", dataDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("error ledger — deterministic signature table", () => {
  it("knows the live shapes from the 2026-08-23 IPlay run", () => {
    const interactions = classifyErrorMessage(
      '[route] generateJson: free attempt 1/3 failed (route gemini/deep-research-pro-preview-12-2025 HTTP 400: {"error":{"message":"This model only supports Interactions API."}})',
    );
    expect(interactions.classification).toBe("provider");
    expect(interactions.suggestion).toMatch(/deep-research|hold it out/i);
    expect(interactions.suggestionSource).toBe("signature");

    const overloaded = classifyErrorMessage(
      "[rotate] generateJson: nvidia_nim/deepseek-ai/deepseek-v4-flash-0731 failed (route nvidia_nim/deepseek-ai/deepseek-v4-flash-0731 HTTP 529: Service temporarily overloaded); rotating to the next pool [1/24].",
    );
    expect(overloaded.classification).toBe("provider");
    expect(overloaded.suggestion).toMatch(/cooling|rotat/i);

    const missing = classifyErrorMessage(
      "[rotate] 513 catalog route(s) skipped: credential env not set in this process (GEMINI_API_KEY, GROQ_API_KEY).",
    );
    expect(missing.classification).toBe("environment");
    expect(missing.suggestion).toMatch(/GEMINI_API_KEY/);
    expect(missing.suggestion).toMatch(/\.fcc[\\/]\.env/);

    expect(
      classifyErrorMessage("reasoning-only reply, no answer text").suggestion,
    ).toMatch(/maxTokens/);
    expect(
      classifyErrorMessage("route ollama/qwen3-coder:30b failed: model not found")
        .suggestion,
    ).toMatch(/ollama pull qwen3-coder:30b/);
    expect(
      classifyErrorMessage("Run failed: model call budget of 100 exhausted")
        .classification,
    ).toBe("budget");
    expect(classifyErrorMessage("fetch failed: ETIMEDOUT").suggestion).toMatch(
      /retry/i,
    );
    // Builder write refusals seen on the resumed IPlay run (08:02).
    const empty = classifyErrorMessage(
      "WRITE REFUSED: web/client/src/pages/Landing.tsx — empty contents for a new file — nothing to write",
    );
    expect(empty.classification).toBe("provider");
    expect(empty.suggestion).toMatch(/Landing\.tsx/);
    const unseen = classifyErrorMessage(
      "WRITE REFUSED: web/client/package.json — existing file was not supplied in full to this stage — refusing an unseen anchored edit",
    );
    expect(unseen.classification).toBe("deck-defect");
    expect(unseen.suggestion).toMatch(/resume/i);
    expect(
      classifyErrorMessage(
        "Run failed: Builder write incomplete: 10 required file(s) were refused.",
      ).suggestion,
    ).toMatch(/WRITE REFUSED/);
    // envFailure signatures are reused verbatim.
    expect(
      classifyErrorMessage("Error: Could not locate the bindings file.").classification,
    ).toBe("environment");
  });

  it("names the route and the program file when the text carries them", () => {
    expect(
      routeIdFrom("route openrouter/nvidia/nemotron-3-ultra-550b-a55b:free HTTP 429"),
    ).toBe("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(
      programFileFrom("FAILED iplay/test_scenes.py::test_plan - AssertionError"),
    ).toBe("iplay/test_scenes.py");
  });

  it("resolves a deck-side failure to file:line and the source line", () => {
    const err = new Error("boom");
    const frame = deckFrameFrom(err.stack);
    expect(frame).not.toBeNull();
    expect(frame!.file).toMatch(
      /src[\\/]server[\\/]__tests__[\\/]errorLedger\.test\.ts$/,
    );
    expect(frame!.line).toBeGreaterThan(0);
    expect(frame!.sourceLine).toContain('new Error("boom")');
  });
});

describe("ErrorLedger — record, classify, persist, render", () => {
  it("records provider, program and deck errors with the right code pointer", () => {
    const ledger = new ErrorLedger("11111111-2222-3333-4444-555555555555");
    const provider = ledger.record({
      stage: "architect",
      message:
        "[rotate] generateJson: nvidia_nim/deepseek-ai/deepseek-v4-flash-0731 failed (route nvidia_nim/deepseek-ai/deepseek-v4-flash-0731 HTTP 529: Service temporarily overloaded); rotating to the next pool [1/24].",
    });
    expect(provider.classification).toBe("provider");
    expect(provider.code.kind).toBe("route");
    expect(provider.code.route).toBe("nvidia_nim/deepseek-ai/deepseek-v4-flash-0731");

    const program = ledger.record({
      stage: "qa_critic",
      message:
        "`python -m pytest -q` exited 1: FAILED iplay/test_scenes.py::test_tiling - AssertionError",
      command: "python -m pytest -q",
      exitCode: 1,
    });
    expect(program.classification).toBe("program-defect");
    expect(program.code.kind).toBe("program");
    expect(program.code.file).toBe("iplay/test_scenes.py");
    expect(program.suggestion).toMatch(/iplay\/test_scenes\.py/);

    const deck = ledger.record({
      stage: "builder",
      message: "Run failed: Cannot read properties of undefined (reading 'tasks')",
      error: new Error("Cannot read properties of undefined (reading 'tasks')"),
    });
    expect(deck.classification).toBe("deck-defect");
    expect(deck.code.kind).toBe("deck");
    expect(deck.code.file).toMatch(/errorLedger\.test\.ts$/);
    expect(deck.code.sourceLine).toContain("new Error(");
    expect(deck.suggestionSource).toBe("none");
    expect(ledger.unresolved()).toEqual([deck]);
  });

  it("a failure carrying a route id is the provider's even with a deck frame, and is never model-triaged", async () => {
    const ledger = new ErrorLedger("11111111-2222-3333-4444-555555555555");
    const entry = ledger.record({
      stage: "builder",
      message:
        "Run failed: route openai_api/gpt-realtime-1.5 HTTP 404: This is not a chat model",
      error: new Error("This is not a chat model"),
    });
    expect(entry.code.kind).toBe("route");
    expect(entry.code.route).toBe("openai_api/gpt-realtime-1.5");
    expect(entry.classification).toBe("provider");
    expect(entry.suggestionSource).toBe("signature");
    expect(ledger.unresolved()).toEqual([]);
    let asked = 0;
    const provider = {
      name: "stub",
      isConfigured: () => true,
      generateText: async () => ({ text: "", provider: "stub" as const }),
      generateJson: async () => {
        asked += 1;
        return { suggestions: [] };
      },
    } as unknown as LLMProvider;
    expect(await ledger.suggestWithModel(provider)).toBe(0);
    expect(asked).toBe(0);
  });

  it("folds repeats into occurrences instead of duplicating rows", () => {
    const ledger = new ErrorLedger("11111111-2222-3333-4444-555555555555");
    ledger.record({ stage: "builder", message: "route x/y failed (HTTP 429)" });
    ledger.record({ stage: "builder", message: "route x/y failed (HTTP 429)" });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.occurrences).toBe(2);
  });

  it("treats route-journal failures as errors even at info level, but not successes", () => {
    expect(
      ErrorLedger.isErrorLogLine(
        "info",
        "[rotate] generateJson: a/b failed (route a/b HTTP 503: overloaded); rotating to the next pool [1/24].",
      ),
    ).toBe(true);
    expect(
      ErrorLedger.isErrorLogLine(
        "info",
        "[route] generateJson: free attempt 1/3 failed (x); retrying",
      ),
    ).toBe(true);
    expect(
      ErrorLedger.isErrorLogLine(
        "info",
        "[rotate] generateJson: a/b [free-tier/frontier] as author",
      ),
    ).toBe(false);
    expect(ErrorLedger.isErrorLogLine("error", "anything")).toBe(true);
    expect(ErrorLedger.isErrorLogLine("warning", "Provider switched on resume")).toBe(
      false,
    );
    expect(ErrorLedger.isErrorLogLine("warning", "WIRING SCAN FAILED: x")).toBe(true);
  });

  it("writes the ledger file under FACTORY_DATA_DIR and prints one summary line", () => {
    const runId = "11111111-2222-3333-4444-555555555555";
    const ledger = new ErrorLedger(runId);
    expect(ledger.summaryLine()).toBe("[errors] none");
    ledger.record({
      stage: "intake",
      message: "Run failed: boom",
      error: new Error("boom"),
    });
    const file = ledger.writeFile();
    expect(file).toBe(errorLedgerPath(runId));
    expect(file.startsWith(dataDir)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, "utf-8")) as { errors: unknown[] };
    expect(saved.errors).toHaveLength(1);
    expect(ledger.summaryLine()).toBe(`[errors] 1 recorded -> ${file}`);
  });

  it("asks a model ONLY for unexplained entries and labels the answer unverified", async () => {
    const ledger = new ErrorLedger("11111111-2222-3333-4444-555555555555");
    const known = ledger.record({
      stage: "builder",
      message: "route a/b failed (HTTP 429)",
    });
    const unknown = ledger.record({
      stage: "builder",
      message: "Run failed: weird",
      error: new Error("weird"),
    });
    const calls: unknown[] = [];
    const provider = {
      name: "stub",
      isConfigured: () => true,
      generateText: async () => ({ text: "", provider: "stub" as const }),
      generateJson: async (input: { prompt: string }) => {
        calls.push(input);
        return {
          suggestions: [
            { id: unknown.id, fix: "Guard the plan before reading tasks." },
          ],
        };
      },
    } as unknown as LLMProvider;
    expect(await ledger.suggestWithModel(provider)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(String((calls[0] as { prompt: string }).prompt)).not.toContain(known.id);
    expect(unknown.suggestion).toBe(
      "model suggestion, unverified: Guard the plan before reading tasks.",
    );
    expect(unknown.suggestionSource).toBe("model");
    expect(known.suggestionSource).toBe("signature");
    // Nothing left to ask: no second call.
    expect(await ledger.suggestWithModel(provider)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("renders one readable line per error and lands in the final report's Errors section", () => {
    const ledger = new ErrorLedger("11111111-2222-3333-4444-555555555555");
    ledger.record({
      stage: "architect",
      message:
        "route gemini/deep-research-preview-04-2026 HTTP 400: This model only supports Interactions API.",
    });
    const lines = renderErrorLines(ledger.entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[architect\] provider: /);
    expect(lines[0]).toMatch(/route gemini\/deep-research-preview-04-2026/);
    expect(lines[0]).toMatch(/fix: .*deep-research/);

    const report = groundFinalReport({
      report: {
        appName: "x",
        summary: "done",
        whatWasBuilt: [],
        howToRun: "run",
        testStatus: "unknown",
        repairLoops: 0,
        caveats: [],
        nextImprovements: [],
        workspacePath: "w",
        providerUsage: {
          free: { calls: 0 },
          anthropic: { calls: 0 },
          openai: { calls: 0 },
          stub: { calls: 0 },
          mock: { calls: 0 },
          totalCalls: 0,
        },
      },
      evidence: { executed: [] },
      testStatus: "unknown",
      writtenFiles: ["a.ts"],
      errors: lines,
    });
    expect(report.errors).toEqual(lines);
  });
});
