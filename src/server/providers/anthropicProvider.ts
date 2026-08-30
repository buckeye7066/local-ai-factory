import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { extractJson, generateJsonWithRepair } from "./types.js";
import {
  evaluatePaidText,
  runCreditGuardedPaidAttempt,
  type CreditGuardUsage,
} from "./creditGuard.js";

/** Reports token usage for the local estimated-USD ledger and telemetry. */
export type UsageSink = (usage: { inTokens: number; outTokens: number }) => void;

/**
 * anthropicProvider.ts — Claude via the official SDK.
 *
 * Every production call passes through Credit Guard. The SDK itself has zero
 * automatic retries, and this provider performs one billable attempt only.
 * Malformed, empty, refused, or schema-invalid output is recorded as disputed
 * and is never purchased again under the same request fingerprint.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly paidBudgetManaged: boolean;
  private client: Anthropic | null;
  private model: string;
  private onUsage: UsageSink;
  private signal?: AbortSignal;

  constructor(
    apiKey: string,
    model: string,
    onUsage: UsageSink = () => {},
    signal?: AbortSignal,
    paidBudgetManaged = false,
  ) {
    // Explicit key/base URL isolate the paid tier from free-route environment
    // variables. maxRetries=0 prevents the SDK from quietly buying a second
    // attempt behind Credit Guard's back.
    this.client = apiKey
      ? new Anthropic({
          apiKey,
          baseURL: "https://api.anthropic.com",
          maxRetries: 0,
        })
      : null;
    this.model = model;
    this.onUsage = onUsage;
    this.signal = signal;
    this.paidBudgetManaged = paidBudgetManaged;
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

  private noteUsage(usage: CreditGuardUsage): void {
    try {
      this.onUsage(usage);
    } catch {
      // Telemetry happens after the provider has answered. It must never turn
      // into another paid attempt.
    }
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const client = this.ensure();
    const maxTokens = input.maxTokens ?? 4096;
    const text = await runCreditGuardedPaidAttempt({
      provider: "anthropic",
      model: this.model,
      operation: "generateText",
      system: input.system,
      prompt: input.prompt,
      maxTokens,
      intent: input.intent,
      managed: this.paidBudgetManaged,
      call: async () => {
        // Streamed because Anthropic refuses some long non-streaming requests.
        // Credit Guard still sees exactly one SDK attempt.
        const response = await client.messages
          .stream(
            {
              model: this.model,
              max_tokens: maxTokens,
              system: input.system,
              messages: [{ role: "user", content: input.prompt }],
            },
            { signal: this.signal },
          )
          .finalMessage();
        const usage = {
          inTokens: response.usage?.input_tokens ?? 0,
          outTokens: response.usage?.output_tokens ?? 0,
        };
        this.noteUsage(usage);
        const output = response.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        return {
          raw: output,
          responseText: output,
          providerRequestId: response.id ?? null,
          usage,
        };
      },
      evaluate: (output) => evaluatePaidText(output, input.intent),
    });
    return { text, provider: "anthropic" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const client = this.ensure();
    const system = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, shell commands, or any prose outside the JSON.
If a field's value would naturally include setup/install instructions, put that text INSIDE
the appropriate JSON string field. Your entire response must be parseable JSON.`;

    const callOnce = async (prompt: string, maxTokens: number): Promise<unknown> =>
      runCreditGuardedPaidAttempt({
        provider: "anthropic",
        model: this.model,
        operation: "generateJson",
        system,
        prompt,
        maxTokens,
        intent: input.intent,
        managed: this.paidBudgetManaged,
        call: async () => {
          const response = await client.messages
            .stream(
              {
                model: this.model,
                max_tokens: maxTokens,
                system,
                messages: [{ role: "user", content: prompt }],
              },
              { signal: this.signal },
            )
            .finalMessage();
          const usage = {
            inTokens: response.usage?.input_tokens ?? 0,
            outTokens: response.usage?.output_tokens ?? 0,
          };
          this.noteUsage(usage);
          const output = response.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          return {
            raw: output,
            responseText: output,
            providerRequestId: response.id ?? null,
            usage,
          };
        },
        evaluate: (output) => {
          const raw = extractJson(output);
          const parsed = input.schema.safeParse(raw);
          return {
            ok: parsed.success,
            value: raw,
            reason: parsed.success
              ? undefined
              : `${input.schemaName} schema rejection: ${JSON.stringify(
                  parsed.error.issues.slice(0, 12),
                )}`,
          };
        },
        returnRejectedValue: true,
      });

    // Exactly one billable attempt. A bad paid response is evidence for a
    // dispute, not permission to buy a repair response from the same provider.
    return generateJsonWithRepair({
      input,
      attempts: 1,
      baseMaxTokens: input.maxTokens ?? 8192,
      call: callOnce,
    });
  }
}
