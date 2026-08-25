/**
 * errorLedger.ts — every error a run hits, readable without watching logs.
 *
 * Owner requirement (2026-08-23): a Factory Deck / Purpose Foundry run must
 * leave an ERROR LEDGER the owner can open: for every error, WHEN (stage),
 * WHAT (the text), WHICH CODE (deck file:line + source line for deck-side
 * failures, the repository file for program-side failures, the route id for
 * provider failures), a CLASSIFICATION, and a SUGGESTED FIX. Suggestions come
 * first from the deterministic signature table below; only when nothing
 * matches does a model get asked, and that answer is labelled
 * "model suggestion, unverified" so it can never pass as a known fix.
 *
 * The ledger lives in the run record (`run.errorLedger`, served by
 * /api/runs/<id>), is mirrored to `.factory/errors/<runId>.json`, and is
 * rendered as the "Errors" section of the final report (reportGrounding).
 * Purpose Foundry runs use the same orchestrator, so they get the same ledger.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LLMProvider } from "../../shared/types.js";
import type {
  ErrorLedgerEntry,
  ErrorClassification,
  StageId,
} from "../../shared/schemas.js";
import { matchEnvironmentSignature } from "./envFailure.js";

export type { ErrorLedgerEntry, ErrorClassification };

/** One row of the deterministic signature table. */
interface Signature {
  id: string;
  pattern: RegExp;
  classification: ErrorClassification;
  suggestion: (m: RegExpMatchArray, message: string) => string;
}

/** Extract the first catalog route id named in a route/rotation message. */
export function routeIdFrom(message: string): string | null {
  const m =
    /\broute ([A-Za-z0-9_./:@-]+)/.exec(message) ||
    /\[rotate\] \w+: ([A-Za-z0-9_./:@-]+) failed/.exec(message) ||
    /\[rotate\] ([A-Za-z0-9_./:@-]+) failed/.exec(message);
  return m?.[1] ?? null;
}

/** Extract the first repository-looking source/test file named in text. */
export function programFileFrom(message: string): string | null {
  const m =
    /\b((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb|cs))\b/.exec(
      message,
    );
  return m?.[1] ?? null;
}

const SIGNATURES: readonly Signature[] = [
  {
    id: "reasoning_only_reply",
    pattern:
      /reasoning[- ]only|reasoning budget|finish=length.*empty|empty completion/i,
    classification: "provider",
    suggestion: () =>
      "The model spent its output budget on reasoning (or returned nothing) — raise maxTokens for this call, or keep the reasoning channel off for local routes (FACTORY_OLLAMA_THINK unset). Rotation already moved to the next pool.",
  },
  {
    id: "interactions_api_only",
    pattern: /only supports (the )?Interactions API/i,
    classification: "provider",
    suggestion: () =>
      "This route is an agentic deep-research product, not a chat model — hold it out of rotation (routeFitness `deep-research` pattern; refresh the AI Time catalog so it is not offered).",
  },
  {
    id: "rate_or_overload",
    pattern: /\b(429|529|503)\b|rate[- ]?limit|temporarily overloaded|Overloaded/i,
    classification: "provider",
    suggestion: () =>
      "The pool is cooling down (rate limit / overload). Rotation already moved to the next pool; nothing to fix unless every pool reports it, then wait for the cooldown to expire.",
  },
  {
    id: "transport_timeout",
    pattern:
      /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|TLS|certificate|socket hang up|fetch failed|timed out/i,
    classification: "provider",
    suggestion: () =>
      "Transient transport failure — retry. If it repeats on one route only, check that provider's status page; if it repeats everywhere, check this machine's network/VPN.",
  },
  {
    id: "model_not_found",
    pattern:
      /model not found|no longer available|is not found|\b404\b.*model|model .* does not exist/i,
    classification: "provider",
    suggestion: (_m, message) => {
      const route = routeIdFrom(message);
      return route?.startsWith("ollama/")
        ? `Pull the model locally: \`ollama pull ${route.slice("ollama/".length)}\`, or refresh the catalog (\`python -m aitime.catalog\`).`
        : "The provider retired or renamed this model — refresh the AI Time catalog (`python -m aitime.catalog`) so the route disappears.";
    },
  },
  {
    id: "missing_credential",
    pattern:
      /credential env not set|not set in this environment|needs [A-Z_]+ which is not set|credentials? (is|are) missing|Missing.*API_KEY/i,
    classification: "environment",
    suggestion: (_m, message) => {
      const env = /\b([A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|KEY))\b/.exec(message)?.[1];
      return `Add ${env ?? "the named key"} to ~/.fcc/.env (the deck hydrates missing route credentials from there) or export it before launching the deck.`;
    },
  },
  {
    id: "model_call_budget",
    pattern: /model call budget|MAX_MODEL_CALLS|call cap|budget exhausted|paid budget/i,
    classification: "budget",
    suggestion: () =>
      "The run hit a spend/call cap. Raise MAX_MODEL_CALLS_PER_RUN (or the FACTORY_PAID_* caps) deliberately, or resume the run after the cap window resets.",
  },
  {
    id: "per_file_context_limit",
    pattern: /exceeds the per-file context limit|could not be read in full/i,
    classification: "program-defect",
    suggestion: (_m, message) =>
      `A target file is too large for one model context${programFileFrom(message) ? ` (${programFileFrom(message)})` : ""} — split it in the repository or narrow the goals so the plan does not target it.`,
  },
  {
    id: "json_schema_rejected",
    pattern:
      /invalid_enum_value|invalid_type|Expected .* received|did not match the schema|schema validation/i,
    classification: "provider",
    suggestion: () =>
      "The model's JSON did not match the agent schema. Rotation retries on another pool; if one route does this repeatedly its yield drops and it cools down for this purpose.",
  },
  {
    id: "executed_test_failure",
    // Case-sensitive on purpose: "Run failed: ..." is not a test failure.
    pattern:
      /\bFAILED\b|AssertionError|Error: expect|\b\d+ failed\b|\bexited [1-9]\d*|exit code [1-9]\d*|Test failed/,
    classification: "program-defect",
    suggestion: (_m, message) => {
      const file = programFileFrom(message);
      return file
        ? `Fix the failing test/file named in the executed output: ${file}.`
        : "Fix the failing test named in the executed output (see the command tail in the QA evidence).";
    },
  },
  {
    id: "builder_empty_file",
    pattern: /empty contents for a new file/i,
    classification: "provider",
    suggestion: (_m, message) =>
      `The builder model returned an empty body for ${programFileFrom(message) ?? "a new file"} — a model-quality miss, not a repository fault. Rotation retries on another pool; a route that repeats this loses yield for this purpose.`,
  },
  {
    id: "unseen_anchored_edit_on_resume",
    pattern:
      /existing file was not supplied in full to this stage|refusing an unseen anchored edit/i,
    classification: "deck-defect",
    suggestion: (_m, message) =>
      `Deck defect (known 2026-08-23, run 751546a5): a resume replays checkpointed builder files against a workspace that already holds them, so every file reads as an unseen edit and is refused${programFileFrom(message) ? ` (${programFileFrom(message)})` : ""}. Start a fresh run, or fix runFactory's resume path to re-read existing targets in full before replaying writes.`,
  },
  {
    id: "builder_write_incomplete",
    pattern:
      /Builder write incomplete|NO BUILDER REACHED DISK|Wrote \d+ of \d+ builder file\(s\); \d+ refused/i,
    classification: "deck-defect",
    suggestion: () =>
      "Consequence line: the run stopped because one or more builder files were refused — see the WRITE REFUSED entries in this ledger for the file and the reason; fix those and resume/re-run.",
  },
  {
    id: "git_push_or_pr",
    pattern:
      /\bgit\b.*(rejected|denied|non-fast-forward)|pull request.*(failed|refused)|auto-merge/i,
    classification: "environment",
    suggestion: () =>
      "The host repository refused the push/PR. Check the remote's protection rules and the gh/git credentials this deck runs with, then resume the run.",
  },
];

export interface ClassifiedError {
  classification: ErrorClassification;
  suggestion: string;
  suggestionSource: "signature" | "none";
  signature: string | null;
}

/** Deterministic classification: the provider/transport table first, then envFailure signatures. */
export function classifyErrorMessage(message: string): ClassifiedError {
  for (const sig of SIGNATURES) {
    const m = sig.pattern.exec(message);
    if (m) {
      return {
        classification: sig.classification,
        suggestion: sig.suggestion(m, message),
        suggestionSource: "signature",
        signature: sig.id,
      };
    }
  }
  // Executed-output environment signatures (envFailure.ts) come after the
  // table above so a route timeout reads as "retry", not as a workspace fault.
  const env = matchEnvironmentSignature(message);
  if (env) {
    return {
      classification: "environment",
      suggestion: env.remedy,
      suggestionSource: "signature",
      signature: env.signature,
    };
  }
  return {
    classification: "deck-defect",
    suggestion: "",
    suggestionSource: "none",
    signature: null,
  };
}

/** The first stack frame inside this deck's own source, with its source line. */
export function deckFrameFrom(
  stack: string | undefined,
): { file: string; line: number; sourceLine: string } | null {
  if (!stack) return null;
  for (const raw of stack.split("\n")) {
    const m =
      /((?:[A-Za-z]:)?[^()\s]*[\\/]src[\\/]server[\\/][^()\s:]+):(\d+)(?::\d+)?/.exec(
        raw,
      );
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\/\/?/, "");
    if (/[\\/]__tests__[\\/]/.test(file) && !/errorLedger/.test(file)) {
      // A frame in a test file is still the deck's own code; keep it.
    }
    const line = Number(m[2]);
    let sourceLine = "";
    try {
      const text = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      sourceLine = (text[line - 1] ?? "").trim().slice(0, 200);
    } catch {
      sourceLine = "";
    }
    return { file, line, sourceLine };
  }
  return null;
}

export interface RecordInput {
  stage: StageId | null;
  message: string;
  /** The thrown error, when there is one — its stack names the deck code. */
  error?: unknown;
  /** Executed command context for program-side failures. */
  command?: string;
  exitCode?: number;
  /** Explicit route id when the caller knows it. */
  route?: string | null;
}

function dataRoot(): string {
  return path.resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
}

/** Where a run's ledger file lives. */
export function errorLedgerPath(runId: string): string {
  return path.join(dataRoot(), "errors", `${runId}.json`);
}

const MAX_ENTRIES = 500;

export class ErrorLedger {
  readonly entries: ErrorLedgerEntry[];
  private seq = 0;

  constructor(
    readonly runId: string,
    existing: ErrorLedgerEntry[] = [],
  ) {
    this.entries = existing;
    this.seq = existing.length;
  }

  /** Record one error. Repeats of the same stage+message bump `occurrences`. */
  record(input: RecordInput): ErrorLedgerEntry {
    const message = String(input.message || "")
      .trim()
      .slice(0, 4000);
    const dup = this.entries.find(
      (e) => e.stage === input.stage && e.message === message,
    );
    if (dup) {
      dup.occurrences += 1;
      dup.ts = Date.now();
      return dup;
    }
    const classified = classifyErrorMessage(
      input.command ? `${message}\n${input.command}` : message,
    );
    const err = input.error instanceof Error ? input.error : null;
    const frame = deckFrameFrom(err?.stack);
    const route = input.route ?? routeIdFrom(message);
    const programFile = programFileFrom(message);

    let codeKind: ErrorLedgerEntry["code"]["kind"] = "unknown";
    let classification = classified.classification;
    let suggestion = classified.suggestion;
    let suggestionSource: ErrorLedgerEntry["suggestionSource"] =
      classified.suggestionSource;
    if (route) {
      // A failure that carries a route id is the PROVIDER's by default, even
      // when a deck frame is on the stack: the HTTP client frame is where it
      // surfaced, not the cause. Route failures are never handed to the model
      // fallback either — that call is itself a rotated call and could
      // re-enter this ledger.
      codeKind = "route";
      if (classified.suggestionSource === "none") {
        classification = "provider";
        suggestion = `Provider-side failure on route ${route} — rotation moves to the next pool; retry. If it repeats on this route only, hold the route out or refresh the catalog.`;
        suggestionSource = "signature";
      }
    } else if (frame && classified.suggestionSource === "none") codeKind = "deck";
    else if (
      programFile &&
      (classification === "program-defect" || input.exitCode !== undefined)
    ) {
      codeKind = "program";
      if (classified.suggestionSource === "none") classification = "program-defect";
    } else if (frame) codeKind = "deck";
    // A command that ran and failed without a known signature is the
    // program's failure, not the deck's.
    if (
      input.exitCode !== undefined &&
      input.exitCode !== 0 &&
      classified.suggestionSource === "none" &&
      !route
    ) {
      classification = "program-defect";
    }

    if (!suggestion && input.exitCode !== undefined && input.exitCode !== 0) {
      suggestion = programFile
        ? `Fix ${programFile}; the command \`${input.command ?? "?"}\` exited ${input.exitCode}.`
        : `The command \`${input.command ?? "?"}\` exited ${input.exitCode}; read its output tail in the QA evidence and fix the named file.`;
    }
    const entry: ErrorLedgerEntry = {
      id: `${this.runId.slice(0, 8)}-${++this.seq}`,
      ts: Date.now(),
      stage: input.stage,
      message,
      code: {
        kind: codeKind,
        file:
          codeKind === "deck"
            ? (frame?.file ?? null)
            : codeKind === "program"
              ? programFile
              : null,
        line: codeKind === "deck" ? (frame?.line ?? null) : null,
        sourceLine: codeKind === "deck" ? (frame?.sourceLine ?? null) : null,
        route: route ?? null,
        command: input.command ?? null,
        exitCode: input.exitCode ?? null,
      },
      classification,
      signature: classified.signature,
      suggestion,
      suggestionSource: suggestion
        ? suggestionSource === "none"
          ? "signature"
          : suggestionSource
        : "none",
      occurrences: 1,
    };
    if (this.entries.length >= MAX_ENTRIES) this.entries.shift();
    this.entries.push(entry);
    return entry;
  }

  /** Log lines that ARE errors even when their kind is "info" (route journal). */
  static isErrorLogLine(kind: string, message: string): boolean {
    if (kind === "error") return true;
    if (kind === "warning")
      return /fail|refused|could not|cannot|unable|error|exhausted|timed out|NOT achieved|rejected/i.test(
        message,
      );
    return /\] \w+: \S+ failed \(|attempt \d+\/\d+ failed|^Run failed:|held-out|HTTP [45]\d\d/.test(
      message,
    );
  }

  /** Entries still without a suggestion. Route failures are never in here. */
  unresolved(): ErrorLedgerEntry[] {
    return this.entries.filter(
      (e) => e.suggestionSource === "none" && e.code.kind !== "route" && !e.code.route,
    );
  }

  /**
   * Fallback: ONE bounded model call for the entries the signature table could
   * not explain. Every answer is labelled "model suggestion, unverified" — the
   * model has not run anything and its fix is a guess until someone checks it.
   */
  async suggestWithModel(provider: LLMProvider, max = 8): Promise<number> {
    const pending = this.unresolved().slice(0, max);
    if (pending.length === 0) return 0;
    const schema = z.object({
      suggestions: z.array(
        z.object({ id: z.string(), fix: z.string().min(1).max(600) }),
      ),
    });
    try {
      const out = await provider.generateJson({
        system:
          "You are a build-system triage assistant. For each error, propose ONE concrete fix in one sentence. " +
          'Never claim the fix is verified. Answer JSON only: {"suggestions":[{"id":...,"fix":...}]}.',
        prompt: JSON.stringify(
          pending.map((e) => ({
            id: e.id,
            stage: e.stage,
            message: e.message.slice(0, 800),
            code: e.code,
          })),
        ),
        schema,
        schemaName: "ErrorFixSuggestions",
        temperature: 0,
        maxTokens: 1500,
        intent: {
          role: "judge",
          needs: ["structured_json"],
          purpose: "error ledger triage",
        },
      });
      const parsed = schema.safeParse(out);
      if (!parsed.success) return 0;
      let n = 0;
      for (const s of parsed.data.suggestions) {
        const entry = pending.find((e) => e.id === s.id);
        if (!entry || entry.suggestionSource !== "none") continue;
        entry.suggestion = `model suggestion, unverified: ${s.fix.trim()}`;
        entry.suggestionSource = "model";
        n += 1;
      }
      return n;
    } catch {
      return 0;
    }
  }

  /** Mirror the ledger to `.factory/errors/<runId>.json`. Returns the path. */
  writeFile(): string {
    const file = errorLedgerPath(this.runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          runId: this.runId,
          writtenAt: new Date().toISOString(),
          errors: this.entries,
        },
        null,
        2,
      ),
      "utf-8",
    );
    return file;
  }

  /** The one console line printed at run end. */
  summaryLine(): string {
    if (this.entries.length === 0) return "[errors] none";
    return `[errors] ${this.entries.length} recorded -> ${errorLedgerPath(this.runId)}`;
  }
}

/** Human-readable lines for the report's "Errors" section. */
export function renderErrorLines(entries: readonly ErrorLedgerEntry[]): string[] {
  return entries.map((e) => {
    const when = e.stage ?? "run";
    const where =
      e.code.kind === "deck" && e.code.file
        ? `deck ${e.code.file}:${e.code.line ?? "?"}${e.code.sourceLine ? ` \`${e.code.sourceLine}\`` : ""}`
        : e.code.kind === "program" && e.code.file
          ? `program ${e.code.file}`
          : e.code.kind === "route" && e.code.route
            ? `route ${e.code.route}`
            : "code not identified";
    const times = e.occurrences > 1 ? ` (x${e.occurrences})` : "";
    const fix = e.suggestion ? e.suggestion : "no suggestion";
    return `[${when}] ${e.classification}${times}: ${e.message.slice(0, 300)} — ${where} — fix: ${fix}`;
  });
}
