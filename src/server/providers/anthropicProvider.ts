import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { withRetry, extractJson, generateJsonWithRepair } from "./types.js";
import {
  abandonPaidCall,
  reservePaidCall,
  settlePaidCall,
  type PaidCallReservation,
} from "./paidBudget.js";
import type { ModelIdResolver } from "./modelCatalog.js";

/**
 * anthropicProvider.ts — Claude via the official SDK.
 *
 * The API key is captured in this closure only and never logged or returned.
 * JSON mode asks for strict JSON and validates with the caller's Zod schema.
 */
/** Reports token usage for the local estimated-USD ledger and telemetry. */
export type UsageSink = (usage: { inTokens: number; outTokens: number }) => void;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly paidBudgetManaged: boolean;
  private client: Anthropic | null;
  private model: string;
  private onUsage: UsageSink;
  /**
   * Bounds every call this provider makes — the run's own deadline combined
   * with its cancellation signal (see runFactory.ts). Without this, a hung
   * `messages.create()` await was bounded only by the SDK's own default
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
    // Explicit apiKey AND baseURL. This is the PAID tier, and the free route
    // sets ANTHROPIC_BASE_URL-shaped configuration elsewhere in this process;
    // passing both explicitly makes the SDK ignore every credential env var so
    // free-route settings can never leak into a billable call (and vice versa).
    this.client = apiKey
      ? new Anthropic({ apiKey, baseURL: "https://api.anthropic.com" })
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

  private ensure(): Anthropic {
    if (!this.client) {
      throw new Error(
        "Anthropic provider is not configured (ANTHROPIC_API_KEY missing).",
      );
    }
    return this.client;
  }

  private reserve(
    system: string,
    prompt: string,
    maxTokens: number,
  ): PaidCallReservation | null {
    return this.paidBudgetManaged
      ? reservePaidCall(this.name, { system, prompt, maxTokens })
      : null;
  }

  private recordUsage(
    reservation: PaidCallReservation | null,
    usage: { inTokens: number; outTokens: number },
  ): void {
    if (reservation) settlePaidCall(reservation, usage);
    try {
      this.onUsage(usage);
    } catch {
      // Telemetry/logging is non-billable bookkeeping. A sink failure after a
      // successful response must never make withRetry buy the same answer again.
    }
  }

  private abandon(reservation: PaidCallReservation | null): void {
    if (reservation) abandonPaidCall(reservation);
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
    const text = await withRetry(
      "anthropic.generateText",
      async () => {
        const model = await this.modelId();
        // NOTE: no `temperature` — sampling params are rejected (400) on
        // Claude Opus 4.7+/Sonnet 5/Fable 5, so omitting keeps this provider
        // model-agnostic. input.temperature still applies to other providers.
        // Streamed then accumulated: the SDK REFUSES large non-streaming
        // requests ("streaming is strongly recommended for operations that
        // may take longer than 10 minutes") - the first real epic's 16k-token
        // planning call died on exactly that. finalMessage() returns the same
        // Message shape, so nothing downstream changes.
        const maxTokens = input.maxTokens ?? 4096;
        const reservation = this.reserve(input.system, input.prompt, maxTokens);
        let res;
        try {
          res = await client.messages
            .stream(
              {
                model,
                max_tokens: maxTokens,
                system: input.system,
                messages: [{ role: "user", content: input.prompt }],
              },
              { signal: this.signal },
            )
            .finalMessage();
        } catch (error) {
          this.abandon(reservation);
          throw error;
        }
        this.recordUsage(reservation, {
          inTokens: res.usage?.input_tokens ?? 0,
          outTokens: res.usage?.output_tokens ?? 0,
        });
        return res.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
      },
      3,
      this.signal,
    );
    return { text, provider: "anthropic" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const client = this.ensure();
    const system = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, shell commands, or any prose outside the JSON.
If a field's value would naturally include setup/install instructions (e.g. npm commands),
put that text INSIDE the appropriate JSON string field -- never emit it as bare text or a
fenced code block outside the JSON object. Your entire response must be parseable by
JSON.parse() as-is.`;

    const callOnce = async (prompt: string, maxTokens: number): Promise<unknown> => {
      const model = await this.modelId();
      // Streamed for the same reason as generateText - large max_tokens
      // non-streaming calls are refused by the SDK outright.
      const reservation = this.reserve(system, prompt, maxTokens);
      let res;
      try {
        res = await client.messages
          .stream(
            {
              model,
              max_tokens: maxTokens,
              system,
              messages: [{ role: "user", content: prompt }],
            },
            { signal: this.signal },
          )
          .finalMessage();
      } catch (error) {
        this.abandon(reservation);
        throw error;
      }
      this.recordUsage(reservation, {
        inTokens: res.usage?.input_tokens ?? 0,
        outTokens: res.usage?.output_tokens ?? 0,
      });
      const text = res.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return extractJson(text);
    };

    // Two attempts: a frontier model rarely answers in prose, and every extra
    // attempt here is billed. `withRetry` still wraps this for transport faults.
    return withRetry(
      "anthropic.generateJson",
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
  }
}
