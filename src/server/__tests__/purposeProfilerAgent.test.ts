import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { architectAgent } from "../agents/architectAgent.js";
import { fileBuilderAgent } from "../agents/fileBuilderAgent.js";
import { finalReviewerAgent } from "../agents/finalReviewerAgent.js";
import {
  groundPurposeProfile,
  purposeProfilerAgent,
  withPurposeAcceptanceCriteria,
} from "../agents/purposeProfilerAgent.js";
import { productSpecAgent } from "../agents/productSpecAgent.js";
import { qaCriticAgent } from "../agents/qaCriticAgent.js";
import { taskPlannerAgent } from "../agents/taskPlannerAgent.js";
import { testWriterAgent } from "../agents/testWriterAgent.js";
import type { RepoAnalysis } from "../workspace/analyzeExistingCodebase.js";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  LLMProvider,
} from "../../shared/types.js";
import type { PurposeEvidence } from "../../shared/schemas.js";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";

const README_DIGEST = `sha256:${"a".repeat(64)}`;
const ROUTE_DIGEST = `sha256:${"b".repeat(64)}`;
const STORE_DIGEST = `sha256:${"c".repeat(64)}`;

const evidence: PurposeEvidence[] = [
  {
    id: "PE-001",
    kind: "readme",
    path: "README.md",
    lineStart: 1,
    lineEnd: 2,
    sourceDigest: README_DIGEST,
    signal: "repository description",
    excerpt: "# GrantFlow\nHelps nonprofit teams track grants.",
  },
  {
    id: "PE-002",
    kind: "route",
    path: "src/routes/grants.ts",
    lineStart: 8,
    lineEnd: 10,
    sourceDigest: ROUTE_DIGEST,
    signal: "route or request handler",
    excerpt: 'router.post("/grants", createGrant);',
  },
  {
    id: "PE-003",
    kind: "source",
    path: "src/stores/grantStore.ts",
    lineStart: 4,
    lineEnd: 6,
    sourceDigest: STORE_DIGEST,
    signal: "external integration or persistence behavior",
    excerpt: "localStorage.setItem('grants', value);\n// TODO: sync across devices",
  },
];

function analysisFixture(): RepoAnalysis {
  return {
    rootPath: "/tmp/grant-flow",
    appNameGuess: "grant-flow",
    detectedStack: ["React", "Express"],
    fileTree: ["README.md", "src/routes/grants.ts", "src/stores/grantStore.ts"],
    manifestExcerpts: [],
    readmeExcerpt: evidence[0].excerpt,
    purposeEvidence: evidence,
    stackSummary: "React, Express — 2 files scanned",
  };
}

class ScriptedProvider implements LLMProvider {
  readonly name = "mock" as const;
  readonly prompts: string[] = [];
  private callIndex = 0;

  constructor(private readonly script: unknown[]) {}

  isConfigured(): boolean {
    return true;
  }

  async generateText(_input: GenerateTextInput) {
    return { text: "", provider: this.name };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.prompts.push(input.prompt);
    const raw = this.script[this.callIndex] ?? this.script[this.script.length - 1];
    this.callIndex += 1;
    return input.schema.parse(raw);
  }
}

describe("purpose profile grounding", () => {
  it("keeps valid citations while deterministically removing invented evidence and unsupported claims", () => {
    const profile = groundPurposeProfile(
      {
        purpose: {
          text: "Help nonprofit teams manage grants",
          evidenceIds: ["PE-001", "PE-404"],
        },
        intendedUsers: [{ text: "Government auditors", evidenceIds: ["PE-999"] }],
        coreWorkflows: [
          {
            name: "Create grant",
            outcome: "A grant is recorded",
            actors: ["nonprofit team"],
            evidenceIds: ["PE-002"],
          },
        ],
        invariants: [
          { text: "Grant creation remains available", evidenceIds: ["PE-002"] },
        ],
        currentCapabilities: [{ text: "Automated government filing", evidenceIds: [] }],
        currentGaps: [
          { text: "Cross-device sync is unfinished", evidenceIds: ["PE-003"] },
        ],
        integrations: [],
        dataOwnership: [
          { text: "Grant data is stored in the browser", evidenceIds: ["PE-003"] },
        ],
        uncertainties: [],
      },
      evidence,
      "grant-flow",
    );

    expect(profile.purpose.evidenceIds).toEqual(["PE-001"]);
    expect(profile.intendedUsers).toEqual([]);
    expect(profile.currentCapabilities).toEqual([]);
    expect(profile.currentGaps[0].text).toContain("sync");
    expect(profile.dataOwnership[0].evidenceIds).toEqual(["PE-003"]);
    expect(profile.coreWorkflows[0].evidenceIds).toEqual(["PE-002"]);
    expect(profile.grounding).toMatchObject({
      grounded: false,
      semanticVerification: "not-performed",
      evidenceCoverage: 1,
      rejectedEvidenceIds: ["PE-404", "PE-999"],
    });
    expect(profile.grounding.droppedClaims).toEqual(
      expect.arrayContaining([
        "intended user: Government auditors",
        "current capability: Automated government filing",
      ]),
    );
    const checkpoint = FactoryCheckpointSchema.parse({
      schemaVersion: 3,
      runId: randomUUID(),
      idea: "Add invoice exports",
      options: {},
      purposeProfile: profile,
      updatedAt: Date.now(),
    });
    expect(checkpoint.purposeProfile).toEqual(profile);
  });

  it("profiles the existing app separately from requested changes", async () => {
    const provider = new ScriptedProvider([
      {
        purpose: {
          text: "Help nonprofit teams track grants",
          evidenceIds: ["PE-001"],
        },
        intendedUsers: [{ text: "Nonprofit teams", evidenceIds: ["PE-001"] }],
        coreWorkflows: [
          {
            name: "Create grant",
            outcome: "A grant is recorded",
            actors: ["nonprofit team"],
            evidenceIds: ["PE-002"],
          },
        ],
        invariants: [],
        currentCapabilities: [
          { text: "Create grant records", evidenceIds: ["PE-002"] },
        ],
        currentGaps: [
          { text: "Cross-device sync is unfinished", evidenceIds: ["PE-003"] },
        ],
        integrations: [],
        dataOwnership: [
          { text: "Grant data is stored in the browser", evidenceIds: ["PE-003"] },
        ],
        uncertainties: [],
      },
    ]);

    const profile = await purposeProfilerAgent({ provider }, analysisFixture(), [
      "Add invoice exports",
    ]);

    expect(profile.appName).toBe("grant-flow");
    expect(profile.grounding.grounded).toBe(true);
    expect(profile.grounding.semanticVerification).toBe("not-performed");
    expect(profile.currentGaps).toHaveLength(1);
    expect(profile.dataOwnership).toHaveLength(1);
    expect(provider.prompts[0]).toContain("Add invoice exports");
    expect(provider.prompts[0]).toContain("not evidence of the app's current purpose");
    expect(provider.prompts[0]).toContain("PE-002");
  });

  it("strips model-authored purpose evidence when no trusted profile exists", async () => {
    const fakeProfile = groundPurposeProfile(
      {
        purpose: { text: "Invented purpose", evidenceIds: ["PE-001"] },
        intendedUsers: [],
        coreWorkflows: [],
        invariants: [],
        currentCapabilities: [],
        currentGaps: [],
        integrations: [],
        dataOwnership: [],
        uncertainties: [],
      },
      evidence,
      "invented-app",
    );
    const provider = new ScriptedProvider([
      {
        appName: "greenfield",
        tagline: "New app",
        targetUser: "operator",
        coreFeatures: ["Build"],
        dataModel: [],
        userFlows: ["Build an app"],
        acceptanceCriteria: ["The app builds"],
        purposeProfile: fakeProfile,
      },
    ]);

    const spec = await productSpecAgent({ provider }, "Build a new app");

    expect(spec.purposeProfile).toBeUndefined();
  });

  it("strips model-authored evidence bundles from the final report", async () => {
    const fakeProfile = groundPurposeProfile(
      {
        purpose: { text: "Invented purpose", evidenceIds: ["PE-001"] },
        intendedUsers: [],
        coreWorkflows: [],
        invariants: [],
        currentCapabilities: [],
        currentGaps: [],
        integrations: [],
        dataOwnership: [],
        uncertainties: [],
      },
      evidence,
      "invented-app",
    );
    const provider = new ScriptedProvider([
      {
        appName: "greenfield",
        summary: "Built the app.",
        whatWasBuilt: ["App"],
        howToRun: "Open it.",
        testStatus: "passing",
        repairLoops: 0,
        caveats: [],
        nextImprovements: [],
        workspacePath: "/tmp/greenfield",
        providerUsage: {},
        purposeProfile: fakeProfile,
        competitiveResearch: {
          required: true,
          productTarget: 5,
          productsVerified: 5,
          productsCompared: 5,
          selectedAdvantages: 5,
          evidenceGateMet: true,
          competitors: [],
          recommendations: [],
          sourceHealth: [],
        },
      },
    ]);

    const report = await finalReviewerAgent(
      { provider },
      {
        appName: "greenfield",
        tagline: "New app",
        targetUser: "operator",
        coreFeatures: ["Build"],
        dataModel: [],
        userFlows: ["Build an app"],
        acceptanceCriteria: ["The app builds"],
      },
      { summary: "No blockers", passed: true, issues: [] },
      {
        repairLoops: 0,
        workspacePath: "/tmp/greenfield",
        providerUsage: {
          free: { calls: 0 },
          anthropic: { calls: 0 },
          openai: { calls: 0 },
          stub: { calls: 0 },
          mock: { calls: 1 },
          totalCalls: 1,
        },
        testStatus: "passing",
      },
    );

    expect(report.purposeProfile).toBeUndefined();
    expect(report.competitiveResearch).toBeUndefined();
  });

  it("threads the typed constitution into spec, architecture, and plan prompts", async () => {
    const profile = groundPurposeProfile(
      {
        purpose: {
          text: "Help nonprofit teams track grants",
          evidenceIds: ["PE-001"],
        },
        intendedUsers: [],
        coreWorkflows: [
          {
            name: "Create grant",
            outcome: "A grant is recorded",
            actors: [],
            evidenceIds: ["PE-002"],
          },
        ],
        invariants: [{ text: "Preserve grant creation", evidenceIds: ["PE-002"] }],
        currentCapabilities: [],
        currentGaps: [
          { text: "Cross-device sync is unfinished", evidenceIds: ["PE-003"] },
        ],
        integrations: [],
        dataOwnership: [{ text: "Browser-owned grant data", evidenceIds: ["PE-003"] }],
        uncertainties: [],
      },
      evidence,
      "grant-flow",
    );
    const provider = new ScriptedProvider([
      {
        appName: "grant-flow",
        tagline: "Track grants",
        targetUser: "Nonprofit teams",
        coreFeatures: ["Grant tracking"],
        dataModel: [],
        userFlows: ["Create a grant"],
        acceptanceCriteria: ["A grant can be created"],
      },
      {
        overview: "Extend the existing app",
        frontend: "React",
        backend: "Express",
        dataModel: "Grant",
        risks: [],
      },
      {
        tasks: [
          {
            order: 1,
            category: "tests",
            title: "Protect grant creation",
            detail: "Regression test PE-002",
          },
        ],
      },
    ]);

    const spec = await productSpecAgent({ provider }, "Add invoice exports", profile);
    const specWithPurposeCriteria = withPurposeAcceptanceCriteria(spec, profile);
    const architecture = await architectAgent({ provider }, spec, profile);
    await taskPlannerAgent({ provider }, spec, architecture, profile);

    expect(provider.prompts).toHaveLength(3);
    for (const prompt of provider.prompts) {
      expect(prompt).toContain("EXISTING APP PURPOSE CONSTITUTION");
      expect(prompt).toContain("PE-002");
    }
    expect(provider.prompts[0]).toContain("requested idea as a CHANGE");
    expect(provider.prompts[1]).toContain("do not replace the current stack");
    expect(provider.prompts[2]).toContain("regression-test tasks");
    expect(spec.purposeProfile).toEqual(profile);
    expect(
      specWithPurposeCriteria.acceptanceCriteria.filter((criterion) =>
        criterion.startsWith("[PURPOSE-"),
      ),
    ).toEqual([
      expect.stringMatching(/PURPOSE-W1.*PE-002/),
      expect.stringMatching(/PURPOSE-I1.*PE-002/),
    ]);

    const downstream = new ScriptedProvider([
      {
        files: [
          {
            path: "src/App.tsx",
            purpose: "Grant UI",
            contents: "export default function App() { return null; }",
          },
        ],
      },
      { testPlan: "Exercise the change", files: [] },
      { summary: "No blockers", passed: true, issues: [] },
      {
        appName: "grant-flow",
        summary: "Invoice exports were added.",
        whatWasBuilt: ["Invoice export"],
        howToRun: "Open the app.",
        testStatus: "passing",
        repairLoops: 0,
        caveats: [],
        nextImprovements: [],
        workspacePath: "/tmp/grant-flow",
        providerUsage: {},
      },
    ]);
    const build = await fileBuilderAgent(
      { provider: downstream },
      spec,
      architecture,
      {
        tasks: [
          { order: 1, category: "frontend", title: "Add export", detail: "PE-002" },
        ],
      },
      { fileTreeExcerpt: "src/App.tsx", manifestExcerpt: "", readmeExcerpt: "" },
    );
    await testWriterAgent({ provider: downstream }, spec, build);
    const qa = await qaCriticAgent(
      { provider: downstream },
      build,
      "tests passed",
      spec,
    );
    const report = await finalReviewerAgent({ provider: downstream }, spec, qa, {
      repairLoops: 0,
      workspacePath: "/tmp/grant-flow",
      providerUsage: {
        free: { calls: 0 },
        anthropic: { calls: 0 },
        openai: { calls: 0 },
        stub: { calls: 0 },
        mock: { calls: 4 },
        totalCalls: 4,
      },
      testStatus: "passing",
      writtenFiles: ["src/App.tsx"],
    });

    expect(downstream.prompts).toHaveLength(4);
    for (const prompt of downstream.prompts) {
      expect(prompt).toContain("PE-002");
    }
    expect(report.purposeProfile).toEqual(profile);
  });
});
