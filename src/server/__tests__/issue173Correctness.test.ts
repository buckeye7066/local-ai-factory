import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProductSpecSchema } from "../../shared/schemas.js";
import { reviewableProductCandidates } from "../agents/researchAgent.js";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";
import { isAllowedNpxVerification } from "../workspace/commandRunner.js";
import {
  commandForPlatformProof,
  mappedPlatformCoverageErrors,
} from "../workspace/platformEvidenceRunner.js";
import { verificationPlanForWorkspace } from "../workspace/verificationCommands.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("issue 173 correctness", () => {
  it("preserves a contained non-default Vitest config in mandatory direct verification", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-vite-config-"));
    roots.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run --config custom.vitest.ts --root ." },
        devDependencies: { vitest: "3" },
      }),
    );
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    writeFileSync(join(root, "custom.vitest.ts"), "export default {};\n");
    const plan = verificationPlanForWorkspace(root, {
      generatedTests: [
        {
          path: "src/App.test.ts",
          contents: "import { test } from 'vitest'; test('works', () => {});",
        },
      ],
    });
    const direct = plan.commands.find((entry) => entry.directTestPath)!;
    expect(direct.args).toEqual([
      "--no-install",
      "vitest",
      "run",
      "src/App.test.ts",
      "--config=custom.vitest.ts",
      "--reporter=json",
      "--root=.",
    ]);
    expect(isAllowedNpxVerification(direct.args)).toBe(true);
    expect(commandForPlatformProof(direct, true).args).toEqual(direct.args);
    expect(
      isAllowedNpxVerification([
        "--no-install",
        "vitest",
        "run",
        "src/App.test.ts",
        "--config=../outside.vitest.ts",
        "--reporter=json",
        "--root=.",
      ]),
    ).toBe(false);
  });

  it("bounds the combined ProductSpec requirement universe at 256", () => {
    const base = {
      appName: "bounded",
      targetUser: "owner",
      coreFeatures: ["feature"],
      dataModel: [],
    };
    expect(
      ProductSpecSchema.safeParse({
        ...base,
        userFlows: Array.from({ length: 200 }, (_, i) => `UF ${i}`),
        acceptanceCriteria: Array.from({ length: 56 }, (_, i) => `AC ${i}`),
      }).success,
    ).toBe(true);
    expect(
      ProductSpecSchema.safeParse({
        ...base,
        userFlows: Array.from({ length: 200 }, (_, i) => `UF ${i}`),
        acceptanceCriteria: Array.from({ length: 57 }, (_, i) => `AC ${i}`),
      }).success,
    ).toBe(false);
  });

  it("keeps all verified products available to targeted fallback", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      id: `product-${index}`,
      kind: "product",
      name: `Product ${index}`,
      url: `https://product-${index}.example.com`,
      description: "verified",
      sourceEvidence: [
        {
          url: `https://product-${index}.example.com/features`,
          excerpt: "feature evidence",
        },
      ],
      license: { spdxId: "NOASSERTION", policy: "reference-only" },
      inspectionError: null,
    }));
    const result = reviewableProductCandidates({
      candidates,
      coverage: {
        productTarget: 5,
        productDiscoveredCount: 10,
        productInspectedCount: 10,
        productVerifiedCount: 10,
        productCoverageMet: true,
        repositoryDiscoveredCount: 0,
        repositoryInspectedCount: 0,
        repositoryVerifiedCount: 0,
      },
    } as never);
    expect(result.requiredCount).toBe(5);
    expect(result.candidates).toHaveLength(10);
  });

  it("requires each mapped acceptance title on the current host", () => {
    const errors = mappedPlatformCoverageErrors(
      {
        testPlan: "mapped",
        coverage: [
          {
            requirementId: "AC-1",
            testPath: "tests/flow.test.ts",
            testName: "saves the task",
            kind: "integration",
          },
        ],
        files: [],
      } as never,
      [
        {
          command: "vitest",
          exitCode: 0,
          directTestPath: "tests/flow.test.ts",
          directEvidenceValid: true,
          passedTestNames: ["different title"],
          outputTail: "",
          hostPlatform: "win32",
        },
      ] as never,
    );
    expect(errors.join("\n")).toMatch(/was not reported passed/i);
  });

  it("preserves own __proto__ in exact file digest receipts", () => {
    const checkpoint = FactoryCheckpointSchema.parse({
      schemaVersion: 3,
      runId: crypto.randomUUID(),
      idea: "prototype digest",
      options: {},
      verification: { fileDigests: JSON.parse('{"__proto__":"sha256:exact"}') },
      updatedAt: Date.now(),
    });
    const digests = checkpoint.verification!.fileDigests!;
    expect(Object.getPrototypeOf(digests)).toBeNull();
    expect(Object.hasOwn(digests, "__proto__")).toBe(true);
    expect(digests["__proto__"]).toBe("sha256:exact");
  });

  it("streams Windows proof output instead of buffering it in PowerShell", () => {
    const launcher = readFileSync("scripts/ci/windows-proof-launcher.ps1", "utf8");
    expect(launcher).not.toContain("ReadToEndAsync");
    expect(launcher).toContain("RedirectStandardOutput = $false");
    expect(launcher).toContain("RedirectStandardError = $false");
  });
});
