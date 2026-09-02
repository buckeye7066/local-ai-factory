import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
    expect(
      projectKeyForOptions(
        {
          mode: "extend",
          repoSource: { type: "path", location: "/private/work/GrantFlow" },
        },
        { resolvedRepoOrigin: "git@github.com:Buckeye7066/GrantFlow.git" },
      ),
    ).toBe("git:github.com/buckeye7066/grantflow");

    const customPort = projectKeyForOptions({
      mode: "extend",
      repoSource: {
        type: "git",
        location: "https://git.example.test:8443/Org/GrantFlow.git",
      },
    });
    const otherPort = projectKeyForOptions({
      mode: "extend",
      repoSource: {
        type: "git",
        location: "https://git.example.test:9443/Org/GrantFlow.git",
      },
    });
    expect(customPort).toBe("git:git.example.test:8443/Org/GrantFlow");
    expect(otherPort).not.toBe(customPort);

    const remote = projectKeyForOptions(
      {
        mode: "new",
        newRepo: { name: "GrantFlow", private: true, createRemote: true },
      },
      { resolvedNewRepoOwner: "Buckeye7066", localProjectId: "ignored" },
    );
    expect(remote).toBe("git:github.com/buckeye7066/grantflow");
    expect(remote).toBe(
      projectKeyForOptions({
        mode: "extend",
        repoSource: {
          type: "git",
          location: "git@github.com:Buckeye7066/GrantFlow.git",
        },
      }),
    );
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
    expect(
      projectKeyForOptions({
        mode: "new",
        newRepo: {
          name: "GrantFlow",
          owner: "Buckeye7066",
          private: true,
          createRemote: false,
        },
      }),
    ).toBeNull();
    expect(
      projectKeyForOptions(
        {
          mode: "new",
          newRepo: {
            name: "GrantFlow",
            owner: "Buckeye7066",
            private: true,
            createRemote: false,
          },
        },
        { localProjectId: "purpose-foundry:project-1" },
      ),
    ).toBe(localNew);

    const workspaceOnly = projectKeyForOptions(
      { mode: "new", idempotencyKey: "workspace-job-1" },
      { localProjectId: "workspace-job-1" },
    );
    expect(workspaceOnly).toMatch(/^new-local-sha256:[a-f0-9]{64}$/);
    expect(workspaceOnly).not.toContain("workspace-job-1");
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

  it("turns owner-declared mission and audience markers into code-owned authority", () => {
    const contract = createGoalContract({
      projectKey: "git:github.com/buckeye7066/grantflow",
      runId: randomUUID(),
      idea: "Purpose Foundry assembly",
      goals: [
        "Mission: Match people to verified public funding",
        "Audience: nonprofit grant seekers",
        "Constraint: cite the original opportunity",
      ],
      spec: spec("A model-authored tagline that must not become the mission"),
      purposeProfile: purposeProfile(
        "A repository inference that is not the directive",
      ),
      now: 2,
    });
    expect(contract).toMatchObject({
      purpose: "Match people to verified public funding",
      purposeSource: "current-request",
      targetUsers: ["nonprofit grant seekers"],
      constraints: ["cite the original opportunity"],
    });
    expect(contract.activeGoals).not.toContain(
      "Mission: Match people to verified public funding",
    );
  });

  it("binds every accepted RunOptions goal into the immutable contract", () => {
    const goals = Array.from({ length: 50 }, (_, index) => `Deliver goal ${index + 1}`);
    const contract = createGoalContract({
      projectKey: "git:github.com/buckeye7066/grantflow",
      runId: randomUUID(),
      idea: "Deliver a complete improvement batch",
      goals,
      spec: spec(),
      now: 3,
    });
    expect(contract.activeGoals).toEqual(goals);
    expect(contract.activeGoals).toHaveLength(50);
    expect(withGoalContract(spec(), contract).acceptanceCriteria).toContain(
      "[GOAL-50] Deliver and directly verify: Deliver goal 50",
    );
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

    const protectedMission = createGoalContract({
      projectKey,
      runId: randomUUID(),
      idea: "Do not change the product purpose; improve export reliability",
      goals: ["Do not change the mission", "Improve export reliability"],
      spec: spec("A model-authored replacement that must be ignored"),
      memory,
      now: 31,
    });
    expect(protectedMission.purpose).toBe(firstContract.purpose);
    expect(protectedMission.purposeSource).toBe("project-memory");

    const trailingProtection = createGoalContract({
      projectKey,
      runId: randomUUID(),
      idea: "Change export workflow without changing the product purpose",
      goals: ["Improve export workflow"],
      spec: spec("A second model-authored replacement that must be ignored"),
      memory,
      now: 31,
    });
    expect(trailingProtection.purpose).toBe(firstContract.purpose);
    expect(trailingProtection.purposeSource).toBe("project-memory");

    const terseProtection = createGoalContract({
      projectKey,
      runId: randomUUID(),
      idea: "No change to the product purpose; improve export reliability",
      goals: ["Improve export reliability"],
      spec: spec("A third model-authored replacement that must be ignored"),
      memory,
      now: 31,
    });
    expect(terseProtection.purpose).toBe(firstContract.purpose);

    const contrastedPivot = createGoalContract({
      projectKey,
      runId: randomUUID(),
      idea: "Do not change the export format, but change the product purpose to help funders",
      goals: ["Change the product purpose and audience"],
      spec: spec("Help funders publish opportunities"),
      memory,
      now: 31,
    });
    expect(contrastedPivot.purpose).toBe("Help funders publish opportunities");
    expect(contrastedPivot.purposeSource).toBe("current-spec");

    const audienceUpdate = createGoalContract({
      projectKey,
      runId: randomUUID(),
      idea: "Expand access for educators",
      goals: ["Audience: teachers", "Improve classroom exports"],
      spec: spec("Another model-authored replacement that must be ignored"),
      memory,
      now: 32,
    });
    expect(audienceUpdate.purpose).toBe(firstContract.purpose);
    expect(audienceUpdate.targetUsers).toEqual(["teachers"]);

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

  it("retains the latest completed mission across repeated abandoned plans", async () => {
    const projectKey = `test:${randomUUID()}`;
    const completedRun = randomUUID();
    const completedContract = createGoalContract({
      projectKey,
      runId: completedRun,
      idea: "Build the durable mission",
      goals: ["Build the durable mission"],
      spec: spec("The durable mission"),
      now: 1,
    });
    const completedSpec = withGoalContract(
      spec("The durable mission"),
      completedContract,
    );
    await rememberProjectPlan({
      projectKey,
      runId: completedRun,
      goalContract: completedContract,
      spec: completedSpec,
      now: 1,
    });
    await rememberProjectCompletion({
      projectKey,
      runId: completedRun,
      goalContract: completedContract,
      spec: completedSpec,
      finalSummary: "The durable mission shipped.",
      nextImprovements: [],
      revision: "durable123",
      now: 2,
    });

    for (let index = 0; index < 13; index += 1) {
      const runId = randomUUID();
      const planned = createGoalContract({
        projectKey,
        runId,
        idea: `Abandoned experiment ${index}`,
        goals: [`Abandoned experiment ${index}`],
        spec: spec(`Drift ${index}`),
        memory: await loadProjectMemory(projectKey),
        now: 10 + index,
      });
      await rememberProjectPlan({
        projectKey,
        runId,
        goalContract: planned,
        spec: withGoalContract(spec(`Drift ${index}`), planned),
        now: 10 + index,
      });
    }

    const memory = await loadProjectMemory(projectKey);
    expect(memory?.entries).toHaveLength(12);
    expect(memory?.entries.some((entry) => entry.runId === completedRun)).toBe(true);
    expect(continuityFromMemory(memory)).toMatchObject({
      previousRunIds: [completedRun],
      purpose: completedContract.purpose,
      lastOutcome: { state: "completed", revision: "durable123" },
    });
  });

  it("publishes completion memory only after the terminal run is durably flushed", () => {
    const source = readFileSync("src/server/orchestrator/runFactory.ts", "utf8");
    const completedStatus = source.lastIndexOf('run.status = "completed";');
    const terminalFlush = source.indexOf("await flush();", completedStatus);
    const memoryCompletion = source.indexOf(
      "await rememberProjectCompletion({",
      completedStatus,
    );
    expect(completedStatus).toBeGreaterThan(-1);
    expect(terminalFlush).toBeGreaterThan(completedStatus);
    expect(memoryCompletion).toBeGreaterThan(terminalFlush);
  });
});
