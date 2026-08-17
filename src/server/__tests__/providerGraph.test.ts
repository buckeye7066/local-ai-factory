import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { freshStages, type RunRecord } from "../../shared/schemas.js";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  LLMProvider,
} from "../../shared/types.js";
import {
  PaidProviderAuthorizationError,
  wrapRunProvider,
} from "../orchestrator/runFactory.js";
import { QuotaFailoverProvider } from "../providers/quotaFailover.js";
import {
  PaidBudgetExhaustedError,
  paidBudgetStatus,
  resetPaidBudget,
} from "../providers/paidBudget.js";

const originalDataDir = process.env.FACTORY_DATA_DIR;
const DATA_DIR = ".vitest-factory-provider-graph";
process.env.FACTORY_DATA_DIR = DATA_DIR;

function runRecord(): RunRecord {
  return {
    id: crypto.randomUUID(),
    idea: "provider graph proof",
    status: "running",
    resumable: false,
    demo: false,
    codeProvider: "anthropic",
    reviewProvider: "openai",
    currentStage: null,
    stages: freshStages(),
    logs: [],
    files: [],
    repairLoops: 0,
    providerUsage: {
      free: { calls: 0 },
      anthropic: { calls: 0 },
      openai: { calls: 0 },
      stub: { calls: 0 },
      mock: { calls: 0 },
      totalCalls: 0,
    },
    finalReport: null,
    appName: null,
    workspacePath: null,
    destination: null,
    error: null,
    attribution: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

class FakePaidProvider implements LLMProvider {
  calls = 0;

  constructor(
    readonly name: "anthropic" | "openai",
    private quotaRefusal = false,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  private result<T>(value: T): T {
    this.calls += 1;
    if (this.quotaRefusal) throw new Error("insufficient_quota");
    return value;
  }

  async generateText(_input: GenerateTextInput) {
    return this.result({ text: "ok", provider: this.name });
  }

  async generateJson<T>(_input: GenerateJsonInput<T>): Promise<T> {
    return this.result({ ok: true } as T);
  }
}

beforeEach(async () => {
  process.env.FACTORY_PAID_RESCUES_PER_HOUR = "6";
  process.env.FACTORY_PAID_RESCUES_PER_DAY = "24";
  process.env.FACTORY_PAID_MAX_USD_PER_DAY = "10";
  await rm(resolve(process.cwd(), DATA_DIR), { recursive: true, force: true });
  resetPaidBudget();
});

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.FACTORY_DATA_DIR;
  else process.env.FACTORY_DATA_DIR = originalDataDir;
  delete process.env.FACTORY_PAID_RESCUES_PER_HOUR;
  delete process.env.FACTORY_PAID_RESCUES_PER_DAY;
  delete process.env.FACTORY_PAID_MAX_USD_PER_DAY;
  await rm(resolve(process.cwd(), DATA_DIR), { recursive: true, force: true });
});

describe("canonical run provider graph", () => {
  it("cannot wrap a paid provider without the run's explicit authorization", () => {
    expect(() =>
      wrapRunProvider(new FakePaidProvider("anthropic"), runRecord(), 10, false),
    ).toThrow(PaidProviderAuthorizationError);
  });

  it("counts and budget-gates an authorized quota alternate", async () => {
    const run = runRecord();
    const primaryRaw = new FakePaidProvider("anthropic", true);
    const alternateRaw = new FakePaidProvider("openai");
    const provider = new QuotaFailoverProvider(
      wrapRunProvider(primaryRaw, run, 10, true),
      [wrapRunProvider(alternateRaw, run, 10, true)],
    );

    await expect(
      provider.generateText({ system: "", prompt: "fallback" }),
    ).resolves.toMatchObject({ provider: "openai" });
    expect(primaryRaw.calls).toBe(1);
    expect(alternateRaw.calls).toBe(1);
    expect(run.providerUsage.totalCalls).toBe(2);
    expect(run.providerUsage.anthropic.calls).toBe(1);
    expect(run.providerUsage.openai.calls).toBe(1);
    // The quota error has uncertain billing, so its primary reservation stays
    // conservative while the successful alternate releases its own.
    expect(paidBudgetStatus().reserved).toBe(1);
  });

  it("refuses an alternate before its SDK when the primary consumed the last slot", async () => {
    process.env.FACTORY_PAID_RESCUES_PER_HOUR = "1";
    const run = runRecord();
    const primaryRaw = new FakePaidProvider("anthropic", true);
    const alternateRaw = new FakePaidProvider("openai");
    const provider = new QuotaFailoverProvider(
      wrapRunProvider(primaryRaw, run, 10, true),
      [wrapRunProvider(alternateRaw, run, 10, true)],
    );

    await expect(
      provider.generateText({ system: "", prompt: "fallback" }),
    ).rejects.toBeInstanceOf(PaidBudgetExhaustedError);
    expect(primaryRaw.calls).toBe(1);
    expect(alternateRaw.calls).toBe(0);
    expect(run.providerUsage.totalCalls).toBe(1);
  });
});
