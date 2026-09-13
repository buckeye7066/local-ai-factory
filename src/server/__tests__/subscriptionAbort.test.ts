import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Catalog, Rotator, StateStore } from "../rotation/aitimeRotation.js";
import { RotatingProvider } from "../rotation/rotatingProvider.js";
import { ModelLadderProvider } from "../providers/modelLadderProvider.js";
import { ProviderAbortError } from "../providers/types.js";
import type { LLMProvider } from "../../shared/types.js";

it("propagates subscription cancellation unchanged without any metered fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-abort-"));
  try {
    const catalog = new Catalog([
      {
        id: "cli/codex",
        backend: "codex-cli",
        backend_label: "Codex",
        model: "codex",
        wire_model: "codex",
        api: "codex-cli",
        base_url: "",
        pool: "codex:plan",
        auth_env: "",
        auth_kind: "none",
        cost_class: "subscription",
        tier: "frontier",
        enabled: true,
        disabled_reason: "",
        quota_status: "unknown",
        resets_at: null,
        note: "",
        capabilities: [],
        capabilities_source: "",
      },
    ]);
    const subscription = new RotatingProvider(
      new Rotator(catalog, new StateStore(path.join(dir, "state.json")), "test", true),
      { fccDelegate: null, fccBaseUrl: "" },
    );
    const error = new ProviderAbortError("cancelled");
    vi.spyOn(
      subscription as unknown as { serveOn: () => Promise<string> },
      "serveOn",
    ).mockRejectedValue(error);
    const api = {
      name: "openai",
      isConfigured: () => true,
      generateText: vi.fn(),
      generateJson: vi.fn(),
    } as unknown as LLMProvider;
    const ladder = new ModelLadderProvider([
      {
        model: "subscription:owner",
        provider: subscription,
        advanceOn: "subscription-unavailable",
      },
      { model: "api", provider: api },
    ]);
    await expect(ladder.generateText({ system: "test", prompt: "test" })).rejects.toBe(
      error,
    );
    expect(api.generateText).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
