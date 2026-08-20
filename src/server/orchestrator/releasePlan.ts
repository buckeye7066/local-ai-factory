import type { RunDestination } from "../../shared/schemas.js";
import type { HostCiPresence } from "../workspace/hostCi.js";

/**
 * releasePlan.ts — HOW THE TRUNK IS ALLOWED TO MOVE, DECIDED IN ONE PLACE.
 *
 * ── The policy, and the reversal (owner decision 2026-08-19/20) ──────────────
 *
 * "protect factory deck's trunk."
 *
 * PR #74 made `deliverRun` push the run's branch and then FAST-FORWARD the trunk
 * onto it directly. On an unprotected trunk that advanced main on Factory Deck's
 * OWN evidence — its demo gate, its verification gate, its file-digest receipt —
 * without ever waiting for the host repository's CI. That is now reversed:
 *
 *   THE PULL REQUEST IS THE PRIMARY PATH. The host repo's checks gate every
 *   trunk advance. Factory Deck opens the PR, arms auto-merge so a green PR
 *   still lands with no human in the loop, and never advances the trunk ahead
 *   of those checks.
 *
 *   THE DIRECT FAST-FORWARD SURVIVES ONLY AS A NAMED FALLBACK, in exactly two
 *   shapes, both of which must be *stated* in the run's report:
 *     1. the host repo configures no CI at all — there is no check to wait on,
 *        so a PR would hang forever on evidence that can never arrive; or
 *     2. the owner explicitly opted this destination in (`directTrunkAdvance`),
 *        which is the local/offline destination case.
 *   Anything else — including "we could not tell whether there is CI" — takes
 *   the PR path. Ambiguity resolves TOWARD the gate, never around it.
 *
 * This is NOT a human approval gate and must never become one. The owner's
 * standing doctrine is that the publish/private toggle is the only human gate;
 * auto-merge is what keeps "done means merged" true without one.
 *
 * ── Why both decisions live in this one file ────────────────────────────────
 *
 * Two mechanisms can put a run's work on the trunk, and when both ran on the
 * same run they collided (PR #75): after a successful fast-forward the branch
 * and the trunk are the SAME COMMIT, so the follow-up PR had zero commits,
 * GitHub refused it, and a run whose work was already in production reported
 * FAILED. The mirror case was just as wrong: a REJECTED fast-forward (what a
 * protected trunk looks like) failed delivery outright, so the PR recovery never
 * ran and verified work sat on a branch nobody was asked to merge.
 *
 * So there is one decision point, in two ordered questions:
 *   `planTrunkAdvance` — asked by `deliverRun` BEFORE it touches the trunk:
 *                        may this run fast-forward the trunk itself, or does the
 *                        PR gate own it?
 *   `planRelease`      — asked by `runFactory` AFTER delivery, from the facts
 *                        delivery actually produced: is there still a release
 *                        step to run, and which?
 * Neither question is answered by branching scattered through the orchestrator.
 */

/* ------------------------------------------------------------------ */
/* 1. May this run move the trunk itself?                              */
/* ------------------------------------------------------------------ */

export type TrunkAdvancePath =
  /**
   * PRIMARY. Publish the branch and stop. The trunk advances only through a
   * pull request the HOST repo's own checks have gated.
   */
  | "pr-gate"
  /**
   * NAMED FALLBACK. Fast-forward the trunk directly, because no host CI exists
   * to gate a PR or because the owner explicitly opted this destination in.
   */
  | "direct-fast-forward";

export interface TrunkAdvanceInput {
  /**
   * `options.directTrunkAdvance` — the owner's explicit opt-in for a
   * local/offline destination that will never have a PR gate. Absent by
   * default; this is the ONLY way to bypass CI on a repo that HAS CI.
   */
  directTrunkAdvance?: boolean;
  /** Whether the delivered tree configures any CI (see workspace/hostCi.ts). */
  hostCi: HostCiPresence;
}

export interface TrunkAdvanceDecision {
  path: TrunkAdvancePath;
  /** Why — verbatim into the destination detail, so the report SAYS the path. */
  reason: string;
}

export function planTrunkAdvance(input: TrunkAdvanceInput): TrunkAdvanceDecision {
  if (input.directTrunkAdvance === true) {
    return {
      path: "direct-fast-forward",
      reason:
        "FALLBACK (owner opt-in): this destination is explicitly configured for a direct trunk " +
        "advance, so the trunk was fast-forwarded without a pull request.",
    };
  }
  if (input.hostCi === "absent") {
    return {
      path: "direct-fast-forward",
      reason:
        "FALLBACK (no host CI): the host repo configures no CI, so a pull request would have no " +
        "check to wait on; the trunk was fast-forwarded directly.",
    };
  }
  // "present" and — deliberately — "unknown". Not knowing whether a gate exists
  // is never permission to skip one.
  return {
    path: "pr-gate",
    reason:
      input.hostCi === "present"
        ? "The host repo's CI gates the trunk: the branch was published and the trunk advances " +
          "only through a pull request those checks pass."
        : "Could not determine whether the host repo has CI, so the trunk was NOT advanced " +
          "directly — the pull request gate owns it.",
  };
}

/* ------------------------------------------------------------------ */
/* 2. What release step, if any, still has work to do?                 */
/* ------------------------------------------------------------------ */

export type ReleasePlan =
  /** Delivery did not complete and cannot be recovered — fail the run. */
  | "fail-delivery"
  /** The trunk already carries the work; record the release, open no PR. */
  | "already-on-trunk"
  /** The PRIMARY path: land the commits through the host repo's PR/CI gate. */
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

  // The trunk moved — only reachable through the named fallback above. There is
  // nothing left for a PR to contain.
  if (d.releasedToTrunk === true && d.status === "delivered") {
    return "already-on-trunk";
  }

  const prEligible =
    d.kind === "existing-repo" &&
    !!d.branch &&
    !!d.commitSha &&
    !input.demo &&
    input.releaseToMainEnabled;

  // Delivered with the trunk untouched — now the ORDINARY case, not an
  // exception: the branch is published and the host repo's PR gate owns the
  // trunk from here.
  if (d.status === "delivered") return prEligible ? "open-pr" : "none";

  // NOT delivered. The one recoverable shape is "the branch IS published, only
  // the trunk did not move" — a protected trunk that rejected the fallback
  // fast-forward. Anything else (nothing committed, nothing pushed, a bad
  // receipt) has no branch to open a PR from.
  if (d.branchPushed === true && d.releasedToTrunk !== true && prEligible) {
    return "open-pr";
  }

  return deliveryRequired ? "fail-delivery" : "none";
}

/* ------------------------------------------------------------------ */
/* 3. What does a release outcome mean for the RUN?                    */
/* ------------------------------------------------------------------ */

/**
 * THREE OUTCOMES, NOT TWO — see releaseRun.ts for how each is earned.
 *
 *   "merged"  → the commits are on the trunk.
 *   "pending" → the PR is open, auto-merge is armed on the verified commit, and
 *               the host repo's checks are still running. It lands with no
 *               human, but it is NOT in production yet.
 *   "held"    → genuinely blocked (evidence gate refused it, checks failed, the
 *               PR could not be opened, auto-merge could not be armed).
 */
export type ReleaseState = "merged" | "pending" | "held";

/** What the orchestrator does with a release outcome. */
export type ReleaseOutcome =
  /** The work is on the trunk; the run is finished and may say so. */
  | "complete"
  /** Open and auto-merging: the run finished, but must NOT claim production. */
  | "pending"
  /** Blocked: fail the run with the reason. */
  | "fail-run";

/**
 * A PENDING PR IS NOT A FAILED RUN. Before this existed the orchestrator failed
 * the run for anything that was not `released`, so an open PR whose checks were
 * simply still running was recorded as a FAILURE — the exact mirror of claiming
 * an open PR is "merged into main and in production", and just as false. Pure
 * so the mapping is pinned directly instead of inferred from an orchestrator
 * branch.
 */
export function planReleaseOutcome(state: ReleaseState): ReleaseOutcome {
  if (state === "merged") return "complete";
  if (state === "pending") return "pending";
  return "fail-run";
}
