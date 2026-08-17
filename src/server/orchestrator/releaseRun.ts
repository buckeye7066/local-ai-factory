import { gh, failureText, type ExecResult } from "../workspace/gitOps.js";

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
 * THE GATE IS EARNED EVIDENCE, NEVER MODEL JUDGMENT — three keys, all hard:
 *   1. the run's grounded QA passed (every executed verification command
 *      exited 0 — qaGrounding is the authority);
 *   2. tests actually EXECUTED and exited 0 (testStatus === "passing";
 *      "unknown" — nothing ran — can never release);
 *   3. the host repository's OWN CI checks go green on the PR (its branch
 *      protections and suites are the final word, exactly as they are for a
 *      human contributor).
 * A run that misses any key still delivers its branch + an OPEN PR with the
 * reason recorded — released is a claim only a merge can make, and the
 * deployed-production claim belongs to the repo's own deploy-from-main
 * automation, which the report names rather than asserts.
 *
 * Release failures NEVER fail the run: the build is delivered either way, and
 * pretending otherwise would lie in both directions.
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

export interface ReleaseResult {
  released: boolean;
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
    `Factory Deck ${gate.eligible ? "release" : "delivery (NOT auto-released)"} for run ${input.runId}.\n\n` +
    `Verification: ${gate.reason}.${caveatBlock}\n\n` +
    `🤖 Generated by Factory Deck.`;

  // 1. Open the PR (idempotent-ish: an existing PR for the branch is reused).
  let prUrl: string | null = null;
  const create: ExecResult = await run(
    [
      "pr",
      "create",
      "-R",
      slug,
      "--head",
      input.branch,
      "--base",
      "main",
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
          prUrl,
          mergedSha: null,
          reason:
            "host repo has no reported CI checks — release is held because absence is not passing evidence",
        };
      }
      if (Date.now() > deadline) {
        return {
          released: false,
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
      return {
        released: false,
        prUrl,
        mergedSha: null,
        reason:
          "host repo checks did not finish within the release window — PR left open",
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
  const [state, sha] = succeeded(view)
    ? view.stdout.trim().split(/\s+/)
    : ["UNKNOWN", ""];
  if (state !== "MERGED") {
    return {
      released: false,
      prUrl,
      mergedSha: null,
      reason: `merge command succeeded but the PR state reads ${state} — not claiming release`,
    };
  }
  return {
    released: true,
    prUrl,
    mergedSha: sha || null,
    // Say WHICH evidence backed the merge. "green host-repo checks" is a
    // claim only the first branch may make; when the repo has no CI the only
    // evidence is the run's own executed tests, and the report must not
    // dress that up as the host repo having approved it.
    reason:
      "merged to main after grounded QA, passing tests, green host-repo checks, and exact PR-head verification",
  };
}
