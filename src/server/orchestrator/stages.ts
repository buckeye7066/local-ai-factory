import { randomUUID } from "node:crypto";
import type {
  RunRecord,
  StageId,
  LogKind,
  LogLine,
  ProviderName,
} from "../../shared/schemas.js";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { throwIfCancelled } from "./cancellation.js";
import { redactSecrets } from "../security/redact.js";
import { snapshotRoute } from "../providers/freeRoute.js";
import { PaidBudgetExhaustedError } from "../providers/paidBudget.js";

/**
 * stages.ts — pure helpers the orchestrator uses to mutate a RunRecord:
 * append logs, move stages through their lifecycle, and meter provider calls.
 */

export function nowMs(): number {
  return Date.now();
}

export function makeLog(
  kind: LogKind,
  message: string,
  stage: StageId | null,
): LogLine {
  // Every log line is persisted to disk and served over the API — strip any
  // secret-shaped content (pasted keys, .env lines) at this single choke point.
  return {
    id: randomUUID(),
    ts: nowMs(),
    stage,
    kind,
    message: redactSecrets(message),
  };
}

export function startStage(run: RunRecord, id: StageId): void {
  // Stage boundaries are cancellation checkpoints (model calls are the other).
  throwIfCancelled(run.id);
  run.currentStage = id;
  const stage = run.stages.find((s) => s.id === id);
  if (stage) {
    stage.status = "active";
    stage.startedAt = nowMs();
  }
}

export function finishStage(
  run: RunRecord,
  id: StageId,
  status: "completed" | "failed" | "skipped",
): void {
  const stage = run.stages.find((s) => s.id === id);
  if (stage) {
    stage.status = status;
    stage.endedAt = nowMs();
    if (stage.startedAt) stage.durationMs = stage.endedAt - stage.startedAt;
  }
}

/** Raised when the per-run model-call budget is exceeded. */
export class ModelBudgetError extends Error {
  constructor(limit: number) {
    super(`Model-call budget exceeded (MAX_MODEL_CALLS_PER_RUN=${limit}).`);
    this.name = "ModelBudgetError";
  }
}

/**
 * Wraps a provider so every call is counted toward the run's usage tally and
 * the global budget. Keeps the safety limit close to where calls happen.
 */
export class CountingProvider implements LLMProvider {
  readonly name: ProviderName;
  constructor(
    private inner: LLMProvider,
    private run: RunRecord,
    private limit: number,
    /**
     * How to attribute a call to a provider.
     *
     * "declared" — credit `inner.name`. Correct for a single concrete
     * provider.
     *
     * "served"   — credit whoever ACTUALLY served, read from the live route
     * snapshot after the call. Required for the failover chain: its declared
     * name is "free" (the primary), so declared-attribution would book a paid
     * rescue as a free call and hide the very spend the deck must surface.
     */
    private attribution: "declared" | "served" = "declared",
  ) {
    this.name = inner.name;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  currentProvider(): ProviderName {
    return this.inner.currentProvider?.() ?? this.inner.name;
  }

  currentModel(): string {
    return this.inner.currentModel?.() ?? this.currentProvider();
  }

  private checkAdmission() {
    // A cancel request stops the run before the next model call.
    throwIfCancelled(this.run.id);
    if (this.run.providerUsage.totalCalls >= this.limit) {
      throw new ModelBudgetError(this.limit);
    }
  }

  private tick() {
    this.checkAdmission();
    this.run.providerUsage.totalCalls += 1;
    if (this.attribution === "declared") {
      this.run.providerUsage[this.name].calls += 1;
    }
  }

  private undoTick() {
    this.run.providerUsage.totalCalls = Math.max(
      0,
      this.run.providerUsage.totalCalls - 1,
    );
    if (this.attribution === "declared") {
      this.run.providerUsage[this.name].calls = Math.max(
        0,
        this.run.providerUsage[this.name].calls - 1,
      );
    }
  }

  private async prepare(): Promise<void> {
    // Catalog lookup and a catalog-proven local refusal are not model calls.
    // Check the cap before doing even that network lookup, then charge only
    // after preparation proves this rung can reach inference. `tick` checks
    // again after the await so concurrent calls cannot jointly cross the cap.
    this.checkAdmission();
    await this.inner.prepareCall?.();
  }

  /** Credit the provider that actually served the call just completed. */
  private creditServed() {
    if (this.attribution !== "served") return;
    const served = snapshotRoute().serving;
    const name: ProviderName = served ?? this.name;
    if (this.run.providerUsage[name]) {
      this.run.providerUsage[name].calls += 1;
    }
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    await this.prepare();
    this.tick();
    let counted = true;
    try {
      return await this.inner.generateText(input);
    } catch (error) {
      // Paid-budget admission fails before provider I/O. It is not a model
      // call and must leave room for the ladder's terminal free rung.
      if (error instanceof PaidBudgetExhaustedError && !error.providerAttemptOccurred) {
        this.undoTick();
        counted = false;
      }
      throw error;
    } finally {
      if (counted) this.creditServed();
    }
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    await this.prepare();
    this.tick();
    let counted = true;
    try {
      return await this.inner.generateJson(input);
    } catch (error) {
      if (error instanceof PaidBudgetExhaustedError && !error.providerAttemptOccurred) {
        this.undoTick();
        counted = false;
      }
      throw error;
    } finally {
      if (counted) this.creditServed();
    }
  }
}
