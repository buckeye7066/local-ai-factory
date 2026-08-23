/**
 * routeFitness.ts — drop non-coding catalog routes before rotation picks them.
 *
 * Observed 2026-08-20: FlexFactor / Factory Deck rotation selected
 * llama-prompt-guard, moondream, orpheus (TTS), kosmos-2, deplot, etc. for
 * semantic code review. Those routes are free-tier/light in the catalog but
 * cannot author or review code, so batches completed zero files and the run
 * fail-closed as a "provider outage".
 *
 * AI Time should classify these as media/non-chat; until the catalog is
 * refreshed, every consumer must filter them process-locally (same rule as
 * missing credentials — never write shared-state cooldowns for another app).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UNFIT_CODE_PATTERNS: RegExp[] = [
  /\bprompt-?guard\b/i,
  /\bllama-guard\b/i,
  /\bnemoguard\b/i,
  /\bmoderation\b/i,
  /\brerank\b/i,
  /\bcontent-?safety\b/i,
  /\btopic-control\b/i,
  /\bsafety-guard\b/i,
  /\borpheus\b/i,
  /\btts\b/i,
  /\bwhisper\b/i,
  /\bmoondream\b/i,
  // Vision models. Parity with flexfactor_directed._UNFIT_CODE_PATTERNS, which
  // gained these 2026-08-21 after llava:7b was rotated in for code review;
  // this twin had drifted and kept ollama/llava:7b in the ring (found
  // 2026-08-23 by the live catalog filter).
  /\bllava\b/i,
  /\bbakllava\b/i,
  /\bminicpm-v\b/i,
  /qwen[^\s/]*-vl\b/i,
  /\bpixtral\b/i,
  /\bkosmos\b/i,
  /\bdeplot\b/i,
  /\bvila\b/i,
  /\bnvclip\b/i,
  /\bfuyu\b/i,
  /\bclip-preview\b/i,
  /\bstable-diffusion\b/i,
  /\bimagen\b/i,
  /\bflux\b/i,
  /\blyria\b/i,
  /\bveo\b/i,
  /\briffusion\b/i,
  /\bembed\b/i,
  /\bretrieval\b/i,
  /\bnomic-embed\b/i,
  /\bvision-only\b/i,
  /\bsynthetic-video\b/i,
  /\bai-synthetic-video\b/i,
  // Agentic "deep research" products are not chat-completion models. Gemini's
  // deep-research-* routes answer every generateContent call with HTTP 400
  // "This model only supports Interactions API." (measured live 2026-08-23,
  // IPlay run 751546a5: two wasted attempts + retry waits in the research
  // stage), and OpenAI's o*-deep-research / Perplexity sonar-deep-research
  // are the same product class behind a different wire. They can never author
  // or review code through this transport, so they are held out exactly like
  // guard/TTS/vision routes. FlexFactor has the same drift (report, not fix
  // here).
  /\bdeep-research\b/i,
  // Realtime (speech/WebRTC) endpoints answer 404 "This is not a chat model"
  // (live FlexFactor run 2026-08-23: openai_api/gpt-realtime-1.5 rotated in as
  // a light judge). Parity with flexfactor_directed's r"realtime".
  /\brealtime\b/i,
];

export function unfitForCodeReason(modelOrRouteId: string): string {
  const id = String(modelOrRouteId || "");
  for (const re of UNFIT_CODE_PATTERNS) {
    if (re.test(id)) {
      return `non-coding model (${re.source.replace(/\\b/g, "").replace(/\\\?/g, "")})`;
    }
  }
  return "";
}

export function isFitForCode(modelOrRouteId: string): boolean {
  return !unfitForCodeReason(modelOrRouteId);
}

/**
 * Routes that are REAL, free and code-capable but must not be ROTATED INTO on
 * this machine, because they are far too slow to carry a deck job.
 *
 * Muse Glimmer is the case this exists for. It is a 30B dense decoder and this
 * box has no GPU Ollama can use (`ollama ps` reports 100% CPU), so it generates
 * at roughly 1-1.5 tokens/second. Rotation is CHEAPEST-FIRST and a local model
 * is cost class 0 — the front of the queue — so a slow local route is not just
 * slow, it is *preferentially* slow: picked first, every sweep. A single 2k
 * token step would take about half an hour.
 *
 * So Glimmer is standalone-only by default (owner decision 2026-08-22). Run it
 * deliberately via `pnpm glimmer` / rotation-pin, not by letting the ring find
 * it. This is the twin of `_rotation_excluded_reason` in flexfactor.py — if the
 * policy changes in one it changes in the other, in the same commit.
 *
 * Process-local only: nothing here is written into the shared rotation state,
 * so it cannot bench the pool for FlexFactor or Purpose Foundry.
 *
 * Override with FACTORY_ROTATION_EXCLUDE (comma-separated substrings); set it
 * to the empty string to let Glimmer rotate after all.
 */
// Scoped to the LOCAL route on purpose. The catalog also carries
// nvidia_nim/meta/muse-glimmer-30b (free-tier, strong) and
// openrouter/meta/muse-glimmer-30b (paid) — the SAME model served from the
// cloud, at cloud speed. The slowness above is a property of THIS machine's
// CPU, not of Muse Glimmer, so excluding the cloud rows would deny rotation a
// good free route for a reason that does not apply to it.
const ROTATION_EXCLUDE_DEFAULT = "ollama/muse-glimmer";

interface BenchEntry {
  tag: string;
  ok: boolean;
  gen_tok_per_s?: number | null;
  answered?: boolean;
  reasoning_only?: boolean;
  /** Set by bench_battery.py once the functional tasks have run. */
  rotation_eligible?: boolean;
  exclusion_reason?: string;
  /** Same, measured with the reasoning channel off (bench_battery --no-think). */
  rotation_eligible_nothink?: boolean;
  exclusion_reason_nothink?: string;
}
interface BenchTable {
  floor: number;
  byTag: Map<string, BenchEntry>;
}

let benchCache: { mtimeMs: number; table: BenchTable } | null = null;

function localBenchPath(): string {
  const base =
    process.env.AITIME_STATE_DIR ||
    path.join(process.env.LOCALAPPDATA || os.homedir(), "AITime");
  return path.join(base, "local-bench.json");
}

/**
 * Measured speeds for local models, written by
 * C:\Users\firer\glimmer\tools\bench_local_models.py — the same prompt through
 * the same Ollama for every local model. Read-only here; a missing or
 * unreadable file means "no measurement", never an error. Twin of
 * flexfactor._local_bench.
 */
function localBench(): BenchTable | null {
  const file = localBenchPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (benchCache && benchCache.mtimeMs === mtimeMs) return benchCache.table;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      slow_tok_per_s?: number;
      models?: BenchEntry[];
    };
    const byTag = new Map<string, BenchEntry>();
    for (const e of raw.models ?? []) {
      if (e && typeof e.tag === "string") byTag.set(e.tag.toLowerCase(), e);
    }
    const table = { floor: Number(raw.slow_tok_per_s) || 5, byTag };
    benchCache = { mtimeMs, table };
    return table;
  } catch {
    return null;
  }
}

export function rotationExcludedReason(modelOrRouteId: string): string {
  const id = String(modelOrRouteId || "").toLowerCase();

  // Measured first: a local route with a benchmark entry is judged by its
  // real generation rate, and that verdict outranks the name list below.
  if (id.startsWith("ollama/")) {
    const bench = localBench();
    const entry = bench?.byTag.get(id.slice("ollama/".length));
    if (entry?.ok) {
      // The functional battery (bench_battery.py) is the stronger verdict
      // when it has run: speed AND valid JSON AND a real planted-defect
      // repair AND a real review. Its reason is carried through verbatim.
      // Local calls run with the reasoning channel OFF (callRoute sends
      // think:false to /api/chat) unless FACTORY_OLLAMA_THINK=1, so the
      // no-think battery verdict is the one that matches the call mode.
      const thinkOn = process.env.FACTORY_OLLAMA_THINK === "1";
      const useNoThink = !thinkOn && typeof entry.rotation_eligible_nothink === "boolean";
      if (useNoThink) {
        if (entry.rotation_eligible_nothink) return "";
        return `excluded from rotation (battery no-think: ${entry.exclusion_reason_nothink || "failed"})`;
      }
      if (typeof entry.rotation_eligible === "boolean") {
        if (entry.rotation_eligible) return "";
        return `excluded from rotation (battery: ${entry.exclusion_reason || "failed"})`;
      }
      // The speed prompt allows 48 tokens; a thinking model spends all of
      // them reasoning, which says nothing about whether it answers -- the
      // battery decides that (rotation_eligible above). Only a TRULY empty
      // reply (no answer, no reasoning) is evidence here.
      if (entry.answered === false && !entry.reasoning_only) {
        return "excluded from rotation (measured: produced no answer at all)";
      }
      const rate = entry.gen_tok_per_s;
      if (typeof rate === "number" && rate < bench!.floor) {
        return (
          `excluded from rotation (measured ${rate} tok/s on this CPU, below the ` +
          `${bench!.floor} tok/s floor for a rotated job)`
        );
      }
      return "";
    }
  }

  const raw =
    process.env.FACTORY_ROTATION_EXCLUDE ?? ROTATION_EXCLUDE_DEFAULT;
  for (const frag of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (frag && id.includes(frag)) {
      return `excluded from rotation (${frag}: too slow for a rotated job on this CPU)`;
    }
  }
  return "";
}
