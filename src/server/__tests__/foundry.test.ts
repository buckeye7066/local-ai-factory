import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FoundryStore, STATIONS, intakeFromMarkdown } from "../foundry/model.js";

describe("Purpose Foundry", () => {
  it("turns an Obsidian note into a versioned project constitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown(
      `---\nproject: IPlay\npurpose: Produce believable avatar performances\ntarget_users: musicians, creators\nsuccess: correct fingering, synchronized audio\ntargets: buckeye7066/IPlay\n---\n# IPlay\nBuild the complete performance pipeline.`,
      "C:/Vault/Purpose Foundry/IPlay.md",
    );
    const project = await store.create(intake);

    expect(project.name).toBe("IPlay");
    expect(project.constitution.targetUsers).toEqual(["musicians", "creators"]);
    expect(project.constitution.targets).toEqual(["buckeye7066/IPlay"]);
    expect(project.stations).toHaveLength(STATIONS.length);
    expect(project.stations.every((station) => station.status === "queued")).toBe(true);
  });

  it("deduplicates an unchanged Obsidian note and hash-chains evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown("# GrantFlow\nFind and match real funding.", "C:/Vault/GrantFlow.md");
    const first = await store.create(intake);
    const second = await store.create(intake);
    await store.appendEvidence(first.id, "crucible", "challenge.recorded", { severity: "high" });

    expect(second.id).toBe(first.id);
    const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { hash: string; previousHash: string | null });
    expect(lines).toHaveLength(2);
    expect(lines[1].previousHash).toBe(lines[0].hash);
  });

  it("serializes simultaneous evidence writes without losing the chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown("# FutureU\nBuild a complete curriculum platform.", "C:/Vault/FutureU.md"),
    );
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.appendEvidence(project.id, "crucible", "challenge.recorded", { index }),
      ),
    );
    const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; hash: string; previousHash: string | null });
    expect(lines).toHaveLength(13);
    lines.forEach((event, index) => {
      expect(event.sequence).toBe(index + 1);
      expect(event.previousHash).toBe(index === 0 ? null : lines[index - 1].hash);
    });
  });
});
