/** @vitest-environment happy-dom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, useHealth, useRunPolling } from "../lib/api.js";
import { jsonFetch, retryDelay } from "../lib/http.js";

const healthy = {
  service: "factory-deck",
  anthropicConfigured: true,
  openaiConfigured: true,
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

function hangUntilAborted(_url: RequestInfo | URL, init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("local service connection recovery", () => {
  it("clears stale online evidence and reconnects", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(healthy))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(async () => response(healthy));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useHealth());
    await act(async () => {});
    expect(result.current.health).toEqual(healthy);

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.health).toBeNull();
    expect(result.current.loading).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(result.current.health).toEqual(healthy);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("times out a hung health poll rather than keeping old green badges", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(healthy))
        .mockImplementation(hangUntilAborted),
    );
    const { result } = renderHook(() => useHealth());
    await act(async () => {});
    expect(result.current.health).toEqual(healthy);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.health).toBeNull();
  });

  it("does not label a different service as Factory Deck", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ service: "other-app" })),
    );
    const { result } = renderHook(() => useHealth());
    await act(async () => {});
    expect(result.current.health).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("backs off repeated refusals and caps the delay", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useHealth());
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(2999));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([1, 2, 3, 4, 5, 20].map((n) => retryDelay(n))).toEqual([
      1500, 3000, 6000, 12_000, 15_000, 15_000,
    ]);
  });

  it("aborts a pending health request and stops polling when unmounted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(hangUntilAborted);
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderHook(() => useHealth());
    const signal = fetchMock.mock.calls[0][1]?.signal;
    unmount();
    await act(async () => {});
    expect(signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries run polling after an outage without resubmitting the run", async () => {
    const run = { id: "run-1", status: "failed" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(response(run));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRunPolling("run-1"));
    await act(async () => {});
    expect(result.current.error).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(result.current.run).toEqual(run);
    expect(result.current.error).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});

describe("request deadlines", () => {
  it("bounds resume requests without replaying them", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(hangUntilAborted);
    vi.stubGlobal("fetch", fetchMock);
    const request = api.resumeRun("run-1");
    const assertion = expect(request).rejects.toThrow("may already have been accepted");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while reading the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal?.reason),
              );
            }),
        } as Response;
      }),
    );
    const request = jsonFetch("/api/health", undefined, 100);
    const assertion = expect(request).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("preserves HTTP errors and caller headers and clears the deadline", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: "Run is already active" }), {
            status: 409,
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      jsonFetch(
        "/api/runs/run-1/resume",
        { headers: { Authorization: "Bearer test" } },
        100,
      ),
    ).rejects.toThrow("Run is already active");
    const options = fetchMock.mock.calls[0][1];
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test");
    expect(options?.cache).toBe("no-store");
    expect(vi.getTimerCount()).toBe(0);
  });
});
