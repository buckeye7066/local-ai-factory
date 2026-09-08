/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "../App.js";
import { RunHistory } from "../components/history/RunHistory.js";
import type { RunSummary } from "../../shared/schemas.js";
import { api } from "../lib/api.js";
import type { RunRecord } from "../../shared/schemas.js";

const stoppedRun = {
  id: "run-1",
  appName: "futureu",
  idea: "Continue the existing curriculum work",
  status: "failed",
  resumable: true,
  codeProvider: "anthropic",
  reviewProvider: "anthropic",
  repairLoops: 0,
  stages: [{ id: "intake", status: "completed", durationMs: 1 }],
  logs: [],
  files: [],
  steering: [],
  workspacePath: null,
  finalReport: null,
} as unknown as RunRecord;

const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Resume request recovery", () => {
  it("releases the busy button even when the run stays failed", async () => {
    let finish!: (value: { ok: true; runId: string }) => void;
    vi.spyOn(api, "resumeRun").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = vi.fn();
    render(
      <RunDetail
        run={stoppedRun}
        files={[]}
        onNewRun={() => {}}
        refreshRun={refresh}
      />,
    );
    fireEvent.click(button("Resume"));
    expect(button("Resuming…").disabled).toBe(true);
    await act(async () => finish({ ok: true, runId: stoppedRun.id }));
    expect(button("Resume").disabled).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(api.resumeRun).toHaveBeenCalledTimes(1);
  });

  it("clears rejected requests and refreshes potentially stale status", async () => {
    vi.spyOn(api, "resumeRun").mockRejectedValue(new Error("Connection lost"));
    const refresh = vi.fn();
    render(
      <RunDetail
        run={stoppedRun}
        files={[]}
        onNewRun={() => {}}
        refreshRun={refresh}
      />,
    );
    await act(async () => {
      fireEvent.click(button("Resume"));
    });
    expect(button("Resume").disabled).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(api.resumeRun).toHaveBeenCalledTimes(1);
  });
});

describe("non-destructive cancellation of scheduled retries", () => {
  const retryRun = {
    ...stoppedRun,
    recovery: {
      stage: "release" as const,
      attempt: 1,
      nextAttemptAt: Date.now() + 30_000,
    },
  };
  it("offers Stop automatic retry in the detail view and calls cancel without deleting work", async () => {
    vi.spyOn(api, "cancelRun").mockResolvedValue({ ok: true });
    const deletion = vi.spyOn(api, "deleteRun");
    const refresh = vi.fn();
    render(
      <RunDetail run={retryRun} files={[]} onNewRun={() => {}} refreshRun={refresh} />,
    );
    expect(button("Resume")).toBeDefined();
    await act(async () => {
      fireEvent.click(button("Stop automatic retry"));
    });
    expect(api.cancelRun).toHaveBeenCalledWith(retryRun.id);
    expect(deletion).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("offers cancellation from history without opening or deleting the run", async () => {
    const cancel = vi.fn(),
      remove = vi.fn(),
      open = vi.fn();
    render(
      <RunHistory
        runs={[retryRun as unknown as RunSummary]}
        onOpen={open}
        onDelete={remove}
        onCancelRetry={cancel}
      />,
    );
    await act(async () => {
      fireEvent.click(button("Stop automatic retry: futureu"));
    });
    expect(cancel).toHaveBeenCalledWith(retryRun.id);
    expect(remove).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it("does not label a manual-only hold as a scheduled retry", () => {
    render(
      <RunDetail
        run={stoppedRun}
        files={[]}
        onNewRun={() => {}}
        refreshRun={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stop automatic retry" })).toBeNull();
    expect(button("Resume")).toBeDefined();
  });
});
