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
      prompt: z.string().min(1).max(20_000),
      submittedAt: z.number(),
      targetIds: z.array(z.string().uuid()),
    }),
  ),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PortfolioSession = z.infer<typeof PortfolioSessionSchema>;
export type PortfolioTargetInput = { name: string; repoSource: RepoSource };

const SESSION_DIR = resolve(
  process.cwd(),
  process.env.FACTORY_DATA_DIR || ".factory",
  "sessions",
);
const sessions = new Map<string, PortfolioSession>();

function sessionPath(id: string): string {
  if (!z.string().uuid().safeParse(id).success)
    throw new Error("Invalid session id.");
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
  const session: PortfolioSession = {
    id: randomUUID(),
    prompt: redactSecrets(clean),
    status: "queued",
    currentTarget: 0,
    targets: targets.map((target) => ({
      id: target.id,
      name: target.name,
      repoSource: target.repoSource,
      prompt: redactSecrets(routeById.get(target.id)!.prompt),
      routeEvidence: routeById.get(target.id)!.evidence,
      status: "queued",
      runId: null,
      error: null,
    })),
    steering: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveSession(session);
  return redactDeep(session);
}

export function startPortfolioSession(
  session: PortfolioSession,
  config: AppConfig,
  secrets: AppSecrets,
): void {
  void (async () => {
    session.status = "running";
    await saveSession(session);
    for (let index = 0; index < session.targets.length; index += 1) {
      const target = session.targets[index]!;
      session.currentTarget = index;
      target.status = "running";
      const startedPrompt = target.prompt;
      await saveSession(session);
      try {
        const run = await runFactoryTracked(
          {
            idea: startedPrompt,
            options: {
              routingMode: "auto",
              mode: "extend",
              repoSource: target.repoSource,
              goals: [startedPrompt],
              pushToOrigin: true,
            },
            config,
            secrets,
          },
          async (created) => {
            target.runId = created.id;
            await saveSession(session);
            // Covers steering submitted in the tiny interval between marking
            // this target running and the run record being created.
            if (target.prompt !== startedPrompt) {
              await submitRunSteering(
                created.id,
                target.prompt.slice(startedPrompt.length).trim(),
              );
            }
          },
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
    session.status = "completed";
    await saveSession(session);
  })().catch(async (error) => {
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
  | { ok: true; steeringId: string; targetIds: string[] }
  | { ok: false; reason: string }
> {
  const session = sessions.get(id);
  if (!session) return { ok: false, reason: "Portfolio session not found." };
  if (session.status !== "queued" && session.status !== "running") {
    return {
      ok: false,
      reason: `Portfolio session is already ${session.status}.`,
    };
  }
  const clean = prompt.trim();
  if (!clean) return { ok: false, reason: "Steering prompt is required." };
  const routes = routePrompt(
    clean,
    session.targets.map((target) => ({
      id: target.id,
      name: target.name,
      source: target.repoSource.location,
    })),
  );
  const targetIds: string[] = [];
  for (const route of routes) {
    const target = session.targets.find((item) => item.id === route.targetId)!;
    if (target.status !== "queued" && target.status !== "running") continue;
    if (target.status === "queued" || !target.runId) {
      target.prompt += `\n\nADDITIONAL OPERATOR STEERING:\n${route.prompt}`;
      targetIds.push(target.id);
    } else {
      const receipt = await submitRunSteering(target.runId, route.prompt);
      if (receipt.ok) targetIds.push(target.id);
    }
  }
  if (!targetIds.length) {
    return {
      ok: false,
      reason:
        "No remaining program has an open model checkpoint for this steering.",
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
