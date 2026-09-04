import express from "express";
import type { Request, Response, NextFunction } from "express";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getConfig, getSecrets, toHealth, isFactoryHealthPayload } from "./config.js";
import {
  RunOptionsSchema,
  RepoSourceSchema,
  isValidRunId,
  repoNameProblem,
  ProviderNameSchema,
  RoutingModeSchema,
  type RoutingMode,
  type RunSummary,
} from "../shared/schemas.js";
import {
  startRun,
  resumeRun,
  runFactoryTracked,
  resumeFactory as resumeFactoryFull,
  MissingProviderCredentialError,
  RunNotResumableError,
  createTierProvider,
  selectRunRouting,
} from "./orchestrator/runFactory.js";
import { requestCancel } from "./orchestrator/cancellation.js";
import {
  createEpicShell,
  planEpic,
  recoverOrphanedEpics,
  getEpic,
  listEpics,
  runEpic,
  type EpicDeps,
} from "./orchestrator/epicRunner.js";
import { epicPlannerAgent } from "./agents/epicPlannerAgent.js";
import {
  getRun,
  listRuns,
  getRunFiles,
  pruneOldRuns,
  deleteRun,
  submitRunSteering,
} from "./storage/runsStore.js";
import { rollbackWorkspace } from "./workspace/cleanup.js";
import { githubLogin, githubRepoExists } from "./workspace/gitOps.js";
import { startIdempotently } from "./storage/idempotency.js";
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
import { safeErrorMessage } from "./errors.js";
import { redactSecrets } from "./security/redact.js";
import { findRemovedRunOption } from "./removedOptions.js";
import { FATAL_EXIT_CODE } from "./exitCodes.js";
import { underWorkTheme } from "./orchestrator/themeBind.js";
import { resumeWorkTheme } from "./orchestrator/workTheme.js";
import {
  createPortfolioSession,
  getPortfolioSession,
  startPortfolioSession,
  steerPortfolioSession,
} from "./orchestrator/portfolioSession.js";

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
function interactiveProvider(routingMode?: RoutingMode) {
  const registry = createProviderRegistry(config, secrets);
  const routing = selectRunRouting({ routingMode }, registry, config);
  return {
    routingMode: routing.routingMode,
    provider: createTierProvider(routing, routing.codeProvider, registry),
  };
}

function respondProviderUnavailable(res: Response, err: unknown): boolean {
  if (!(err instanceof MissingProviderCredentialError)) return false;
  res.status(409).json({
    error: err.message,
    missing: err.missing,
    blocked: true,
    hint: "Enable the final free/local rung or configure a paid provider. Live work follows one paid-first automatic ladder; mock/stub are never used.",
  });
  return true;
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
    const parsedMode = RoutingModeSchema.optional().safeParse(req.body?.routingMode);
    if (!parsedMode.success) {
      res.status(400).json({
        error:
          "Field 'routingMode' must be 'auto' (legacy 'free'/'paid' values are accepted and normalized).",
      });
      return;
    }
    let selected;
    try {
      selected = interactiveProvider(parsedMode.data);
    } catch (err) {
      if (respondProviderUnavailable(res, err)) return;
      throw err;
    }
    // Persist only the normalized automatic route. Legacy client values do not
    // create a second clarification path.
    const session = createSession(initialRequest, selected.routingMode);
    const turn = await clarificationAgent(
      { provider: selected.provider },
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
    let turn;
    if (forceConfident) {
      turn = {
        confident: true,
        nextQuestion: null,
        rationale: `Reached the ${questionCap()}-question cap — proceeding with what's known.`,
        refinedGoals: [
          session.initialRequest,
          ...history.map((h) => `${h.question} -> ${h.answer}`),
        ],
      };
    } else {
      try {
        const selected = interactiveProvider(session.routingMode);
        turn = await clarificationAgent(
          { provider: selected.provider },
          { initialRequest: session.initialRequest, history },
        );
      } catch (err) {
        if (respondProviderUnavailable(res, err)) return;
        throw err;
      }
    }
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

/**
 * Reject any request that names a removed no-op option (dryRun / simulate /
 * reportOnly). Explicit demo runs are accepted and remain delivery-gated.
 * The decision itself lives in removedOptions.ts so it
 * is unit-testable without booting the server.
 *
 * @returns true when the request was rejected (the caller must stop).
 */
function rejectRemovedRunOption(req: Request, res: Response): boolean {
  const rejection = findRemovedRunOption(req.body?.options);
  if (!rejection) return false;
  res.status(rejection.status).json(rejection.body);
  return true;
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
    // Unknown TOP-LEVEL fields fail loud. A `destination` (or any run
    // setting) placed beside `idea` instead of inside `options` used to be
    // silently ignored, turning an extend run into a from-scratch app.
    const allowedTopLevel = new Set(["idea", "options"]);
    const strayKeys = Object.keys((req.body ?? {}) as Record<string, unknown>).filter(
      (k) => !allowedTopLevel.has(k),
    );
    if (strayKeys.length) {
      res.status(400).json({
        error:
          `Unknown top-level field(s): ${strayKeys.join(", ")}. ` +
          `Run settings must be nested inside 'options' ` +
          `(e.g. options.mode, options.repoSource, options.goals).`,
      });
      return;
    }
    if (rejectRemovedRunOption(req, res)) return;
    const parsed = RunOptionsSchema.safeParse(req.body?.options ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path?.length ? ` at '${first.path.join(".")}'` : "";
      res.status(400).json({
        error: `Invalid options${where}: ${first?.message ?? "bad shape"}`,
      });
      return;
    }
    const headerKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"].trim()
        : "";
    const idempotencyKey = parsed.data.idempotencyKey?.trim() || headerKey || undefined;

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
      if (parsed.data.demo !== true && newRepo.createRemote !== false) {
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

    const options = parsed.data.demo
      ? {
          ...parsed.data,
          demo: true,
          publish: false,
          pushToOrigin: false,
          newRepo: parsed.data.newRepo
            ? { ...parsed.data.newRepo, createRemote: false }
            : undefined,
          idempotencyKey,
        }
      : { ...parsed.data, idempotencyKey };
    let run: ReturnType<typeof startRun>;
    try {
      // Bind a directed WorkTheme for the whole async run subtree so every
      // rotated/concurrent model stays on the same open issue (ALS propagates
      // into saveRun().then(executeRun) when started inside this wrapper).
      if (idempotencyKey) {
        const outcome = await startIdempotently(idempotencyKey, idea, (reservedRunId) =>
          underWorkTheme({ idea, stage: "build" }, () =>
            startRun({
              idea,
              options,
              config,
              secrets,
              runId: reservedRunId,
            }),
          ),
        );
        if (outcome.status === "conflict") {
          res.status(409).json({
            error: "Idempotency-Key was already used with a different idea.",
          });
          return;
        }
        if (outcome.status === "existing") {
          await appendAuditEvent({
            type: "idempotency.hit",
            runId: outcome.runId,
            detail: idempotencyKey,
          });
          res.status(200).json({ runId: outcome.runId, idempotent: true });
          return;
        }
        run = outcome.value;
      } else {
        run = underWorkTheme({ idea, stage: "build" }, () =>
          startRun({ idea, options, config, secrets }),
        );
      }
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
            "as a rescue tier. For a clearly marked zero-credit preview, set " +
            "options.demo=true; demo output is never released.",
        });
        return;
      }
      throw err;
    }
    res.status(201).json({ runId: run.id });
  }),
);

const PortfolioSessionRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20_000),
    targets: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            repoSource: RepoSourceSchema,
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

function portfolioRepositoryIdentity(target: {
  repoSource: z.infer<typeof RepoSourceSchema>;
}): string {
  const location = target.repoSource.location.trim();
  if (target.repoSource.type === "path") return `path:${resolve(location)}`;
  const withoutSuffix = location.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const scp = /^git@([^:]+):(.+)$/i.exec(withoutSuffix);
  if (scp) return `git:${scp[1]!.toLowerCase()}/${scp[2]!.toLowerCase()}`;
  try {
    const url = new URL(withoutSuffix);
    return `git:${url.hostname.toLowerCase()}/${url.pathname
      .replace(/^\/+/, "")
      .toLowerCase()}`;
  } catch {
    return `git:${withoutSuffix}`;
  }
}

app.post(
  "/api/sessions",
  wrap(async (req, res) => {
    const parsed = PortfolioSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid portfolio session.",
      });
      return;
    }
    const targetNames = parsed.data.targets.map((target) => target.name.toLowerCase());
    const targetLocations = parsed.data.targets.map(portfolioRepositoryIdentity);
    if (
      new Set(targetNames).size !== targetNames.length ||
      new Set(targetLocations).size !== targetLocations.length
    ) {
      res.status(400).json({
        error: "Every portfolio target must have a unique program name and repository.",
      });
      return;
    }
    try {
      selectRunRouting(
        { routingMode: "auto" },
        createProviderRegistry(config, secrets),
        config,
      );
    } catch (error) {
      if (respondProviderUnavailable(res, error)) return;
      throw error;
    }
    const session = await createPortfolioSession(
      parsed.data.prompt,
      parsed.data.targets,
    );
    startPortfolioSession(session.id, config, secrets);
    res.status(202).json(session);
  }),
);

app.get(
  "/api/sessions/:sessionId",
  wrap(async (req, res) => {
    const id = String(req.params.sessionId ?? "");
    const session = await getPortfolioSession(id);
    if (!session) {
      res.status(404).json({ error: "Portfolio session not found." });
      return;
    }
    res.json(session);
  }),
);

app.post(
  "/api/sessions/:sessionId/steer",
  wrap(async (req, res) => {
    const id = String(req.params.sessionId ?? "");
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const receipt = await steerPortfolioSession(id, prompt);
    if (!receipt.ok) {
      res.status(receipt.reason.includes("not found") ? 404 : 409).json({
        error: receipt.reason,
      });
      return;
    }
    res.status(202).json(receipt);
  }),
);

app.get(
  "/api/runs",
  wrap(async (_req, res) => {
    res.json({ runs: await listRuns() });
  }),
);

/**
 * Epics — large evolutions run as ordered slices (owner order 2026-08-16:
 * reach the factory's purpose "even with larger systems and evolutions").
 * Each slice is a full normal run; the epic advances only on a slice that
 * actually RELEASED to main, pauses with the named reason otherwise, and a
 * paused epic is resumable. No approval gates.
 */
function epicDeps(): EpicDeps {
  return {
    executeSliceRun: (idea, options, onStarted) =>
      underWorkTheme({ idea, stage: "epic-slice" }, () =>
        runFactoryTracked({ idea, options, config, secrets }, onStarted ?? (() => {})),
      ),
    resumeSliceRun: async (runId) =>
      underWorkTheme(resumeWorkTheme(await getRun(runId), runId, "epic-resume"), () =>
        resumeFactoryFull(runId, config, secrets),
      ),
    plan: async (idea, options) => {
      // Planning obeys the same owner-selected economic tier as every slice.
      // Free never rescues to paid; Paid may rotate only among configured paid
      // providers on a narrow quota refusal. Both paths remain time-bounded.
      const planTimeoutMs = Number(
        process.env.FACTORY_PLAN_TIMEOUT_MS ?? 20 * 60 * 1000,
      );
      const withPlanTimeout = async <T>(
        label: string,
        work: Promise<T>,
      ): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        const started = Date.now();
        try {
          return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `${label} planning exceeded ${Math.round(
                        planTimeoutMs / 1000,
                      )}s (waited ${Math.round(
                        (Date.now() - started) / 1000,
                      )}s) and was abandoned. Raise FACTORY_PLAN_TIMEOUT_MS if this route is simply slow.`,
                    ),
                  ),
                planTimeoutMs,
              );
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const registry = createProviderRegistry(config, secrets);
      const routing = selectRunRouting(options, registry, config);
      const provider = createTierProvider(routing, routing.codeProvider, registry);
      return withPlanTimeout(
        `${routing.routingMode}(${routing.codeProvider})`,
        epicPlannerAgent({ provider }, { idea }),
      );
    },
    config,
    secrets,
  };
}

app.post(
  "/api/epics",
  wrap(async (req, res) => {
    const idea = typeof req.body?.idea === "string" ? req.body.idea.trim() : "";
    if (!idea) {
      res.status(400).json({ error: "Field 'idea' is required." });
      return;
    }
    if (rejectRemovedRunOption(req, res)) return;
    const parsed = RunOptionsSchema.safeParse(req.body?.options ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Bad options." });
      return;
    }
    if (parsed.data.demo) {
      res.status(400).json({
        error:
          "Offline demo is available for a single /api/runs job only; epic planning requires live providers.",
      });
      return;
    }
    // Validate the selected economic tier before returning 202. Previously a
    // missing Paid key or disabled Free route failed only in the background,
    // leaving an accepted-but-dead epic instead of an explicit blocked reply.
    try {
      selectRunRouting(parsed.data, createProviderRegistry(config, secrets), config);
    } catch (err) {
      if (respondProviderUnavailable(res, err)) return;
      throw err;
    }
    const deps = epicDeps();
    // Respond immediately: planning alone can take minutes on the free route.
    const shell = await createEpicShell(idea, parsed.data);
    void (async () => {
      const epic = await planEpic(shell, deps);
      if (epic.status === "running") await runEpic(epic, deps);
    })().catch(() => {});
    res.status(202).json({ epicId: shell.id });
  }),
);

app.get(
  "/api/epics",
  wrap(async (_req, res) => {
    res.json({ epics: await listEpics() });
  }),
);

app.get(
  "/api/epics/:epicId",
  wrap(async (req, res) => {
    const epic = await getEpic(String(req.params.epicId));
    if (!epic) {
      res.status(404).json({ error: "Epic not found." });
      return;
    }
    res.json(epic);
  }),
);

app.post(
  "/api/epics/:epicId/resume",
  wrap(async (req, res) => {
    const epic = await getEpic(String(req.params.epicId));
    if (!epic) {
      res.status(404).json({ error: "Epic not found." });
      return;
    }
    // A FAILED epic is resumable too (2026-08-16): an epic whose PLANNING died
    // - e.g. the provider was out of credits - had zero slices and could never
    // be retried, a permanent dead end for work the owner still wanted. Only
    // completed and already-running epics are refused.
    if (epic.status === "completed" || epic.status === "running") {
      res.status(409).json({ error: `Epic is ${epic.status}; nothing to resume.` });
      return;
    }
    // Retry the slice that paused it: reset to pending and continue.
    const slice = epic.slices[epic.currentSlice];
    if (slice) {
      slice.status = "pending";
      slice.detail = null;
    }
    epic.status = "running";
    epic.statusReason = null;
    const deps = epicDeps();
    // Never planned (or planning failed): plan first, then run.
    void (async () => {
      const ready = epic.slices.length === 0 ? await planEpic(epic, deps) : epic;
      if (ready.status !== "failed") await runEpic(ready, deps);
    })().catch(() => {});
    res.status(202).json({ ok: true });
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
  "/api/runs/:runId/steer",
  wrap(async (req, res) => {
    const runId = validRunIdParam(req, res);
    if (runId === null) return;
    const instruction =
      typeof req.body?.instruction === "string" ? req.body.instruction : "";
    const receipt = await submitRunSteering(runId, instruction);
    if (!receipt.ok) {
      const status = receipt.reason === "Run not found." ? 404 : 409;
      res.status(status).json({ error: receipt.reason });
      return;
    }
    res.status(202).json(receipt);
  }),
);

const ProviderSwitchSchema = z
  .object({
    codeProvider: ProviderNameSchema.optional(),
    reviewProvider: ProviderNameSchema.optional(),
  })
  .strict();

app.post(
  "/api/runs/:runId/resume",
  wrap(async (req, res) => {
    const runId = validRunIdParam(req, res);
    if (runId === null) return;
    try {
      // Optional provider switch for this resume (owner order 2026-08-16:
      // move an in-flight run off the free route without losing its paid
      // checkpoint). Unknown providers are rejected by resumeRun.
      const wanted = ProviderSwitchSchema.safeParse(req.body ?? {});
      if (!wanted.success) {
        res
          .status(400)
          .json({ error: wanted.error.issues[0]?.message ?? "Bad providers." });
        return;
      }
      // Resume under the run's ORIGINAL purpose so rotation fit/yield/cooldown
      // stay keyed to the work, not to the resume event (see resumeWorkTheme).
      const run = await underWorkTheme(
        resumeWorkTheme(await getRun(runId), runId),
        () => resumeRun(runId, config, secrets, wanted.data),
      );
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
          hint: "Restore the provider/free-route configuration used by this run, then resume again.",
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
): Promise<{
  runId: string;
  workspaceRemoved: boolean;
  workspaceNote: string;
}> {
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
    const result = await deleteRunAndWorkspace(
      run,
      liveWorkspacePaths(await listRuns()),
    );
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
    //
    // getRunFiles() returns [] on ANY read/parse failure, and the fallback
    // below is run.files — which are FileSummary records with NO `contents`
    // field. Serving those raw broke the declared FileContent[] contract and
    // crashed the Files tab (`match.contents.length` on undefined), taking the
    // whole SPA to a blank page. Normalise to a real FileContent so a missing
    // body is an empty string the UI can render, never a type violation.
    const files = await getRunFiles(runId);
    res.json({
      files: files.length ? files : run.files.map((f) => ({ ...f, contents: "" })),
    });
  }),
);

/** Purpose Foundry is additive: existing Factory Deck routes and standalone tools remain intact. */
app.use("/api/foundry", createFoundryRouter());

/**
 * Production mode: if the UI has been built (pnpm build → dist/ui), serve it
 * directly so the whole app runs as a single process on config.port — no Vite
 * dev server required. The dev flow (pnpm dev on :5190) is unaffected.
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
  const message = safeErrorMessage(err, "Internal error.");
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
const bind = resolveBindHost({
  bindLan: config.bindLan,
  token: secrets.authToken,
});
if (bind.error) {
  console.error(`[factory] ${bind.error}`);
  process.exit(FATAL_EXIT_CODE);
}

/**
 * CRASH VISIBILITY (owner order 2026-08-16): the server died overnight with
 * exit 1 and ZERO output - undiagnosable. Every uncaught error now lands in
 * .factory/crash.log with a stack before anything else happens. Rejections
 * and exceptions are logged-and-survived: durable checkpoints make a live
 * server strictly better than a dead one, and the log names what happened.
 *
 * Handlers MUST register synchronously before listen/orphan-recovery. A prior
 * dynamic `import("node:fs").then(...)` left a race: early unhandled
 * rejections (and Node 20+ default rejection exits) killed the process with
 * exit -1/1 and zero crash.log — the exact overnight failure, re-observed
 * 2026-08-20 when the launcher printed "backend exited with code -1".
 */
{
  const dir = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
  const logCrash = (kind: string, err: unknown) => {
    const detail = redactSecrets(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(resolve(dir, "crash.log"), line);
    } catch {
      /* the console line below still fires */
    }
    console.error(`[factory] ${kind}: ${safeErrorMessage(err)}`);
  };
  process.on("uncaughtException", (err) => logCrash("uncaughtException", err));
  process.on("unhandledRejection", (err) => logCrash("unhandledRejection", err));
}

void recoverOrphanedEpics()
  .then((n) => {
    if (n > 0)
      console.log(`[factory] recovered ${n} orphaned epic(s) — paused, resumable.`);
  })
  .catch((err) => {
    // Boot must stay up even if epic recovery fails — a wedged audit file
    // must not take the whole deck down (exit -1 under the launcher).
    console.error(`[factory] orphan epic recovery failed (continuing):`, err);
  });
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
      // Permanent until the operator frees the port — restarting cannot fix it.
      process.exit(FATAL_EXIT_CODE);
    })();
    return;
  }
  console.error(`[factory] server error: ${safeErrorMessage(err)}`);
  process.exit(1);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
