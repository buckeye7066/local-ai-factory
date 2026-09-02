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
import { decodeStructuredGoalDirectives } from "./goalDirectives.js";

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
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function canonicalGitIdentity(raw: string): string {
  const scp = raw.trim().match(/^(?:[^@\s]+@)?([^:\s/]+):(.+)$/);
  if (scp && !raw.includes("://") && !/^[A-Za-z]:[\\/]/.test(raw)) {
    const host = scp[1]!.toLowerCase();
    const pathname = scp[2]!.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `${host}/${host === "github.com" ? pathname.toLowerCase() : pathname}`;
  }
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    // Preserve an explicit port: two self-hosted Git services on one hostname
    // are distinct repositories and must never share durable purpose memory.
    const host = url.host.toLowerCase();
    const pathname = url.pathname.replace(/\/+$/g, "").replace(/\.git$/i, "");
    return `${host}${host === "github.com" ? pathname.toLowerCase() : pathname}`;
  } catch {
    return raw
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  }
}

export interface ProjectIdentityContext {
  /** Authenticated destination owner resolved before a new remote is planned. */
  resolvedNewRepoOwner?: string | null;
  /** Origin discovered from a local checkout during ingestion. */
  resolvedRepoOrigin?: string | null;
  /** Stable within one local-only project; always hashed before persistence. */
  localProjectId?: string | null;
}

/** Stable, credential-free identity used to join separate runs for one app. */
export function projectKeyForOptions(
  options: RunOptions,
  context: ProjectIdentityContext = {},
): string | null {
  if (options.mode === "extend" && options.repoSource) {
    if (options.repoSource.type === "git" || context.resolvedRepoOrigin) {
      return `git:${canonicalGitIdentity(
        options.repoSource.type === "git"
          ? options.repoSource.location
          : context.resolvedRepoOrigin!,
      )}`;
    }
    return `path-sha256:${createHash("sha256")
      .update(resolve(options.repoSource.location))
      .digest("hex")}`;
  }
  if (options.mode !== "extend" && options.newRepo?.name) {
    if (options.newRepo.createRemote === false) {
      if (!context.localProjectId) return null;
      const localIdentity = createHash("sha256")
        .update(
          JSON.stringify({
            project: context.localProjectId,
            name: options.newRepo.name.toLowerCase(),
          }),
        )
        .digest("hex");
      return `new-local-sha256:${localIdentity}`;
    }
    const owner = options.newRepo.owner ?? context.resolvedNewRepoOwner;
    if (owner) {
      // Use the same canonical identity a later extend run derives from the
      // created GitHub remote, so the founding mission is not stranded under
      // a one-time "new" namespace.
      return `git:github.com/${owner.toLowerCase()}/${options.newRepo.name.toLowerCase()}`;
    }
    // A requested remote without a resolved owner is not a workspace-only
    // project. Fail closed instead of silently assigning a different identity.
    return null;
  }
  if (options.mode !== "extend" && context.localProjectId) {
    return `new-local-sha256:${createHash("sha256")
      .update(JSON.stringify({ project: context.localProjectId }))
      .digest("hex")}`;
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
    (entry) => entry.runId !== excludeRunId && entry.state === "completed",
  );
  const last = entries.at(-1);
  if (!memory || !last) return undefined;
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
      [...entries].reverse().flatMap((entry) => entry.goalContract.activeGoals),
      30,
    ),
    priorDecisions: unique(
      [...entries]
        .reverse()
        .flatMap((entry) => [
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

/** A checkpoint is current only while the completed-history frontier is unchanged. */
export function goalContractMatchesProjectMemory(
  contract: GoalContract,
  memory: ProjectMemory | null,
): boolean {
  const completedRunIds = (memory?.entries ?? [])
    .filter(
      (entry) =>
        entry.state === "completed" && entry.runId !== contract.createdFromRunId,
    )
    .map((entry) => entry.runId)
    .slice(-12);
  return (
    completedRunIds.length === contract.continuity.previousRunIds.length &&
    completedRunIds.every(
      (runId, index) => runId === contract.continuity.previousRunIds[index],
    )
  );
}

function partitionGoals(goals: string[], fallback: string) {
  const active: string[] = [];
  const constraints: string[] = [];
  const nonGoals: string[] = [];
  const declaredPurposes: string[] = [];
  const declaredTargetUsers: string[] = [];
  let structuredEnvelopeSeen = false;
  for (const raw of goals.length ? goals : [fallback]) {
    const structured = decodeStructuredGoalDirectives(raw);
    if (structured) {
      if (structuredEnvelopeSeen) {
        throw new Error("Only one structured goal directive envelope is allowed.");
      }
      structuredEnvelopeSeen = true;
      declaredTargetUsers.push(...structured.targetUsers.map((item) => clip(item)));
      active.push(...structured.activeGoals.map((item) => clip(item)));
      constraints.push(...structured.constraints.map((item) => clip(item)));
      nonGoals.push(...structured.nonGoals.map((item) => clip(item)));
      continue;
    }
    const value = raw.trim();
    const constraint = value.match(/^constraint\s*:\s*([\s\S]+)$/i);
    const nonGoal = value.match(/^non[- ]?goal\s*:\s*([\s\S]+)$/i);
    const declaredPurpose = value.match(/^(?:mission|purpose)\s*:\s*([\s\S]+)$/i);
    const declaredAudience = value.match(
      /^(?:audience|target[- ]?users?)\s*:\s*([\s\S]+)$/i,
    );
    if (declaredPurpose) declaredPurposes.push(clip(declaredPurpose[1]!, 20_000));
    else if (declaredAudience) declaredTargetUsers.push(clip(declaredAudience[1]!));
    else if (constraint) constraints.push(clip(constraint[1]!));
    else if (nonGoal) nonGoals.push(clip(nonGoal[1]!));
    else active.push(clip(value));
  }
  const purposes = unique(declaredPurposes, 2);
  if (purposes.length > 1) {
    throw new Error(
      "Conflicting Mission/Purpose directives were supplied for one Factory run.",
    );
  }
  return {
    declaredPurpose: purposes[0] ?? null,
    declaredTargetUsers: unique(declaredTargetUsers, 100),
    activeGoals: unique(active.length ? active : [clip(fallback)], 100),
    constraints: unique(constraints, 100),
    nonGoals: unique(nonGoals, 100),
  };
}

function currentSpecPurpose(spec: ProductSpec): string {
  if (spec.tagline.trim()) return clip(spec.tagline, 4_000);
  const outcome = spec.userFlows[0] ?? spec.coreFeatures[0]!;
  return clip(`Enable ${spec.targetUser} to ${outcome}.`, 4_000);
}

function explicitPurposeChange(texts: string[]): boolean {
  const negatedVerbFirst =
    /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|cannot|can't|cant|without|no)\b[^\n.;!?]{0,40}?\b(?:chang(?:e|ing)|replac(?:e|ing)|redefin(?:e|ing)|pivot(?:ing)?|repurpos(?:e|ing)|retarget(?:ing)?|shift(?:ing)?)\b[^\n.;!?]{0,80}?\b(?:product\s+(?:purpose|mission)|purpose|mission|audience|product)\b/gi;
  const negatedTargetFirst =
    /\b(?:product\s+(?:purpose|mission)|purpose|mission|audience|product)\b[^\n.;!?]{0,40}?\b(?:do\s+not|not|never|must\s+not|should\s+not|cannot|can't|cant)\b[^\n.;!?]{0,40}?\b(?:change|replace|redefine|pivot|repurpose|retarget|shift)\b/gi;
  const negatedTargetShorthand =
    /\b(?:no|without)\b[^\n.;!?]{0,20}?\b(?:product\s+(?:purpose|mission)|purpose|mission|audience|product)\b[^\n.;!?]{0,20}?\b(?:change|replacement|redefinition|pivot|repurposing|retargeting|shift)\b/gi;
  const affirmativeChange =
    /\b(?:(?:change|changing|replace|replacing|redefine|redefining|pivot|pivoting|repurpose|repurposing|retarget|retargeting|shift|shifting)\b[^\n.;!?]{0,80}\b(?:product\s+(?:purpose|mission)|purpose|mission|audience)|(?:product\s+(?:purpose|mission)|purpose|mission|audience)\b[^\n.;!?]{0,80}\b(?:change|changing|replace|replacing|redefine|redefining|pivot|pivoting|repurpose|repurposing|retarget|retargeting|shift|shifting)|(?:pivot|pivoting|repurpose|repurposing|retarget|retargeting)\b[^\n.;!?]{0,40}\b(?:the\s+)?product\b|(?:the\s+)?product\b[^\n.;!?]{0,40}\b(?:pivot|pivoting|repurpose|repurposing|retarget|retargeting))\b/i;
  return texts.some((text) =>
    text.split(/(?:[\n.;!?]+|,?\s+but\s+)/i).some((clause) => {
      // Remove only syntactically negated target-change clauses first. This
      // prevents a leading unrelated verb ("Change export workflow …") from
      // reaching across "without changing the product purpose" and authorizing
      // a mission pivot.
      const affirmativeOnly = clause
        .replace(negatedVerbFirst, " ")
        .replace(negatedTargetFirst, " ")
        .replace(negatedTargetShorthand, " ");
      return affirmativeChange.test(affirmativeOnly);
    }),
  );
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
    (entry) => entry.runId !== input.runId && entry.state === "completed",
  );
  const previous = history.at(-1);
  const partitioned = partitionGoals(input.goals, input.idea);
  const purposeChanged =
    explicitPurposeChange([input.idea, ...partitioned.activeGoals]) ||
    Boolean(
      previous &&
        partitioned.declaredPurpose &&
        partitioned.declaredPurpose.trim() !== previous.goalContract.purpose.trim(),
    );
  const preservePriorPurpose = Boolean(
    previous && !purposeChanged && !partitioned.declaredPurpose,
  );
  const preservePriorAudience = Boolean(previous && !purposeChanged);
  // Once an owner has accepted a mission, a fresh model inference from the
  // same repository may not silently replace it. Repository evidence is the
  // source of truth only for the first run; an explicit repurpose uses the
  // current owner-directed specification.
  const purpose = preservePriorPurpose
    ? previous!.goalContract.purpose
    : partitioned.declaredPurpose
      ? partitioned.declaredPurpose
      : purposeChanged
        ? currentSpecPurpose(input.spec)
        : input.purposeProfile
          ? input.purposeProfile.purpose.text
          : currentSpecPurpose(input.spec);
  const purposeSource: GoalContract["purposeSource"] = preservePriorPurpose
    ? "project-memory"
    : partitioned.declaredPurpose
      ? "current-request"
      : purposeChanged
        ? "current-spec"
        : input.purposeProfile
          ? "repository"
          : "current-spec";
  const targetUsers =
    partitioned.declaredTargetUsers.length > 0
      ? partitioned.declaredTargetUsers
      : preservePriorAudience
        ? previous!.goalContract.targetUsers
        : purposeChanged
          ? unique([input.spec.targetUser], 20)
          : unique(
              [
                ...(input.purposeProfile?.intendedUsers.map((claim) => claim.text) ??
                  []),
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
    [...history]
      .reverse()
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
        ...partitioned.constraints,
        ...(previous && !purposeChanged ? previous.goalContract.constraints : []),
      ],
      200,
    ),
    nonGoals: unique(
      [
        ...partitioned.nonGoals,
        ...(previous && !purposeChanged ? previous.goalContract.nonGoals : []),
      ],
      200,
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

function retainMemoryHistory(
  entries: z.infer<typeof ProjectMemoryEntrySchema>[],
): z.infer<typeof ProjectMemoryEntrySchema>[] {
  const tail = entries.slice(-MAX_HISTORY);
  if (tail.some((entry) => entry.state === "completed")) return tail;
  const latestCompleted = [...entries]
    .reverse()
    .find((entry) => entry.state === "completed");
  return latestCompleted ? [latestCompleted, ...tail.slice(-(MAX_HISTORY - 1))] : tail;
}

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
      entries: retainMemoryHistory([
        ...memory.entries.filter((item) => item.runId !== input.runId),
        entry,
      ]),
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
      entries: retainMemoryHistory([
        ...memory.entries.filter((item) => item.runId !== input.runId),
        entry,
      ]),
      updatedAt: now,
    };
  });
}
