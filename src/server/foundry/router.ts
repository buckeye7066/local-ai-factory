import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { safeErrorMessage } from "../errors.js";
import { RoutingModeSchema } from "../../shared/schemas.js";
import { getConfig, getSecrets, readinessBrainFloor } from "../config.js";
import { loadReadinessState } from "../storage/readinessStore.js";
import {
  evaluateFoundryCompletion,
  requiredProductionStations,
  type RequiredProductionStation,
} from "./readinessPolicy.js";
import { FoundryAdapters } from "./adapters.js";
import {
  FoundryIntakeSchema,
  FoundryProjectSchema,
  FoundryStore,
  STATIONS,
  StationEventSchema,
  StationIdSchema,
  intakeFromMarkdown,
  type FoundryProject,
} from "./model.js";

type StationEvent = z.infer<typeof StationEventSchema>;

class FoundryRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MarkdownImportSchema = z.object({
  markdown: z.string().min(1).max(1_000_000),
  sourcePath: z.string().min(1).max(2_000).default("Obsidian/Purpose Foundry.md"),
  routingMode: RoutingModeSchema.optional(),
  selectedStations: z.array(StationIdSchema).default([]),
});

async function deriveProjectStatus(
  project: FoundryProject,
): Promise<FoundryProject["status"]> {
  const selected = project.stations.filter(
    (station) => station.status !== "not_selected",
  );
  if (selected.some((station) => station.status === "failed")) return "failed";
  if (selected.some((station) => station.status === "needs_attention")) {
    return "needs_attention";
  }
  if (selected.length && selected.every((station) => station.status === "completed")) {
    const readiness = await loadReadinessState(project.id);
    const requiredStations = requiredProductionStations(project.routingMode);
    return evaluateFoundryCompletion({
      factoryReceipt: readiness?.receipt ?? null,
      routingMode: project.routingMode,
      stations: requiredStations.map((stationId) => {
        const station = project.stations.find((item) => item.stationId === stationId);
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
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function createFoundryRouter(
  store = new FoundryStore(),
  adapters = new FoundryAdapters(store),
): Router {
  const router = Router();
  const obsidianInbox = process.env.PURPOSE_FOUNDRY_OBSIDIAN_INBOX?.trim() || null;
  let transitionWrites: Promise<unknown> = Promise.resolve();
  const runningAdapters = new Set<string>();
  const enqueueTransition = <T>(handler: () => Promise<T>): Promise<T> => {
    const transition = transitionWrites.then(handler);
    transitionWrites = transition.catch(() => undefined);
    return transition;
  };
  const serialTransition = (handler: (req: Request, res: Response) => Promise<void>) =>
    asyncRoute(async (req, res) => {
      await enqueueTransition(() => handler(req, res));
    });

  const applyStationEvent = async (
    projectId: string,
    stationId: z.infer<typeof StationIdSchema>,
    event: StationEvent,
  ): Promise<FoundryProject> => {
    const project = await store.get(projectId);
    if (!project)
      throw new FoundryRouteError(404, "Purpose Foundry project not found.");
    const station = project.stations.find((item) => item.stationId === stationId);
    if (!station || station.status === "not_selected") {
      throw new FoundryRouteError(
        409,
        "That station is not selected for this project.",
      );
    }
    if (
      station.status === event.status &&
      station.summary === event.summary &&
      JSON.stringify(station.artifacts) === JSON.stringify(event.artifacts)
    ) {
      return project;
    }
    if (station.status !== "active" && event.status !== "active") {
      throw new FoundryRouteError(
        409,
        `Station ${stationId} is ${station.status}; only the active station may complete or fail.`,
      );
    }
    if (event.status === "active" && station.status !== "active") {
      if (station.status !== "needs_attention" && station.status !== "failed") {
        throw new FoundryRouteError(
          409,
          "Only a failed or attention-required station may be resumed.",
        );
      }
      if (
        project.stations.some(
          (item) => item.stationId !== stationId && item.status === "active",
        )
      ) {
        throw new FoundryRouteError(409, "Another station is already active.");
      }
    }
    const previousStatus = station.status;
    station.status = event.status;
    station.summary = event.summary;
    station.artifacts = event.artifacts;
    const factoryStation = project.stations.find(
      (item) => item.stationId === "factory-deck",
    );
    const requiredStation = requiredProductionStations(project.routingMode).includes(
      stationId as RequiredProductionStation,
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
    if (event.status === "active" && previousStatus !== "active") {
      station.startedAt = Date.now();
      station.endedAt = null;
      station.attempt += 1;
    }
    if (["completed", "failed", "needs_attention"].includes(event.status)) {
      station.endedAt = Date.now();
    }
    if (event.status === "completed") {
      const currentIndex = project.stations.findIndex(
        (item) => item.stationId === stationId,
      );
      const next = project.stations
        .slice(currentIndex + 1)
        .find((item) => item.status === "queued");
      if (next) {
        next.status = "active";
        next.startedAt = Date.now();
        next.attempt += 1;
      }
    }
    project.status = await deriveProjectStatus(project);
    await store.save(project);
    await store.appendEvidence(project.id, stationId, `station.${event.status}`, {
      summary: event.summary,
      artifacts: event.artifacts,
      evidence: event.evidence,
    });
    return project;
  };

  const dispatchActive = (projectId: string): void => {
    void (async () => {
      const project = await store.get(projectId);
      const active = project?.stations.find((station) => station.status === "active");
      if (!project || !active) return;
      const key = `${projectId}:${active.stationId}`;
      if (runningAdapters.has(key)) return;
      runningAdapters.add(key);
      let event: StationEvent;
      try {
        event = StationEventSchema.parse(
          await adapters.execute(project, active.stationId),
        );
      } catch (error) {
        event = StationEventSchema.parse({
          status: "needs_attention",
          summary: `Adapter stopped: ${safeErrorMessage(error).slice(0, 1_000)}`,
          artifacts: [],
          evidence: { adapterError: error instanceof Error ? error.name : "unknown" },
        });
      }
      try {
        const updated = await enqueueTransition(() =>
          applyStationEvent(projectId, active.stationId, event),
        );
        if (event.status === "completed" && updated.status === "running") {
          queueMicrotask(() => dispatchActive(projectId));
        }
      } catch (error) {
        // A manual callback may have already advanced this station. The stale
        // adapter result must never complete a different station or crash the server.
        if (!(error instanceof FoundryRouteError && error.status === 409)) {
          console.error(`[foundry] adapter result failed: ${safeErrorMessage(error)}`);
        }
      } finally {
        runningAdapters.delete(key);
      }
    })().catch((error: unknown) => {
      console.error(`[foundry] adapter dispatch failed: ${safeErrorMessage(error)}`);
    });
  };

  // Durable restart behavior: a server restart must not strand an assembly
  // line in "active" forever. Factory Deck uses a durable idempotency key and
  // FlexFactor owns its own resume/lock state, so re-dispatch is deliberate.
  queueMicrotask(() => {
    void store
      .list()
      .then((projects) => {
        for (const project of projects) {
          if (project.status === "running") dispatchActive(project.id);
        }
      })
      .catch((error: unknown) => {
        console.error(
          `[foundry] active-project recovery failed: ${safeErrorMessage(error)}`,
        );
      });
  });

  // Obsidian remains an independent application. Purpose Foundry watches only
  // the explicitly configured inbox folder and imports changed Markdown notes.
  if (obsidianInbox) {
    const scan = () =>
      void store.importObsidianInbox(obsidianInbox).catch((error: unknown) => {
        console.error(`[foundry] Obsidian scan failed: ${safeErrorMessage(error)}`);
      });
    scan();
    const timer = setInterval(scan, 5_000);
    timer.unref();
  }

  router.get("/stations", (_req, res) => {
    res.json({ protocolVersion: "1.0", stations: STATIONS });
  });

  router.get("/adapters", (_req, res) => {
    res.json({ protocolVersion: "1.1", adapters: adapters.descriptors() });
  });

  router.get("/obsidian/status", (_req, res) => {
    res.json({ configured: Boolean(obsidianInbox), inbox: obsidianInbox });
  });

  router.get(
    "/projects",
    asyncRoute(async (_req, res) => {
      res.json({ projects: await store.list() });
    }),
  );

  router.get(
    "/projects/:projectId",
    asyncRoute(async (req, res) => {
      const project = await store.get(String(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Purpose Foundry project not found." });
        return;
      }
      res.json(project);
    }),
  );

  router.get(
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
    asyncRoute(async (req, res) => {
      const intake = FoundryIntakeSchema.parse(req.body);
      res.status(201).json(await store.create(intake));
    }),
  );

  router.post(
    "/obsidian/import",
    asyncRoute(async (req, res) => {
      const input = MarkdownImportSchema.parse(req.body);
      const intake = intakeFromMarkdown(input.markdown, input.sourcePath);
      res.status(201).json(
        await store.create({
          ...intake,
          routingMode: input.routingMode ?? intake.routingMode,
          selectedStations: input.selectedStations,
        }),
      );
    }),
  );

  router.post(
    "/obsidian/scan",
    asyncRoute(async (_req, res) => {
      const inbox = process.env.PURPOSE_FOUNDRY_OBSIDIAN_INBOX?.trim();
      if (!inbox) {
        res.status(409).json({
          error:
            "Set PURPOSE_FOUNDRY_OBSIDIAN_INBOX to the Obsidian folder Purpose Foundry should watch.",
        });
        return;
      }
      res.json(await store.importObsidianInbox(inbox));
    }),
  );

  router.post(
    "/projects/:projectId/start",
    serialTransition(async (req, res) => {
      const project = await store.get(String(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Purpose Foundry project not found." });
        return;
      }
      const brainFloor = readinessBrainFloor(getConfig(), getSecrets());
      if (!brainFloor.configured) {
        res.status(409).json({
          error:
            "Purpose Foundry is blocked until OpenAI Sol and Anthropic Fable/Opus readiness brains are configured.",
        });
        return;
      }
      if (
        project.status === "running" ||
        project.stations.some((station) => station.status === "active")
      ) {
        res
          .status(409)
          .json({ error: "This project assembly line is already running." });
        return;
      }
      if (project.status === "completed") {
        res
          .status(409)
          .json({ error: "This project has already completed its selected stations." });
        return;
      }
      if (project.status === "failed" || project.status === "needs_attention") {
        res.status(409).json({
          error:
            "Resume the failed or attention-required station instead of skipping it.",
        });
        return;
      }
      const first = project.stations.find((station) => station.status === "queued");
      if (!first) {
        res.status(409).json({ error: "This project has no queued stations." });
        return;
      }
      first.status = "active";
      first.attempt += 1;
      first.startedAt = Date.now();
      project.status = "running";
      await store.save(FoundryProjectSchema.parse(project));
      await store.appendEvidence(project.id, first.stationId, "station.started", {
        attempt: first.attempt,
        constitution: project.constitution,
      });
      res.status(202).json(project);
      queueMicrotask(() => dispatchActive(project.id));
    }),
  );

  router.post(
    "/projects/:projectId/stations/:stationId/run",
    serialTransition(async (req, res) => {
      const projectId = String(req.params.projectId);
      const stationId = StationIdSchema.parse(req.params.stationId);
      const project = await store.get(projectId);
      if (!project) {
        res.status(404).json({ error: "Purpose Foundry project not found." });
        return;
      }
      const station = project.stations.find((item) => item.stationId === stationId);
      if (!station || station.status === "not_selected") {
        res
          .status(409)
          .json({ error: "That station is not selected for this project." });
        return;
      }
      let updated = project;
      if (station.status === "failed" || station.status === "needs_attention") {
        updated = await applyStationEvent(projectId, stationId, {
          status: "active",
          summary: "Adapter retry requested.",
          artifacts: station.artifacts,
          evidence: { retry: true },
        });
      } else if (station.status !== "active") {
        res
          .status(409)
          .json({ error: `Station ${stationId} is ${station.status}, not active.` });
        return;
      }
      res.status(202).json(updated);
      queueMicrotask(() => dispatchActive(projectId));
    }),
  );

  router.post(
    "/projects/:projectId/stations/:stationId/events",
    serialTransition(async (req, res) => {
      const stationId = StationIdSchema.parse(req.params.stationId);
      const event = StationEventSchema.parse(req.body);
      try {
        const project = await applyStationEvent(
          String(req.params.projectId),
          stationId,
          event,
        );
        res.json(project);
        if (event.status === "completed" && project.status === "running") {
          queueMicrotask(() => dispatchActive(project.id));
        }
      } catch (error) {
        if (error instanceof FoundryRouteError) {
          res.status(error.status).json({ error: safeErrorMessage(error) });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
