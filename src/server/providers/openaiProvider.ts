import OpenAI from "openai";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { extractJson, generateJsonWithRepair } from "./types.js";
import type { UsageSink } from "./anthropicProvider.js";
import {
  evaluatePaidText,
  runCreditGuardedPaidAttempt,
  type CreditGuardUsage,
} from "./creditGuard.js";

/**
 * openaiProvider.ts — OpenAI via the official SDK's Responses API.
 *
 * Every production call passes through Credit Guard. The SDK itself has zero
 * automatic retries, and this provider performs one billable attempt only.
 * Malformed, empty, refused, or schema-invalid output is recorded as disputed
 * and is never purchased again under the same request fingerprint.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly paidBudgetManaged: boolean;
  private client: OpenAI | null;
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
      ? new OpenAI({
          apiKey,
          baseURL: "https://api.openai.com/v1",
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

  private ensure(): OpenAI {
    if (!this.client) {
      throw new Error("OpenAI provider is not configured (OPENAI_API_KEY missing).");
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
      provider: "openai",
      model: this.model,
      operation: "generateText",
      system: input.system,
      prompt: input.prompt,
      maxTokens,
      intent: input.intent,
      managed: this.paidBudgetManaged,
      call: async () => {
        const response = await client.responses.create(
          {
            model: this.model,
            instructions: input.system,
            input: input.prompt,
            max_output_tokens: maxTokens,
          },
          { signal: this.signal },
        );
        const usage = {
          inTokens: response.usage?.input_tokens ?? 0,
          outTokens: response.usage?.output_tokens ?? 0,
        };
        this.noteUsage(usage);
        const output = response.output_text ?? "";
        const request = response as {
          id?: string;
          _request_id?: string;
        };
        return {
          raw: output,
          responseText: output,
          providerRequestId: request._request_id ?? request.id ?? null,
          usage,
        };
      },
      evaluate: (output) => evaluatePaidText(output, input.intent),
    });
    return { text, provider: "openai" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const client = this.ensure();
    const instructions = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, or any prose outside the JSON.`;

    const callOnce = async (prompt: string, maxTokens: number): Promise<unknown> =>
      runCreditGuardedPaidAttempt({
        provider: "openai",
        model: this.model,
        operation: "generateJson",
        system: instructions,
        prompt,
        maxTokens,
        intent: input.intent,
        managed: this.paidBudgetManaged,
        call: async () => {
          // Plain Responses output is deliberate. The former json_object then
          // format-fallback path could buy two calls for one request when a
          // model rejected that option. The prompt plus local parser/schema is
          // the single-attempt contract now.
          const response = await client.responses.create(
            {
              model: this.model,
              instructions,
              input: prompt,
              max_output_tokens: maxTokens,
            },
            { signal: this.signal },
          );
          const usage = {
            inTokens: response.usage?.input_tokens ?? 0,
            outTokens: response.usage?.output_tokens ?? 0,
          };
          this.noteUsage(usage);
          const output = response.output_text ?? "";
          const request = response as {
            id?: string;
            _request_id?: string;
          };
          return {
            raw: output,
            responseText: output,
            providerRequestId: request._request_id ?? request.id ?? null,
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
