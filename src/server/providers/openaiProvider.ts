import OpenAI from "openai";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { withRetry, extractJson } from "./types.js";

/**
 * openaiProvider.ts — OpenAI via the official SDK's Responses API.
 *
 * Uses `client.responses.create` and reads `output_text`. The API key lives
 * only in this closure; prompts and responses are never logged.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  private client: OpenAI | null;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model = model;
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

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const client = this.ensure();
    const text = await withRetry("openai.generateText", async () => {
      // NOTE: no `temperature` — gpt-5.x reasoning models reject it (400),
      // same as current Claude models. Model defaults are used instead.
      const res = await client.responses.create({
        model: this.model,
        instructions: input.system,
        input: input.prompt,
        max_output_tokens: input.maxTokens ?? 4096,
      });
      return res.output_text ?? "";
    });
    return { text, provider: "openai" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const client = this.ensure();
    const instructions = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, or any prose outside the JSON.`;

    const callOnce = async (prompt: string): Promise<unknown> => {
      // Prefer json_object when the Responses API accepts it; fall back plain.
      try {
        const res = await client.responses.create({
          model: this.model,
          instructions,
          input: prompt,
          max_output_tokens: input.maxTokens ?? 8192,
          text: { format: { type: "json_object" } },
        });
        return extractJson(res.output_text ?? "");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/format|json_object|text\.format|unsupported/i.test(msg)) {
          const res = await client.responses.create({
            model: this.model,
            instructions,
            input: prompt,
            max_output_tokens: input.maxTokens ?? 8192,
          });
          return extractJson(res.output_text ?? "");
        }
        throw err;
      }
    };

    return withRetry("openai.generateJson", async () => {
      const raw = await callOnce(input.prompt);
      const first = input.schema.safeParse(raw);
      if (first.success) return first.data;

      // One schema-repair pass — common for live models that invent nested shapes.
      const repairPrompt = `${input.prompt}

Your previous JSON failed schema validation for "${input.schemaName}".
Issues (truncated): ${JSON.stringify(first.error.issues.slice(0, 12))}
Return corrected JSON only.`;
      const repaired = await callOnce(repairPrompt);
      return input.schema.parse(repaired);
    });
  }
}
