/** Bounded requests for local status/control calls; never retry a mutation. */
export async function jsonFetch<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 0,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  try {
    const res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    // Keep the deadline alive while consuming the body, not just the headers.
    return (await res.json()) as T;
  } catch (error) {
    if (timedOut) {
      const mutation = !["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase());
      throw new Error(
        `Factory Deck did not respond within ${timeoutMs / 1000} seconds.` +
          (mutation
            ? " The request may already have been accepted. Check the run status after reconnecting before retrying."
            : " Reopen the desktop launcher if the local service has stopped."),
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

/** Recover quickly once, then back off instead of flooding a stopped server. */
export function retryDelay(failures: number, initialMs = 1500): number {
  return Math.min(15_000, initialMs * 2 ** Math.min(Math.max(failures - 1, 0), 4));
}
