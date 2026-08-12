import { randomUUID } from "node:crypto";
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
import { isInsideWorkspace, runCommand } from "../workspace/commandRunner.js";
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
import {
  RunCancelledError,
  clearCancel,
  throwIfCancelled,
  isCancelRequested,
  getCancelSignal,
} from "./cancellation.js";
import { runRepairLoop } from "./repairLoop.js";
import { productSpecAgent } from "../agents/productSpecAgent.js";
import { architectAgent } from "../agents/architectAgent.js";
import { taskPlannerAgent } from "../agents/taskPlannerAgent.js";
import { fileBuilderAgent } from "../agents/fileBuilderAgent.js";
import { testWriterAgent } from "../agents/testWriterAgent.js";
import { qaCriticAgent } from "../agents/qaCriticAgent.js";
import { repairAgent } from "../agents/repairAgent.js";
import { finalReviewerAgent } from "../agents/finalReviewerAgent.js";

export interface StartRunArgs {
  idea: string;
  options: RunOptions;
  config: AppConfig;
  secrets: AppSecrets;
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
    error: null,
    attribution: null,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };
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
function combineAbortSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
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
  let checkpoint: FactoryCheckpoint =
    restored ?? {
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
  const code: LLMProvider = new CountingProvider(
    rawCode,
    run,
    config.maxModelCallsPerRun,
    attribution(rawCode),
  );
  const review: LLMProvider = new CountingProvider(
    rawReview,
    run,
    config.maxModelCallsPerRun,
    attribution(rawReview),
  );

  // The live in-memory view of the workspace, restored from the private
  // checkpoint so a resumed run never needs the redacted API copy.
  const files = new Map<string, FileContent>(
    checkpoint.files.map((file) => [file.path, file]),
  );

  const writeBuild = async (
    workspacePath: string,
    incoming: { path: string; purpose: string; contents: string }[],
    stage: StageId,
  ) => {
    // A cancel during a stage must stop further file writes, not only at stage
    // boundaries — check before touching the workspace.
    throwIfCancelled(run.id);
    throwIfTimedOut(deadline, timeoutMs);
    for (const f of incoming) {
      // Re-check per file so a cancel mid-loop stops the REMAINING writes.
      throwIfCancelled(run.id);
      throwIfTimedOut(deadline, timeoutMs);
      const res = await writeWorkspaceFile(workspacePath, f.path, f.contents);
      // And again after the awaited write, before we record/log/persist it.
      throwIfCancelled(run.id);
      const status: FileContent["status"] = res.existed ? "modified" : "generated";
      files.set(res.path, {
        path: res.path,
        purpose: f.purpose,
        language: res.language,
        size: res.size,
        status,
        contents: f.contents,
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
  };

  const persistAttribution = async (
    testResult: "passing" | "failing" | "skipped" | "unknown" | "not_run",
    auditSeq: number | null,
  ) => {
    const attr = buildAttribution(run, {
      dryRunCommands: config.dryRunCommands,
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
    if (!stageDone("intake")) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "intake");
      log("info", `Intake: "${run.idea}"`);
      finishStage(run, "intake", "completed");
      await flush();
    }

    /* Stage 2 — Product Spec */
    let spec: ProductSpec | undefined = checkpoint.spec;
    if (!spec) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "product_spec");
      log("model_call", `Product Spec agent (${code.name})…`);
      spec = await productSpecAgent({ provider: code }, checkpoint.idea);
      // Persist the provider output before any later mutation: a crash after
      // this point resumes without paying for the same call again.
      await checkpointNow({ spec });
    }
    if (!stageDone("product_spec")) {
      run.appName = redactSecrets(spec.appName);
      log(
        "success",
        `Spec ready: ${spec.appName} — ${spec.coreFeatures.length} core features.`,
      );
      finishStage(run, "product_spec", "completed");
      await flush();
    }

    /* Stage 3 — Architect */
    let arch: Architecture | undefined = checkpoint.architecture;
    if (!arch) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "architect");
      log("model_call", `Architect agent (${code.name})…`);
      arch = await architectAgent({ provider: code }, spec);
      await checkpointNow({ architecture: arch });
    }
    if (!stageDone("architect")) {
      log(
        "success",
        `Architecture set${arch.risks.length ? ` — ${arch.risks.length} risk(s) noted.` : "."}`,
      );
      finishStage(run, "architect", "completed");
      await flush();
    }

    /* Stage 4 — Task Planner */
    let plan: TaskPlan | undefined = checkpoint.plan;
    if (!plan) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "task_planner");
      log("model_call", `Task Planner agent (${code.name})…`);
      plan = await taskPlannerAgent({ provider: code }, spec, arch);
      await checkpointNow({ plan });
    }
    if (!stageDone("task_planner")) {
      log("success", `Plan ready: ${plan.tasks.length} tasks.`);
      finishStage(run, "task_planner", "completed");
      await flush();
    }

    /* Stage 5 + 6 — Builder (generate + write files) */
    let workspacePath = run.workspacePath;
    if (!workspacePath) {
      const created = await createWorkspace(
        config.workspaceRoot,
        spec.appName,
        run.id,
      );
      workspacePath = created.path;
      run.workspacePath = workspacePath;
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
      log("model_call", `File Builder agent (${code.name})…`);
      build = await fileBuilderAgent({ provider: code }, spec, arch, plan);
      await checkpointNow({ build });
    }
    if (!stageDone("builder")) {
      await writeBuild(workspacePath, build.files, "builder");
      log("success", `Generated ${build.files.length} files.`);
      finishStage(run, "builder", "completed");
      await flush();
    }

    /* Stage 7 — Test Writer (+ optional install/test commands) */
    let commandOutput = checkpoint.commandOutput;
    let testsExecuted = checkpoint.testsExecuted;
    let testExit = checkpoint.testExit;
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
        await writeBuild(workspacePath, testPlan.files, "test_writer");
      }

      // Install + test, subject to the allowlist + dry-run flag. Command replay
      // after a crash is allowed; the expensive provider result above is not.
      commandOutput = "";
      testsExecuted = false;
      testExit = null;
      for (const cmd of [
        { bin: "pnpm", args: ["install"] },
        { bin: "pnpm", args: ["test"] },
      ]) {
        throwIfCancelled(run.id);
        throwIfTimedOut(deadline, timeoutMs);
        const res = await runCommand(
          { bin: cmd.bin, args: cmd.args, cwd: workspacePath },
          {
            workspaceRoot: config.workspaceRoot,
            dryRun: config.dryRunCommands,
            allowScriptExecution: config.allowUntrustedScripts,
            shouldCancel: () => isCancelRequested(run.id),
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
          if (cmd.args[0] === "test") {
            testsExecuted = true;
            testExit = res.exitCode;
          }
        }
      }
      await checkpointNow({
        testWriterComplete: true,
        commandOutput,
        testsExecuted,
        testExit,
      });
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
      })),
    });

    /* Stage 8 — QA Critic */
    let qa: QaReport | undefined = checkpoint.qa;
    if (!qa) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "qa_critic");
      log("model_call", `QA Critic agent (${review.name})…`);
      qa = await qaCriticAgent({ provider: review }, fullBuild(), commandOutput);
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
          await writeBuild(workspacePath, pending.files, "repair");
        }
        log("info", pending.notes || "Applied checkpointed repair.", "repair");
        log("model_call", `Re-running QA Critic (${review.name})…`, "repair");
        qa = await qaCriticAgent({ provider: review }, fullBuild(), commandOutput);
        await checkpointNow({ qa, pendingRepair: undefined });
        log(qa.passed ? "success" : "warning", `QA: ${qa.summary}`, "repair");
      }
      const remainingLoops = Math.max(0, maxLoops - run.repairLoops);
      if (qa.passed) {
        log("success", "No high-severity issues — repair loop skipped.");
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
            if (fix.files.length) {
              await writeBuild(workspacePath, fix.files, "repair");
            }
            log("info", fix.notes || "Applied repairs.", "repair");
          },
          reverify: async () => {
            throwIfTimedOut(deadline, timeoutMs);
            log("model_call", `Re-running QA Critic (${review.name})…`, "repair");
            const next = await qaCriticAgent(
              { provider: review },
              fullBuild(),
              commandOutput,
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
    const testStatus = testsExecuted
      ? testExit === 0
        ? "passing"
        : "failing"
      : qa.passed
        ? "passing"
        : "unknown";
    let report = checkpoint.finalReport;
    if (!report) {
      throwIfTimedOut(deadline, timeoutMs);
      startStage(run, "final_review");
      log("model_call", `Final Reviewer agent (${review.name})…`);
      report = await finalReviewerAgent({ provider: review }, spec, qa, {
        repairLoops: run.repairLoops,
        workspacePath,
        providerUsage: run.providerUsage,
        testStatus,
      });
      await checkpointNow({ finalReport: report });
    }
    throwIfCancelled(run.id);
    throwIfTimedOut(deadline, timeoutMs);
    run.finalReport = redactDeep(report);
    finishStage(run, "final_review", "completed");

    run.status = "completed";
    run.resumable = false;
    const doneEv = await appendAuditEvent({ type: "run.completed", runId: run.id });
    await persistAttribution(testStatus, doneEv.seq);
    log("success", `Run complete — ${spec.appName} is ready at ${workspacePath}.`);
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
      run.resumable = false;
      run.error = null;
      if (run.currentStage) finishStage(run, run.currentStage, "skipped");
      log("warning", "Run cancelled by user — stopping cleanly.");
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
    // A user cancellation is terminal, not resumable. Persist that terminal
    // truth first, then remove the private raw checkpoint so cancelled input
    // does not linger until retention pruning.
    await flush();
    if (run.status === "cancelled") {
      try {
        await deleteRunCheckpoint(run.id);
      } catch (cleanupErr) {
        log(
          "warning",
          `Cancelled-run checkpoint cleanup failed: ${redactSecrets(
            cleanupErr instanceof Error ? cleanupErr.message : "unknown error",
          )}`,
        );
        await flush();
      }
    }
  } finally {
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
    if (!run || !checkpoint || run.status !== "failed" || !run.resumable) {
      throw new RunNotResumableError(
        "Run has no interrupted durable checkpoint to resume.",
      );
    }
    if (
      run.workspacePath &&
      !isInsideWorkspace(config.workspaceRoot, run.workspacePath)
    ) {
      throw new RunNotResumableError(
        "Saved workspace is outside the current WORKSPACE_ROOT. Restore the prior root or start a new run.",
      );
    }

    // Resolve providers before consuming the checkpoint. If credentials or the
    // free route changed while the process was down, the run remains failed and
    // resumable instead of becoming a queued ghost after the API returns 202.
    const registry = createProviderRegistry(config, secrets);
    if (run.demo) {
      registry.get("mock");
    } else {
      if (registry.availableLive().length === 0) {
        throw new MissingProviderCredentialError(
          registry.missingCredentialNames(),
        );
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
): Promise<RunRecord> {
  const prepared = await prepareResume(runId, config, secrets);
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
