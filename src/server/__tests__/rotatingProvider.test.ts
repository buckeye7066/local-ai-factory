/**
 * rotatingProvider.test.ts — the provider half of the rotation contract's
 * equivalence suite (mirrors flexfactor_rotation_tests.py RotatingProviderTests
 * and ClassificationTests, adapted to this repo's LLMProvider surface).
 *
 * Everything runs offline: `fetch` is stubbed, the FCC delegate is a fake,
 * and the catalog + shared state live in a throwaway directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  buildRotator,
  PinUnavailable,
  StateStore,
} from "../rotation/aitimeRotation.js";
import {
  RotatingProvider,
  classifyOutcome,
  filterRoutableCatalog,
  isRetryableAcrossPools,
} from "../rotation/rotatingProvider.js";
import { FailoverProvider } from "../providers/failoverProvider.js";
import { resetRouteState, resetThresholdCache } from "../providers/freeRoute.js";
import { ProviderAbortError } from "../providers/types.js";
import type { FreeProvider } from "../providers/freeProvider.js";

let dir: string;

const FCC_URL = "http://127.0.0.1:8082";

interface RowOpts {
  pool?: string;
  tier?: string;
  cost_class?: string;
  api?: string;
  base_url?: string;
  auth_env?: string;
  auth_kind?: string;
  enabled?: boolean;
  model?: string;
}

function row(id: string, opts: RowOpts = {}): Record<string, unknown> {
  const backend = id.split("/")[0];
  return {
    id,
    backend,
    model: opts.model ?? id.split("/").slice(1).join("/"),
    wire_model: opts.model ?? id.split("/").slice(1).join("/"),
    api: opts.api ?? "openai",
    base_url: opts.base_url ?? `https://${backend}.example.invalid/v1`,
    pool: opts.pool ?? `${backend}:pool`,
    auth_env: opts.auth_env ?? "",
    auth_kind: opts.auth_kind ?? (opts.auth_env ? "bearer" : "none"),
    cost_class: opts.cost_class ?? "free-tier",
    tier: opts.tier ?? "frontier",
    enabled: opts.enabled ?? true,
  };
}

function writeCatalog(rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(dir, "routes.json"),
    JSON.stringify({ schema: 1, generated_at: new Date().toISOString(), routes: rows }),
  );
}

function fccStub(overrides: Partial<FreeProvider> = {}): FreeProvider {
  return {
    name: "free",
    isConfigured: () => true,
    resetTransport: () => {},
    generateText: async () => ({ text: "served by fcc", provider: "free" as const }),
    generateJson: async () => ({ ok: true }),
    ...overrides,
  } as unknown as FreeProvider;
}

function provider(
  opts: {
    fcc?: FreeProvider | null;
    signal?: AbortSignal;
  } = {},
): RotatingProvider {
  const rotator = buildRotator("factory-deck");
  if (!rotator) throw new Error("no rotator for test");
  return new RotatingProvider(rotator, {
    fccDelegate: opts.fcc ?? null,
    fccBaseUrl: FCC_URL,
    tier: "frontier",
    signal: opts.signal,
  });
}

/** JSON body for an OpenAI-compatible completion. */
function openaiBody(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

/** Stub fetch: responds per base-url match, defaulting to echoing the model. */
function stubFetch(
  handler?: (url: string, init: RequestInit) => Response | undefined,
): FetchStub {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const special = handler?.(url, init ?? {});
    if (special) return special;
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return new Response(openaiBody(`completed by ${body.model ?? "?"}`), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn as unknown as FetchStub;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotating-provider-test-"));
  vi.stubEnv("AITIME_STATE_DIR", dir);
  vi.stubEnv("AI_ROTATE", "on");
  vi.stubEnv("AI_ROTATE_PIN", "");
  resetRouteState();
  resetThresholdCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("RotatingProvider", () => {
  it("successive calls land on different pools", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    stubFetch();
    const prov = provider();
    const results = new Set([
      (await prov.generateText({ system: "s", prompt: "p" })).text,
      (await prov.generateText({ system: "s", prompt: "p" })).text,
    ]);
    expect(results).toEqual(new Set(["completed by one", "completed by one"]));
    // Distinguish by pool via the state file: both pools took exactly one call.
    const state = new StateStore().read();
    expect(state.pools["pool-a"].calls).toBe(1);
    expect(state.pools["pool-b"].calls).toBe(1);
  });

  it("a rate-limited pool is skipped on the next call", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    stubFetch((url) =>
      url.includes("aaa.example.invalid")
        ? new Response("rate limit exceeded", { status: 429 })
        : undefined,
    );
    const prov = provider();
    // Whichever call reaches aaa fails over to bbb; afterwards pool-a cools.
    await prov.generateText({ system: "s", prompt: "p" });
    await prov.generateText({ system: "s", prompt: "p" });
    const state = new StateStore().read();
    expect(state.cooldowns["pool-a"]).toBeGreaterThan(Date.now() / 1000);
    expect(state.pools["pool-b"].calls).toBeGreaterThanOrEqual(1);
  });

  it("a 400 is raised immediately, not rotated past", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    const fetchFn = stubFetch(() => new Response("invalid request", { status: 400 }));
    const prov = provider();
    await expect(prov.generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      /HTTP 400/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("every pool failing surfaces the last real error", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    stubFetch(() => new Response("overloaded", { status: 503 }));
    const prov = provider();
    await expect(prov.generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      /every frontier pool failed.*overloaded/s,
    );
  });

  it("model reflects the route actually used", async () => {
    writeCatalog([row("openrouter/x-ai/grok-4.6", { pool: "openrouter:credits" })]);
    stubFetch();
    const prov = provider();
    await prov.generateText({ system: "s", prompt: "p" });
    expect(prov.model).toBe("x-ai/grok-4.6");
  });

  it("a retry-after header sets the cooldown length", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    stubFetch((url) =>
      url.includes("aaa.example.invalid")
        ? new Response("rate limit", { status: 429, headers: { "retry-after": "900" } })
        : undefined,
    );
    const prov = provider();
    await prov.generateText({ system: "s", prompt: "p" });
    const cooldowns = new StateStore().read().cooldowns;
    expect(cooldowns["pool-a"] - Date.now() / 1000).toBeGreaterThan(600);
  });

  it("a route whose credential env var is missing is rotated past, not fatal", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a", auth_env: "NO_SUCH_KEY_EVER_SET" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    const fetchFn = stubFetch();
    const prov = provider();
    const first = await prov.generateText({ system: "s", prompt: "p" });
    const second = await prov.generateText({ system: "s", prompt: "p" });
    expect(first.text).toBe("completed by one");
    expect(second.text).toBe("completed by one");
    // Only bbb is ever fetched — aaa has no key and never leaves the machine.
    for (const call of fetchFn.mock.calls) {
      expect(String(call[0])).toContain("bbb.example.invalid");
    }
  });

  it("sends a real User-Agent and the bearer credential as a HEADER", async () => {
    vi.stubEnv("TEST_ROTATION_KEY", "sk-test-123");
    writeCatalog([
      row("groq/llama", { pool: "groq:free-tier", auth_env: "TEST_ROTATION_KEY" }),
    ]);
    const fetchFn = stubFetch();
    await provider().generateText({ system: "s", prompt: "p" });
    const [url, init] = fetchFn.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    // Default fetch UA is Cloudflare-blocked (1010) at Groq/Cerebras.
    expect(headers["user-agent"]).toMatch(/local-ai-factory/);
    expect(headers["authorization"]).toBe("Bearer sk-test-123");
    expect(String(url)).not.toContain("sk-test-123"); // never in the URL
  });

  it("speaks the gemini wire shape for gemini routes", async () => {
    vi.stubEnv("TEST_GEMINI_KEY", "g-key");
    writeCatalog([
      row("gemini/gemini-2.5-flash", {
        pool: "gemini:free-tier",
        api: "gemini",
        base_url: "https://generativelanguage.example.invalid/v1beta",
        auth_env: "TEST_GEMINI_KEY",
        auth_kind: "x-goog-api-key",
      }),
    ]);
    const fetchFn = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "gemini says hi" }] } }],
          }),
          { status: 200 },
        ),
    );
    const result = await provider().generateText({ system: "s", prompt: "p" });
    expect(result.text).toBe("gemini says hi");
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("/models/gemini-2.5-flash:generateContent");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
  });

  it("calls Ollama's NATIVE /api/chat with the reasoning channel off", async () => {
    // Measured 2026-08-23: /v1 ignores think:false while /api/chat honours it,
    // and on this CPU that is 551 s of reasoning vs a 7 s fix for gemma4:26b.
    writeCatalog([
      row("ollama/qwen3-coder:30b", {
        pool: "local:ollama",
        api: "ollama",
        base_url: "http://127.0.0.1:11434",
        cost_class: "local-unlimited",
      }),
    ]);
    const fetchFn = stubFetch((url) =>
      url.endsWith("/api/chat")
        ? new Response(
            JSON.stringify({ message: { role: "assistant", content: "native ok" }, done_reason: "stop" }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : undefined,
    );
    const out = await provider().generateText({ system: "s", prompt: "p" });
    expect(out.text).toBe("native ok");
    expect(String(fetchFn.mock.calls[0][0])).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String((fetchFn.mock.calls[0][1] as RequestInit).body));
    expect(body.think).toBe(false);
    expect(body.options.num_predict).toBeGreaterThan(0);
  });

  it("a reasoning-only native Ollama reply is named as a budget problem", async () => {
    writeCatalog([
      row("ollama/gemma4:26b", {
        pool: "local:ollama",
        api: "ollama",
        base_url: "http://127.0.0.1:11434",
        cost_class: "local-unlimited",
      }),
    ]);
    stubFetch((url) =>
      url.endsWith("/api/chat")
        ? new Response(
            JSON.stringify({ message: { role: "assistant", content: "", thinking: "hmm..." }, done_reason: "length" }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : undefined,
    );
    await expect(provider().generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      /reasoning/,
    );
  });

  it("delegates FCC catalog routes to the existing FreeProvider machinery", async () => {
    writeCatalog([
      row("anthropic_sub/claude-fable-5", {
        pool: "anthropic:max-plan",
        api: "anthropic",
        base_url: FCC_URL,
        cost_class: "subscription",
        auth_kind: "anthropic-token",
        auth_env: "FCC_TOKEN_UNSET",
      }),
    ]);
    const fetchFn = stubFetch();
    const generateText = vi.fn(async () => ({
      text: "served by fcc",
      provider: "free" as const,
    }));
    const prov = provider({
      fcc: fccStub({ generateText } as unknown as Partial<FreeProvider>),
    });
    const result = await prov.generateText({ system: "s", prompt: "p" });
    expect(result.text).toBe("served by fcc");
    expect(generateText).toHaveBeenCalledTimes(1);
    // The proxy is reached through the delegate, never through a raw fetch —
    // and its missing env var is irrelevant because delegation owns auth.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("NEVER promotes to a paid cost class: paid routes are unreachable", async () => {
    writeCatalog([
      row("openai_api/gpt-4o", {
        pool: "openai_api:paid",
        cost_class: "paid-metered",
        base_url: "https://api.openai.example.invalid/v1",
      }),
      row("groq/llama", { pool: "groq:free-tier", tier: "strong" }),
    ]);
    const fetchFn = stubFetch();
    const prov = provider();
    // Frontier has ONLY a paid route: rotation demotes DOWN to the strong
    // free route rather than up a cost class.
    const result = await prov.generateText({ system: "s", prompt: "p" });
    expect(result.text).toBe("completed by llama");
    for (const call of fetchFn.mock.calls) {
      expect(String(call[0])).not.toContain("api.openai.example.invalid");
    }
  });

  it("a catalog with ONLY paid routes fails loudly with zero requests", async () => {
    writeCatalog([
      row("openai_api/gpt-4o", { pool: "openai_api:paid", cost_class: "paid-metered" }),
    ]);
    const fetchFn = stubFetch();
    const prov = provider();
    await expect(prov.generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      /paid-metered.*held back|budget gate/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an aborted run surfaces ProviderAbortError and cools nothing", async () => {
    writeCatalog([row("aaa/one", { pool: "pool-a" })]);
    stubFetch(() => {
      throw new Error("unreachable — fetch rejects via signal first");
    });
    const controller = new AbortController();
    controller.abort();
    const prov = provider({ signal: controller.signal });
    await expect(prov.generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      ProviderAbortError,
    );
    expect(new StateStore().read().cooldowns).toEqual({});
  });

  it("generateJson rotates to another pool when a model cannot produce the shape", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/two", { pool: "pool-b" }),
    ]);
    stubFetch((url) => {
      if (url.includes("aaa.example.invalid")) {
        return new Response(openaiBody("I'll research the architecture first…"), {
          status: 200,
        });
      }
      return new Response(openaiBody('{"ok": true}'), { status: 200 });
    });
    const prov = provider();
    const result = await prov.generateJson({
      system: "s",
      prompt: "p",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "OkShape",
    });
    expect(result).toEqual({ ok: true });
  });

  it("honours the shared per-app pin — the manual toggle", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    stubFetch();
    await new StateStore().setPin("bbb", "factory-deck");
    const prov = provider();
    for (let i = 0; i < 3; i++) await prov.generateText({ system: "s", prompt: "p" });
    const state = new StateStore().read();
    expect(state.pools["pool-b"].calls).toBe(3);
    expect(state.pools["pool-a"]).toBeUndefined();
  });
});

describe("filterRoutableCatalog — process-local credential filtering", () => {
  it("drops keyless routes locally without touching the shared state", () => {
    vi.stubEnv("TEST_HAVE_KEY", "yes");
    writeCatalog([
      row("aaa/one", { pool: "pool-a", auth_env: "NO_SUCH_KEY_EVER_SET" }),
      row("bbb/one", { pool: "pool-b", auth_env: "TEST_HAVE_KEY" }),
      row("ollama/qwen", { pool: "local:ollama", cost_class: "local-unlimited" }),
    ]);
    const warnings: string[] = [];
    const filtered = filterRoutableCatalog(
      buildRotator("factory-deck")!,
      FCC_URL,
      (_k, m) => warnings.push(m),
    );
    expect(filtered!.catalog.routes.map((r) => r.id).sort()).toEqual([
      "bbb/one",
      "ollama/qwen",
    ]);
    expect(warnings.join("\n")).toMatch(/NO_SUCH_KEY_EVER_SET/);
    // Nothing about the dropped pool reaches the SHARED state file — other
    // consumers may hold the key.
    expect(new StateStore().read().cooldowns).toEqual({});
  });

  it("keeps FCC-proxied routes even though the delegate owns their auth", () => {
    writeCatalog([
      row("anthropic_sub/claude-fable-5", {
        pool: "anthropic:max-plan",
        api: "anthropic",
        base_url: FCC_URL,
        cost_class: "subscription",
        auth_kind: "anthropic-token",
        auth_env: "FCC_TOKEN_NOT_IN_ENV",
      }),
    ]);
    const filtered = filterRoutableCatalog(buildRotator("factory-deck")!, FCC_URL);
    expect(filtered!.catalog.routes).toHaveLength(1);
  });

  it("hydrates MISSING credentials from the FCC env file, never overwriting live env", () => {
    // This machine keeps the free-cloud keys in ~/.fcc/.env, not in the
    // process env of a launcher-started deck. A 2026-08-23 live run dropped
    // 513 routes as "credential env not set" for exactly that reason.
    const fccHome = fs.mkdtempSync(path.join(os.tmpdir(), "fcc-home-"));
    fs.writeFileSync(
      path.join(fccHome, ".env"),
      [
        "# provisioned for the proxy",
        "TEST_FCC_ONLY_KEY=\"from-fcc-file\"",
        "TEST_ALREADY_SET_KEY=should-not-win",
        "TEST_BLANK_IN_FILE=",
        "",
      ].join("\n"),
    );
    vi.stubEnv("FCC_HOME", fccHome);
    vi.stubEnv("TEST_ALREADY_SET_KEY", "live-env-wins");
    vi.stubEnv("TEST_FCC_ONLY_KEY", "");
    vi.stubEnv("TEST_BLANK_IN_FILE", "");
    writeCatalog([
      row("aaa/one", { pool: "pool-a", auth_env: "TEST_FCC_ONLY_KEY" }),
      row("bbb/one", { pool: "pool-b", auth_env: "TEST_ALREADY_SET_KEY" }),
      row("ccc/one", { pool: "pool-c", auth_env: "TEST_BLANK_IN_FILE" }),
    ]);
    const lines: string[] = [];
    const filtered = filterRoutableCatalog(
      buildRotator("factory-deck")!,
      FCC_URL,
      (_k, m) => lines.push(m),
    );
    expect(filtered!.catalog.routes.map((r) => r.id).sort()).toEqual([
      "aaa/one",
      "bbb/one",
    ]);
    expect(process.env.TEST_FCC_ONLY_KEY).toBe("from-fcc-file");
    expect(process.env.TEST_ALREADY_SET_KEY).toBe("live-env-wins");
    // Names are announced; the VALUE never reaches a log line.
    const joined = lines.join("\n");
    expect(joined).toMatch(/credentials loaded from .*TEST_FCC_ONLY_KEY/);
    expect(joined).not.toMatch(/from-fcc-file/);
    // A key blank in the file is still reported as missing, loudly.
    expect(joined).toMatch(/TEST_BLANK_IN_FILE/);
    fs.rmSync(fccHome, { recursive: true, force: true });
  });

  it("returns null loudly when nothing callable remains", () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a", auth_env: "NO_SUCH_KEY_EVER_SET" }),
    ]);
    const warnings: string[] = [];
    const filtered = filterRoutableCatalog(
      buildRotator("factory-deck")!,
      FCC_URL,
      (_k, m) => warnings.push(m),
    );
    expect(filtered).toBeNull();
    expect(warnings.join("\n")).toMatch(/no callable route remains/);
  });
});

describe("FailoverProvider × rotation", () => {
  it("a PinUnavailable pin failure is fatal — never paid-rescued", async () => {
    writeCatalog([
      row("aaa/one", { pool: "pool-a" }),
      row("bbb/one", { pool: "pool-b" }),
    ]);
    stubFetch();
    // Pin the operator's target, then cool it: the pin cannot serve.
    await new StateStore().setPin("aaa/one", "factory-deck");
    await new StateStore().update((s) => {
      s.cooldowns["pool-a"] = Date.now() / 1000 + 10_000;
    });
    const paidCalled = vi.fn();
    const paid = {
      name: "anthropic" as const,
      isConfigured: () => true,
      generateText: async () => {
        paidCalled();
        return { text: "paid", provider: "anthropic" as const };
      },
      generateJson: async <T>(): Promise<T> => {
        paidCalled();
        return {} as T;
      },
    };
    const chain = new FailoverProvider(
      provider(),
      paid,
      { ...paid, name: "openai" as const },
      {
        holdMs: 1000,
        attempts: 2,
        retrySpacingMs: 10,
        maxBackpressureRetries: 1,
        baseUrl: FCC_URL,
        autoRestart: false,
      },
    );
    await expect(chain.generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      PinUnavailable,
    );
    expect(paidCalled).not.toHaveBeenCalled();
  });
});

describe("outcome classification", () => {
  const boom = (message: string, status?: number) => {
    const err = new Error(message) as Error & { status?: number };
    err.status = status;
    return err;
  };

  it("429 is rate_limited", () => {
    expect(classifyOutcome(boom("slow down", 429))).toBe("rate_limited");
  });

  it("credit language is quota exhaustion", () => {
    for (const m of ["insufficient credits", "quota exceeded", "billing hard limit"]) {
      expect(classifyOutcome(boom(m))).toBe("quota_exhausted");
    }
  });

  it("anything else is a plain error", () => {
    expect(classifyOutcome(boom("segfault in the tokeniser"))).toBe("error");
  });

  it("programming errors and bad requests never rotate across pools", () => {
    expect(isRetryableAcrossPools(new TypeError("bad kwarg"))).toBe(false);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableAcrossPools(boom("nope", status))).toBe(false);
    }
    expect(isRetryableAcrossPools(new ProviderAbortError())).toBe(false);
  });

  it("transport-ish failures do rotate", () => {
    expect(isRetryableAcrossPools(boom("overloaded", 503))).toBe(true);
    expect(isRetryableAcrossPools(boom("connection reset"))).toBe(true);
  });
});

describe("a reasoning-only reply is a budget problem, not an empty completion", () => {
  // Measured 2026-08-22 against meta/muse-glimmer-30b on NVIDIA NIM: content
  // null, reasoning_content populated, finish_reason "length". Reporting that
  // as "returned an empty completion" points the reader at a dead route when
  // the real fix is a bigger maxTokens.
  it("names the reasoning budget in the error and still rotates onward", async () => {
    writeCatalog([
      row("nim/reasoner", { pool: "pool-nim" }),
      row("other/plain", { pool: "pool-other" }),
    ]);
    const fetchMock = stubFetch((url) => {
      if (url.includes("nim.example.invalid")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_content: "We need to answer in one sentence. Probably…",
                },
                finish_reason: "length",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return undefined;
    });
    const prov = provider();
    // Two calls: whichever pool goes first, the run must still end with a real
    // answer from the plain route, and the NIM route's failure must be named.
    const texts = [
      (await prov.generateText({ system: "s", prompt: "p" })).text,
      (await prov.generateText({ system: "s", prompt: "p" })).text,
    ];
    expect(texts).toContain("completed by plain");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("a genuinely empty completion is still reported as one", async () => {
    writeCatalog([row("nim/empty", { pool: "pool-nim" })]);
    stubFetch(() =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const prov = provider();
    await expect(prov.generateText({ system: "s", prompt: "p" })).rejects.toThrow(
      /empty completion/,
    );
  });
});
