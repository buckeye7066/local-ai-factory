import path from "node:path";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { CliUnavailable } from "./cliProvider.js";
import { generateJsonWithRepair } from "./types.js";

export function ownerSubscriptionOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test(env.FACTORY_OWNER_SUBSCRIPTION_ONLY || "");
}
export interface OwnerCodexResult {
  ok: boolean;
  complete: boolean;
  provider: string;
  billing_mode: string;
  model: string;
  raw: string;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
}
export type OwnerCodexExecute = (
  job: object,
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<OwnerCodexResult | null>;
const officialRuntime = new URL(
  "../../../tools/owner-ai/officialCli.mjs",
  import.meta.url,
).href;
const execute: OwnerCodexExecute = async (job, options) =>
  (await import(officialRuntime)).executeJob(job, options);

/** Local owner enrollment, never a customer-facing subscription proxy. */
export class OwnerCodexProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly paidBudgetManaged = true;
  private readonly model: string;
  constructor(
    private readonly signal?: AbortSignal,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly run: OwnerCodexExecute = execute,
  ) {
    this.model = env.FACTORY_OWNER_CODEX_MODEL || "gpt-6-astra";
  }
  isConfigured(): boolean {
    return (
      ownerSubscriptionOnly(this.env) &&
      path.isAbsolute(this.env.FACTORY_OWNER_CODEX_HOME || "")
    );
  }
  currentProvider(): "openai" {
    return "openai";
  }
  currentModel(): string {
    return this.model;
  }
  private async complete(
    system: string,
    prompt: string,
    format: "text" | "json",
    maxTokens: number,
  ): Promise<OwnerCodexResult> {
    this.signal?.throwIfAborted();
    if (!this.isConfigured())
      throw new CliUnavailable(
        "Owner ChatGPT subscription is not enrolled on this installation",
      );
    const timeout = Number(this.env.FACTORY_OWNER_CODEX_TIMEOUT_MS || 120000);
    const result = await this.run(
      {
        providers: ["codex"],
        system,
        prompt,
        format,
        maxTokens: Math.max(2, Math.min(32000, maxTokens)),
        timeoutMs: Math.max(
          1000,
          Math.min(120000, Number.isFinite(timeout) ? timeout : 120000),
        ),
      },
      {
        env: {
          ...this.env,
          OWNER_AI_CODEX_HOME: this.env.FACTORY_OWNER_CODEX_HOME,
          OWNER_AI_CODEX_MODEL: this.model,
        },
        signal: this.signal,
      },
    );
    this.signal?.throwIfAborted();
    if (
      !result?.ok ||
      !result.complete ||
      result.provider !== "subscription:codex" ||
      result.billing_mode !== "subscription" ||
      result.model !== this.model ||
      !result.raw?.trim()
    ) {
      throw new CliUnavailable(
        "No completed ChatGPT-authenticated subscription response; no metered fallback was used",
      );
    }
    return result;
  }
  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const result = await this.complete(
      input.system,
      input.prompt,
      "text",
      input.maxTokens ?? 8192,
    );
    return {
      text: result.raw,
      provider: "openai",
      billingMode: "subscription",
      model: result.model,
      usage: result.usage,
    };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return generateJsonWithRepair({
      input,
      attempts: 2,
      baseMaxTokens: input.maxTokens ?? 8192,
      call: async (prompt, maxTokens) => {
        const result = await this.complete(
          input.system +
            `\nReturn only a complete JSON object for ${input.schemaName}.`,
          prompt,
          "json",
          maxTokens,
        );
        return JSON.parse(result.raw);
      },
    });
  }
}
