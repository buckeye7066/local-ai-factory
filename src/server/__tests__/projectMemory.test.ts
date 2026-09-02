import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProductSpecSchema, PurposeProfileSchema } from "../../shared/schemas.js";
import {
  assertGoalContractIntegrity,
  continuityFromMemory,
  createGoalContract,
  loadProjectMemory,
  projectKeyForOptions,
  rememberProjectCompletion,
  rememberProjectPlan,
  withGoalContract,
} from "../orchestrator/projectMemory.js";

function spec(tagline = "Help grant seekers find verified funding") {
  return ProductSpecSchema.parse({
    appName: "GrantFlow",
    tagline,
    targetUser: "grant seekers",
    coreFeatures: ["Verified funding search"],
    dataModel: [{ entity: "Opportunity", fields: ["id", "status"] }],
    userFlows: ["Search and verify a funding opportunity"],
    acceptanceCriteria: ["A user can find one verified opportunity"],
  });
}

function purposeProfile(purpose: string, user = "grant seekers") {
  const evidence = {
    id: "PE-001",
    kind: "readme" as const,
    path: "README.md",
    lineStart: 1,
    lineEnd: 2,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    signal: "Repository purpose",
    excerpt: purpose,
  };
  return PurposeProfileSchema.parse({
    profileVersion: 1,
    appName: "GrantFlow",
    purpose: { text: purpose, evidenceIds: [evidence.id] },
    intendedUsers: [{ text: user, evidenceIds: [evidence.id] }],
    evidence: [evidence],
    grounding: {
      grounded: true,
      semanticVerification: "not-performed",
      evidenceCoverage: 1,
      rejectedEvidenceIds: [],
      droppedClaims: [],
    },
  });
}

describe("durable project purpose memory", () => {
  it("derives stable credential-free identities without exposing local paths", () => {
    const withCredential = projectKeyForOptions({
      mode: "extend",
      repoSource: {
        type: "git",
        location:
          "https://secret-token@github.com/Buckeye7066/GrantFlow.git?token=leak",
      },
    });
    const clean = projectKeyForOptions({
      mode: "extend",
      repoSource: {
        type: "git",
        location: "https://github.com/buckeye7066/grantflow",
      },
    });
    expect(withCredential).toBe(clean);
    expect(withCredential).toBe("git:github.com/buckeye7066/grantflow");
    expect(withCredential).not.toContain("secret-token");
    expect(withCredential).not.toContain("token=leak");

    const local = projectKeyForOptions({
      mode: "extend",
      repoSource: { type: "path", location: "/private/work/GrantFlow" },
    });
    expect(local).toMatch(/^path-sha256:[a-f0-9]{64}$/);
    expect(local).not.toContain("/private/work");

    const remote = projectKeyForOptions(
      {
        mode: "new",
        newRepo: { name: "GrantFlow", private: true, createRemote: true },
      },
      { resolvedNewRepoOwner: "Buckeye7066", localProjectId: "ignored" },
    );
    expect(remote).toBe("new:buckeye7066/grantflow");
    expect(
      projectKeyForOptions(
        {
          mode: "new",
          newRepo: { name: "GrantFlow", private: true, createRemote: true },
        },
        { localProjectId: "not-a-remote-owner" },
      ),
    ).toBeNull();

    const localNew = projectKeyForOptions(
      {
        mode: "new",
        newRepo: { name: "GrantFlow", private: true, createRemote: false },
      },
      { localProjectId: "purpose-foundry:project-1" },
    );
    expect(localNew).toMatch(/^new-local-sha256:[a-f0-9]{64}$/);
    expect(localNew).not.toContain("purpose-foundry");
  });

  it("keeps one digest-verified mission unless the owner explicitly changes it", () => {
    const projectKey = "git:github.com/buckeye7066/grantflow";
    const firstRun = randomUUID();
    const first = createGoalContract({
      projectKey,
      runId: firstRun,
      idea: "Add a verified funding search",
      goals: ["Add a verified funding search"],
      spec: spec(),
      now: 1,
    });
    expect(first.purposeSource).toBe("current-spec");
    expect(() => assertGoalContractIntegrity(first)).not.toThrow();

    const stamped = withGoalContract(spec(), first);
    expect(stamped.goalContract).toEqual(first);
    expect(stamped.acceptanceCriteria).toContain(
      "[GOAL-1] Deliver and directly verify: Add a verified funding search",
    );
    expect(
      stamped.acceptanceCriteria.some((criterion) => criterion.startsWith("[MISSION]")),
    ).toBe(true);

    expect(() =>
      assertGoalContractIntegrity({ ...first, purpose: "tampered mission" }),
    ).toThrow(/digest mismatch/i);
  });

  it("persists completed context and carries it into a later run", async () => {
    const projectKey = `test:${randomUUID()}`;
    const firstRun = randomUUID();
    const firstContract = createGoalContract({
      projectKey,
      runId: firstRun,
      idea: "Build verified funding search",
      goals: ["Build verified funding search"],
      spec: spec(),
      now: 10,
    });
    const firstSpec = withGoalContract(spec(), firstContract);
    await rememberProjectPlan({
      projectKey,
      runId: firstRun,
      goalContract: firstContract,
      spec: firstSpec,
      now: 10,
    });
    await rememberProjectCompletion({
      projectKey,
      runId: firstRun,
      goalContract: firstContract,
      spec: firstSpec,
      finalSummary: "Verified funding search shipped.",
      nextImprovements: ["Add alert subscriptions"],
      revision: "abc123",
      now: 20,
    });

    const memory = await loadProjectMemory(projectKey);
    expect(memory?.entries).toHaveLength(1);
    expect(memory?.entries[0]).toMatchObject({
      runId: firstRun,
      state: "completed",
      finalSummary: "Verified funding search shipped.",
      revision: "abc123",
    });

    const secondRun = randomUUID();
    const secondContract = createGoalContract({
      projectKey,
      runId: secondRun,
      idea: "Add exports without changing the product",
      goals: ["Add CSV exports"],
      spec: spec("A randomly drifted tagline"),
      purposeProfile: purposeProfile(
        "A randomly drifted model inference from the same repository",
        "randomly inferred users",
      ),
      memory,
      now: 30,
    });
    expect(secondContract.purpose).toBe(firstContract.purpose);
    expect(secondContract.purposeSource).toBe("project-memory");
    expect(secondContract.targetUsers).toEqual(firstContract.targetUsers);
    expect(secondContract.continuity.previousRunIds).toEqual([firstRun]);

    await rememberProjectPlan({
      projectKey,
      runId: secondRun,
      goalContract: secondContract,
      spec: withGoalContract(spec(), secondContract),
      now: 30,
    });
    const afterSecondPlan = await loadProjectMemory(projectKey);
    const inherited = continuityFromMemory(afterSecondPlan, secondRun);
    expect(inherited).toMatchObject({
      previousRunIds: [firstRun],
      purpose: firstContract.purpose,
      lastOutcome: {
        state: "completed",
        summary: "Verified funding search shipped.",
        nextImprovements: ["Add alert subscriptions"],
        revision: "abc123",
      },
    });

    const repurposed = createGoalContract({
      projectKey,
      runId: randomUUID(),
      idea: "Change the product purpose to help funders publish opportunities",
      goals: ["Change the purpose and audience"],
      spec: spec("Help funders publish opportunities"),
      memory: afterSecondPlan,
      now: 40,
    });
    expect(repurposed.purpose).toBe("Help funders publish opportunities");
    expect(repurposed.purposeSource).toBe("current-spec");

    await rememberProjectPlan({
      projectKey,
      runId: repurposed.createdFromRunId,
      goalContract: repurposed,
      spec: withGoalContract(spec("Help funders publish opportunities"), repurposed),
      now: 40,
    });
    const withAbandonedPivot = await loadProjectMemory(projectKey);
    const followUp = createGoalContract({
      projectKey,
      runId: randomUUID(),
      idea: "Improve export reliability",
      goals: ["Improve export reliability"],
      spec: spec("Another fresh inference"),
      purposeProfile: purposeProfile("Another fresh repository inference"),
      memory: withAbandonedPivot,
      now: 50,
    });
    expect(followUp.purpose).toBe(firstContract.purpose);
    expect(followUp.continuity.previousRunIds).toEqual([firstRun]);
  });
});
