/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewRunHero } from "./NewRunHero.js";
import { api } from "../../lib/api.js";
import type { Health } from "../../../shared/schemas.js";

vi.mock("../../lib/api.js", () => ({
  api: {
    checkRepoName: vi.fn(),
    startClarify: vi.fn(),
  },
}));

const health: Health = {
  ok: true,
  controlPlaneOk: true,
  mockConfigured: true,
  freeConfigured: true,
  freeBaseUrl: "http://127.0.0.1:8082",
  freeModel: "free-model",
  anthropicConfigured: false,
  openaiConfigured: true,
  providersAvailable: ["free", "openai"],
  anthropicModel: "claude",
  openaiModel: "gpt",
  defaultCodeProvider: "free",
  defaultReviewProvider: "free",
  maxRepairLoops: 3,
  maxModelCallsPerRun: 30,
  runTimeoutMs: 1_000,
  workspaceRoot: "/workspaces",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("provider tier UI wiring", () => {
  it.each(["free", "paid"] as const)(
    "sends the selected %s tier when clarification starts",
    async (routingMode) => {
      vi.mocked(api.startClarify).mockResolvedValue({
        sessionId: "session-1",
        confident: true,
        question: null,
        refinedGoals: ["Keep the selected tier"],
      });
      render(<NewRunHero health={health} starting={false} onStart={vi.fn()} />);

      if (routingMode === "paid") {
        fireEvent.click(screen.getByRole("button", { name: /Paid rotation/i }));
      }
      fireEvent.click(
        screen.getByRole("button", { name: /Extend an Existing Program/i }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Ask Me Yes\/No Questions/i }),
      );
      fireEvent.change(
        screen.getByLabelText(/Describe what you want at a high level/i),
        { target: { value: "Clarify this existing app" } },
      );
      fireEvent.click(screen.getByRole("button", { name: /Start Clarifying/i }));

      await waitFor(() =>
        expect(api.startClarify).toHaveBeenCalledWith(
          "Clarify this existing app",
          routingMode,
        ),
      );
    },
  );
});
