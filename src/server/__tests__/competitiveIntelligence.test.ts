import { describe, expect, it } from "vitest";
import {
  assessCompetitiveCoverage,
  assessLicense,
  buildDiscoveryQueries,
  isCompetitorQuery,
  isMeaningfulProductEvidence,
  isRepositoryCandidateUrl,
  detectLicenseFromText,
  MAX_PRODUCT_INSPECTION_ATTEMPTS,
  MIN_PRODUCT_COMPETITORS,
  normalizeProductDiscoveryQueries,
  parseGitHubRepoUrl,
  productCandidateKey,
  rankRelevantPaths,
  type CompetitiveCandidate,
} from "../tools/competitiveIntelligence.js";
import { enforceReuseMode } from "../agents/researchAgent.js";
import type { ProductSpec } from "../../shared/schemas.js";

const candidate = (
  policy: CompetitiveCandidate["license"]["policy"],
  kind: CompetitiveCandidate["kind"] = "repository",
): CompetitiveCandidate => ({
  id: "owner/repo",
  kind,
  name: "owner/repo",
  url: "https://github.com/owner/repo",
  description: "",
  stars: 10,
  archived: false,
  updatedAt: "2026-08-14T00:00:00Z",
  discoveryEvidence: [],
  license: {
    spdxId: policy === "direct-use" ? "MIT" : "AGPL-3.0",
    name: "test",
    policy,
    reason: "test",
    evidenceUrl: "https://github.com/owner/repo/blob/main/LICENSE",
  },
  fileTree: [],
  sourceEvidence: [],
  inspectionError: "",
});

describe("competitive intelligence licensing", () => {
  it("allows recognized permissive licenses for direct use", () => {
    expect(assessLicense("MIT").policy).toBe("direct-use");
    expect(assessLicense("Apache-2.0").policy).toBe("direct-use");
  });

  it("requires review for weak copyleft and blocks automatic reuse otherwise", () => {
    expect(assessLicense("MPL-2.0").policy).toBe("conditional-review");
    expect(assessLicense("AGPL-3.0").policy).toBe("reference-only");
    expect(assessLicense(null).policy).toBe("reference-only");
  });

  it("recognizes canonical license text independently of repository metadata", () => {
    expect(
      detectLicenseFromText(
        'MIT License Permission is hereby granted, free of charge. THE SOFTWARE IS PROVIDED "AS IS".',
      ),
    ).toBe("MIT");
    expect(detectLicenseFromText("GNU AFFERO GENERAL PUBLIC LICENSE Version 3")).toBe(
      "AGPL-3.0",
    );
    expect(detectLicenseFromText("Copyright only. All rights reserved.")).toBeNull();
  });

  it("cannot let a model override the deterministic license gate", () => {
    expect(enforceReuseMode("direct-code", candidate("direct-use"))).toBe(
      "direct-code",
    );
    expect(enforceReuseMode("direct-code", candidate("reference-only"))).toBe(
      "clean-room-pattern",
    );
    expect(enforceReuseMode("dependency", candidate("conditional-review"))).toBe(
      "clean-room-pattern",
    );
    expect(
      enforceReuseMode("direct-code", candidate("reference-only", "product")),
    ).toBe("clean-room-pattern");
    expect(
      enforceReuseMode("api-integration", candidate("reference-only", "product")),
    ).toBe("clean-room-pattern");
  });
});

describe("competitive discovery", () => {
  it("canonicalizes repository links and ignores non-GitHub pages", () => {
    expect(
      parseGitHubRepoUrl("https://github.com/Owner/Repo/tree/main/src")?.canonicalUrl,
    ).toBe("https://github.com/Owner/Repo");
    expect(parseGitHubRepoUrl("https://example.com/Owner/Repo")).toBeNull();
    expect(isRepositoryCandidateUrl("https://bitbucket.org/Owner/Repo")).toBe(true);
    expect(isRepositoryCandidateUrl("https://codeberg.org/Owner/Repo")).toBe(true);
    expect(isRepositoryCandidateUrl("https://gitlab.com/Owner/Repo")).toBe(true);
    expect(isRepositoryCandidateUrl("https://product.example/features")).toBe(false);
  });

  it("ranks relevant source files above generated and unrelated files", () => {
    const ranked = rankRelevantPaths(
      [
        "dist/app.js",
        "src/auth/sessionService.ts",
        "src/components/Footer.tsx",
        "README.md",
        "pnpm-lock.yaml",
      ],
      ["auth", "session"],
    );
    expect(ranked[0]).toBe("src/auth/sessionService.ts");
    expect(ranked).not.toContain("dist/app.js");
    expect(ranked).not.toContain("pnpm-lock.yaml");
  });

  it("derives several independent discovery queries from the target spec", () => {
    const spec: ProductSpec = {
      appName: "Privacy Desk",
      tagline: "private identities",
      targetUser: "families",
      coreFeatures: ["email aliases", "phone masking", "password vault"],
      dataModel: [],
      userFlows: [],
      acceptanceCriteria: ["works"],
      goalContract: {
        schema: "factory.goal-contract.v1",
        projectKey: "git:github.com/example/privacy-desk",
        purpose: "Protect family identities across everyday communications",
        purposeSource: "project-memory",
        targetUsers: ["families"],
        activeGoals: ["Reduce identity exposure"],
        constraints: [],
        nonGoals: [],
        continuity: {
          previousRunIds: [],
          carriedForwardDecisions: [],
          priorResearch: [],
        },
        createdFromRunId: "00000000-0000-4000-8000-000000000001",
        createdAt: 1,
        digest: `sha256:${"a".repeat(64)}`,
      },
    };
    const queries = buildDiscoveryQueries(spec);
    expect(queries.length).toBeGreaterThanOrEqual(5);
    expect(queries[0]).toContain(
      "Protect family identities across everyday communications",
    );
    expect(queries[0]).not.toContain("Privacy Desk");
    expect(queries[1]).toContain("families");
    expect(queries.join(" ")).toContain("email aliases");
    // Owner directive 2026-08-15: hunt real COMPETITOR PRODUCTS first, then
    // open-source implementations - never only the latter.
    expect(queries[0]).toMatch(/competitors/);
    expect(queries.some((query) => query.includes("open source"))).toBe(true);
    expect(queries.some((query) => !query.includes("open source"))).toBe(true);
    expect(queries.filter(isCompetitorQuery)).toHaveLength(4);
    expect(queries.slice(0, 4).every((query) => query.length < 320)).toBe(true);
  });

  it("normalizes orchestrator product queries without weakening classification", () => {
    const queries = normalizeProductDiscoveryQueries([
      "Taskwarrior official website",
      "Todo.txt",
      "  Todo.txt  ",
      "",
      "TickTick official product",
      "Todoist official website",
      "Things official website",
      "OmniFocus official website",
      "Ultralist official website",
      "Todoman official website",
      "extra product",
    ]);
    expect(queries).toHaveLength(8);
    expect(queries.every(isCompetitorQuery)).toBe(true);
    expect(queries).toContain("official product website Todo.txt");
    expect(new Set(queries).size).toBe(queries.length);
  });

  it("deduplicates product subdomains and rejects aggregators as competitors", () => {
    const docs = productCandidateKey({
      title: "Acme docs",
      url: "https://docs.acme.example/features",
      snippet: "",
    });
    const product = productCandidateKey({
      title: "Acme",
      url: "https://www.acme.example/product",
      snippet: "",
    });
    expect(docs).toBe("acme.example");
    expect(product).toBe(docs);
    for (const subdomain of ["community", "learn", "us", "www2"]) {
      expect(
        productCandidateKey({
          title: "Acme",
          url: `https://${subdomain}.acme.example/features`,
          snippet: "",
        }),
      ).toBe(docs);
    }
    expect(
      productCandidateKey({
        title: "Acme UK",
        url: "https://learn.acme.co.uk/features",
        snippet: "",
      }),
    ).toBe("acme.co.uk");
    expect(
      productCandidateKey({
        title: "Top Acme alternatives",
        url: "https://www.g2.com/compare/acme",
        snippet: "",
      }),
    ).toBeNull();
    expect(
      productCandidateKey({
        title: "Best CRM software in 2026",
        url: "https://www.techradar.com/best/best-crm-software",
        snippet: "ranked products",
      }),
    ).toBeNull();
    expect(
      productCandidateKey({
        title: "Top 10 CRM tools",
        url: "https://vendor-neutral.example/top-10-crm",
        snippet: "ranked products",
      }),
    ).toBeNull();
    expect(
      productCandidateKey({
        title: "Codeberg project",
        url: "https://codeberg.org/owner/project",
        snippet: "source",
      }),
    ).toBeNull();
    for (const url of [
      "https://stackoverflow.com/questions/1",
      "https://dev.to/example/a-cli",
      "https://www.npmjs.com/package/task-cli",
      "https://www.codemag.com/Article/1/A-CLI",
      "https://weeklyjs.io/typescript/a-cli",
      "https://www.linuxlinks.com/taskell-command-line-kanban-board-task-manager/",
      "https://aur.archlinux.org/packages/taskell-bin",
      "https://in.pinterest.com/pin/boards--94294185934002813/",
      "https://pkg.go.dev/github.com/example/task",
      "https://deepwiki.com/example/task",
    ]) {
      expect(
        productCandidateKey({ title: "Implementation article", url, snippet: "" }),
      ).toBeNull();
    }
  });

  it("does not verify an empty or non-text 200 response as product evidence", () => {
    const base = {
      ok: true,
      status: 200,
      finalUrl: "https://product.example/",
      error: undefined,
      truncated: false,
    };
    expect(
      isMeaningfulProductEvidence({
        ...base,
        contentType: "text/html",
        textExcerpt: "",
      }),
    ).toBe(false);
    expect(
      isMeaningfulProductEvidence({
        ...base,
        contentType: "application/octet-stream",
        textExcerpt: "x".repeat(500),
      }),
    ).toBe(false);
    expect(
      isMeaningfulProductEvidence({
        ...base,
        contentType: "text/html; charset=utf-8",
        textExcerpt: "A real product page with features and workflows. ".repeat(8),
      }),
    ).toBe(true);
  });

  it("requires redirect continuity and product-relevant evidence for the strict gate", () => {
    const context = { candidateKey: "acme.example", title: "Acme workspace" };
    const page = {
      ok: true,
      status: 200,
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://www.acme.example/features",
      textExcerpt:
        "Acme helps teams plan projects, coordinate work, and measure delivery. ".repeat(
          4,
        ),
      truncated: false,
    };
    expect(isMeaningfulProductEvidence(page, context)).toBe(true);
    expect(
      isMeaningfulProductEvidence(
        { ...page, finalUrl: "https://login-provider.example/session" },
        context,
      ),
    ).toBe(false);
    expect(
      isMeaningfulProductEvidence(
        {
          ...page,
          finalUrl: "https://acme.example/login",
          textExcerpt: "Acme sign in to continue. ".repeat(12),
        },
        context,
      ),
    ).toBe(false);
    expect(
      isMeaningfulProductEvidence(
        {
          ...page,
          textExcerpt:
            "An unrelated news article about weather, sports, and city events. ".repeat(
              4,
            ),
        },
        context,
      ),
    ).toBe(false);
    expect(
      isMeaningfulProductEvidence(
        {
          ...page,
          textExcerpt: "Buy this domain. This domain is for sale. ".repeat(6),
        },
        context,
      ),
    ).toBe(false);
  });

  it("keeps the five-product floor separate from repository coverage", () => {
    const verified = (
      kind: CompetitiveCandidate["kind"],
      index: number,
    ): CompetitiveCandidate => ({
      ...candidate("direct-use", kind),
      id: `${kind}-${index}`,
      sourceEvidence: [
        {
          path: kind === "product" ? "product-page" : "README.md",
          url: `https://evidence.example/${kind}/${index}`,
          excerpt: "verified",
        },
      ],
    });
    const repositories = Array.from({ length: 8 }, (_, index) =>
      verified("repository", index),
    );
    const repoOnly = assessCompetitiveCoverage(repositories, 0, 8);
    expect(repoOnly).toMatchObject({
      productVerifiedCount: 0,
      productCoverageMet: false,
      repositoryVerifiedCount: 8,
    });

    const products = Array.from({ length: 5 }, (_, index) =>
      verified("product", index),
    );
    const complete = assessCompetitiveCoverage([...products, ...repositories], 7, 8);
    expect(complete).toMatchObject({
      productTarget: 5,
      productVerifiedCount: 5,
      productCoverageMet: true,
      repositoryVerifiedCount: 8,
    });
    expect(MAX_PRODUCT_INSPECTION_ATTEMPTS).toBeGreaterThan(MIN_PRODUCT_COMPETITORS);
  });
});

describe("isCompetitorQuery", () => {
  it("recognizes competitor-product queries and not implementation queries", () => {
    expect(isCompetitorQuery("GrantFlow competitors")).toBe(true);
    expect(isCompetitorQuery("best grant discovery software for nonprofits")).toBe(
      true,
    );
    expect(isCompetitorQuery("top alternatives to GrantFlow")).toBe(true);
    expect(isCompetitorQuery("grant matching open source GitHub implementation")).toBe(
      false,
    );
  });
});
