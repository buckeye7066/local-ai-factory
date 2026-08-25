import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ResearchFindings } from "../agents/researchAgent.js";
import type { ProductSpec } from "../../shared/schemas.js";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";
import {
  assessRequiredCompetitiveEvidence,
  requiresCompetitiveEvidence,
  shouldAttemptResearch,
  summarizeCompetitiveEvidence,
  withCompetitiveAcceptanceCriteria,
} from "../orchestrator/competitiveEvidence.js";

function findings(productCount = 5): ResearchFindings {
  const candidates = Array.from({ length: productCount }, (_, index) => ({
    candidateId: `product:${index + 1}`,
    kind: "product" as const,
    name: `Product ${index + 1}`,
    url: `https://product-${index + 1}.example`,
    evidenceUrls: [`https://product-${index + 1}.example`],
    licenseSpdx: "NOASSERTION",
    licensePolicy: "reference-only" as const,
    inspectedFiles: 1,
    inspectionError: "",
  }));
  return {
    summary: "Compared products.",
    competitiveAudit: {
      queries: ["best test software"],
      sources: [
        {
          name: "firecrawl-v2",
          ok: true,
          status: "ok",
          detail: "five results",
          attempts: 1,
          succeeded: 1,
          empty: 0,
          failed: 0,
          skipped: 0,
          resultCount: productCount,
        },
      ],
      coverage: {
        productTarget: 5,
        productDiscoveredCount: productCount,
        productInspectedCount: productCount,
        productVerifiedCount: productCount,
        productCoverageMet: productCount >= 5,
        repositoryDiscoveredCount: 3,
        repositoryInspectedCount: 3,
        repositoryVerifiedCount: 2,
      },
      discoveredCount: productCount + 3,
      inspectedCount: productCount + 3,
      generatedAt: new Date().toISOString(),
      candidates,
    },
    comparisons: candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      name: candidate.name,
      score: 90 - index,
      matchedFeatures: ["workflow"],
      strengths: ["clear workflow"],
      gaps: ["no local mode"],
      evidenceUrls: [candidate.url],
      decision: "adapt" as const,
      rationale: "Useful pattern",
      origin: "competitive-selection" as const,
    })),
    recommendations: candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      name: `${candidate.name}: workflow`,
      why: "Faster first use",
      sourceUrl: candidate.url,
      howToIntegrate: `Add verified workflow ${index + 1}`,
      licenseSpdx: "NOASSERTION",
      licensePolicy: "reference-only" as const,
      reuseMode: "clean-room-pattern" as const,
      evidenceUrls: [candidate.url],
      score: 90 - index,
      origin: "competitive-selection" as const,
    })),
  };
}

const spec: ProductSpec = {
  appName: "Factory",
  tagline: "",
  targetUser: "operator",
  coreFeatures: ["build"],
  dataModel: [],
  userFlows: ["build software"],
  acceptanceCriteria: ["build succeeds"],
};

describe("comparative evidence gate", () => {
  it("detects explicit comparative intent without gating ordinary goals", () => {
    expect(requiresCompetitiveEvidence(["make it better than its competitors"])).toBe(
      true,
    );
    expect(requiresCompetitiveEvidence(["fix the login error"])).toBe(false);
    for (const phrase of [
      "beat the competition",
      "make it superior to the current options",
      "match or exceed the industry standard",
      "become the market leader",
      "compare the leading alternatives",
      "research the top five products",
      "make it the best CRM",
      "build the #1 project management app",
      "deliver a world-class scheduling tool",
      "become the category leader",
    ]) {
      expect(requiresCompetitiveEvidence([phrase]), phrase).toBe(true);
    }
    for (const phrase of [
      "show the top five tasks",
      "list my five leading indicators",
      "make the login faster",
      "choose the best way to fix this bug",
    ]) {
      expect(requiresCompetitiveEvidence([phrase]), phrase).toBe(false);
    }
  });

  it("requires five verified, compared, and selected product competitors", () => {
    expect(assessRequiredCompetitiveEvidence(findings())).toMatchObject({
      ok: true,
      productVerifiedCount: 5,
      productComparedCount: 5,
      productSelectedCount: 5,
    });
    const short = assessRequiredCompetitiveEvidence(findings(4));
    expect(short.ok).toBe(false);
    expect(short.reasons.join("; ")).toMatch(/4\/5/);
  });

  it("recomputes the five-product floor and rejects invented citations", () => {
    const manipulated = findings();
    manipulated.competitiveAudit!.coverage.productTarget = 1;
    manipulated.competitiveAudit!.coverage.productVerifiedCount = 99;
    manipulated.comparisons[0]!.evidenceUrls = ["https://invented.example/proof"];
    manipulated.recommendations[0]!.evidenceUrls = ["https://invented.example/proof"];

    const gate = assessRequiredCompetitiveEvidence(manipulated);

    expect(gate.productTarget).toBe(5);
    expect(gate.productVerifiedCount).toBe(5);
    expect(gate.productComparedCount).toBe(4);
    expect(gate.productSelectedCount).toBe(4);
    expect(gate.ok).toBe(false);
  });

  it("requires the same actionable products to be compared and selected", () => {
    const disjoint = findings(10);
    disjoint.comparisons = disjoint.comparisons.slice(0, 5);
    disjoint.recommendations = disjoint.recommendations.slice(5, 10);

    const gate = assessRequiredCompetitiveEvidence(disjoint);

    expect(gate.productVerifiedCount).toBe(10);
    expect(gate.productComparedCount).toBe(5);
    expect(gate.productSelectedCount).toBe(0);
    expect(gate.reasons.join(" ")).toMatch(/comparison-qualified.*0\/5/i);
    expect(gate.ok).toBe(false);
    expect(
      withCompetitiveAcceptanceCriteria(spec, disjoint).acceptanceCriteria.filter(
        (item) => item.startsWith("[COMP-"),
      ),
    ).toHaveLength(0);
    expect(summarizeCompetitiveEvidence(disjoint, true).recommendations).toHaveLength(
      0,
    );
  });

  it("does not count rejected or reference-only products as adopted advantages", () => {
    const research = findings();
    research.comparisons[0]!.decision = "reject";
    research.recommendations[1]!.reuseMode = "reference-only";

    const gate = assessRequiredCompetitiveEvidence(research);

    expect(gate.productComparedCount).toBe(4);
    expect(gate.productSelectedCount).toBe(3);
    expect(gate.ok).toBe(false);
    const enriched = withCompetitiveAcceptanceCriteria(spec, research);
    expect(
      enriched.acceptanceCriteria.filter((item) => item.startsWith("[COMP-")),
    ).toHaveLength(3);
    expect(summarizeCompetitiveEvidence(research, true).recommendations).toHaveLength(
      3,
    );
  });

  it("treats duplicate or contradictory product comparisons as non-qualifying", () => {
    const research = findings();
    research.comparisons.push({
      ...research.comparisons[0]!,
      decision: "reject",
      rationale: "Contradictory persisted decision",
    });

    const gate = assessRequiredCompetitiveEvidence(research);

    expect(gate.productComparedCount).toBe(4);
    expect(gate.productSelectedCount).toBe(4);
    expect(gate.ok).toBe(false);
    const enriched = withCompetitiveAcceptanceCriteria(spec, research);
    expect(
      enriched.acceptanceCriteria.filter((item) => item.startsWith("[COMP-")),
    ).toHaveLength(4);
    expect(summarizeCompetitiveEvidence(research, true).recommendations).toHaveLength(
      4,
    );
  });

  it("retries blocked comparative research after architecture has checkpointed", () => {
    expect(shouldAttemptResearch(true, true, undefined)).toBe(true);
    expect(shouldAttemptResearch(true, true, findings(4))).toBe(true);
    expect(shouldAttemptResearch(true, true, findings())).toBe(false);

    // Advisory research remains checkpoint-idempotent and does not turn a
    // completed architecture stage into an endless retry loop.
    expect(shouldAttemptResearch(true, false, undefined)).toBe(false);
    expect(shouldAttemptResearch(false, false, undefined)).toBe(true);
    expect(shouldAttemptResearch(false, false, findings())).toBe(false);
  });

  it("rejects stale, invalid, and future-dated comparative checkpoints", () => {
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const stale = findings();
    stale.competitiveAudit!.generatedAt = "2026-08-17T11:59:59.000Z";
    expect(assessRequiredCompetitiveEvidence(stale, now).reasons.join(" ")).toMatch(
      /older than seven days/i,
    );
    expect(shouldAttemptResearch(true, true, stale, now)).toBe(true);

    const invalid = findings();
    invalid.competitiveAudit!.generatedAt = "";
    expect(assessRequiredCompetitiveEvidence(invalid, now).ok).toBe(false);

    const future = findings();
    future.competitiveAudit!.generatedAt = "2026-08-25T12:06:00.000Z";
    expect(assessRequiredCompetitiveEvidence(future, now).reasons.join(" ")).toMatch(
      /future/i,
    );
  });

  it("keeps older v3 research checkpoints with empty comparison arrays resumable", () => {
    const checkpoint = FactoryCheckpointSchema.parse({
      schemaVersion: 3,
      runId: randomUUID(),
      idea: "resume old research",
      options: {},
      research: {
        summary: "Legacy checkpoint",
        comparisons: [
          {
            candidateId: "legacy",
            name: "Legacy product",
            decision: "reference",
            strengths: [],
            gaps: [],
            evidenceUrls: [],
          },
        ],
      },
      updatedAt: Date.now(),
    });

    expect(checkpoint.research?.comparisons[0]).toMatchObject({
      candidateId: "legacy",
      origin: "tool-research",
      evidenceUrls: [],
    });
  });

  it("turns selected advantages into acceptance criteria and durable evidence", () => {
    const research = findings();
    research.recommendations.unshift(
      ...Array.from({ length: 4 }, (_, index) => ({
        ...research.recommendations[0]!,
        name: `Duplicate product one ${index + 1}`,
      })),
    );
    const enriched = withCompetitiveAcceptanceCriteria(spec, research);
    const criteria = enriched.acceptanceCriteria.filter((item) =>
      item.startsWith("[COMP-"),
    );
    expect(criteria).toHaveLength(5);
    expect(criteria.filter((item) => item.includes("Product 1"))).toHaveLength(1);

    const summary = summarizeCompetitiveEvidence(research, true);
    expect(summary.coverageMet).toBe(true);
    expect(summary.competitors).toHaveLength(5);
    expect(summary.recommendations).toHaveLength(5);
    expect(summary.sources[0]).toMatchObject({
      name: "firecrawl-v2",
      status: "ok",
    });
  });
});
