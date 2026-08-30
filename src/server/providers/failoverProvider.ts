import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import { PinUnavailable } from "../rotation/aitimeRotation.js";
import {
  FreeRouteStallError,
  FreeRouteBackpressureError,
  armHold,
  ensureProxy,
  isHoldActive,
  noteBackpressure,
  noteBudgetRefusal,
  noteFailover,
  noteServed,
} from "./freeRoute.js";
import { canPayNow, PaidBudgetExhaustedError } from "./paidBudget.js";
import { ProviderAbortError } from "./types.js";
import { safeErrorMessage } from "../errors.js";

/**
 * failoverProvider.ts — FREE primary, one paid rescue, automatic return to free.
 *
 * Credit Guard changes the paid side of the historical chain deliberately:
 * one logical request may reach at most ONE paid provider. If that provider
 * errors or its output fails acceptance, the request stops with evidence. It
 * never rolls into a second billable provider and compounds the loss.
 */

export interface FailoverConfig {
  /** How long to skip the free route after a proven stall. */
  holdMs: number;
  /** Free attempts for non-stall failures before rescuing. */
  attempts: number;
  /** Spacing between free attempts — matches the proxy's rate window. */
  retrySpacingMs: number;
  /** Cap on patient backpressure retries per logical call. */
  maxBackpressureRetries: number;
  baseUrl: string;
  autoRestart: boolean;
}

export type RouteLogger = (kind: "info" | "warn", message: string) => void;

export interface FreePrimary extends LLMProvider {
  resetTransport(): void;
}

export class FailoverProvider implements LLMProvider {
  readonly name: ProviderName = "free";

  constructor(
    private free: FreePrimary,
    private anthropic: LLMProvider,
    private openai: LLMProvider,
    private cfg: FailoverConfig,
    private log: RouteLogger = () => {},
  ) {}

  isConfigured(): boolean {
    return (
      this.free.isConfigured() ||
      this.anthropic.isConfigured() ||
      this.openai.isConfigured()
    );
  }

  private paidTiers(): LLMProvider[] {
    return [this.anthropic, this.openai].filter((p) => p.isConfigured());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async execute<T>(
    label: string,
    invoke: (p: LLMProvider) => Promise<T>,
  ): Promise<T> {
    const paid = this.paidTiers();
    const freeUsable = this.free.isConfigured();

    if (!freeUsable) {
      return this.runPaid(label, invoke, new Error("free route not configured"));
    }

    if (isHoldActive() && paid.length > 0 && canPayNow().ok) {
      this.log(
        "warn",
        `[route] ${label}: free route is under a post-stall hold; one paid rescue may serve this request. ` +
          `Free will be re-probed automatically when the hold lapses.`,
      );
      return this.runPaid(label, invoke, new Error("free route under post-stall hold"));
    }

    let backpressureRetries = 0;
    let attempt = 0;
    let lastErr: unknown = new Error("free route did not run");

    for (;;) {
      try {
        const result = await invoke(this.free);
        noteServed("free");
        return result;
      } catch (err) {
        lastErr = err;

        if (err instanceof ProviderAbortError) throw err;
        if (err instanceof PinUnavailable) throw err;

        if (err instanceof FreeRouteBackpressureError) {
          backpressureRetries += 1;
          noteBackpressure(`${label}: ${safeErrorMessage(err)}`);
          if (backpressureRetries <= this.cfg.maxBackpressureRetries) {
            this.log(
              "info",
              `[route] ${label}: free route signalled backpressure ` +
                `(${safeErrorMessage(err)}) — waiting ${Math.round(
                  err.retryAfterMs / 1000,
                )}s and retrying on FREE ` +
                `[${backpressureRetries}/${this.cfg.maxBackpressureRetries}]. No paid call.`,
            );
            await this.sleep(err.retryAfterMs);
            continue;
          }
          this.log(
            "warn",
            `[route] ${label}: free route stayed busy for ${backpressureRetries} retries.`,
          );
          break;
        }

        if (err instanceof FreeRouteStallError) {
          const m = err.measurement;
          armHold(
            this.cfg.holdMs,
            `${label}: ${m.phase} silence ${Math.round(m.silentMs / 1000)}s ` +
              `(budget ${Math.round(m.windowMs / 1000)}s, ${m.patienceGrants} grants, liveness=${m.liveness})`,
          );
          this.log(
            "warn",
            `[route] ${label}: FREE ROUTE STALLED — ${m.phase} silence ` +
              `${Math.round(m.silentMs / 1000)}s exceeded its ${Math.round(
                m.windowMs / 1000,
              )}s budget after ${m.patienceGrants} patience grant(s); ` +
              `out-of-band liveness=${m.liveness} (${m.livenessDetail}); ` +
              `queueDepth=${m.queueDepth}; ${m.bytesReceived} stream events in ${Math.round(
                m.elapsedMs / 1000,
              )}s.`,
          );
          void ensureProxy(this.cfg.baseUrl, this.cfg.autoRestart).catch(() => {});
          break;
        }

        attempt += 1;
        if (attempt < this.cfg.attempts) {
          this.log(
            "info",
            `[route] ${label}: free attempt ${attempt}/${this.cfg.attempts} failed ` +
              `(${safeErrorMessage(err).slice(0, 160)}); ` +
              `retrying on FREE in ${Math.round(this.cfg.retrySpacingMs / 1000)}s.`,
          );
          this.free.resetTransport();
          await this.sleep(this.cfg.retrySpacingMs);
          continue;
        }
        break;
      }
    }

    return this.runPaid(label, invoke, lastErr);
  }

  /**
   * The rescue tier admits at most one paid provider for one logical request.
   * Credit Guard inside that provider performs the reservation, validation,
   * dispute receipt, duplicate block, and circuit break.
   */
  private async runPaid<T>(
    label: string,
    invoke: (p: LLMProvider) => Promise<T>,
    cause: unknown,
  ): Promise<T> {
    const tiers = this.paidTiers();
    const causeMsg = safeErrorMessage(cause);

    if (tiers.length === 0) {
      this.log(
        "warn",
        `[route] ${label}: free route failed (${causeMsg.slice(0, 160)}) and no paid ` +
          `rescue key is configured. Retrying on FREE.`,
      );
      return invoke(this.free).then((result) => {
        noteServed("free");
        return result;
      });
    }

    const budget = canPayNow();
    if (!budget.ok) {
      noteBudgetRefusal(`${label}: ${budget.reason}`);
      this.log(
        "warn",
        `[route] ${label}: PAID RESCUE REFUSED — ${budget.reason}. ` +
          `Falling back to the FREE route and waiting. No money will be spent.`,
      );
      return invoke(this.free).then((result) => {
        noteServed("free");
        return result;
      });
    }

    const tier = tiers[0];
    const tierName = tier.name;
    noteFailover(tierName, `${label}: ${causeMsg.slice(0, 200)}`);
    this.log(
      "warn",
      `[route] ${label}: PAYING ONCE — rescuing this call on ${tierName.toUpperCase()} ` +
        `because the free route failed (${causeMsg.slice(0, 160)}). ` +
        `Credit Guard forbids a second paid-provider attempt if this one fails.`,
    );

    try {
      const result = await invoke(tier);
      noteServed(tierName);
      return result;
    } catch (error) {
      if (error instanceof ProviderAbortError) throw error;
      this.log(
        "warn",
        `[route] ${label}: the single paid attempt on ${tierName} failed or was rejected ` +
          `(${safeErrorMessage(error).slice(0, 160)}). Credit Guard stopped paid routing.`,
      );
      if (error instanceof PaidBudgetExhaustedError) throw error;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.execute("generateText", (provider) => provider.generateText(input));
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.execute("generateJson", (provider) => provider.generateJson(input));
  }
}
