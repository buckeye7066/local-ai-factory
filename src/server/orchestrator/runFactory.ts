import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AppConfig, AppSecrets } from "../config.js";
import type {
  RunRecord,
  RunOptions,
  FileContent,
  StageId,
  LogKind,
  QaReport,
  FileBuild,
  ProviderName,
  ProductSpec,
  Architecture,
  TaskPlan,
} from "../../shared/schemas.js";
import { freshStages } from "../../shared/schemas.js";
import type { FileEdit } from "../../shared/schemas.js";
import type { LLMProvider } from "../../shared/types.js";
import {
  createProviderRegistry,
  FailoverProvider,
  MissingProviderCredentialError,
  OFFLINE_PROVIDERS,
  ProviderAbortError,
} from "../providers/index.js";
export { MissingProviderCredentialError };
import { createWorkspace } from "../workspace/createWorkspace.js";
import { writeWorkspaceFile } from "../workspace/fileWriter.js";
import { runCommand } from "../workspace/commandRunner.js";
import { verificationCommandsForWorkspace } from "../workspace/verificationCommands.js";
import { findUnwiredNewFiles, unwiredCaveat } from "../workspace/unwiredFiles.js";
import { assessProtectedHostWrite } from "../workspace/protectedFiles.js";
import { assessPhantomImports } from "../workspace/phantomImports.js";
import { resolveGeneratedWrite } from "../workspace/applyEdits.js";
import { readTargetFiles } from "../workspace/targetFiles.js";
import { summarize } from "../workspace/summarizeFiles.js";
import {
  saveRun,
  putRunInMemory,
  saveRunFiles,
  saveRunCheckpoint,
  getRunCheckpoint,
  deleteRunCheckpoint,
  getRunForExecution,
} from "../storage/runsStore.js";
import type { FactoryCheckpoint } from "./checkpoint.js";
import { appendAuditEvent } from "../storage/auditLog.js";
import { buildAttribution, writeAttribution } from "../storage/attribution.js";
import {
  makeLog,
  startStage,
  finishStage,
  nowMs,
  CountingProvider,
  ModelBudgetError,
} from "./stages.js";
import { redactSecrets, redactDeep } from "../security/redact.js";
import { BudgetGatedProvider } from "../providers/paidBudget.js";
import { QuotaFailoverProvider } from "../providers/quotaFailover.js";
import {
  RunCancelledError,
  clearCancel,
  throwIfCancelled,
  isCancelRequested,
  getCancelSignal,
} from "./cancellation.js";
import { runRepairLoop } from "./repairLoop.js";
import { groundQaReport, type VerificationEvidence } from "./qaGrounding.js";
import { groundFinalReport } from "./reportGrounding.js";
import { foldTestExit, freshTestVerdict, testStatusFor } from "./testVerdict.js";
import { classifyEnvironmentFailure } from "./envFailure.js";
import { productSpecAgent } from "../agents/productSpecAgent.js";
import { architectAgent } from "../agents/architectAgent.js";
import { taskPlannerAgent } from "../agents/taskPlannerAgent.js";
import { fileBuilderAgent } from "../agents/fileBuilderAgent.js";
import { testWriterAgent } from "../agents/testWriterAgent.js";
import { qaCriticAgent } from "../agents/qaCriticAgent.js";
import { repairAgent } from "../agents/repairAgent.js";
import { finalReviewerAgent } from "../agents/finalReviewerAgent.js";
import { repoResolverAgent, ResolveError } from "../agents/repoResolverAgent.js";
import { ingestExistingRepo, IngestError } from "../workspace/ingestRepo.js";
import { analyzeExistingCodebase } from "../workspace/analyzeExistingCodebase.js";
import { composeExtendIdea, buildExistingContext } from "./composeExtendIdea.js";
import { ingestAdditionalSource } from "./ingestAdditionalSource.js";
import { buildFilesConcurrently } from "./concurrentBuild.js";
import { researchAgent } from "../agents/researchAgent.js";
import { deliverRun, planDestination } from "./deliverRun.js";
import { releaseRun, isPaperOnlyDelivery } from "./releaseRun.js";
import { deployRun } from "./deployRun.js";
import { storePublish } from "./storePublish.js";
import { githubLogin, originUrl, currentBranch, git } from "../workspace/gitOps.js";

export interface StartRunArgs {
  idea: string;
  options: RunOptions;
  config: AppConfig;
  secrets: AppSecrets;
}

/**
 * What one writeBuild call actually did.
 *
 * The invariant the owner's no-silent-no-op rule demands:
 *   candidates === written + refusals.length
 * A stage that produced files but wrote none must be LOUD, never a success
 * line quoting the model's output count.
 */
export interface WriteTally {
  /** Files the stage handed to writeBuild. */
  candidates: number;
  /** Files that genuinely reached disk. */
  written: number;
  /** Files a guard refused, each with the reason. */
  refusals: Array<{ path: string; reason: string }>;
}

/** Raised when the overall run wall-clock timeout fires. */
export class RunTimeoutError extends Error {
  constructor(limitMs: number) {
    super(`Run timed out after ${limitMs}ms (FACTORY_RUN_TIMEOUT_MS).`);
    this.name = "RunTimeoutError";
  }
}

/** Create the initial queued record. Providers are resolved at queue time. */
function createRecord(args: StartRunArgs): RunRecord {
  const { config, secrets, options } = args;
  const registry = createProviderRegistry(config, secrets);
  // Explicit demo only. Missing paid keys must NOT silently coerce to mock success.
  const demo = options.demo === true;

  // A live run needs ONE usable live provider — and the free route counts.
  // Requiring a paid key here would have made "no credit card" mean "no
  // factory", which is exactly backwards for a free-primary deck.
  if (!demo && registry.availableLive().length === 0) {
    throw new MissingProviderCredentialError(registry.missingCredentialNames());
  }

  // Reject live requests that explicitly ask for offline providers.
  if (!demo) {
    for (const name of [options.codeProvider, options.reviewProvider]) {
      if (name && OFFLINE_PROVIDERS.has(name)) {
        throw new MissingProviderCredentialError([
          `live run cannot use offline provider "${name}" — omit provider or set demo:true`,
        ]);
      }
    }
  }

  const codeProvider: ProviderName = demo
    ? "mock"
    : registry.resolveLive(
        options.codeProvider ?? config.defaultCodeProvider,
        config.defaultCodeProvider,
      ).name;
  const reviewProvider: ProviderName = demo
    ? "mock"
    : registry.resolveLive(
        options.reviewProvider ?? config.defaultReviewProvider,
        config.defaultReviewProvider,
      ).name;

  return {
    id: randomUUID(),
    // Persisted + API-served copy: redact secret-shaped content. The RAW idea is
    // still passed to the model from `args.idea` (see executeRun) so generation
    // is unaffected — only the durable/served copy is scrubbed.
    idea: redactSecrets(args.idea),
    status: "queued",
    resumable: false,
    demo,
    codeProvider,
    reviewProvider,
    currentStage: null,
    stages: freshStages(),
    logs: [],
    files: [],
    repairLoops: 0,
    providerUsage: {
      free: { calls: 0 },
      anthropic: { calls: 0 },
      openai: { calls: 0 },
      stub: { calls: 0 },
      mock: { calls: 0 },
      totalCalls: 0,
    },
    finalReport: null,
    appName: null,
    workspacePath: null,
    // Filled in at intake (extend) or at workspace creation (new) — BEFORE any
    // building — so the UI can show where the work will be saved up front.
    destination: null,
    error: null,
    attribution: null,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };
}

/** One-line, log-safe summary of where a run's output goes. */
function describeDestination(dest: {
  kind: string;
  target: string;
  branch: string | null;
}): string {
  if (dest.kind === "workspace-only") return `its workspace folder (${dest.target})`;
  if (dest.kind === "new-repo") return `a new repo ${dest.target}`;
  return `${dest.target}${dest.branch ? ` on branch ${dest.branch}` : ""}`;
}

/** Mutable helpers bound to one run. */
function controller(run: RunRecord) {
  const touch = () => {
    run.updatedAt = nowMs();
    putRunInMemory(run);
  };
  const flush = async () => {
    touch();
    await saveRun(run);
  };
  const log = (
    kind: LogKind,
    message: string,
    stage: StageId | null = run.currentStage,
  ) => {
    run.logs.push(makeLog(kind, message, stage));
    touch();
  };
  return { touch, flush, log };
}

function throwIfTimedOut(deadline: number | null, limitMs: number): void {
  if (deadline !== null && Date.now() > deadline) {
    throw new RunTimeoutError(limitMs);
  }
}

/**
 * Combine multiple AbortSignals into one that fires when the first of them
 * does, preserving that signal's `reason`. Manual implementation (rather than
 * `AbortSignal.any`, added in Node 20.3) because this project's declared
 * engine floor is `node >=20`.
 */
function combineAbortSignals(
  signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  for (const s of active) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Execute the full assembly line. Mutates `run` in place and persists at every
 * stage boundary so the UI can poll live progress.
 */
async function executeRun(
  run: RunRecord,
  args: StartRunArgs,
  restored?: FactoryCheckpoint,
): Promise<void> {
  const { config, secrets } = args;
  const { flush, log } = controller(run);
  let checkpoint: FactoryCheckpoint = restored ?? {
    schemaVersion: 1,
    runId: run.id,
    idea: args.idea,
    options: args.options,
    files: [],
    testWriterComplete: false,
    commandOutput: "",
    testsExecuted: false,
    testExit: null,
    repairLoops: 0,
    repairComplete: false,
    updatedAt: Date.now(),
  };
  const checkpointNow = async (patch: Partial<FactoryCheckpoint> = {}) => {
    checkpoint = { ...checkpoint, ...patch, updatedAt: Date.now() };
    await saveRunCheckpoint(checkpoint);
  };
  run.repairLoops = Math.max(run.repairLoops, checkpoint.repairLoops);
  const stageDone = (id: StageId) => {
    const status = run.stages.find((stage) => stage.id === id)?.status;
    return status === "completed" || status === "skipped";
  };
  const timeoutMs = args.options.timeoutMs ?? config.runTimeoutMs;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  // Bound every individual paid-provider SDK call by the SAME budget that
  // bounds the run as a whole, and by cancellation — not just the checks at
  // stage/file boundaries via throwIfTimedOut/throwIfCancelled above. Without
  // this, a single hung client.messages.create()/responses.create() await was
  // bounded only by the SDK's own default timeout, never by
  // FACTORY_RUN_TIMEOUT_MS or a cancel request. See ProviderAbortError for
  // how an abort here is kept distinct from a retryable transport error.
  const deadlineSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const callSignal = combineAbortSignals([deadlineSignal, getCancelSignal(run.id)]);
  // Route decisions land in the run log, so "why did this cost money?" is
  // answerable from the run itself and not only from the server console.
  const registry = createProviderRegistry(
    config,
    secrets,
    (kind, message) => {
      log(kind === "warn" ? "warning" : "info", message);
    },
    callSignal,
  );

  // Resolve + meter providers (budget enforced inside CountingProvider).
  // Demo journeys use mock; live journeys use resolveLive (never mock/stub).
  const rawCode = run.demo
    ? registry.get("mock")
    : registry.resolveLive(run.codeProvider, config.defaultCodeProvider);
  const rawReview = run.demo
    ? registry.get("mock")
    : registry.resolveLive(run.reviewProvider, config.defaultReviewProvider);
  // The failover chain declares itself as "free" but may serve a call from a
  // paid rescue tier, so it must be attributed by who ACTUALLY served —
  // otherwise a paid call would be booked as free and the spend would hide.
  const attribution = (p: LLMProvider): "declared" | "served" =>
    p instanceof FailoverProvider ? "served" : "declared";
  // BUDGET BYPASS FIX (2026-08-16): only the concurrent pool was budget-gated.
  // When a run's own codeProvider/reviewProvider resolved to a RAW paid
  // provider (pinned routing, or a paid default), every stage call skipped
  // canPayNow() entirely — spend was RECORDED but never CHECKED. Measured
  // result: 68 paid calls / $26.64 in 24h against configured caps of 24/day
  // and $2/day. The failover chain gates itself; raw paid providers must be
  // wrapped here, exactly like the pool.
  const gateIfPaid = (p: LLMProvider, counted: LLMProvider): LLMProvider =>
    p.name === "anthropic" || p.name === "openai"
      ? new BudgetGatedProvider(counted, p.name)
      : counted;
  // QUOTA FAILOVER (owner rule: fix, don't block). A pinned provider answering
  // "no credits remaining" used to end the slice while a funded second key sat
  // unused. Only quota refusals fail over; a real 400 still fails loudly.
  const alternates = (): LLMProvider[] =>
    run.demo
      ? []
      : registry
          .availableLive()
          .filter((n) => n !== "free")
          .map((n) => registry.get(n));
  const withFailover = (p: LLMProvider): LLMProvider =>
    run.demo
      ? p
      : new QuotaFailoverProvider(p, alternates(), (from, to, reason) =>
          log(
            "warning",
            `${from} refused on quota — continuing on ${to}. (${reason.slice(0, 120)})`,
          ),
        );
  const code: LLMProvider = withFailover(
    gateIfPaid(
      rawCode,
      new CountingProvider(rawCode, run, config.maxModelCallsPerRun, attribution(rawCode)),
    ),
  );
  const review: LLMProvider = withFailover(
    gateIfPaid(
      rawReview,
      new CountingProvider(rawReview, run, config.maxModelCallsPerRun, attribution(rawReview)),
    ),
  );
  // CRITICAL-STAGE provider (owner order 2026-08-16: fix known-weak backends
  // before they fail, don't wait). Spec, architecture, research, planning and
  // the final report are ONE call each whose quality shapes or judges the
  // whole run - the free small model demonstrably planned junk and gave up on
  // competitor research ("no conclusion within 5 steps"). These few calls
  // prefer the first configured PAID provider (budget-gated like the pool);
  // free remains the keyless fallback and the builder's bulk free-primary
  // economics are unchanged.
  // The run's OWN pinned paid provider wins (2026-08-16): picking
  // availablePaid()[0] made every run - including ones explicitly pinned to
  // OpenAI - route its spec/architecture/research/planning through Anthropic,
  // so an Anthropic credit outage failed five epics that had a funded OpenAI
  // key sitting right there. Order: the run's own paid choice, then any
  // configured paid provider, then free.
  const runPinnedPaid =
    run.codeProvider === "anthropic" || run.codeProvider === "openai"
      ? run.codeProvider
      : undefined;
  const rawCritical = run.demo
    ? registry.get("mock")
    : registry.resolveLive(
        runPinnedPaid ?? registry.availablePaid()[0] ?? run.codeProvider,
        config.defaultCodeProvider,
      );
  const criticalCounted = new CountingProvider(
    rawCritical,
    run,
    config.maxModelCallsPerRun,
    attribution(rawCritical),
  );
  const critical: LLMProvider = withFailover(gateIfPaid(rawCritical, criticalCounted));
  // Every distinct LIVE backend actually configured (free / anthropic / openai,
  // never the failover chain itself), each still budget-metered — the pool the
  // concurrent builder dispatches independent work across. Demo runs get just
  // mock, so concurrency naturally degrades to the single-provider path.
  //
  // BUDGET GATE: unlike the failover chain (whose runPaid() checks canPayNow()
  // before every paid call), a raw registry provider has no such gate built
  // in — dispatching tasks to it directly would spend past
  // FACTORY_PAID_RESCUES_PER_HOUR/_PER_DAY/FACTORY_PAID_MAX_USD_PER_DAY with
  // no one asking first. BudgetGatedProvider re-checks canPayNow() on EVERY
  // call (not just once when the pool is built), so a burst of concurrent
  // paid calls that would collectively blow the cap gets stopped mid-burst,
  // not only refused on the next dispatch.
  const liveProviderPool: LLMProvider[] = run.demo
    ? [registry.get("mock")]
    : registry.availableLive().map((name) => {
        const metered = new CountingProvider(
          registry.get(name),
          run,
          config.maxModelCallsPerRun,
          "declared",
        );
        return name === "anthropic" || name === "openai"
          ? new BudgetGatedProvider(metered, name)
          : metered;
      });

  // The live in-memory view of the workspace, restored from the private
  // checkpoint so a resumed run never needs the redacted API copy.
  const files = new Map<string, FileContent>(
    checkpoint.files.map((file) => [file.path, file]),
  );

  /**
   * Every generated file a guard refused this run, across all stages. Carried
   * into the final report so a refusal is surfaced to the owner rather than
   * living only in a log line they may never scroll back to.
   */
  const writeRefusals: Array<{ path: string; reason: string }> = [];

  /**
   * Report a write tally honestly: never announce work that was refused, and
   * make a zero-write stage LOUD rather than a quiet success line.
   */
  const reportWrites = (tally: WriteTally, stage: StageId, noun: string) => {
    const { candidates, written, refusals } = tally;
    if (candidates === 0) return;
    if (written === 0) {
      log(
        "warning",
        `NO ${noun.toUpperCase()} REACHED DISK: all ${candidates} generated file(s) were refused — ` +
          refusals.map((r) => `${r.path} (${r.reason})`).join("; "),
        stage,
      );
      return;
    }
    if (refusals.length) {
      log(
        "warning",
        `Wrote ${written} of ${candidates} ${noun} file(s); ${refusals.length} refused — ` +
          refusals.map((r) => `${r.path} (${r.reason})`).join("; "),
        stage,
      );
      return;
    }
    log("success", `Wrote ${written} ${noun} file(s).`, stage);
  };

  /**
   * Write a stage's generated files and report EXACTLY what reached disk.
   *
   * Three guards below can refuse a file (blind rewrite, protected host file,
   * undeclared dependency). Callers used to log the count of files the MODEL
   * PRODUCED, so a stage that refused every write still announced "Generated
   * N files" — the silent-overclaim defect. The tally returned here is the
   * only honest count, and it always satisfies:
   *
   *     incoming.length === written + refused
   */
  const writeBuild = async (
    workspacePath: string,
    incoming: { path: string; purpose: string; contents: string; edits?: FileEdit[] }[],
    stage: StageId,
  ): Promise<WriteTally> => {
    const refusals: Array<{ path: string; reason: string }> = [];
    let written = 0;
    // A cancel during a stage must stop further file writes, not only at stage
    // boundaries — check before touching the workspace.
    throwIfCancelled(run.id);
    throwIfTimedOut(deadline, timeoutMs);
    for (const f of incoming) {
      // Re-check per file so a cancel mid-loop stops the REMAINING writes.
      throwIfCancelled(run.id);
      // ROOT FIX: an existing file is EDITED, never regenerated from its name.
      // resolveGeneratedWrite reads the real file and applies anchored edits;
      // a blind whole-file replacement of existing source is refused outright.
      const resolved = resolveGeneratedWrite(workspacePath, f.path, {
        contents: f.contents,
        edits: f.edits ?? [],
      });
      if (resolved.contents === null) {
        const reason = resolved.reason ?? "refused";
        log("warning", `WRITE REFUSED: ${f.path} — ${reason}`, stage);
        refusals.push({ path: f.path, reason });
        continue;
      }
      let finalContents = resolved.contents;
      throwIfTimedOut(deadline, timeoutMs);
      // PROTECTED HOST FILES (run a8a9c84a): the test-writer replaced the
      // ingested repo's 10,998-byte package.json with a 192-byte stub and the
      // repair loop then regenerated the lockfile to match — collapsing the
      // host's ~1,900-test suite into the run's own two tests while npm test
      // read green. Destructive writes to tracked manifests/lockfiles/root
      // tool configs (and hijack-by-new-variant configs) are refused LOUDLY;
      // additive manifest edits still pass. Inert for new-app workspaces.
      const verdict = assessProtectedHostWrite(workspacePath, f.path, finalContents);
      if (verdict.refused) {
        const reason = `protected host file — ${verdict.reason}`;
        log(
          "warning",
          `PROTECTED HOST FILE: refused generated write of ${f.path} — ${verdict.reason}`,
          stage,
        );
        refusals.push({ path: f.path, reason });
        continue;
      }
      // PHANTOM DEPENDENCIES: a generated file may only import packages the
      // repo declares. Two SermonSmith slices in a row wrote
      // `react-router-dom` into a repo that depends on react-router v8, and
      // the failure only surfaced as "Failed to resolve import" deep in the
      // test run, after paid repair loops. Checked against the manifests as
      // they are ON DISK, so a build that adds the dependency first passes.
      // FIX, DON'T BLOCK (owner rule 2026-08-16). A specifier with a known
      // right answer is corrected in place; only an import with no declared
      // counterpart is still refused, because the build must declare it.
      const phantom = assessPhantomImports(workspacePath, f.path, finalContents);
      if (phantom.corrections?.length) {
        log(
          "info",
          `Import corrected in ${f.path}: ${phantom.corrections.join(", ")} (matched the repo's declared packages).`,
          stage,
        );
      }
      if (phantom.corrected) finalContents = phantom.corrected;
      if (phantom.refused) {
        const reason = `undeclared dependency — ${phantom.reason}`;
        log(
          "warning",
          `UNDECLARED DEPENDENCY in ${f.path} — ${phantom.reason}`,
          stage,
        );
        refusals.push({ path: f.path, reason });
        continue;
      }
      const res = await writeWorkspaceFile(workspacePath, f.path, finalContents);
      // And again after the awaited write, before we record/log/persist it.
      throwIfCancelled(run.id);
      const status: FileContent["status"] = res.existed ? "modified" : "generated";
      written++;
      files.set(res.path, {
        path: res.path,
        purpose: f.purpose,
        language: res.language,
        size: res.size,
        status,
        // `finalContents`, NOT the model's `f.contents`. The two diverge
        // whenever anchored edits were applied to the real file or a phantom
        // import was corrected in place. Storing the model's copy left QA
        // reviewing text that is not on disk, and served the same stale text
        // to the UI and the persisted run record.
        contents: finalContents,
      });
      log(
        "file_write",
        `${status === "modified" ? "Updated" : "Wrote"} ${res.path} (${res.size} B)`,
        stage,
      );
    }
    run.files = summarize([...files.values()]);
    saveRunFiles(run.id, [...files.values()]);
    await checkpointNow({ files: [...files.values()] });
    writeRefusals.push(...refusals);
    return { candidates: incoming.length, written, refusals };
  };

  const persistAttribution = async (
    testResult: "passing" | "failing" | "skipped" | "unknown" | "not_run",
    auditSeq: number | null,
  ) => {
    const attr = buildAttribution(run, {
      allowUntrustedScripts: config.allowUntrustedScripts,
      testResult,
      auditSeq,
    });
    const path = await writeAttribution(attr);
    run.attribution = attr;
    log("info", `Attribution written: ${path}`);
    await appendAuditEvent({
      type: "attribution.written",
      runId: run.id,
      detail: path,
      meta: { testResult },
    });
  };

  /** inPlace runs restore the owner's branch on EVERY exit path (see finally). */
  let inPlaceRestore: { path: string; branch: string } | null = null;
  try {
    const isResume = Boolean(restored);
    run.status = "running";
    run.resumable = false;
    run.error = null;
    await checkpointNow();
    await appendAuditEvent({
      type: isResume ? "run.resumed" : "run.started",
      runId: run.id,
    });
    log(
      "info",
      isResume
        ? "Factory run resumed from its last durable checkpoint."
        : `Factory run started in ${run.demo ? "demo (mock)" : "live"} mode.`,
    );
    if (run.demo && !isResume)
      log(
        "warning",
        "Demo mode: zero paid credits; output is the offline mock provider.",
      );
    await flush();

    /* Stage 1 — Intake */
    /* Stage 1 — Intake (greenfield, or extend-mode ingestion) */
    // Options come from the CHECKPOINT (canonical on resume, identical to
    // args.options on a fresh run) so a resumed extend run keeps its resolved
    // target/goals instead of replaying the resolver.
    const extendMode = checkpoint.options.mode === "extend";
    let repoAnalysis: Awaited<ReturnType<typeof analyzeExistingCodebase>> | null = null;
    let ingestedWorkspacePath: string | null = null;
    let goalsForSpec: string[] = [];
    let additionalSourceContexts: Awaited<ReturnType<typeof ingestAdditionalSource>>[] =
      [];
    if (!stageDone("intake")) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "intake");
      if (extendMode) {
        log("info", `Intake (extend mode): "${run.idea}"`);
        let repoSource = checkpoint.options.repoSource ?? null;
        let additionalRepoSources = checkpoint.options.additionalRepoSources ?? [];
        if (!repoSource) {
          // Direct-prompt mode: nothing pre-resolved — figure out WHICH program(s)
          // and WHAT to do from the free text itself (URL / project name /
          // multiple programs to combine / instructions all mixed together),
          // using real web + local-filesystem tools.
          log(
            "model_call",
            `Repo Resolver agent (${code.name}) — resolving target(s) from free text…`,
          );
          let resolved;
          try {
            resolved = await repoResolverAgent({ provider: code }, checkpoint.idea);
          } catch (err) {
            if (err instanceof ResolveError) {
              throw new IngestError(err.message);
            }
            throw err;
          }
          for (const line of resolved.transcript) log("info", `resolver: ${line}`);
          repoSource = resolved.repoSource;
          additionalRepoSources = resolved.additionalSources;
          goalsForSpec = resolved.goals;
          log(
            "success",
            `Resolved target: ${repoSource.type} "${repoSource.location}"` +
              (resolved.additionalSources.length
                ? ` + ${resolved.additionalSources.length} additional source(s) to combine/glean from`
                : "") +
              ` — ${resolved.goals.length} goal(s).`,
          );
        } else {
          goalsForSpec = checkpoint.options.goals?.length
            ? checkpoint.options.goals
            : [checkpoint.idea];
        }
        log(
          "info",
          `Ingesting existing repo (${repoSource.type}): ${repoSource.location}`,
        );
        const ingested = await ingestExistingRepo(
          config.workspaceRoot,
          repoSource,
          run.id,
        );
        for (const line of ingested.log) log("info", line);
        ingestedWorkspacePath = ingested.path;
        if (ingested.inPlace && ingested.previousBranch) {
          inPlaceRestore = { path: ingested.path, branch: ingested.previousBranch };
        }
        // Record the workspace NOW (not at builder time) so a crash between
        // intake and builder still resumes into the SAME ingested copy.
        run.workspacePath = ingested.path;
        await appendAuditEvent({
          type: "workspace.created",
          runId: run.id,
          detail: ingested.path,
        });
        log(
          "success",
          `Ingested into ${ingested.inPlace ? "the REAL repo (explicit inPlace opt-in)" : "an isolated workspace"}: ${ingested.path}${ingested.branch ? ` (branch ${ingested.branch})` : ""}.`,
        );
        // The attached repo IS the destination (owner order 2026-08-13).
        run.destination = planDestination({
          mode: "extend",
          options: checkpoint.options,
          originUrl: ingested.originUrl,
          branch: ingested.branch,
        });
        log("info", `Work will be saved to: ${describeDestination(run.destination)}`);
        repoAnalysis = await analyzeExistingCodebase(ingested.path);
        log("info", `Detected stack: ${repoAnalysis.stackSummary}`);

        // Multi-program combination: every ADDITIONAL reference — a git repo
        // (owned or third-party), a plain local folder, or just a URL that
        // isn't clonable at all — is ingested read-only and understood, never
        // silently dropped in favor of just the primary target.
        if (additionalRepoSources.length) {
          log(
            "info",
            `Ingesting ${additionalRepoSources.length} additional source(s) to combine/glean from (read-only)…`,
          );
          additionalSourceContexts = await Promise.all(
            additionalRepoSources.map((src, i) =>
              ingestAdditionalSource(config, src, run.id, i),
            ),
          );
          for (const ctx of additionalSourceContexts) {
            log("success", `Additional source ready: "${ctx.label}".`);
          }
        }
        // Persist the resolver's decisions so a resumed run never replays the
        // resolver model call or loses the goal list.
        await checkpointNow({
          options: {
            ...checkpoint.options,
            repoSource,
            additionalRepoSources,
            goals: goalsForSpec,
          },
        });
      } else {
        log("info", `Intake: "${run.idea}"`);
      }
      finishStage(run, "intake", "completed");
      await flush();
    } else if (extendMode) {
      // Resumed past intake: the ingested workspace lives on the run record and
      // the resolver's decisions are in the checkpoint — re-derive the local
      // analysis (pure filesystem work, zero model calls) instead of replaying
      // ingestion.
      ingestedWorkspacePath = run.workspacePath;
      goalsForSpec = checkpoint.options.goals?.length
        ? checkpoint.options.goals
        : [checkpoint.idea];
      if (ingestedWorkspacePath) {
        repoAnalysis = await analyzeExistingCodebase(ingestedWorkspacePath);
      }
      // Additional read-only sources only matter while spec/build are still
      // being produced; re-ingest them (local copy/clone, no model calls).
      if (!checkpoint.build && checkpoint.options.additionalRepoSources?.length) {
        additionalSourceContexts = await Promise.all(
          checkpoint.options.additionalRepoSources.map((src, i) =>
            ingestAdditionalSource(config, src, run.id, i),
          ),
        );
      }
      // A run that was STARTED before delivery existed (or simply crashed after
      // intake) has no destination, and its workspace may have had `origin`
      // stripped by the old ingest behaviour. Without this, such a run would
      // finish and quietly leave the work in a scratch folder — the exact
      // outcome the owner asked us to stop. Re-derive both from the repo the
      // owner attached, which the checkpoint still records.
      if (!run.destination && ingestedWorkspacePath) {
        const attached = checkpoint.options.repoSource?.location ?? null;
        const existing = await originUrl(ingestedWorkspacePath);
        if (!existing && attached) {
          const added = await git(
            ["remote", "add", "origin", attached],
            ingestedWorkspacePath,
            15_000,
          );
          log(
            added.code === 0 ? "info" : "warning",
            added.code === 0
              ? `Restored origin -> ${attached} so this run's branch can be saved back to it.`
              : `Could not restore origin for delivery: ${added.stderr.slice(0, 200)}`,
          );
        }
        run.destination = planDestination({
          mode: "extend",
          options: checkpoint.options,
          originUrl: existing ?? attached,
          branch: await currentBranch(ingestedWorkspacePath),
        });
        log("info", `Work will be saved to: ${describeDestination(run.destination)}`);
      }
    }

    /* Stage 2 — Product Spec */
    let spec: ProductSpec | undefined = checkpoint.spec;
    if (!spec) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "product_spec");
      log("model_call", `Product Spec agent (${critical.name})…`);
      // Give the model the RAW idea (checkpoint.idea), not the redacted
      // persisted copy. Extend mode composes a richer idea string (existing app
      // name + stack + goals) so productSpecAgent stays completely unchanged.
      const ideaForSpec =
        extendMode && repoAnalysis
          ? composeExtendIdea(
              repoAnalysis,
              goalsForSpec.length ? goalsForSpec : [checkpoint.idea],
              additionalSourceContexts,
            )
          : checkpoint.idea;
      spec = await productSpecAgent({ provider: critical }, ideaForSpec);
      if (extendMode && repoAnalysis) {
        // Authoritative override: the existing app's real name is known from
        // disk, not from what the model decided to call it — never trust the
        // model here.
        spec.appName = repoAnalysis.appNameGuess;
      }
      // Persist the provider output before any later mutation: a crash after
      // this point resumes without paying for the same call again.
      await checkpointNow({ spec });
    }
    if (!stageDone("product_spec")) {
      // appName is model-controlled and is served by /api/runs + /:runId + logs;
      // redact the persisted/served copy (logs already go through makeLog).
      run.appName = redactSecrets(spec.appName);
      log(
        "success",
        `Spec ready: ${spec.appName} — ${spec.coreFeatures.length} core features.`,
      );
      finishStage(run, "product_spec", "completed");
      await flush();
    }

    /* Stage 3 — Architect (+ real keyless research) */
    let arch: Architecture | undefined = checkpoint.architecture;
    if (!arch) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "architect");
      log("model_call", `Architect agent (${critical.name})…`);
      arch = await architectAgent({ provider: critical }, spec);
      await checkpointNow({ architecture: arch });
    }
    // Real research — "if there's a tool out there that can help build this,
    // find it and use it" — genuine keyless web search + fetch, not a
    // decorative aside. Runs after architecture (so it knows what's being
    // built) and before the plan commits to an approach. Skipped for demo
    // (offline by definition) and when explicitly disabled (tests; see
    // vitest.config.ts) — everywhere else it's on by default. Checkpointed so
    // a resume never replays it.
    let research: Awaited<ReturnType<typeof researchAgent>> | undefined =
      checkpoint.research;
    if (!stageDone("architect")) {
      log(
        "success",
        `Architecture set${arch.risks.length ? ` — ${arch.risks.length} risk(s) noted.` : "."}`,
      );
      if (!run.demo && config.enableResearch) {
        log(
          "model_call",
          `Research agent (${critical.name}) — searching for tools/APIs that could help…`,
        );
        research = await researchAgent({ provider: critical }, spec, arch, {
          competitive: true,
        });
        await checkpointNow({ research });
        log(
          research.recommendations.length ? "success" : "info",
          research.recommendations.length
            ? `Research: ${research.recommendations.length} candidate(s) — ${research.recommendations.map((r) => r.name).join(", ")}.`
            : `Research: nothing external recommended — ${research.summary}`,
        );
      } else {
        log("info", "Research skipped (demo mode or FACTORY_RESEARCH_ENABLED=0).");
      }
      finishStage(run, "architect", "completed");
      await flush();
    }

    /* Stage 4 — Task Planner */
    let plan: TaskPlan | undefined = checkpoint.plan;
    if (!plan) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "task_planner");
      log("model_call", `Task Planner agent (${critical.name})…`);
      // Research findings are folded into the architecture text fed to the
      // planner — taskPlannerAgent itself stays completely unchanged, same
      // trick as composeExtendIdea uses for the spec agent.
      const archForPlanning =
        research && research.recommendations.length
          ? {
              ...arch,
              overview: `${arch.overview}\n\nExternal tools/APIs to use for this build: ${research.recommendations
                .map((r) => `${r.name} (${r.why})`)
                .join("; ")}`,
            }
          : arch;
      plan = await taskPlannerAgent({ provider: critical }, spec, archForPlanning);
      await checkpointNow({ plan });
    }
    if (!stageDone("task_planner")) {
      log("success", `Plan ready: ${plan.tasks.length} tasks.`);
      finishStage(run, "task_planner", "completed");
      await flush();
    }

    /* Stage 5 + 6 — Builder (generate + write files) */
    // Extend mode already recorded the ingested workspace during intake; a
    // fresh "new app" run allocates one now, exactly as before.
    let workspacePath = run.workspacePath;
    if (!workspacePath) {
      // The owner's chosen repo name wins over whatever the model called the
      // app: "If it is a new app altogether, it should ask me what to name the
      // app/repo, then create it" — so the folder, the repo and the name the
      // owner typed are all the same thing.
      const newRepo = checkpoint.options.newRepo;
      const created = await createWorkspace(
        config.workspaceRoot,
        newRepo?.name ?? spec.appName,
        run.id,
      );
      workspacePath = created.path;
      run.workspacePath = workspacePath;
      if (!run.destination) {
        run.destination = planDestination({
          mode: "new",
          options: checkpoint.options,
          githubOwner: newRepo
            ? (newRepo.owner ?? (await githubLogin(process.cwd())))
            : null,
        });
        log("info", `Work will be saved to: ${describeDestination(run.destination)}`);
      }
      await appendAuditEvent({
        type: "workspace.created",
        runId: run.id,
        detail: workspacePath,
      });
      log("info", `Workspace: ${workspacePath}`);
      await flush();
    }
    let build: FileBuild | undefined = checkpoint.build;
    if (!build) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "builder");
      // READ BEFORE WRITE: hand the builder the REAL contents of the files this
      // plan names, so an existing file is edited from its actual text instead
      // of reconstructed from its filename.
      const baseContext =
        extendMode && repoAnalysis ? buildExistingContext(repoAnalysis) : undefined;
      const existingContext =
        baseContext && workspacePath
          ? {
              ...baseContext,
              targetFiles: readTargetFiles(
                workspacePath,
                plan,
                checkpoint.idea ?? "",
                repoAnalysis?.fileTree ?? [],
              ),
            }
          : baseContext;
      if (existingContext?.targetFiles?.length) {
        log(
          "info",
          `Read ${existingContext.targetFiles.length} existing file(s) the plan targets — edits will quote real code.`,
        );
      }
      if (extendMode) {
        // Only extend-mode goes through the concurrent dispatcher: the task
        // planner's categories are genuinely independent build units here, and
        // there is a real multi-backend pool to spread them across. Greenfield
        // "new app" runs keep the exact original single-call path below,
        // unchanged, so the free->paid failover chain's resilience on the
        // builder call is never lost.
        log(
          "model_call",
          `File Builder agent — dispatching ${plan.tasks.length} task(s) across up to ${liveProviderPool.length} live backend(s)…`,
        );
        const concurrentResult = await buildFilesConcurrently(
          code,
          liveProviderPool,
          spec,
          arch,
          plan,
          existingContext,
          research,
          additionalSourceContexts.length ? additionalSourceContexts : undefined,
        );
        if (concurrentResult.usedConcurrency) {
          log(
            "success",
            `Concurrent dispatch: ${Object.entries(concurrentResult.tasksByProvider)
              .map(([name, n]) => `${name}=${n}`)
              .join(", ")}.`,
          );
        }
        // An incomplete build FAILS LOUDLY with every missing category named.
        // Run f0077040: 12 of 13 categories silently produced nothing and the
        // "build" was one README that QA then honestly passed. A build that
        // cannot fulfill the plan is a failed build, not a small success.
        for (const f of concurrentResult.failures) {
          log("warning", `Build category FAILED on every provider: ${f.id} — ${f.reason}`);
        }
        for (const id of concurrentResult.empties) {
          log("warning", `Build category returned no files: ${id}`);
        }
        const missing =
          concurrentResult.failures.length + concurrentResult.empties.length;
        if (missing > 0) {
          throw new Error(
            `Build incomplete: ${missing} categor${missing === 1 ? "y" : "ies"} produced no files (` +
              [
                ...concurrentResult.failures.map((f) => f.id),
                ...concurrentResult.empties,
              ].join(", ") +
              `). The run fails honestly instead of delivering a fraction of the plan.`,
          );
        }
        build = concurrentResult.build;
      } else {
        log("model_call", `File Builder agent (${code.name})…`);
        build = await fileBuilderAgent(
          { provider: code },
          spec,
          arch,
          plan,
          undefined,
          research,
        );
      }
      await checkpointNow({ build });
    }
    // PAID WORK MUST REACH DISK (run b74e5955, 2026-08-16). A cancel landed
    // between the builder's answers being checkpointed and being WRITTEN. On
    // resume the builder stage already read "done", so writeBuild was skipped
    // entirely: ~$18 of generated UI files vanished, and the run sailed on to
    // deliver a PR containing only the test-writer's files. Stage bookkeeping
    // is not evidence that files exist — the run's file map is. Any build file
    // missing from it gets written, whatever the stage says.
    const missingFromWorkspace = build.files.filter((f) => !files.has(f.path));
    if (!stageDone("builder") || missingFromWorkspace.length > 0) {
      if (stageDone("builder") && missingFromWorkspace.length > 0) {
        log(
          "warning",
          `Builder stage was marked done but ${missingFromWorkspace.length} of ${build.files.length} generated file(s) were never written — writing them now.`,
        );
      }
      const builderTally = await writeBuild(
        workspacePath,
        stageDone("builder") ? missingFromWorkspace : build.files,
        "builder",
      );
      // HONEST COUNT. This used to read `Generated ${build.files.length}
      // files.` — the number the MODEL produced, which counted every file the
      // guards above refused. A build whose writes were all refused reported
      // full success.
      reportWrites(builderTally, "builder", "builder");
      finishStage(run, "builder", "completed");
      await flush();
    }

    /* Stage 7 — Test Writer (+ optional install/test commands) */
    let commandOutput = checkpoint.commandOutput;
    let verification: VerificationEvidence = checkpoint.verification ?? {
      executed: [],
    };
    let testsExecuted = checkpoint.testsExecuted;
    let testExit = checkpoint.testExit;

    /**
     * Execute the current workspace verification plan and replace all prior
     * command evidence. Repairs may change source files and dependencies, so
     * reusing pre-repair output would let QA judge a build that no longer
     * exists on disk.
     */
    const verifyWorkspace = async (): Promise<void> => {
      commandOutput = "";
      verification = { executed: [] };
      testsExecuted = false;
      testExit = null;
      // Distinct from `testExit === null`: a timeout-killed suite legitimately
      // reports a null exit, so null cannot double as "nothing recorded yet".
      let verdict = freshTestVerdict();
      const verificationCommands = verificationCommandsForWorkspace(workspacePath);
      if (!verificationCommands.length) {
        log(
          "warning",
          "No supported project manifest detected; command verification skipped.",
        );
      }
      for (const cmd of verificationCommands) {
        throwIfCancelled(run.id);
        throwIfTimedOut(deadline, timeoutMs);
        const res = await runCommand(
          { bin: cmd.bin, args: cmd.args, cwd: workspacePath },
          {
            workspaceRoot: config.workspaceRoot,
            // Real execution by default; hermetic tests disable it via config.
            allowScriptExecution: config.allowUntrustedScripts,
            // Force-kill an in-flight child if the run is cancelled mid-command.
            shouldCancel: () => isCancelRequested(run.id),
            // REAL suites need real time. The runner's 120s default silently
            // guaranteed failure for any mature repository: GrantFlow's full
            // `npm test` (lint + typecheck + build + unit) takes ~20 minutes
            // in its own CI, so run d687f5fd's verification could NEVER have
            // passed regardless of code quality — the timeout kill then left
            // a Windows zombie grandchild holding the pipes for 19 more
            // minutes. Installs get 15 minutes; test commands get 45.
            timeoutMs: cmd.isTest ? 45 * 60_000 : 15 * 60_000,
          },
        );
        log(
          "command_run",
          res.executed
            ? `Ran: ${res.command} (exit ${res.exitCode})`
            : (res.reason ?? res.command),
        );
        if (res.executed) {
          commandOutput += `\n$ ${res.command}\n${res.stdout}\n${res.stderr}`;
          verification.executed.push({
            command: res.command,
            exitCode: res.exitCode,
            outputTail: `${res.stdout}\n${res.stderr}`,
          });
          if (cmd.isTest) {
            testsExecuted = true;
            // A RED TEST SIGNAL IS STICKY. The old condition was
            //   `res.exitCode !== 0 || testExit === null`
            // which used `testExit === null` to mean "no result yet" — but a
            // test suite KILLED by the 45-minute timeout also closes with
            // exitCode `null` (SIGKILL, executed: true). So a timed-out suite
            // set testExit = null, and the very next passing test command
            // matched `testExit === null` and overwrote it with 0 — turning a
            // killed suite into testStatus "passing".
            //
            // Track "have we recorded any test result yet" separately from the
            // exit value, and never let a clean 0 replace a non-zero-or-null
            // result that was already observed.
            verdict = foldTestExit(verdict, res.exitCode);
            testExit = verdict.testExit;
          }
        }
      }
      await checkpointNow({
        commandOutput,
        verification,
        testsExecuted,
        testExit,
      });
    };
    if (!checkpoint.testWriterComplete) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "test_writer");
      let testPlan = checkpoint.testPlan;
      if (!testPlan) {
        log("model_call", `Test Writer agent (${review.name})…`);
        testPlan = await testWriterAgent({ provider: review }, spec, build);
        await checkpointNow({ testPlan });
      }
      if (testPlan.files.length) {
        const testTally = await writeBuild(workspacePath, testPlan.files, "test_writer");
        reportWrites(testTally, "test_writer", "test");
      }

      // Verify the files written by the test writer. The same helper is used
      // after every repair so QA always receives fresh executable evidence.
      await verifyWorkspace();
      await checkpointNow({ testWriterComplete: true });
    }
    if (!stageDone("test_writer")) {
      finishStage(run, "test_writer", "completed");
      await flush();
    }

    const fullBuild = (): FileBuild => ({
      files: [...files.values()].map((file) => ({
        path: file.path,
        purpose: file.purpose,
        contents: file.contents,
        edits: [],
      })),
    });

    /* Stage 8 — QA Critic */
    let qa: QaReport | undefined = checkpoint.qa;
    if (!qa) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "qa_critic");
      log("model_call", `QA Critic agent (${review.name})…`);
      qa = groundQaReport(
        await qaCriticAgent({ provider: review }, fullBuild(), commandOutput),
        verification,
      );
      await checkpointNow({ qa });
    }
    if (!stageDone("qa_critic")) {
      log(qa.passed ? "success" : "warning", `QA: ${qa.summary}`);
      finishStage(run, "qa_critic", "completed");
      await flush();
    }

    /* Stage 9 — Repair Loop (bounded) */
    if (!checkpoint.repairComplete) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "repair");
      const maxLoops = args.options.maxRepairLoops ?? config.maxRepairLoops;
      // A repair output is checkpointed after its paid call and remains pending
      // until QA verifies the applied files. Complete that already-counted loop
      // before deciding whether another loop slot is available.
      if (checkpoint.pendingRepair) {
        const pending = checkpoint.pendingRepair;
        if (pending.files.length) {
          const repairTally = await writeBuild(workspacePath, pending.files, "repair");
          reportWrites(repairTally, "repair", "repair");
        }
        log("info", pending.notes || "Applied checkpointed repair.", "repair");
        log("info", "Re-running executable verification after repair.", "repair");
        await verifyWorkspace();
        log("model_call", `Re-running QA Critic (${review.name})…`, "repair");
        qa = groundQaReport(
          await qaCriticAgent({ provider: review }, fullBuild(), commandOutput),
          verification,
        );
        await checkpointNow({ qa, pendingRepair: undefined });
        log(qa.passed ? "success" : "warning", `QA: ${qa.summary}`, "repair");
      }
      const remainingLoops = Math.max(0, maxLoops - run.repairLoops);
      // ENVIRONMENT GATE. The repair loop's only tool is writing project
      // files; an environment-class failure (missing native binding, ABI
      // mismatch, missing binary) cannot be fixed that way, so looping burns
      // paid provider calls patching innocent files and hands the QA critic a
      // failure it then misdiagnoses (run d687f5fd: three loops, ~$2.60, and
      // a final review blaming the Node version for a skipped-install-scripts
      // binding). Classification is deterministic signature matching over the
      // EXECUTED commands' real output — never model judgment.
      const envFailure = qa.passed ? null : classifyEnvironmentFailure(verification);
      if (qa.passed) {
        log("success", "No high-severity issues — repair loop skipped.");
        finishStage(run, "repair", "skipped");
      } else if (envFailure) {
        log(
          "warning",
          `Environment failure (${envFailure.signature}) in \`${envFailure.command}\` — ` +
            `file repairs cannot fix this, so the repair loop is skipped. ${envFailure.remedy}`,
          "repair",
        );
        qa = {
          ...qa,
          summary:
            `[environment: ${envFailure.signature} — a runner/environment condition, ` +
            `not a defect in the generated files; ${envFailure.remedy}] ` +
            qa.summary,
        };
        finishStage(run, "repair", "skipped");
      } else {
        const loopResult = await runRepairLoop({
          maxLoops: remainingLoops,
          initialQa: qa,
          onLoop: async () => {
            run.repairLoops += 1;
            await checkpointNow({ repairLoops: run.repairLoops });
            log(
              "warning",
              `Repair loop ${run.repairLoops}/${maxLoops} — patching files…`,
              "repair",
            );
          },
          repair: async (report) => {
            throwIfTimedOut(deadline, timeoutMs);
            let fix = checkpoint.pendingRepair;
            if (!fix) {
              log("model_call", `Repair agent (${code.name})…`, "repair");
              fix = await repairAgent(
                { provider: code },
                report,
                fullBuild(),
                commandOutput,
              );
              // Persist before writing so a crash cannot replay the provider call.
              await checkpointNow({ pendingRepair: fix });
            }
            let repairWrote = 0;
            if (fix.files.length) {
              const fixTally = await writeBuild(workspacePath, fix.files, "repair");
              reportWrites(fixTally, "repair", "repair");
              repairWrote = fixTally.written;
            }
            // "Applied repairs" is only true if something actually changed on
            // disk. A repair loop whose every write was refused otherwise
            // re-ran QA against untouched code and reported progress it had
            // not made.
            log(
              "info",
              repairWrote > 0
                ? fix.notes || "Applied repairs."
                : `NO REPAIR APPLIED — nothing reached disk${fix.notes ? ` (model notes: ${fix.notes})` : ""}.`,
              "repair",
            );
          },
          verify: verifyWorkspace,
          reverify: async () => {
            throwIfTimedOut(deadline, timeoutMs);
            log("model_call", `Re-running QA Critic (${review.name})…`, "repair");
            const next = groundQaReport(
              await qaCriticAgent({ provider: review }, fullBuild(), commandOutput),
              verification,
            );
            await checkpointNow({ qa: next, pendingRepair: undefined });
            log(next.passed ? "success" : "warning", `QA: ${next.summary}`, "repair");
            return next;
          },
        });
        qa = loopResult.finalQa;
        finishStage(run, "repair", qa.passed ? "completed" : "failed");
        if (!qa.passed) {
          log(
            "warning",
            `Reached max repair loops (${maxLoops}); residual issues remain.`,
            "repair",
          );
        }
      }
      await checkpointNow({ qa, repairComplete: true });
      await flush();
    }

    /* Stage — Final Review */
    // "passing" may ONLY be claimed when a test command actually executed and
    // exited 0. The old fallback promoted a bare model verdict to "passing"
    // with zero tests run — the fabricated-pass defect (run c72fdb26 claimed
    // 278/278 with no repo clone). No execution = "unknown", always.
    const testStatus = testStatusFor(testsExecuted, testExit);
    let report = checkpoint.finalReport;
    if (!report) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "final_review");
      log("model_call", `Final Reviewer agent (${critical.name})…`);
      report = await finalReviewerAgent({ provider: critical }, spec, qa, {
        repairLoops: run.repairLoops,
        workspacePath,
        providerUsage: run.providerUsage,
        testStatus,
        // The reviewer used to see only the spec and the QA report, so its
        // prose could assert "all tests pass" beside a stamped
        // testStatus:"failing". Give it the executed evidence and the real
        // file list it is supposed to be summarizing.
        verification,
        writtenFiles: [...files.keys()],
      });
      // ...and then ENFORCE it. An instruction in a prompt is not a guarantee:
      // the same grounding rule QA verdicts follow is applied to the report's
      // prose deterministically.
      report = groundFinalReport({
        report,
        evidence: verification,
        testStatus,
        writtenFiles: [...files.keys()],
        refusals: writeRefusals,
      });
      // SCAFFOLDING HONESTY (extend runs). Three consecutive GrantFlow
      // deliveries generated pages/modules that NOTHING pre-existing imports —
      // features on paper, unreachable in the product — and each read as
      // delivered work until a human traced imports by hand. The trace now
      // runs mechanically: generated source files with no pre-existing
      // referrer are named in the caveats, so an unwired delivery can never
      // present itself as wired. Purely additive — no verdict changes, no
      // file is blocked from delivery.
      try {
        const unwired = findUnwiredNewFiles(workspacePath, [...files.keys()]);
        const caveat = unwiredCaveat(unwired);
        if (caveat) {
          report = { ...report, caveats: [...report.caveats, caveat] };
          log("warning", caveat, "final_review");
        }
      } catch (err) {
        log(
          "warning",
          `Unwired-file scan failed (non-fatal): ${String((err as Error)?.message ?? err)}`,
          "final_review",
        );
      }
      await checkpointNow({ finalReport: report });
    }
    throwIfCancelled(run.id);
    throwIfTimedOut(deadline, timeoutMs);
    run.finalReport = redactDeep(report);
    finishStage(run, "final_review", "completed");

    /* Delivery — save the work where the owner said to save it. */
    // Runs only for a build that actually got here: a cancelled or failed run
    // never pushes. Delivery NEVER throws (see deliverRun), so a rejected push
    // downgrades the destination to "failed" with the exact git/gh error and
    // leaves the completed run completed — the code is built either way, and
    // claiming otherwise would be a lie in both directions.
    if (run.destination) {
      log("info", `Saving the work to ${describeDestination(run.destination)}…`);
      const delivered = await deliverRun({
        destination: run.destination,
        workspacePath,
        filePaths: [...files.keys()],
        runId: run.id,
        appName: run.appName,
        options: checkpoint.options,
      });
      run.destination = {
        ...delivered,
        detail: delivered.detail == null ? null : redactSecrets(delivered.detail),
      };
      log(
        delivered.status === "delivered"
          ? "success"
          : delivered.status === "failed"
            ? "warning"
            : "info",
        `Destination (${delivered.status}): ${run.destination.detail ?? delivered.target}`,
      );
      await appendAuditEvent({
        type: `run.delivery.${delivered.status}`,
        runId: run.id,
        detail: delivered.target,
      });

      /* Release — finish the job (owner order 2026-08-15): an extend run that
       * EARNED it goes to main, and main is what production deploys. The gate
       * is earned evidence only — grounded QA green, tests executed and
       * passing, and the HOST repo's own CI checks green on the PR (see
       * releaseRun.ts). Anything less leaves the branch + an open PR with the
       * reason recorded. FACTORY_RELEASE_TO_MAIN=0 opts out. */
      if (
        delivered.status === "delivered" &&
        delivered.kind === "existing-repo" &&
        delivered.branch &&
        checkpoint.options.demo !== true &&
        process.env.FACTORY_RELEASE_TO_MAIN !== "0"
      ) {
        log(
          "info",
          "Release: opening the PR against main and waiting on the repo's checks…",
        );
        const paperOnly = isPaperOnlyDelivery([...files.keys()]);
        if (paperOnly) {
          log(
            "warning",
            "Delivery is paper-only (docs/tests/schema, no wired product change) — it will not auto-merge.",
          );
        }
        const release = await releaseRun({
          paperOnly,
          repoUrl: delivered.target,
          branch: delivered.branch,
          runId: run.id,
          appName: run.appName,
          qaPassed: qa.passed,
          testStatus,
          caveats: report.caveats ?? [],
        });
        log(
          release.released ? "success" : "warning",
          release.released
            ? `Released: merged to main (${release.mergedSha?.slice(0, 10) ?? "sha unknown"}). Production deploys from main pick this up.`
            : `Not released to main: ${release.reason}${release.prUrl ? ` — PR left open: ${release.prUrl}` : ""}`,
        );
        run.destination = {
          ...run.destination,
          detail: redactSecrets(
            `${run.destination.detail ?? ""} ${
              release.released
                ? `Released: merged to main (${release.mergedSha ?? "sha unknown"}).`
                : `Not auto-released: ${release.reason}.`
            }${release.prUrl ? ` PR: ${release.prUrl}` : ""}`.trim(),
          ),
        };
        run.release = {
          released: release.released,
          prUrl: release.prUrl,
          mergedSha: release.mergedSha,
          reason: redactSecrets(release.reason),
        };
        await appendAuditEvent({
          type: release.released ? "run.release.merged" : "run.release.held",
          runId: run.id,
          detail: release.prUrl ?? delivered.target,
        });
      }

      /* Deploy — the from-scratch twin of Release (owner order 2026-08-15):
       * a NEW program finishes on a real host (Railway for servers, Vercel
       * for static/frontend), and "live" is claimed only after this process
       * observes the URL answering. Same evidence gate; deploy failures
       * never fail the run. FACTORY_DEPLOY_NEW_APPS=0 opts out. */
      if (
        delivered.status === "delivered" &&
        delivered.kind === "new-repo" &&
        checkpoint.options.demo !== true &&
        process.env.FACTORY_DEPLOY_NEW_APPS !== "0"
      ) {
        const gate = qa.passed && testStatus === "passing";
        if (!gate) {
          log(
            "warning",
            `Not deploying to a host: ${
              qa.passed ? "tests did not execute green" : "grounded QA did not pass"
            } — an unverified build never goes live.`,
          );
        } else {
          log("info", "Deploy: putting the new app on a host (Railway/Vercel)…");
          const dep = await deployRun({
            workspacePath,
            appName: run.appName,
            runId: run.id,
          });
          log(
            dep.deployed && dep.verified ? "success" : "warning",
            dep.deployed && dep.verified
              ? `Deployed and live: ${dep.url} (${dep.target})`
              : `Deploy (${dep.target ?? "no target"}): ${dep.reason}`,
          );
          run.destination = {
            ...run.destination,
            detail: redactSecrets(
              `${run.destination.detail ?? ""} Hosting: ${dep.reason}.`.trim(),
            ),
          };
          await appendAuditEvent({
            type: dep.deployed && dep.verified ? "run.deploy.live" : "run.deploy.held",
            runId: run.id,
            detail: dep.url ?? dep.reason,
          });

          /* Store publish — owner order 2026-08-15: a production-ready app is
           * posted to the owner's app store on www.axiombiolabs.org too, and
           * PromoPilot picks it up from the same registry. Only a deploy this
           * process live-verified qualifies; store failures never fail the
           * run. FACTORY_STORE_PUBLISH=0 opts out. */
          if (checkpoint.options.publish === false) {
            log(
              "info",
              "App Store: skipped - this run is marked private (publish unchecked), so it is not listed or promoted.",
            );
          } else if (
            dep.deployed &&
            dep.verified &&
            dep.url &&
            process.env.FACTORY_STORE_PUBLISH !== "0"
          ) {
            log("info", "App Store: posting to the axiombiolabs.org store registry…");
            const store = await storePublish({
              appName: run.appName,
              runId: run.id,
              url: dep.url,
              tagline: spec.tagline || null,
            });
            log(
              store.published && store.verified ? "success" : "warning",
              `App Store: ${store.reason}`,
            );
            run.destination = {
              ...run.destination,
              detail: redactSecrets(
                `${run.destination.detail ?? ""} Store: ${store.reason}.`.trim(),
              ),
            };
            await appendAuditEvent({
              type:
                store.published && store.verified
                  ? "run.store.listed"
                  : "run.store.held",
              runId: run.id,
              detail: store.appId ?? store.reason,
            });
          }
        }
      }
    }

    run.status = "completed";
    run.resumable = false;
    const doneEv = await appendAuditEvent({ type: "run.completed", runId: run.id });
    await persistAttribution(testStatus, doneEv.seq);
    // "Complete" describes the PIPELINE, never the outcome. A run whose tests
    // failed or whose work was held back read "Run complete — X is ready",
    // which the owner reasonably took as success (2026-08-16, run b74e5955).
    // The final line now states what actually happened.
    const outcomeOk = qa.passed && testStatus === "passing";
    const releaseNote = run.release
      ? run.release.released
        ? ` Merged to main (${run.release.mergedSha?.slice(0, 8) ?? "sha unknown"}).`
        : ` NOT merged: ${run.release.reason}`
      : "";
    log(
      outcomeOk ? "success" : "warning",
      outcomeOk
        ? `Run finished — ${spec.appName} passed its checks.${releaseNote} Workspace: ${workspacePath}.`
        : `Run finished WITHOUT passing its checks (${
            testStatus === "passing" ? "QA flagged blockers" : `tests ${testStatus}`
          }) — ${spec.appName} is NOT ready.${releaseNote} Workspace: ${workspacePath}.`,
    );
    await flush();
    await deleteRunCheckpoint(run.id).catch(() => {
      log("warning", "Completed run checkpoint cleanup will be retried by retention.");
    });
  } catch (rawErr) {
    // A provider call aborted mid-flight because the deadline fired or the
    // run was cancelled — reuse the exact same, already-tested
    // cancelled-vs-timed-out classification the stage-boundary checks use,
    // rather than re-deriving it here. Cancel takes priority if both are
    // somehow true at once.
    const err: unknown =
      rawErr instanceof ProviderAbortError
        ? isCancelRequested(run.id)
          ? new RunCancelledError()
          : new RunTimeoutError(timeoutMs)
        : rawErr;
    if (err instanceof RunCancelledError) {
      run.status = "cancelled";
      // A cancel is a PAUSE the owner may want to return from, not a shredder
      // (owner order 2026-08-15: "there needs to be a way to pick up where the
      // run left off"). The concrete case: run a8a9c84a was cancelled mid-
      // repair specifically so a Factory Deck defect could be fixed — and its
      // checkpoint held ~$4 of already-paid spec/architecture/research/plan
      // work that deleting made unrecoverable. Cancelled runs now keep their
      // checkpoint and are resumable exactly like failed ones; the one-click
      // run DELETE remains the disposal path for a cancel the owner means as
      // final, and retention pruning still bounds how long checkpoints linger.
      run.resumable = Boolean(await getRunCheckpoint(run.id));
      run.error = null;
      if (run.currentStage) finishStage(run, run.currentStage, "skipped");
      log(
        "warning",
        run.resumable
          ? "Run cancelled by user — stopping cleanly. The durable checkpoint is kept; resume to pick up where it left off."
          : "Run cancelled by user — stopping cleanly.",
      );
      const ev = await appendAuditEvent({ type: "run.cancelled", runId: run.id });
      await persistAttribution("not_run", ev.seq).catch(() => {});
    } else if (err instanceof RunTimeoutError) {
      run.status = "failed";
      run.resumable = true;
      run.error = err.message;
      if (run.currentStage) finishStage(run, run.currentStage, "failed");
      log("error", `Run failed: ${run.error}`);
      const ev = await appendAuditEvent({
        type: "run.timeout",
        runId: run.id,
        detail: err.message,
      });
      await persistAttribution("unknown", ev.seq).catch(() => {});
    } else if (err instanceof ModelBudgetError) {
      run.status = "failed";
      run.resumable = true;
      run.error = err.message;
      if (run.currentStage) finishStage(run, run.currentStage, "failed");
      log("error", `Run failed: ${run.error}`);
      const ev = await appendAuditEvent({
        type: "run.budget_exhausted",
        runId: run.id,
        detail: err.message,
      });
      await persistAttribution("unknown", ev.seq).catch(() => {});
    } else {
      run.status = "failed";
      run.resumable = true;
      // The raw error may embed a provider/library message containing a
      // secret-shaped value — redact before it is persisted and served by the API.
      run.error = redactSecrets(err instanceof Error ? err.message : "Unknown error");
      if (run.currentStage) finishStage(run, run.currentStage, "failed");
      log("error", `Run failed: ${run.error}`);
      const ev = await appendAuditEvent({
        type: "run.failed",
        runId: run.id,
        detail: run.error,
      });
      await persistAttribution("unknown", ev.seq).catch(() => {});
    }
    if (run.status === "failed") {
      run.resumable = Boolean(await getRunCheckpoint(run.id));
    }
    // Cancelled runs KEEP their checkpoint (owner order 2026-08-15: a cancel
    // is a pause to fix something, then "pick up where the run left off").
    // Disposal of a cancel the owner means as final is the one-click run
    // DELETE, and retention pruning still bounds checkpoint lifetime.
    await flush();
  } finally {
    // PARKING FIX (2026-08-16): an inPlace run cut a branch in the owner's REAL
    // repo and never put them back — success, failure, or crash left their
    // working tree parked on factory-deck/<id>, which is how the FlexFactor
    // audit stranded five repos on 2026-08-11. Restore runs on every exit path
    // and never masks the run's own outcome.
    if (inPlaceRestore) {
      const res = await git(["checkout", inPlaceRestore.branch], inPlaceRestore.path, 30_000).catch(
        (err: unknown) => ({ code: 1, stdout: "", stderr: String(err), spawnError: null }),
      );
      log(
        res.code === 0 ? "info" : "warning",
        res.code === 0
          ? `Restored your working tree to ${inPlaceRestore.branch} (the run's work stays on its own branch).`
          : `Could not restore ${inPlaceRestore.branch} in ${inPlaceRestore.path}: ${res.stderr.slice(0, 300)} — your repo is still on the run's branch.`,
      );
      await flush().catch(() => {});
    }
    clearCancel(run.id);
  }
}

export class RunNotResumableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunNotResumableError";
  }
}

// The local backend is a single process. Claim synchronously before the first
// await so two concurrent HTTP requests cannot both observe the same failed
// record and start duplicate executions.
const resumeClaims = new Set<string>();

async function assertResumeWorkspace(
  workspaceRoot: string,
  workspacePath: string,
): Promise<void> {
  const root = resolve(workspaceRoot);
  const candidate = resolve(workspacePath);
  const lexical = relative(root, candidate);
  if (lexical === "" || lexical.startsWith("..") || isAbsolute(lexical)) {
    throw new RunNotResumableError(
      "Saved workspace must be a strict child of the current WORKSPACE_ROOT. Restore the prior root or start a new run.",
    );
  }

  const stat = await lstat(candidate).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RunNotResumableError(
      "Saved workspace is missing, is not a directory, or is a symlink. Restore it safely or start a new run.",
    );
  }
  const [rootReal, candidateReal] = await Promise.all([
    realpath(root).catch(() => null),
    realpath(candidate).catch(() => null),
  ]);
  if (!rootReal || !candidateReal) {
    throw new RunNotResumableError(
      "Saved workspace could not be resolved under the current WORKSPACE_ROOT.",
    );
  }
  const physical = relative(rootReal, candidateReal);
  if (physical === "" || physical.startsWith("..") || isAbsolute(physical)) {
    throw new RunNotResumableError(
      "Saved workspace resolves outside the current WORKSPACE_ROOT.",
    );
  }
}

async function prepareResume(
  runId: string,
  config: AppConfig,
  secrets: AppSecrets,
): Promise<{
  run: RunRecord;
  checkpoint: FactoryCheckpoint;
  args: StartRunArgs;
}> {
  if (resumeClaims.has(runId)) {
    throw new RunNotResumableError("Run resume is already being claimed.");
  }
  resumeClaims.add(runId);
  try {
    const run = await getRunForExecution(runId);
    const checkpoint = await getRunCheckpoint(runId);
    // Failed AND cancelled runs resume — a cancel is a pause the owner may
    // return from once whatever prompted it is fixed (owner order 2026-08-15).
    const stoppedResumable =
      (run?.status === "failed" || run?.status === "cancelled") &&
      run?.resumable === true;
    if (!run || !checkpoint || !stoppedResumable) {
      throw new RunNotResumableError(
        "Run has no interrupted durable checkpoint to resume.",
      );
    }
    if (run.workspacePath) {
      await assertResumeWorkspace(config.workspaceRoot, run.workspacePath);
    }

    // Resolve providers before consuming the checkpoint. If credentials or the
    // free route changed while the process was down, the run remains failed and
    // resumable instead of becoming a queued ghost after the API returns 202.
    const registry = createProviderRegistry(config, secrets);
    if (run.demo) {
      registry.get("mock");
    } else {
      if (registry.availableLive().length === 0) {
        throw new MissingProviderCredentialError(registry.missingCredentialNames());
      }
      registry.resolveLive(run.codeProvider, config.defaultCodeProvider);
      registry.resolveLive(run.reviewProvider, config.defaultReviewProvider);
    }

    for (const stage of run.stages) {
      if (stage.status === "failed" || stage.status === "active") {
        stage.status = "pending";
        stage.startedAt = null;
        stage.endedAt = null;
        stage.durationMs = null;
      }
    }
    run.currentStage = null;
    run.status = "queued";
    run.resumable = false;
    run.error = null;
    await saveRun(run);
    return {
      run,
      checkpoint,
      args: {
        idea: checkpoint.idea,
        options: checkpoint.options,
        config,
        secrets,
      },
    };
  } finally {
    resumeClaims.delete(runId);
  }
}

async function restoreFailedResume(run: RunRecord, err: unknown): Promise<void> {
  run.status = "failed";
  run.resumable = Boolean(await getRunCheckpoint(run.id));
  run.error = redactSecrets(
    err instanceof Error ? err.message : "Resume setup failed unexpectedly.",
  );
  await saveRun(run);
}

/** Resume in the background (API/UI entry point). */
export async function resumeRun(
  runId: string,
  config: AppConfig,
  secrets: AppSecrets,
  /**
   * Optional provider switch applied to THIS resume (owner order 2026-08-16:
   * "grantflow needs to be on openai"). A run's providers were fixed at
   * creation, so the only way to move an in-flight build off the free route
   * was to abandon its paid checkpoint and start over. The override is
   * validated against configured live providers and persisted with the run.
   */
  providers?: { codeProvider?: ProviderName; reviewProvider?: ProviderName },
): Promise<RunRecord> {
  const prepared = await prepareResume(runId, config, secrets);
  if (providers?.codeProvider || providers?.reviewProvider) {
    const registry = createProviderRegistry(config, secrets);
    const live = new Set(registry.availableLive());
    for (const name of [providers.codeProvider, providers.reviewProvider]) {
      if (name && !live.has(name)) {
        throw new MissingProviderCredentialError([
          `provider "${name}" is not configured — cannot resume onto it`,
        ]);
      }
    }
    if (providers.codeProvider) prepared.run.codeProvider = providers.codeProvider;
    if (providers.reviewProvider) prepared.run.reviewProvider = providers.reviewProvider;
    prepared.run.logs.push(
      makeLog(
        "info",
        `Provider switched on resume: code=${prepared.run.codeProvider}, review=${prepared.run.reviewProvider}.`,
        prepared.run.currentStage,
      ),
    );
    await saveRun(prepared.run);
  }
  void executeRun(prepared.run, prepared.args, prepared.checkpoint).catch(
    async (err) => {
      await restoreFailedResume(prepared.run, err).catch(() => {});
    },
  );
  return prepared.run;
}

/** Resume and await completion (CLI and integration-test entry point). */
export async function resumeFactory(
  runId: string,
  config: AppConfig,
  secrets: AppSecrets,
): Promise<RunRecord> {
  const prepared = await prepareResume(runId, config, secrets);
  try {
    await executeRun(prepared.run, prepared.args, prepared.checkpoint);
  } catch (err) {
    await restoreFailedResume(prepared.run, err);
    throw err;
  }
  return prepared.run;
}

/** Fire-and-forget: returns the queued record immediately, runs in background. */
export function startRun(args: StartRunArgs): RunRecord {
  const run = createRecord(args);
  putRunInMemory(run);
  void appendAuditEvent({ type: "run.queued", runId: run.id });
  void saveRun(run).then(() => executeRun(run, args));
  return run;
}

/** Await the full run (used by the CLI). */
export async function runFactory(args: StartRunArgs): Promise<RunRecord> {
  const run = createRecord(args);
  await appendAuditEvent({ type: "run.queued", runId: run.id });
  await saveRun(run);
  await executeRun(run, args);
  return run;
}

/**
 * Await the full run, reporting the created record BEFORE execution — so an
 * orchestrator (the epic runner) can persist the runId while the run is
 * still alive instead of only after it finishes.
 */
export async function runFactoryTracked(
  args: StartRunArgs,
  onCreated: (run: RunRecord) => void | Promise<void>,
): Promise<RunRecord> {
  const run = createRecord(args);
  await appendAuditEvent({ type: "run.queued", runId: run.id });
  await saveRun(run);
  await onCreated(run);
  await executeRun(run, args);
  return run;
}
