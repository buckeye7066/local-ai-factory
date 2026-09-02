import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
} from "../../shared/types.js";
import { isModelExhaustion, modelFailureText } from "./modelExhaustion.js";
import { ProviderAbortError } from "./types.js";

export type ModelLadderRung = {
  model: string;
  provider: LLMProvider;
};

/**
 * One sticky strongest-to-weakest ladder inside a single provider family.
 *
 * The outer provider ladder still owns Anthropic -> OpenAI -> free/local.
 * This layer exhausts configured models within one family first, so a rejected
 * frontier model can fall through to the next paid model without losing family
 * identity or re-hammering the exhausted model at every later stage.
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
      if (!model || seen.has(model)) return false;
      seen.add(model);
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
    return this.rungs[this.cursor]!.model;
  }

  private nextConfigured(after: number): number | null {
    for (let index = after + 1; index < this.rungs.length; index += 1) {
      if (this.rungs[index]!.provider.isConfigured()) return index;
    }
    return null;
  }

  private async execute<T>(invoke: (provider: LLMProvider) => Promise<T>): Promise<T> {
    let firstExhaustion: unknown = null;
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
        firstExhaustion ??= error;
        const nextIndex = this.nextConfigured(index);
        if (nextIndex === null) throw firstExhaustion;
        const next = this.rungs[nextIndex]!;
        this.onFailover(rung.model, next.model, modelFailureText(error));
        this.cursor = nextIndex;
        index = nextIndex - 1;
      }
    }
    if (firstExhaustion) throw firstExhaustion;
    throw new Error("No configured model remains in this provider-family ladder.");
  }

  generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.execute((provider) => provider.generateText(input));
  }

  generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.execute((provider) => provider.generateJson<T>(input));
  }
}
