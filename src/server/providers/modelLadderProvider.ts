import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
} from "../../shared/types.js";
import {
  isModelExhaustion,
  isPaidBudgetExhaustion,
  isQuotaRefusal,
  modelFailureText,
} from "./modelExhaustion.js";
import { ProviderAbortError } from "./types.js";

export type ModelLadderRung = {
  model: string;
  provider: LLMProvider;
};

/**
 * One sticky strongest-to-weakest model ladder.
 *
 * Most callers use this inside one provider family. Readiness review also uses
 * it across paid families so the mandatory judgment follows the same ordered
 * paid route as the build instead of dying at an arbitrary provider boundary.
 */
export class ModelLadderProvider implements LLMProvider {
  readonly name: LLMProvider["name"];
  readonly paidBudgetManaged: boolean;
  private readonly rungs: ModelLadderRung[];
  private cursor = 0;

  constructor(
    rungs: ModelLadderRung[],
    private onFailover: (from: string, to: string, reason: string) => void = () => {},
  ) {
    const seen = new Set<string>();
    this.rungs = rungs.filter((rung) => {
      const model = rung.model.trim();
      const key = `${rung.provider.name}:${model}`;
      if (!model || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (this.rungs.length === 0) {
      throw new Error("A model ladder requires at least one model rung.");
    }
    this.name = this.rungs[0]!.provider.name;
    this.paidBudgetManaged = this.rungs.every(
      (rung) => rung.provider.paidBudgetManaged === true,
    );
  }

  isConfigured(): boolean {
    return this.rungs.some((rung) => rung.provider.isConfigured());
  }

  currentModel(): string {
    const rung = this.rungs[this.cursor]!;
    return rung.provider.currentModel?.() ?? rung.model;
  }

  /** Actual provider family serving the current rung after any failover. */
  currentProvider(): LLMProvider["name"] {
    return this.rungs[this.cursor]!.provider.name;
  }

  private nextConfigured(
    after: number,
    excludedProviders: ReadonlySet<LLMProvider["name"]> = new Set(),
  ): number | null {
    for (let index = after + 1; index < this.rungs.length; index += 1) {
      const candidate = this.rungs[index]!.provider;
      if (candidate.isConfigured() && !excludedProviders.has(candidate.name)) {
        return index;
      }
    }
    return null;
  }

  private async execute<T>(invoke: (provider: LLMProvider) => Promise<T>): Promise<T> {
    let lastExhaustion: unknown = null;
    for (let index = this.cursor; index < this.rungs.length; index += 1) {
      const rung = this.rungs[index]!;
      if (!rung.provider.isConfigured()) continue;
      try {
        const result = await invoke(rung.provider);
        this.cursor = index;
        return result;
      } catch (error) {
        if (error instanceof ProviderAbortError || !isModelExhaustion(error)) {
          throw error;
        }
        lastExhaustion = error;
        // An account/credit refusal applies to the whole provider account, not
        // one model ID. Probing every remaining same-family rung only repeats a
        // billable refusal. Model-scoped availability and capacity failures do
        // still walk the configured family ladder.
        const excludedProviders = isPaidBudgetExhaustion(error)
          ? new Set<LLMProvider["name"]>(["anthropic", "openai"])
          : isQuotaRefusal(error)
            ? new Set<LLMProvider["name"]>([rung.provider.name])
            : undefined;
        const nextIndex = this.nextConfigured(index, excludedProviders);
        if (nextIndex === null) throw lastExhaustion;
        const next = this.rungs[nextIndex]!;
        this.onFailover(
          rung.provider.currentModel?.() ?? rung.model,
          next.provider.currentModel?.() ?? next.model,
          modelFailureText(error),
        );
        this.cursor = nextIndex;
        index = nextIndex - 1;
      }
    }
    if (lastExhaustion) throw lastExhaustion;
    throw new Error(
      "No configured model remains in the automatic paid-to-free ladder.",
    );
  }

  generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.execute((provider) => provider.generateText(input));
  }

  generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.execute((provider) => provider.generateJson<T>(input));
  }
}
