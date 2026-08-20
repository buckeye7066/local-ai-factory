import type { RunDestination } from "../../shared/schemas.js";

/**
 * releasePlan.ts — WHICH RELEASE STEP, IF ANY, STILL HAS WORK TO DO.
 *
 * Two mechanisms can put an extend run's work on the trunk, written four days
 * apart, and until 2026-08-19 they both ran on every run:
 *
 *   1. `gitOps.releaseToMain`, called from `deliverRun`: fast-forwards the
 *      repo's real default branch onto the run's `factory-deck/<id>` branch.
 *   2. `releaseRun`: opens a PR from that branch onto main, waits for the HOST
 *      repo's own CI checks, and merges only when they are green.
 *
 * They collide. After (1) succeeds the branch and the trunk are the SAME
 * COMMIT, so `git rev-list trunk..branch` is empty and the PR (2) opens has no
 * commits in it — GitHub refuses an empty PR, `releaseRun` reports "could not
 * open the PR", and the run was then marked FAILED with its work sitting in
 * production. A run that succeeded must never be reported as failed.
 *
 * The mirror case was just as wrong: when (1) is REJECTED — which is what a
 * PROTECTED trunk looks like — delivery returned "failed" and the run stopped
 * there, so (2), the correct recovery for a protected trunk, never ran at all.
 * Verified work sat on a pushed branch with no PR and nothing asking anyone to
 * finish it. That is the same hole FlexFactor closed on its own push path.
 *
 * This function is the single place that decides, so the decision can be
 * exercised directly instead of inferred from a long orchestrator branch.
 */
export type ReleasePlan =
  /** Delivery did not complete and cannot be recovered — fail the run. */
  | "fail-delivery"
  /** The trunk already carries the work; record the release, open no PR. */
  | "already-on-trunk"
  /** The trunk did not move; land the same commits through the repo's PR gate. */
  | "open-pr"
  /** Nothing to release (workspace-only, new repo, demo, or opted out). */
  | "none";

export interface ReleasePlanInput {
  destination: Pick<
    RunDestination,
    "status" | "kind" | "branch" | "commitSha" | "branchPushed" | "releasedToTrunk"
  >;
  /** True for a simulated run — never touches a real repo. */
  demo: boolean;
  /** `options.pushToOrigin`; `false` means the owner opted out of delivery. */
  pushToOrigin?: boolean;
  /** False when FACTORY_RELEASE_TO_MAIN=0. */
  releaseToMainEnabled: boolean;
}

export function planRelease(input: ReleasePlanInput): ReleasePlan {
  const d = input.destination;

  const deliveryRequired =
    !input.demo &&
    d.kind !== "workspace-only" &&
    !(d.kind === "existing-repo" && input.pushToOrigin === false);

  // The trunk moved. There is nothing left for a PR to contain.
  if (d.releasedToTrunk === true && d.status === "delivered") {
    return "already-on-trunk";
  }

  const prEligible =
    d.kind === "existing-repo" &&
    !!d.branch &&
    !!d.commitSha &&
    !input.demo &&
    input.releaseToMainEnabled;

  // Delivered, but the trunk was not advanced here (a re-delivery, or a record
  // written before the fast-forward release existed): the PR gate still owns it.
  if (d.status === "delivered") return prEligible ? "open-pr" : "none";

  // NOT delivered. The one recoverable shape is "the branch IS published, only
  // the trunk did not move" — a protected trunk. Anything else (nothing
  // committed, nothing pushed, a bad receipt) has no branch to open a PR from.
  if (d.branchPushed === true && d.releasedToTrunk !== true && prEligible) {
    return "open-pr";
  }

  return deliveryRequired ? "fail-delivery" : "none";
}
