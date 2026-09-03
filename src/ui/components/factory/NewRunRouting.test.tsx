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
  anthropicConfigured: true,
  openaiConfigured: true,
  mandatoryProductionReadiness: true,
  readinessBrainFloorConfigured: true,
  readinessPaidProviders: ["anthropic", "openai"],
  solConfigured: true,
  fableOrOpusConfigured: true,
  solModel: "gpt",
  fableOrOpusModel: "claude",
  ownerExternalMatters: "owner-managed-outside-cyberland",
  providersAvailable: ["free", "anthropic", "openai"],
  modelLadder: ["anthropic", "openai", "free"],
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

describe("automatic model ladder UI wiring", () => {
  it("warns when the mandatory brain floor is missing despite a live free rung", () => {
    render(
      <NewRunHero
        health={{
          ...health,
          anthropicConfigured: false,
          openaiConfigured: false,
          readinessBrainFloorConfigured: false,
          solConfigured: false,
          fableOrOpusConfigured: false,
          modelLadder: ["free"],
          providersAvailable: ["free"],
        }}
        starting={false}
        onStart={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/Production admission requires a configured paid rung/i),
    ).toBeNull();
  });

  it("shows one ordered ladder and sends only automatic routing", async () => {
    vi.mocked(api.startClarify).mockResolvedValue({
      sessionId: "session-1",
      confident: true,
      question: null,
      refinedGoals: ["Keep the unified route"],
    });
    render(<NewRunHero health={health} starting={false} onStart={vi.fn()} />);

    expect(screen.getByLabelText("Automatic model ladder").textContent).toMatch(
      /Anthropic.*OpenAI.*Free \/ local/s,
    );
    expect(screen.queryByRole("button", { name: /Paid rotation/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Free$/i })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Extend an Existing Program/i }));
    fireEvent.click(screen.getByRole("tab", { name: /Ask Me Yes\/No Questions/i }));
    fireEvent.change(screen.getByLabelText(/Describe what you want at a high level/i), {
      target: { value: "Clarify this existing app" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Start Clarifying/i }));

    await waitFor(() =>
      expect(api.startClarify).toHaveBeenCalledWith(
        "Clarify this existing app",
        "auto",
      ),
    );
  });
});
