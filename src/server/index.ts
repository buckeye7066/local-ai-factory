import express from "express";
import type { Request, Response, NextFunction } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getConfig, getSecrets, toHealth, isFactoryHealthPayload } from "./config.js";
import {
  RunOptionsSchema,
  isValidRunId,
  repoNameProblem,
  type RunSummary,
} from "../shared/schemas.js";
import {
  startRun,
  resumeRun,
  MissingProviderCredentialError,
  RunNotResumableError,
} from "./orchestrator/runFactory.js";
import { requestCancel } from "./orchestrator/cancellation.js";
import {
  getRun,
  listRuns,
  getRunFiles,
  pruneOldRuns,
  deleteRun,
} from "./storage/runsStore.js";
import { rollbackWorkspace } from "./workspace/cleanup.js";
import { githubLogin, githubRepoExists } from "./workspace/gitOps.js";
import {
  lookupIdempotency,
  rememberIdempotency,
  isIdempotencyConflict,
} from "./storage/idempotency.js";
import { appendAuditEvent } from "./storage/auditLog.js";
import { authorizeApiRequest, resolveBindHost } from "./security/access.js";
import { snapshotRoute, getThresholds, probeLiveness } from "./providers/freeRoute.js";
import { paidBudgetStatus } from "./providers/paidBudget.js";
import { createProviderRegistry } from "./providers/index.js";
import {
  clarificationAgent,
  type ClarificationHistoryItem,
} from "./agents/clarificationAgent.js";
import {
  createSession,
  getSession,
  updateSession,
  questionCap,
} from "./storage/clarificationStore.js";
import { createFoundryRouter } from "./foundry/router.js";

/**
 * server/index.ts — the LOCAL backend API.
 *
 * SECURITY: This process is the only place API keys exist. No endpoint ever
 * returns a key; /api/health returns booleans only. The frontend talks to
 * these routes through a dev proxy (or is served as static files from
 * dist/ui in production mode) and never holds secrets.
 */
const config = getConfig();
const secrets = getSecrets();
const app = express();
app.use(express.json({ limit: "1mb" }));

// /api/health is intentionally UNAUTHENTICATED: it exposes only non-secret
// booleans + the launcher's `service` marker, and the EADDRINUSE/idempotency
// probe must reach it even when a token gates every other route. Registered
// BEFORE the auth middleware so it is never subject to it.
/**
 * Assemble the live routing picture served on /api/health.
 *
 * This is the anti-silent-demotion surface: `serving` says who answered the
 * last call, `counts` says how many calls each tier has taken, `paidBudget`
 * says what the rescue has cost today, and `wouldHaveFailedOver` says how
 * often the deck nearly paid and waited instead. A threshold that is quietly
 * too tight shows up in that last number long before it shows up as a bill.
 */
function routeStatus() {
  return {
    ...snapshotRoute(),
    thresholds: getThresholds(),
    paidBudget: (() => {
      const b = paidBudgetStatus();
      return {
        lastHour: b.lastHour,
        lastDay: b.lastDay,
        usdLastDay: b.usdLastDay,
        exhausted: b.exhausted,
        reason: b.reason,
        limits: {
          perHour: b.limits.perHour,
          perDay: b.limits.perDay,
          usdPerDay: b.limits.usdPerDay,
        },
      };
    })(),
  };
}

app.get("/api/health", (_req, res) => {
  res.json(toHealth(config, secrets, routeStatus()));
});

/**
 * AUTH BOUNDARY for all other /api routes. Fail closed: when FACTORY_AUTH_TOKEN
 * is configured, EVERY request needs the bearer token — including loopback,
 * because a local reverse proxy/tunnel makes remote callers appear as 127.0.0.1.
 * With no token configured the app is loopback-only and loopback is trusted.
 * IP is read from the trusted socket peer (`req.socket.remoteAddress`), never
 * from spoofable X-Forwarded-For / Host headers.
 */
app.use("/api", (req, res, next) => {
  const decision = authorizeApiRequest({
    remoteAddress: req.socket.remoteAddress,
    authorization: req.headers.authorization,
    token: secrets.authToken,
  });
  if (!decision.ok) {
    res.status(decision.status).json({ error: decision.reason ?? "Unauthorized." });
    return;
  }
  next();
});

/**
 * Live proxy probe — behind the auth boundary on purpose. Unlike /api/health
 * this actually touches the free backend, so it must not be a way for an
 * unauthenticated caller to generate outbound traffic.
 */
app.get("/api/route", (_req, res) => {
  void (async () => {
    const liveness = await probeLiveness(config.free.baseUrl, config.free.ollamaUrl);
    res.json({ ...routeStatus(), liveness });
  })();
});

/**
 * Clarification loop — the yes/no alternative to direct-prompt mode. The
 * owner states what they want; the backend asks ONE yes/no question at a time
 * (never open-ended) until it is confident, then hands back a refined goal
 * list the client passes into POST /api/runs as options.goals with
 * options.mode="extend".
 */
function clarificationProvider() {
  const registry = createProviderRegistry(config, secrets);
  return registry.resolveLive(undefined, config.defaultCodeProvider);
}

app.post(
  "/api/clarify/start",
  wrap(async (req, res) => {
    const initialRequest =
      typeof req.body?.initialRequest === "string"
        ? req.body.initialRequest.trim()
        : "";
    if (!initialRequest) {
      res.status(400).json({ error: "Field 'initialRequest' is required." });
      return;
    }
    const session = createSession(initialRequest);
    const turn = await clarificationAgent(
      { provider: clarificationProvider() },
      { initialRequest, history: [] },
    );
    updateSession(session.id, {
      status: turn.confident ? "confident" : "active",
      currentQuestion: turn.nextQuestion,
      refinedGoals: turn.refinedGoals,
    });
    res.status(201).json({
      sessionId: session.id,
      confident: turn.confident,
      question: turn.nextQuestion,
      refinedGoals: turn.refinedGoals,
    });
  }),
);

app.post(
  "/api/clarify/:sessionId/answer",
  wrap(async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "Clarification session not found." });
      return;
    }
    if (session.status !== "active") {
      res.status(409).json({ error: `Session is already ${session.status}.` });
      return;
    }
    const answerRaw = String(req.body?.answer ?? "")
      .toLowerCase()
      .trim();
    const answer: "yes" | "no" | null =
      answerRaw === "yes" || answerRaw === "y"
        ? "yes"
        : answerRaw === "no" || answerRaw === "n"
          ? "no"
          : null;
    if (!answer) {
      res.status(400).json({ error: "Field 'answer' must be 'yes' or 'no'." });
      return;
    }
    if (!session.currentQuestion) {
      res.status(409).json({ error: "No pending question on this session." });
      return;
    }
    const history: ClarificationHistoryItem[] = [
      ...session.history,
      { question: session.currentQuestion, answer },
    ];
    const forceConfident = history.length >= questionCap();
    const turn = forceConfident
      ? {
          confident: true,
          nextQuestion: null,
          rationale: `Reached the ${questionCap()}-question cap — proceeding with what's known.`,
          refinedGoals: [
            session.initialRequest,
            ...history.map((h) => `${h.question} -> ${h.answer}`),
          ],
        }
      : await clarificationAgent(
          { provider: clarificationProvider() },
          { initialRequest: session.initialRequest, history },
        );
    updateSession(sessionId, {
      history,
      status: turn.confident ? "confident" : "active",
      currentQuestion: turn.nextQuestion,
      refinedGoals: turn.refinedGoals,
    });
    res.json({
      sessionId,
      confident: turn.confident,
      question: turn.nextQuestion,
      refinedGoals: turn.refinedGoals,
    });
  }),
);

app.get(
  "/api/clarify/:sessionId",
  wrap(async (req, res) => {
    const session = getSession(String(req.params.sessionId));
    if (!session) {
      res.status(404).json({ error: "Clarification session not found." });
      return;
    }
    res.json(session);
  }),
);

/** A `:runId` route param must be a well-formed run id or the route 404s. */
function validRunIdParam(req: Request, res: Response): string | null {
  const runId = String(req.params.runId);
  if (!isValidRunId(runId)) {
    res.status(404).json({ error: "Run not found." });
    return null;
  }
  return runId;
}

/** Route async rejections into the JSON error handler instead of crashing. */
function wrap(
  fn: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

app.post(
  "/api/runs",
  wrap(async (req, res) => {
    const idea = typeof req.body?.idea === "string" ? req.body.idea.trim() : "";
    if (!idea) {
      res.status(400).json({ error: "Field 'idea' is required." });
      return;
    }
    const parsed = RunOptionsSchema.safeParse(req.body?.options ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: `Invalid options: ${parsed.error.issues[0]?.message ?? "bad shape"}`,
      });
      return;
    }
    const headerKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"].trim()
        : "";
    const idempotencyKey = parsed.data.idempotencyKey?.trim() || headerKey || undefined;

    if (idempotencyKey) {
      if (await isIdempotencyConflict(idempotencyKey, idea)) {
        res.status(409).json({
          error: "Idempotency-Key was already used with a different idea.",
        });
        return;
      }
      const existing = await lookupIdempotency(idempotencyKey, idea);
      if (existing) {
        await appendAuditEvent({
          type: "idempotency.hit",
          runId: existing.runId,
          detail: idempotencyKey,
        });
        res.status(200).json({ runId: existing.runId, idempotent: true });
        return;
      }
    }

    // A from-scratch app must be named by the owner, and the name has to be
    // one GitHub will actually accept and is not already taken — checked HERE,
    // before a multi-hour build, not at delivery time when it is too late to
    // ask. A check we could not perform is never treated as a pass; it is
    // allowed through with the collision reported at delivery instead.
    const newRepo = parsed.data.newRepo;
    if (newRepo) {
      const problem = repoNameProblem(newRepo.name);
      if (problem) {
        res.status(400).json({ error: `Invalid repo name: ${problem}` });
        return;
      }
      if (newRepo.createRemote !== false) {
        const owner =
          newRepo.owner?.trim() ||
          process.env.FACTORY_GITHUB_OWNER?.trim() ||
          (await githubLogin(process.cwd())) ||
          "";
        if (owner) {
          const { existence } = await githubRepoExists(
            `${owner}/${newRepo.name}`,
            process.cwd(),
          );
          if (existence === "exists") {
            res.status(409).json({
              error: `The repo ${owner}/${newRepo.name} already exists. Pick a different name.`,
              nameTaken: true,
            });
            return;
          }
        }
      }
    }

    const options = { ...parsed.data, idempotencyKey };
    let run;
    try {
      run = startRun({ idea, options, config, secrets });
    } catch (err) {
      if (err instanceof MissingProviderCredentialError) {
        res.status(409).json({
          error: err.message,
          missing: err.missing,
          blocked: true,
          hint:
            "Start the FREE route (run the 'Claude Code - FREE (Ollama)' shortcut, " +
            "or set FACTORY_FREE_ENABLED=1 with fcc-server running). " +
            "A paid ANTHROPIC_API_KEY / OPENAI_API_KEY is optional and used only " +
            "as a rescue tier. Or pass options.demo=true for offline mock only.",
        });
        return;
      }
      throw err;
    }
    if (idempotencyKey) {
      await rememberIdempotency(idempotencyKey, idea, run.id);
    }
    res.status(201).json({ runId: run.id });
  }),
);

app.get(
  "/api/runs",
  wrap(async (_req, res) => {
    res.json({ runs: await listRuns() });
  }),
);

app.get(
  "/api/runs/:runId",
  wrap(async (req, res) => {
    const runId = validRunIdParam(req, res);
    if (runId === null) return;
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    res.json(run);
  }),
);

app.post(
  "/api/runs/:runId/cancel",
  wrap(async (req, res) => {
    const runId = validRunIdParam(req, res);
    if (runId === null) return;
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    if (run.status !== "queued" && run.status !== "running") {
      res.status(409).json({ error: `Run is already ${run.status}.` });
      return;
    }
    requestCancel(run.id);
    res.status(202).json({ ok: true });
  }),
);

app.post(
  "/api/runs/:runId/resume",
  wrap(async (req, res) => {
    const runId = validRunIdParam(req, res);
    if (runId === null) return;
    try {
      const run = await resumeRun(runId, config, secrets);
      res.status(202).json({ ok: true, runId: run.id });
    } catch (err) {
      if (err instanceof RunNotResumableError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof MissingProviderCredentialError) {
        res.status(409).json({
          error: err.message,
          missing: err.missing,
          blocked: true,
          hint:
            "Restore the provider/free-route configuration used by this run, then resume again.",
        });
        return;
      }
      throw err;
    }
  }),
);

/* ------------------------------------------------------------------ */
/* Deleting runs (owner request: "give me a way to delete old runs")    */
/* ------------------------------------------------------------------ */

/** A run whose work is over — safe to delete without stopping anything. */
function isFinished(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Remove one run's persisted state AND its workspace directory.
 *
 * The workspace goes too by default, on purpose: "delete old runs" that left
 * multi-gigabyte clones behind under `workspaces/` would not have deleted
 * anything that matters. `rollbackWorkspace` only ever removes a directory
 * jailed under WORKSPACE_ROOT, so an inPlace run pointed at the owner's real
 * checkout is refused by construction and reported as kept — deleting a run
 * record must never delete the owner's actual repo.
 *
 * The single guard here is a genuine one, not a confirmation gate: a workspace
 * that a currently RUNNING run is writing into is never removed.
 */
async function deleteRunAndWorkspace(
  run: { id: string; workspacePath: string | null },
  liveWorkspaces: Set<string>,
): Promise<{ runId: string; workspaceRemoved: boolean; workspaceNote: string }> {
  let workspaceRemoved = false;
  let workspaceNote = "No workspace directory recorded.";
  if (run.workspacePath) {
    if (liveWorkspaces.has(resolve(run.workspacePath))) {
      workspaceNote = "Workspace kept: an active run is using it.";
    } else {
      const res = await rollbackWorkspace(config.workspaceRoot, run.workspacePath);
      workspaceRemoved = res.ok;
      workspaceNote = res.ok
        ? `Workspace deleted: ${run.workspacePath}`
        : `Workspace kept (${res.reason ?? "unknown"}): ${run.workspacePath}`;
    }
  }
  await deleteRun(run.id);
  await appendAuditEvent({
    type: "run.deleted",
    runId: run.id,
    detail: workspaceNote,
  });
  return { runId: run.id, workspaceRemoved, workspaceNote };
}

/** Workspaces currently owned by a queued/running run — never delete these. */
function liveWorkspacePaths(runs: RunSummary[]): Set<string> {
  return new Set(
    runs
      .filter((r) => !isFinished(r.status) && r.workspacePath)
      .map((r) => resolve(r.workspacePath!)),
  );
}

app.delete(
  "/api/runs/:runId",
  wrap(async (req, res) => {
    const runId = validRunIdParam(req, res);
    if (runId === null) return;
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    // The ONE case that is refused: a run that is still doing work. Deleting
    // its state out from under the executing orchestrator would leave an
    // orphaned in-flight run writing to a directory that no longer exists.
    // Everything stopped — completed, failed, cancelled — deletes on one click.
    if (!isFinished(run.status)) {
      res.status(409).json({
        error: `This run is still ${run.status}. Stop it first, then delete it.`,
        running: true,
      });
      return;
    }
    const result = await deleteRunAndWorkspace(run, liveWorkspacePaths(await listRuns()));
    res.json({ ok: true, ...result });
  }),
);

/**
 * Bulk cleanup: delete EVERY finished run (and its workspace) in one action.
 * Runs still in flight are skipped and reported by id, never silently ignored.
 */
app.post(
  "/api/runs/delete-finished",
  wrap(async (_req, res) => {
    const runs = await listRuns();
    const live = liveWorkspacePaths(runs);
    const candidates = runs.filter((r) => isFinished(r.status));
    const skipped = runs.filter((r) => !isFinished(r.status)).map((r) => r.id);
    const deleted: string[] = [];
    const workspacesRemoved: string[] = [];
    for (const run of candidates) {
      const result = await deleteRunAndWorkspace(run, live);
      deleted.push(result.runId);
      if (result.workspaceRemoved) workspacesRemoved.push(result.workspaceNote);
    }
    res.json({
      ok: true,
      // candidates == deleted + failed, and skipped is reported separately, so
      // a zero-work run is visibly zero rather than quietly "successful".
      candidates: candidates.length,
      deleted: deleted.length,
      workspacesRemoved: workspacesRemoved.length,
      skippedRunning: skipped,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* New-app repo naming                                                 */
/* ------------------------------------------------------------------ */

/**
 * Validate a proposed app/repo name and say whether it is already taken.
 * Called by the UI as the owner types, and again server-side at run start.
 *
 * "unknown" availability is reported honestly rather than assumed free: if gh
 * cannot answer, telling the owner a name is available would be a claim we did
 * not verify.
 */
app.post(
  "/api/repo/check-name",
  wrap(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const problem = repoNameProblem(name);
    if (problem) {
      res.json({ valid: false, availability: "unknown", reason: problem });
      return;
    }
    const owner =
      (typeof req.body?.owner === "string" ? req.body.owner.trim() : "") ||
      process.env.FACTORY_GITHUB_OWNER?.trim() ||
      (await githubLogin(process.cwd())) ||
      "";
    if (!owner) {
      res.json({
        valid: true,
        availability: "unknown",
        fullName: name,
        reason:
          "Could not determine a GitHub owner (gh not authenticated). The repo will be created locally only.",
      });
      return;
    }
    const fullName = `${owner}/${name}`;
    const { existence, detail } = await githubRepoExists(fullName, process.cwd());
    res.json({
      valid: true,
      owner,
      fullName,
      availability: existence,
      reason: detail,
    });
  }),
);

app.get(
  "/api/runs/:runId/files",
  wrap(async (req, res) => {
    const runId = validRunIdParam(req, res);
    if (runId === null) return;
    const run = await getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    // Full contents are served only from this explicit endpoint (still local).
    const files = await getRunFiles(runId);
    res.json({ files: files.length ? files : run.files });
  }),
);

/** Purpose Foundry is additive: existing Factory Deck routes and standalone tools remain intact. */
app.use("/api/foundry", createFoundryRouter());

/**
 * Production mode: if the UI has been built (pnpm build → dist/ui), serve it
 * directly so the whole app runs as a single process on config.port — no Vite
 * dev server required. The dev flow (pnpm dev on :5180) is unaffected.
 */
const uiDist = resolve(process.cwd(), "dist", "ui");
const servesUi = existsSync(resolve(uiDist, "index.html"));
if (servesUi) {
  app.use(express.static(uiDist));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    // Never SPA-fallback asset requests: a stale cached index.html referencing
    // a rebuilt (renamed) bundle must fail loudly as 404 — serving index.html
    // as JS renders a silent blank page instead.
    if (req.path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(req.path)) {
      res.status(404).end();
      return;
    }
    res.sendFile(resolve(uiDist, "index.html"));
  });
}

/** Last-resort JSON error handler — never leak an HTML stack trace. */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? "Invalid request." });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal error.";
  console.error(`[factory] request failed: ${message}`);
  res.status(500).json({ error: message });
});

// Best-effort history retention; never blocks or fails startup.
void pruneOldRuns().then((n) => {
  if (n) console.log(`[factory] pruned ${n} old run record(s) from .factory`);
});

// Decide the bind interface. Default is loopback (127.0.0.1) so run history and
// generated file contents are NOT reachable from other LAN devices. LAN binding
// is an explicit opt-in (FACTORY_BIND_LAN=1) and is refused without a token.
const bind = resolveBindHost({ bindLan: config.bindLan, token: secrets.authToken });
if (bind.error) {
  console.error(`[factory] ${bind.error}`);
  process.exit(1);
}

const server = app.listen(config.port, bind.host, () => {
  console.log(`[factory] backend listening on http://${bind.host}:${config.port}`);
  console.log(
    bind.lan
      ? `[factory] LAN access ENABLED (bearer token required for remote requests).`
      : `[factory] loopback-only (set FACTORY_BIND_LAN=1 + FACTORY_AUTH_TOKEN to expose on LAN).`,
  );
  if (servesUi) {
    console.log(`[factory] serving built UI from ${uiDist}`);
  }
  console.log(
    `[factory] command execution: ${
      config.allowUntrustedScripts
        ? "REAL (allowlisted commands run in workspaces)"
        : "DISABLED (ALLOW_UNTRUSTED_SCRIPTS=0 — hermetic/test mode)"
    } | workspace: ${config.workspaceRoot}`,
  );
});

// Idempotent start: if the port is already held, verify whether the holder is
// actually a Factory Deck backend before treating it as "already running". If
// it is, exit 0 (safe no-op re-launch). If it's some OTHER service, fail loudly
// (exit 1) instead of pretending — never open or defer to a foreign service.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    void (async () => {
      let isFactory = false;
      try {
        const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        isFactory = isFactoryHealthPayload(await res.json());
      } catch {
        isFactory = false;
      }
      if (isFactory) {
        console.error(
          `[factory] port ${config.port} already serves a Factory Deck backend — nothing to do. Exiting.`,
        );
        process.exit(0);
      }
      console.error(
        `[factory] port ${config.port} is in use by another (non-Factory Deck) process. ` +
          `Free the port or set PORT to a different value. Exiting.`,
      );
      process.exit(1);
    })();
    return;
  }
  console.error(`[factory] server error: ${err.message}`);
  process.exit(1);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
