import { resolve } from "node:path";
import { rm, readFile, access, mkdir } from "node:fs/promises";
import { describe, it, expect, afterAll, beforeAll } from "vitest";

const tmpRoot = resolve(process.cwd(), ".test-workspaces-mock");
const tmpData = resolve(process.cwd(), ".test-factory-data-mock");

// MUST be set before importing storage modules (they capture DATA_ROOT at load).
process.env.FACTORY_DATA_DIR = tmpData;
await mkdir(tmpData, { recursive: true });
await rm(resolve(tmpData, "audit"), {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
});

const { runFactory } = await import("../orchestrator/runFactory.js");
const { loadConfig, loadSecrets, toHealth } = await import("../config.js");
const { createProviderRegistry } = await import("../providers/index.js");
const { MockProvider } = await import("../providers/mockProvider.js");
const { verifyAuditChain, _resetAuditCursorForTests } = await import(
  "../storage/auditLog.js"
);
const { rollbackWorkspace } = await import("../workspace/cleanup.js");
const { loadReadinessState } = await import("../storage/readinessStore.js");
const { ProductSpecSchema, QaReportSchema } = await import("../../shared/schemas.js");

beforeAll(async () => {
  _resetAuditCursorForTests();
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(tmpData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  delete process.env.FACTORY_DATA_DIR;
});

describe("mock provider (#237)", () => {
  it("is always configured with zero keys", () => {
    const reg = createProviderRegistry(loadConfig({}), loadSecrets({}));
    expect(reg.available()).toContain("mock");
    expect(reg.get("mock").isConfigured()).toBe(true);
    // Soft resolve now prefers the FREE route over mock, because free is a
    // real live provider. Mock remains the last resort when nothing is live.
    const noLive = createProviderRegistry(
      loadConfig({ FACTORY_FREE_ENABLED: "0" } as NodeJS.ProcessEnv),
      loadSecrets({}),
    );
    expect(noLive.resolve("anthropic", "anthropic").name).toBe("mock");
  });

  it("returns schema-valid product specs offline", async () => {
    const mock = new MockProvider();
    const spec = await mock.generateJson({
      system: "x",
      prompt: "Build a Bible reading habit tracker",
      schema: ProductSpecSchema,
      schemaName: "ProductSpec",
    });
    expect(spec.appName).toBe("VerseKeeper");
  });
});

describe("control-plane health vs providers (#237)", () => {
  it("reports controlPlaneOk and mockConfigured even with no paid keys", () => {
    const health = toHealth(loadConfig({}), loadSecrets({}));
    expect(health.ok).toBe(true);
    expect(health.controlPlaneOk).toBe(true);
    expect(health.mockConfigured).toBe(true);
    expect(health.anthropicConfigured).toBe(false);
    expect(health.openaiConfigured).toBe(false);
    expect(health.providersAvailable).toContain("mock");
    expect(JSON.stringify(health)).not.toMatch(/sk-/);
  });
});

describe("mock end-to-end job (#242)", () => {
  it("completes a full assembly line with zero paid credits + attribution", async () => {
    _resetAuditCursorForTests();
    await rm(resolve(tmpData, "audit"), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    const config = {
      ...loadConfig({}),
      workspaceRoot: tmpRoot,
      allowUntrustedScripts: false,
      runTimeoutMs: 120_000,
    };
    const run = await runFactory({
      idea: "Build a Bible reading habit tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });

    expect(run.status).toBe("completed");
    expect(run.demo).toBe(true);
    expect(run.codeProvider).toBe("mock");
    expect(run.reviewProvider).toBe("mock");
    expect(run.appName).toBe("VerseKeeper");
    expect(run.repairLoops).toBe(1);
    expect(run.files.length).toBeGreaterThan(3);
    expect(run.finalReport).not.toBeNull();
    expect(run.providerUsage.anthropic.calls).toBe(0);
    expect(run.providerUsage.openai.calls).toBe(0);
    expect(run.providerUsage.mock.calls).toBeGreaterThan(0);
    expect(run.destination?.status).not.toBe("delivered");
    expect(run.release?.released).not.toBe(true);

    const readiness = await loadReadinessState(run.id);
    expect(readiness?.status).toBe("blocked");
    expect(readiness?.receipt?.ready).toBe(false);
    expect(readiness?.reviews).toEqual([]);
    expect(readiness?.blockers).toContain(
      "Demo/mock output cannot be production-ready.",
    );

    // Attribution (#244)
    expect(run.attribution).not.toBeNull();
    expect(run.attribution?.jobId).toBe(run.id);
    expect(run.attribution?.worktreePath).toBe(run.workspacePath);
    expect(run.attribution?.approval.allowUntrustedScripts).toBe(false);
    // Scripts are disabled in this hermetic job, so no test command ever
    // executed — claiming "passing" here was the fabricated-pass defect.
    expect(run.attribution?.testResult).toBe("unknown");
    expect(run.attribution?.commitPath).toBeTruthy();
    expect(run.attribution?.rollbackPath).toBe(run.workspacePath);
    await access(run.attribution!.commitPath!);
    const attrRaw = await readFile(run.attribution!.commitPath!, "utf8");
    const attr = JSON.parse(attrRaw);
    expect(attr.jobId).toBe(run.id);

    const chain = await verifyAuditChain();
    expect(chain.ok).toBe(true);
  });
});

describe("resilience (#243)", () => {
  it("fails cleanly on budget exhaustion without corrupting source", async () => {
    const config = {
      ...loadConfig({}),
      workspaceRoot: tmpRoot,
      allowUntrustedScripts: false,
      maxModelCallsPerRun: 1,
      runTimeoutMs: 60_000,
    };
    const run = await runFactory({
      idea: "Build a chore tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/budget/i);
    expect(run.workspacePath === null || run.workspacePath.startsWith(tmpRoot)).toBe(
      true,
    );
  });

  it("fails cleanly on run timeout", async () => {
    const config = {
      ...loadConfig({}),
      workspaceRoot: tmpRoot,
      allowUntrustedScripts: false,
      runTimeoutMs: 1,
    };
    const run = await runFactory({
      idea: "Build a timer app",
      options: { demo: true, timeoutMs: 1 },
      config,
      secrets: loadSecrets({}),
    });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/timed out/i);
  });

  it("rolls back a worktree only inside WORKSPACE_ROOT", async () => {
    const config = {
      ...loadConfig({}),
      workspaceRoot: tmpRoot,
      allowUntrustedScripts: false,
    };
    const run = await runFactory({
      idea: "Build a Bible reading habit tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });
    expect(run.workspacePath).toBeTruthy();
    const ok = await rollbackWorkspace(tmpRoot, run.workspacePath);
    expect(ok.ok).toBe(true);
    await expect(access(run.workspacePath!)).rejects.toThrow();

    const refused = await rollbackWorkspace(tmpRoot, resolve(process.cwd(), "src"));
    expect(refused.ok).toBe(false);
  });

  it("mock QA still drives exactly one repair then pass", async () => {
    const mock = new MockProvider();
    const first = await mock.generateJson({
      system: "x",
      prompt: "demo",
      schema: QaReportSchema,
      schemaName: "QaReport",
    });
    const second = await mock.generateJson({
      system: "x",
      prompt: "demo",
      schema: QaReportSchema,
      schemaName: "QaReport",
    });
    expect(first.passed).toBe(false);
    expect(second.passed).toBe(true);
  });
});
