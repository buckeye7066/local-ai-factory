import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * hostCi.ts — DOES THE HOST REPOSITORY HAVE CI THAT COULD GATE A TRUNK ADVANCE?
 *
 * Owner decision 2026-08-19/20: "protect factory deck's trunk." The trunk is no
 * longer advanced on Factory Deck's own evidence; the HOST repository's checks
 * gate it, through a PR. The one narrow case where that is impossible is a repo
 * that has no CI at all — there is no check to wait on, so waiting forever would
 * just strand the work. This module answers that question, and ONLY that
 * question, from the delivered tree.
 *
 * IT FAILS TOWARD THE GATE, NEVER AWAY FROM IT. Three answers:
 *   - "present": a CI configuration was found → the PR path owns the trunk.
 *   - "absent":  the tree was read successfully and contains no CI config at all.
 *   - "unknown": the tree could not be read → treated exactly like "present" by
 *     `planTrunkAdvance`, because "I could not tell" must never be spent as
 *     permission to bypass a gate. Absence of evidence is not evidence of
 *     absence — the same rule `releaseRun` applies to "no checks reported".
 *
 * Deliberately a FILESYSTEM read, not a GitHub API call: it must work for a
 * plain git remote (including the bare local remotes the tests use), it must
 * cost nothing, and it must be decidable BEFORE any push happens.
 */

export type HostCiPresence = "present" | "absent" | "unknown";

export interface HostCiDetection {
  presence: HostCiPresence;
  /** What was found (or not), for the run's report. Never a bare boolean. */
  detail: string;
  /** The config path that decided "present", relative to the repo root. */
  evidence: string | null;
}

/**
 * Single-file CI configurations, in the order they are probed. A repo needs
 * exactly one of these to have a gate worth waiting for.
 */
const CI_FILES = [
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  ".circleci/config.yml",
  ".circleci/config.yaml",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "Jenkinsfile",
  ".travis.yml",
  "bitbucket-pipelines.yml",
  ".drone.yml",
  ".woodpecker.yml",
  "appveyor.yml",
  ".appveyor.yml",
  "cloudbuild.yaml",
  "cloudbuild.json",
  ".teamcity/settings.kts",
];

/** Directories whose *contents* are the CI definition (any workflow file counts). */
const CI_DIRS = [".github/workflows", ".buildkite", ".woodpecker"];

const WORKFLOW_EXT = /\.(ya?ml)$/i;

function dirHasWorkflow(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!WORKFLOW_EXT.test(name)) continue;
    try {
      // An empty file is a placeholder, not a gate.
      if (statSync(join(dir, name)).size > 0) return name;
    } catch {
      /* unreadable entry — keep looking */
    }
  }
  return null;
}

/**
 * Read `dir` and report whether the repository it holds configures any CI.
 *
 * Never throws: an unreadable tree is reported as "unknown", which the trunk
 * policy treats as "assume there is a gate".
 */
export function detectHostCi(dir: string): HostCiDetection {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return {
        presence: "unknown",
        detail: `Could not read ${dir} to look for CI configuration.`,
        evidence: null,
      };
    }
  } catch {
    return {
      presence: "unknown",
      detail: `Could not read ${dir} to look for CI configuration.`,
      evidence: null,
    };
  }

  for (const rel of CI_DIRS) {
    const found = dirHasWorkflow(join(dir, ...rel.split("/")));
    if (found) {
      const evidence = `${rel}/${found}`;
      return {
        presence: "present",
        detail: `The host repo configures CI (${evidence}), so its checks gate the trunk.`,
        evidence,
      };
    }
  }

  for (const rel of CI_FILES) {
    const abs = join(dir, ...rel.split("/"));
    try {
      if (existsSync(abs) && statSync(abs).size > 0) {
        return {
          presence: "present",
          detail: `The host repo configures CI (${rel}), so its checks gate the trunk.`,
          evidence: rel,
        };
      }
    } catch {
      /* unreadable candidate — keep looking */
    }
  }

  return {
    presence: "absent",
    detail:
      "The host repo configures no CI (no workflow or pipeline file in the delivered tree), " +
      "so there is no check for a pull request to wait on.",
    evidence: null,
  };
}
