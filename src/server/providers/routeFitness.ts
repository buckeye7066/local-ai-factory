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

export function rotationExcludedReason(modelOrRouteId: string): string {
  const raw =
    process.env.FACTORY_ROTATION_EXCLUDE ?? ROTATION_EXCLUDE_DEFAULT;
  const id = String(modelOrRouteId || "").toLowerCase();
  for (const frag of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (frag && id.includes(frag)) {
      return `excluded from rotation (${frag}: too slow for a rotated job on this CPU)`;
    }
  }
  return "";
}
