import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataRoot = resolve(process.cwd(), ".test-factory-data-idempotency-atomic");
process.env.FACTORY_DATA_DIR = dataRoot;

const { startIdempotently, _resetIdempotencyForTests } = await import(
  "../storage/idempotency.js"
);
const { inspectDurableRun } = await import("../storage/runsStore.js");

beforeEach(async () => {
  await rm(dataRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  _resetIdempotencyForTests();
});

afterAll(async () => {
  await rm(dataRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  delete process.env.FACTORY_DATA_DIR;
});

describe("atomic idempotent run starts", () => {
  it("invokes the starter once and returns one run id under concurrency", async () => {
    let starts = 0;
    const start = async (id: string) => {
      starts += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      return { id };
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        startIdempotently("same-request", "Build the same app", start),
      ),
    );

    expect(starts).toBe(1);
    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "existing")).toHaveLength(19);
  });

  it("reports a conflict when a durable key is reused for another idea", async () => {
    await startIdempotently("reused-key", "First idea", (id) => ({ id }));
    await expect(
      startIdempotently("reused-key", "Different idea", (id) => ({ id })),
    ).resolves.toMatchObject({ status: "conflict" });
  });

  it("releases its reservation when the starter fails before creating a run", async () => {
    await expect(
      startIdempotently("retry-key", "Retryable idea", () => {
        throw new Error("provider unavailable");
      }),
    ).rejects.toThrow("provider unavailable");

    await expect(
      startIdempotently("retry-key", "Retryable idea", (id) => ({ id })),
    ).resolves.toMatchObject({ status: "created" });
  });

  it("does not report an unfinished durable reservation as an existing run", async () => {
    const key = "pending-key";
    const idea = "An interrupted idea";
    const filename = createHash("sha256").update(key).digest("hex") + ".json";
    const directory = resolve(dataRoot, "idempotency");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, filename),
      JSON.stringify({
        runId: "00000000-0000-4000-8000-000000000001",
        ideaHash: createHash("sha256").update(idea).digest("hex").slice(0, 32),
        createdAt: Date.now(),
        state: "pending",
        claimToken: "00000000-0000-4000-8000-000000000002",
      }),
      "utf8",
    );
    let starts = 0;

    const result = await startIdempotently(key, idea, (id) => {
      starts += 1;
      return { id };
    });

    expect(result).toMatchObject({
      status: "pending",
      runId: "00000000-0000-4000-8000-000000000001",
    });
    expect(starts).toBe(0);
  });

  it("recovers one abandoned reservation with its original run id", async () => {
    const key = "abandoned-key";
    const idea = "Recover this build";
    const runId = "00000000-0000-4000-8000-000000000011";
    const filename = createHash("sha256").update(key).digest("hex") + ".json";
    const directory = resolve(dataRoot, "idempotency");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, filename),
      JSON.stringify({
        runId,
        ideaHash: createHash("sha256").update(idea).digest("hex").slice(0, 32),
        createdAt: Date.now() - 60_000,
        state: "pending",
        claimToken: "00000000-0000-4000-8000-000000000012",
      }),
      "utf8",
    );
    let starts = 0;
    const start = async (id: string) => {
      starts += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      return { id };
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        startIdempotently(key, idea, start, async () => "missing"),
      ),
    );

    expect(starts).toBe(1);
    expect(new Set(results.map((result) => result.runId))).toEqual(new Set([runId]));
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "existing")).toHaveLength(19);
  });

  it("promotes a pending receipt backed by a durable run without restarting", async () => {
    const key = "persisted-pending-key";
    const idea = "Already persisted";
    const runId = "00000000-0000-4000-8000-000000000021";
    const filename = createHash("sha256").update(key).digest("hex") + ".json";
    const directory = resolve(dataRoot, "idempotency");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, filename),
      JSON.stringify({
        runId,
        ideaHash: createHash("sha256").update(idea).digest("hex").slice(0, 32),
        createdAt: Date.now() - 60_000,
        state: "pending",
        claimToken: "00000000-0000-4000-8000-000000000022",
      }),
      "utf8",
    );
    let starts = 0;

    const result = await startIdempotently(
      key,
      idea,
      (id) => {
        starts += 1;
        return { id };
      },
      async () => "present",
    );

    expect(result).toEqual({ status: "existing", runId });
    expect(starts).toBe(0);
  });

  it("fails closed when a durable run receipt is corrupt", async () => {
    const runId = "00000000-0000-4000-8000-000000000031";
    const runsDirectory = resolve(dataRoot, "runs");
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(resolve(runsDirectory, `${runId}.json`), '{"id":', "utf8");

    await expect(inspectDurableRun(runId)).rejects.toThrow(
      /durable run receipt is corrupt/i,
    );
  });

  it("fails closed on a malformed durable receipt", async () => {
    const key = "corrupt-key";
    const filename = createHash("sha256").update(key).digest("hex") + ".json";
    const directory = resolve(dataRoot, "idempotency");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, filename), '{"runId":', "utf8");

    await expect(startIdempotently(key, "An idea", (id) => ({ id }))).rejects.toThrow(
      /malformed JSON/i,
    );
  });
});
