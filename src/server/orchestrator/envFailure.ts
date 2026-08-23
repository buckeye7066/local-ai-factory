import type { VerificationEvidence } from "./qaGrounding.js";

/**
 * envFailure.ts — deterministic classification of verification failures that
 * FILE REPAIRS CANNOT FIX.
 *
 * The repair loop's only tool is writing project files. When a verification
 * command fails for an ENVIRONMENT reason — a native module with no compiled
 * binding, an ABI mismatch, a missing toolchain or binary — every repair loop
 * is a paid no-op against the wrong target, and the LLM diagnostician then
 * invents a plausible-sounding cause. Run d687f5fd (GrantFlow, 2026-08-15) is
 * the measured case: `npm ci` under the sandbox's --ignore-scripts left
 * better-sqlite3 with no binding, 20 auth tests failed, three repair loops
 * (~$2.60 in paid calls) patched innocent files, and the final review blamed
 * the Node version. The signatures below are matched against the EXECUTED
 * commands' real output — never against a model's summary of it — mirroring
 * the qaGrounding rule that executed evidence is the authority.
 *
 * A classification here does not mean the run is hopeless; it means the fix
 * is an environment/runner action (named in `remedy`), so the orchestrator
 * skips the repair loop and reports the true cause instead.
 */

export interface EnvironmentFailure {
  /** Short machine-stable id for the failure class. */
  signature: string;
  /** The command whose output matched. */
  command: string;
  /** What actually fixes it — a runner/environment action, not a file patch. */
  remedy: string;
}

const SIGNATURES: ReadonlyArray<{
  signature: string;
  pattern: RegExp;
  remedy: string;
}> = [
  {
    signature: "native_binding_missing",
    // better-sqlite3 & friends via the `bindings` package.
    pattern: /could not locate the bindings file/i,
    remedy:
      "The dependency's native binding was never compiled (install scripts are " +
      "suppressed by the sandbox). Run `npm rebuild` / `pnpm rebuild` in the " +
      "workspace — the verification plan now does this automatically after install.",
  },
  {
    signature: "native_abi_mismatch",
    pattern:
      /was compiled against a different node\.js version|NODE_MODULE_VERSION \d+.*NODE_MODULE_VERSION \d+/is,
    remedy:
      "The compiled native module targets a different Node ABI. Run `npm rebuild` " +
      "under the Node version the tests run with.",
  },
  {
    signature: "native_toolchain_failure",
    pattern: /gyp ERR!|node-gyp rebuild.*failed|MSBUILD : error/i,
    remedy:
      "Native compilation itself failed — a build-toolchain problem on this " +
      "machine (node-gyp / MSVC), not a defect in the generated files.",
  },
  {
    signature: "missing_binary",
    pattern:
      /'[^']+' is not recognized as an internal or external command|command not found|spawn \S+ ENOENT/i,
    remedy:
      "A binary the project needs is not installed or not on PATH in the " +
      "sandboxed environment.",
  },
  {
    signature: "disk_full",
    pattern: /ENOSPC|no space left on device|disk full|not enough disk space/i,
    remedy:
      "The workspace or runner disk is full. Free space under WORKSPACE_ROOT " +
      "(or the system drive) and rerun verification.",
  },
  {
    signature: "out_of_memory",
    pattern:
      /ENOMEM|out of memory|heap out of memory|allocation failed|cannot allocate memory|std::bad_alloc/i,
    remedy:
      "The command exhausted available memory. Reduce concurrency/workload or " +
      "run on a machine with more RAM, then rerun verification.",
  },
  {
    signature: "network_unreachable",
    pattern:
      /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|network unreachable|socket hang up|fetch failed/i,
    remedy:
      "A required network or local service endpoint could not be reached from " +
      "this environment. Verify the URL/service and rerun verification.",
  },
  {
    signature: "request_timeout",
    pattern:
      /ETIMEDOUT|ESOCKETTIMEDOUT|request timed out|connect timed out|deadline exceeded/i,
    remedy:
      "A required service timed out before responding. Check the service health " +
      "or timeout budget, then rerun verification.",
  },
  {
    signature: "engine_mismatch",
    pattern: /EBADENGINE|Unsupported engine/i,
    remedy:
      "The package manager refused the running Node version. Use a Node version " +
      "satisfying the project's engines range.",
  },
];

/** The environment signature matching one piece of text, if any (error ledger). */
export function matchEnvironmentSignature(
  text: string,
): { signature: string; remedy: string } | null {
  for (const { signature, pattern, remedy } of SIGNATURES) {
    if (pattern.test(text)) return { signature, remedy };
  }
  return null;
}

/**
 * Classify the FIRST environment-class failure found in the executed
 * evidence, or null when every failure looks repairable-by-files. Only
 * failing commands are scanned: a signature string inside a PASSING command's
 * output (e.g. a test asserting on these very messages) is not a failure.
 */
export function classifyEnvironmentFailure(
  evidence: VerificationEvidence,
): EnvironmentFailure | null {
  for (const result of evidence.executed) {
    if (result.exitCode === 0) continue;
    for (const { signature, pattern, remedy } of SIGNATURES) {
      if (pattern.test(result.outputTail)) {
        return { signature, command: result.command, remedy };
      }
    }
  }
  return null;
}
