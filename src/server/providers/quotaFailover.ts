import type { LLMProvider } from "../../shared/types.js";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
} from "../../shared/types.js";
import { noteFailover, noteRoutePrimary, noteServed } from "./freeRoute.js";
import { ProviderAbortError } from "./types.js";
import { isModelExhaustion, modelFailureText } from "./modelExhaustion.js";
export { isModelExhaustion, isQuotaRefusal } from "./modelExhaustion.js";

/**
 * A credit/quota wall is routing state, not a failed build. The ladder starts
 * at the strongest configured paid model and demotes through weaker providers,
 * ending at the strongest available free/local rotation rung.
 */

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
    noteRoutePrimary(primary.name);
  }

  isConfigured(): boolean {
    return this.providers.some((provider) => provider.isConfigured());
  }

  currentProvider(): LLMProvider["name"] {
    const provider = this.providers[this.cursor]!;
    return provider.currentProvider?.() ?? provider.name;
  }

  currentModel(): string {
    const provider = this.providers[this.cursor]!;
    return provider.currentModel?.() ?? this.currentProvider();
  }

  private nextConfigured(after: number): number | null {
    for (let index = after + 1; index < this.providers.length; index += 1) {
      if (this.providers[index]!.isConfigured()) return index;
    }
    return null;
  }

  private async execute<T>(invoke: (provider: LLMProvider) => Promise<T>): Promise<T> {
    let lastExhaustion: unknown = null;
    for (let index = this.cursor; index < this.providers.length; index += 1) {
      const provider = this.providers[index]!;
      if (!provider.isConfigured()) continue;
      try {
        const result = await invoke(provider);
        this.cursor = index;
        noteServed(provider.name);
        return result;
      } catch (error) {
        if (error instanceof ProviderAbortError || !isModelExhaustion(error)) {
          throw error;
        }
        lastExhaustion = error;
        const nextIndex = this.nextConfigured(index);
        if (nextIndex === null) throw lastExhaustion;
        const next = this.providers[nextIndex]!;
        const reason = modelFailureText(error);
        noteFailover(next.name, reason, provider.name);
        this.onFailover(provider.name, next.name, reason);
        this.cursor = nextIndex;
        index = nextIndex - 1;
      }
    }
    if (lastExhaustion) throw lastExhaustion;
    throw new Error("No configured model remains in the provider ladder.");
  }

  generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.execute((provider) => provider.generateText(input));
  }

  generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.execute((provider) => provider.generateJson<T>(input));
  }
}
