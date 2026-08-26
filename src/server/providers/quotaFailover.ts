import type { LLMProvider } from "../../shared/types.js";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
} from "../../shared/types.js";

/**
 * quotaFailover.ts — a provider running out of credit must not kill the work.
 *
 * Owner rule 2026-08-16: "errors are to be fixed not blocked." A pinned
 * provider answering 429 "You have no credits remaining" ended three epic
 * slices outright, while a second funded provider sat unused in the same
 * registry. A quota wall is not a defect in the build — it is a routing fact,
 * and routing is something the factory can fix by itself.
 *
 * Scope is deliberately narrow: ONLY quota/credit/billing refusals fail over.
 * A genuine 400 (bad request, bad model, invalid params) still fails loudly,
 * because retrying that on another provider hides a real bug.
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
      ? `${err.message}`
      : typeof err === "string"
        ? err
        : JSON.stringify(err ?? "");
  return QUOTA_SIGNS.some((rx) => rx.test(text));
}

/**
 * Wrap a primary provider so a quota refusal transparently retries on the
 * first alternate that is configured. Reports which provider actually served,
 * so spend and attribution never lie.
 */
export class QuotaFailoverProvider implements LLMProvider {
  readonly name: LLMProvider["name"];

  constructor(
    private primary: LLMProvider,
    private alternates: LLMProvider[],
    private onFailover: (from: string, to: string, reason: string) => void = () => {},
  ) {
    this.name = primary.name;
  }

  isConfigured(): boolean {
    return this.primary.isConfigured();
  }

  private usable(): LLMProvider[] {
    return this.alternates.filter(
      (p) => p.isConfigured() && p.name !== this.primary.name,
    );
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    try {
      return await this.primary.generateText(input);
    } catch (err) {
      if (!isQuotaRefusal(err)) throw err;
      for (const alt of this.usable()) {
        this.onFailover(
          this.primary.name,
          alt.name,
          String((err as Error)?.message ?? err),
        );
        try {
          return await alt.generateText(input);
        } catch (inner) {
          if (!isQuotaRefusal(inner)) throw inner;
        }
      }
      throw err;
    }
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    try {
      return await this.primary.generateJson<T>(input);
    } catch (err) {
      if (!isQuotaRefusal(err)) throw err;
      for (const alt of this.usable()) {
        this.onFailover(
          this.primary.name,
          alt.name,
          String((err as Error)?.message ?? err),
        );
        try {
          return await alt.generateJson<T>(input);
        } catch (inner) {
          if (!isQuotaRefusal(inner)) throw inner;
        }
      }
      throw err;
    }
  }
}
