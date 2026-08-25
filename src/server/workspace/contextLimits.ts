/**
 * One context contract for every stage that may inspect or approve changed
 * code. A file the builder is allowed to read must also fit in Test Writer,
 * QA, and Repair context; otherwise a legitimate edit can become impossible
 * to verify later in the same run.
 */
export const MAX_CONTEXT_FILE_CHARS = 64_000;
export const MAX_CONTEXT_TOTAL_CHARS = 120_000;
