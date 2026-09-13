import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Catalog,
  Rotator,
  RotationError,
  StateStore,
} from "../rotation/aitimeRotation.js";
import { RotatingProvider } from "../rotation/rotatingProvider.js";

it("reports actual all-pool exhaustion with the typed error the API fallback handles", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-exhaustion-"));
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
    const rotator = new Rotator(
      catalog,
      new StateStore(path.join(dir, "state.json")),
      "test",
      true,
    );
    const provider = new RotatingProvider(rotator, {
      fccDelegate: null,
      fccBaseUrl: "",
    });
    const transport = provider as unknown as { serveOn: () => Promise<string> };
    vi.spyOn(transport, "serveOn").mockRejectedValue(
      Object.assign(new Error("subscription exhausted"), { status: 429 }),
    );
    await expect(
      provider.generateText({ system: "test", prompt: "test" }),
    ).rejects.toBeInstanceOf(RotationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
