import { describe, it, expect, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileContent } from "../../shared/schemas.js";

/**
 * Round-10 #6 — generated file CONTENTS are persisted in `.factory/files` and
 * served by /api/runs/:runId/files. A generated `.env`/source line embedding a
 * secret must be redacted in the served + persisted copy (the raw file in the
 * disposable workspace stays intact — that's the product itself).
 */

const DATA_DIR = ".test-factory-filesredact";
process.env.FACTORY_DATA_DIR = DATA_DIR;
const dataPath = resolve(process.cwd(), DATA_DIR);

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(dataPath, { recursive: true, force: true });
});

async function freshStore() {
  vi.resetModules();
  return import("../storage/runsStore.js");
}

const SECRET = "sk-ant-FILEsecret0123456789abcdef";

describe("Round-10 #6 saveRunFiles redacts served + persisted file contents", () => {
  it("redacts secret-shaped content in the in-memory served copy", async () => {
    const store = await freshStore();
    const id = crypto.randomUUID();
    const files: FileContent[] = [
      {
        path: ".env",
        language: "dotenv",
        size: 32,
        status: "generated",
        purpose: "env file",
        contents: `SECRET_KEY=${SECRET}\nHELLO=world`,
      },
    ];
    store.saveRunFiles(id, files);

    const served = await store.getRunFiles(id);
    expect(served).toHaveLength(1);
    expect(served[0].contents).not.toContain(SECRET);
    expect(served[0].contents).toMatch(/\[REDACTED/);
    // Non-secret content is preserved.
    expect(served[0].contents).toContain("HELLO=world");
  }, 20_000); // freshStore() re-transforms the module graph; be generous under load

  it("persists the redacted copy to disk (survives a restart)", async () => {
    const store = await freshStore();
    const id = crypto.randomUUID();
    store.saveRunFiles(id, [
      {
        path: "config.ts",
        language: "typescript",
        size: 20,
        status: "generated",
        purpose: "config",
        contents: `export const KEY = "${SECRET}";`,
      },
    ]);

    // Disk write is fire-and-forget; wait until a fresh store reads it back.
    await vi.waitFor(
      async () => {
        const s2 = await freshStore();
        const fromDisk = await s2.getRunFiles(id);
        expect(fromDisk).toHaveLength(1);
        expect(fromDisk[0].contents).not.toContain(SECRET);
        expect(fromDisk[0].contents).toMatch(/\[REDACTED/);
      },
      { timeout: 15_000 },
    );
  }, 20_000);
});
