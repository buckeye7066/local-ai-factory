import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
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
import { readWorkspaceFile, safeResolve, writeWorkspaceFile } from "../workspace/fileWriter.js";
import {
  findUnexpectedWorkspaceChanges,
  sha256Text,
  verifyFileDigests,
  withVerificationReceipt,
} from "../workspace/verificationReceipt.js";
import { runCommand } from "../workspace/commandRunner.js";
import {
  hasPlaywrightHarness,
  verificationPlanForWorkspace,
} from "../workspace/verificationCommands.js";
import {
  enforceWiredIntegration,
  findUnwiredNewFiles,
  unwiredCaveat,
} from "../workspace/unwiredFiles.js";
import { assessProtectedHostWrite } from "../workspace/protectedFiles.js";
import { assessPhantomImports } from "../workspace/phantomImports.js";
import { resolveGeneratedWrite } from "../workspace/applyEdits.js";
import { inspectTargetFiles } from "../workspace/targetFiles.js";
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
import {
  assessExecutedCoverage,
  assessGeneratedTests,
} from "./acceptanceGate.js";
import { parseDirectTestEvidence } from "./directTestEvidence.js";
import { groundFinalReport } from "./reportGrounding.js";
import {
  foldTestExit,
  freshTestVerdict,
  relevantTestStatus,
} from "./testVerdict.js";
import { classifyEnvironmentFailure } from "./envFailure.js";
import { productSpecAgent } from "../agents/productSpecAgent.js";
import { architectAgent } from "../agents/architectAgent.js";
import { taskPlannerAgent } from "../agents/taskPlannerAgent.js";
import { fileBuilderAgent } from "../agents/fileBuilderAgent.js";
import { testWriterAgent } from "../agents/testWriterAgent.js";
import { qaCriticAgent } from "../agents/qaCriticAgent.js";
import { repairAgent } from "../agents/repairAgent.js";
import { renderBuildCodeContext } from "../agents/codeContext.js";
import { finalReviewerAgent } from "../agents/finalReviewerAgent.js";
import { repoResolverAgent, ResolveError } from "../agents/repoResolverAgent.js";
import { ingestExistingRepo, IngestError } from "../workspace/ingestRepo.js";
import { analyzeExistingCodebase } from "../workspace/analyzeExistingCodebase.js";
import { composeExtendIdea, buildExistingContext } from "./composeExtendIdea.js";
import { ingestAdditionalSource } from "./ingestAdditionalSource.js";
import { createWorkTheme, withWorkTheme } from "./workTheme.js";
import { researchAgent } from "../agents/researchAgent.js";
import { deliverRun, planDestination } from "./deliverRun.js";
import { releaseRun, isPaperOnlyDelivery } from "./releaseRun.js";
import { planRelease, planReleaseOutcome } from "./releasePlan.js";
import { deployRun } from "./deployRun.js";
import { storePublish } from "./storePublish.js";
import { githubLogin, originUrl, currentBranch, git } from "../workspace/gitOps.js";
import { safeErrorMessage } from "../errors.js";

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

export function repairOutcomeMessage(tally: WriteTally): string {
  if (tally.candidates === 0) {
    return "NO REPAIR APPLIED — the repair agent proposed no files.";
  }
  if (tally.written === 0) {
    return `NO REPAIR APPLIED — all ${tally.refusals.length} proposed write(s) were refused.`;
  }
  if (tally.refusals.length > 0) {
    return (
      `Applied ${tally.written} repair file(s); ${tally.refusals.length} were refused. ` +
      "Executable verification will determine only what the applied files fixed."
    );
  }
  return (
    `Applied ${tally.written} repair file(s). ` +
    "Executable verification will determine whether they fixed the issue."
  );
}

/** Canonical slash-separated workspace path used for identity and guard checks. */
export function normalizeGeneratedPath(path: string): string {
  return posix
    .normalize(path.replace(/\\/g, "/"))
    .replace(/^\.\/+/, "");
}
