import { useCallback, useEffect, useRef, useState } from "react";
import { jsonFetch, retryDelay } from "./http.js";
import type {
  RunRecord,
  RunSummary,
  RunOptions,
  Health,
  FileContent,
  RepoSource,
} from "../../shared/schemas.js";

/**
 * lib/api.ts — typed client for the LOCAL backend.
 *
 * The browser never sees API keys; /api/health returns only "configured"
 * booleans. In dev, Vite proxies /api to the backend. An unreachable backend
 * is reported as offline; cached run data is not evidence of a live connection.
 */

/**
 * One slice of a large evolution, as the epic runner records it.
 * Mirrors EpicSliceStateSchema in src/server/orchestrator/epicRunner.ts.
 */
export type EpicSliceSummary = {
  title: string;
  status: "pending" | "running" | "released" | "held" | "failed";
  runId: string | null;
  prUrl: string | null;
  detail: string | null;
};

export type EpicSummary = {
  id: string;
  idea: string;
  summary: string;
  status: "planning" | "running" | "paused" | "completed" | "failed";
  /** Why it paused or failed - always named, never silent. */
  statusReason: string | null;
  slices: EpicSliceSummary[];
  currentSlice: number;
  createdAt: number;
  updatedAt: number;
};

export type PortfolioSession = {
  id: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed";
  currentTarget: number;
  targets: Array<{
    id: string;
    name: string;
    repoSource: RepoSource;
    prompt: string;
    routeEvidence: "named" | "shared" | "single";
    status: "queued" | "running" | "completed" | "failed";
    runId: string | null;
    error: string | null;
  }>;
  steering: Array<{
    id: string;
    prompt: string;
    submittedAt: number;
    targetIds: string[];
  }>;
  createdAt: number;
  updatedAt: number;
};

export const api = {
  health: async (signal?: AbortSignal) => {
    const health = await jsonFetch<Health>("/api/health", { signal }, 5000);
    if ((health as { service?: unknown } | null)?.service !== "factory-deck") {
      throw new Error("The local service did not identify itself as Factory Deck.");
    }
    return health;
  },
  listRuns: () => jsonFetch<{ runs: RunSummary[] }>("/api/runs", undefined, 10_000),
  /**
   * Every large evolution the factory knows about.
   *
   * The UI could START an epic and never SHOW one: `createEpic` existed with
   * no listing counterpart, and the Runs view reads only `/api/runs`, which
   * holds a record per SLICE RUN. So an epic that is planning, paused, or
   * holding twelve pending slices was invisible - and the start toast's
   * promise that slices "appear in the runs list" was a promise the code did
   * not keep. `/api/epics` has always served this; nothing called it.
   */
  listEpics: () => jsonFetch<{ epics: EpicSummary[] }>("/api/epics", undefined, 10_000),
  getRun: (id: string, signal?: AbortSignal) =>
    jsonFetch<RunRecord>(`/api/runs/${id}`, { signal }, 10_000),
  getFiles: (id: string) =>
    jsonFetch<{ files: FileContent[] }>(`/api/runs/${id}/files`, undefined, 15_000),
  createRun: (idea: string, options: RunOptions) =>
    jsonFetch<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ idea, options }),
    }),
  createPortfolioSession: (
    prompt: string,
    targets: Array<{ name: string; repoSource: RepoSource }>,
  ) =>
    jsonFetch<PortfolioSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt, targets }),
    }),
  getPortfolioSession: (id: string) =>
    jsonFetch<PortfolioSession>(`/api/sessions/${id}`),
  steerPortfolioSession: (id: string, prompt: string) =>
    jsonFetch<{ ok: true; steeringId: string; targetIds: string[] }>(
      `/api/sessions/${id}/steer`,
      { method: "POST", body: JSON.stringify({ prompt }) },
    ),
  steerRun: (id: string, instruction: string) =>
    jsonFetch<{ ok: true; steeringId: string; status: "pending" }>(
      `/api/runs/${id}/steer`,
      { method: "POST", body: JSON.stringify({ instruction }) },
    ),
  /**
   * Start a large evolution. The server responds 202 with ONLY `epicId` and
   * plans in the background (planning alone can take minutes on the free
   * route), so there is no slice count to report yet — claiming one here
   * rendered "Planned into undefined slices."
   */
  createEpic: (idea: string, options: RunOptions) =>
    jsonFetch<{ epicId: string }>("/api/epics", {
      method: "POST",
      body: JSON.stringify({ idea, options }),
    }),
  cancelRun: (id: string) =>
    jsonFetch<{ ok: true }>(`/api/runs/${id}/cancel`, { method: "POST" }, 30_000),
  resumeRun: (id: string) =>
    jsonFetch<{ ok: true; runId: string }>(
      `/api/runs/${id}/resume`,
      { method: "POST" },
      30_000,
    ),
  /** Delete one stopped run: its history record AND its workspace folder. */
  deleteRun: (id: string) =>
    jsonFetch<{
      ok: true;
      runId: string;
      workspaceRemoved: boolean;
      workspaceNote: string;
    }>(`/api/runs/${id}`, { method: "DELETE" }),
  /** Delete every finished run in one action; in-flight runs are skipped. */
  deleteFinishedRuns: () =>
    jsonFetch<{
      ok: true;
      candidates: number;
      deleted: number;
      workspacesRemoved: number;
      skippedRunning: string[];
    }>("/api/runs/delete-finished", { method: "POST" }),
  /** Validate a new app/repo name and check GitHub for a collision. */
  checkRepoName: (name: string) =>
    jsonFetch<{
      valid: boolean;
      owner?: string;
      fullName?: string;
      availability: "exists" | "free" | "unknown";
      reason: string;
    }>("/api/repo/check-name", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  startClarify: (
    initialRequest: string,
    routingMode?: NonNullable<RunOptions["routingMode"]>,
  ) =>
    jsonFetch<{
      sessionId: string;
      confident: boolean;
      question: string | null;
      refinedGoals: string[];
    }>("/api/clarify/start", {
      method: "POST",
      body: JSON.stringify({ initialRequest, routingMode }),
    }),
  answerClarify: (sessionId: string, answer: "yes" | "no") =>
    jsonFetch<{
      sessionId: string;
      confident: boolean;
      question: string | null;
      refinedGoals: string[];
    }>(`/api/clarify/${sessionId}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    }),
};

/** True when a run has reached a terminal state (no more polling needed). */
export function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Poll a run record until it reaches a terminal state. */
export function useRunPolling(
  runId: string | null,
  intervalMs = 750,
): {
  run: RunRecord | null;
  error: string | null;
  refresh: () => void;
} {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    setError(null);
    setRun((current) => (current?.id === runId ? current : null));
    if (!runId) return;
    let active = true;
    let failures = 0;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const r = await api.getRun(runId, controller.signal);
        if (!active) return;
        setRun(r);
        setError(null);
        failures = 0;
        if (isTerminal(r.status)) return;
      } catch (e) {
        if (!active) return;
        failures++;
        setError(e instanceof Error ? e.message : "poll error");
      }
      timer.current = setTimeout(tick, failures ? retryDelay(failures) : intervalMs);
    };
    void tick();

    return () => {
      active = false;
      controller.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId, intervalMs, generation]);

  return { run, error, refresh };
}

/** Health is live evidence: clear it on failure and recover without a reload. */
export function useHealth(): { health: Health | null; loading: boolean } {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const h = await api.health(controller.signal);
        if (!active) return;
        setHealth(h);
        failures = 0;
      } catch {
        if (!active) return;
        // Never leave yesterday's green Connected/Live badges on a dead server.
        setHealth(null);
        failures++;
      }
      if (!active) return;
      setLoading(false);
      timer = setTimeout(poll, failures ? retryDelay(failures) : 5000);
    };

    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { health, loading };
}
