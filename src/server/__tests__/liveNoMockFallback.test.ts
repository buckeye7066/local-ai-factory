import { describe, it, expect } from "vitest";
import {
  createProviderRegistry,
  MissingProviderCredentialError,
} from "../providers/index.js";
import { loadConfig, loadSecrets } from "../config.js";
import {
  runFactory,
  MissingProviderCredentialError as RunMissingCred,
  PaidProviderAuthorizationError,
} from "../orchestrator/runFactory.js";

const cfg = loadConfig({});
/**
 * The only genuinely provider-less deck: free route OFF and no paid key.
 *
 * These tests originally treated "no paid key" as "no live provider". That is
 * no longer true — the free route is a live provider — so the fail-closed
 * cases below switch the free route off explicitly. The guarantee they protect
 * is unchanged and is the important one: a live run must NEVER silently
 * complete on mock/stub.
 */
const noLiveCfg = loadConfig({ FACTORY_FREE_ENABLED: "0" } as NodeJS.ProcessEnv);

describe("live path forbids silent mock fallback", () => {
  it("resolveLive throws with exact missing credential names when nothing is live", () => {
    const reg = createProviderRegistry(noLiveCfg, loadSecrets({}));
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
      noLiveCfg,
      loadSecrets({ OPENAI_API_KEY: "sk-test-openai" }),
    );
    const p = reg.resolveLive("anthropic", "openai");
    expect(p.name).toBe("openai");
    expect(p.name).not.toBe("mock");
    expect(p.name).not.toBe("stub");
  });

  it("resolveLive never returns mock/stub on the FREE route either", () => {
    const reg = createProviderRegistry(cfg, loadSecrets({}));
    const p = reg.resolveLive(undefined, "free");
    expect(p.name).toBe("free");
    expect(p.name).not.toBe("mock");
    expect(p.name).not.toBe("stub");
  });

  it("runFactory live with NO live provider fails closed (no completed mock job)", async () => {
    await expect(
      runFactory({
        idea: "Build a chore tracker",
        options: { demo: false },
        config: noLiveCfg,
        secrets: loadSecrets({}),
      }),
    ).rejects.toBeInstanceOf(RunMissingCred);
  });

  it("runFactory default (no demo flag) with NO live provider fails closed", async () => {
    await expect(
      runFactory({
        idea: "Build a chore tracker",
        options: {},
        config: noLiveCfg,
        secrets: loadSecrets({}),
      }),
    ).rejects.toBeInstanceOf(RunMissingCred);
  });

  it("does not treat a configured paid key as authorization to spend", async () => {
    await expect(
      runFactory({
        idea: "Build without surprise billing",
        options: {},
        config: noLiveCfg,
        secrets: loadSecrets({ OPENAI_API_KEY: "sk-test-openai" }),
      }),
    ).rejects.toBeInstanceOf(PaidProviderAuthorizationError);
  });

  it("rejects a paid pin unless the request carries the explicit authorization bit", async () => {
    await expect(
      runFactory({
        idea: "Build without surprise billing",
        options: { codeProvider: "openai", reviewProvider: "openai" },
        config: cfg,
        secrets: loadSecrets({ OPENAI_API_KEY: "sk-test-openai" }),
      }),
    ).rejects.toBeInstanceOf(PaidProviderAuthorizationError);
  });

  it("explicit demo still completes offline (dev path only)", async () => {
    const run = await runFactory({
      idea: "Build a Bible reading habit tracker",
      options: { demo: true },
      config: {
        ...cfg,
        workspaceRoot: `${process.cwd()}/.test-workspaces-live-gate`,
        allowUntrustedScripts: false,
      },
      secrets: loadSecrets({}),
    });
    expect(run.status).toBe("completed");
    expect(run.demo).toBe(true);
    expect(run.codeProvider).toBe("mock");
  });
});
