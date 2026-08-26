/**
 * paidFirst.ts — ONE paid round, then free, for critical stages in auto mode.
 *
 * Owner decision 2026-08-23 (resolves the paid-critical-stage conflict):
 * "If auto mode is selected, then paid models first followed by free. Only do
 * one round, though." A critical stage (spec / architecture / research /
 * planning / final report) therefore gets exactly ONE attempt on the first
 * configured paid provider, through the existing budget gate; if that attempt
 * fails or is refused, the SAME call falls to the free rotator. There is never
 * a second paid attempt for that call and no paid retry loop — the free side
 * handed in here must not carry its own paid rescue tier.
 *
 * Cancel / deadline aborts are not "paid failed": they propagate untouched so
 * a cancelled run is never quietly continued on free.
 */
import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
  ProviderName,
} from "../../shared/types.js";
import { ProviderAbortError } from "./types.js";

export class PaidFirstOneRoundProvider implements LLMProvider {
  readonly name: ProviderName;

  constructor(
    private readonly paid: LLMProvider,
    private readonly free: LLMProvider,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.name = paid.name;
  }

  isConfigured(): boolean {
    return this.paid.isConfigured() || this.free.isConfigured();
  }

  private reason(err: unknown): string {
    return String((err as Error)?.message ?? err)
      .replace(/\s+/g, " ")
      .slice(0, 160);
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    try {
      const out = await this.paid.generateText(input);
      this.log(`paid first: ${this.paid.name} served (one round, budget-gated).`);
      return out;
    } catch (err) {
      if (err instanceof ProviderAbortError) throw err;
      this.log(`paid first: ${this.paid.name} fell to free after ${this.reason(err)}`);
      return this.free.generateText(input);
    }
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    try {
      const out = await this.paid.generateJson(input);
      this.log(
        `paid first: ${this.paid.name} served ${input.schemaName} (one round, budget-gated).`,
      );
      return out;
    } catch (err) {
      if (err instanceof ProviderAbortError) throw err;
      this.log(
        `paid first: ${this.paid.name} fell to free for ${input.schemaName} after ${this.reason(err)}`,
      );
      return this.free.generateJson(input);
    }
  }
}
