import { describe, it, expect } from "vitest";
import {
  createProviderRegistry,
  MissingProviderCredentialError,
} from "../providers/index.js";
import { loadConfig, loadSecrets } from "../config.js";
import {
  runFactory,
  MissingProviderCredentialError as RunMissingCred,
} from "../orchestrator/runFactory.js";

const cfg = loadConfig({});

describe("live path forbids silent mock fallback", () => {
  it("resolveLive throws with exact missing credential names when no paid keys", () => {
    const reg = createProviderRegistry(cfg, loadSecrets({}));
    expect(() => reg.resolveLive("anthropic", "anthropic")).toThrow(
      MissingProviderCredentialError,
    );
    try {
      reg.resolveLive("anthropic", "anthropic");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingProviderCredentialError);
      const e = err as MissingProviderCredentialError;
      expect(e.missing).toContain("ANTHROPIC_API_KEY");
      expect(e.missing).toContain("OPENAI_API_KEY");
      expect(e.message).toMatch(/ANTHROPIC_API_KEY/);
    }
  });

  it("resolveLive never returns mock/stub when a paid key exists", () => {
    const reg = createProviderRegistry(
      cfg,
      loadSecrets({ OPENAI_API_KEY: "sk-test-openai" }),
    );
    const p = reg.resolveLive("anthropic", "openai");
    expect(p.name).toBe("openai");
    expect(p.name).not.toBe("mock");
    expect(p.name).not.toBe("stub");
  });

  it("runFactory live without keys fails closed (no completed mock job)", async () => {
    await expect(
      runFactory({
        idea: "Build a chore tracker",
        options: { demo: false },
        config: cfg,
        secrets: loadSecrets({}),
      }),
    ).rejects.toBeInstanceOf(RunMissingCred);
  });

  it("runFactory default (no demo flag) without keys fails closed", async () => {
    await expect(
      runFactory({
        idea: "Build a chore tracker",
        options: {},
        config: cfg,
        secrets: loadSecrets({}),
      }),
    ).rejects.toBeInstanceOf(RunMissingCred);
  });

  it("explicit demo still completes offline (dev path only)", async () => {
    const run = await runFactory({
      idea: "Build a Bible reading habit tracker",
      options: { demo: true },
      config: { ...cfg, workspaceRoot: `${process.cwd()}/.test-workspaces-live-gate` },
      secrets: loadSecrets({}),
    });
    expect(run.status).toBe("completed");
    expect(run.demo).toBe(true);
    expect(run.codeProvider).toBe("mock");
  });
});
