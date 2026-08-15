import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FoundryAdapters, repoRewardsQuery, repoSourceFromTarget } from "../foundry/adapters.js";
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

  it("deduplicates simultaneous project creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown("# GeneMap\nMap evidence to genes.", "C:/Vault/GeneMap.md");
    const projects = await Promise.all(
      Array.from({ length: 8 }, () => store.create(intake)),
    );
    expect(new Set(projects.map((project) => project.id)).size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("normalizes Windows notes and refuses a symlink outside the inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const inbox = await mkdtemp(join(tmpdir(), "purpose-foundry-inbox-"));
    const outside = join(root, "outside.md");
    await writeFile(join(inbox, "GrantFlow.md"), "# GrantFlow\r\nFind funding.\r\n", "utf8");
    await writeFile(outside, "# Private\nDo not import.\n", "utf8");
    await symlink(outside, join(inbox, "outside.md"));
    const store = new FoundryStore(root);

    const first = await store.importObsidianInbox(inbox);
    const second = await store.importObsidianInbox(inbox);
    expect(first.imported).toBe(1);
    expect(first.errors.some((error) => error.startsWith("outside.md:"))).toBe(true);
    expect(second.imported).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("classifies explicit repository targets without guessing prose", () => {
    expect(repoSourceFromTarget("buckeye7066/GrantFlow")).toEqual({
      type: "git",
      location: "https://github.com/buckeye7066/GrantFlow.git",
    });
    expect(repoSourceFromTarget("C:\\Users\\firer\\GrantFlow")).toEqual({
      type: "path",
      location: "C:\\Users\\firer\\GrantFlow",
    });
    expect(repoSourceFromTarget("the grant program on my desktop")).toBeNull();
  });

  it("runs the Repo Rewards adapter and persists its evidence inside the artifact jail", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown(
        "---\nproject: GrantFlow\npurpose: Match people to real funding\nsuccess: verified live opportunities\n---\n# GrantFlow",
        "C:/Vault/GrantFlow.md",
      ),
    );
    let posted: unknown = null;
    const adapters = new FoundryAdapters(store, {
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ results: [{ name: "useful/repo" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const outcome = await adapters.execute(project, "repo-rewards");

    expect(outcome.status).toBe("completed");
    expect(posted).toMatchObject({ lens: "best", sessionId: project.id });
    expect(repoRewardsQuery(project)).toContain("verified live opportunities");
    expect(outcome.artifacts[0]).toContain(join(project.id, "repo-rewards"));
    expect(JSON.parse(await readFile(outcome.artifacts[0], "utf8"))).toEqual({
      results: [{ name: "useful/repo" }],
    });
    await expect(
      store.writeArtifact(project.id, "repo-rewards", "../escape.json", {}),
    ).rejects.toThrow("Invalid artifact filename");

    const outside = await mkdtemp(join(tmpdir(), "purpose-foundry-artifact-outside-"));
    const stationParent = join(root, "artifacts", project.id);
    await mkdir(stationParent, { recursive: true });
    await symlink(outside, join(stationParent, "watchtower"), "dir");
    await expect(
      store.writeArtifact(project.id, "watchtower", "health.json", {}),
    ).rejects.toThrow("escapes the Foundry data root");
  });
});
