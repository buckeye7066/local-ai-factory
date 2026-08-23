/**
 * The local Muse Glimmer route is held out of rotation — and a pin overrides it.
 *
 * Two opposite failures are guarded here, and both were real risks:
 *
 *  1. UNDER-blocking. Rotation is cheapest-first and a local route is cost
 *     class 0, so an un-excluded `ollama/muse-glimmer` is selected FIRST on
 *     every sweep. It generates at ~1.6 tok/s on this machine (measured), so it
 *     would blow the per-call timeout and burn a cooldown — surfacing as a
 *     provider outage rather than as "that model is slow here".
 *
 *  2. OVER-blocking. The catalog also carries the SAME model served from NVIDIA
 *     NIM (free-tier) and OpenRouter (paid). Those are cloud routes at cloud
 *     speed; excluding them would quietly cost real free capacity for a reason
 *     that is a property of this CPU, not of the model.
 *
 * And the interaction that ties them together: a deliberate PIN must still
 * reach Glimmer. Without pin-awareness the filter drops the route and the
 * rotator then reports "pinned target matches no route in the catalog" — the
 * operator asks for it by name and is told it does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRotator, StateStore } from "../rotation/aitimeRotation.js";
import { filterRoutableCatalog } from "../rotation/rotatingProvider.js";

let dir: string;
const FCC_URL = "http://127.0.0.1:8082";

function row(id: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  const backend = id.split("/")[0];
  const model = (opts.model as string) ?? id.split("/").slice(1).join("/");
  return {
    id,
    backend,
    model,
    wire_model: model,
    api: opts.api ?? "openai",
    base_url: opts.base_url ?? `https://${backend}.example.invalid/v1`,
    pool: opts.pool ?? `${backend}:pool`,
    auth_env: "",
    auth_kind: "none",
    cost_class: opts.cost_class ?? "free-tier",
    tier: opts.tier ?? "frontier",
    enabled: true,
  };
}

/** The three Glimmer rows the real catalog carries, plus a normal local peer. */
function glimmerCatalog(): Array<Record<string, unknown>> {
  return [
    row("ollama/muse-glimmer:30b", {
      api: "ollama",
      base_url: "http://127.0.0.1:11434",
      pool: "local:ollama",
      cost_class: "local-unlimited",
      tier: "light",
    }),
    row("ollama/qwen3-coder:30b", {
      api: "ollama",
      base_url: "http://127.0.0.1:11434",
      pool: "local:ollama",
      cost_class: "local-unlimited",
      tier: "light",
    }),
    row("nvidia_nim/meta/muse-glimmer-30b", {
      pool: "nvidia_nim:free-tier",
      cost_class: "free-tier",
      tier: "strong",
    }),
    row("openrouter/meta/muse-glimmer-30b", {
      pool: "openrouter:credits",
      cost_class: "paid-metered",
      tier: "strong",
    }),
  ];
}

function writeCatalog(rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(dir, "routes.json"),
    JSON.stringify({
      schema: 1,
      generated_at: new Date().toISOString(),
      routes: rows,
    }),
  );
}

function keptIds(app = "factory-deck"): string[] {
  const rotator = buildRotator(app);
  if (!rotator) throw new Error("no rotator for test");
  const filtered = filterRoutableCatalog(rotator, FCC_URL, () => {});
  return (filtered?.catalog.routes ?? []).map((r) => r.id).sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glimmer-excl-"));
  vi.stubEnv("AITIME_STATE_DIR", dir);
  vi.stubEnv("AI_ROTATE", "");
  vi.stubEnv("AI_ROTATE_PIN", "");
  vi.stubEnv("FACTORY_ROTATION_EXCLUDE", "");
  // stubEnv("") leaves the var DEFINED-but-empty, which for the exclusion means
  // "exclude nothing". Delete it so the built-in default applies instead.
  delete process.env.FACTORY_ROTATION_EXCLUDE;
  delete process.env.AI_ROTATE_PIN;
  writeCatalog(glimmerCatalog());
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("local Glimmer is held out of rotation", () => {
  it("drops ollama/muse-glimmer but keeps every other route", () => {
    expect(keptIds()).toEqual([
      "nvidia_nim/meta/muse-glimmer-30b",
      "ollama/qwen3-coder:30b",
      "openrouter/meta/muse-glimmer-30b",
    ]);
  });

  it("keeps the free NVIDIA NIM Glimmer — the slowness is this CPU, not the model", () => {
    expect(keptIds()).toContain("nvidia_nim/meta/muse-glimmer-30b");
  });

  it("does not disturb the other local model", () => {
    expect(keptIds()).toContain("ollama/qwen3-coder:30b");
  });

  it("says out loud that it held a route back", () => {
    const messages: string[] = [];
    const rotator = buildRotator("factory-deck")!;
    filterRoutableCatalog(rotator, FCC_URL, (_k, m) => messages.push(m));
    const line = messages.find((m) => m.includes("held out of rotation"));
    expect(line, "a silently vanished route is indistinguishable from an absent one")
      .toBeTruthy();
    expect(line).toContain("muse-glimmer");
  });

  it("can be switched off entirely with FACTORY_ROTATION_EXCLUDE=''", () => {
    vi.stubEnv("FACTORY_ROTATION_EXCLUDE", "");
    expect(keptIds()).toContain("ollama/muse-glimmer:30b");
  });
});

describe("a deliberate pin outranks the exclusion", () => {
  it("admits the local route when this app pinned it", async () => {
    await new StateStore().setPin("muse-glimmer:30b", "factory-deck");
    expect(
      keptIds(),
      "pinning must reach Glimmer, or the rotator reports 'matches no route'",
    ).toContain("ollama/muse-glimmer:30b");
  });

  it("admits it for purpose-foundry when purpose-foundry pinned it", async () => {
    await new StateStore().setPin("muse-glimmer:30b", "purpose-foundry");
    expect(keptIds("purpose-foundry")).toContain("ollama/muse-glimmer:30b");
  });

  it("another app's pin does NOT unblock it here", async () => {
    await new StateStore().setPin("muse-glimmer:30b", "purpose-foundry");
    expect(keptIds("factory-deck")).not.toContain("ollama/muse-glimmer:30b");
  });

  it("honours AI_ROTATE_PIN from the environment", () => {
    vi.stubEnv("AI_ROTATE_PIN", "muse-glimmer:30b");
    expect(keptIds()).toContain("ollama/muse-glimmer:30b");
  });

  it("a pin naming something else leaves Glimmer excluded", async () => {
    await new StateStore().setPin("qwen3-coder:30b", "factory-deck");
    expect(keptIds()).not.toContain("ollama/muse-glimmer:30b");
  });
});

describe("the local gate is a measurement when local-bench.json exists", () => {
  function writeBench(models: Array<Record<string, unknown>>, floor = 5): void {
    fs.writeFileSync(
      path.join(dir, "local-bench.json"),
      JSON.stringify({ schema: 1, slow_tok_per_s: floor, models }),
    );
  }

  it("a slow measurement holds the route out", () => {
    writeBench([{ tag: "qwen3-coder:30b", ok: true, gen_tok_per_s: 1.6, answered: true }]);
    expect(keptIds()).not.toContain("ollama/qwen3-coder:30b");
  });

  it("a fast measurement admits even a name-listed route", () => {
    writeBench([{ tag: "muse-glimmer:30b", ok: true, gen_tok_per_s: 40, answered: true }]);
    expect(keptIds()).toContain("ollama/muse-glimmer:30b");
  });

  it("a reasoning-only speed prompt is NOT a no-answer; the battery decides that", () => {
    writeBench([
      { tag: "qwen3-coder:30b", ok: true, gen_tok_per_s: 30, answered: false, reasoning_only: true },
    ]);
    expect(keptIds()).toContain("ollama/qwen3-coder:30b");
  });

  it("a truly empty reply is held out regardless of rate", () => {
    writeBench([
      { tag: "qwen3-coder:30b", ok: true, gen_tok_per_s: 30, answered: false, reasoning_only: false },
    ]);
    expect(keptIds()).not.toContain("ollama/qwen3-coder:30b");
  });

  it("cloud rows never consult the bench file", () => {
    writeBench([{ tag: "meta/muse-glimmer-30b", ok: true, gen_tok_per_s: 0.1, answered: true }]);
    expect(keptIds()).toContain("nvidia_nim/meta/muse-glimmer-30b");
  });

  it("a corrupt file is ignored, not fatal", () => {
    fs.writeFileSync(path.join(dir, "local-bench.json"), "{not json");
    expect(keptIds()).toContain("ollama/qwen3-coder:30b");
  });
});

describe("the functional battery verdict outranks raw speed", () => {
  function writeBench(models: Array<Record<string, unknown>>): void {
    fs.writeFileSync(
      path.join(dir, "local-bench.json"),
      JSON.stringify({ schema: 1, slow_tok_per_s: 5, models }),
    );
  }

  it("a fast model the battery rejected is held out, with the battery's reason", () => {
    const messages: string[] = [];
    writeBench([
      {
        tag: "qwen3-coder:30b",
        ok: true,
        gen_tok_per_s: 40,
        answered: true,
        rotation_eligible: false,
        exclusion_reason: "could not produce valid structured JSON",
      },
    ]);
    const rotator = buildRotator("factory-deck")!;
    const filtered = filterRoutableCatalog(rotator, FCC_URL, (_k, m) => messages.push(m));
    expect(filtered!.catalog.routes.map((r) => r.id)).not.toContain("ollama/qwen3-coder:30b");
    expect(messages.join("\n")).toContain("structured JSON");
  });

  it("a battery pass admits the route", () => {
    writeBench([
      { tag: "muse-glimmer:30b", ok: true, gen_tok_per_s: 9, answered: true,
        rotation_eligible: true, exclusion_reason: "" },
    ]);
    expect(keptIds()).toContain("ollama/muse-glimmer:30b");
  });
});

describe("vision models never enter code rotation (parity with flexfactor)", () => {
  it("drops llava and its relatives", () => {
    writeCatalog([
      row("ollama/llava:7b", { api: "ollama", base_url: "http://127.0.0.1:11434", pool: "local:ollama", cost_class: "local-unlimited" }),
      row("ollama/bakllava:latest", { api: "ollama", base_url: "http://127.0.0.1:11434", pool: "local:ollama", cost_class: "local-unlimited" }),
      row("openrouter/qwen/qwen2.5-vl-72b:free", { pool: "openrouter:free" }),
      row("ollama/qwen3-coder:30b", { api: "ollama", base_url: "http://127.0.0.1:11434", pool: "local:ollama", cost_class: "local-unlimited" }),
    ]);
    expect(keptIds()).toEqual(["ollama/qwen3-coder:30b"]);
  });

  it("drops deep-research agent products, which reject chat completions outright", () => {
    // Live 2026-08-23 (IPlay run 751546a5): gemini/deep-research-* answered
    // every call with HTTP 400 "This model only supports Interactions API."
    writeCatalog([
      row("gemini/deep-research-preview-04-2026", { api: "gemini", pool: "gemini:free" }),
      row("gemini/deep-research-pro-preview-12-2025", { api: "gemini", pool: "gemini:free" }),
      row("openrouter/perplexity/sonar-deep-research", { pool: "openrouter:free" }),
      row("gemini/gemini-2.5-flash", { api: "gemini", pool: "gemini:free" }),
    ]);
    expect(keptIds()).toEqual(["gemini/gemini-2.5-flash"]);
  });
});
