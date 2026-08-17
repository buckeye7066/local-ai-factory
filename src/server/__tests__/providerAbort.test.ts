import { describe, it, expect, vi } from "vitest";

/**
 * providerAbort.test.ts — regression coverage for the adversarial-review
 * finding: paid-provider calls were bounded only by stage-boundary checks
 * (`throwIfTimedOut`/`throwIfCancelled` between pipeline stages), never by
 * anything reaching INSIDE a single in-flight `client.messages.create()` /
 * `client.responses.create()` await. A hung SDK call used to block past
 * FACTORY_RUN_TIMEOUT_MS and past a cancel request, bounded only by whatever
 * default the SDK itself happened to apply.
 *
 * Every test below drives a call that would hang FOREVER if left unbounded
 * (`new Promise(() => {})`, which never resolves or rejects on its own) and
 * asserts the surrounding code still terminates well inside a small budget —
 * "the test would time out" is the failure mode being guarded against, so a
 * check that can pass on the pre-fix code would prove nothing.
 */

const anthropicCreateCalls: { params: unknown; options: { signal?: AbortSignal } }[] =
  [];
const openaiCreateCalls: { params: unknown; options: { signal?: AbortSignal } }[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: vi.fn(() => {
        throw new Error(
          "messages.create() should not be reached - the provider streams (large non-streaming calls are refused by the SDK)",
        );
      }),
      // The provider now STREAMS every call (the SDK refuses large
      // non-streaming requests). A wedged stream = finalMessage() that never
      // settles; the abort contract is identical.
      stream: vi.fn((params: unknown, options: { signal?: AbortSignal } = {}) => {
        anthropicCreateCalls.push({ params, options });
        return { finalMessage: () => new Promise(() => {}) };
      }),
    };
    constructor(public opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

vi.mock("openai", () => {
  class FakeOpenAI {
    responses = {
      create: vi.fn((params: unknown, options: { signal?: AbortSignal } = {}) => {
        openaiCreateCalls.push({ params, options });
        return new Promise(() => {});
      }),
    };
    constructor(public opts: unknown) {}
  }
  return { default: FakeOpenAI };
});

import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { OpenAIProvider } from "../providers/openaiProvider.js";
import { FreeProvider } from "../providers/freeProvider.js";
import { FailoverProvider } from "../providers/failoverProvider.js";
import { withRetry, ProviderAbortError } from "../providers/types.js";
import {
  getCancelSignal,
  requestCancel,
  clearCancel,
} from "../orchestrator/cancellation.js";
import { startRun } from "../orchestrator/runFactory.js";
import { loadConfig, loadSecrets } from "../config.js";
import type {
  LLMProvider,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";

/** Never settles unless raced against a signal — the shape of a real wedge. */
function hang<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("withRetry bounds a wedged call by its AbortSignal", () => {
  it("rejects with ProviderAbortError well inside the signal's own budget, without retrying", async () => {
    let calls = 0;
    const fn = () => {
      calls += 1;
      return hang<string>();
    };
    const signal = AbortSignal.timeout(80);
    const start = Date.now();

    await expect(withRetry("test.hang", fn, 3, signal)).rejects.toBeInstanceOf(
      ProviderAbortError,
    );

    expect(Date.now() - start).toBeLessThan(2000);
    // A deliberate abort must not burn the remaining retry attempts.
    expect(calls).toBe(1);
  });

  it("never even attempts the call if the signal fired before withRetry started", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const fn = () => {
      calls += 1;
      return hang<string>();
    };
    await expect(
      withRetry("test.pre-aborted", fn, 3, controller.signal),
    ).rejects.toBeInstanceOf(ProviderAbortError);
    expect(calls).toBe(0);
  });
});

describe("cancellation.getCancelSignal reaches an in-flight call", () => {
  it("aborts a wedged call the moment requestCancel is invoked, not at the next checkpoint", async () => {
    const runId = `test-cancel-${Math.random().toString(36).slice(2)}`;
    const signal = getCancelSignal(runId);
    const pending = withRetry("test.cancel", () => hang<string>(), 3, signal);

    const start = Date.now();
    setTimeout(() => requestCancel(runId), 30);

    await expect(pending).rejects.toBeInstanceOf(ProviderAbortError);
    expect(Date.now() - start).toBeLessThan(1000);

    clearCancel(runId);
  });
});

describe("AnthropicProvider bounds a wedged SDK call", () => {
  it("generateText: passes the signal to messages.stream() AND aborts within budget", async () => {
    anthropicCreateCalls.length = 0;
    const signal = AbortSignal.timeout(80);
    const provider = new AnthropicProvider("sk-test", "claude-test", undefined, signal);

    const start = Date.now();
    await expect(
      provider.generateText({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(ProviderAbortError);
    expect(Date.now() - start).toBeLessThan(2000);

    expect(anthropicCreateCalls.length).toBeGreaterThan(0);
    expect(anthropicCreateCalls[0].options.signal).toBe(signal);
  });

  it("generateJson: also aborts within budget (both callOnce round-trips are covered)", async () => {
    anthropicCreateCalls.length = 0;
    const signal = AbortSignal.timeout(80);
    const provider = new AnthropicProvider("sk-test", "claude-test", undefined, signal);
    const { z } = await import("zod");

    const start = Date.now();
    await expect(
      provider.generateJson({
        system: "s",
        prompt: "p",
        schema: z.object({ ok: z.boolean() }),
        schemaName: "Ok",
      }),
    ).rejects.toBeInstanceOf(ProviderAbortError);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("OpenAIProvider bounds a wedged SDK call", () => {
  it("generateText: passes the signal to responses.create() AND aborts within budget", async () => {
    openaiCreateCalls.length = 0;
    const signal = AbortSignal.timeout(80);
    const provider = new OpenAIProvider("sk-test", "gpt-test", undefined, signal);

    const start = Date.now();
    await expect(
      provider.generateText({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(ProviderAbortError);
    expect(Date.now() - start).toBeLessThan(2000);

    expect(openaiCreateCalls.length).toBeGreaterThan(0);
    expect(openaiCreateCalls[0].options.signal).toBe(signal);
  });
});

/** Records whether it was invoked, so a test can assert the OTHER tier was skipped. */
class SpyPaidProvider implements LLMProvider {
  calls = 0;
  constructor(readonly name: "anthropic" | "openai") {}
  isConfigured(): boolean {
    return true;
  }
  async generateText(): Promise<GenerateTextResult> {
    this.calls += 1;
    return { text: "PAID", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.calls += 1;
    return input.schema.parse({});
  }
}

/** A paid tier whose call hangs until `signal` fires, exactly like the real providers. */
class HangingPaidProvider implements LLMProvider {
  constructor(
    readonly name: "anthropic" | "openai",
    private signal: AbortSignal,
  ) {}
  isConfigured(): boolean {
    return true;
  }
  async generateText(): Promise<GenerateTextResult> {
    return withRetry(
      "test.hanging-paid",
      () => hang<GenerateTextResult>(),
      3,
      this.signal,
    );
  }
  async generateJson<T>(_input: GenerateJsonInput<T>): Promise<T> {
    return withRetry("test.hanging-paid", () => hang<T>(), 3, this.signal);
  }
}

describe("FailoverProvider treats a ProviderAbortError as a hard stop, not a transient failure", () => {
  it("does not retry the other paid tier and does not fall back to free after an abort", async () => {
    const free = new FreeProvider({
      baseUrl: "",
      authToken: "",
      model: "unused",
      ollamaUrl: "",
      maxConcurrency: 1,
      backpressureRetryMs: 10,
      enabled: false, // not configured -> execute() goes straight to the paid tiers
    });
    const signal = AbortSignal.timeout(80);
    const anthropic = new HangingPaidProvider("anthropic", signal);
    const openai = new SpyPaidProvider("openai");
    const logs: string[] = [];

    const chain = new FailoverProvider(
      free,
      anthropic,
      openai,
      {
        holdMs: 1000,
        attempts: 2,
        retrySpacingMs: 10,
        maxBackpressureRetries: 2,
        baseUrl: "",
        autoRestart: false,
      },
      (_kind, message) => logs.push(message),
    );

    const start = Date.now();
    await expect(
      chain.generateText({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(ProviderAbortError);
    expect(Date.now() - start).toBeLessThan(2000);

    // The abort must propagate as-is, not be reinterpreted as "this paid tier
    // failed, try the next one" (that would silently spend on openai for a
    // call the caller already gave up on).
    expect(openai.calls).toBe(0);
  });
});

describe("end-to-end: a hung paid Anthropic call is bounded by FACTORY_RUN_TIMEOUT_MS", () => {
  it("marks the run failed (timed out) instead of hanging past the configured deadline", async () => {
    anthropicCreateCalls.length = 0;
    const config = {
      ...loadConfig({ FACTORY_FREE_ENABLED: "0" } as NodeJS.ProcessEnv),
    };
    const secrets = loadSecrets({ ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv);

    const run = startRun({
      idea: "Build a chore tracker",
      options: {
        demo: false,
        codeProvider: "anthropic",
        reviewProvider: "anthropic",
        allowPaidProviderCalls: true,
        timeoutMs: 150,
      },
      config,
      secrets,
    });

    const start = Date.now();
    await vi.waitFor(() => expect(run.status).toBe("failed"), { timeout: 5_000 });
    const elapsed = Date.now() - start;

    // Bounded by the configured 150ms deadline plus scheduling slack — nowhere
    // near "hangs until the process is killed", which is what the pre-fix
    // behaviour would have done here (the mocked SDK call never resolves).
    expect(elapsed).toBeLessThan(4_000);
    expect(run.error).toMatch(/timed out/i);
    expect(anthropicCreateCalls.length).toBeGreaterThan(0);
  }, 10_000);
});
