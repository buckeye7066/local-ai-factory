import { useEffect, useRef, useState } from "react";
import type {
  RunRecord,
  RunSummary,
  RunOptions,
  Health,
  FileContent,
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

export const api = {
  health: () => jsonFetch<Health>("/api/health"),
  listRuns: () => jsonFetch<{ runs: RunSummary[] }>("/api/runs"),
  getRun: (id: string) => jsonFetch<RunRecord>(`/api/runs/${id}`),
  getFiles: (id: string) =>
    jsonFetch<{ files: FileContent[] }>(`/api/runs/${id}/files`),
  createRun: (idea: string, options: RunOptions) =>
    jsonFetch<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ idea, options }),
    }),
  cancelRun: (id: string) =>
    jsonFetch<{ ok: true }>(`/api/runs/${id}/cancel`, { method: "POST" }),
};

/** True when a run has reached a terminal state (no more polling needed). */
export function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Poll a run record until it reaches a terminal state. */
export function useRunPolling(
  runId: string | null,
  intervalMs = 750,
): { run: RunRecord | null; error: string | null } {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  }, [runId, intervalMs]);

  return { run, error };
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
