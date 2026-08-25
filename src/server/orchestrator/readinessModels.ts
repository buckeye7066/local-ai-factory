const FABLE_OR_OPUS_MODEL_ID = /^(?:claude-)?(?:fable|opus)(?:[-.][a-z0-9]+)*$/i;

/**
 * Accept only explicit Fable/Opus-class model identifiers.
 *
 * Anchoring the complete identifier prevents strings such as `not-opus`,
 * `claude-haiku-opus-proxy`, or arbitrary aliases from masquerading as the
 * mandatory Anthropic production reviewer. Version suffixes remain allowed,
 * for example `claude-opus-4-8` and `claude-fable-v1`.
 */
export function isSupportedFableOrOpusModel(model: string): boolean {
  return FABLE_OR_OPUS_MODEL_ID.test(String(model || "").trim());
}

export const READINESS_EVIDENCE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isReadinessEvidenceDigest(value: string): boolean {
  return READINESS_EVIDENCE_DIGEST.test(String(value || "").trim());
}
