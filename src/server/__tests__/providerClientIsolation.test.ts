import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructors = vi.hoisted(() => ({
  anthropic: [] as Array<Record<string, unknown>>,
  openai: [] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {};
    models = {};
    constructor(options: Record<string, unknown>) {
      constructors.anthropic.push(options);
    }
  }
  return { default: FakeAnthropic };
});

vi.mock("openai", () => {
  class FakeOpenAI {
    responses = {};
    models = {};
    constructor(options: Record<string, unknown>) {
      constructors.openai.push(options);
    }
  }
  return { default: FakeOpenAI };
});

import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { OpenAIProvider } from "../providers/openaiProvider.js";
import {
  createAnthropicModelResolver,
  createOpenAiModelResolver,
} from "../providers/modelCatalog.js";

describe("paid SDK clients isolate retries and ambient tenant configuration", () => {
  beforeEach(() => {
    constructors.anthropic.length = 0;
    constructors.openai.length = 0;
  });

  afterEach(() => vi.unstubAllEnvs());

  it("configures generation and catalog clients with one explicit retry owner", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-anthropic-token");
    vi.stubEnv("OPENAI_ORG_ID", "ambient-organization");
    vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");

    new AnthropicProvider("anthropic-key", "claude-test");
    createAnthropicModelResolver({
      apiKey: "anthropic-key",
      preferred: ["claude-test"],
      log: () => {},
    });
    new OpenAIProvider("openai-key", "gpt-test");
    createOpenAiModelResolver({
      apiKey: "openai-key",
      preferred: ["gpt-test"],
      log: () => {},
    });

    expect(constructors.anthropic).toHaveLength(2);
    for (const options of constructors.anthropic) {
      expect(options).toMatchObject({
        apiKey: "anthropic-key",
        authToken: null,
        baseURL: "https://api.anthropic.com",
        maxRetries: 0,
      });
    }
    expect(constructors.openai).toHaveLength(2);
    for (const options of constructors.openai) {
      expect(options).toMatchObject({
        apiKey: "openai-key",
        baseURL: "https://api.openai.com/v1",
        organization: null,
        project: null,
        maxRetries: 0,
      });
    }
  });
});
