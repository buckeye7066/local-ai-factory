import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FoundryStore,
  intakeFromMarkdown,
  STATIONS,
  type StationId,
} from "../foundry/model.js";
import {
  FoundryAdapters,
  type AdapterOutcome,
  type AdapterDescriptor,
} from "../foundry/adapters.js";
import { createFoundryRouter } from "../foundry/router.js";

function jsonHeaders() {
  return { "content-type": "application/json" };
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 8000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await sleep(25);
  }
}

class TestFoundryAdapters extends FoundryAdapters {
  private completions = new Map<string, Set<StationId>>();
  private calls: Array<{ projectId: string; stationId: StationId }> = [];
  private held = new Map<StationId, Promise<void>>();
  private releases = new Map<StationId, () => void>();
  getCalls() {
    return this.calls.slice();
  }
  hold(stationId: StationId) {
    if (this.held.has(stationId)) return;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(stationId, pending);
    this.releases.set(stationId, release);
  }
  release(stationId: StationId) {
    this.releases.get(stationId)?.();
    this.releases.delete(stationId);
    this.held.delete(stationId);
  }
  override descriptors(): AdapterDescriptor[] {
    return STATIONS.map((s) => {
      const desc: AdapterDescriptor = {
        stationId: s.id,
        mode: "internal",
        destination: "in-memory",
        configured: true,
      };
      return desc;
    });
  }
  override async execute(
    project: Awaited<ReturnType<FoundryStore["get"]>>,
    stationId: StationId,
  ): Promise<AdapterOutcome> {
    if (!project) throw new Error("no project");
    const done = this.completions.get(project.id) ?? new Set<StationId>();
    this.completions.set(project.id, done);
    this.calls.push({ projectId: project.id, stationId });
    const held = this.held.get(stationId);
    if (held) await held;
    // Complete discovery and Factory Deck quickly; hold Crucible for attention to prove restart dispatch.
    const complete: StationId[] = [
      "scout",
      "repo-rewards",
      "promo-pilot",
      "factory-deck",
      "flexfactor",
    ];
    if (complete.includes(stationId)) {
      done.add(stationId);
      const evidence: Record<string, unknown> = {};
      if (stationId === "factory-deck") {
        // Build a deterministic artifact tree digest bound to project id.
        const tree = { projectId: project.id, files: ["a.txt", "b.txt"], bytes: 42 };
        const hex = createHash("sha256").update(JSON.stringify(tree)).digest("hex");
        evidence.evidenceDigest = `sha256:${hex}`;
        evidence.revision = `rev-${hex.slice(0, 12)}`;
      }
      return {
        status: "completed",
        summary: `completed:${stationId}`,
        artifacts: [],
        ...(stationId === "repo-rewards" || stationId === "scout"
          ? {
              handoff: {
                insights:
                  stationId === "scout"
                    ? ["Program Scout verified the target capability map."]
                    : ["Use the useful/repo validation pattern."],
                sources:
                  stationId === "scout"
                    ? ["https://example.com/program-scout-evidence"]
                    : ["https://github.com/useful/repo"],
                candidates:
                  stationId === "repo-rewards"
                    ? [
                        {
                          name: "useful/repo",
                          url: "https://github.com/useful/repo",
                          summary: "A maintained validation implementation.",
                          license: "MIT",
                          score: 91,
                        },
                      ]
                    : [],
              },
            }
          : {}),
        evidence,
      } satisfies AdapterOutcome;
    }
    if (stationId === "crucible") {
      return {
        status: "needs_attention",
        summary: "adversary requires attention",
        artifacts: [],
        evidence: {},
      } satisfies AdapterOutcome;
    }
    // Anything after attention point is left queued.
    return {
      status: "needs_attention",
      summary: "default",
      artifacts: [],
      evidence: {},
    } satisfies AdapterOutcome;
  }
}

describe("Foundry router invariants (deterministic adapters): single-active, stale-reject, auto-advance, restart dispatch, evidence chain", () => {
  let root!: string;
  let store!: FoundryStore;
  let baseUrl!: string;
  let server: import("http").Server;
  let adapters!: TestFoundryAdapters;
  let prevOpenAi!: string | undefined;
  let prevAnthropic!: string | undefined;
  let prevSolModel!: string | undefined;
  let prevFableModel!: string | undefined;

  async function startServer() {
    const app = express();
    app.use(express.json());
    app.use("/api/foundry", createFoundryRouter(store, adapters));
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}/api/foundry`;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "foundry-router-"));
    store = new FoundryStore(root);
    adapters = new TestFoundryAdapters(store);
    prevOpenAi = process.env.OPENAI_API_KEY;
    prevAnthropic = process.env.ANTHROPIC_API_KEY;
    prevSolModel = process.env.FACTORY_SOL_MODEL;
    prevFableModel = process.env.FACTORY_FABLE_OR_OPUS_MODEL;
    process.env.OPENAI_API_KEY = prevOpenAi || "test-openai";
    process.env.ANTHROPIC_API_KEY = prevAnthropic || "test-anthropic";
    process.env.FACTORY_SOL_MODEL = "gpt-5.5";
    process.env.FACTORY_FABLE_OR_OPUS_MODEL = "claude-opus-4-8";
    await startServer();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevSolModel === undefined) delete process.env.FACTORY_SOL_MODEL;
    else process.env.FACTORY_SOL_MODEL = prevSolModel;
    if (prevFableModel === undefined) delete process.env.FACTORY_FABLE_OR_OPUS_MODEL;
    else process.env.FACTORY_FABLE_OR_OPUS_MODEL = prevFableModel;
  });

  it("preserves explicit specialist selection for Obsidian intake", async () => {
    const response = await fetch(`${baseUrl}/obsidian/import`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        markdown: "# Imported job\nBuild and promote the product.",
        sourcePath: "C:/Vault/Imported.md",
        routingMode: "paid",
        selectedStations: ["promo-pilot"],
      }),
    });
    expect(response.status).toBe(201);
    const project = (await response.json()) as Awaited<ReturnType<typeof store.create>>;
    const queued = project.stations
      .filter((station) => station.status === "queued")
      .map((station) => station.stationId);
    expect(queued).toEqual([
      "scout",
      "repo-rewards",
      "promo-pilot",
      "factory-deck",
      "crucible",
      "watchtower",
    ]);
    expect(
      project.stations.find((station) => station.stationId === "scout")?.status,
    ).toBe("queued");
    expect(
      project.stations.find((station) => station.stationId === "flexfactor")?.status,
    ).toBe("not_selected");
  });

  it("finishes an earlier Scout pass once, then runs mandatory RepoRewards", async () => {
    const project = await store.create({
      ...intakeFromMarkdown(
        "# ScoutFirst\nInspect the market before improving the product.",
        "C:/Vault/ScoutFirst.md",
      ),
      selectedStations: ["scout"],
    });
    adapters.hold("repo-rewards");

    const started = await fetch(`${baseUrl}/projects/${project.id}/start`, {
      method: "POST",
      headers: jsonHeaders(),
    });
    expect(started.status).toBe(202);
    await waitFor(
      async () => adapters.getCalls().filter((call) => call.projectId === project.id),
      (calls) => calls.some((call) => call.stationId === "repo-rewards"),
    );

    const whileDiscoveryRuns = (await store.get(project.id))!;
    expect(
      adapters
        .getCalls()
        .filter((call) => call.projectId === project.id)
        .map((call) => call.stationId),
    ).toEqual(["scout", "repo-rewards"]);
    expect(
      whileDiscoveryRuns.stations.find((station) => station.stationId === "scout")
        ?.status,
    ).toBe("completed");
    expect(
      whileDiscoveryRuns.stations.find(
        (station) => station.stationId === "repo-rewards",
      )?.status,
    ).toBe("active");

    adapters.release("repo-rewards");
    await waitFor(
      async () => (await store.get(project.id))!,
      (candidate) =>
        candidate.stations.find((station) => station.stationId === "crucible")
          ?.status === "needs_attention",
    );
    const completedCalls = adapters
      .getCalls()
      .filter((call) => call.projectId === project.id)
      .map((call) => call.stationId);
    expect(completedCalls.filter((stationId) => stationId === "scout")).toHaveLength(1);
    expect(
      completedCalls.filter((stationId) => stationId === "repo-rewards"),
    ).toHaveLength(1);
  });

  it("rejects a completed RepoRewards event without its typed handoff", async () => {
    const created = await store.create(
      intakeFromMarkdown(
        "# EvidenceRequired\nFind reusable validation patterns.",
        "C:/Vault/EvidenceRequired.md",
      ),
    );
    adapters.hold("repo-rewards");
    const started = await fetch(`${baseUrl}/projects/${created.id}/start`, {
      method: "POST",
      headers: jsonHeaders(),
    });
    expect(started.status).toBe(202);
    await waitFor(
      async () => (await store.get(created.id))!,
      (project) =>
        project.stations.find((station) => station.stationId === "repo-rewards")
          ?.status === "active",
    );

    const response = await fetch(
      `${baseUrl}/projects/${created.id}/stations/repo-rewards/events`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          status: "completed",
          summary: "legacy reporter omitted structured evidence",
          artifacts: [],
          evidence: {},
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("requires a purpose-bound insight"),
    });
    expect(
      (await store.get(created.id))?.stations.find(
        (station) => station.stationId === "repo-rewards",
      )?.status,
    ).toBe("active");
    adapters.release("repo-rewards");
  });

  it("routes failed legacy retries through RepoRewards before the failed station", async () => {
    const project = await store.create(
      intakeFromMarkdown(
        "# LegacyRetry\nResume a previously failed build.",
        "C:/Vault/LegacyRetry.md",
      ),
    );
    const scout = project.stations.find(
      (station) => station.stationId === "scout",
    )!;
    scout.status = "completed";
    scout.handoff = {
      insights: ["Legacy project already contains verified Scout evidence."],
      sources: ["https://example.com/program-scout-evidence"],
      candidates: [],
    };
    scout.endedAt = Date.now();
    const discovery = project.stations.find(
      (station) => station.stationId === "repo-rewards",
    )!;
    const factory = project.stations.find(
      (station) => station.stationId === "factory-deck",
    )!;
    discovery.status = "not_selected";
    factory.status = "failed";
    factory.endedAt = Date.now();
    project.status = "failed";
    await store.save(project);

    adapters.hold("repo-rewards");
    const response = await fetch(
      `${baseUrl}/projects/${project.id}/stations/factory-deck/run`,
      { method: "POST", headers: jsonHeaders() },
    );
    expect(response.status).toBe(202);
    const migrated = (await store.get(project.id))!;
    expect(
      migrated.stations.find((station) => station.stationId === "repo-rewards")?.status,
    ).toBe("active");
    expect(
      migrated.stations.find((station) => station.stationId === "factory-deck")?.status,
    ).toBe("queued");
    await waitFor(
      async () => adapters.getCalls(),
      (calls) =>
        calls.some(
          (call) => call.projectId === project.id && call.stationId === "repo-rewards",
        ),
    );
    expect(
      adapters
        .getCalls()
        .some(
          (call) => call.projectId === project.id && call.stationId === "factory-deck",
        ),
    ).toBe(false);
    adapters.release("repo-rewards");
  });

  it("migrates an active legacy restart with an empty RepoRewards handoff", async () => {
    const project = await store.create(
      intakeFromMarkdown(
        "# LegacyRestart\nContinue an in-flight build after a server restart.",
        "C:/Vault/LegacyRestart.md",
      ),
    );
    const scout = project.stations.find(
      (station) => station.stationId === "scout",
    )!;
    scout.status = "completed";
    scout.handoff = {
      insights: ["Legacy project already contains verified Scout evidence."],
      sources: ["https://example.com/program-scout-evidence"],
      candidates: [],
    };
    scout.endedAt = Date.now();
    const discovery = project.stations.find(
      (station) => station.stationId === "repo-rewards",
    )!;
    const factory = project.stations.find(
      (station) => station.stationId === "factory-deck",
    )!;
    discovery.status = "completed";
    discovery.handoff = { insights: [], sources: [], candidates: [] };
    discovery.endedAt = Date.now();
    factory.status = "active";
    factory.startedAt = Date.now();
    factory.attempt = 1;
    project.status = "running";
    await store.save(project);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    store = new FoundryStore(root);
    adapters = new TestFoundryAdapters(store);
    adapters.hold("repo-rewards");
    await startServer();

    await waitFor(
      async () => adapters.getCalls(),
      (calls) =>
        calls.some(
          (call) => call.projectId === project.id && call.stationId === "repo-rewards",
        ),
      4_000,
    );
    const migrated = (await store.get(project.id))!;
    expect(
      migrated.stations.find((station) => station.stationId === "repo-rewards")?.status,
    ).toBe("active");
    expect(
      migrated.stations.find((station) => station.stationId === "factory-deck")?.status,
    ).toBe("queued");
    expect(
      adapters
        .getCalls()
        .some(
          (call) => call.projectId === project.id && call.stationId === "factory-deck",
        ),
    ).toBe(false);

    const bypass = await fetch(
      `${baseUrl}/projects/${project.id}/stations/factory-deck/events`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          status: "completed",
          summary: "legacy callback attempted to bypass discovery",
          artifacts: [],
          evidence: {},
        }),
      },
    );
    expect(bypass.status).toBe(409);
    expect(await bypass.json()).toMatchObject({
      error: expect.stringMatching(/Program Scout and RepoRewards discovery/i),
    });

    adapters.release("repo-rewards");
    await waitFor(
      async () => adapters.getCalls(),
      (calls) =>
        calls.some(
          (call) => call.projectId === project.id && call.stationId === "factory-deck",
        ),
      4_000,
    );
  });

  it("redispatches an in-flight station after restart without replay or concurrency", async () => {
    const intake = {
      ...intakeFromMarkdown("# GrantFlow\nFind funding.", "C:/Vault/GrantFlow.md"),
      selectedStations: STATIONS.map((station) => station.id),
    };
    const createdRes = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(intake),
    });
    expect(createdRes.status).toBe(201);
    const project = (await createdRes.json()) as Awaited<
      ReturnType<typeof store.create>
    >;
    const projectId = project.id;

    // Hold Factory Deck in flight. This makes the single-active invariant
    // observable and leaves a genuinely active station on disk at restart.
    adapters.hold("factory-deck");
    const startRes = await fetch(`${baseUrl}/projects/${projectId}/start`, {
      method: "POST",
      headers: jsonHeaders(),
    });
    expect(startRes.status).toBe(202);
    await waitFor(
      async () => adapters.getCalls(),
      (calls) =>
        calls.some(
          (call) => call.projectId === projectId && call.stationId === "factory-deck",
        ),
      4_000,
    );

    for (let i = 0; i < 20; i++) {
      const snapshot = (await store.get(projectId))!;
      const active = snapshot.stations.filter((station) => station.status === "active");
      expect(active.map((station) => station.stationId)).toEqual(["factory-deck"]);
      await sleep(10);
    }
    const beforeRestart = (await store.get(projectId))!;
    for (const stationId of ["scout", "repo-rewards", "promo-pilot"] as const) {
      expect(
        beforeRestart.stations.find((station) => station.stationId === stationId)
          ?.status,
      ).toBe("completed");
    }
    expect(
      beforeRestart.stations.find((station) => station.stationId === "repo-rewards")
        ?.handoff.candidates[0],
    ).toMatchObject({
      name: "useful/repo",
      url: "https://github.com/useful/repo",
      license: "MIT",
      score: 91,
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    store = new FoundryStore(root);
    adapters = new TestFoundryAdapters(store);
    await startServer();

    // Wait for a known post-restart adapter call, not merely old persisted state.
    await waitFor(
      async () => adapters.getCalls(),
      (calls) =>
        calls.some(
          (call) => call.projectId === projectId && call.stationId === "factory-deck",
        ),
      4_000,
    );
    const afterRestart = await waitFor(
      async () => (await store.get(projectId))!,
      (candidate) =>
        candidate.stations.find((station) => station.stationId === "crucible")
          ?.status === "needs_attention" &&
        adapters.getCalls().some((call) => call.stationId === "crucible"),
      4_000,
    );

    const callsAfterRestart = adapters
      .getCalls()
      .filter((call) => call.projectId === projectId)
      .map((call) => call.stationId);
    expect(callsAfterRestart).toEqual(["factory-deck", "flexfactor", "crucible"]);
    for (const stationId of [
      "scout",
      "repo-rewards",
      "promo-pilot",
      "factory-deck",
      "flexfactor",
    ] as const) {
      expect(
        afterRestart.stations.find((station) => station.stationId === stationId)
          ?.status,
      ).toBe("completed");
    }
    expect(
      afterRestart.stations.filter((station) => station.status === "active"),
    ).toHaveLength(0);

    const factory = afterRestart.stations.find(
      (station) => station.stationId === "factory-deck",
    )!;
    const expectedHex = createHash("sha256")
      .update(JSON.stringify({ projectId, files: ["a.txt", "b.txt"], bytes: 42 }))
      .digest("hex");
    expect(factory.evidenceDigest).toBe(`sha256:${expectedHex}`);
    expect(factory.revision).toBe(`rev-${expectedHex.slice(0, 12)}`);

    const stale = await fetch(
      `${baseUrl}/projects/${projectId}/stations/scout/events`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          status: "completed",
          summary: "duplicate",
          artifacts: [],
          evidence: {},
        }),
      },
    );
    expect(stale.status).toBe(409);

    const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    type Event = {
      sequence: number;
      timestamp: number;
      projectId: string;
      stationId: StationId;
      type: string;
      payload: unknown;
      previousHash: string | null;
      hash: string;
    };
    const events = lines.map((line) => JSON.parse(line) as Event);
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const unsigned = {
        sequence: event.sequence,
        timestamp: event.timestamp,
        projectId: event.projectId,
        stationId: event.stationId,
        type: event.type,
        payload: event.payload,
        previousHash: event.previousHash,
      };
      const recomputed = createHash("sha256")
        .update(JSON.stringify(unsigned))
        .digest("hex");
      expect(event.hash).toBe(recomputed);
      if (i === 0) expect(event.previousHash).toBeNull();
      else expect(event.previousHash).toBe(events[i - 1]!.hash);
    }
  });
});
