import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
} from "../../shared/types.js";
import type { ReadinessLiveProvider } from "../orchestrator/productionReadinessPolicy.js";
import type { RouteLogger } from "./failoverProvider.js";

export type ReadinessProviderRoute = {
  provider: LLMProvider;
  currentProvider: () => ReadinessLiveProvider;
  currentModel: () => string;
};

export type ReadinessProviderPair = {
  lead: ReadinessProviderRoute;
  challenger: ReadinessProviderRoute;
};

function asLiveProvider(name: LLMProvider["name"]): ReadinessLiveProvider {
  if (name === "openai" || name === "anthropic" || name === "free") return name;
  throw new Error(`Readiness review reached offline provider ${name}.`);
}

/**
 * Snapshots the exact route that served a completed judgment. This matters when
 * the two independent reviewers share an AI Time rotator and execute in parallel:
 * a later call must never relabel an earlier review's model.
 */
class ObservedReadinessProvider implements LLMProvider {
  readonly name: LLMProvider["name"];
  private servedProvider: ReadinessLiveProvider;
  private servedModel: string;

  constructor(private readonly inner: LLMProvider) {
    this.name = inner.name;
    this.servedProvider = asLiveProvider(inner.currentProvider?.() ?? inner.name);
    this.servedModel = inner.currentModel?.() ?? this.servedProvider;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  currentProvider(): ReadinessLiveProvider {
    return this.servedProvider;
  }

  currentModel(): string {
    return this.servedModel;
  }

  private capture(): void {
    this.servedProvider = asLiveProvider(
      this.inner.currentProvider?.() ?? this.inner.name,
    );
    this.servedModel = this.inner.currentModel?.() ?? this.servedProvider;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const result = await this.inner.generateText(input);
    this.capture();
    return result;
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const result = await this.inner.generateJson(input);
    this.capture();
    return result;
  }
}

/**
 * Construct two independently stateful reviewers from the same automatic route
 * factory used by every build stage. Each starts at the strongest configured
 * paid model. Under the owner-directed default, Opus remains primary until
 * verified credit/quota exhaustion or permanent unavailability, then Sol
 * serves the judgment before AI Time's strongest available free/local model. Mock and stub providers are never accepted.
 */
export function createReadinessBrainProviders(
  makeProvider: () => LLMProvider,
  log: RouteLogger = () => {},
): ReadinessProviderPair {
  const makeRoute = (reviewer: "lead" | "challenger"): ReadinessProviderRoute => {
    const observed = new ObservedReadinessProvider(makeProvider());
    if (!observed.isConfigured()) {
      throw new Error(`No live model route is configured for the ${reviewer} review.`);
    }
    log(
      "info",
      `[readiness] ${reviewer} starts on the automatic model ladder; paid exhaustion continues to the AI Time free/local rung.`,
    );
    return {
      provider: observed,
      currentProvider: () => observed.currentProvider(),
      currentModel: () => observed.currentModel(),
    };
  };

  return {
    lead: makeRoute("lead"),
    challenger: makeRoute("challenger"),
  };
}
