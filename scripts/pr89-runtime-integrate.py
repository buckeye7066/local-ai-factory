from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 0 and new in text:
        return
    if count != 1:
        raise SystemExit(
            f"{path}: expected one marker, found {count}: {old[:120]!r}"
        )
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def regex_once(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count == 0 and replacement in text:
        return
    if count != 1:
        raise SystemExit(
            f"{path}: expected one regex match, found {count}: {pattern[:120]!r}"
        )
    file.write_text(updated, encoding="utf-8")


# ---------------------------------------------------------------------------
# Factory Deck completion choke point.
# ---------------------------------------------------------------------------
replace_once(
    "src/server/orchestrator/runFactory.ts",
    'import type { ProviderRegistry } from "../providers/index.js";\n'
    "export { MissingProviderCredentialError };",
    '''import type { ProviderRegistry } from "../providers/index.js";
import { createReadinessBrainProviders } from "../providers/readinessBrains.js";
import {
  completeProductionReadiness,
  productionReadinessDigest,
  type ProductionReadinessFacts,
} from "./completeProductionReadiness.js";
import {
  deterministicProductionBlockers,
  evaluateProductionReadiness,
} from "./productionReadinessPolicy.js";
import { recordReadinessEvaluation } from "../storage/readinessStore.js";
export { MissingProviderCredentialError };''',
)

replace_once(
    "src/server/orchestrator/runFactory.ts",
    "    if (run.destination) {\n",
    "    let liveDeploymentVerified = false;\n\n    if (run.destination) {\n",
)

replace_once(
    "src/server/orchestrator/runFactory.ts",
    "          /* Store publish — owner order 2026-08-15: a production-ready app is\n",
    "          liveDeploymentVerified = true;\n\n"
    "          /* Store publish — owner order 2026-08-15: a production-ready app is\n",
)

readiness_block = r'''    const readinessKind = run.destination?.kind ?? "workspace-only";
    const deliveryCompleted = run.destination?.status === "delivered";
    const privateApp = checkpoint.options.publish === false;
    const readinessPurposeProfile = spec.purposeProfile;
    const wiringComplete = !(report.caveats ?? []).some((caveat) =>
      /UNWIRED|WIRING SCAN/i.test(caveat),
    );
    const highOrCriticalIssues = qa.issues.filter((issue) =>
      ["critical", "high"].includes(String(issue.severity).toLowerCase()),
    ).length;
    const readinessFacts: ProductionReadinessFacts = {
      appName: spec.appName,
      purpose: {
        stated: Boolean(args.idea.trim() && spec.appName.trim()),
        grounded: readinessPurposeProfile
          ? readinessPurposeProfile.grounding.grounded &&
            readinessPurposeProfile.evidence.length > 0
          : Boolean(args.idea.trim() && spec.acceptanceCriteria.length > 0),
        goalsCovered:
          verifiedOutcome && (verification.incomplete?.length ?? 0) === 0,
        acceptanceCriteria: spec.acceptanceCriteria.length,
        acceptanceCriteriaExecuted: verifiedOutcome
          ? spec.acceptanceCriteria.length
          : 0,
      },
      technical: {
        qaPassed: qa.passed,
        testsPassed: testStatus === "passing",
        verificationComplete: (verification.incomplete?.length ?? 0) === 0,
        digestReceiptValid: receipt.ok,
        blockingWriteRefusals: blockingWriteRefusals.length,
        wiringComplete,
        criticalSecurityIssues: highOrCriticalIssues,
        operationallyRunnable:
          verifiedOutcome && Boolean(report.howToRun?.trim()),
      },
      delivery: {
        kind: readinessKind,
        delivered: deliveryCompleted,
        releasedToTrunk:
          readinessKind === "existing-repo"
            ? Boolean(run.release?.released || run.destination?.releasedToTrunk)
            : false,
        liveVerified: liveDeploymentVerified,
        localArtifactVerified:
          receipt.ok &&
          deliveryCompleted &&
          (readinessKind === "workspace-only" ||
            (readinessKind === "new-repo" && privateApp)),
      },
      ownerExternalNotes: [
        "Legal, regulatory, contractual, store-policy, and licensing decisions are owner-managed outside cyberland and were not evaluated.",
      ],
    };
    const readinessDigest = productionReadinessDigest(readinessFacts);

    if (run.demo) {
      const demoReceipt = evaluateProductionReadiness({
        ...readinessFacts,
        evidenceDigest: readinessDigest,
        reviews: [],
      });
      demoReceipt.blockers = [
        "Demo/mock output cannot be production-ready.",
        ...demoReceipt.blockers,
      ];
      await recordReadinessEvaluation({
        subjectType: "run",
        subjectId: run.id,
        evidenceDigest: readinessDigest,
        reviews: [],
        receipt: demoReceipt,
      });
      log(
        "warning",
        "Simulation pipeline finished, but mandatory production readiness is blocked by design.",
      );
    } else {
      const deterministicBlockers = deterministicProductionBlockers({
        ...readinessFacts,
        evidenceDigest: readinessDigest,
      });
      if (deterministicBlockers.length > 0) {
        const blockedReceipt = evaluateProductionReadiness({
          ...readinessFacts,
          evidenceDigest: readinessDigest,
          reviews: [],
        });
        await recordReadinessEvaluation({
          subjectType: "run",
          subjectId: run.id,
          evidenceDigest: readinessDigest,
          reviews: [],
          receipt: blockedReceipt,
        });
        run.status = "failed";
        run.resumable = false;
        run.error = redactSecrets(
          `Production readiness blocked before paid brain review: ${deterministicBlockers.join("; ")}`,
        );
        const blockedEvent = await appendAuditEvent({
          type: "run.readiness.blocked",
          runId: run.id,
          detail: run.error,
        });
        await persistAttribution(testStatus, blockedEvent.seq);
        log("warning", run.error);
        await checkpointNow();
        await flush();
        return;
      }

      log(
        "model_call",
        "Mandatory production review: launching independent Sol and Fable/Opus judgments on the same exact evidence digest.",
        "final_review",
      );
      const brainProviders = createReadinessBrainProviders(
        config,
        secrets,
        (kind, message) =>
          log(
            kind === "warn" ? "warning" : "info",
            message,
            "final_review",
          ),
        callSignal,
      );
      const readiness = await completeProductionReadiness({
        subjectType: "run",
        subjectId: run.id,
        facts: readinessFacts,
        solProvider: countProvider(brainProviders.sol),
        solModel: brainProviders.solModel,
        secondProvider: countProvider(brainProviders.second),
        secondIdentity: brainProviders.secondIdentity,
        secondModel: brainProviders.secondModel,
      });
      if (!readiness.receipt.ready) {
        run.status = "failed";
        run.resumable = false;
        run.error = redactSecrets(
          `Production readiness blocked: ${readiness.receipt.blockers.join("; ")}`,
        );
        const blockedEvent = await appendAuditEvent({
          type: "run.readiness.blocked",
          runId: run.id,
          detail: run.error,
        });
        await persistAttribution(testStatus, blockedEvent.seq);
        log("warning", run.error);
        await checkpointNow();
        await flush();
        return;
      }
      run.finalReport = redactDeep({
        ...report,
        providerUsage: run.providerUsage,
      });
      await appendAuditEvent({
        type: "run.readiness.ready",
        runId: run.id,
        detail: readiness.receipt.evidenceDigest,
      });
      log(
        "success",
        `Mandatory production readiness PASSED: Sol and ${brainProviders.secondIdentity} approved ${readiness.receipt.evidenceDigest}.`,
        "final_review",
      );
    }

'''
replace_once(
    "src/server/orchestrator/runFactory.ts",
    '    run.status = "completed";\n',
    readiness_block + '    run.status = "completed";\n',
)

replace_once(
    "src/server/storage/auditLog.ts",
    '  | "run.verification.held"\n',
    '  | "run.verification.held"\n'
    '  | "run.readiness.blocked"\n'
    '  | "run.readiness.ready"\n',
)

# ---------------------------------------------------------------------------
# Purpose Foundry station floor and converged completion.
# ---------------------------------------------------------------------------
replace_once(
    "src/server/foundry/model.ts",
    'import { RoutingModeSchema } from "../../shared/schemas.js";\n',
    'import { RoutingModeSchema } from "../../shared/schemas.js";\n'
    'import {\n'
    '  normalizeFoundryStations,\n'
    '  REQUIRED_PRODUCTION_STATIONS,\n'
    '} from "./readinessPolicy.js";\n',
)

regex_once(
    "src/server/foundry/model.ts",
    r'export const FoundryIntakeSchema = z\n  \.object\(\{([\s\S]*?)\n  \}\)\n'
    r'  \.superRefine\(\(intake, context\) => \{[\s\S]*?\n  \}\);\n'
    r'export type FoundryIntake',
    r'export const FoundryIntakeSchema = z.object({\1\n  });\n'
    r'export type FoundryIntake',
)

replace_once(
    "src/server/foundry/model.ts",
    "  artifacts: z.array(z.string()),\n  startedAt: z.number().nullable(),\n",
    "  artifacts: z.array(z.string()),\n"
    "  evidenceDigest: z.string().nullable().default(null),\n"
    "  revision: z.string().nullable().default(null),\n"
    "  startedAt: z.number().nullable(),\n",
)

regex_once(
    "src/server/foundry/model.ts",
    r'    const blockedUnmeteredStations = new Set<StationId>\([\s\S]*?\n'
    r'    const selected = new Set\([\s\S]*?\n    \);',
    '    const selected = new Set(\n'
    '      normalizeFoundryStations(input.selectedStations, input.routingMode),\n'
    '    );',
)

replace_once(
    "src/server/foundry/model.ts",
    "        artifacts: [],\n        startedAt: null,\n",
    "        artifacts: [],\n"
    "        evidenceDigest: null,\n"
    "        revision: null,\n"
    "        startedAt: null,\n",
)

replace_once(
    "src/server/foundry/model.ts",
    '      routingMode: project.routingMode ?? "legacy-default",\n'
    "      blockedUnmeteredStations: [...blockedUnmeteredStations],\n",
    '      routingMode: project.routingMode ?? "legacy-default",\n'
    "      requiredProductionStations: [...REQUIRED_PRODUCTION_STATIONS],\n",
)

# Foundry router: brain preflight, exact station identity, and no green-badge completion.
replace_once(
    "src/server/foundry/router.ts",
    'import { RoutingModeSchema } from "../../shared/schemas.js";\n',
    '''import { RoutingModeSchema } from "../../shared/schemas.js";
import { getConfig, getSecrets, readinessBrainFloor } from "../config.js";
import { loadReadinessState } from "../storage/readinessStore.js";
import {
  evaluateFoundryCompletion,
  REQUIRED_PRODUCTION_STATIONS,
} from "./readinessPolicy.js";
''',
)

regex_once(
    "src/server/foundry/router.ts",
    r'function deriveProjectStatus\(project: FoundryProject\): '
    r'FoundryProject\["status"\] \{[\s\S]*?\n\}',
    '''async function deriveProjectStatus(
  project: FoundryProject,
): Promise<FoundryProject["status"]> {
  const selected = project.stations.filter(
    (station) => station.status !== "not_selected",
  );
  if (selected.some((station) => station.status === "failed")) return "failed";
  if (selected.some((station) => station.status === "needs_attention")) {
    return "needs_attention";
  }
  if (
    selected.length &&
    selected.every((station) => station.status === "completed")
  ) {
    const readiness = await loadReadinessState(project.id);
    return evaluateFoundryCompletion({
      factoryReceipt: readiness?.receipt ?? null,
      stations: REQUIRED_PRODUCTION_STATIONS.map((stationId) => {
        const station = project.stations.find(
          (item) => item.stationId === stationId,
        );
        return {
          stationId,
          status:
            station?.status === "completed"
              ? "completed"
              : station?.status === "failed"
                ? "failed"
                : station?.status === "needs_attention"
                  ? "needs_attention"
                  : station?.status === "active"
                    ? "active"
                    : "queued",
          evidenceDigest: station?.evidenceDigest ?? null,
          revision: station?.revision ?? null,
        };
      }),
    }).status;
  }
  if (selected.some((station) => station.status === "active")) return "running";
  return "queued";
}''',
)

replace_once(
    "src/server/foundry/router.ts",
    "    station.summary = event.summary;\n    station.artifacts = event.artifacts;\n",
    '''    station.summary = event.summary;
    station.artifacts = event.artifacts;
    const factoryStation = project.stations.find(
      (item) => item.stationId === "factory-deck",
    );
    const requiredStation = REQUIRED_PRODUCTION_STATIONS.includes(
      stationId as (typeof REQUIRED_PRODUCTION_STATIONS)[number],
    );
    station.evidenceDigest =
      typeof event.evidence.evidenceDigest === "string"
        ? event.evidence.evidenceDigest
        : event.status === "completed" && requiredStation
          ? (factoryStation?.evidenceDigest ?? null)
          : null;
    station.revision =
      typeof event.evidence.revision === "string"
        ? event.evidence.revision
        : event.status === "completed" && requiredStation
          ? (factoryStation?.revision ?? null)
          : null;
''',
)

replace_once(
    "src/server/foundry/router.ts",
    "    project.status = deriveProjectStatus(project);\n",
    "    project.status = await deriveProjectStatus(project);\n",
)

replace_once(
    "src/server/foundry/router.ts",
    '      if (\n        project.status === "running" ||\n',
    '''      const brainFloor = readinessBrainFloor(getConfig(), getSecrets());
      if (!brainFloor.configured) {
        res.status(409).json({
          error:
            "Purpose Foundry is blocked until OpenAI Sol and Anthropic Fable/Opus readiness brains are configured.",
        });
        return;
      }
      if (
        project.status === "running" ||
''',
)

replace_once(
    "src/server/foundry/router.ts",
    '  router.post(\n    "/projects",\n',
    '''  router.get(
    "/projects/:projectId/readiness",
    asyncRoute(async (req, res) => {
      const readiness = await loadReadinessState(String(req.params.projectId));
      res.json(
        readiness ?? {
          status: "not_evaluated",
          receipt: null,
          blockers: ["Mandatory production readiness has not been evaluated."],
          ownerExternalMatters: "owner-managed-outside-cyberland",
        },
      );
    }),
  );

  router.post(
    "/projects",
''',
)

# Factory Deck adapter propagates the actual dual-brain receipt to the Foundry project.
replace_once(
    "src/server/foundry/adapters.ts",
    'import { getRun } from "../storage/runsStore.js";\n',
    '''import { getRun } from "../storage/runsStore.js";
import {
  loadReadinessState,
  recordReadinessEvaluation,
} from "../storage/readinessStore.js";
''',
)

replace_once(
    "src/server/foundry/adapters.ts",
    '      `Constraints: ${project.constitution.constraints.join("; ") || '
    '"none specified"}`,\n',
    '      `Constraints: ${project.constitution.constraints.join("; ") || '
    '"none specified"}`,\n'
    '      `Non-goals: ${project.constitution.nonGoals.join("; ") || '
    '"none specified"}`,\n'
    '      `Targets: ${project.constitution.targets.join("; ") || '
    '"none specified"}`,\n'
    '      "Mandatory completion: the run is not complete until the purpose-bound '
    'factory.production-readiness.v1 receipt is ready and approved independently '
    'by Sol plus Fable/Opus. Owner-managed legal/external matters remain outside '
    'cyberland.",\n',
)

old_factory_success = '''    return {
      status: "completed",
      summary: run.finalReport?.summary || `Factory Deck completed run ${run.id}.`,
      artifacts: [
        artifact,
        ...(run.workspacePath ? [run.workspacePath] : []),
        ...(run.destination?.url ? [run.destination.url] : []),
      ],
      evidence: {
        runId: run.id,
        status: run.status,
        destination: run.destination ?? null,
        errorLedger,
      },
    };'''
new_factory_success = '''    const readiness = await loadReadinessState(run.id);
    if (readiness?.status !== "ready" || readiness.receipt?.ready !== true) {
      return {
        status: "needs_attention",
        summary: `Factory Deck pipeline ended, but mandatory production readiness is blocked: ${(readiness?.blockers ?? ["receipt missing"]).join("; ")}`,
        artifacts: [artifact],
        evidence: {
          runId: run.id,
          status: run.status,
          readiness: readiness ?? null,
          errorLedger,
        },
      };
    }
    await recordReadinessEvaluation({
      subjectType: "foundry-project",
      subjectId: project.id,
      evidenceDigest: readiness.receipt.evidenceDigest,
      reviews: readiness.reviews,
      receipt: readiness.receipt,
    });
    const revision =
      run.release?.mergedSha ??
      run.destination?.commitSha ??
      readiness.receipt.evidenceDigest;
    return {
      status: "completed",
      summary: run.finalReport?.summary || `Factory Deck completed run ${run.id}.`,
      artifacts: [
        artifact,
        ...(run.workspacePath ? [run.workspacePath] : []),
        ...(run.destination?.url ? [run.destination.url] : []),
      ],
      evidence: {
        runId: run.id,
        status: run.status,
        destination: run.destination ?? null,
        evidenceDigest: readiness.receipt.evidenceDigest,
        revision,
        readinessReceipt: readiness.receipt,
        errorLedger,
      },
    };'''
replace_once(
    "src/server/foundry/adapters.ts",
    old_factory_success,
    new_factory_success,
)

# FlexFactor remains an unmetered verification station even when build work is Paid.
regex_once(
    "src/server/foundry/adapters.ts",
    r'    const config = this\.dependencies\.config\(\);\n'
    r'    const routing = selectRunRouting\([\s\S]*?\n'
    r'    if \(routing\.routingMode === "paid"\) \{[\s\S]*?\n    \}\n'
    r'    // Free is a hard boundary\.',
    '    // Scout/FlexFactor is an unmetered verification station. Paid build mode\n'
    '    // does not remove it or turn the child into an untracked paid process.\n'
    '    // Free is a hard boundary.',
)

# A private/local app may satisfy Watchtower with the exact durable artifact receipt.
old_watch_no_urls = '''    if (!configured.length) {
      return {
        status: "needs_attention",
        summary:
          "Watchtower needs at least one explicit PURPOSE_FOUNDRY_WATCH_URLS endpoint.",
        artifacts: [],
        evidence: { missing: "PURPOSE_FOUNDRY_WATCH_URLS" },
      };
    }'''
new_watch_no_urls = '''    if (!configured.length) {
      const readiness = await loadReadinessState(project.id);
      const factoryStation = project.stations.find(
        (station) => station.stationId === "factory-deck",
      );
      if (
        readiness?.status === "ready" &&
        readiness.receipt?.ready === true &&
        factoryStation?.evidenceDigest &&
        factoryStation.revision
      ) {
        const artifact = await this.store.writeArtifact(
          project.id,
          "watchtower",
          "local-production-health.json",
          {
            checkedAt: Date.now(),
            mode: "private-local-artifact",
            evidenceDigest: factoryStation.evidenceDigest,
            revision: factoryStation.revision,
            receipt: readiness.receipt,
          },
        );
        return {
          status: "completed",
          summary:
            "Watchtower verified the private/local production artifact and its exact readiness receipt; no public endpoint was required.",
          artifacts: [artifact],
          evidence: {
            mode: "private-local-artifact",
            evidenceDigest: factoryStation.evidenceDigest,
            revision: factoryStation.revision,
          },
        };
      }
      return {
        status: "needs_attention",
        summary:
          "Watchtower needs explicit watch URLs or a verified private/local production artifact receipt.",
        artifacts: [],
        evidence: { missing: "PURPOSE_FOUNDRY_WATCH_URLS_OR_LOCAL_RECEIPT" },
      };
    }'''
replace_once(
    "src/server/foundry/adapters.ts",
    old_watch_no_urls,
    new_watch_no_urls,
)

# The policy's deterministic preflight uses synthetic ready reviews only to
# isolate non-model blockers. It never issues or persists a receipt.
policy = Path("src/server/orchestrator/productionReadinessPolicy.ts")
text = policy.read_text(encoding="utf-8")
if "export function deterministicProductionBlockers" not in text:
    text += '''

export function deterministicProductionBlockers(
  evidence: Omit<ProductionReadinessEvidence, "reviews">,
): string[] {
  const synthetic: ReadinessBrainReview[] = [
    {
      identity: "sol",
      provider: "openai",
      model: "deterministic-preflight-only",
      evidenceDigest: evidence.evidenceDigest,
      decision: "ready",
      purposeAligned: true,
      implementationComplete: true,
      technicallyReady: true,
      blockers: [],
    },
    {
      identity: "opus",
      provider: "anthropic",
      model: "opus-deterministic-preflight-only",
      evidenceDigest: evidence.evidenceDigest,
      decision: "ready",
      purposeAligned: true,
      implementationComplete: true,
      technicallyReady: true,
      blockers: [],
    },
  ];
  return evaluateProductionReadiness({ ...evidence, reviews: synthetic }).blockers;
}
'''
    policy.write_text(text, encoding="utf-8")

# Any blocker means an all-green station board still needs attention.
replace_once(
    "src/server/foundry/readinessPolicy.ts",
    '''  const needsAttention = input.stations.some(
    (station) => station.status === "needs_attention",
  );
''',
    "",
)
replace_once(
    "src/server/foundry/readinessPolicy.ts",
    '''          : needsAttention
            ? "needs_attention"
            : "running",
''',
    '          : "needs_attention",\n',
)

# A provider failure becomes a durable blocked receipt, never a stranded
# evaluating state or a one-brain success.
replace_once(
    "src/server/orchestrator/completeProductionReadiness.ts",
    "  reviews: [ReadinessBrainReview, ReadinessBrainReview];\n",
    "  reviews: ReadinessBrainReview[];\n",
)
old_review_body = '''  const reviews = await independentProductionReadinessReviews({
    solProvider: input.solProvider,
    solModel: input.solModel,
    secondProvider: input.secondProvider,
    secondIdentity: input.secondIdentity,
    secondModel: input.secondModel,
    evidence: immutableEvidence,
  });
  const evidence: ProductionReadinessEvidence = {
    ...immutableEvidence,
    reviews,
  };
  const receipt = evaluateProductionReadiness(evidence);
  const state = await recordReadinessEvaluation({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    evidenceDigest,
    reviews,
    receipt,
  });
  return { evidence, reviews, receipt, state };'''
new_review_body = '''  let reviews: ReadinessBrainReview[] = [];
  try {
    reviews = await independentProductionReadinessReviews({
      solProvider: input.solProvider,
      solModel: input.solModel,
      secondProvider: input.secondProvider,
      secondIdentity: input.secondIdentity,
      secondModel: input.secondModel,
      evidence: immutableEvidence,
    });
  } catch {
    const evidence: ProductionReadinessEvidence = {
      ...immutableEvidence,
      reviews: [],
    };
    const receipt = evaluateProductionReadiness(evidence);
    receipt.blockers = [
      "Mandatory Sol and Fable/Opus review failed before both independent decisions completed.",
      ...receipt.blockers,
    ];
    const state = await recordReadinessEvaluation({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      evidenceDigest,
      reviews: [],
      receipt,
    });
    return { evidence, reviews: [], receipt, state };
  }
  const evidence: ProductionReadinessEvidence = {
    ...immutableEvidence,
    reviews,
  };
  const receipt = evaluateProductionReadiness(evidence);
  const state = await recordReadinessEvaluation({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    evidenceDigest,
    reviews,
    receipt,
  });
  return { evidence, reviews, receipt, state };'''
replace_once(
    "src/server/orchestrator/completeProductionReadiness.ts",
    old_review_body,
    new_review_body,
)
