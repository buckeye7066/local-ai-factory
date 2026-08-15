import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
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

const MarkdownImportSchema = z.object({
  markdown: z.string().min(1).max(1_000_000),
  sourcePath: z.string().min(1).max(2_000).default("Obsidian/Purpose Foundry.md"),
});

function deriveProjectStatus(project: FoundryProject): FoundryProject["status"] {
  const selected = project.stations.filter((station) => station.status !== "not_selected");
  if (selected.some((station) => station.status === "failed")) return "failed";
  if (selected.some((station) => station.status === "needs_attention")) return "needs_attention";
  if (selected.length && selected.every((station) => station.status === "completed")) return "completed";
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

export function createFoundryRouter(store = new FoundryStore()): Router {
  const router = Router();
  const obsidianInbox = process.env.PURPOSE_FOUNDRY_OBSIDIAN_INBOX?.trim() || null;

  // Obsidian remains an independent application. Purpose Foundry watches only
  // the explicitly configured inbox folder and imports changed Markdown notes.
  if (obsidianInbox) {
    const scan = () => void store.importObsidianInbox(obsidianInbox).catch((error: unknown) => {
      console.error(`[foundry] Obsidian scan failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    scan();
    const timer = setInterval(scan, 5_000);
    timer.unref();
  }

  router.get("/stations", (_req, res) => {
    res.json({ protocolVersion: "1.0", stations: STATIONS });
  });

  router.get("/obsidian/status", (_req, res) => {
    res.json({ configured: Boolean(obsidianInbox), inbox: obsidianInbox });
  });

  router.get("/projects", asyncRoute(async (_req, res) => {
    res.json({ projects: await store.list() });
  }));

  router.get("/projects/:projectId", asyncRoute(async (req, res) => {
    const project = await store.get(String(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Purpose Foundry project not found." });
      return;
    }
    res.json(project);
  }));

  router.post("/projects", asyncRoute(async (req, res) => {
    const intake = FoundryIntakeSchema.parse(req.body);
    res.status(201).json(await store.create(intake));
  }));

  router.post("/obsidian/import", asyncRoute(async (req, res) => {
    const input = MarkdownImportSchema.parse(req.body);
    res.status(201).json(await store.create(intakeFromMarkdown(input.markdown, input.sourcePath)));
  }));

  router.post("/obsidian/scan", asyncRoute(async (_req, res) => {
    const inbox = process.env.PURPOSE_FOUNDRY_OBSIDIAN_INBOX?.trim();
    if (!inbox) {
      res.status(409).json({
        error: "Set PURPOSE_FOUNDRY_OBSIDIAN_INBOX to the Obsidian folder Purpose Foundry should watch.",
      });
      return;
    }
    res.json(await store.importObsidianInbox(inbox));
  }));

  router.post("/projects/:projectId/start", asyncRoute(async (req, res) => {
    const project = await store.get(String(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Purpose Foundry project not found." });
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
  }));

  router.post("/projects/:projectId/stations/:stationId/events", asyncRoute(async (req, res) => {
    const stationId = StationIdSchema.parse(req.params.stationId);
    const event = StationEventSchema.parse(req.body);
    const project = await store.get(String(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Purpose Foundry project not found." });
      return;
    }
    const station = project.stations.find((item) => item.stationId === stationId);
    if (!station || station.status === "not_selected") {
      res.status(409).json({ error: "That station is not selected for this project." });
      return;
    }
    station.status = event.status;
    station.summary = event.summary;
    station.artifacts = event.artifacts;
    if (event.status === "active" && !station.startedAt) {
      station.startedAt = Date.now();
      station.attempt += 1;
    }
    if (["completed", "failed", "needs_attention"].includes(event.status)) {
      station.endedAt = Date.now();
    }
    if (event.status === "completed") {
      const currentIndex = project.stations.findIndex((item) => item.stationId === stationId);
      const next = project.stations.slice(currentIndex + 1).find((item) => item.status === "queued");
      if (next) {
        next.status = "active";
        next.startedAt = Date.now();
        next.attempt += 1;
      }
    }
    project.status = deriveProjectStatus(project);
    await store.save(project);
    await store.appendEvidence(project.id, stationId, `station.${event.status}`, {
      summary: event.summary,
      artifacts: event.artifacts,
      evidence: event.evidence,
    });
    res.json(project);
  }));

  return router;
}
