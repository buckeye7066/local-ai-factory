import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import type { FreeProvider } from "./freeProvider.js";
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
 * failoverProvider.ts — FREE primary, paid rescue, automatic return to free.
 *
 * The escalation order is free -> paid Anthropic -> paid OpenAI, and every hop
 * is loud: the trigger, the measurement that caused it, who took over, and
 * what it cost all reach the run log and /api/health.
 *
 * Three rules keep the paid tier from becoming the primary by accident:
 *
 *  - Only a proven STALL escalates. Backpressure (429/503/model-loading/cold
 *    start) is "alive, come back shortly" and retries patiently on free,
 *    forever-ish, without ever touching a paid provider.
 *
 *  - The post-stall hold is a monotonic timestamp, not a flag. When it lapses
 *    the very next call goes back to free with no explicit recovery step, so a
 *    single stall can never pin the deck to a paid provider.
 *
 *  - When paid is unavailable — no key, or a budget cap reached — the deck
 *    does NOT fail. It goes back to waiting on free. The owner's purpose is
 *    keeping the free route running; refusing to spend must degrade to
 *    patience, not to an error.
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

export class FailoverProvider implements LLMProvider {
  /**
   * Reported identity is the PRIMARY route, which is what the run record and
   * the deck should show. Who actually served each call is tracked in the
   * route snapshot and logged per hop.
   */
  readonly name: ProviderName = "free";

  constructor(
    private free: FreeProvider,
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

  /**
   * Run one logical model call through the chain.
   *
   * `invoke` is applied to whichever provider ends up serving, so text and
   * JSON calls share one policy rather than drifting apart.
   */
  private async execute<T>(
    label: string,
    invoke: (p: LLMProvider) => Promise<T>,
  ): Promise<T> {
    const paid = this.paidTiers();
    const freeUsable = this.free.isConfigured();

    // No free route configured at all: this deck is paid-only by explicit
    // configuration, so run the paid chain (still budget-capped).
    if (!freeUsable) {
      return this.runPaid(label, invoke, new Error("free route not configured"));
    }

    // Under a post-stall hold, prefer paid — but only if paying is actually
    // allowed. Otherwise fall through and keep waiting on free.
    if (isHoldActive() && paid.length > 0 && canPayNow().ok) {
      this.log(
        "warn",
        `[route] ${label}: free route is under a post-stall hold; serving from the paid rescue tier. ` +
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

        // A deliberate abort (deadline/cancel) is never a free-route retry
        // candidate and must never trigger paid rescue.
        if (err instanceof ProviderAbortError) throw err;

        // ---- Alive, just busy. Wait. Never escalate. --------------------
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

        // ---- Proven wedge. Arm the hold, try to revive the backend, rescue.
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
          // Best-effort revive so the NEXT call can go back to free sooner.
          void ensureProxy(this.cfg.baseUrl, this.cfg.autoRestart).catch(() => {});
          break;
        }

        // ---- Ordinary failure: empty output, bad JSON, transport blip. ---
        // Cheap to retry on free, and no evidence the backend is wedged, so
        // this must not arm the hold.
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
   * The rescue tier. Refuses to spend past the caps, and when it refuses it
   * hands the work BACK to free rather than failing the run.
   */
  private async runPaid<T>(
    label: string,
    invoke: (p: LLMProvider) => Promise<T>,
    cause: unknown,
  ): Promise<T> {
    const tiers = this.paidTiers();
    const causeMsg = safeErrorMessage(cause);

    if (tiers.length === 0) {
      // No paid key at all. Keep trying free — that is the whole point.
      this.log(
        "warn",
        `[route] ${label}: free route failed (${causeMsg.slice(0, 160)}) and no paid ` +
          `rescue key is configured. Retrying on FREE.`,
      );
      return invoke(this.free).then((r) => {
        noteServed("free");
        return r;
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
      return invoke(this.free).then((r) => {
        noteServed("free");
        return r;
      });
    }

    let lastErr: unknown = cause;
    for (const tier of tiers) {
      const tierName = tier.name;
      try {
        noteFailover(tierName, `${label}: ${causeMsg.slice(0, 200)}`);
        this.log(
          "warn",
          `[route] ${label}: PAYING — rescuing this call on ${tierName.toUpperCase()} ` +
            `because the free route failed (${causeMsg.slice(0, 160)}). ` +
            `The free proxy stays primary and will be re-probed automatically.`,
        );
        const result = await invoke(tier);
        noteServed(tierName);
        return result;
      } catch (err) {
        // The run's deadline lapsed or it was cancelled WHILE this paid call
        // was in flight. That is a deliberate stop, not a paid-tier failure —
        // do not try the next paid tier, and do not let the caller retry.
        if (err instanceof ProviderAbortError) throw err;
        lastErr = err;
        this.log(
          "warn",
          `[route] ${label}: paid tier ${tierName} also failed ` +
            `(${safeErrorMessage(err).slice(0, 160)}).`,
        );
      }
    }

    if (lastErr instanceof PaidBudgetExhaustedError) throw lastErr;
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.execute("generateText", (p) => p.generateText(input));
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.execute("generateJson", (p) => p.generateJson(input));
  }
}
