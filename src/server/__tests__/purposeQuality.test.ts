/**
 * Purpose effectiveness: the rotator learns from RESULTS, not just from
 * serving. Twin of flexfactor_quality_tests.py — same cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Catalog,
  QUALITY_COOLDOWN_S,
  QUALITY_MIN_ATTEMPTS,
  RotationError,
  Rotator,
  StateStore,
  yieldOf,
  type CatalogRoute,
} from "../rotation/aitimeRotation.js";
import { RotatingProvider, reportRouteQuality } from "../rotation/rotatingProvider.js";

let dir: string;

function route(id: string, pool: string): CatalogRoute {
  const model = id.split("/").slice(1).join("/");
  return {
    id,
    backend: id.split("/")[0],
    backend_label: "",
    model,
    wire_model: model,
    api: "openai",
    base_url: `https://${id.split("/")[0]}.example.invalid/v1`,
    pool,
    auth_env: "",
    auth_kind: "none",
    cost_class: "free-tier",
    tier: "strong",
    enabled: true,
    disabled_reason: "",
    quota_status: "unknown",
    resets_at: null,
    note: "",
    capabilities: ["code_author"],
    capabilities_source: "measured",
  };
}

function rot(routes: CatalogRoute[]): Rotator {
  return new Rotator(new Catalog(routes), new StateStore(), "test");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-quality-"));
  vi.stubEnv("AITIME_STATE_DIR", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("yield inside the pool", () => {
  it("verified work wins the pool over LRU", async () => {
    const good = route("a/good", "pool-a");
    const bad = route("a/bad", "pool-a");
    const r = rot([good, bad]);
    for (let i = 0; i < 3; i++) {
      await r.reportQuality(good, "verified", "prog");
      await r.reportQuality(bad, "rejected", "prog");
    }
    for (let i = 0; i < 4; i++) {
      const s = await r.nextRoute({
        tier: "strong",
        intent: { role: "author", purpose: "prog" },
      });
      expect(s.route.id).toBe("a/good");
    }
  });

  it("pool order is untouched by yield", async () => {
    const a = route("a/x", "pool-a");
    const b = route("b/y", "pool-b");
    const r = rot([a, b]);
    for (let i = 0; i < 4; i++) {
      await r.reportQuality(b, "verified", "prog");
      await r.reportQuality(a, "noop", "prog");
    }
    const first = (
      await r.nextRoute({
        tier: "strong",
        intent: { role: "author", purpose: "prog" },
        now: 100,
      })
    ).pool;
    const second = (
      await r.nextRoute({
        tier: "strong",
        intent: { role: "author", purpose: "prog" },
        now: 101,
      })
    ).pool;
    expect(new Set([first, second])).toEqual(new Set(["pool-a", "pool-b"]));
  });

  it("no history is neutral", () => {
    expect(yieldOf(undefined)).toBe(0.5);
    expect(yieldOf({ rejected: 1 })).toBeLessThan(0.5);
    expect(yieldOf({ verified: 1 })).toBeGreaterThan(0.5);
  });
});

describe("chronic offender cooldown", () => {
  it("low yield after enough attempts cools the route for that purpose", async () => {
    const bad = route("a/bad", "pool-a");
    const ok = route("b/ok", "pool-b");
    const r = rot([bad, ok]);
    let note: string | null = null;
    for (let i = 0; i < QUALITY_MIN_ATTEMPTS; i++)
      note = await r.reportQuality(bad, "rejected", "prog", 1000);
    expect(note).toContain("cooled down");
    for (let i = 0; i < 4; i++) {
      const s = await r.nextRoute({
        tier: "strong",
        intent: { role: "author", purpose: "prog" },
        now: 1001,
      });
      expect(s.route.id).toBe("b/ok");
    }
  });

  it("the cooldown is scoped to the purpose", async () => {
    const bad = route("a/bad", "pool-a");
    const r = rot([bad]);
    for (let i = 0; i < QUALITY_MIN_ATTEMPTS; i++)
      await r.reportQuality(bad, "rejected", "prog-one", 1000);
    expect(
      (
        await r.nextRoute({
          tier: "strong",
          intent: { role: "author", purpose: "prog-two" },
          now: 1001,
        })
      ).route.id,
    ).toBe("a/bad");
    expect((await r.nextRoute({ tier: "strong", now: 1002 })).route.id).toBe("a/bad");
  });

  it("the cooldown expires", async () => {
    const bad = route("a/bad", "pool-a");
    const r = rot([bad]);
    for (let i = 0; i < QUALITY_MIN_ATTEMPTS; i++)
      await r.reportQuality(bad, "rejected", "prog", 1000);
    await expect(
      r.nextRoute({
        tier: "strong",
        intent: { role: "author", purpose: "prog" },
        now: 1001,
      }),
    ).rejects.toThrow(RotationError);
    const later = 1000 + QUALITY_COOLDOWN_S + 1;
    expect(
      (
        await r.nextRoute({
          tier: "strong",
          intent: { role: "author", purpose: "prog" },
          now: later,
        })
      ).route.id,
    ).toBe("a/bad");
  });

  it("an unknown signal is recorded, not thrown", async () => {
    const x = route("a/x", "pool-a");
    const r = rot([x]);
    await r.reportQuality(x, "weird", "prog");
    expect(r.qualityFor(x, "prog").other).toBe(1);
  });
});

describe("the provider attributes results to the authoring route", () => {
  function stubFetch(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `by ${body.model}` } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  }

  it("reportQuality lands on the route that last served the role, via the module hook too", async () => {
    stubFetch();
    const a = route("a/one", "pool-a");
    const b = route("b/two", "pool-b");
    const r = rot([a, b]);
    const seen: CatalogRoute[] = [];
    const prov = new RotatingProvider(r, {
      fccDelegate: null,
      fccBaseUrl: "http://127.0.0.1:8082",
      tier: "strong",
      onRoute: (s) => seen.push(s.route),
    });
    prov.setPurpose("prog");
    await prov.generateText({ system: "s", prompt: "p", intent: { role: "author" } });
    const authored = seen.at(-1)!;
    await reportRouteQuality("author", "rejected");
    expect(r.qualityFor(authored, "prog").rejected).toBe(1);
    const other = authored.id === a.id ? b : a;
    expect(r.qualityFor(other, "prog")).toEqual({});
  });

  it("a report before any call is a no-op", async () => {
    const r = rot([route("a/one", "pool-a")]);
    const prov = new RotatingProvider(r, {
      fccDelegate: null,
      fccBaseUrl: "http://127.0.0.1:8082",
      tier: "strong",
    });
    expect(await prov.reportQuality("author", "verified")).toBeNull();
  });
});
