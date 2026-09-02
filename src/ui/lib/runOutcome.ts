import type { RunRecord } from "../../shared/schemas.js";

/** One fail-closed definition of "ready" for toast and celebration surfaces. */
export function runIsReady(
  run: Pick<RunRecord, "status" | "demo" | "finalReport" | "destination" | "release">,
): boolean {
  if (run.status !== "completed" || run.demo) return false;
  if (run.finalReport?.testStatus !== "passing") return false;
  const destination = run.destination;
  // Legacy records without a destination predate receipt-bound delivery.
  if (!destination) return false;
  // Every destination kind, including workspace-only, earns readiness only
  // through a successful receipt-bound delivery with a verified commit.
  if (destination.status !== "delivered" || !destination.commitSha) {
    return false;
  }
  if (run.release && !run.release.released) return false;
  return true;
}
