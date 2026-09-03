import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AppConfig, AppSecrets } from "../config.js";
import { RepoSourceSchema, type RepoSource } from "../../shared/schemas.js";
import { redactDeep, redactSecrets } from "../security/redact.js";
import { submitRunSteering, writeFileContained } from "../storage/runsStore.js";
import { runFactoryTracked } from "./runFactory.js";
import { routePrompt } from "./promptRouter.js";
import { underWorkTheme } from "./themeBind.js";

const SessionTargetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  repoSource: RepoSourceSchema,
  prompt: z.string().min(1).max(24_000),
  routeEvidence: z.enum(["named", "shared", "single"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
  runId: z.string().uuid().nullable(),
  error: z.string().nullable(),
});

const PortfolioSessionSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1).max(20_000),
  status: z.enum(["queued", "running", "completed", "failed"]),
  currentTarget: z.number().int().nonnegative(),
  targets: z.array(SessionTargetSchema).min(1).max(30),
  steering: z.array(
    z.object({
      id: z.string().uuid(),
      prompt: z.string().min(1).max(4_000),
      submittedAt: z.number(),
      targetIds: z.array(z.string().uuid()),
    }),
  ),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PortfolioSession = z.infer<typeof PortfolioSessionSchema>;
export type PortfolioTargetInput = { name: string; repoSource: RepoSource };

type PortfolioExecutionTarget = {
  repoSource: RepoSource;
  prompt: string;
};

const SESSION_DIR = resolve(
  process.cwd(),
  process.env.FACTORY_DATA_DIR || ".factory",
  "sessions",
);
const sessions = new Map<string, PortfolioSession>();

// Raw operator inputs are execution-only and intentionally never persisted.
// Durable/API session state is redacted, while the active process retains the
// exact Git credential URL and configuration prompt needed to do the work.
const executionInputs = new Map<string, Map<string, PortfolioExecutionTarget>>();

function sessionPath(id: string): string {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Invalid session id.");
  return join(SESSION_DIR, `${id}.json`);
}

async function saveSession(session: PortfolioSession): Promise<void> {
  session.updatedAt = Date.now();
  sessions.set(session.id, session);
  await mkdir(SESSION_DIR, { recursive: true });
  await writeFileContained(sessionPath(session.id), JSON.stringify(session));
}

export async function getPortfolioSession(
  id: string,
): Promise<PortfolioSession | null> {
  if (sessions.has(id)) return redactDeep(sessions.get(id)!);
  try {
    const parsed = PortfolioSessionSchema.parse(
      JSON.parse(await readFile(sessionPath(id), "utf8")),
    );
    if (parsed.id !== id) return null;
    if (parsed.status === "queued" || parsed.status === "running") {
      parsed.status = "failed";
      for (const target of parsed.targets) {
        if (target.status === "running") {
          target.status = "failed";
          target.error = "The backend restarted during this portfolio session.";
        }
      }
      await saveSession(parsed);
    }
    return redactDeep(parsed);
  } catch {
    return null;
  }
}

export async function createPortfolioSession(
  prompt: string,
  inputs: PortfolioTargetInput[],
): Promise<PortfolioSession> {
  const clean = prompt.trim();
  const targets = inputs.map((input) => ({
    id: randomUUID(),
    name: input.name.trim(),
    source: input.repoSource.location,
    repoSource: input.repoSource,
  }));
  const routes = routePrompt(clean, targets);
  const routeById = new Map(routes.map((route) => [route.targetId, route]));
  const now = Date.now();
  const executionByTarget = new Map<string, PortfolioExecutionTarget>();
  const sessionTargets = targets.flatMap((target) => {
    const route = routeById.get(target.id)!;
    if (!route.prompt) return [];
    executionByTarget.set(target.id, {
      repoSource: target.repoSource,
      prompt: route.prompt,
    });
    return [
      {
        id: target.id,
        name: target.name,
        repoSource: redactDeep(target.repoSource),
        prompt: redactSecrets(route.prompt),
        routeEvidence: route.evidence,
        status: "queued" as const,
        runId: null,
        error: null,
      },
    ];
  });
  if (!sessionTargets.length) {
    throw new Error("The session prompt did not route work to any selected program.");
  }
  const session: PortfolioSession = {
    id: randomUUID(),
    prompt: redactSecrets(clean),
    status: "queued",
    currentTarget: 0,
    targets: sessionTargets,
    steering: [],
    createdAt: now,
    updatedAt: now,
  };
  executionInputs.set(session.id, executionByTarget);
  try {
    await saveSession(session);
  } catch (error) {
    executionInputs.delete(session.id);
    throw error;
  }
  return redactDeep(session);
}

export function startPortfolioSession(
  sessionId: string,
  config: AppConfig,
  secrets: AppSecrets,
): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Portfolio session not found.");
  const executionByTarget = executionInputs.get(sessionId);
  if (!executionByTarget) {
    throw new Error(
      "Portfolio execution inputs are unavailable after backend restart; start a new session so raw credentials are never recovered from persisted data.",
    );
  }
  void (async () => {
    session.status = "running";
    await saveSession(session);
    for (let index = 0; index < session.targets.length; index += 1) {
      const target = session.targets[index]!;
      const executionTarget = executionByTarget.get(target.id);
      if (!executionTarget) throw new Error(`Execution input is missing for ${target.name}.`);
      session.currentTarget = index;
      target.status = "running";
      const startedPrompt = executionTarget.prompt;
      await saveSession(session);
      try {
        const run = await underWorkTheme(
          { idea: startedPrompt, stage: "portfolio-target" },
          () =>
            runFactoryTracked(
              {
                idea: startedPrompt,
                options: {
                  routingMode: "auto",
                  mode: "extend",
                  repoSource: executionTarget.repoSource,
                  goals: [startedPrompt],
                  pushToOrigin: true,
                },
                config,
                secrets,
              },
              async (created) => {
                target.runId = created.id;
                await saveSession(session);
                if (executionTarget.prompt !== startedPrompt) {
                  await submitRunSteering(
                    created.id,
                    executionTarget.prompt.slice(startedPrompt.length).trim(),
                  );
                }
              },
            ),
        );
        target.status = run.status === "completed" ? "completed" : "failed";
        target.error = run.error;
      } catch (error) {
        target.status = "failed";
        target.error = redactSecrets(
          error instanceof Error ? error.message : "Program run failed.",
        );
      }
      await saveSession(session);
    }
    session.currentTarget = session.targets.length;
    session.status = session.targets.some((target) => target.status === "failed")
      ? "failed"
      : "completed";
    await saveSession(session);
    executionInputs.delete(session.id);
  })().catch(async (error) => {
    executionInputs.delete(session.id);
    session.status = "failed";
    const active = session.targets[session.currentTarget];
    if (active && active.status === "running") {
      active.status = "failed";
      active.error = redactSecrets(
        error instanceof Error ? error.message : "Portfolio session failed.",
      );
    }
    await saveSession(session).catch(() => {});
  });
}

export async function steerPortfolioSession(
  id: string,
  prompt: string,
): Promise<
  { ok: true; steeringId: string; targetIds: string[] } | { ok: false; reason: string }
> {
  const session = sessions.get(id);
  if (!session) return { ok: false, reason: "Portfolio session not found." };
  if (session.status !== "queued" && session.status !== "running") {
    return { ok: false, reason: `Portfolio session is already ${session.status}.` };
  }
  const clean = prompt.trim();
  if (!clean) return { ok: false, reason: "Steering prompt is required." };
  if (clean.length > 4_000) {
    return { ok: false, reason: "Steering prompt must be 4,000 characters or fewer." };
  }
  const executionByTarget = executionInputs.get(id);
  if (!executionByTarget) {
    return {
      ok: false,
      reason: "Execution inputs are unavailable after backend restart; start a new session.",
    };
  }
  const routes = routePrompt(
    clean,
    session.targets.map((target) => ({
      id: target.id,
      name: target.name,
      source: executionByTarget.get(target.id)?.repoSource.location ?? target.repoSource.location,
    })),
  );
  const applicable = routes
    .map((route) => ({
      route,
      target: session.targets.find((item) => item.id === route.targetId)!,
    }))
    .filter(
      ({ route, target }) =>
        route.prompt && (target.status === "queued" || target.status === "running"),
    );
  const targetIds: string[] = [];
  const active = applicable.find(
    ({ target }) => target.status === "running" && target.runId,
  );
  const queuedOverflow = applicable.find(({ route, target }) => {
    if (target.id === active?.target.id) return false;
    const executionTarget = executionByTarget.get(target.id);
    return !executionTarget || executionTarget.prompt.length + route.prompt.length + 34 > 24_000;
  });
  if (queuedOverflow) {
    return {
      ok: false,
      reason: `Queued steering for ${queuedOverflow.target.name} exceeds the session prompt limit or lacks execution input.`,
    };
  }
  if (active?.target.runId) {
    const receipt = await submitRunSteering(active.target.runId, active.route.prompt);
    if (!receipt.ok) return receipt;
    targetIds.push(active.target.id);
  }
  for (const { route, target } of applicable) {
    if (target.id === active?.target.id) continue;
    const executionTarget = executionByTarget.get(target.id)!;
    executionTarget.prompt += `\n\nADDITIONAL OPERATOR STEERING:\n${route.prompt}`;
    target.prompt += `\n\nADDITIONAL OPERATOR STEERING:\n${redactSecrets(route.prompt)}`;
    targetIds.push(target.id);
  }
  if (!targetIds.length) {
    return {
      ok: false,
      reason: "No remaining program has an open model checkpoint for this steering.",
    };
  }
  const steeringId = randomUUID();
  session.steering.push({
    id: steeringId,
    prompt: redactSecrets(clean),
    submittedAt: Date.now(),
    targetIds,
  });
  await saveSession(session);
  return { ok: true, steeringId, targetIds };
}
