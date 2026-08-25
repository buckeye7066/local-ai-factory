/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SafetySettingsPreview } from "./SafetySettingsPreview.js";
import type { Health } from "../../../shared/schemas.js";

/**
 * "Command mode: Live" was a CONSTANT, not a fact.
 *
 * `commandRunner`'s SCRIPT GATE refuses EVERY allowlisted command — installs,
 * builds and tests alike — unless `allowScriptExecution` is on, and
 * `config.ts` defaults `ALLOW_UNTRUSTED_SCRIPTS` to **false**. So on a default
 * install nothing a run writes can be executed, while this strip told the
 * owner "Allowlisted commands actually run inside the workspace — every run is
 * real work". The server has always reported the answer
 * (`health.allowUntrustedScripts`); the UI simply ignored it.
 *
 * Three states, because the field is optional on the wire: enabled, disabled,
 * and NOT REPORTED — which is rendered as unknown rather than guessed either
 * way.
 */
const baseHealth: Health = {
  ok: true,
  controlPlaneOk: true,
  mockConfigured: true,
  freeConfigured: true,
  freeBaseUrl: "http://127.0.0.1:8082",
  freeModel: "free-model",
  anthropicConfigured: false,
  openaiConfigured: false,
  providersAvailable: ["free"],
  anthropicModel: "claude",
  openaiModel: "gpt",
  defaultCodeProvider: "free",
  defaultReviewProvider: "free",
  maxRepairLoops: 3,
  maxModelCallsPerRun: 30,
  runTimeoutMs: 1000,
  workspaceRoot: "/workspaces",
  allowUntrustedScripts: false,
};

afterEach(() => cleanup());

describe("the Command mode claim tracks the real script gate", () => {
  it("does NOT claim commands run when the script gate is off", () => {
    render(<SafetySettingsPreview health={baseHealth} />);
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("claims Live only when execution is actually enabled", () => {
    render(
      <SafetySettingsPreview health={{ ...baseHealth, allowUntrustedScripts: true }} />,
    );
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.queryByText("Blocked")).toBeNull();
  });

  it("says nothing either way when the server did not report the gate", () => {
    const { allowUntrustedScripts: _omitted, ...withoutGate } = baseHealth;
    render(<SafetySettingsPreview health={withoutGate as Health} />);
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByText("Blocked")).toBeNull();
  });

  it("renders nothing claim-like before the health report arrives", () => {
    render(<SafetySettingsPreview health={null} />);
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByText("Blocked")).toBeNull();
  });
});
