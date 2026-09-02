const PLATFORM_EVIDENCE_BLOCKER =
  /^(?:windows|webkit|macos|ios|android) compatibility is applicable but lacks executed evidence\.$/;

const PRE_RELEASE_BLOCK_PREFIX = "Production readiness blocked before release review: ";

/**
 * Missing execution on another platform is the one deterministic readiness
 * hold that another trusted runner can satisfy without changing candidate
 * bytes or replaying a paid generation stage.
 */
export function onlyPlatformEvidenceBlockers(blockers: readonly string[]): boolean {
  return (
    blockers.length > 0 &&
    blockers.every((blocker) => PLATFORM_EVIDENCE_BLOCKER.test(blocker))
  );
}

/** Recover the exact deterministic blockers persisted on a held run. */
export function platformEvidenceBlockersFromRunError(
  error: string | null | undefined,
): string[] | null {
  if (!error?.startsWith(PRE_RELEASE_BLOCK_PREFIX)) return null;
  const blockers = error
    .slice(PRE_RELEASE_BLOCK_PREFIX.length)
    .split(";")
    .map((blocker) => blocker.trim())
    .filter(Boolean);
  return onlyPlatformEvidenceBlockers(blockers) ? blockers : null;
}
