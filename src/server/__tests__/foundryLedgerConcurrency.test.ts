import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FoundryStore, hashText } from "../foundry/model.js";

type EvidenceEvent = Awaited<ReturnType<FoundryStore["appendEvidence"]>>;

describe("Foundry evidence ledger concurrency", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("serializes writes from recreated stores sharing one ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "foundry-ledger-"));
    roots.push(root);
    const stores = Array.from({ length: 64 }, () => new FoundryStore(root));
    const projectId = randomUUID();

    await Promise.all(
      stores.map((store, index) =>
        store.appendEvidence(
          projectId,
          "factory-deck",
          `concurrent.${index}`,
          { index },
        ),
      ),
    );

    const events = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvidenceEvent);

    expect(events).toHaveLength(stores.length);
    expect(new Set(events.map((event) => event.type)).size).toBe(stores.length);
    for (const [index, event] of events.entries()) {
      const { hash, ...unsigned } = event;
      expect(event.sequence).toBe(index + 1);
      expect(event.previousHash).toBe(
        index === 0 ? null : events[index - 1].hash,
      );
      expect(hash).toBe(hashText(JSON.stringify(unsigned)));
    }
  });
});
