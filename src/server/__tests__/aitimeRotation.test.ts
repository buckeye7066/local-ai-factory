/**
 * aitimeRotation.test.ts — the TypeScript half of the shared rotation
 * contract's equivalence suite (docs/rotation-contract.md §7, mirrored from
 * flexfactor_rotation_tests.py). Covers pool-first ordering, pin-strict
 * failure, cost-class containment, auto-demote recording, cooldown expiry,
 * and concurrent state writes — including REAL cross-process fairness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
import {
  Catalog,
  PinUnavailable,
  Rotator,
  StateStore,
  buildRotator,
  loadCatalog,
  rotationEnabled,
  unavailableReason,
  type CatalogRoute,
} from "../rotation/aitimeRotation.js";

let dir: string;

function routes(): Array<Partial<CatalogRoute> & { id: string }> {
  return [
    // Two frontier models on ONE OpenAI ledger — they must not fake headroom.
    {
      id: "openai_api/gpt-4o",
      backend: "openai_api",
      model: "gpt-4o",
      pool: "openai_api:paid",
      cost_class: "paid-metered",
      tier: "frontier",
    },
    {
      id: "openai_api/gpt-4o-2024-08-06",
      backend: "openai_api",
      model: "gpt-4o-2024-08-06",
      pool: "openai_api:paid",
      cost_class: "paid-metered",
      tier: "frontier",
    },
    // Three distinct $0 frontier pools.
    {
      id: "openrouter/x-ai/grok-4.6",
      backend: "openrouter",
      model: "x-ai/grok-4.6",
      pool: "openrouter:credits",
      cost_class: "free-tier",
      tier: "frontier",
    },
    {
      id: "groq/llama-4-maverick",
      backend: "groq",
      model: "llama-4-maverick",
      pool: "groq:free-tier",
      cost_class: "free-tier",
      tier: "frontier",
    },
    {
      id: "groq/llama-4-scout",
      backend: "groq",
      model: "llama-4-scout",
      pool: "groq:free-tier",
      cost_class: "free-tier",
      tier: "frontier",
    },
    {
      id: "anthropic_sub/claude-fable-5",
      backend: "anthropic_sub",
      model: "claude-fable-5",
      pool: "anthropic:max-plan",
      cost_class: "subscription",
      tier: "frontier",
    },
    // Strong + light tiers.
    {
      id: "ollama/qwen3-coder:30b",
      backend: "ollama",
      model: "qwen3-coder:30b",
      pool: "local:ollama",
      cost_class: "local-unlimited",
      tier: "strong",
    },
    {
      id: "gemini/gemini-2.5-flash",
      backend: "gemini",
      model: "gemini-2.5-flash",
      pool: "gemini:free-tier",
      cost_class: "free-tier",
      tier: "light",
    },
  ];
}

function writeCatalog(
  rows: Array<Record<string, unknown>> = routes(),
  extra: Record<string, unknown> = {},
): void {
  fs.writeFileSync(
    path.join(dir, "routes.json"),
    JSON.stringify({
      schema: 1,
      generated_at: new Date().toISOString(),
      routes: rows,
      ...extra,
    }),
  );
}

function rotator(): Rotator {
  const r = buildRotator("factory-deck");
  if (!r) throw new Error(`buildRotator returned null: ${unavailableReason()}`);
  return r;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotation-test-"));
  vi.stubEnv("AITIME_STATE_DIR", dir);
  vi.stubEnv("AI_ROTATE", "on");
  vi.stubEnv("AI_ROTATE_PIN", "");
  writeCatalog();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("pool-first rotation", () => {
  it("consecutive picks walk different pools", async () => {
    const rot = rotator();
    const first = await rot.nextRoute({ now: 100 });
    const second = await rot.nextRoute({ now: 101 });
    const third = await rot.nextRoute({ now: 102 });
    expect(second.pool).not.toBe(first.pool);
    expect(third.pool).not.toBe(second.pool);
    // 3 distinct $0 frontier pools: three picks cover all three.
    expect(new Set([first.pool, second.pool, third.pool]).size).toBe(3);
  });

  it("many models on one ledger do not fake headroom", async () => {
    // Only the groq pool (2 models) plus openrouter (1 model): four calls must
    // split 2/2 across the POOLS, not 3/1 by model count.
    writeCatalog(
      routes().filter(
        (r) => r.pool === "groq:free-tier" || r.pool === "openrouter:credits",
      ),
    );
    const rot = rotator();
    const picks: string[] = [];
    for (let i = 0; i < 4; i++)
      picks.push((await rot.nextRoute({ now: 100 + i })).pool);
    const groq = picks.filter((p) => p === "groq:free-tier").length;
    const openrouter = picks.filter((p) => p === "openrouter:credits").length;
    expect(groq).toBe(2);
    expect(openrouter).toBe(2);
  });

  it("the least recently used pool wins — no cursor double-rotate", async () => {
    const rot = rotator();
    const a = await rot.nextRoute({ now: 100 });
    const b = await rot.nextRoute({ now: 101 });
    const c = await rot.nextRoute({ now: 102 });
    // Fourth pick: the oldest stamp is pool `a` again. A double-rotating
    // cursor lands somewhere else — this is the trap test.
    const d = await rot.nextRoute({ now: 103 });
    expect(d.pool).toBe(a.pool);
    expect([b.pool, c.pool]).not.toContain(d.pool);
  });

  it("within a pool the least recently used model wins", async () => {
    writeCatalog(routes().filter((r) => r.pool === "groq:free-tier"));
    const rot = rotator();
    const first = await rot.nextRoute({ now: 100 });
    const second = await rot.nextRoute({ now: 101 });
    expect(second.pool).toBe(first.pool);
    expect(second.route.id).not.toBe(first.route.id);
  });
});

describe("cost containment — free must never silently become paid", () => {
  it("paid routes are invisible by default", async () => {
    const rot = rotator();
    for (let i = 0; i < 8; i++) {
      const sel = await rot.nextRoute({ now: 100 + i });
      expect(sel.route.cost_class).not.toBe("paid-metered");
    }
  });

  it("a free-only tier that runs dry demotes DOWN, never up a cost class", async () => {
    // Cool every $0 frontier pool; paid frontier remains. The pick must be the
    // strong-tier local route, not the paid frontier one.
    const rot = rotator();
    for (const pool of ["openrouter:credits", "groq:free-tier", "anthropic:max-plan"]) {
      await rot.store.update((s) => {
        s.cooldowns[pool] = 10_000;
      });
    }
    const sel = await rot.nextRoute({ now: 100 });
    expect(sel.route.cost_class).not.toBe("paid-metered");
    expect(sel.tier).toBe("strong");
    expect(sel.demotedFrom).toBe("frontier");
  });

  it("when only paid routes remain the error names them and no route is returned", async () => {
    writeCatalog(routes().filter((r) => r.cost_class === "paid-metered"));
    const rot = rotator();
    await expect(rot.nextRoute({ now: 100 })).rejects.toThrow(
      /paid-metered.*held back|budget gate/,
    );
  });

  it("allowPaid opens the gate explicitly, and no ledger is starved", async () => {
    const rot = rotator();
    const classes: string[] = [];
    for (let i = 0; i < 8; i++) {
      classes.push(
        (await rot.nextRoute({ allowPaid: true, now: 100 + i })).route.cost_class,
      );
    }
    // 3 free pools + 1 paid pool at frontier: LRU gives each ledger 2 of 8.
    expect(classes.filter((c) => c === "paid-metered")).toHaveLength(2);
  });
});

describe("demotion", () => {
  it("an empty frontier falls to strong and says so", async () => {
    writeCatalog(routes().filter((r) => r.tier !== "frontier"));
    const rot = rotator();
    const sel = await rot.nextRoute({ now: 100 });
    expect(sel.tier).toBe("strong");
    expect(sel.demotedFrom).toBe("frontier");
    expect(sel.requestedTier).toBe("frontier");
  });

  it("demotion walks all the way down to light", async () => {
    writeCatalog(routes().filter((r) => r.tier === "light"));
    const rot = rotator();
    const sel = await rot.nextRoute({ now: 100 });
    expect(sel.tier).toBe("light");
    expect(sel.demotedFrom).toBe("frontier");
  });

  it("an available frontier route is not demoted", async () => {
    const rot = rotator();
    const sel = await rot.nextRoute({ now: 100 });
    expect(sel.tier).toBe("frontier");
    expect(sel.demotedFrom).toBeNull();
  });
});

describe("pins — the manual toggle", () => {
  it("a pin overrides rotation entirely", async () => {
    const rot = rotator();
    for (let i = 0; i < 3; i++) {
      const sel = await rot.nextRoute({
        pin: "openrouter/x-ai/grok-4.6",
        now: 100 + i,
      });
      expect(sel.route.id).toBe("openrouter/x-ai/grok-4.6");
      expect(sel.pinned).toBe(true);
    }
  });

  it("a pin may name a backend, a pool, or a bare model id", async () => {
    const rot = rotator();
    expect((await rot.nextRoute({ pin: "groq", now: 100 })).pool).toBe(
      "groq:free-tier",
    );
    expect(
      (await rot.nextRoute({ pin: "openrouter:credits", now: 101 })).route.backend,
    ).toBe("openrouter");
    expect((await rot.nextRoute({ pin: "x-ai/grok-4.6", now: 102 })).route.model).toBe(
      "x-ai/grok-4.6",
    );
  });

  it("an unavailable pin fails loudly instead of substituting", async () => {
    const rot = rotator();
    await rot.store.update((s) => {
      s.cooldowns["openrouter:credits"] = 10_000;
    });
    await expect(
      rot.nextRoute({ pin: "openrouter/x-ai/grok-4.6", now: 100 }),
    ).rejects.toThrow(PinUnavailable);
  });

  it("a pin naming nothing says so rather than rotating", async () => {
    const rot = rotator();
    await expect(rot.nextRoute({ pin: "no-such-thing", now: 100 })).rejects.toThrow(
      /matches no route/,
    );
  });

  it("the env pin is honoured", async () => {
    vi.stubEnv("AI_ROTATE_PIN", "groq");
    const rot = rotator();
    expect((await rot.nextRoute({ now: 100 })).pool).toBe("groq:free-tier");
  });

  it("a persisted per-app pin beats the global one", async () => {
    const rot = rotator();
    await rot.store.setPin("groq", "global");
    await rot.store.setPin("openrouter/x-ai/grok-4.6", "factory-deck");
    expect((await rot.nextRoute({ now: 100 })).route.id).toBe(
      "openrouter/x-ai/grok-4.6",
    );
  });

  it("clearing a pin restores rotation", async () => {
    const rot = rotator();
    await rot.store.setPin("groq", "factory-deck");
    expect((await rot.nextRoute({ now: 100 })).pool).toBe("groq:free-tier");
    await rot.store.setPin(null, "factory-deck");
    const pools = new Set<string>();
    for (let i = 0; i < 3; i++) pools.add((await rot.nextRoute({ now: 101 + i })).pool);
    expect(pools.size).toBe(3);
  });

  it("a non-strict pin falls through when asked", async () => {
    const rot = rotator();
    await rot.store.update((s) => {
      s.cooldowns["openrouter:credits"] = 10_000;
    });
    const sel = await rot.nextRoute({
      pin: "openrouter/x-ai/grok-4.6",
      pinStrict: false,
      now: 100,
    });
    expect(sel.route.id).not.toBe("openrouter/x-ai/grok-4.6");
    expect(sel.pinned).toBe(false);
  });
});

describe("cooldowns and strikes", () => {
  const grok = (): CatalogRoute => {
    const cat = loadCatalog();
    return cat!.routes.find((r) => r.id === "openrouter/x-ai/grok-4.6")!;
  };

  it("a rate limit cools the whole pool, not just the model", async () => {
    const rot = rotator();
    await rot.report(grok(), "rate_limited", undefined, 100);
    const state = rot.store.read();
    expect(state.cooldowns["openrouter:credits"]).toBe(160);
  });

  it("a cooldown expires", async () => {
    const rot = rotator();
    await rot.report(grok(), "rate_limited", 60, 100);
    const during: string[] = [];
    for (let i = 0; i < 3; i++)
      during.push((await rot.nextRoute({ now: 110 + i })).pool);
    expect(during).not.toContain("openrouter:credits");
    // After expiry the pool is the least recently used and wins again.
    expect((await rot.nextRoute({ now: 200 })).pool).toBe("openrouter:credits");
  });

  it("one bad model does not take its provider out of rotation", async () => {
    const rot = rotator();
    await rot.report(grok(), "error", undefined, 100);
    const state = rot.store.read();
    expect(state.cooldowns["route:openrouter/x-ai/grok-4.6"]).toBe(130);
    expect(state.cooldowns["openrouter:credits"]).toBeUndefined();
  });

  it("three strikes cools the pool", async () => {
    const rot = rotator();
    await rot.report(grok(), "error", undefined, 100);
    await rot.report(grok(), "error", undefined, 140);
    await rot.report(grok(), "error", undefined, 180);
    const state = rot.store.read();
    expect(state.cooldowns["openrouter:credits"]).toBe(480);
    expect(state.strikes["openrouter/x-ai/grok-4.6"]).toBeUndefined();
  });

  it("success clears strikes", async () => {
    const rot = rotator();
    await rot.report(grok(), "error", undefined, 100);
    await rot.report(grok(), "ok", undefined, 150);
    const state = rot.store.read();
    expect(state.strikes["openrouter/x-ai/grok-4.6"]).toBeUndefined();
    expect(state.cooldowns["route:openrouter/x-ai/grok-4.6"]).toBeUndefined();
  });

  it("quota exhaustion cools until the reset the route reported", async () => {
    const resetsAt = new Date((1_000_000 + 500) * 1000).toISOString();
    writeCatalog(
      routes().map((r) =>
        r.id === "openrouter/x-ai/grok-4.6" ? { ...r, resets_at: resetsAt } : r,
      ),
    );
    const rot = rotator();
    const route = rot.catalog.routes.find((r) => r.id === "openrouter/x-ai/grok-4.6")!;
    await rot.report(route, "quota_exhausted", undefined, 1_000_000);
    const state = rot.store.read();
    expect(state.cooldowns["openrouter:credits"]).toBeCloseTo(1_000_500, 0);
  });

  it("quota exhaustion without a reset uses the default hour", async () => {
    const rot = rotator();
    await rot.report(grok(), "quota_exhausted", undefined, 100);
    expect(rot.store.read().cooldowns["openrouter:credits"]).toBe(3700);
  });

  it("selection counts the call against its pool", async () => {
    const rot = rotator();
    const sel = await rot.nextRoute({ now: 100 });
    const state = rot.store.read();
    expect(state.pools[sel.pool].calls).toBe(1);
    expect(state.pools[sel.pool].last_used_at).toBe(100);
    expect(state.cursor["frontier"]).toBe(1);
  });

  it("a clean success needs no second write", async () => {
    const rot = rotator();
    const sel = await rot.nextRoute({ now: 100 });
    const stateFile = path.join(dir, "rotation-state.json");
    const before = fs.readFileSync(stateFile, "utf8");
    await rot.report(sel.route, "ok", undefined, 101);
    expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
  });

  it("a success after an error does write to clear the strike", async () => {
    const rot = rotator();
    await rot.report(grok(), "error", undefined, 100);
    const stateFile = path.join(dir, "rotation-state.json");
    const before = fs.readFileSync(stateFile, "utf8");
    await rot.report(grok(), "ok", undefined, 150);
    expect(fs.readFileSync(stateFile, "utf8")).not.toBe(before);
  });
});

describe("catalog handling", () => {
  it("a missing catalog yields no rotator, with a reason", () => {
    fs.rmSync(path.join(dir, "routes.json"));
    expect(buildRotator("factory-deck")).toBeNull();
    expect(unavailableReason()).toMatch(/no route catalog/);
  });

  it("the wrong schema is rejected rather than guessed at", () => {
    fs.writeFileSync(
      path.join(dir, "routes.json"),
      JSON.stringify({ schema: 2, routes: [] }),
    );
    expect(loadCatalog()).toBeNull();
    expect(unavailableReason()).toMatch(/unreadable or has the wrong schema/);
  });

  it("a corrupt catalog is not fatal", () => {
    fs.writeFileSync(path.join(dir, "routes.json"), "{nope");
    expect(loadCatalog()).toBeNull();
    expect(buildRotator("factory-deck")).toBeNull();
  });

  it("one malformed row does not void the catalog", () => {
    writeCatalog([
      { id: "good/route", pool: "p", cost_class: "free-tier", tier: "light" },
      { pool: "no-id" } as never,
    ]);
    const cat = loadCatalog();
    expect(cat!.routes).toHaveLength(1);
    expect(cat!.routes[0].id).toBe("good/route");
  });

  it("a route without a pool falls back to its backend", () => {
    writeCatalog([{ id: "x/y", backend: "x", cost_class: "free-tier", tier: "light" }]);
    expect(loadCatalog()!.routes[0].pool).toBe("x:pool");
  });

  it("a stale catalog still routes but flags itself", async () => {
    const file = path.join(dir, "routes.json");
    const old = Date.now() / 1000 - 4 * 3600;
    fs.utimesSync(file, old, old);
    const rot = rotator();
    expect(rot.catalog.isStale).toBe(true);
    const sel = await rot.nextRoute({ now: 100 });
    expect(sel.catalogStale).toBe(true);
  });

  it("all routes disabled yields no rotator", () => {
    writeCatalog(routes().map((r) => ({ ...r, enabled: false })));
    expect(buildRotator("factory-deck")).toBeNull();
    expect(unavailableReason()).toMatch(/none are enabled/);
  });

  it("AI_ROTATE=off disables the rotator and says why", () => {
    vi.stubEnv("AI_ROTATE", "off");
    expect(rotationEnabled()).toBe(false);
    expect(buildRotator("factory-deck")).toBeNull();
    expect(unavailableReason()).toBe("AI_ROTATE=off");
  });

  it("rotation is on by default", () => {
    vi.stubEnv("AI_ROTATE", "");
    expect(rotationEnabled()).toBe(true);
  });

  it("an empty catalog fails loudly with the fix", async () => {
    writeCatalog([]);
    const rot = new Rotator(new Catalog([]), new StateStore());
    await expect(rot.nextRoute({ now: 100 })).rejects.toThrow(
      /python -m aitime.catalog/,
    );
  });

  it("the no-route failure lists why pools were skipped", async () => {
    writeCatalog(
      routes().map((r) => ({ ...r, enabled: false, disabled_reason: "no key" })),
    );
    const rot = new Rotator(loadCatalog()!, new StateStore());
    await expect(rot.nextRoute({ now: 100 })).rejects.toThrow(/Pools skipped:.*no key/);
  });
});

describe("shared state", () => {
  it("state survives a new store instance", async () => {
    const rot = rotator();
    await rot.nextRoute({ now: 100 });
    const fresh = new StateStore();
    expect(Object.keys(fresh.read().pools).length).toBeGreaterThan(0);
  });

  it("a stale lock is broken rather than wedging rotation", async () => {
    const lock = path.join(dir, "rotation-state.json.lock");
    fs.writeFileSync(lock, "99999");
    const old = Date.now() / 1000 - 120;
    fs.utimesSync(lock, old, old);
    const rot = rotator();
    const sel = await rot.nextRoute({ now: 100 });
    expect(sel.route.enabled).toBe(true);
  });

  it("a fresh lock makes acquisition wait (and then proceed once released)", async () => {
    const lock = path.join(dir, "rotation-state.json.lock");
    fs.writeFileSync(lock, String(process.pid));
    const rot = rotator();
    const pending = rot.nextRoute({ now: 100 });
    // Release the lock shortly after; the waiter must then get through.
    setTimeout(() => fs.rmSync(lock, { force: true }), 150);
    const sel = await pending;
    expect(sel.route.enabled).toBe(true);
  });

  it("no leftover temp or lock files after a burst of writes", async () => {
    const rot = rotator();
    for (let i = 0; i < 5; i++) await rot.nextRoute({ now: 100 + i });
    const leftovers = fs
      .readdirSync(dir)
      .filter((f) => f.includes(".tmp.") || f.endsWith(".lock"));
    expect(leftovers).toEqual([]);
  });

  it("concurrent in-process pickers do not stampede one pool", async () => {
    const rot = rotator();
    const picks = await Promise.all(
      Array.from({ length: 6 }, () => rot.nextRoute({}).then((s) => s.pool)),
    );
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1);
    // 6 picks over 3 $0 frontier pools: fair is 2 each. Same-millisecond
    // stamps make ties legal, so mirror the Python suite's bound (fair +50%):
    // every pool used, none absorbs the burst.
    expect(counts.size).toBe(3);
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(3);
  });

  it("CROSS-PROCESS fairness: 4 workers × 6 picks split evenly across pools", async () => {
    // The real stampede scenario: independent OS processes sharing the state
    // file. Each worker does 6 selections; 24 picks over 3 pools land ~8 each
    // when read-select-stamp is one locked transaction, while an unlocked
    // read-select piles the burst onto one ledger. File integrity alone is
    // NOT the assertion — fairness is. Bound mirrors the Python suite:
    // fair +50% (Python: 4 pools, 40 picks, max ≤ 15).
    const worker = path.join(HERE, "helpers", "rotationWorker.ts");
    const run = (): Promise<string[]> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", worker], {
          cwd: path.resolve(HERE, "..", "..", ".."),
          env: {
            ...process.env,
            AITIME_STATE_DIR: dir,
            AI_ROTATE: "on",
            AI_ROTATE_PIN: "",
            ROTATION_WORKER_PICKS: "6",
          },
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => {
          if (code !== 0)
            reject(new Error(`worker exit ${code}: ${err.slice(0, 500)}`));
          else resolve(out.trim().split(/\r?\n/).filter(Boolean));
        });
      });

    const results = await Promise.all([run(), run(), run(), run()]);
    const pools = results.flat();
    expect(pools).toHaveLength(24);
    const counts = new Map<string, number>();
    for (const p of pools) counts.set(p, (counts.get(p) ?? 0) + 1);
    expect(counts.size).toBe(3);
    for (const [pool, n] of counts) {
      expect(n, `pool ${pool} got ${n}/24 picks`).toBeLessThanOrEqual(12);
    }
    // And the shared state survived intact.
    const state = new StateStore(path.join(dir, "rotation-state.json")).read();
    const totalCalls = Object.entries(state.pools)
      .filter(([k]) => !k.startsWith("route:"))
      .reduce((sum, [, v]) => sum + v.calls, 0);
    expect(totalCalls).toBe(24);
  }, 120_000);
});
