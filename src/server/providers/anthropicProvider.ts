import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { withRetry, extractJson } from "./types.js";

/**
 * anthropicProvider.ts — Claude via the official SDK.
 *
 * The API key is captured in this closure only and never logged or returned.
 * JSON mode asks for strict JSON and validates with the caller's Zod schema.
 */
/** Reports token usage for one paid call, so the spend ceiling can see it. */
export type UsageSink = (usage: { inTokens: number; outTokens: number }) => void;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic | null;
  private model: string;
  private onUsage: UsageSink;

  constructor(apiKey: string, model: string, onUsage: UsageSink = () => {}) {
    // Explicit apiKey AND baseURL. This is the PAID tier, and the free route
    // sets ANTHROPIC_BASE_URL-shaped configuration elsewhere in this process;
    // passing both explicitly makes the SDK ignore every credential env var so
    // free-route settings can never leak into a billable call (and vice versa).
    this.client = apiKey
      ? new Anthropic({ apiKey, baseURL: "https://api.anthropic.com" })
      : null;
    this.model = model;
    this.onUsage = onUsage;
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

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const client = this.ensure();
    const text = await withRetry("anthropic.generateText", async () => {
      // NOTE: no `temperature` — sampling params are rejected (400) on
      // Claude Opus 4.7+/Sonnet 5/Fable 5, so omitting keeps this provider
      // model-agnostic. input.temperature still applies to other providers.
      const res = await client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? 4096,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      });
      this.onUsage({
        inTokens: res.usage?.input_tokens ?? 0,
        outTokens: res.usage?.output_tokens ?? 0,
      });
      return res.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    });
    return { text, provider: "anthropic" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const client = this.ensure();
    const system = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, or any prose outside the JSON.`;

    const callOnce = async (prompt: string): Promise<unknown> => {
      const res = await client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? 8192,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      this.onUsage({
        inTokens: res.usage?.input_tokens ?? 0,
        outTokens: res.usage?.output_tokens ?? 0,
      });
      const text = res.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return extractJson(text);
    };

    return withRetry("anthropic.generateJson", async () => {
      const raw = await callOnce(input.prompt);
      const first = input.schema.safeParse(raw);
      if (first.success) return first.data;
      const repairPrompt = `${input.prompt}

Your previous JSON failed schema validation for "${input.schemaName}".
Issues (truncated): ${JSON.stringify(first.error.issues.slice(0, 12))}
Return corrected JSON only.`;
      const repaired = await callOnce(repairPrompt);
      return input.schema.parse(repaired);
    });
  }
}
