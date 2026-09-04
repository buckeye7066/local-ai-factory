import { afterAll, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FactoryCheckpointSchema,
  type FactoryCheckpoint,
} from "../orchestrator/checkpoint.js";
import {
  MAX_PERSISTED_PASSED_TEST_NAMES,
  MAX_PERSISTED_TEST_NAME_CHARS,
} from "../orchestrator/directTestEvidence.js";

const DATA_DIR = ".test-checkpoint-evidence-bounds";
process.env.FACTORY_DATA_DIR = DATA_DIR;
const dataPath = resolve(DATA_DIR);

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  vi.resetModules();
  await rm(dataPath, { recursive: true, force: true });
});

describe("checkpoint evidence bounds", () => {
  it("preserves prototype-named platform artifact keys while parsing", () => {
    const checkpoint = FactoryCheckpointSchema.parse({
      schemaVersion: 3,
      runId: crypto.randomUUID(),
      idea: "Preserve the complete artifact seal",
      options: {},
      verification: {
        platformArtifactSnapshot: JSON.parse(
          '{"__proto__":"file:regular:exact-digest"}',
        ),
      },
      updatedAt: Date.now(),
    });
    const restored = checkpoint.verification!.platformArtifactSnapshot!;

    expect(Object.getPrototypeOf(restored)).toBeNull();
    expect(Object.hasOwn(restored, "__proto__")).toBe(true);
    expect(restored["__proto__"]).toBe("file:regular:exact-digest");
  });

  it("bounds reporter-controlled titles in the persisted JSON", async () => {
    vi.resetModules();
    const { saveRunCheckpoint } = await import("../storage/runsStore.js");
    const runId = crypto.randomUUID();
    const oversized = "z".repeat(MAX_PERSISTED_TEST_NAME_CHARS + 1);
    const names = [
      oversized,
      ...Array.from(
        { length: MAX_PERSISTED_PASSED_TEST_NAMES + 50 },
        (_, index) => `${index}:${"x".repeat(MAX_PERSISTED_TEST_NAME_CHARS - 20)}`,
      ),
    ];
    const checkpoint = {
      schemaVersion: 3,
      runId,
      idea: "Bound direct evidence",
      options: { demo: true },
      files: [],
      builderExistingPaths: [],
      hostFileBaselines: {},
      writeRefusals: [],
      blockingWriteRefusals: [],
      testWriterComplete: false,
      commandOutput: "",
      verification: {
        executed: [
          {
            command: "npx --no-install vitest",
            exitCode: 0,
            passedTestNames: names,
            outputTail: "",
          },
        ],
      },
      testsExecuted: true,
      testExit: 0,
      repairLoops: 0,
      repairComplete: false,
      updatedAt: Date.now(),
    } as unknown as FactoryCheckpoint;

    await saveRunCheckpoint(checkpoint);
    const raw = JSON.parse(
      await readFile(resolve(dataPath, "checkpoints", `${runId}.json`), "utf8"),
    ) as {
      verification: { executed: Array<{ passedTestNames: string[] }> };
    };
    const persisted = raw.verification.executed[0]!.passedTestNames;
    expect(persisted).toHaveLength(MAX_PERSISTED_PASSED_TEST_NAMES);
    expect(
      persisted.every((name) => name.length <= MAX_PERSISTED_TEST_NAME_CHARS),
    ).toBe(true);
    expect(persisted).not.toContain(oversized.slice(0, MAX_PERSISTED_TEST_NAME_CHARS));
  });
});
