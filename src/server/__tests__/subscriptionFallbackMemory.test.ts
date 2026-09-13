import { expect, it, vi } from "vitest";
import { RotationError } from "../rotation/aitimeRotation.js";
import { ModelLadderProvider } from "../providers/modelLadderProvider.js";
import type { LLMProvider } from "../../shared/types.js";

it("rechecks subscriptions without reprobing already exhausted API accounts", async () => {
  const sub = {
    name: "free",
    isConfigured: () => true,
    generateText: vi.fn().mockRejectedValue(new RotationError("plan exhausted")),
    generateJson: vi.fn(),
  } as unknown as LLMProvider;
  const first = {
    name: "anthropic",
    isConfigured: () => true,
    generateText: vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("insufficient credit"), { status: 402 }),
      ),
    generateJson: vi.fn(),
  } as unknown as LLMProvider;
  const second = {
    name: "openai",
    isConfigured: () => true,
    generateText: vi.fn().mockResolvedValue({ text: "api result" }),
    generateJson: vi.fn(),
  } as unknown as LLMProvider;
  const ladder = new ModelLadderProvider([
    {
      model: "subscription:owner",
      provider: sub,
      advanceOn: "subscription-unavailable",
    },
    { model: "api-a", provider: first },
    { model: "api-b", provider: second },
  ]);
  for (let i = 0; i < 2; i++)
    await ladder.generateText({ system: "test", prompt: "test" });
  expect(sub.generateText).toHaveBeenCalledTimes(2);
  expect(first.generateText).toHaveBeenCalledTimes(1);
  expect(second.generateText).toHaveBeenCalledTimes(2);
});
