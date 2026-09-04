import { describe, it, expect } from "vitest";
import {
  sanitizeChildEnv,
  hardenArgs,
  argsAreShellSafe,
  isAllowed,
} from "../workspace/commandRunner.js";
import { CountingProvider, ModelBudgetError } from "../orchestrator/stages.js";
import { ModelLadderProvider } from "../providers/modelLadderProvider.js";
import { ProviderModelUnavailableError } from "../providers/types.js";
import { PaidBudgetExhaustedError } from "../providers/paidBudget.js";
import type { LLMProvider, GenerateTextResult } from "../../shared/types.js";
import type { RunRecord } from "../../shared/schemas.js";

/**
 * Hardening tests for the command-execution boundary:
 *  - NO INHERITED SECRETS (spec 5.15 #2): credential-shaped env vars are
 *    stripped before any child process is spawned.
 *  - UNTRUSTED LIFECYCLE SCRIPTS / prompt-injection (#3, #4): installs run with
 *    --ignore-scripts so a model-authored package.json cannot execute code.
 *  - BUDGET (#5): the per-run model-call budget is enforced.
 */

describe("sanitizeChildEnv — no inherited secrets", () => {
  it("strips API keys, tokens, secrets, and passwords by name", () => {
    const clean = sanitizeChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-ant-leakme",
      OPENAI_API_KEY: "sk-oai-leakme",
      GITHUB_TOKEN: "ghp_leak",
      MY_SECRET: "hunter2",
      DB_PASSWORD: "pw",
      SESSION_COOKIE: "abc",
      NODE_ENV: "production",
    });
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.HOME).toBe("/home/x");
    expect(clean.NODE_ENV).toBe("production");
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.OPENAI_API_KEY).toBeUndefined();
    expect(clean.GITHUB_TOKEN).toBeUndefined();
    expect(clean.MY_SECRET).toBeUndefined();
    expect(clean.DB_PASSWORD).toBeUndefined();
    expect(clean.SESSION_COOKIE).toBeUndefined();
  });

  it("never returns a value that looks like a factory key", () => {
    const values = Object.values(
      sanitizeChildEnv({
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-ant-secret-value",
        OPENAI_API_KEY: "sk-oai-secret-value",
      }),
    );
    expect(values.some((v) => String(v).includes("secret-value"))).toBe(false);
  });
});

describe("hardenArgs — untrusted install lifecycle scripts", () => {
  it("appends --ignore-scripts to install and ci (+ --ignore-pnpmfile for pnpm)", () => {
    // Round-7 #1: pnpm also loads a project `.pnpmfile.cjs` during resolution
    // that --ignore-scripts does NOT disable, so pnpm installs also drop it.
    expect(hardenArgs("pnpm", ["install"])).toEqual([
      "install",
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]);
    expect(hardenArgs("npm", ["install"])).toEqual(["install", "--ignore-scripts"]);
    expect(hardenArgs("npm", ["ci"])).toEqual(["ci", "--ignore-scripts"]);
    expect(hardenArgs("yarn", ["install"])).toEqual(["install", "--ignore-scripts"]);
  });

  it("does not touch non-install commands", () => {
    expect(hardenArgs("pnpm", ["test"])).toEqual(["test"]);
    expect(hardenArgs("pnpm", ["run", "build"])).toEqual(["run", "build"]);
    expect(hardenArgs("npx", ["tsc"])).toEqual(["tsc"]);
  });

  it("is idempotent (never adds the flag twice)", () => {
    const once = hardenArgs("pnpm", ["install"]);
    expect(hardenArgs("pnpm", once)).toEqual([
      "install",
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]);
  });

  it("keeps hardened install args on the allowlist and shell-safe", () => {
    const args = hardenArgs("pnpm", ["install"]);
    expect(isAllowed("pnpm", args)).toBe(true);
    expect(argsAreShellSafe("pnpm", args)).toBe(true);
  });
});

describe("CountingProvider — model-call budget (#5)", () => {
  const inner: LLMProvider = {
    name: "stub",
    isConfigured: () => true,
    async generateText(): Promise<GenerateTextResult> {
      return { text: "ok", provider: "stub" };
    },
    async generateJson<T>(): Promise<T> {
      return {} as T;
    },
  };

  function fakeRun(): RunRecord {
    return {
      providerUsage: {
        free: { calls: 0 },
        anthropic: { calls: 0 },
        openai: { calls: 0 },
        stub: { calls: 0 },
        mock: { calls: 0 },
        totalCalls: 0,
      },
      // Only the fields CountingProvider reads are needed; the rest is unused.
      id: "budget-test-run",
    } as unknown as RunRecord;
  }

  it("throws ModelBudgetError once the cap is reached", async () => {
    const run = fakeRun();
    const capped = new CountingProvider(inner, run, 2);
    await capped.generateText({ system: "s", prompt: "p" });
    await capped.generateText({ system: "s", prompt: "p" });
    expect(run.providerUsage.totalCalls).toBe(2);
    await expect(capped.generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      ModelBudgetError,
    );
  });

  it("does not charge catalog-only refusals before reaching a real fallback call", async () => {
    const run = fakeRun();
    let refusedGenerateCalls = 0;
    const catalogRefusal: LLMProvider = {
      name: "anthropic",
      isConfigured: () => true,
      prepareCall: async () => {
        throw new ProviderModelUnavailableError(
          "anthropic model unavailable in the account catalog",
        );
      },
      async generateText() {
        refusedGenerateCalls += 1;
        throw new Error("must not reach generation");
      },
      async generateJson<T>() {
        throw new Error("must not reach generation") as T;
      },
    };
    const openai: LLMProvider = {
      name: "openai",
      isConfigured: () => true,
      async generateText() {
        return { text: "ok", provider: "openai" };
      },
      async generateJson<T>() {
        return {} as T;
      },
    };
    const ladder = new ModelLadderProvider([
      {
        model: "claude-unavailable",
        provider: new CountingProvider(catalogRefusal, run, 1),
      },
      { model: "gpt-live", provider: new CountingProvider(openai, run, 1) },
    ]);

    await expect(ladder.generateText({ system: "s", prompt: "p" })).resolves.toEqual({
      text: "ok",
      provider: "openai",
    });
    expect(refusedGenerateCalls).toBe(0);
    expect(run.providerUsage).toMatchObject({
      totalCalls: 1,
      anthropic: { calls: 0 },
      openai: { calls: 1 },
    });
  });

  it("does not charge a global paid-budget refusal or probe another paid rung", async () => {
    const run = fakeRun();
    let redundantPaidCalls = 0;
    const capped: LLMProvider = {
      name: "anthropic",
      isConfigured: () => true,
      async generateText() {
        throw new PaidBudgetExhaustedError("paid-rescue cap reached");
      },
      async generateJson<T>() {
        throw new PaidBudgetExhaustedError("paid-rescue cap reached") as T;
      },
    };
    const redundantPaid: LLMProvider = {
      name: "openai",
      isConfigured: () => true,
      async generateText() {
        redundantPaidCalls += 1;
        return { text: "must not run", provider: "openai" };
      },
      async generateJson<T>() {
        redundantPaidCalls += 1;
        return {} as T;
      },
    };
    const free: LLMProvider = {
      name: "free",
      isConfigured: () => true,
      async generateText() {
        return { text: "free", provider: "free" };
      },
      async generateJson<T>() {
        return {} as T;
      },
    };
    const ladder = new ModelLadderProvider([
      { model: "claude-capped", provider: new CountingProvider(capped, run, 1) },
      {
        model: "gpt-redundant",
        provider: new CountingProvider(redundantPaid, run, 1),
      },
      { model: "free-live", provider: new CountingProvider(free, run, 1) },
    ]);

    await expect(ladder.generateText({ system: "s", prompt: "p" })).resolves.toEqual({
      text: "free",
      provider: "free",
    });
    expect(redundantPaidCalls).toBe(0);
    expect(run.providerUsage).toMatchObject({
      totalCalls: 1,
      anthropic: { calls: 0 },
      openai: { calls: 0 },
      free: { calls: 1 },
    });
  });

  it("retains the logical count when paid exhaustion follows provider I/O", async () => {
    const run = fakeRun();
    let calls = 0;
    const partial: LLMProvider = {
      name: "openai",
      isConfigured: () => true,
      async generateText() {
        calls += 1;
        const refusal = new PaidBudgetExhaustedError("paid-rescue cap reached");
        refusal.markProviderAttemptOccurred();
        throw refusal;
      },
      async generateJson<T>() {
        throw new Error("unused") as T;
      },
    };
    const counted = new CountingProvider(partial, run, 1);

    await expect(
      counted.generateText({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(PaidBudgetExhaustedError);
    await expect(
      counted.generateText({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(ModelBudgetError);
    expect(calls).toBe(1);
    expect(run.providerUsage).toMatchObject({
      totalCalls: 1,
      openai: { calls: 1 },
    });
  });
});
