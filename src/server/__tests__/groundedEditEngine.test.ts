import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
} from "../../shared/types.js";
import type {
  Architecture,
  FileBuild,
  ProductSpec,
  TaskPlan,
} from "../../shared/schemas.js";
import { fileBuilderAgent } from "../agents/fileBuilderAgent.js";
import { repairAgent } from "../agents/repairAgent.js";
import { testWriterAgent } from "../agents/testWriterAgent.js";
import { qaCriticAgent } from "../agents/qaCriticAgent.js";
import {
  partitionRepairFiles,
  repairOutcomeMessage,
} from "../orchestrator/runFactory.js";
import { deliverRun } from "../orchestrator/deliverRun.js";
import { analyzeExistingCodebase } from "../workspace/analyzeExistingCodebase.js";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";

class CaptureProvider implements LLMProvider {
  readonly name = "stub" as const;
  lastSystem = "";
  lastPrompt = "";

  constructor(private readonly response: unknown) {}

  isConfigured(): boolean {
    return true;
  }

  async generateText(_input: GenerateTextInput): Promise<GenerateTextResult> {
    return { text: "", provider: "stub" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.lastSystem = input.system;
    this.lastPrompt = input.prompt;
    return input.schema.parse(this.response);
  }
}

const spec: ProductSpec = {
  appName: "GrantFlow",
  tagline: "",
  targetUser: "A non-technical grant seeker",
  coreFeatures: ["Organization profile"],
  dataModel: [],
  userFlows: ["Save, reload, and edit the profile"],
  acceptanceCriteria: [
    "Reloading shows the saved profile",
    "Blank optional fields save successfully",
  ],
};
const arch: Architecture = {
  overview: "Extend the real app",
  frontend: "React",
  backend: "Existing",
  dataModel: "Existing",
  risks: [],
};
const plan: TaskPlan = {
  tasks: [
    {
      order: 1,
      category: "frontend",
      title: "Wire profile",
      detail: "Update src/App.tsx",
    },
  ],
};
const currentApp =
  "export default function App(){ return <ExistingRoutes />; }";

describe("agent grounding contracts", () => {
  it("builder has one anchored-edit contract and honors the real host path", async () => {
    const provider = new CaptureProvider({
      files: [
        {
          path: "src/App.jsx",
          purpose: "wire profile",
          contents: "",
          edits: [
            {
              find: "<ExistingRoutes />",
              replace: "<><ExistingRoutes /><Profile /></>",
            },
          ],
        },
      ],
    });
    await fileBuilderAgent(
      { provider },
      spec,
      arch,
      plan,
      {
        fileTreeExcerpt: "src/App.jsx",
        manifestExcerpt: '{"dependencies":{"react":"^18"}}',
        readmeExcerpt: "",
        targetFiles: [{ path: "src/App.jsx", contents: currentApp }],
      },
    );
    expect(provider.lastPrompt).toContain("src/App.jsx");
    expect(provider.lastPrompt).toContain(currentApp);
    expect(provider.lastPrompt).not.toContain(
      "full contents for each new/changed file",
    );
    expect(provider.lastPrompt).toContain("EDIT THE REAL HOST PATH");
  });

  it("repair receives exact current code and returns anchored edits", async () => {
    const provider = new CaptureProvider({
      notes: "wire it",
      files: [
        {
          path: "src/App.jsx",
          purpose: "wire profile",
          contents: "",
          edits: [{ find: "<ExistingRoutes />", replace: "<Profile />" }],
        },
      ],
    });
    const build: FileBuild = {
      files: [
        {
          path: "src/App.jsx",
          purpose: "entry",
          contents: currentApp,
          edits: [],
        },
      ],
    };
    const result = await repairAgent(
      { provider },
      {
        summary: "unwired",
        passed: false,
        issues: [
          {
            severity: "high",
            title: "Unwired",
            detail: "Profile is unreachable",
            file: "src/App.jsx",
            repairInstruction: "Wire it",
          },
        ],
      },
      build,
      "test failed",
    );
    expect(provider.lastPrompt).toContain(currentApp);
    expect(provider.lastSystem).toContain("Existing files MUST use edits");
    expect(result.files[0]!.edits).toHaveLength(1);
  });

  it("test and QA agents see implementation plus acceptance criteria", async () => {
    const build: FileBuild = {
      files: [
        {
          path: "src/App.jsx",
          purpose: "entry",
          contents: currentApp,
          edits: [],
        },
      ],
    };
    const tests = new CaptureProvider({
      testPlan: "criterion: reload",
      files: [
        {
          path: "src/App.test.jsx",
          purpose: "reload",
          contents: "test('reload',()=>{})",
        },
      ],
    });
    await testWriterAgent(
      { provider: tests },
      spec,
      build,
      { manifestExcerpt: '{"devDependencies":{"vitest":"^3"}}' },
    );
    expect(tests.lastPrompt).toContain(currentApp);
    expect(tests.lastPrompt).toContain("Reloading shows the saved profile");
    expect(tests.lastPrompt).toContain("vitest");

    const qa = new CaptureProvider({ summary: "ok", passed: true, issues: [] });
    await qaCriticAgent({ provider: qa }, build, "all green", spec);
    expect(qa.lastPrompt).toContain(currentApp);
    expect(qa.lastPrompt).toContain("Blank optional fields save successfully");
  });
});

describe("repair accounting and scope are mechanical", () => {
  it("refuses paths outside the run's actual change set", () => {
    const partition = partitionRepairFiles(
      [
        { path: "src/App.jsx" },
        { path: "backend/tests/unrelated.test.js" },
        { path: "vitest.config.js" },
      ],
      ["src/App.jsx"],
    );
    expect(partition.accepted.map((file) => file.path)).toEqual(["src/App.jsx"]);
    expect(partition.refusals).toHaveLength(2);
  });

  it("refuses generated tests and tooling even when they are in the change set", () => {
    const partition = partitionRepairFiles(
      [
        { path: "src/App.jsx" },
        { path: "src/App.test.jsx" },
        { path: "vitest.config.js" },
      ],
      ["src/App.jsx", "src/App.test.jsx", "vitest.config.js"],
    );
    expect(partition.accepted.map((file) => file.path)).toEqual(["src/App.jsx"]);
    expect(partition.refusals.map((item) => item.path)).toEqual([
      "src/App.test.jsx",
      "vitest.config.js",
    ]);
  });

  it("never turns one accepted write into a claim that four fixes landed", () => {
    const message = repairOutcomeMessage({
      candidates: 4,
      written: 1,
      refusals: [
        { path: "a", reason: "x" },
        { path: "b", reason: "x" },
        { path: "c", reason: "x" },
      ],
    });
    expect(message).toContain("Applied 1");
    expect(message).toContain("3 were refused");
    expect(message).not.toMatch(/fixed|all four/i);
  });
});

describe("refusal ledger survives restart parsing", () => {
  it("retains refused writes and defaults legacy checkpoints safely", () => {
    const base = {
      schemaVersion: 1 as const,
      runId: crypto.randomUUID(),
      idea: "test",
      options: {},
      files: [],
      updatedAt: Date.now(),
    };
    const refusal = { path: "vitest.config.js", reason: "protected host file" };
    expect(
      FactoryCheckpointSchema.parse({
        ...base,
        writeRefusals: [refusal],
      }).writeRefusals,
    ).toEqual([refusal]);
    expect(FactoryCheckpointSchema.parse(base).writeRefusals).toEqual([]);
  });
});

describe("existing-repo indexing is complete", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the real entrypoint even when more than 1,500 tracked files precede it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-index-"));
    roots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const noise = join(repo, "000-noise");
    mkdirSync(noise);
    for (let i = 0; i < 1_505; i += 1) {
      writeFileSync(join(noise, `${i.toString().padStart(4, "0")}.txt`), "x");
    }
    mkdirSync(join(repo, "src"));
    writeFileSync(
      join(repo, "src", "App.jsx"),
      "export default function App(){ return null; }",
    );
    execFileSync("git", ["add", "-A"], { cwd: repo });

    const analysis = await analyzeExistingCodebase(repo);
    expect(analysis.fileTree).toContain("src/App.jsx");
    expect(analysis.fileTree.length).toBeGreaterThan(1_500);
  });
});

describe("delivery fails closed without complete verification", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes no commit when any generated write was refused", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-gate-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const changed = true;\n");
    execFileSync("git", ["init", "-q", "-b", "factory-deck/test"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
    const before = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    writeFileSync(join(repo, "app.js"), "export const changed = false;\n");
    const result = await deliverRun({
      destination: {
        kind: "existing-repo",
        target: repo,
        branch: "factory-deck/test",
        status: "planned",
        detail: null,
        url: null,
        deliveredAt: null,
      },
      workspacePath: repo,
      filePaths: ["app.js"],
      runId: crypto.randomUUID(),
      appName: "Gate test",
      options: {},
      verification: {
        qaPassed: true,
        testStatus: "passing",
        writeRefusals: 1,
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/verification gate/i);
    const after = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(after).toBe(before);
  });
});
