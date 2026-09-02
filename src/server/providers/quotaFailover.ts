import type { LLMProvider } from "../../shared/types.js";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
} from "../../shared/types.js";
import { PaidBudgetExhaustedError } from "./paidBudget.js";
import { ProviderAbortError } from "./types.js";

/**
 * A credit/quota wall is routing state, not a failed build. The ladder starts
 * at the strongest configured paid model and demotes through weaker providers,
 * ending at the strongest available free/local rotation rung.
 */

const QUOTA_SIGNS = [
  /no credits remaining/i,
  /insufficient_quota/i,
  /credit balance is too low/i,
  /exceeded your current quota/i,
  /billing.*(hard limit|not active)/i,
  /quota exceeded/i,
];

const MODEL_EXHAUSTION_SIGNS = [
  ...QUOTA_SIGNS,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /capacity/i,
  /temporarily unavailable/i,
  /model (?:is )?(?:unavailable|disabled|exhausted)/i,
  /model_not_found/i,
  /model not found/i,
  /does not exist or you do not have access/i,
  /not supported.*model/i,
];

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name} ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err ?? "");
  } catch {
    return String(err);
  }
}

export function isQuotaRefusal(err: unknown): boolean {
  const text = errorText(err);
  return QUOTA_SIGNS.some((rx) => rx.test(text));
}

/**
 * True only for a route-scoped exhaustion condition where another model can
 * reasonably serve the same request. Authentication failures, malformed
 * requests, cancellation, and arbitrary provider bugs remain loud.
 */
export function isModelExhaustion(err: unknown): boolean {
  if (err instanceof ProviderAbortError) return false;
  if (err instanceof PaidBudgetExhaustedError) return true;
  const status = (err as { status?: unknown })?.status;
  if (status === 402 || status === 429 || status === 529) return true;
  const text = errorText(err);
  return MODEL_EXHAUSTION_SIGNS.some((rx) => rx.test(text));
}

/**
 * One sticky strongest-to-weakest route.
 *
 * After a provider reports exhausted credit/quota/capacity, the cursor advances
 * for the rest of this orchestrated run. That prevents every stage from
 * re-hammering a known-empty account before reaching the provider that can
 * still work. Abort and non-route errors never demote.
 */
export class QuotaFailoverProvider implements LLMProvider {
  readonly name: LLMProvider["name"];
  private readonly providers: LLMProvider[];
  private cursor = 0;

  constructor(
    primary: LLMProvider,
    alternates: LLMProvider[],
    private onFailover: (from: string, to: string, reason: string) => void = () => {},
  ) {
    this.name = primary.name;
    const seen = new Set([primary.name]);
    this.providers = [
      primary,
      ...alternates.filter((provider) => {
        if (seen.has(provider.name)) return false;
        seen.add(provider.name);
        return true;
      }),
    ];
  }

  isConfigured(): boolean {
    return this.providers.some((provider) => provider.isConfigured());
  }

  private nextConfigured(after: number): number | null {
    for (let index = after + 1; index < this.providers.length; index += 1) {
      if (this.providers[index]!.isConfigured()) return index;
    }
    return null;
  }

  private async execute<T>(invoke: (provider: LLMProvider) => Promise<T>): Promise<T> {
    let firstExhaustion: unknown = null;
    for (let index = this.cursor; index < this.providers.length; index += 1) {
      const provider = this.providers[index]!;
      if (!provider.isConfigured()) continue;
      try {
        const result = await invoke(provider);
        this.cursor = index;
        return result;
      } catch (error) {
        if (error instanceof ProviderAbortError || !isModelExhaustion(error)) {
          throw error;
        }
        firstExhaustion ??= error;
        const nextIndex = this.nextConfigured(index);
        if (nextIndex === null) throw firstExhaustion;
        const next = this.providers[nextIndex]!;
        this.onFailover(provider.name, next.name, errorText(error));
        this.cursor = nextIndex;
        index = nextIndex - 1;
      }
    }
    if (firstExhaustion) throw firstExhaustion;
    throw new Error("No configured model remains in the provider ladder.");
  }

  generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.execute((provider) => provider.generateText(input));
  }

  generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.execute((provider) => provider.generateJson<T>(input));
  }
}
