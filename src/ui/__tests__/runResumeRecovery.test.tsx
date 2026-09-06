/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "../App.js";
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
