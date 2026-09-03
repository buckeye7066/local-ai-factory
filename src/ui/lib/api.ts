import { useEffect, useRef, useState } from "react";
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
 * booleans. In dev, Vite proxies /api to the backend. If the backend is not
 * running (pure UI preview), calls fail gracefully and the app falls back to
 * the built-in client-side demo simulator.
 */

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

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
  health: () => jsonFetch<Health>("/api/health"),
  listRuns: () => jsonFetch<{ runs: RunSummary[] }>("/api/runs"),
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
  listEpics: () => jsonFetch<{ epics: EpicSummary[] }>("/api/epics"),
  getRun: (id: string) => jsonFetch<RunRecord>(`/api/runs/${id}`),
  getFiles: (id: string) =>
    jsonFetch<{ files: FileContent[] }>(`/api/runs/${id}/files`),
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
    jsonFetch<{ ok: true }>(`/api/runs/${id}/cancel`, { method: "POST" }),
  resumeRun: (id: string) =>
    jsonFetch<{ ok: true; runId: string }>(`/api/runs/${id}/resume`, {
      method: "POST",
    }),
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

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    let active = true;

    const tick = async () => {
      try {
        const r = await api.getRun(runId);
        if (!active) return;
        setRun(r);
        setError(null);
        if (isTerminal(r.status)) return;
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "poll error");
      }
      timer.current = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId, intervalMs, generation]);

  return { run, error, refresh: () => setGeneration((value) => value + 1) };
}

/**
 * Health fetch that survives a cold backend.
 *
 * The desktop launcher opens the browser on a fixed timer while the backend
 * (tsx watch) may still be booting, so a single fetch on mount can race the
 * server and fail — leaving the UI to wrongly report "missing API keys" until
 * a manual refresh. To avoid that false negative we retry on failure until the
 * first success, then keep a slow poll so the badges stay accurate if the
 * backend restarts (watch reload) or keys change.
 */
export function useHealth(): { health: Health | null; loading: boolean } {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      api
        .health()
        .then((h) => {
          if (!active) return;
          setHealth(h);
          setLoading(false);
          // Healthy: slow steady poll to stay fresh.
          timer = setTimeout(poll, 15000);
        })
        .catch(() => {
          if (!active) return;
          setLoading(false);
          // Backend not up yet (or went away): retry quickly until it answers.
          timer = setTimeout(poll, 1500);
        });
    };

    poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { health, loading };
}
