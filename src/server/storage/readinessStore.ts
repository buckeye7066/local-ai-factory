import { constants as FS } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isValidRunId } from "../../shared/schemas.js";
import {
  PRODUCTION_READINESS_POLICY,
  type ProductionReadinessReceipt,
  type ReadinessBrainReview,
} from "../orchestrator/productionReadinessPolicy.js";
import { writeFileContained } from "./runsStore.js";

const DATA_ROOT = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
const READINESS_DIR = join(DATA_ROOT, "readiness");

const BrainReviewSchema = z.object({
  identity: z.enum(["sol", "fable", "opus"]),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1),
  evidenceDigest: z.string().min(1),
  decision: z.enum(["ready", "not_ready"]),
  purposeAligned: z.boolean(),
  implementationComplete: z.boolean(),
  technicallyReady: z.boolean(),
  blockers: z.array(
    z.object({
      category: z.enum([
        "purpose",
        "implementation",
        "verification",
        "security",
        "operations",
        "delivery",
        "usability",
        "performance",
      ]),
      detail: z.string(),
    }),
  ),
});

const ReceiptSchema = z.object({
  schema: z.literal(PRODUCTION_READINESS_POLICY.version),
  mandatory: z.literal(true),
  ready: z.boolean(),
  appName: z.string(),
  evidenceDigest: z.string(),
  brainFloor: z.object({
    sol: z.boolean(),
    fableOrOpus: z.boolean(),
    independentFamilies: z.boolean(),
    sameEvidence: z.boolean(),
  }),
  blockers: z.array(z.string()),
  ownerExternalMatters: z.literal("owner-managed-outside-cyberland"),
});

export const ReadinessStateSchema = z.object({
  schema: z.literal("factory.readiness-state.v1"),
  subjectType: z.enum(["run", "foundry-project"]),
  subjectId: z.string().min(1),
  status: z.enum(["not_evaluated", "evaluating", "blocked", "ready"]),
  evidenceDigest: z.string().nullable(),
  reviews: z.array(BrainReviewSchema),
  receipt: ReceiptSchema.nullable(),
  blockers: z.array(z.string()),
  ownerExternalMatters: z.literal("owner-managed-outside-cyberland"),
  updatedAt: z.number(),
});

export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

function safeSubjectId(subjectId: string): string {
  if (isValidRunId(subjectId)) return subjectId;
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(subjectId)) return subjectId;
  throw new Error(
    `Refused: invalid readiness subject id: ${JSON.stringify(subjectId)}`,
  );
}

function statePath(subjectId: string): string {
  const safe = safeSubjectId(subjectId);
  const target = join(READINESS_DIR, `${safe}.json`);
  const rel = relative(resolve(READINESS_DIR), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) {
    throw new Error("Refused: readiness state path escaped its store.");
  }
  return target;
}

async function ensureReadinessDir(): Promise<void> {
  await mkdir(READINESS_DIR, { recursive: true });
  const [rootReal, stateReal] = await Promise.all([
    realpath(DATA_ROOT),
    realpath(READINESS_DIR),
  ]);
  const st = await lstat(READINESS_DIR);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error("Refused: readiness store is not a regular directory.");
  }
  const rel = relative(rootReal, stateReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Refused: readiness store resolves outside the data root.");
  }
}

export function initialReadinessState(
  subjectType: ReadinessState["subjectType"],
  subjectId: string,
): ReadinessState {
  return {
    schema: "factory.readiness-state.v1",
    subjectType,
    subjectId: safeSubjectId(subjectId),
    status: "not_evaluated",
    evidenceDigest: null,
    reviews: [],
    receipt: null,
    blockers: ["Mandatory production readiness has not been evaluated."],
    ownerExternalMatters: "owner-managed-outside-cyberland",
    updatedAt: Date.now(),
  };
}

export async function saveReadinessState(state: ReadinessState): Promise<void> {
  const parsed = ReadinessStateSchema.parse({
    ...state,
    updatedAt: Date.now(),
  });
  if (parsed.status === "ready" && parsed.receipt?.ready !== true) {
    throw new Error(
      "Refused: readiness status cannot be ready without a ready receipt.",
    );
  }
  if (parsed.receipt && parsed.receipt.evidenceDigest !== parsed.evidenceDigest) {
    throw new Error("Refused: readiness receipt digest does not match state evidence.");
  }
  await ensureReadinessDir();
  const path = statePath(parsed.subjectId);
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error("Refused: readiness state target is a symlink.");
  }
  await writeFileContained(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function loadReadinessState(
  subjectId: string,
): Promise<ReadinessState | null> {
  await ensureReadinessDir();
  const path = statePath(subjectId);
  const existing = await lstat(path).catch(() => null);
  if (!existing) return null;
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error("Refused: readiness state is not a regular file.");
  }
  // O_NOFOLLOW adds defense at the final component on platforms that support it.
  const flags = FS.O_RDONLY | (typeof FS.O_NOFOLLOW === "number" ? FS.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    return ReadinessStateSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

export async function recordReadinessEvaluation(input: {
  subjectType: ReadinessState["subjectType"];
  subjectId: string;
  evidenceDigest: string;
  reviews: ReadinessBrainReview[];
  receipt: ProductionReadinessReceipt;
}): Promise<ReadinessState> {
  const status = input.receipt.ready ? "ready" : "blocked";
  const state: ReadinessState = {
    schema: "factory.readiness-state.v1",
    subjectType: input.subjectType,
    subjectId: safeSubjectId(input.subjectId),
    status,
    evidenceDigest: input.evidenceDigest,
    reviews: input.reviews,
    receipt: input.receipt,
    blockers: input.receipt.blockers,
    ownerExternalMatters: "owner-managed-outside-cyberland",
    updatedAt: Date.now(),
  };
  await saveReadinessState(state);
  return state;
}

export async function assertReadyReceipt(
  subjectId: string,
  evidenceDigest?: string,
): Promise<ProductionReadinessReceipt> {
  const state = await loadReadinessState(subjectId);
  if (!state || state.status !== "ready" || state.receipt?.ready !== true) {
    throw new Error(
      `Mandatory production readiness is not satisfied for ${subjectId}.`,
    );
  }
  if (evidenceDigest && state.receipt.evidenceDigest !== evidenceDigest) {
    throw new Error(
      `Mandatory production readiness is stale for ${subjectId}: evidence digest changed.`,
    );
  }
  return state.receipt;
}

export async function markReadinessEvaluating(input: {
  subjectType: ReadinessState["subjectType"];
  subjectId: string;
  evidenceDigest: string;
}): Promise<ReadinessState> {
  const state: ReadinessState = {
    ...initialReadinessState(input.subjectType, input.subjectId),
    status: "evaluating",
    evidenceDigest: input.evidenceDigest,
    blockers: ["Sol and Fable/Opus readiness reviews are running."],
  };
  await saveReadinessState(state);
  return state;
}

/** Test-only location helper; never serve the path through an API. */
export function readinessPathForTests(subjectId: string): string {
  return statePath(subjectId);
}
