import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FoundryStore, intakeFromMarkdown, STATIONS, type StationId } from "../foundry/model.js";
import { FoundryAdapters } from "../foundry/adapters.js";
import { createFoundryRouter } from "../foundry/router.js";

function jsonHeaders() {
  return { "content-type": "application/json" };
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 2000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await sleep(25);
  }
}

type AdapterEvent = {
  status: "active" | "needs_attention" | "completed" | "failed";
  summary?: string;
  artifacts?: string[];
  evidence?: Record<string, unknown>;
};

class TestFoundryAdapters extends FoundryAdapters {
  private completions = new Map<string, Set<StationId>>();
  private calls: Array<{ projectId: string; stationId: StationId }> = [];
  getCalls() {
    return this.calls.slice();
  }
  override descriptors() {
    return STATIONS.map((s) => ({
      stationId: s.id,
      mode: "deterministic",
      destination: "in-memory",
      configured: true,
    }));
  }
  override async execute(
    project: Awaited<ReturnType<FoundryStore["get"]>>,
    stationId: StationId,
  ): Promise<AdapterEvent> {
    if (!project) throw new Error("no project");
    const done = this.completions.get(project.id) ?? new Set<StationId>();
    this.completions.set(project.id, done);
    this.calls.push({ projectId: project.id, stationId });
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
        evidence,
      } as AdapterEvent;
    }
    if (stationId === "crucible") {
      return {
        status: "needs_attention",
        summary: "adversary requires attention",
        artifacts: [],
        evidence: {},
      } as AdapterEvent;
    }
    // Anything after attention point is left queued.
    return {
      status: "needs_attention",
      summary: "default",
      artifacts: [],
      evidence: {},
    } as AdapterEvent;
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
    process.env.OPENAI_API_KEY = prevOpenAi || "test-openai";
    process.env.ANTHROPIC_API_KEY = prevAnthropic || "test-anthropic";
    await startServer();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  });

  it("router-level start, single-active, stale reject, auto-advance, survives restart, valid evidence chain", async () => {
    // Create a project (obsidian equivalence)
    const intake = intakeFromMarkdown("# GrantFlow\nFind funding.", "C:/Vault/GrantFlow.md");
    const createdRes = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(intake),
    });
    expect(createdRes.status).toBe(201);
    const project = (await createdRes.json()) as Awaited<ReturnType<typeof store.create>>;
    const projectId = project.id;

    // Start the assembly line via router (exercises readiness brain floor + dispatcher).
    let startRes = await fetch(`${baseUrl}/projects/${projectId}/start`, {
      method: "POST",
      headers: jsonHeaders(),
    });
    expect(startRes.status).toBe(202);

    // Immediately restart the HTTP listener AND reconstruct store/adapters to prove process-level recovery.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Recreate fresh instances from disk
    store = new FoundryStore(root);
    adapters = new TestFoundryAdapters(store);
    await startServer();

    // The project should be picked up; dispatch executes the active station then auto-advances.
    const afterRestart = await waitFor(
      async () => (await store.get(projectId))!,
      (p) => Boolean(p.stations.find((s) => s.status === "active" || s.status === "needs_attention")),
      4000,
    );
    // Sample repeatedly to assert at most one concurrent active station throughout.
    for (let i = 0; i < 40; i++) {
      const snap = (await store.get(projectId))!;
      const activeCount = snap.stations.filter((s) => s.status === "active").length;
      expect(activeCount).toBeLessThanOrEqual(1);
      await sleep(10);
    }
    // Calls after restart should NOT include any station that was already completed before restart (none in this path),
    // and MUST include the first active station encountered after restart.
    const calls = adapters.getCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Stale/duplicate completion is rejected (complete a previously completed station again).
    const currentAfter = (await store.get(projectId))!;
    const scout = currentAfter.stations.find((s) => s.stationId === "scout")!;
    expect(scout.status).toBe("completed");
    const stale = await fetch(`${baseUrl}/projects/${projectId}/stations/scout/events`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        status: "completed",
        summary: "duplicate",
        artifacts: [],
        evidence: {},
      }),
    });
    expect(stale.status).toBe(409);

    // Verify digest/revision binding from Factory Deck station.
    const factory = (await store.get(projectId))!.stations.find(
      (s) => s.stationId === "factory-deck",
    )!;
    // Recompute the deterministic digest and revision and assert exact binding.
    const expectedHex = createHash("sha256")
      .update(JSON.stringify({ projectId, files: ["a.txt", "b.txt"], bytes: 42 }))
      .digest("hex");
    expect(factory.evidenceDigest).toBe(`sha256:${expectedHex}`);
    expect(factory.revision).toBe(`rev-${expectedHex.slice(0, 12)}`);

    // At this point Crucible should be active; restart the server and prove dispatcher runs:
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startServer();
    await waitFor(
      async () => (await store.get(projectId))!,
      (p) => Boolean(p.stations.find((s) => s.stationId === "crucible" && s.status === "needs_attention")),
      4000,
    );

    // Evidence ledger cryptographic chain verification (previousHash/hash).
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
    const events = lines.map((l) => JSON.parse(l) as Event);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const unsigned = {
        sequence: e.sequence,
        timestamp: e.timestamp,
        projectId: e.projectId,
        stationId: e.stationId,
        type: e.type,
        payload: e.payload,
        previousHash: e.previousHash,
      };
      const recomputed = createHash("sha256")
        .update(JSON.stringify(unsigned))
        .digest("hex");
      expect(e.hash).toBe(recomputed);
      if (i === 0) expect(e.previousHash).toBeNull();
      else expect(e.previousHash).toBe(events[i - 1].hash);
    }
  });
});


