import { describe, expect, it } from "vitest";
import {
  assessLicense,
  buildDiscoveryQueries,
  detectLicenseFromText,
  parseGitHubRepoUrl,
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
    expect(
      detectLicenseFromText("GNU AFFERO GENERAL PUBLIC LICENSE Version 3"),
    ).toBe("AGPL-3.0");
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
    expect(enforceReuseMode("direct-code", candidate("reference-only", "web"))).toBe(
      "api-integration",
    );
  });
});

describe("competitive discovery", () => {
  it("canonicalizes repository links and ignores non-GitHub pages", () => {
    expect(
      parseGitHubRepoUrl("https://github.com/Owner/Repo/tree/main/src")?.canonicalUrl,
    ).toBe("https://github.com/Owner/Repo");
    expect(parseGitHubRepoUrl("https://example.com/Owner/Repo")).toBeNull();
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
    };
    const queries = buildDiscoveryQueries(spec);
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(queries.join(" ")).toContain("email aliases");
    expect(queries.every((query) => query.includes("open source"))).toBe(true);
  });
});
