import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
} from "../../shared/types.js";
import { CreditGuardCircuitOpenError } from "./creditGuard.js";
import { PaidBudgetExhaustedError } from "./paidBudget.js";

/**
 * Recognize provider-originated quota text for diagnostics only.
 *
 * A provider response carrying one of these messages may already represent a
 * submitted billable request. Credit Guard therefore does NOT try a second
 * provider for the same logical request. On an identical later request, the
 * first provider is blocked locally by Credit Guard before I/O, which permits
 * a safe alternate without compounding paid attempts.
 */
const QUOTA_SIGNS = [
  /no credits remaining/i,
  /insufficient_quota/i,
  /credit balance is too low/i,
  /exceeded your current quota/i,
  /billing.*(hard limit|not active)/i,
  /quota exceeded/i,
];

export function isQuotaRefusal(err: unknown): boolean {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err ?? "");
  return QUOTA_SIGNS.some((pattern) => pattern.test(text));
}

/**
 * True only when local admission refused the call before provider I/O.
 * Trying an alternate in this case still preserves the one-paid-provider-per-
 * logical-request invariant.
 */
export function isPreProviderPaidRefusal(err: unknown): boolean {
  return (
    err instanceof PaidBudgetExhaustedError ||
    err instanceof CreditGuardCircuitOpenError
  );
}

/**
 * Compatibility wrapper for strict paid routing.
 *
 * Historical behavior retried an actual provider quota/error response on the
 * next paid provider. That could turn one failed request into two external
 * charges. Current behavior uses an alternate ONLY when the first route was
 * rejected locally before any provider I/O. Once a provider request has been
 * submitted, success, rejection, quota, or error is terminal for that logical
 * request and Credit Guard records the evidence.
 */
export class QuotaFailoverProvider implements LLMProvider {
  readonly name: LLMProvider["name"];

  constructor(
    private primary: LLMProvider,
    private alternates: LLMProvider[],
    private onFailover: (from: string, to: string, reason: string) => void =
      () => {},
  ) {
    this.name = primary.name;
  }

  isConfigured(): boolean {
    return this.primary.isConfigured();
  }

  private usable(): LLMProvider[] {
    return this.alternates.filter(
      (provider) =>
        provider.isConfigured() && provider.name !== this.primary.name,
    );
  }

  private async execute<T>(
    invoke: (provider: LLMProvider) => Promise<T>,
  ): Promise<T> {
    try {
      return await invoke(this.primary);
    } catch (error) {
      if (!isPreProviderPaidRefusal(error)) throw error;
      const original = error;
      for (const alternate of this.usable()) {
        this.onFailover(
          this.primary.name,
          alternate.name,
          String((error as Error)?.message ?? error),
        );
        try {
          return await invoke(alternate);
        } catch (alternateError) {
          if (!isPreProviderPaidRefusal(alternateError)) throw alternateError;
        }
      }
      throw original;
    }
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.execute((provider) => provider.generateText(input));
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.execute((provider) => provider.generateJson<T>(input));
  }
}
