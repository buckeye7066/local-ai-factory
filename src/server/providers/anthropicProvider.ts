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
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic | null;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.model = model;
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
