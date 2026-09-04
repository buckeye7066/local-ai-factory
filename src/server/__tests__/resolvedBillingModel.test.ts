import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { OpenAIProvider } from "../providers/openaiProvider.js";

describe("paid usage identifies the API-reported serving model", () => {
  it("reports Anthropic's response model instead of its requested catalog pin", async () => {
    const observed: Array<{
      usage: { inTokens: number; outTokens: number };
      model: string;
    }> = [];
    const provider = new AnthropicProvider(
      "sk-test",
      "claude-haiku-4-5",
      (usage, model) => observed.push({ usage, model }),
      undefined,
      false,
      async (requested) => {
        expect(requested).toBe("claude-haiku-4-5");
        return "claude-haiku-4-5-20251001";
      },
    );
    const requests: Array<{ model: string }> = [];
    (
      provider as unknown as {
        client: {
          messages: {
            stream: (request: { model: string }) => {
              finalMessage: () => Promise<{
                model: string;
                usage: { input_tokens: number; output_tokens: number };
                content: Array<{ type: "text"; text: string }>;
              }>;
            };
          };
        };
      }
    ).client = {
      messages: {
        stream: (request) => {
          requests.push(request);
          return {
            finalMessage: async () => ({
              model: "claude-haiku-4-5-20251002",
              usage: { input_tokens: 11, output_tokens: 7 },
              content: [{ type: "text", text: "ok" }],
            }),
          };
        },
      },
    };

    await expect(
      provider.generateText({ system: "system", prompt: "prompt" }),
    ).resolves.toEqual({ text: "ok", provider: "anthropic" });
    expect(requests.map(({ model }) => model)).toEqual(["claude-haiku-4-5-20251001"]);
    expect(observed).toEqual([
      {
        usage: { inTokens: 11, outTokens: 7 },
        model: "claude-haiku-4-5-20251002",
      },
    ]);
    expect(provider.currentModel()).toBe("claude-haiku-4-5-20251002");
  });

  it("reports OpenAI's response model instead of its requested catalog pin", async () => {
    const observed: Array<{
      usage: { inTokens: number; outTokens: number };
      model: string;
    }> = [];
    const provider = new OpenAIProvider(
      "sk-test",
      "gpt-4.1",
      (usage, model) => observed.push({ usage, model }),
      undefined,
      false,
      async (requested) => {
        expect(requested).toBe("gpt-4.1");
        return "gpt-4.1-2025-04-14";
      },
    );
    const requests: Array<{ model: string }> = [];
    (
      provider as unknown as {
        client: {
          responses: {
            create: (request: { model: string }) => Promise<{
              model: string;
              usage: { input_tokens: number; output_tokens: number };
              output_text: string;
            }>;
          };
        };
      }
    ).client = {
      responses: {
        create: async (request) => {
          requests.push(request);
          return {
            model: "gpt-4.1-2025-04-15",
            usage: { input_tokens: 13, output_tokens: 5 },
            output_text: "ok",
          };
        },
      },
    };

    await expect(
      provider.generateText({ system: "system", prompt: "prompt" }),
    ).resolves.toEqual({ text: "ok", provider: "openai" });
    expect(requests.map(({ model }) => model)).toEqual(["gpt-4.1-2025-04-14"]);
    expect(observed).toEqual([
      {
        usage: { inTokens: 13, outTokens: 5 },
        model: "gpt-4.1-2025-04-15",
      },
    ]);
    expect(provider.currentModel()).toBe("gpt-4.1-2025-04-15");
  });
});
