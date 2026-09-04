import { readFileSync, writeFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}
function write(path, text) {
  writeFileSync(path, text, "utf8");
}
function one(path, before, after) {
  const text = read(path);
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one patch anchor, found ${count}`);
  write(path, text.replace(before, after));
}
function replaceRegex(path, pattern, replacement, label) {
  const text = read(path);
  let count = 0;
  const next = text.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
  if (count !== 1) throw new Error(`${path}: ${label} replacements=${count}`);
  write(path, next);
}

// 1. Preserve validated candidate-owned Vitest --config paths in direct verification.
one(
  "src/server/workspace/verificationCommands.ts",
  `interface VitestScript {\n  root: string;\n  ownsRoot: boolean;\n}`,
  `interface VitestScript {\n  root: string;\n  ownsRoot: boolean;\n  config?: string;\n}`,
);
one(
  "src/server/workspace/verificationCommands.ts",
  `  let root: string | undefined;\n  const seenPathOptions = new Set<string>();`,
  `  let root: string | undefined;\n  let config: string | undefined;\n  const seenPathOptions = new Set<string>();`,
);
one(
  "src/server/workspace/verificationCommands.ts",
  `    if (option === "--root") root = normalized;\n  }\n  return { root: root ?? ".", ownsRoot: root !== undefined };`,
  `    if (option === "--root") root = normalized;\n    if (option === "--config") config = normalized;\n  }\n  return { root: root ?? ".", ownsRoot: root !== undefined, config };`,
);
one(
  "src/server/workspace/verificationCommands.ts",
  `          testPath,\n          "--reporter=json",\n          \`--root=\${root}\`,`,
  `          testPath,\n          ...(vitestScript?.config ? [\`--config=\${vitestScript.config}\`] : []),\n          "--reporter=json",\n          \`--root=\${root}\`,`,
);
one(
  "src/server/workspace/commandRunner.ts",
  `function isSafeVitestRoot(arg: string): boolean {\n  if (!arg.startsWith("--root=")) return false;\n  return normalizeSafeRelativePath(arg.slice("--root=".length)) !== null;\n}\n`,
  `function isSafeVitestRoot(arg: string): boolean {\n  if (!arg.startsWith("--root=")) return false;\n  return normalizeSafeRelativePath(arg.slice("--root=".length)) !== null;\n}\n\nfunction isSafeVitestConfig(arg: string): boolean {\n  if (!arg.startsWith("--config=")) return false;\n  return normalizeSafeRelativePath(arg.slice("--config=".length)) !== null;\n}\n`,
);
replaceRegex(
  "src/server/workspace/commandRunner.ts",
  /  if \(tool === "vitest"\) \{\n[\s\S]*?\n  \}\n(?=  if \(tool === "jest"\) \{)/,
  `  if (tool === "vitest") {\n    if (args[4]?.startsWith("--config=")) {\n      return (\n        args.length === 7 &&\n        args[2] === "run" &&\n        isSafeDirectJsTest(args[3]!) &&\n        isSafeVitestConfig(args[4]!) &&\n        args[5] === "--reporter=json" &&\n        isSafeVitestRoot(args[6]!)\n      );\n    }\n    return (\n      (args.length === 6 || args.length === 7) &&\n      args[2] === "run" &&\n      isSafeDirectJsTest(args[3]!) &&\n      args[4] === "--reporter=json" &&\n      isSafeVitestRoot(args[5]!) &&\n      (args.length === 6 ||\n        args[6] === "--config=.factory-deck-platform-vitest.config.mjs")\n    );\n  }\n`,
  "Vitest command grammar",
);
one(
  "src/server/workspace/platformEvidenceRunner.ts",
  `  if (!isolatedVitest || command.runner !== "vitest") return command;\n  return { ...command, args: [...command.args, \`--config=\${PLATFORM_VITEST_CONFIG}\`] };`,
  `  if (\n    !isolatedVitest ||\n    command.runner !== "vitest" ||\n    command.args.some((arg) => arg.startsWith("--config="))\n  ) {\n    return command;\n  }\n  return { ...command, args: [...command.args, \`--config=\${PLATFORM_VITEST_CONFIG}\`] };`,
);

// 2. Keep the ProductSpec schema object reusable while enforcing the combined 256-entry requirement ceiling.
one(
  "src/shared/schemas.ts",
  `export const ProductSpecSchema = z.object({\n  appName: z.string(),\n  tagline: z.string().default(""),\n  targetUser: z.string(),\n  coreFeatures: NonEmptyStringListSchema,\n  dataModel: DataModelSchema,\n  userFlows: StringListSchema.default([]),\n  acceptanceCriteria: NonEmptyStringListSchema,\n  /** Present on extend runs so every downstream agent receives the constitution. */\n  purposeProfile: PurposeProfileSchema.optional(),\n  /** Present on every orchestrated run; stamped by code, never trusted from a model. */\n  goalContract: GoalContractSchema.optional(),\n});`,
  `export const ProductSpecObjectSchema = z.object({\n  appName: z.string(),\n  tagline: z.string().default(""),\n  targetUser: z.string(),\n  coreFeatures: NonEmptyStringListSchema,\n  dataModel: DataModelSchema,\n  userFlows: StringListSchema.default([]),\n  acceptanceCriteria: NonEmptyStringListSchema,\n  /** Present on extend runs so every downstream agent receives the constitution. */\n  purposeProfile: PurposeProfileSchema.optional(),\n  /** Present on every orchestrated run; stamped by code, never trusted from a model. */\n  goalContract: GoalContractSchema.optional(),\n});\n\nexport const ProductSpecSchema = ProductSpecObjectSchema.superRefine((spec, context) => {\n  if (spec.userFlows.length + spec.acceptanceCriteria.length > 256) {\n    context.addIssue({\n      code: z.ZodIssueCode.custom,\n      path: ["acceptanceCriteria"],\n      message:\n        "userFlows plus acceptanceCriteria cannot exceed the 256-entry executable evidence map",\n    });\n  }\n});`,
);
one(
  "src/server/agents/productSpecAgent.ts",
  `import {\n  ProductSpecSchema,\n  type ProductSpec,`,
  `import {\n  ProductSpecObjectSchema,\n  ProductSpecSchema,\n  type ProductSpec,`,
);
one(
  "src/server/agents/productSpecAgent.ts",
  `const ProductSpecDraftSchema = ProductSpecSchema.omit({`,
  `const ProductSpecDraftSchema = ProductSpecObjectSchema.omit({`,
);

// 4. Let targeted fallback inspect every verified product; only collective review receives bounded headroom.
replaceRegex(
  "src/server/agents/researchAgent.ts",
  /function reviewableProductCandidates\(dossier: CompetitiveDossier\) \{([\s\S]*?)const candidates = dossier\.candidates\s*\.filter\(([\s\S]*?)\)\s*\.slice\(0, productTarget \+ COMPETITIVE_REVIEW_HEADROOM\);/,
  (_match, prefix, predicate) =>
    `export function reviewableProductCandidates(dossier: CompetitiveDossier) {${prefix}const candidates = dossier.candidates.filter(${predicate});`,
  "reviewable product candidate pool",
);
{
  const path = "src/server/agents/researchAgent.ts";
  let text = read(path);
  const marker = `  const { candidates, requiredCount } = reviewableProductCandidates(dossier);\n  if (requiredCount === 0) {`;
  if (text.split(marker).length - 1 < 2) throw new Error("researchAgent: collective/targeted anchors missing");
  text = text.replace(
    marker,
    `  const { candidates, requiredCount } = reviewableProductCandidates(dossier);\n  const reviewCandidates = candidates.slice(\n    0,\n    requiredCount + COMPETITIVE_REVIEW_HEADROOM,\n  );\n  if (requiredCount === 0) {`,
  );
  const dossierOld = `\`VERIFIED PRODUCT DOSSIER:\\n\${JSON.stringify(candidates.map(compactProductCandidate))}\``;
  if (text.split(dossierOld).length - 1 !== 1) throw new Error("researchAgent: dossier prompt anchor mismatch");
  text = text.replace(
    dossierOld,
    `\`VERIFIED PRODUCT DOSSIER:\\n\${JSON.stringify(reviewCandidates.map(compactProductCandidate))}\``,
  );
  const schemaOld = `(raw) => hydrateCompetitiveCandidateIds(raw, candidates),\n      competitiveSelectionSchema(candidates, requiredCount),`;
  if (text.split(schemaOld).length - 1 !== 1) throw new Error("researchAgent: schema anchor mismatch");
  text = text.replace(
    schemaOld,
    `(raw) => hydrateCompetitiveCandidateIds(raw, reviewCandidates),\n      competitiveSelectionSchema(reviewCandidates, requiredCount),`,
  );
  write(path, text);
}

// 5. Require every mapped acceptance-test title to pass on the current platform.
one(
  "src/server/workspace/platformEvidenceRunner.ts",
  `import { mappedTestNamesForPath } from "../orchestrator/acceptanceGate.js";`,
  `import {\n  assessExecutedCoverage,\n  mappedTestNamesForPath,\n} from "../orchestrator/acceptanceGate.js";`,
);
one(
  "src/server/workspace/platformEvidenceRunner.ts",
  `export function missingDirectPlatformEvidencePaths(\n  requiredPaths: readonly string[],`,
  `export function mappedPlatformCoverageErrors(\n  testPlan: FactoryCheckpoint["testPlan"],\n  evidence: CheckpointExecutedCommand[],\n): string[] {\n  return testPlan ? assessExecutedCoverage(testPlan, evidence) : [];\n}\n\nexport function missingDirectPlatformEvidencePaths(\n  requiredPaths: readonly string[],`,
);
replaceRegex(
  "src/server/workspace/platformEvidenceRunner.ts",
  /(    if \(missingDirectEvidence\.length > 0\) \{[\s\S]*?^    \}\n)(\n    const after = await verifyFileDigests)/m,
  (_match, before, after) =>
    `${before}    const mappedCoverageErrors = mappedPlatformCoverageErrors(\n      held.checkpoint.testPlan,\n      executed,\n    );\n    if (mappedCoverageErrors.length > 0) {\n      throw new Error(\n        \`\${hostPlatform} proof did not independently pass every mapped acceptance test: \${mappedCoverageErrors.join("; ")}.\`,\n      );\n    }\n${after}`,
  "mapped acceptance title gate",
);

// 6. Preserve own prototype-named keys in verification.fileDigests as well as artifact snapshots.
{
  const path = "src/server/orchestrator/checkpoint.ts";
  let text = read(path);
  if (text.split("const PlatformArtifactSnapshotSchema = z").length - 1 !== 1) throw new Error("checkpoint: snapshot schema mismatch");
  text = text.replace("const PlatformArtifactSnapshotSchema = z", "const OwnStringRecordSchema = z");
  text = text.replace('"expected an artifact snapshot object"', '"expected a string-record object"');
  text = text.replace('message: "expected an artifact fingerprint string",', 'message: "expected a string value",');
  if (text.split("fileDigests: z.record(z.string()).optional(),").length - 1 !== 1) throw new Error("checkpoint: file digest schema mismatch");
  text = text.replace("fileDigests: z.record(z.string()).optional(),", "fileDigests: OwnStringRecordSchema.optional(),");
  if (text.split("platformArtifactSnapshot: PlatformArtifactSnapshotSchema.optional(),").length - 1 !== 1) throw new Error("checkpoint: artifact schema use mismatch");
  text = text.replace("platformArtifactSnapshot: PlatformArtifactSnapshotSchema.optional(),", "platformArtifactSnapshot: OwnStringRecordSchema.optional(),");
  write(path, text);
}

// 7. Stream Windows proof child output into the Node-side bounded capture.
one(
  "scripts/ci/windows-proof-launcher.ps1",
  `  $psi.RedirectStandardOutput = $true\n  $psi.RedirectStandardError = $true`,
  `  # Stream untrusted child output through inherited job handles; Node bounds the capture.\n  $psi.RedirectStandardOutput = $false\n  $psi.RedirectStandardError = $false`,
);
one(
  "scripts/ci/windows-proof-launcher.ps1",
  `  $stdout = $process.StandardOutput.ReadToEndAsync()\n  $stderr = $process.StandardError.ReadToEndAsync()\n  $process.WaitForExit()\n  [Console]::Out.Write($stdout.GetAwaiter().GetResult())\n  [Console]::Error.Write($stderr.GetAwaiter().GetResult())\n  exit $process.ExitCode`,
  `  $process.WaitForExit()\n  exit $process.ExitCode`,
);

const regression = `import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nimport { afterEach, describe, expect, it } from "vitest";\nimport { ProductSpecSchema } from "../../shared/schemas.js";\nimport { reviewableProductCandidates } from "../agents/researchAgent.js";\nimport { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";\nimport { isAllowedNpxVerification } from "../workspace/commandRunner.js";\nimport { commandForPlatformProof, mappedPlatformCoverageErrors } from "../workspace/platformEvidenceRunner.js";\nimport { verificationPlanForWorkspace } from "../workspace/verificationCommands.js";\n\nconst roots: string[] = [];\nafterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });\n\ndescribe("issue 173 correctness", () => {\n  it("preserves a contained non-default Vitest config in mandatory direct verification", () => {\n    const root = mkdtempSync(join(tmpdir(), "factory-vite-config-")); roots.push(root);\n    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run --config custom.vitest.ts --root ." }, devDependencies: { vitest: "3" } }));\n    writeFileSync(join(root, "package-lock.json"), "{}\\n");\n    writeFileSync(join(root, "custom.vitest.ts"), "export default {};\\n");\n    const plan = verificationPlanForWorkspace(root, { generatedTests: [{ path: "src/App.test.ts", contents: "import { test } from 'vitest'; test('works', () => {});" }] });\n    const direct = plan.commands.find((entry) => entry.directTestPath)!;\n    expect(direct.args).toEqual(["--no-install", "vitest", "run", "src/App.test.ts", "--config=custom.vitest.ts", "--reporter=json", "--root=."]);\n    expect(isAllowedNpxVerification(direct.args)).toBe(true);\n    expect(commandForPlatformProof(direct, true).args).toEqual(direct.args);\n    expect(isAllowedNpxVerification(["--no-install", "vitest", "run", "src/App.test.ts", "--config=../outside.vitest.ts", "--reporter=json", "--root=."])).toBe(false);\n  });\n\n  it("bounds the combined ProductSpec requirement universe at 256", () => {\n    const base = { appName: "bounded", targetUser: "owner", coreFeatures: ["feature"], dataModel: [] };\n    expect(ProductSpecSchema.safeParse({ ...base, userFlows: Array.from({ length: 200 }, (_, i) => \`UF \${i}\`), acceptanceCriteria: Array.from({ length: 56 }, (_, i) => \`AC \${i}\`) }).success).toBe(true);\n    expect(ProductSpecSchema.safeParse({ ...base, userFlows: Array.from({ length: 200 }, (_, i) => \`UF \${i}\`), acceptanceCriteria: Array.from({ length: 57 }, (_, i) => \`AC \${i}\`) }).success).toBe(false);\n  });\n\n  it("keeps all verified products available to targeted fallback", () => {\n    const candidates = Array.from({ length: 10 }, (_, index) => ({ id: \`product-\${index}\`, kind: "product", name: \`Product \${index}\`, url: \`https://product-\${index}.example.com\`, description: "verified", sourceEvidence: [{ url: \`https://product-\${index}.example.com/features\`, excerpt: "feature evidence" }], license: { spdxId: "NOASSERTION", policy: "reference-only" }, inspectionError: null }));\n    const result = reviewableProductCandidates({ candidates, coverage: { productTarget: 5, productDiscoveredCount: 10, productInspectedCount: 10, productVerifiedCount: 10, productCoverageMet: true, repositoryDiscoveredCount: 0, repositoryInspectedCount: 0, repositoryVerifiedCount: 0 } } as never);\n    expect(result.requiredCount).toBe(5); expect(result.candidates).toHaveLength(10);\n  });\n\n  it("requires each mapped acceptance title on the current host", () => {\n    const errors = mappedPlatformCoverageErrors({ testPlan: "mapped", coverage: [{ requirementId: "AC-1", testPath: "tests/flow.test.ts", testName: "saves the task", kind: "integration" }], files: [] } as never, [{ command: "vitest", exitCode: 0, directTestPath: "tests/flow.test.ts", directEvidenceValid: true, passedTestNames: ["different title"], outputTail: "", hostPlatform: "win32" }] as never);\n    expect(errors.join("\\n")).toMatch(/was not reported passed/i);\n  });\n\n  it("preserves own __proto__ in exact file digest receipts", () => {\n    const checkpoint = FactoryCheckpointSchema.parse({ schemaVersion: 3, runId: crypto.randomUUID(), idea: "prototype digest", options: {}, verification: { fileDigests: JSON.parse('{"__proto__":"sha256:exact"}') }, updatedAt: Date.now() });\n    const digests = checkpoint.verification!.fileDigests!; expect(Object.getPrototypeOf(digests)).toBeNull(); expect(Object.hasOwn(digests, "__proto__")).toBe(true); expect(digests["__proto__"]).toBe("sha256:exact");\n  });\n\n  it("streams Windows proof output instead of buffering it in PowerShell", () => {\n    const launcher = readFileSync("scripts/ci/windows-proof-launcher.ps1", "utf8"); expect(launcher).not.toContain("ReadToEndAsync"); expect(launcher).toContain("RedirectStandardOutput = $false"); expect(launcher).toContain("RedirectStandardError = $false");\n  });\n});\n`;
write("src/server/__tests__/issue173Correctness.test.ts", regression);
console.log("Applied issue 173 code repairs and dedicated regressions.");
