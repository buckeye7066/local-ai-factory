import { gh, failureText, type ExecResult } from "../workspace/gitOps.js";
import type { ReleaseState } from "./releasePlan.js";

const succeeded = (r: ExecResult): boolean => r.code === 0 && !r.spawnError;

/**
 * releaseRun.ts — FINISH THE JOB: an extend run that EARNED it merges to main.
 *
 * Owner order 2026-08-15: "When the run finishes factory deck, it should be
 * either a new program, or in this case with grantflow, a patch that improved
 * the program towards its purpose, and placed into production." Delivery used
 * to stop at pushing `factory-deck/<id>` — a branch nobody deploys. The last
 * mile is the intake's own Phase 10: open the PR, let the HOST repo's checks
 * run, merge only when they pass, and report the merged SHA.
 *
 * WHEN THIS RUNS (corrected again 2026-08-20 — "protect factory deck's trunk").
 * THIS IS NOW THE PRIMARY PATH, not a recovery. `deliverRun` publishes the run's
 * branch and stops; the trunk advances only here, through a PR the HOST repo's
 * own checks passed. The direct fast-forward in `gitOps.releaseToMain` survives
 * only as `planTrunkAdvance`'s named fallback (a repo with no CI at all, or an
 * explicit owner opt-in), so `runFactory` skips this step only when the trunk
 * already carries the work and a PR from that branch would be EMPTY.
 *
 * The interim policy this replaces is worth naming plainly, because it is the
 * thing being reversed: between 2026-08-19 and 2026-08-20 an UNPROTECTED trunk
 * was advanced on Factory Deck's own evidence without ever waiting for the host
 * repo's checks. It no longer is.
 *
 * NO HUMAN GATE. Auto-merge is armed when this process stops watching a PR
 * whose checks are still running, so a green PR still lands with nobody in the
 * loop — the owner's publish/private toggle stays the only human gate, and
 * "done means merged" stays true. What auto-merge must never do is let the run
 * CLAIM production: a PR that has not merged yet reports `state: "pending"`.
 *
 * THE GATE HERE IS EARNED EVIDENCE, NEVER MODEL JUDGMENT — three keys, all hard:
 *   1. the run's grounded QA passed (every executed verification command
 *      exited 0 — qaGrounding is the authority);
 *   2. tests actually EXECUTED and exited 0 (testStatus === "passing";
 *      "unknown" — nothing ran — can never release);
 *   3. the host repository's OWN CI checks go green on the PR.
 * A run that misses any key still delivers its branch + an OPEN PR with the
 * reason recorded — released is a claim only a merge can make, and the
 * deployed-production claim belongs to the repo's own deploy-from-main
 * automation, which the report names rather than asserts.
 *
 * A held release DOES fail the run (runFactory marks it failed with the
 * reason). An earlier version of this comment claimed the opposite — "release
 * failures NEVER fail the run" — which was false the moment the trunk became
 * part of the definition of delivered.
 */

export interface ReleaseInput {
  /** e.g. https://github.com/owner/repo — the destination target. */
  repoUrl: string;
  branch: string;
  runId: string;
  appName: string | null;
  qaPassed: boolean;
  testStatus: "passing" | "failing" | "unknown";
  /** Exact delivered commit covered by the verification receipt. */
  verifiedCommitSha: string;
  /** Final-report caveats (unwired scaffolding etc.) surfaced in the PR body. */
  caveats: string[];
  /** True when the delivery contains no wired product change (see isPaperOnlyDelivery). */
  paperOnly?: boolean;
  /** Injectable gh runner for tests. */
  ghImpl?: typeof gh;
  /** Injectable sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Max time to wait for the host repo's checks. */
  checkTimeoutMs?: number;
  /**
   * How long "no checks reported" must persist before it is believed to mean
   * "this repo has no CI" rather than "GitHub has not registered them yet".
   * Injectable so tests can exercise the race without waiting minutes.
   */
  noChecksGraceMs?: number;
  /** Consecutive absent readings required alongside the grace window. */
  noChecksConfirmations?: number;
}

/**
 * THREE OUTCOMES, NOT TWO.
 *
 * `released: false` used to cover both "this is blocked" and "this is still
 * going green", and the orchestrator failed the run for either. Reporting an
 * open, auto-merging PR as a FAILURE is the same class of dishonesty as
 * reporting one as "in production" — it is just wrong in the other direction.
 * The state lives in releasePlan.ts with the rest of the release policy;
 * `planReleaseOutcome` maps it to what the run does.
 */
export type { ReleaseState } from "./releasePlan.js";

export interface ReleaseResult {
  released: boolean;
  state: ReleaseState;
  prUrl: string | null;
  mergedSha: string | null;
  reason: string;
}

/** owner/repo from a github URL, or null when it is not a github remote. */
export function repoSlug(repoUrl: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/.\s]+)/i.exec(repoUrl);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * A delivery consisting ONLY of docs, standalone tests, and schema files is
 * paper — it changes no product behavior. Run a1d8866f delivered exactly this
 * (5 docs + 4 self-referential contract tests + a prisma schema for an ORM the
 * host repo does not use) with every command legitimately exiting 0: grounded
 * QA cannot catch a build that verifies its own paper. Paper never auto-merges.
 */
const PAPER_PATH_RE =
  /(?:^|\/)(?:docs?|tests?|__tests__|test|prisma)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$|\.mdx?$/i;

export function isPaperOnlyDelivery(filePaths: string[]): boolean {
  if (filePaths.length === 0) return true;
  return filePaths.every((p) => PAPER_PATH_RE.test(p.replace(/\\/g, "/")));
}

/** The evidence gate — pure, so tests pin it directly. */
export function releaseEligible(input: {
  qaPassed: boolean;
  testStatus: ReleaseInput["testStatus"];
  paperOnly?: boolean;
}): { eligible: boolean; reason: string } {
  if (input.paperOnly) {
    return {
      eligible: false,
      reason:
        "delivery contains only docs/tests/schema paper — no wired product change, so there is nothing to release",
    };
  }
  if (!input.qaPassed) {
    return {
      eligible: false,
      reason:
        "grounded QA did not pass — the branch and an open PR are the honest deliverable",
    };
  }
  if (input.testStatus !== "passing") {
    return {
      eligible: false,
      reason:
        input.testStatus === "unknown"
          ? "no test command executed — an unverified build never releases"
          : "tests failed — an unverified build never releases",
    };
  }
  return { eligible: true, reason: "grounded QA green and tests passing" };
}

const CHECK_POLL_MS = 90_000;

/**
 * How long "no checks reported" must persist before it is believed.
 *
 * `gh pr checks` says "no checks reported" both for a repo with no CI at all
 * AND for the first seconds of a brand-new PR whose workflow runs GitHub has
 * not registered yet. Treating the first reading as truth merged to main ahead
 * of the host repo's own suite.
 */
const NO_CHECKS_GRACE_MS = 120_000;
/** Consecutive absent readings required alongside the grace window. */
const NO_CHECKS_CONFIRMATIONS = 3;

export async function releaseRun(input: ReleaseInput): Promise<ReleaseResult> {
  const run = input.ghImpl ?? gh;
  const sleep =
    input.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const slug = repoSlug(input.repoUrl);
  if (!slug) {
    return {
      released: false,
      state: "held",
      prUrl: null,
      mergedSha: null,
      reason: `destination is not a GitHub repo (${input.repoUrl}) — nothing to merge`,
    };
  }

  const gate = releaseEligible(input);
  // Ineligible work must not create external state. A held branch is already
  // available through delivery; opening a PR before this check made "unknown"
  // tests and paper-only output look review-ready and triggered host automation.
  if (!gate.eligible) {
    return {
      released: false,
      state: "held",
      prUrl: null,
      mergedSha: null,
      reason: gate.reason,
    };
  }
  const title = `${input.appName ?? "Factory Deck"}: run ${input.runId.slice(0, 8)}`;
  const caveatBlock = input.caveats.length
    ? `\n\n## Caveats\n${input.caveats.map((c) => `- ${c}`).join("\n")}`
    : "";
  const body =
    `Factory Deck release for run ${input.runId}.\n\n` +
    `Verification: ${gate.reason}.${caveatBlock}\n\n` +
    `🤖 Generated by Factory Deck.`;

  // 1. Open the PR (idempotent-ish: an existing PR for the branch is reused).
  //
  //    NO `--base`, deliberately. It used to be hardcoded `main`, which is the
  //    same assumption `gitOps.defaultRemoteBranch` exists to avoid: a repo
  //    whose trunk is `master` (or anything else) would have had its PR opened
  //    against a branch that may not even exist. Omitted, `gh` resolves the
  //    BASE REPO's real default branch itself — the remote's own answer, not
  //    ours, and one fewer round trip than asking for it separately.
  let prUrl: string | null = null;
  const create: ExecResult = await run(
    [
      "pr",
      "create",
      "-R",
      slug,
      "--head",
      input.branch,
      "--title",
      title,
      "--body",
      body,
    ],
    process.cwd(),
    120_000,
  );
  if (succeeded(create)) {
    prUrl = create.stdout.trim().split(/\s+/).pop() ?? null;
  } else if (/already exists/i.test(create.stderr + create.stdout)) {
    const view = await run(
      ["pr", "view", input.branch, "-R", slug, "--json", "url", "--jq", ".url"],
      process.cwd(),
      60_000,
    );
    prUrl = succeeded(view) ? view.stdout.trim() : null;
  }
  if (!prUrl) {
    return {
      released: false,
      state: "held",
      prUrl: null,
      mergedSha: null,
      reason: `could not open the PR: ${failureText(create)}`,
    };
  }

  // 2. Wait for the HOST repo's own checks. `gh pr checks` exits 0 when all
  //    checks pass, 8 while pending, non-zero otherwise.
  //
  //    A repo with genuinely NO checks reports "no checks" and is pass-through
  //    (that repo imposed no gate). But absence must be CONFIRMED, never taken
  //    on the first look: this loop runs immediately after `pr create`, and
  //    GitHub takes seconds to register a new PR's workflow runs. During that
  //    window a repo that DOES have CI also reports "no checks reported" — so
  //    the old single-shot `break` could merge to main before the host repo's
  //    suite had even started, which is precisely a merge with no evidence
  //    behind it. Require several consecutive absent observations spanning a
  //    grace window before believing the repo has no CI at all.
  const deadline = Date.now() + (input.checkTimeoutMs ?? 45 * 60_000);
  const graceUntil = Date.now() + (input.noChecksGraceMs ?? NO_CHECKS_GRACE_MS);
  const neededAbsent = input.noChecksConfirmations ?? NO_CHECKS_CONFIRMATIONS;
  let absentObservations = 0;
  for (;;) {
    const checks = await run(
      ["pr", "checks", prUrl, "--json", "state,name"],
      process.cwd(),
      60_000,
    );
    const raw = checks.stdout + checks.stderr;
    if (/no checks reported/i.test(raw)) {
      absentObservations++;
      // Believe "this repo has no CI" only after the grace window has elapsed
      // AND the absence has held across several polls.
      if (absentObservations >= neededAbsent && Date.now() >= graceUntil) {
        return {
          released: false,
          state: "held",
          prUrl,
          mergedSha: null,
          reason:
            "host repo has no reported CI checks — release is held because absence is not passing evidence",
        };
      }
      if (Date.now() > deadline) {
        return {
          released: false,
          state: "held",
          prUrl,
          mergedSha: null,
          reason:
            "host repo reported no checks for the whole release window — PR left open",
        };
      }
      await sleep(CHECK_POLL_MS);
      continue;
    }
    // Checks appeared, so the repo DOES have CI: absence was just the
    // registration race. Never fall back to the pass-through path again.
    absentObservations = 0;
    let states: Array<{ state: string; name: string }> = [];
    try {
      states = JSON.parse(checks.stdout);
    } catch {
      /* non-JSON output while checks initialize — poll again */
    }
    const failed = states.filter((s) =>
      /FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/i.test(s.state),
    );
    if (failed.length) {
      return {
        released: false,
        state: "held",
        prUrl,
        mergedSha: null,
        reason: `host repo checks failed: ${failed
          .map((f) => f.name)
          .slice(0, 4)
          .join(", ")}`,
      };
    }
    const pending = states.filter((s) =>
      /PENDING|QUEUED|IN_PROGRESS|EXPECTED/i.test(s.state),
    );
    const successful = states.filter((s) => /^SUCCESS$/i.test(s.state));
    const nonGreenTerminal = states.filter(
      (s) =>
        !/^SUCCESS$/i.test(s.state) &&
        !/PENDING|QUEUED|IN_PROGRESS|EXPECTED/i.test(s.state),
    );
    if (nonGreenTerminal.length) {
      return {
        released: false,
        state: "held",
        prUrl,
        mergedSha: null,
        reason:
          "host repo checks did not produce an all-success result: " +
          nonGreenTerminal
            .map((check) => `${check.name} (${check.state})`)
            .slice(0, 4)
            .join(", "),
      };
    }
    if (states.length > 0 && !pending.length && successful.length === states.length) {
      break;
    }
    if (Date.now() > deadline) {
      // THE ONLY EXIT WHERE THE PR COULD STILL GO GREEN ON ITS OWN. Every other
      // exit is terminal (merged, checks failed, ineligible, head mismatch, no
      // CI at all), so this is the whole surface that would otherwise need a
      // human later — and the owner's doctrine bans that. Hand the merge to
      // GitHub itself, bound to the same verified head commit, then report the
      // honest state: open and pending, NOT released, NOT in production.
      const armed = await run(
        [
          "pr",
          "merge",
          prUrl,
          "-R",
          slug,
          "--squash",
          "--auto",
          "--match-head-commit",
          input.verifiedCommitSha,
        ],
        process.cwd(),
        120_000,
      );
      if (!succeeded(armed)) {
        return {
          released: false,
          state: "held",
          prUrl,
          mergedSha: null,
          reason:
            "host repo checks did not finish within the release window and auto-merge could not be " +
            `armed (${failureText(armed)}) — the PR is open but nothing will land it automatically`,
        };
      }
      return {
        released: false,
        state: "pending",
        prUrl,
        mergedSha: null,
        reason:
          "host repo checks are still running; auto-merge is armed on the verified commit, so the PR " +
          "lands on the trunk when they pass. The work is NOT on the trunk and NOT in production yet",
      };
    }
    await sleep(CHECK_POLL_MS);
  }

  // Bind the merge to the exact commit whose bytes passed Factory Deck's
  // receipt. A branch update after verification must never inherit its green.
  const head = await run(
    ["pr", "view", prUrl, "-R", slug, "--json", "headRefOid", "--jq", ".headRefOid"],
    process.cwd(),
    60_000,
  );
  if (!succeeded(head) || head.stdout.trim() !== input.verifiedCommitSha) {
    return {
      released: false,
      state: "held",
      prUrl,
      mergedSha: null,
      reason:
        "PR head no longer matches the exact verified delivered commit — re-verify before release",
    };
  }

  // 3. Merge (squash, never force) and confirm with the repo's own record.
  const merge = await run(
    [
      "pr",
      "merge",
      prUrl,
      "-R",
      slug,
      "--squash",
      "--match-head-commit",
      input.verifiedCommitSha,
    ],
    process.cwd(),
    120_000,
  );
  if (!succeeded(merge)) {
    return {
      released: false,
      state: "held",
      prUrl,
      mergedSha: null,
      reason: `merge refused by the host repo: ${failureText(merge)}`,
    };
  }
  const view = await run(
    [
      "pr",
      "view",
      prUrl,
      "-R",
      slug,
      "--json",
      "state,mergeCommit",
      "--jq",
      '.state + " " + (.mergeCommit.oid // "")',
    ],
    process.cwd(),
    60_000,
  );
  const [prState, sha] = succeeded(view)
    ? view.stdout.trim().split(/\s+/)
    : ["UNKNOWN", ""];
  if (prState !== "MERGED") {
    return {
      released: false,
      state: "held",
      prUrl,
      mergedSha: null,
      reason: `merge command succeeded but the PR state reads ${prState} — not claiming release`,
    };
  }
  return {
    released: true,
    state: "merged",
    prUrl,
    mergedSha: sha || null,
    // Say WHICH evidence backed the merge. Reaching here means the loop above
    // observed real checks and every one of them SUCCESS — so "green host-repo
    // checks" is a claim this line has actually earned. No other exit from this
    // function may make it.
    reason:
      "merged to the trunk after grounded QA, passing tests, green host-repo checks, and exact PR-head verification",
  };
}
