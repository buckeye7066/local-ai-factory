import { describe, it, expect, afterAll, vi } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { freshStages } from "../../shared/schemas.js";
import type { RunRecord, FileContent } from "../../shared/schemas.js";

/**
 * Round-11 #1-#4 — redaction must happen at the SERVE/LOAD boundary, not only on
 * write. A raw record planted on disk (an OLD pre-fix record, or a locally
 * planted file) must be scrubbed by getRun / listRuns / getRunFiles on the way
 * out — covering idea, appName, workspacePath, error, log messages, finalReport,
 * and file path/purpose/contents.
 */

const DATA_DIR = ".test-factory-serveredact";
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

const SECRET = "sk-ant-PLANTEDsecret0123456789abc";

function plantedRun(id: string): RunRecord {
  return {
    id,
    idea: `Build X DATABASE_URL=postgres://user:pass@host/db`,
    status: "completed",
    demo: true,
    codeProvider: "stub",
    reviewProvider: "stub",
    currentStage: null,
    stages: freshStages(),
    logs: [
      {
        id: crypto.randomUUID(),
        ts: Date.now(),
        stage: null,
        kind: "info",
        message: `leaked openai_api_key=${SECRET}`,
      },
    ],
    files: [
      {
        path: `src/${SECRET}.ts`,
        language: "typescript",
        size: 1,
        status: "generated",
        purpose: `uses ${SECRET}`,
      },
    ],
    repairLoops: 0,
    providerUsage: {
      anthropic: { calls: 0 },
      openai: { calls: 0 },
      stub: { calls: 0 },
      totalCalls: 0,
    },
    finalReport: {
      appName: "App",
      summary: `done token=${SECRET}`,
      whatWasBuilt: [],
      howToRun: "run",
      testStatus: "unknown",
      repairLoops: 0,
      caveats: [`note ${SECRET}`],
      nextImprovements: [],
      workspacePath: "(ws)",
      providerUsage: {
        anthropic: { calls: 0 },
        openai: { calls: 0 },
        stub: { calls: 0 },
        totalCalls: 0,
      },
    },
    appName: `App OPENAI_API_KEY=${SECRET}`,
    workspacePath: `/tmp/ws password=hunter2`,
    error: `boom SECRET_KEY=${SECRET}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as RunRecord;
}

describe("Round-11 #1/#3 getRun + listRuns scrub old/planted raw run records", () => {
  it("redacts idea/appName/workspacePath/error/logs/finalReport in getRun", async () => {
    const id = crypto.randomUUID();
    await mkdir(join(dataPath, "runs"), { recursive: true });
    await writeFile(
      join(dataPath, "runs", `${id}.json`),
      JSON.stringify(plantedRun(id)),
      "utf8",
    );

    const store = await freshStore();
    const run = await store.getRun(id);
    expect(run).not.toBeNull();
    const blob = JSON.stringify(run);
    // No secret shape survives anywhere in the served record.
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("user:pass");
    // Spot checks on the individual fields.
    expect(run!.idea).toMatch(/\[REDACTED/);
    expect(run!.appName!).toMatch(/\[REDACTED/); // #3 appName redacted where served
    expect(run!.workspacePath!).toMatch(/\[REDACTED/);
    expect(run!.error!).toMatch(/\[REDACTED/);
    expect(run!.logs[0].message).toMatch(/\[REDACTED/);
    expect(run!.finalReport!.summary).toMatch(/\[REDACTED/);
    expect(run!.files[0].path).toMatch(/\[REDACTED/);
  });

  it("redacts idea/appName/workspacePath in the listRuns summary", async () => {
    const id = crypto.randomUUID();
    await mkdir(join(dataPath, "runs"), { recursive: true });
    await writeFile(
      join(dataPath, "runs", `${id}.json`),
      JSON.stringify(plantedRun(id)),
      "utf8",
    );

    const store = await freshStore();
    const runs = await store.listRuns();
    const row = runs.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain("hunter2");
    expect(row!.idea).toMatch(/\[REDACTED/);
    expect(row!.appName!).toMatch(/\[REDACTED/);
    expect(row!.workspacePath!).toMatch(/\[REDACTED/);
  });
});

describe("Round-11 #2/#4 getRunFiles scrubs old/planted raw file records", () => {
  it("redacts contents AND path/purpose of a planted file record", async () => {
    const id = crypto.randomUUID();
    await mkdir(join(dataPath, "files"), { recursive: true });
    const planted: FileContent[] = [
      {
        path: `config/${SECRET}.env`,
        language: "dotenv",
        size: 10,
        status: "generated",
        purpose: `contains OPENAI_API_KEY=${SECRET}`,
        contents: `SECRET_KEY=${SECRET}\nDATABASE_URL=postgres://u:p@h/db`,
      },
    ];
    await writeFile(
      join(dataPath, "files", `${id}.json`),
      JSON.stringify(planted),
      "utf8",
    );

    const store = await freshStore();
    const files = await store.getRunFiles(id);
    expect(files).toHaveLength(1);
    const blob = JSON.stringify(files[0]);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("u:p@h");
    expect(files[0].path).toMatch(/\[REDACTED/);
    expect(files[0].purpose).toMatch(/\[REDACTED/);
    expect(files[0].contents).toMatch(/\[REDACTED/);
  });
});
