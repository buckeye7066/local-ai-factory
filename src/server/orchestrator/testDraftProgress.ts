/**
 * Return the only draft number a resumed Test Writer may generate next.
 * Legacy checkpoints with a plan predate the counter and are treated as draft 1.
 */
export function nextTestDraftToGenerate(
  hasCheckpointedPlan: boolean,
  checkpointedDraft: number | undefined,
): number {
  return hasCheckpointedPlan ? (checkpointedDraft ?? 1) + 1 : 1;
}
