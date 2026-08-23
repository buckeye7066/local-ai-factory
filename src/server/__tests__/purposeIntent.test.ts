/**
 * Purpose sight: the rotator fits the route to what the call is FOR.
 * Twin of flexfactor_intent_tests.py — same cases, same expectations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Catalog,
  Rotator,
  RotationError,
  StateStore,
  modelFamily,
  type CatalogRoute,
} from "../rotation/aitimeRotation.js";
import { RotatingProvider } from "../rotation/rotatingProvider.js";
import { ThemedProvider, purposeNeedsVision } from "../orchestrator/workTheme.js";
import type { GenerateJsonInput, GenerateTextInput, LLMProvider } from "../../shared/types.js";

let dir: string;

function route(
  id: string,
  pool: string,
  caps: string[] = [],
  source: "measured" | "declared" | "" = "measured",
): CatalogRoute {
  const model = id.split("/").slice(1).join("/");
  return {
    id, backend: id.split("/")[0], backend_label: "", model, wire_model: model,
    api: "openai", base_url: `https://${id.split("/")[0]}.example.invalid/v1`, pool,
    auth_env: "", auth_kind: "none", cost_class: "free-tier", tier: "strong",
    enabled: true, disabled_reason: "", quota_status: "unknown", resets_at: null, note: "",
    capabilities: caps, capabilities_source: caps.length ? source : "",
  };
}

function rotator(routes: CatalogRoute[]): Rotator {
  return new Rotator(new Catalog(routes), new StateStore(), "test");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-intent-"));
  vi.stubEnv("AITIME_STATE_DIR", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fit before pools", () => {
  it("a route lacking a hard need is not a candidate", async () => {
    const r = rotator([
      route("a/vision-only", "pool-a", ["vision"]),
      route("b/coder", "pool-b", ["code_author", "structured_json"]),
    ]);
    for (let i = 0; i < 4; i++) {
      const s = await r.nextRoute({ tier: "strong", intent: { role: "author", needs: ["code_author"] } });
      expect(s.route.id).toBe("b/coder");
    }
  });

  it("unknown capabilities are not a failure", async () => {
    const r = rotator([route("a/mystery", "pool-a")]);
    const s = await r.nextRoute({ tier: "strong", intent: { role: "author", needs: ["code_author"] } });
    expect(s.route.id).toBe("a/mystery");
    expect(s.fit).toBe("unknown");
  });

  it("known fit ranks ahead of unknown inside a pool", async () => {
    const r = rotator([route("a/mystery", "pool-a"), route("a/measured", "pool-a", ["code_author"])]);
    const s = await r.nextRoute({ tier: "strong", intent: { role: "author", needs: ["code_author"] } });
    expect(s.route.id).toBe("a/measured");
    expect(s.fit).toBe("measured");
  });

  it("no intent changes nothing", async () => {
    const r = rotator([route("a/x", "pool-a", ["vision"]), route("b/y", "pool-b")]);
    const s = await r.nextRoute({ tier: "strong" });
    expect(s.intentRole ?? "").toBe("");
    expect(s.fit ?? "").toBe("");
  });

  it("when nothing fits, the reason names the need", async () => {
    const r = rotator([route("a/vision-only", "pool-a", ["vision"])]);
    await expect(
      r.nextRoute({ tier: "strong", intent: { role: "author", needs: ["code_author"] } }),
    ).rejects.toThrow(RotationError);
    try {
      await r.nextRoute({ tier: "strong", intent: { role: "author", needs: ["code_author"] } });
    } catch (e) {
      expect(JSON.stringify((e as RotationError).reasons)).toContain("lacks code_author for role author");
    }
  });
});

describe("family independence", () => {
  it("a reviewer avoids the author's family when it can", async () => {
    const r = rotator([route("a/qwen3-coder:30b", "pool-a"), route("b/gemma4:e4b", "pool-b")]);
    for (let i = 0; i < 4; i++) {
      const s = await r.nextRoute({ tier: "strong", intent: { role: "reviewer", avoidFamily: "qwen" } });
      expect(modelFamily(s.route.model)).toBe("gemma");
      expect(s.familyNote ?? "").toBe("");
    }
  });

  it("when only the author's family exists it still runs and says so", async () => {
    const r = rotator([route("a/qwen3-coder:30b", "pool-a"), route("b/qwen2.5-coder:7b", "pool-b")]);
    const s = await r.nextRoute({ tier: "strong", intent: { role: "reviewer", avoidFamily: "qwen" } });
    expect(s.familyNote).toContain("independence NOT achieved");
  });

  it("modelFamily sees through route prefixes", () => {
    expect(modelFamily("openrouter/qwen/qwen3.6-27b")).toBe("qwen");
    expect(modelFamily("ollama/gemma4:26b")).toBe("gemma");
    expect(modelFamily("nvidia_nim/openai/gpt-oss-20b")).toBe("gpt-oss");
    expect(modelFamily("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(modelFamily("ollama/muse-glimmer:30b")).toBe("muse");
  });
});

describe("the provider wrapper carries purpose", () => {
  function openaiBody(content: string): string {
    return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
  }
  function stub(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return new Response(openaiBody(`by ${body.model ?? "?"}`), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  it("purpose and role ride on every selection; a purpose need reshapes selection", async () => {
    stub();
    const r = rotator([
      route("a/text-coder", "pool-a", ["code_author"]),
      route("b/vision-coder", "pool-b", ["code_author", "vision"]),
    ]);
    const seen: string[] = [];
    const prov = new RotatingProvider(r, {
      fccDelegate: null, fccBaseUrl: "http://127.0.0.1:8082", tier: "strong",
      onRoute: (s) => seen.push(`${s.route.id}|${s.intentRole}|${s.purpose}`),
    });
    prov.setPurpose("ui-app: checkout screenshots", ["vision"]);
    // Authors are NOT narrowed by a visual purpose (live IPlay run 2026-08-23).
    const authors = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await prov.generateText({ system: "s", prompt: "p", intent: { role: "author", needs: ["code_author"] } });
      authors.add(seen.at(-1)!.split("|")[0]);
      expect(seen.at(-1)!.endsWith("|author|ui-app: checkout screenshots")).toBe(true);
    }
    expect(authors).toEqual(new Set(["a/text-coder", "b/vision-coder"]));
    // The vision role is.
    for (let i = 0; i < 3; i++) {
      await prov.generateText({ system: "s", prompt: "p", intent: { role: "vision" } });
      expect(seen.at(-1)!.split("|")[0]).toBe("b/vision-coder");
    }
    vi.unstubAllGlobals();
  });

  it("a reviewer automatically avoids the last author's family", async () => {
    stub();
    const r = rotator([route("a/qwen3-coder:30b", "pool-a"), route("b/gemma4:e4b", "pool-b")]);
    const seen: string[] = [];
    const prov = new RotatingProvider(r, {
      fccDelegate: null, fccBaseUrl: "http://127.0.0.1:8082", tier: "strong",
      onRoute: (s) => seen.push(s.route.model),
    });
    await prov.generateText({ system: "s", prompt: "p", intent: { role: "author" } });
    const authorFam = modelFamily(seen.at(-1)!);
    for (let i = 0; i < 3; i++) {
      await prov.generateText({ system: "s", prompt: "p", intent: { role: "reviewer" } });
      expect(modelFamily(seen.at(-1)!)).not.toBe(authorFam);
    }
    vi.unstubAllGlobals();
  });
});

describe("the work theme supplies purpose to the rotator", () => {
  it("stamps the theme as the call's purpose and adds vision for a visual purpose", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const inner: LLMProvider = {
      name: "free",
      isConfigured: () => true,
      resetTransport: () => {},
      generateText: async (input: GenerateTextInput) => { captured.push(input as unknown as Record<string, unknown>); return { text: "", provider: "free" }; },
      generateJson: async (input: GenerateJsonInput<unknown>) => { captured.push(input as unknown as Record<string, unknown>); return {} as never; },
    } as unknown as LLMProvider;
    const themed = new ThemedProvider(inner, {
      theme: "Checkout UI: fix the screenshot-based visual regression",
      issue: "cart total renders off-screen",
      constraints: [],
    });
    await themed.generateText({ system: "s", prompt: "p", intent: { role: "author", needs: ["code_author"] } });
    const author = captured[0].intent as { role: string; needs: string[]; purpose: string };
    expect(author.role).toBe("author");
    expect(author.purpose).toContain("Checkout UI");
    expect(author.needs).toEqual(["code_author"]);            // not narrowed
    await themed.generateText({ system: "s", prompt: "p", intent: { role: "vision" } });
    const vision = captured[1].intent as { role: string; needs: string[] };
    expect(vision.needs).toEqual(expect.arrayContaining(["vision"]));
  });

  it("purposeNeedsVision is narrow", () => {
    expect(purposeNeedsVision("preserve exact scripture text")).toBe(false);
    expect(purposeNeedsVision("review screenshots of the dashboard")).toBe(true);
  });
});
