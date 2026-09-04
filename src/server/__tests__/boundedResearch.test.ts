import { describe, expect, it, vi } from "vitest";
import type { GenerateJsonInput, LLMProvider } from "../../shared/types.js";
import type { Architecture, ProductSpec } from "../../shared/schemas.js";
import { researchAgent } from "../agents/researchAgent.js";
import { assessRequiredCompetitiveEvidence } from "../orchestrator/competitiveEvidence.js";
import type { CompetitiveDossier } from "../tools/competitiveIntelligence.js";

const spec: ProductSpec = {
  appName: "Offline Workflow Deck",
  tagline: "Reliable offline workflow synchronization",
  targetUser: "software teams",
  coreFeatures: ["offline workflow synchronization", "durable task recovery"],
  dataModel: [],
  userFlows: ["recover an interrupted workflow"],
  acceptanceCriteria: ["offline workflow state survives restart"],
};

const arch: Architecture = {
  overview: "A durable local workflow engine",
  frontend: "Desktop workflow interface",
  backend: "Persistent workflow queue",
  dataModel: "Workflow and task records",
  risks: [],
};

function dossier(unrelatedLast = false): CompetitiveDossier {
  const generatedAt = new Date().toISOString();
  const candidates = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    const url = `https://workflow-rival-${number}.example/product`;
    return {
      id: `product:workflow-rival-${number}.example`,
      kind: "product" as const,
      name: `Workflow Rival ${number}`,
      url,
      description: "A discovered market product.",
      stars: 0,
      archived: false,
      updatedAt: generatedAt,
      discoveryEvidence: [url],
      license: {
        spdxId: "NOASSERTION",
        name: "Proprietary product",
        policy: "reference-only" as const,
        reason: "Public behavior may only be studied as a clean-room pattern.",
        evidenceUrl: url,
      },
      fileTree: [],
      sourceEvidence: [
        {
          path: "product-page",
          url,
          excerpt:
            unrelatedLast && number === 5
              ? "Offline ticket sales are available. Synchronization connects cloud invoices. Recovery experts restore damaged disks."
              : `The official product page documents offline workflow synchronization and durable workflow recovery for team ${number}.`,
        },
      ],
      inspectionError: "",
    };
  });
  return {
    queries: ["offline workflow products", "workflow source repositories"],
    candidates,
    discoveredCount: 5,
    inspectedCount: 5,
    generatedAt,
    sources: [
      {
        name: "repo-rewards",
        ok: true,
        status: "ok",
        detail: "queried",
        attempts: 1,
        succeeded: 1,
        empty: 0,
        failed: 0,
        skipped: 0,
        resultCount: 1,
      },
      {
        name: "web-search",
        ok: true,
        status: "ok",
        detail: "queried",
        attempts: 1,
        succeeded: 1,
        empty: 0,
        failed: 0,
        skipped: 0,
        resultCount: 5,
      },
    ],
    coverage: {
      productTarget: 5,
      productDiscoveredCount: 5,
      productInspectedCount: 5,
      productVerifiedCount: 5,
      productCoverageMet: true,
      repositoryDiscoveredCount: 0,
      repositoryInspectedCount: 0,
      repositoryVerifiedCount: 0,
    },
  };
}

class FailingBulkProvider implements LLMProvider {
  readonly name = "mock" as const;
  calls = 0;
  isConfigured(): boolean {
    return true;
  }
  async generateText() {
    return { text: "", provider: this.name };
  }
  async generateJson<T>(_input: GenerateJsonInput<T>): Promise<T> {
    this.calls += 1;
    throw new Error("model route unavailable");
  }
}

describe("bounded production research", () => {
  it("uses one bulk model call then preserves five truth-gated evidence comparisons", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(dossier());
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent({ provider }, spec, arch, {
        competitive: true,
        executionMode: "bounded-production",
      });

      expect(provider.calls).toBe(1);
      expect(findings.comparisons).toHaveLength(5);
      expect(findings.recommendations).toHaveLength(5);
      expect(findings.summary).toContain("Deterministic evidence analysis");
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects target terms scattered across unrelated features and keeps the gate blocked", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(dossier(true));
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent({ provider }, spec, arch, {
        competitive: true,
        executionMode: "bounded-production",
      });
      const gate = assessRequiredCompetitiveEvidence(findings);

      expect(provider.calls).toBe(1);
      expect(findings.recommendations).toHaveLength(4);
      expect(gate.ok).toBe(false);
      expect(gate.reasons).toContain(
        "competitive selected-advantage entries are 4/5; exactly 5 required",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
