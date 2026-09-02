import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FoundryAdapters,
  createFoundryTierProvider,
  defaultProcessRunner,
  repoRewardsQuery,
  repoSourceFromTarget,
} from "../foundry/adapters.js";
import {
  EXTEND_PERSISTENCE_CONTRACT,
  withExtendPersistenceGoals,
} from "../orchestrator/composeExtendIdea.js";
import { FoundryStore, STATIONS, intakeFromMarkdown } from "../foundry/model.js";
import { loadConfig } from "../config.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { LLMProvider } from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import { resetPaidBudget } from "../providers/paidBudget.js";

function providerRegistry(providers: LLMProvider[]): ProviderRegistry {
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const missing = (name: ProviderName) =>
    ({ name, isConfigured: () => false }) as LLMProvider;
  const get = (name: ProviderName) => byName.get(name) ?? missing(name);
  const configured = providers.map((provider) => provider.name);
  const paid = configured.filter(
    (name): name is "anthropic" | "openai" => name === "anthropic" || name === "openai",
  );
  return {
    get,
    resolve: (requested, fallback) => get(requested ?? fallback),
    resolveLive: (requested, fallback) => get(requested ?? fallback),
    available: () => configured,
    availableLive: () =>
      configured.filter((name) => name !== "mock" && name !== "stub"),
    availablePaid: () => paid,
    missingCredentialNames: () => [],
  };
}

function callable(name: ProviderName, fail = false): LLMProvider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    isConfigured: () => true,
    async generateText() {
      provider.calls += 1;
      if (fail) throw new Error(`${name} failed`);
      return { text: "ok", provider: name };
    },
    async generateJson<T>() {
      provider.calls += 1;
      if (fail) throw new Error(`${name} failed`);
      return {} as T;
    },
  };
  return provider;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Purpose Foundry", () => {
  it.each(["free", "paid"] as const)(
    "normalizes legacy %s intake to the same automatic production line",
    async (legacyMode) => {
      const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
      const store = new FoundryStore(root);
      const project = await store.create({
        ...intakeFromMarkdown(
          "# Unified Line\nShip safely through one model ladder.",
          "C:/Vault/Unified-Line.md",
        ),
        routingMode: legacyMode,
      });

      expect(project.routingMode).toBe("auto");
      expect((await store.get(project.id))?.routingMode).toBe("auto");
      for (const stationId of [
        "repo-rewards",
        "factory-deck",
        "crucible",
        "watchtower",
      ]) {
        expect(
          project.stations.find((station) => station.stationId === stationId)?.status,
        ).toBe("queued");
      }
      for (const stationId of [
        "scout",
        "promo-pilot",
        "flexfactor",
        "app-store-publisher",
      ]) {
        expect(
          project.stations.find((station) => station.stationId === stationId)?.status,
        ).toBe("not_selected");
      }
    },
  );

  it("keeps configured external orchestrators optional on the unified route", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown(
      "# Optional Specialists\nUse specialists when configured.",
      "C:/Vault/Optional-Specialists.md",
    );
    const project = await store.create({
      ...intake,
      routingMode: "paid",
      selectedStations: ["scout", "flexfactor"],
    });

    expect(project.routingMode).toBe("auto");
    expect(
      project.stations.find((station) => station.stationId === "scout")?.status,
    ).toBe("queued");
    expect(
      project.stations.find((station) => station.stationId === "flexfactor")?.status,
    ).toBe("queued");
  });

  it("routes Purpose Foundry model calls through the paid-first ladder", async () => {
    const paid = callable("openai");
    const free = callable("free");
    const registry = providerRegistry([paid, free]);
    const config = loadConfig({
      FACTORY_FREE_ENABLED: "true",
      FACTORY_MODEL_LADDER: "openai",
    });
    const selected = createFoundryTierProvider("free", registry, config, "review");

    await expect(
      selected.provider.generateText({ system: "", prompt: "" }),
    ).resolves.toMatchObject({ provider: "openai" });
    expect(selected.routing).toMatchObject({
      routingMode: "auto",
      ladder: ["openai", "free"],
    });
    expect(paid.calls).toBe(1);
    expect(free.calls).toBe(0);
  });

  it("falls through to free when Purpose Foundry's paid budget is exhausted", async () => {
    const dataDir = ".vitest-factory-data-foundry-routing";
    const previousDir = process.env.FACTORY_DATA_DIR;
    const previousDay = process.env.FACTORY_PAID_RESCUES_PER_DAY;
    process.env.FACTORY_DATA_DIR = dataDir;
    process.env.FACTORY_PAID_RESCUES_PER_DAY = "0";
    await rm(resolve(process.cwd(), dataDir), { recursive: true, force: true });
    resetPaidBudget();
    try {
      const paid = callable("openai");
      const free = callable("free");
      const registry = providerRegistry([paid, free]);
      const config = loadConfig({
        FACTORY_FREE_ENABLED: "true",
        FACTORY_MODEL_LADDER: "openai",
      });
      const selected = createFoundryTierProvider("paid", registry, config, "review");

      await expect(
        selected.provider.generateText({ system: "", prompt: "" }),
      ).resolves.toMatchObject({ provider: "free" });
      expect(paid.calls).toBe(0);
      expect(free.calls).toBe(1);
    } finally {
      if (previousDir === undefined) delete process.env.FACTORY_DATA_DIR;
      else process.env.FACTORY_DATA_DIR = previousDir;
      if (previousDay === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_DAY;
      else process.env.FACTORY_PAID_RESCUES_PER_DAY = previousDay;
      resetPaidBudget();
    }
  });

  it("keeps an exhausted rung demoted across Purpose Foundry station retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create({
      ...intakeFromMarkdown(
        "# Sticky Ladder\nKeep exhausted models demoted.",
        "C:/Vault/Sticky-Ladder.md",
      ),
    });
    const exhausted: LLMProvider & { calls: number } = {
      name: "openai",
      paidBudgetManaged: true,
      calls: 0,
      isConfigured: () => true,
      async generateText() {
        exhausted.calls += 1;
        throw Object.assign(new Error("rate limit exhausted"), { status: 429 });
      },
      async generateJson() {
        exhausted.calls += 1;
        throw Object.assign(new Error("rate limit exhausted"), { status: 429 });
      },
    };
    const fallback: LLMProvider & { calls: number } = {
      name: "free",
      calls: 0,
      isConfigured: () => true,
      async generateText() {
        fallback.calls += 1;
        return { text: "ok", provider: "free" };
      },
      async generateJson<T>() {
        fallback.calls += 1;
        return {
          verdict: "hardened",
          summary: "All supplied claims survived adversarial review.",
          findings: [],
          testedClaims: ["sticky ladder"],
        } as T;
      },
    };
    const registry = providerRegistry([exhausted, fallback]);
    const adapters = new FoundryAdapters(store, {
      config: () =>
        loadConfig({
          FACTORY_FREE_ENABLED: "true",
          FACTORY_MODEL_LADDER: "openai",
        }),
      providerRegistry: () => registry,
    });

    await expect(adapters.execute(project, "crucible")).resolves.toMatchObject({
      status: "completed",
    });
    await expect(adapters.execute(project, "crucible")).resolves.toMatchObject({
      status: "completed",
    });
    expect(exhausted.calls).toBe(1);
    expect(fallback.calls).toBe(2);
  });

  it("forwards the resolved automatic ladder to Factory Deck's run API", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create({
      ...intakeFromMarkdown(
        "# Metered-Build\nBuild through Factory Deck.",
        "C:/Vault/Metered-Build.md",
      ),
      routingMode: "paid",
      selectedStations: ["factory-deck", "crucible"],
    });
    const posted: Array<{
      idea?: string;
      options?: { goals?: string[] } & Record<string, unknown>;
    }> = [];
    const adapters = new FoundryAdapters(store, {
      config: () =>
        loadConfig({
          FACTORY_FREE_ENABLED: "false",
          FACTORY_MODEL_LADDER: "openai",
        }),
      providerRegistry: () => providerRegistry([callable("openai")]),
      fetch: async (_url, init) => {
        posted.push(
          JSON.parse(String(init?.body)) as {
            idea?: string;
            options?: { goals?: string[] } & Record<string, unknown>;
          },
        );
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(adapters.execute(project, "factory-deck")).rejects.toThrow(
      /did not return a run id/i,
    );
    expect(posted[0]?.options).toMatchObject({
      routingMode: "auto",
      codeProvider: "openai",
      reviewProvider: "openai",
    });
    expect(posted[0]?.options?.goals).toContain(
      `Mission: ${project.constitution.purpose}`,
    );
    for (const targetUser of project.constitution.targetUsers) {
      expect(posted[0]?.options?.goals).toContain(`Audience: ${targetUser}`);
    }
  });

  it("advertises App Store Publisher only with an explicit endpoint", async () => {
    const previous = process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL;
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    try {
      delete process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL;
      let publisher = new FoundryAdapters(store)
        .descriptors()
        .find((descriptor) => descriptor.stationId === "app-store-publisher");
      expect(publisher?.configured).toBe(false);
      expect(publisher?.destination).toContain(
        "PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL",
      );

      process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL = "http://127.0.0.1:4000";
      publisher = new FoundryAdapters(store)
        .descriptors()
        .find((descriptor) => descriptor.stationId === "app-store-publisher");
      expect(publisher).toMatchObject({
        configured: true,
        destination: "http://127.0.0.1:4000",
      });

      delete process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL;
      const project = await store.create(
        intakeFromMarkdown(
          "# Publisher guard\nPublish only through an explicitly configured service.",
          "C:/Vault/Publisher-guard.md",
        ),
      );
      await expect(
        new FoundryAdapters(store).execute(project, "app-store-publisher"),
      ).rejects.toThrow(/not configured.*no request was sent/i);
    } finally {
      if (previous === undefined)
        delete process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL;
      else process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL = previous;
    }
  });

  it("uses the directed FlexFactor run script by default in descriptors and process mode", async () => {
    const previousScript = process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT;
    const previousProvider = process.env.PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousAuthToken = process.env.FACTORY_AUTH_TOKEN;
    const previousPromoToken = process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN;
    delete process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT;
    // A stale operator override must not pin FlexFactor: its own orchestrator
    // chooses the strongest available rung.
    process.env.PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER = "anthropic";
    process.env.OPENAI_API_KEY = "paid-secret-must-not-reach-free-child";
    process.env.FACTORY_AUTH_TOKEN = "factory-secret-must-not-reach-child";
    process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN = "promo-secret-must-not-reach-child";
    try {
      const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
      const store = new FoundryStore(root);
      const project = await store.create(
        intakeFromMarkdown(
          "---\nproject: GrantFlow\npurpose: Match people to real funding\ntargets: buckeye7066/GrantFlow\n---\n# GrantFlow",
          "C:/Vault/GrantFlow.md",
        ),
      );
      let receivedArgs: string[] = [];
      let receivedEnv: NodeJS.ProcessEnv | undefined;
      let processExit = 0;
      const adapters = new FoundryAdapters(store, {
        config: () =>
          loadConfig({
            FACTORY_FREE_ENABLED: "true",
            DEFAULT_CODE_PROVIDER: "free",
            DEFAULT_REVIEW_PROVIDER: "free",
          }),
        providerRegistry: () => providerRegistry([callable("free")]),
        processRunner: async (_python, args, options) => {
          receivedArgs = args;
          receivedEnv = options.env;
          return {
            stdout:
              processExit === 0
                ? "ok"
                : `FACTORY_AUTH_TOKEN=${process.env.FACTORY_AUTH_TOKEN}`,
            stderr:
              processExit === 0
                ? "failed detail"
                : `PURPOSE_FOUNDRY_PROMOPILOT_TOKEN=${process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN}`,
            exitCode: processExit,
          };
        },
      });

      const descriptors = adapters.descriptors();
      const scout = descriptors.find((descriptor) => descriptor.stationId === "scout");
      const flexfactor = descriptors.find(
        (descriptor) => descriptor.stationId === "flexfactor",
      );
      const directedScript = "C:\\Users\\firer\\flexfactor\\flexfactor_run.py";
      expect(scout?.destination).toBe(directedScript);
      expect(flexfactor?.destination).toBe(directedScript);
      expect(scout?.configured).toBe(existsSync(directedScript));
      expect(flexfactor?.configured).toBe(existsSync(directedScript));

      const success = await adapters.execute(project, "scout");
      expect(success.status).toBe("completed");
      expect(receivedArgs[0]).toBe(directedScript);
      expect(receivedArgs).not.toContain("--provider");
      expect(receivedArgs).not.toContain("ollama");
      expect(receivedArgs).not.toContain("anthropic");
      expect(receivedEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(receivedEnv?.PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER).toBeUndefined();
      expect(receivedEnv?.FACTORY_AUTH_TOKEN).toBeUndefined();
      expect(receivedEnv?.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN).toBeUndefined();

      processExit = 7;
      const failure = await adapters.execute(project, "scout");
      expect(failure).toMatchObject({
        status: "failed",
        evidence: {
          exitCode: 7,
          provider: "flexfactor-orchestrated",
        },
      });
      const failureOutput = await readFile(failure.artifacts[0], "utf8");
      expect(failureOutput).not.toContain("factory-secret-must-not-reach-child");
      expect(failureOutput).not.toContain("promo-secret-must-not-reach-child");
      expect(JSON.stringify(failure.evidence)).not.toContain(
        "factory-secret-must-not-reach-child",
      );
      expect(JSON.stringify(failure.evidence)).not.toContain(
        "promo-secret-must-not-reach-child",
      );
    } finally {
      if (previousScript === undefined)
        delete process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT;
      else process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT = previousScript;
      if (previousProvider === undefined)
        delete process.env.PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER;
      else process.env.PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER = previousProvider;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousAuthToken === undefined) delete process.env.FACTORY_AUTH_TOKEN;
      else process.env.FACTORY_AUTH_TOKEN = previousAuthToken;
      if (previousPromoToken === undefined)
        delete process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN;
      else process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN = previousPromoToken;
    }
  });

  it("returns ordinary nonzero exits from the real process runner", async () => {
    const result = await defaultProcessRunner(
      process.execPath,
      [
        "-e",
        "process.stdout.write('partial output'); process.stderr.write('failure detail'); process.exit(7)",
      ],
      { timeoutMs: 30_000 },
    );

    expect(result).toEqual({
      stdout: "partial output",
      stderr: "failure detail",
      exitCode: 7,
    });
    await expect(
      defaultProcessRunner(`missing-foundry-process-${Date.now()}`, [], {
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/could not be launched/i);
  });

  it("lets a legacy Paid record invoke FlexFactor's own orchestrated ladder", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create({
      ...intakeFromMarkdown(
        "---\nproject: Paid Line\npurpose: Review the app\ntargets: buckeye7066/local-ai-factory\n---\n# Paid Line",
        "C:/Vault/Paid-Line.md",
      ),
      routingMode: "paid",
    });
    project.stations.find((station) => station.stationId === "flexfactor")!.status =
      "queued";
    let processCalls = 0;
    const adapters = new FoundryAdapters(store, {
      config: () =>
        loadConfig({
          FACTORY_FREE_ENABLED: "true",
          DEFAULT_CODE_PROVIDER: "free",
          DEFAULT_REVIEW_PROVIDER: "free",
        }),
      providerRegistry: () => providerRegistry([callable("free"), callable("openai")]),
      processRunner: async () => {
        processCalls += 1;
        return { stdout: "completed", stderr: "", exitCode: 0 };
      },
    });

    await expect(adapters.execute(project, "flexfactor")).resolves.toMatchObject({
      status: "completed",
      evidence: { provider: "flexfactor-orchestrated" },
    });
    expect(processCalls).toBe(1);
  });

  it("turns an Obsidian note into a versioned project constitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown(
      `---\nproject: IPlay\npurpose: Produce believable avatar performances\ntarget_users: musicians, creators\nsuccess: correct fingering, synchronized audio\ntargets: buckeye7066/IPlay\n---\n# IPlay\nBuild the complete performance pipeline.`,
      "C:/Vault/Purpose Foundry/IPlay.md",
    );
    const project = await store.create(intake);

    expect(project.name).toBe("IPlay");
    expect(project.constitution.targetUsers).toEqual(["musicians", "creators"]);
    expect(project.constitution.targets).toEqual(["buckeye7066/IPlay"]);
    expect(project.stations).toHaveLength(STATIONS.length);
    expect(project.stations[0].stationId).toBe("scout");
    expect(
      project.stations.findIndex((station) => station.stationId === "factory-deck"),
    ).toBeGreaterThan(
      project.stations.findIndex((station) => station.stationId === "promo-pilot"),
    );
    for (const stationId of [
      "repo-rewards",
      "factory-deck",
      "crucible",
      "watchtower",
    ]) {
      expect(
        project.stations.find((station) => station.stationId === stationId)?.status,
      ).toBe("queued");
    }
    for (const stationId of [
      "scout",
      "promo-pilot",
      "flexfactor",
      "app-store-publisher",
    ]) {
      expect(
        project.stations.find((station) => station.stationId === stationId)?.status,
      ).toBe("not_selected");
    }
  });

  it("deduplicates an unchanged Obsidian note and hash-chains evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown(
      "# GrantFlow\nFind and match real funding.",
      "C:/Vault/GrantFlow.md",
    );
    const first = await store.create(intake);
    const second = await store.create(intake);
    await store.appendEvidence(first.id, "crucible", "challenge.recorded", {
      severity: "high",
    });

    expect(second.id).toBe(first.id);
    const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { hash: string; previousHash: string | null });
    expect(lines).toHaveLength(2);
    expect(lines[1].previousHash).toBe(lines[0].hash);
  });

  it("serializes simultaneous evidence writes without losing the chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown(
        "# FutureU\nBuild a complete curriculum platform.",
        "C:/Vault/FutureU.md",
      ),
    );
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.appendEvidence(project.id, "crucible", "challenge.recorded", {
          index,
        }),
      ),
    );
    const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            sequence: number;
            hash: string;
            previousHash: string | null;
          },
      );
    expect(lines).toHaveLength(13);
    lines.forEach((event, index) => {
      expect(event.sequence).toBe(index + 1);
      expect(event.previousHash).toBe(index === 0 ? null : lines[index - 1].hash);
    });
  });

  it("deduplicates simultaneous project creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown(
      "# GeneMap\nMap evidence to genes.",
      "C:/Vault/GeneMap.md",
    );
    const projects = await Promise.all(
      Array.from({ length: 8 }, () => store.create(intake)),
    );
    expect(new Set(projects.map((project) => project.id)).size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("normalizes Windows notes and refuses a symlink outside the inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const inbox = await mkdtemp(join(tmpdir(), "purpose-foundry-inbox-"));
    const outside = join(root, "outside.md");
    await writeFile(
      join(inbox, "GrantFlow.md"),
      "# GrantFlow\r\nFind funding.\r\n",
      "utf8",
    );
    await writeFile(outside, "# Private\nDo not import.\n", "utf8");
    await symlink(outside, join(inbox, "outside.md"));
    const store = new FoundryStore(root);

    const first = await store.importObsidianInbox(inbox);
    const second = await store.importObsidianInbox(inbox);
    expect(first.imported).toBe(1);
    expect(first.errors.some((error) => error.startsWith("outside.md:"))).toBe(true);
    expect(second.imported).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("carries the extend persistence contract into Factory Deck extend goals", () => {
    const goals = withExtendPersistenceGoals(["Match people to real funding"]);
    expect(goals).toContain(EXTEND_PERSISTENCE_CONTRACT);
    expect(goals[0]).toBe("Match people to real funding");
  });

  it("classifies explicit repository targets without guessing prose", () => {
    expect(repoSourceFromTarget("buckeye7066/GrantFlow")).toEqual({
      type: "git",
      location: "https://github.com/buckeye7066/GrantFlow.git",
    });
    expect(repoSourceFromTarget("C:\\Users\\firer\\GrantFlow")).toEqual({
      type: "path",
      location: "C:\\Users\\firer\\GrantFlow",
    });
    expect(repoSourceFromTarget("the grant program on my desktop")).toBeNull();
  });

  it("runs the Repo Rewards adapter and persists its evidence inside the artifact jail", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown(
        "---\nproject: GrantFlow\npurpose: Match people to real funding\nsuccess: verified live opportunities\n---\n# GrantFlow",
        "C:/Vault/GrantFlow.md",
      ),
    );
    let posted: unknown = null;
    const adapters = new FoundryAdapters(store, {
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            results: [
              {
                repo: {
                  fullName: "useful/repo",
                  license: { spdxId: "MIT", name: "MIT License" },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const outcome = await adapters.execute(project, "repo-rewards");

    expect(outcome.status).toBe("completed");
    expect(posted).toMatchObject({ lens: "best", sessionId: project.id });
    expect(repoRewardsQuery(project)).toContain("verified live opportunities");
    expect(outcome.artifacts[0]).toContain(join(project.id, "repo-rewards"));
    expect(outcome.handoff).toMatchObject({
      insights: [expect.stringContaining("purpose-bound search")],
      candidates: [
        {
          name: "useful/repo",
          url: null,
          summary: "",
          license: "MIT",
          score: null,
        },
      ],
    });
    expect(JSON.parse(await readFile(outcome.artifacts[0], "utf8"))).toEqual({
      results: [
        {
          repo: {
            fullName: "useful/repo",
            license: { spdxId: "MIT", name: "MIT License" },
          },
        },
      ],
    });
    await expect(
      store.writeArtifact(project.id, "repo-rewards", "../escape.json", {}),
    ).rejects.toThrow("Invalid artifact filename");

    const outside = await mkdtemp(join(tmpdir(), "purpose-foundry-artifact-outside-"));
    const stationParent = join(root, "artifacts", project.id);
    await mkdir(stationParent, { recursive: true });
    await symlink(outside, join(stationParent, "watchtower"), "dir");
    await expect(
      store.writeArtifact(project.id, "watchtower", "health.json", {}),
    ).rejects.toThrow("escapes the Foundry data root");
  });

  it("does not mistake an artifact filename for an App Store submission", async () => {
    vi.stubEnv("PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL", "https://publisher.example");
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown("# IPlay\nShip the mobile app.", "C:/Vault/IPlay.md"),
    );
    project.stations.find(
      (station) => station.stationId === "factory-deck",
    )!.artifacts = ["C:/build/IPlay.aab"];
    {
      const adapters = new FoundryAdapters(store, {
        fetch: async (url) => {
          const path = new URL(String(url)).pathname;
          const body =
            path === "/api/stores"
              ? { stores: [{ id: "google_play", configured: true }] }
              : path === "/api/presets"
                ? {
                    presets: [
                      {
                        id: "iplay",
                        label: "IPlay",
                        packageName: "com.iplay.app",
                      },
                    ],
                  }
                : path === "/api/submissions"
                  ? { submissions: [] }
                  : { ok: true };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const outcome = await adapters.execute(project, "app-store-publisher");
      expect(outcome.status).toBe("needs_attention");
      expect(outcome.evidence).toMatchObject({
        uploaded: false,
        submitted: false,
      });
      expect(outcome.summary).toContain("requiring attention");
    }
  });

  it("streams, checksum-verifies, dry-runs, and submits a real build through Publisher", async () => {
    vi.stubEnv("PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL", "https://publisher.example");
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const target = await mkdtemp(join(tmpdir(), "purpose-foundry-release-"));
    const release = join(target, "grantflow-release.aab");
    const bytes = Buffer.from("PK\u0003\u0004purpose-foundry-test-build");
    await writeFile(release, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown(
        `---\nproject: GrantFlow\npurpose: Ship verified funding tools\ntargets: ${target}\n---\n# GrantFlow`,
        "C:/Vault/GrantFlow.md",
      ),
    );
    project.stations.find(
      (station) => station.stationId === "factory-deck",
    )!.artifacts = [release];
    const calls: string[] = [];
    {
      const adapters = new FoundryAdapters(store, {
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          calls.push(`${init?.method || "GET"} ${path}`);
          let body: Record<string, unknown>;
          if (path === "/api/stores") {
            body = {
              stores: [{ id: "google_play", label: "Google Play", configured: true }],
            };
          } else if (path === "/api/presets") {
            body = {
              presets: [
                {
                  id: "grantflow",
                  label: "GrantFlow",
                  repo: "buckeye7066/GrantFlow",
                  packageName: "com.grantflow.app",
                },
              ],
            };
          } else if (path === "/api/submissions") {
            body = { submissions: [] };
          } else if (path === "/api/upload") {
            const chunks: Buffer[] = [];
            for await (const chunk of init?.body as AsyncIterable<Uint8Array>)
              chunks.push(Buffer.from(chunk));
            const multipart = Buffer.concat(chunks);
            expect(multipart.includes(bytes)).toBe(true);
            expect(multipart.toString("latin1")).toContain(sha256);
            expect(init?.headers).toMatchObject({
              "x-purpose-foundry-client": "purpose-foundry",
            });
            body = {
              uploadId: "upload-1",
              fileName: "grantflow-release.aab",
              sha256,
              inspection: { fields: { packageId: "com.grantflow.app" } },
            };
          } else if (path === "/api/submit") {
            const request = JSON.parse(String(init?.body)) as {
              dryRun?: boolean;
            };
            body = request.dryRun
              ? {
                  approvalToken: "approval-1",
                  artifactEvidence: {
                    stores: [{ unknowns: [], mismatches: [] }],
                  },
                  plannedMutations: [],
                }
              : {
                  results: [
                    {
                      store: "google_play",
                      status: "success",
                      state: "published",
                    },
                  ],
                };
          } else {
            body = { ok: true };
          }
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const outcome = await adapters.execute(project, "app-store-publisher");
      expect(outcome.status).toBe("completed");
      expect(outcome.evidence).toMatchObject({
        uploaded: true,
        submitted: true,
        submittedStores: 1,
      });
      expect(calls).toContain("POST /api/upload");
      expect(calls.filter((call) => call === "POST /api/submit")).toHaveLength(2);
    }
  });
});
