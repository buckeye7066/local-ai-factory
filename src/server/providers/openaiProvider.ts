import OpenAI from "openai";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import {
  withRetry,
  extractJson,
  generateJsonWithRepair,
  JsonExtractionError,
} from "./types.js";
import type { UsageSink } from "./anthropicProvider.js";
import {
  abandonPaidCall,
  PaidBudgetExhaustedError,
  reservePaidCall,
  settlePaidCall,
} from "./paidBudget.js";
import type { ModelIdResolver } from "./modelCatalog.js";

/**
 * openaiProvider.ts — OpenAI via the official SDK's Responses API.
 *
 * Uses `client.responses.create` and reads `output_text`. The API key lives
 * only in this closure; prompts and responses are never logged.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly paidBudgetManaged: boolean;
  private client: OpenAI | null;
  private model: string;
  private onUsage: UsageSink;
  /**
   * Bounds every call this provider makes — the run's own deadline combined
   * with its cancellation signal (see runFactory.ts). Without this, a hung
   * `responses.create()` await was bounded only by the SDK's own default
   * timeout, not by FACTORY_RUN_TIMEOUT_MS or a cancel request.
   */
  private signal?: AbortSignal;
  private readonly resolveModelId?: ModelIdResolver;
  private resolvedModel: Promise<string> | null = null;

  constructor(
    apiKey: string,
    model: string,
    onUsage: UsageSink = () => {},
    signal?: AbortSignal,
    paidBudgetManaged = false,
    resolveModelId?: ModelIdResolver,
  ) {
    // Explicit apiKey AND baseURL — same reasoning as the Anthropic tier. An
    // empty-but-PRESENT OPENAI_BASE_URL in the environment is honoured by the
    // SDK as a literal base URL and produces a connection error, so the paid
    // client must never be built from the environment.
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1" })
      : null;
    this.model = model;
    this.onUsage = onUsage;
    this.signal = signal;
    this.paidBudgetManaged = paidBudgetManaged;
    this.resolveModelId = resolveModelId;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private ensure(): OpenAI {
    if (!this.client) {
      throw new Error("OpenAI provider is not configured (OPENAI_API_KEY missing).");
    }
    return this.client;
  }

  private async bill<T>(
    system: string,
    prompt: string,
    maxTokens: number,
    call: () => Promise<T>,
    usageOf: (response: T) => { inTokens: number; outTokens: number },
    onProviderAttempt: () => void,
  ): Promise<T> {
    const reservation = this.paidBudgetManaged
      ? reservePaidCall(this.name, { system, prompt, maxTokens })
      : null;
    let response: T;
    try {
      onProviderAttempt();
      response = await call();
    } catch (error) {
      if (reservation) abandonPaidCall(reservation);
      throw error;
    }
    const usage = usageOf(response);
    if (reservation) settlePaidCall(reservation, usage);
    try {
      this.onUsage(usage);
    } catch {
      // A telemetry/logging failure occurs after the provider billed and
      // answered. It must not escape into withRetry and duplicate that call.
    }
    return response;
  }

  currentProvider(): LLMProvider["name"] {
    return this.name;
  }

  currentModel(): string {
    return this.model;
  }

  private async modelId(): Promise<string> {
    this.resolvedModel ??= this.resolveModelId
      ? this.resolveModelId(this.model).then((model) => {
          this.model = model;
          return model;
        })
      : Promise.resolve(this.model);
    return this.resolvedModel;
  }

  async prepareCall(): Promise<void> {
    await this.modelId();
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const client = this.ensure();
    let providerAttemptOccurred = false;
    try {
      const text = await withRetry(
        "openai.generateText",
        async () => {
          const model = await this.modelId();
          const maxTokens = input.maxTokens ?? 4096;
          // NOTE: no `temperature` — gpt-5.x reasoning models reject it (400),
          // same as current Claude models. Model defaults are used instead.
          const res = await this.bill(
            input.system,
            input.prompt,
            maxTokens,
            () =>
              client.responses.create(
                {
                  model,
                  instructions: input.system,
                  input: input.prompt,
                  max_output_tokens: maxTokens,
                },
                { signal: this.signal },
              ),
            (response) => ({
              inTokens: response.usage?.input_tokens ?? 0,
              outTokens: response.usage?.output_tokens ?? 0,
            }),
            () => {
              providerAttemptOccurred = true;
            },
          );
          return res.output_text ?? "";
        },
        3,
        this.signal,
      );
      return { text, provider: "openai" };
    } catch (error) {
      if (error instanceof PaidBudgetExhaustedError && providerAttemptOccurred) {
        error.markProviderAttemptOccurred();
      }
      throw error;
    }
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const client = this.ensure();
    let providerAttemptOccurred = false;
    const instructions = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, or any prose outside the JSON.`;

    const callOnce = async (prompt: string, maxTokens: number): Promise<unknown> => {
      const model = await this.modelId();
      // Prefer json_object when the Responses API accepts it; fall back plain.
      try {
        const res = await this.bill(
          instructions,
          prompt,
          maxTokens,
          () =>
            client.responses.create(
              {
                model,
                instructions,
                input: prompt,
                max_output_tokens: maxTokens,
                text: { format: { type: "json_object" } },
              },
              { signal: this.signal },
            ),
          (response) => ({
            inTokens: response.usage?.input_tokens ?? 0,
            outTokens: response.usage?.output_tokens ?? 0,
          }),
          () => {
            providerAttemptOccurred = true;
          },
        );
        return extractJson(res.output_text ?? "");
      } catch (err) {
        // An aborted call must propagate as-is — the format-fallback retry
        // below is for a 400 on `text.format`, not for a deliberate abort.
        if (this.signal?.aborted) throw err;
        // A JSON-level failure is the repair loop's business, not the
        // format-fallback's: re-issuing the same request unformatted would
        // waste a call, and a parse message that happens to contain the word
        // "format" would otherwise trigger exactly that.
        if (err instanceof JsonExtractionError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/format|json_object|text\.format|unsupported/i.test(msg)) {
          const res = await this.bill(
            instructions,
            prompt,
            maxTokens,
            () =>
              client.responses.create(
                {
                  model,
                  instructions,
                  input: prompt,
                  max_output_tokens: maxTokens,
                },
                { signal: this.signal },
              ),
            (response) => ({
              inTokens: response.usage?.input_tokens ?? 0,
              outTokens: response.usage?.output_tokens ?? 0,
            }),
            () => {
              providerAttemptOccurred = true;
            },
          );
          return extractJson(res.output_text ?? "");
        }
        throw err;
      }
    };

    // Two attempts (see anthropicProvider): every extra attempt is billed.
    try {
      return await withRetry(
        "openai.generateJson",
        () =>
          generateJsonWithRepair({
            input,
            attempts: 2,
            baseMaxTokens: input.maxTokens ?? 8192,
            call: callOnce,
          }),
        3,
        this.signal,
      );
    } catch (error) {
      if (error instanceof PaidBudgetExhaustedError && providerAttemptOccurred) {
        error.markProviderAttemptOccurred();
      }
      throw error;
    }
  }
}
