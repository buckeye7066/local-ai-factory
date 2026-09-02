import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  CompetitiveResearchSummarySchema,
  GoalContractSchema,
  ProductSpecSchema,
  type CompetitiveResearchSummary,
  type GoalContract,
  type ProductSpec,
  type PurposeProfile,
  type RunOptions,
} from "../../shared/schemas.js";
import { loadProjectMemoryJson, saveProjectMemoryJson } from "../storage/runsStore.js";

const MAX_HISTORY = 12;

const ProjectMemoryEntrySchema = z.object({
  runId: z.string().uuid(),
  state: z.enum(["planned", "completed"]),
  goalContract: GoalContractSchema,
  spec: ProductSpecSchema,
  competitiveResearch: CompetitiveResearchSummarySchema.optional(),
  finalSummary: z.string().max(20_000).default(""),
  nextImprovements: z.array(z.string().max(2_000)).max(30).default([]),
  revision: z.string().max(500).nullable().default(null),
  startedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable().default(null),
});

export const ProjectMemorySchema = z.object({
  schemaVersion: z.literal(1),
  projectKey: z.string().min(1).max(500),
  entries: z.array(ProjectMemoryEntrySchema).max(MAX_HISTORY),
  updatedAt: z.number().int().nonnegative(),
});
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;

export interface ProjectContinuity {
  previousRunIds: string[];
  purpose: string;
  targetUsers: string[];
  priorGoals: string[];
  priorDecisions: string[];
  priorResearch: string[];
  lastOutcome: {
    state: "planned" | "completed";
    summary: string;
    nextImprovements: string[];
    revision: string | null;
  };
}

function unique(values: Iterable<string>, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function clip(value: string, max = 2_000): string {
  const normalized = value.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function canonicalGitIdentity(raw: string): string {
  const scp = raw.trim().match(/^(?:[^@\s]+@)?([^:\s/]+):(.+)$/);
  if (scp && !raw.includes("://") && !/^[A-Za-z]:[\\/]/.test(raw)) {
    const host = scp[1]!.toLowerCase();
    const pathname = scp[2]!.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    return `${host}/${host === "github.com" ? pathname.toLowerCase() : pathname}`;
  }
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/\.git$/i, "").replace(/\/+$/g, "");
    return `${host}${host === "github.com" ? pathname.toLowerCase() : pathname}`;
  } catch {
    return raw
      .trim()
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
  }
}

/** Stable, credential-free identity used to join separate runs for one app. */
export function projectKeyForOptions(options: RunOptions): string | null {
  if (options.mode === "extend" && options.repoSource) {
    return options.repoSource.type === "git"
      ? `git:${canonicalGitIdentity(options.repoSource.location)}`
      : `path-sha256:${createHash("sha256")
          .update(resolve(options.repoSource.location))
          .digest("hex")}`;
  }
  if (options.mode !== "extend" && options.newRepo?.name) {
    return `new:${(options.newRepo.owner ?? "default").toLowerCase()}/${options.newRepo.name.toLowerCase()}`;
  }
  return null;
}

function memoryId(projectKey: string): string {
  return createHash("sha256").update(projectKey).digest("hex");
}

export async function loadProjectMemory(
  projectKey: string,
): Promise<ProjectMemory | null> {
  const raw = await loadProjectMemoryJson(memoryId(projectKey));
  if (!raw) return null;
  const parsed = ProjectMemorySchema.parse(JSON.parse(raw));
  if (parsed.projectKey !== projectKey) {
    throw new Error("Project memory identity mismatch.");
  }
  for (const entry of parsed.entries) {
    assertGoalContractIntegrity(entry.goalContract);
  }
  return parsed;
}

export function continuityFromMemory(
  memory: ProjectMemory | null,
  excludeRunId?: string,
): ProjectContinuity | undefined {
  const entries = (memory?.entries ?? []).filter(
    (entry) => entry.runId !== excludeRunId,
  );
  const last = entries.at(-1);
  if (!memory || !last) return undefined;
  const completed = entries.filter((entry) => entry.state === "completed");
  const research = [...entries]
    .reverse()
    .flatMap((entry) => entry.competitiveResearch?.recommendations ?? [])
    .map(
      (item) => `${item.name}: ${item.howToIntegrate} (evidence: ${item.sourceUrl})`,
    );
  return {
    previousRunIds: entries.map((entry) => entry.runId),
    purpose: last.goalContract.purpose,
    targetUsers: last.goalContract.targetUsers,
    priorGoals: unique(
      entries.flatMap((entry) => entry.goalContract.activeGoals),
      30,
    ),
    priorDecisions: unique(
      completed.flatMap((entry) => [
        ...entry.spec.coreFeatures.map((feature) => `Kept feature: ${feature}`),
        ...entry.spec.userFlows.map((flow) => `Kept workflow: ${flow}`),
      ]),
      30,
    ),
    priorResearch: unique(research, 30),
    lastOutcome: {
      state: last.state,
      summary: last.finalSummary,
      nextImprovements: last.nextImprovements,
      revision: last.revision,
    },
  };
}

function partitionGoals(goals: string[], fallback: string) {
  const active: string[] = [];
  const constraints: string[] = [];
  const nonGoals: string[] = [];
  for (const raw of goals.length ? goals : [fallback]) {
    const value = clip(raw);
    const constraint = value.match(/^constraint\s*:\s*(.+)$/i);
    const nonGoal = value.match(/^non[- ]?goal\s*:\s*(.+)$/i);
    if (constraint) constraints.push(constraint[1]!);
    else if (nonGoal) nonGoals.push(nonGoal[1]!);
    else active.push(value);
  }
  return {
    activeGoals: unique(active.length ? active : [fallback], 20),
    constraints: unique(constraints, 30),
    nonGoals: unique(nonGoals, 30),
  };
}

function currentSpecPurpose(spec: ProductSpec): string {
  if (spec.tagline.trim()) return clip(spec.tagline, 4_000);
  const outcome = spec.userFlows[0] ?? spec.coreFeatures[0]!;
  return clip(`Enable ${spec.targetUser} to ${outcome}.`, 4_000);
}

function explicitPurposeChange(texts: string[]): boolean {
  const pattern =
    /\b(?:(?:change|replace|redefine|pivot|repurpose|retarget|shift)\b[\s\S]{0,80}\b(?:purpose|mission|audience|product)|(?:purpose|mission|audience|product)\b[\s\S]{0,80}\b(?:change|replace|redefine|pivot|repurpose|retarget|shift))\b/i;
  return texts.some((text) => pattern.test(text));
}

function digestGoalContract(
  contract: Omit<GoalContract, "digest">,
): GoalContract["digest"] {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(contract))
    .digest("hex")}`;
}

/** Refuse a checkpoint or memory entry whose mission bytes were altered. */
export function assertGoalContractIntegrity(contract: GoalContract): void {
  const { digest, ...withoutDigest } = contract;
  if (digestGoalContract(withoutDigest) !== digest) {
    throw new Error("Goal contract digest mismatch.");
  }
}

/**
 * Reconcile current intent, repository evidence, and durable history once.
 * Downstream agents receive this exact immutable object through ProductSpec.
 */
export function createGoalContract(input: {
  projectKey: string;
  runId: string;
  idea: string;
  goals: string[];
  spec: ProductSpec;
  purposeProfile?: PurposeProfile;
  memory?: ProjectMemory | null;
  now?: number;
}): GoalContract {
  const history = (input.memory?.entries ?? []).filter(
    (entry) => entry.runId !== input.runId,
  );
  const previous = history.at(-1);
  const partitioned = partitionGoals(input.goals, input.idea);
  const purposeChanged = explicitPurposeChange([
    input.idea,
    ...partitioned.activeGoals,
  ]);
  const preservePriorPurpose = Boolean(previous && !purposeChanged);
  // Once an owner has accepted a mission, a fresh model inference from the
  // same repository may not silently replace it. Repository evidence is the
  // source of truth only for the first run (or an explicit repurpose).
  const purpose = preservePriorPurpose
    ? previous!.goalContract.purpose
    : input.purposeProfile
      ? input.purposeProfile.purpose.text
      : currentSpecPurpose(input.spec);
  const purposeSource: GoalContract["purposeSource"] = preservePriorPurpose
    ? "project-memory"
    : input.purposeProfile
      ? "repository"
      : "current-spec";
  const targetUsers = preservePriorPurpose
    ? previous!.goalContract.targetUsers
    : unique(
        [
          ...(input.purposeProfile?.intendedUsers.map((claim) => claim.text) ?? []),
          input.spec.targetUser,
        ],
        20,
      );
  const priorResearch = unique(
    [...history]
      .reverse()
      .flatMap((entry) => entry.competitiveResearch?.recommendations ?? [])
      .map((item) => `${item.name}: ${item.howToIntegrate}`),
    30,
  );
  const carriedForwardDecisions = unique(
    history
      .filter((entry) => entry.state === "completed")
      .flatMap((entry) => [
        ...entry.spec.coreFeatures.map((feature) => `Feature: ${feature}`),
        ...entry.spec.userFlows.map((flow) => `Workflow: ${flow}`),
      ]),
    30,
  );
  const withoutDigest: Omit<GoalContract, "digest"> = {
    schema: "factory.goal-contract.v1",
    projectKey: input.projectKey,
    purpose: clip(purpose, 20_000),
    purposeSource,
    targetUsers,
    activeGoals: partitioned.activeGoals,
    constraints: unique(
      [
        ...(previous && !purposeChanged ? previous.goalContract.constraints : []),
        ...partitioned.constraints,
      ],
      30,
    ),
    nonGoals: unique(
      [
        ...(previous && !purposeChanged ? previous.goalContract.nonGoals : []),
        ...partitioned.nonGoals,
      ],
      30,
    ),
    continuity: {
      previousRunIds: history.map((entry) => entry.runId).slice(-12),
      carriedForwardDecisions,
      priorResearch,
    },
    createdFromRunId: input.runId,
    createdAt: input.now ?? Date.now(),
  };
  return GoalContractSchema.parse({
    ...withoutDigest,
    digest: digestGoalContract(withoutDigest),
  });
}

/** Stamp the contract and convert every active obligation into test coverage. */
export function withGoalContract(
  spec: ProductSpec,
  contract: GoalContract,
): ProductSpec {
  const acceptanceCriteria = [...spec.acceptanceCriteria];
  const additions = [
    `[MISSION] The primary delivered workflow advances this purpose: ${contract.purpose}`,
    ...contract.activeGoals.map(
      (goal, index) => `[GOAL-${index + 1}] Deliver and directly verify: ${goal}`,
    ),
    ...contract.constraints.map(
      (constraint, index) =>
        `[CONSTRAINT-${index + 1}] Preserve and verify: ${constraint}`,
    ),
    ...contract.nonGoals.map(
      (nonGoal, index) =>
        `[NON-GOAL-${index + 1}] Verify the delivery does not add: ${nonGoal}`,
    ),
  ];
  for (const criterion of additions) {
    if (!acceptanceCriteria.includes(criterion)) acceptanceCriteria.push(criterion);
  }
  return { ...spec, goalContract: contract, acceptanceCriteria };
}

const writes = new Map<string, Promise<unknown>>();

async function updateMemory(
  projectKey: string,
  update: (memory: ProjectMemory) => ProjectMemory,
): Promise<ProjectMemory> {
  const id = memoryId(projectKey);
  const previous = writes.get(id) ?? Promise.resolve();
  const write = previous.then(async () => {
    const current =
      (await loadProjectMemory(projectKey)) ??
      ProjectMemorySchema.parse({
        schemaVersion: 1,
        projectKey,
        entries: [],
        updatedAt: Date.now(),
      });
    const next = ProjectMemorySchema.parse(update(current));
    await saveProjectMemoryJson(id, JSON.stringify(next));
    return next;
  });
  const settled = write.catch(() => undefined);
  writes.set(id, settled);
  void settled.then(() => {
    if (writes.get(id) === settled) writes.delete(id);
  });
  return write;
}

/** Persist the exact context before any builder or release side effect. */
export async function rememberProjectPlan(input: {
  projectKey: string;
  runId: string;
  goalContract: GoalContract;
  spec: ProductSpec;
  competitiveResearch?: CompetitiveResearchSummary;
  now?: number;
}): Promise<ProjectMemory> {
  const now = input.now ?? Date.now();
  return updateMemory(input.projectKey, (memory) => {
    const prior = memory.entries.find((entry) => entry.runId === input.runId);
    const entry = ProjectMemoryEntrySchema.parse({
      runId: input.runId,
      state: prior?.state ?? "planned",
      goalContract: input.goalContract,
      spec: input.spec,
      competitiveResearch: input.competitiveResearch,
      finalSummary: prior?.finalSummary ?? "",
      nextImprovements: prior?.nextImprovements ?? [],
      revision: prior?.revision ?? null,
      startedAt: prior?.startedAt ?? now,
      completedAt: prior?.completedAt ?? null,
    });
    return {
      ...memory,
      entries: [
        ...memory.entries.filter((item) => item.runId !== input.runId),
        entry,
      ].slice(-MAX_HISTORY),
      updatedAt: now,
    };
  });
}

/** Mark an already-recorded plan complete without losing its prior evidence. */
export async function rememberProjectCompletion(input: {
  projectKey: string;
  runId: string;
  goalContract: GoalContract;
  spec: ProductSpec;
  competitiveResearch?: CompetitiveResearchSummary;
  finalSummary: string;
  nextImprovements: string[];
  revision: string | null;
  now?: number;
}): Promise<ProjectMemory> {
  const now = input.now ?? Date.now();
  return updateMemory(input.projectKey, (memory) => {
    const prior = memory.entries.find((entry) => entry.runId === input.runId);
    const entry = ProjectMemoryEntrySchema.parse({
      runId: input.runId,
      state: "completed",
      goalContract: input.goalContract,
      spec: input.spec,
      competitiveResearch: input.competitiveResearch,
      finalSummary: clip(input.finalSummary, 20_000),
      nextImprovements: unique(
        input.nextImprovements.map((item) => clip(item)),
        30,
      ),
      revision: input.revision,
      startedAt: prior?.startedAt ?? now,
      completedAt: now,
    });
    return {
      ...memory,
      entries: [
        ...memory.entries.filter((item) => item.runId !== input.runId),
        entry,
      ].slice(-MAX_HISTORY),
      updatedAt: now,
    };
  });
}
