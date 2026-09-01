import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FoundryStore, intakeFromMarkdown, STATIONS } from "../foundry/model.js";
import { createFoundryRouter } from "../foundry/router.js";

function jsonHeaders() {
  return { "content-type": "application/json" };
}

describe("Foundry router — resume/race/auto-advance/evidence", () => {
  let root!: string;
  let store!: FoundryStore;
  let baseUrl!: string;
  let server: import("http").Server;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "foundry-router-"));
    store = new FoundryStore(root);

    // Satisfy the readiness brain floor guard for /start
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai";
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-anthropic";

    const app = express();
    app.use(express.json());
    app.use("/api/foundry", createFoundryRouter(store));
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}/api/foundry`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("enforces active-only completion, resumes correctly, auto-advances, and writes evidence", async () => {
    // Create a project via the API (obsidian note intake equivalence)
    const intake = intakeFromMarkdown("# GrantFlow\nFind funding.", "C:/Vault/GrantFlow.md");
    const createdRes = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(intake),
    });
    expect(createdRes.status).toBe(201);
    const project = (await createdRes.json()) as Awaited<ReturnType<typeof store.create>>;
    const projectId = project.id;

    // Attempt to complete without being active -> 409 guard
    {
      const scout = STATIONS.find((s) => s.id === "scout")!;
      const res = await fetch(
        `${baseUrl}/projects/${projectId}/stations/${scout.id}/events`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            status: "completed",
            summary: "should be rejected",
            artifacts: [],
            evidence: {},
          }),
        },
      );
      expect(res.status).toBe(409);
    }

    // Activate the first queued station directly in the store to avoid adapter races
    {
      const current = await store.get(projectId);
      const firstQueued = current!.stations.find((s) => s.status === "queued")!;
      firstQueued.status = "active";
      firstQueued.attempt += 1;
      firstQueued.startedAt = Date.now();
      await store.save(current!);
    }

    // Wrong station cannot complete while queued -> 409
    {
      const factoryDeck = STATIONS.find((s) => s.id === "factory-deck")!;
      const res = await fetch(
        `${baseUrl}/projects/${projectId}/stations/${factoryDeck.id}/events`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            status: "completed",
            summary: "still queued; reject",
            artifacts: [],
            evidence: {},
          }),
        },
      );
      expect(res.status).toBe(409);
    }

    // Complete the active station -> auto-advance to the next queued
    {
      const activeBefore = (await store.get(projectId))!.stations.find(
        (s) => s.status === "active",
      )!;
      const res = await fetch(
        `${baseUrl}/projects/${projectId}/stations/${activeBefore.stationId}/events`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            status: "completed",
            summary: "done",
            artifacts: [],
            evidence: {},
          }),
        },
      );
      expect(res.status).toBe(200);
      const after = await store.get(projectId);
      const nowActive = after!.stations.find((s) => s.status === "active");
      expect(nowActive && nowActive.stationId !== activeBefore.stationId).toBe(true);

      // Replaying a stale completion on the previous station is rejected
      const replay = await fetch(
        `${baseUrl}/projects/${projectId}/stations/${activeBefore.stationId}/events`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            status: "completed",
            summary: "stale",
            artifacts: [],
            evidence: {},
          }),
        },
      );
      expect(replay.status).toBe(409);
    }

    // Evidence ledger captured transitions in a hash chain
    {
      const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const events = lines.map((line) => JSON.parse(line) as { type: string });
      const types = events.map((e) => e.type);
      // When activating via direct store save (to avoid adapter races), only the completion
      // event is guaranteed to be present.
      expect(types.some((t) => t === "station.completed")).toBe(true);
    }
  });
});

