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
  clearResolvedBlockingWriteRefusals,
  generatedFilesNeedingWrite,
  generatedPathsForWiring,
  normalizeGeneratedPath,
  partitionRepairFiles,
  repairOutcomeMessage,
  withinHostChangeBudget,
} from "../orchestrator/runFactory.js";
import { deliverRun } from "../orchestrator/deliverRun.js";
import { analyzeExistingCodebase } from "../workspace/analyzeExistingCodebase.js";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";
import {
  captureFileDigests,
  findUnexpectedWorkspaceChanges,
  verifyCommitFileDigests,
  withVerificationReceipt,
} from "../workspace/verificationReceipt.js";

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
    expect(provider.lastPrompt).not.toContain("PREVIOUS ATTEMPT");
  });

  // FutureU run 9b034d37: the refusal reasons were actionable but the model
  // never saw them. A corrective pass hands them back, once, verbatim.
  it("builder corrective pass lists each refusal and asks only for those files", async () => {
    const provider = new CaptureProvider({ files: [{ path: "src/Card.jsx", purpose: "fixed", contents: "export default 1;", edits: [] }] });
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
      undefined,
      undefined,
      {
        refusals: [
          { path: "server/routes/index.js", reason: "edits were supplied for a file that does not exist yet" },
          { path: "src/Card.jsx", reason: "undeclared dependency — prop-types" },
        ],
      },
    );
    expect(provider.lastPrompt).toContain("PREVIOUS ATTEMPT");
    expect(provider.lastPrompt).toContain("- server/routes/index.js: edits were supplied for a file that does not exist yet");
    expect(provider.lastPrompt).toContain("- src/Card.jsx: undeclared dependency — prop-types");
    expect(provider.lastPrompt).toContain("must NOT be resent");
    expect(provider.lastPrompt).toContain(currentApp);
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

describe("bounded agent context fails closed", () => {
  it("QA cannot pass and repair cannot target a file that was not shown in full", async () => {
    const largeBuild: FileBuild = {
      files: [
        {
          path: "src/huge.ts",
          purpose: "huge",
          contents: "x".repeat(24_001),
          edits: [],
        },
      ],
    };
    const qaProvider = new CaptureProvider({
      summary: "looks fine",
      passed: true,
      issues: [],
    });
    const report = await qaCriticAgent(
      { provider: qaProvider },
      largeBuild,
      "tests green",
      spec,
    );
    expect(report.passed).toBe(false);
    expect(report.summary).toMatch(/INCOMPLETE CODE REVIEW/);

    const repairProvider = new CaptureProvider({ notes: "", files: [] });
    await repairAgent(
      { provider: repairProvider },
      { summary: "fix", passed: false, issues: [] },
      largeBuild,
      "failed",
    );
    expect(repairProvider.lastPrompt).toContain("ALLOWED PATHS:\n(none)");
    expect(repairProvider.lastPrompt).toContain("truncated");
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

  it("canonicalizes accepted repair aliases to the real allowed path", () => {
    const partition = partitionRepairFiles(
      [{ path: "./src/../src/App.jsx" }],
      ["src/App.jsx"],
    );
    expect(partition.refusals).toEqual([]);
    expect(partition.accepted[0]!.path).toBe("src/App.jsx");
    expect(normalizeGeneratedPath("src/../vitest.config.ts")).toBe(
      "vitest.config.ts",
    );
  });

  it("skips exact checkpointed test bytes and clears only resolved blockers", () => {
    const pending = generatedFilesNeedingWrite(
      [
        { path: "./src/a.test.ts", contents: "same" },
        { path: "src/b.test.ts", contents: "new" },
      ],
      [{ path: "src/a.test.ts", contents: "same" }],
    );
    expect(pending.map((file) => file.path)).toEqual(["src/b.test.ts"]);

    const blockers = [
      { path: "./src/a.test.ts", reason: "old refusal" },
      { path: "src/b.test.ts", reason: "still blocked" },
    ];
    clearResolvedBlockingWriteRefusals(blockers, ["src/a.test.ts"]);
    expect(blockers).toEqual([
      { path: "src/b.test.ts", reason: "still blocked" },
    ]);
  });

  it("preserves generated-vs-modified origin and cumulative host locality", () => {
    expect(
      generatedPathsForWiring([
        { path: "src/App.jsx", status: "modified" },
        { path: "src/New.jsx", status: "generated" },
      ]),
    ).toEqual(["src/New.jsx"]);
    const baseline = "a".repeat(500) + "b".repeat(500);
    expect(
      withinHostChangeBudget(baseline, "x".repeat(600) + "b".repeat(400)),
    ).toBe(false);
    expect(
      withinHostChangeBudget(baseline, "a".repeat(500) + "c".repeat(100) + "b".repeat(400)),
    ).toBe(true);
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
    expect(message).not.toMatch(/fixed all|applied all|all four/i);
  });
});

describe("checkpoint safety contract", () => {
  it("retains refusal ledgers and rejects all pre-v3 checkpoints", () => {
    const base = {
      schemaVersion: 3 as const,
      runId: crypto.randomUUID(),
      idea: "test",
      options: {},
      files: [],
      updatedAt: Date.now(),
    };
    const refusal = { path: "vitest.config.js", reason: "protected host file" };
    const parsed = FactoryCheckpointSchema.parse({
      ...base,
      writeRefusals: [refusal],
      blockingWriteRefusals: [refusal],
    });
    expect(parsed.writeRefusals).toEqual([refusal]);
    expect(parsed.blockingWriteRefusals).toEqual([refusal]);
    expect(parsed.builderExistingPaths).toEqual([]);
    expect(parsed.hostFileBaselines).toEqual({});
    for (const schemaVersion of [1, 2]) {
      expect(() =>
        FactoryCheckpointSchema.parse({ ...base, schemaVersion }),
      ).toThrow();
    }
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

describe("existing-repo indexing includes safe untracked work", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes an untracked real App.jsx for same-stem resolution", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-untracked-"));
    roots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "src"));
    writeFileSync(
      join(repo, "src", "App.jsx"),
      "export default function App(){ return null; }",
    );
    const analysis = await analyzeExistingCodebase(repo);
    expect(analysis.fileTree).toContain("src/App.jsx");
  });
});

describe("verification tree binding", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds when a verification command mutates a deliverable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-command-mutate-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const value = 'tested';\n");
    const intended = await captureFileDigests(repo, ["app.js"]);
    const result = await withVerificationReceipt(
      repo,
      ["app.js"],
      intended,
      async () => {
        writeFileSync(
          join(repo, "app.js"),
          "export const value = 'untested';\n",
        );
        return 0;
      },
    );
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("after");
    expect(result.reason).toMatch(/app\.js/);
  });

  it("reports unlisted source created in a new-app workspace", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-new-tree-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const app = 1;\n");
    writeFileSync(join(repo, "generated-helper.js"), "export const hidden = 1;\n");
    expect(findUnexpectedWorkspaceChanges(repo, ["app.js"])).toEqual([
      "generated-helper.js",
    ]);
  });

  it("detects tracked and untracked command mutations outside the deliverable set", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-tree-"));
    roots.push(repo);
    writeFileSync(join(repo, "host.js"), "export const host = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
    writeFileSync(join(repo, "host.js"), "export const host = 2;\n");
    writeFileSync(join(repo, "generated.log"), "side effect\n");
    expect(findUnexpectedWorkspaceChanges(repo, ["app.js"])).toEqual([
      "generated.log",
      "host.js",
    ]);
    expect(findUnexpectedWorkspaceChanges(repo, ["generated.log", "host.js"])).toEqual([]);
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
        incompleteCommands: 0,
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

  it("delivers only the exact bytes covered by a verification receipt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-receipt-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const value = 1;\n");
    execFileSync("git", ["init", "-q", "-b", "factory-deck/receipt"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    const receipt = await captureFileDigests(repo, ["app.js"]);
    const result = await deliverRun({
      destination: {
        kind: "new-repo",
        target: "local",
        branch: "main",
        status: "planned",
        detail: null,
        url: null,
        deliveredAt: null,
      },
      workspacePath: repo,
      filePaths: ["app.js"],
      runId: crypto.randomUUID(),
      appName: "Receipt",
      options: { newRepo: { name: "local", createRemote: false } },
      verification: {
        qaPassed: true,
        testStatus: "passing",
        writeRefusals: 0,
        incompleteCommands: 0,
        fileDigests: receipt,
      },
    });
    expect(result.status).toBe("delivered");
  });

  it("refuses delivery when one verified byte changes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-receipt-mutate-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const value = 1;\n");
    const receipt = await captureFileDigests(repo, ["app.js"]);
    writeFileSync(join(repo, "app.js"), "export const value = 2;\n");
    const result = await deliverRun({
      destination: {
        kind: "new-repo",
        target: "local",
        branch: "main",
        status: "planned",
        detail: null,
        url: null,
        deliveredAt: null,
      },
      workspacePath: repo,
      filePaths: ["app.js"],
      runId: crypto.randomUUID(),
      appName: "Receipt",
      options: { newRepo: { name: "local", createRemote: false } },
      verification: {
        qaPassed: true,
        testStatus: "passing",
        writeRefusals: 0,
        incompleteCommands: 0,
        fileDigests: receipt,
      },
    });
    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/receipt|changed/i);
  });


  it("rejects a commit blob that differs even when the working tree is restored", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-commit-blob-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const value = 1;\n");
    const receipt = await captureFileDigests(repo, ["app.js"]);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "app.js"), "export const value = 2;\n");
    execFileSync("git", ["add", "app.js"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "mutated index"], { cwd: repo });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(repo, "app.js"), "export const value = 1;\n");
    const verdict = verifyCommitFileDigests(
      repo,
      sha,
      ["app.js"],
      receipt,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/committed blob|verified bytes/i);
  });

  it("refuses delivery when a pre-staged extra path enters the commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-extra-index-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const app = 1;\n");
    writeFileSync(join(repo, "owner.txt"), "owner staged change\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["add", "owner.txt"], { cwd: repo });
    const receipt = await captureFileDigests(repo, ["app.js"]);
    const result = await deliverRun({
      destination: {
        kind: "new-repo",
        target: "local",
        branch: "main",
        status: "planned",
        detail: null,
        url: null,
        deliveredAt: null,
      },
      workspacePath: repo,
      filePaths: ["app.js"],
      runId: "extra-index-run",
      appName: "Receipt",
      options: {
        newRepo: { name: "local", createRemote: false },
      },
      verification: {
        qaPassed: true,
        testStatus: "passing",
        writeRefusals: 0,
        incompleteCommands: 0,
        fileDigests: receipt,
      },
    });
    expect(result.status).toBe("failed");
    expect(result.detail).toMatch(/outside the verification receipt|owner\.txt/i);
  });

  it("reuses only its own receipt-bound commit after an interrupted delivery", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-retry-commit-"));
    roots.push(repo);
    writeFileSync(join(repo, "app.js"), "export const app = 1;\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    const receipt = await captureFileDigests(repo, ["app.js"]);
    const input = {
      destination: {
        kind: "new-repo" as const,
        target: "local",
        branch: "main",
        status: "planned" as const,
        detail: null,
        url: null,
        deliveredAt: null,
      },
      workspacePath: repo,
      filePaths: ["app.js"],
      runId: "same-run-after-crash",
      appName: "Receipt",
      options: {
        newRepo: { name: "local", createRemote: false },
      },
      verification: {
        qaPassed: true,
        testStatus: "passing" as const,
        writeRefusals: 0,
        incompleteCommands: 0,
        fileDigests: receipt,
      },
    };
    const first = await deliverRun(input);
    const resumed = await deliverRun(input);
    expect(first.status).toBe("delivered");
    expect(resumed.status).toBe("delivered");
    expect(resumed.commitSha).toBe(first.commitSha);
    expect(resumed.detail).toMatch(/reusing receipt-bound commit/i);
  });

});
