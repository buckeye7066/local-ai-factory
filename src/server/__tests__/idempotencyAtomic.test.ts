import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataRoot = resolve(process.cwd(), ".test-factory-data-idempotency-atomic");
process.env.FACTORY_DATA_DIR = dataRoot;

const { startIdempotently, _resetIdempotencyForTests } = await import(
  "../storage/idempotency.js"
);

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
