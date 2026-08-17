import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIR = ".vitest-factory-checkpoint-durability";
const dataRoot = resolve(process.cwd(), DATA_DIR);
process.env.FACTORY_DATA_DIR = DATA_DIR;

async function freshStore() {
  vi.resetModules();
  return import("../storage/runsStore.js");
}

async function plantCheckpoint(id: string, value: unknown): Promise<string> {
  const dir = resolve(dataRoot, "checkpoints");
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${id}.json`);
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

beforeEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("checkpoint migration and durability", () => {
  it.each([1, 2] as const)(
    "migrates v%s to v3 and atomically rewrites the durable record",
    async (schemaVersion) => {
      const id = crypto.randomUUID();
      const path = await plantCheckpoint(id, {
        schemaVersion,
        runId: id,
        idea: "continue without replay",
        options: { codeProvider: "anthropic", reviewProvider: "anthropic" },
        updatedAt: 1,
      });
      const store = await freshStore();

      const checkpoint = await store.getRunCheckpoint(id);

      expect(checkpoint).toMatchObject({
        schemaVersion: 3,
        runId: id,
        builderExistingPaths: [],
        hostFileBaselines: {},
        writeRefusals: [],
        blockingWriteRefusals: [],
        options: { allowPaidProviderCalls: true },
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        schemaVersion: 3,
        runId: id,
        options: { allowPaidProviderCalls: true },
      });
    },
  );

  it("does not infer paid authorization for a legacy free checkpoint", async () => {
    const id = crypto.randomUUID();
    await plantCheckpoint(id, {
      schemaVersion: 2,
      runId: id,
      idea: "free stays free",
      options: { codeProvider: "free", reviewProvider: "free" },
      updatedAt: 1,
    });
    const checkpoint = await (await freshStore()).getRunCheckpoint(id);
    expect(checkpoint?.options.allowPaidProviderCalls).toBe(false);
  });

  it("fails explicitly for malformed or unsupported checkpoints", async () => {
    const malformedId = crypto.randomUUID();
    const malformedPath = await plantCheckpoint(malformedId, {});
    await writeFile(malformedPath, "{ truncated", "utf8");
    let store = await freshStore();
    await expect(store.getRunCheckpoint(malformedId)).rejects.toMatchObject({
      name: "CheckpointPersistenceError",
      failure: "parse",
    });

    const futureId = crypto.randomUUID();
    await plantCheckpoint(futureId, {
      schemaVersion: 99,
      runId: futureId,
      idea: "future checkpoint",
      options: {},
      updatedAt: 1,
    });
    store = await freshStore();
    await expect(store.getRunCheckpoint(futureId)).rejects.toMatchObject({
      name: "CheckpointPersistenceError",
      failure: "migrate",
    });
  });

  it("fails explicitly for an invalid checkpoint identity", async () => {
    const store = await freshStore();

    await expect(store.getRunCheckpoint("../outside-the-store")).rejects.toMatchObject({
      name: "CheckpointPersistenceError",
      failure: "invalid",
      runId: "../outside-the-store",
    });
  });

  it("concurrent replacements leave one complete JSON value and no temp files", async () => {
    const dir = resolve(dataRoot, "atomic-proof");
    const target = resolve(dir, "record.json");
    await mkdir(dir, { recursive: true });
    const { writeFileContained } = await freshStore();
    const candidates = Array.from({ length: 24 }, (_, index) => ({
      index,
      payload: `value-${index}`.repeat(2_000),
    }));

    await Promise.all(
      candidates.map((candidate) =>
        writeFileContained(target, JSON.stringify(candidate)),
      ),
    );

    const persisted = JSON.parse(await readFile(target, "utf8")) as {
      index: number;
      payload: string;
    };
    expect(candidates).toContainEqual(persisted);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
