import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProviderRegistry } from "../providers/index.js";
import { loadConfig, loadSecrets } from "../config.js";
import * as rotation from "../rotation/aitimeRotation.js";
import * as providers from "../rotation/rotatingProvider.js";
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
it.each(["environment", "factory-deck", "purpose-foundry", "global"])(
  "honors %s pins instead of silently substituting a subscription",
  async (scope) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-pin-"));
    temporary.push(dir);
    const store = new rotation.StateStore(path.join(dir, "state.json"));
    const catalog = new rotation.Catalog([
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
    const app = scope === "purpose-foundry" ? scope : "factory-deck";
    const rotator = new rotation.Rotator(catalog, store, app);
    if (scope === "environment") vi.stubEnv("AI_ROTATE_PIN", "missing-explicit-target");
    else
      await store.update((state) => {
        state.pin = { [scope]: "missing-explicit-target" };
      });
    vi.spyOn(rotation, "buildRotator").mockReturnValue(rotator);
    vi.spyOn(providers, "filterRoutableCatalog").mockImplementation((r) => r);
    const serve = vi
      .spyOn(
        providers.RotatingProvider.prototype as unknown as {
          serveOn: () => Promise<string>;
        },
        "serveOn",
      )
      .mockResolvedValue("must-not-run");
    const registry = createProviderRegistry(
      loadConfig({}),
      loadSecrets({}),
      () => {},
      undefined,
      app,
    );
    const first = registry.automaticRungs!()[0];
    expect(first.model).toBe("subscription:owner");
    await expect(
      first.provider.generateText({ system: "test", prompt: "test" }),
    ).rejects.toBeInstanceOf(rotation.PinUnavailable);
    expect(serve).not.toHaveBeenCalled();
  },
);
