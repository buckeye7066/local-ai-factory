import { expect, it, vi } from "vitest";
import {
  OwnerCodexProvider,
  type OwnerCodexExecute,
} from "../providers/ownerCodexProvider.js";
const env = {
  FACTORY_OWNER_SUBSCRIPTION_ONLY: "1",
  FACTORY_OWNER_CODEX_HOME: process.cwd() + "/fixture-auth",
  FACTORY_OWNER_CODEX_MODEL: "gpt-6-astra",
  LOCALAPPDATA: process.cwd(),
};
const receipt = {
  ok: true,
  complete: true,
  provider: "subscription:codex",
  billing_mode: "subscription",
  model: "gpt-6-astra",
  raw: "Fixture result",
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 },
};
it("enrollment preserves prompt and verified response metadata", async () => {
  const run = vi.fn<OwnerCodexExecute>().mockResolvedValue(receipt);
  const provider = new OwnerCodexProvider(undefined, env, run);
  expect(
    await provider.generateText({
      system: "system",
      prompt: "Keep the API unchanged.",
    }),
  ).toMatchObject({
    text: "Fixture result",
    provider: "openai",
    billingMode: "subscription",
    model: "gpt-6-astra",
  });
  expect(run.mock.calls[0][0]).toMatchObject({
    providers: ["codex"],
    prompt: "Keep the API unchanged.",
  });
  expect(run.mock.calls[0][1].env.OWNER_AI_CODEX_HOME).toBe(
    env.FACTORY_OWNER_CODEX_HOME,
  );
});
it("unenrolled installation does not invoke the executor", async () => {
  const run = vi.fn<OwnerCodexExecute>().mockResolvedValue(receipt);
  const provider = new OwnerCodexProvider(
    undefined,
    { ...env, FACTORY_OWNER_SUBSCRIPTION_ONLY: "0" },
    run,
  );
  await expect(
    provider.generateText({ system: "", prompt: "request" }),
  ).rejects.toThrow(/not enrolled/);
  expect(run).not.toHaveBeenCalled();
});
it("different billing metadata does not satisfy the subscription contract", async () => {
  const run = vi
    .fn<OwnerCodexExecute>()
    .mockResolvedValue({ ...receipt, billing_mode: "paid_api" });
  await expect(
    new OwnerCodexProvider(undefined, env, run).generateText({
      system: "",
      prompt: "request",
    }),
  ).rejects.toThrow(/No completed/);
});

it("pre-cancelled generation does not invoke the executor", async () => {
  const run = vi.fn<OwnerCodexExecute>().mockResolvedValue(receipt);
  await expect(
    new OwnerCodexProvider(AbortSignal.abort(), env, run).generateText({
      system: "",
      prompt: "request",
    }),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

it("unavailable owner inference reaches configured free fallback", async () => {
  const { ModelLadderProvider } = await import("../providers/modelLadderProvider.js");
  const run = vi.fn<OwnerCodexExecute>().mockResolvedValue(null);
  const free = {
    name: "free" as const,
    isConfigured: () => true,
    generateText: vi.fn(async () => ({
      text: "free result",
      provider: "free" as const,
    })),
    generateJson: vi.fn(),
  };
  const ladder = new ModelLadderProvider([
    {
      model: "subscription:codex",
      provider: new OwnerCodexProvider(undefined, env, run),
      advanceOn: "subscription-unavailable",
    },
    { model: "local", provider: free },
  ]);
  expect(await ladder.generateText({ system: "", prompt: "fixture" })).toMatchObject({
    text: "free result",
  });
  expect(free.generateText).toHaveBeenCalledTimes(1);
});
it("health does not advertise metered rungs for an enrolled owner", async () => {
  const { loadConfig, loadSecrets, toHealth } = await import("../config.js");
  vi.stubEnv("FACTORY_OWNER_SUBSCRIPTION_ONLY", "1");
  vi.stubEnv("FACTORY_OWNER_CODEX_HOME", env.FACTORY_OWNER_CODEX_HOME);
  try {
    const h = toHealth(
      loadConfig({}),
      loadSecrets({ OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture" }),
    );
    expect(h.openaiConfigured).toBe(false);
    expect(h.anthropicConfigured).toBe(false);
    expect(h.providersAvailable).toContain("free");
    expect(h.modelLadder).not.toContain("openai");
    expect(h.modelLadder).not.toContain("anthropic");
    expect(h).toMatchObject({
      ownerSubscriptionConfigured: true,
      ownerMeteredFallback: false,
    });
    expect(JSON.stringify(h)).not.toContain(env.FACTORY_OWNER_CODEX_HOME);
  } finally {
    vi.unstubAllEnvs();
  }
});
it("a completed reasoning event is not user output and does not invalidate the final answer", async () => {
  const runtimeUrl = new URL("../../../tools/owner-ai/officialCli.mjs", import.meta.url)
    .href;
  const { parseResult } = await import(runtimeUrl);
  const events = [
    { type: "thread.started" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { type: "reasoning", text: "private reasoning summary" },
    },
    { type: "item.completed", item: { type: "agent_message", text: "final answer" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 4 },
    },
  ];
  expect(
    parseResult(
      "codex",
      events.map((e) => JSON.stringify(e)).join("\n"),
      "gpt-6-astra",
    ),
  ).toMatchObject({ raw: "final answer", billing_mode: "subscription" });
  events[2]!.item!.type = "command_execution";
  expect(
    parseResult(
      "codex",
      events.map((e) => JSON.stringify(e)).join("\n"),
      "gpt-6-astra",
    ),
  ).toBeNull();
});

it("the concrete subscription provider remains attributed to OpenAI rather than free capacity", () => {
  const provider = new OwnerCodexProvider(
    undefined,
    env,
    vi.fn<OwnerCodexExecute>().mockResolvedValue(receipt),
  );
  expect(provider.name).toBe("openai");
  expect(provider.paidBudgetManaged).toBe(true);
});
it("completed Codex receipts do not confuse advisory tokens with provider truncation", async () => {
  const runtimeUrl = new URL("../../../tools/owner-ai/officialCli.mjs", import.meta.url)
    .href;
  const { executeJob, cliArguments } = await import(runtimeUrl);
  const args = cliArguments("codex", env);
  const features = args
    .flatMap((value: string, index: number) =>
      value === "--disable" ? [args[index + 1] + " experimental false"] : [],
    )
    .join("\n");
  const events = [
    { type: "thread.started" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "complete" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 200 },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const run = vi.fn(async (_exe: string, a: string[]) =>
    a.includes("--help")
      ? args.join(" ") + " --config"
      : a[0] === "features"
        ? features
        : a[0] === "login"
          ? "Logged in using ChatGPT"
          : events,
  );
  const result = await executeJob(
    {
      providers: ["codex"],
      system: "fixture",
      prompt: "fixture",
      format: "text",
      maxTokens: 100,
      timeoutMs: 1000,
    },
    { env: { ...env, OWNER_AI_CODEX_HOME: env.FACTORY_OWNER_CODEX_HOME }, run },
  );
  expect(result).toMatchObject({
    complete: true,
    raw: "complete",
    usage: { output_tokens: 200 },
  });
});
