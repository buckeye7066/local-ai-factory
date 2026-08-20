import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FoundryAdapters,
  FOUNDRY_FLEXFACTOR_PROVIDER_RE,
  repoRewardsQuery,
  repoSourceFromTarget,
} from "../foundry/adapters.js";
import {
  EXTEND_PERSISTENCE_CONTRACT,
  withExtendPersistenceGoals,
} from "../orchestrator/composeExtendIdea.js";
import {
  FoundryStore,
  STATIONS,
  intakeFromMarkdown,
} from "../foundry/model.js";

describe("Purpose Foundry", () => {
  it("accepts FlexFactor xai and grok providers used by Factory Deck paid routes", () => {
    expect(FOUNDRY_FLEXFACTOR_PROVIDER_RE.test("ollama")).toBe(true);
    expect(FOUNDRY_FLEXFACTOR_PROVIDER_RE.test("anthropic")).toBe(true);
    expect(FOUNDRY_FLEXFACTOR_PROVIDER_RE.test("openai")).toBe(true);
    expect(FOUNDRY_FLEXFACTOR_PROVIDER_RE.test("xai")).toBe(true);
    expect(FOUNDRY_FLEXFACTOR_PROVIDER_RE.test("grok")).toBe(true);
    expect(FOUNDRY_FLEXFACTOR_PROVIDER_RE.test("azure")).toBe(false);
  });

  it("uses the directed FlexFactor run script by default in descriptors and process mode", async () => {
    const previousScript = process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT;
    delete process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT;
    try {
      const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
      const store = new FoundryStore(root);
      const project = await store.create(
        intakeFromMarkdown(
          "---\nproject: GrantFlow\npurpose: Match people to real funding\ntargets: buckeye7066/GrantFlow\n---\n# GrantFlow",
          "C:/Vault/GrantFlow.md",
        ),
      );
      let receivedArgs: string[] = [];
      const adapters = new FoundryAdapters(store, {
        processRunner: async (_python, args) => {
          receivedArgs = args;
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      });

      const descriptors = adapters.descriptors();
      const scout = descriptors.find((descriptor) => descriptor.stationId === "scout");
      const flexfactor = descriptors.find(
        (descriptor) => descriptor.stationId === "flexfactor",
      );
      const directedScript = "C:\\Users\\firer\\flexfactor\\flexfactor_run.py";
      expect(scout?.destination).toBe(directedScript);
      expect(flexfactor?.destination).toBe(directedScript);

      await adapters.execute(project, "scout");
      expect(receivedArgs[0]).toBe(directedScript);
    } finally {
      if (previousScript === undefined)
        delete process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT;
      else process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT = previousScript;
    }
  });

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
    expect(project.stations[0].stationId).toBe("scout");
    expect(
      project.stations.findIndex(
        (station) => station.stationId === "factory-deck",
      ),
    ).toBeGreaterThan(
      project.stations.findIndex(
        (station) => station.stationId === "promo-pilot",
      ),
    );
    expect(
      project.stations.every((station) => station.status === "queued"),
    ).toBe(true);
  });

  it("deduplicates an unchanged Obsidian note and hash-chains evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown(
      "# GrantFlow\nFind and match real funding.",
      "C:/Vault/GrantFlow.md",
    );
    const first = await store.create(intake);
    const second = await store.create(intake);
    await store.appendEvidence(first.id, "crucible", "challenge.recorded", {
      severity: "high",
    });

    expect(second.id).toBe(first.id);
    const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { hash: string; previousHash: string | null },
      );
    expect(lines).toHaveLength(2);
    expect(lines[1].previousHash).toBe(lines[0].hash);
  });

  it("serializes simultaneous evidence writes without losing the chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown(
        "# FutureU\nBuild a complete curriculum platform.",
        "C:/Vault/FutureU.md",
      ),
    );
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.appendEvidence(project.id, "crucible", "challenge.recorded", {
          index,
        }),
      ),
    );
    const lines = (await readFile(join(root, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            sequence: number;
            hash: string;
            previousHash: string | null;
          },
      );
    expect(lines).toHaveLength(13);
    lines.forEach((event, index) => {
      expect(event.sequence).toBe(index + 1);
      expect(event.previousHash).toBe(
        index === 0 ? null : lines[index - 1].hash,
      );
    });
  });

  it("deduplicates simultaneous project creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const intake = intakeFromMarkdown(
      "# GeneMap\nMap evidence to genes.",
      "C:/Vault/GeneMap.md",
    );
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
    await writeFile(
      join(inbox, "GrantFlow.md"),
      "# GrantFlow\r\nFind funding.\r\n",
      "utf8",
    );
    await writeFile(outside, "# Private\nDo not import.\n", "utf8");
    await symlink(outside, join(inbox, "outside.md"));
    const store = new FoundryStore(root);

    const first = await store.importObsidianInbox(inbox);
    const second = await store.importObsidianInbox(inbox);
    expect(first.imported).toBe(1);
    expect(first.errors.some((error) => error.startsWith("outside.md:"))).toBe(
      true,
    );
    expect(second.imported).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("carries the extend persistence contract into Factory Deck extend goals", () => {
    const goals = withExtendPersistenceGoals(["Match people to real funding"]);
    expect(goals).toContain(EXTEND_PERSISTENCE_CONTRACT);
    expect(goals[0]).toBe("Match people to real funding");
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
        return new Response(
          JSON.stringify({ results: [{ name: "useful/repo" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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

    const outside = await mkdtemp(
      join(tmpdir(), "purpose-foundry-artifact-outside-"),
    );
    const stationParent = join(root, "artifacts", project.id);
    await mkdir(stationParent, { recursive: true });
    await symlink(outside, join(stationParent, "watchtower"), "dir");
    await expect(
      store.writeArtifact(project.id, "watchtower", "health.json", {}),
    ).rejects.toThrow("escapes the Foundry data root");
  });

  it("does not mistake an artifact filename for an App Store submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown("# IPlay\nShip the mobile app.", "C:/Vault/IPlay.md"),
    );
    project.stations.find(
      (station) => station.stationId === "factory-deck",
    )!.artifacts = ["C:/build/IPlay.aab"];
    {
      const adapters = new FoundryAdapters(store, {
        fetch: async (url) => {
          const path = new URL(String(url)).pathname;
          const body =
            path === "/api/stores"
              ? { stores: [{ id: "google_play", configured: true }] }
              : path === "/api/presets"
                ? {
                    presets: [
                      {
                        id: "iplay",
                        label: "IPlay",
                        packageName: "com.iplay.app",
                      },
                    ],
                  }
                : path === "/api/submissions"
                  ? { submissions: [] }
                  : { ok: true };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const outcome = await adapters.execute(project, "app-store-publisher");
      expect(outcome.status).toBe("needs_attention");
      expect(outcome.evidence).toMatchObject({
        uploaded: false,
        submitted: false,
      });
      expect(outcome.summary).toContain("requiring attention");
    }
  });

  it("streams, checksum-verifies, dry-runs, and submits a real build through Publisher", async () => {
    const root = await mkdtemp(join(tmpdir(), "purpose-foundry-"));
    const target = await mkdtemp(join(tmpdir(), "purpose-foundry-release-"));
    const release = join(target, "grantflow-release.aab");
    const bytes = Buffer.from("PK\u0003\u0004purpose-foundry-test-build");
    await writeFile(release, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new FoundryStore(root);
    const project = await store.create(
      intakeFromMarkdown(
        `---\nproject: GrantFlow\npurpose: Ship verified funding tools\ntargets: ${target}\n---\n# GrantFlow`,
        "C:/Vault/GrantFlow.md",
      ),
    );
    project.stations.find(
      (station) => station.stationId === "factory-deck",
    )!.artifacts = [release];
    const calls: string[] = [];
    {
      const adapters = new FoundryAdapters(store, {
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          calls.push(`${init?.method || "GET"} ${path}`);
          let body: Record<string, unknown>;
          if (path === "/api/stores") {
            body = {
              stores: [
                { id: "google_play", label: "Google Play", configured: true },
              ],
            };
          } else if (path === "/api/presets") {
            body = {
              presets: [
                {
                  id: "grantflow",
                  label: "GrantFlow",
                  repo: "buckeye7066/GrantFlow",
                  packageName: "com.grantflow.app",
                },
              ],
            };
          } else if (path === "/api/submissions") {
            body = { submissions: [] };
          } else if (path === "/api/upload") {
            const chunks: Buffer[] = [];
            for await (const chunk of init?.body as AsyncIterable<Uint8Array>)
              chunks.push(Buffer.from(chunk));
            const multipart = Buffer.concat(chunks);
            expect(multipart.includes(bytes)).toBe(true);
            expect(multipart.toString("latin1")).toContain(sha256);
            expect(init?.headers).toMatchObject({
              "x-purpose-foundry-client": "purpose-foundry",
            });
            body = {
              uploadId: "upload-1",
              fileName: "grantflow-release.aab",
              sha256,
              inspection: { fields: { packageId: "com.grantflow.app" } },
            };
          } else if (path === "/api/submit") {
            const request = JSON.parse(String(init?.body)) as {
              dryRun?: boolean;
            };
            body = request.dryRun
              ? {
                  approvalToken: "approval-1",
                  artifactEvidence: {
                    stores: [{ unknowns: [], mismatches: [] }],
                  },
                  plannedMutations: [],
                }
              : {
                  results: [
                    {
                      store: "google_play",
                      status: "success",
                      state: "published",
                    },
                  ],
                };
          } else {
            body = { ok: true };
          }
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const outcome = await adapters.execute(project, "app-store-publisher");
      expect(outcome.status).toBe("completed");
      expect(outcome.evidence).toMatchObject({
        uploaded: true,
        submitted: true,
        submittedStores: 1,
      });
      expect(calls).toContain("POST /api/upload");
      expect(calls.filter((call) => call === "POST /api/submit")).toHaveLength(
        2,
      );
    }
  });
});
