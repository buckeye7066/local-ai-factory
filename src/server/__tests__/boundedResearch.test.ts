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
              : `Recovery experts restore damaged disks. The official product page documents offline workflow synchronization and durable workflow recovery for team ${number}.`,
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
      for (const comparison of findings.comparisons) {
        expect(comparison.strengths[0]).toContain(
          "official product page documents offline workflow synchronization",
        );
        expect(comparison.strengths[0]).not.toContain(
          "Recovery experts restore damaged disks",
        );
      }
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

  it("emits the statement and URL from the strongest coherent match", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence = [
        {
          path: "weak-product-page",
          url: `${candidate.url}/weak`,
          excerpt: "Durable task recovery is documented.",
        },
        {
          path: "strong-product-page",
          url: `${candidate.url}/strong`,
          excerpt:
            "The official product page documents reliable offline workflow synchronization for distributed teams.",
        },
      ];
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent({ provider }, spec, arch, {
        competitive: true,
        executionMode: "bounded-production",
      });

      expect(findings.comparisons).toHaveLength(5);
      for (const comparison of findings.comparisons) {
        expect(comparison.strengths[0]).toContain(
          "reliable offline workflow synchronization",
        );
        expect(comparison.strengths[0]).not.toContain("Durable task recovery");
        expect(comparison.evidenceUrls).toEqual([
          `${input.candidates.find((candidate) => candidate.id === comparison.candidateId)!.url}/strong`,
        ]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("does not treat an opposing word suffix as an exact feature phrase", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "The product intentionally uses insecure storage for customer records.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["secure storage"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects explicit negations of an otherwise exact feature phrase", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    const denials = [
      "The product does not support offline workflow synchronization.",
      "The product never offers offline workflow synchronization.",
      "The product lacks offline workflow synchronization.",
      "Offline workflow synchronization is not supported.",
      "The product doesn't provide offline workflow synchronization.",
    ];
    input.candidates.forEach((candidate, index) => {
      candidate.sourceEvidence[0]!.excerpt = denials[index]!;
    });
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["offline workflow synchronization"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects postfix denials of an otherwise exact feature phrase", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    const denials = [
      "Offline workflow synchronization is no longer supported.",
      "Offline workflow synchronization was removed.",
      "Offline workflow synchronization has been removed.",
      "Offline workflow synchronization is no longer available.",
      "Offline workflow synchronization is no longer provided.",
    ];
    input.candidates.forEach((candidate, index) => {
      candidate.sourceEvidence[0]!.excerpt = denials[index]!;
    });
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["offline workflow synchronization"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("requires overlap evidence to share the target requirement's polarity", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "This product can store plaintext credentials.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["do not store plaintext credentials"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("retains exact evidence for a negative target without semantic rewriting", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "Security policy: do not store plaintext credentials.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["do not store plaintext credentials"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toHaveLength(5);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a denial embedded between noncontiguous overlap terms", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "Offline workflow does not provide durable synchronization.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["offline workflow durable synchronization"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not borrow polarity from an unrelated clause", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "No setup; we store plaintext credentials.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["do not store plaintext credentials"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("tracks negation across the complete matched clause", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "This product does not under any circumstances make any effort whatsoever to encrypt stored plaintext credentials using hardware keys.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["encrypt stored plaintext credentials using hardware keys"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not turn double-encoded visible text into new evidence", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "Policy text: do&amp;#32;not store plaintext credentials.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["do not store plaintext credentials"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("distinguishes a negated denial predicate from the denial itself", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "Offline workflow synchronization was removed.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["offline workflow synchronization must not be removed"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("recognizes imperative denial verbs in target requirements", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        "Include plaintext credentials in storage.";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["exclude plaintext credentials from storage"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not qualify a feature outside the persisted evidence statement", async () => {
    const intelligence = await import("../tools/competitiveIntelligence.js");
    const input = dossier();
    for (const candidate of input.candidates) {
      candidate.sourceEvidence[0]!.excerpt =
        `${"Unrelated weather observations fill this introduction ".repeat(7)}` +
        "encrypted archive";
    }
    const spy = vi
      .spyOn(intelligence, "buildCompetitiveDossier")
      .mockResolvedValue(input);
    const provider = new FailingBulkProvider();
    try {
      const findings = await researchAgent(
        { provider },
        {
          ...spec,
          tagline: "",
          coreFeatures: ["encrypted archive"],
          userFlows: [],
          acceptanceCriteria: [],
        },
        arch,
        { competitive: true, executionMode: "bounded-production" },
      );

      expect(findings.comparisons).toEqual([]);
      expect(assessRequiredCompetitiveEvidence(findings).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
