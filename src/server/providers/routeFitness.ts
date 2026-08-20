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
