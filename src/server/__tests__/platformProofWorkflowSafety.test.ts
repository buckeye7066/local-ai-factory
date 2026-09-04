import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const factory = readFileSync(".github/workflows/factory-deck-cloud.yml", "utf8");
const foundry = readFileSync(".github/workflows/purpose-foundry-cloud.yml", "utf8");
const windowsRunner = readFileSync(
  "scripts/ci/run-windows-platform-proof.ps1",
  "utf8",
);
const macRunner = readFileSync("scripts/ci/run-macos-platform-proof.sh", "utf8");

describe("cross-platform proof workflow safety", () => {
  it("keeps Windows proof credentials inside one trusted step", () => {
    expect(windowsRunner).toContain("New-LocalUser");
    expect(windowsRunner).toContain("FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD");
    expect(windowsRunner).toContain("Remove-LocalUser");
    expect(windowsRunner).not.toContain("GITHUB_OUTPUT");
    expect(windowsRunner).not.toMatch(/password\s*=.*GITHUB_OUTPUT/i);

    for (const workflow of [factory, foundry]) {
      expect(workflow).toContain("run-windows-platform-proof.ps1");
      expect(workflow).not.toContain("steps.proof_sandbox.outputs.password");
      expect(workflow).not.toContain("proof_sandbox.outputs.password");
    }
  });

  it("runs macOS proof as a dedicated restricted account", () => {
    expect(macRunner).toContain('proof_user="factoryproof"');
    expect(macRunner).toContain("sudo dscl . -create");
    expect(macRunner).toContain("FACTORY_PLATFORM_PROOF_USER");
    expect(macRunner).toContain("FACTORY_PLATFORM_PROOF_STATE_ROOT");
    expect(macRunner).toContain("factory-platform-proof.ts record");
    for (const workflow of [factory, foundry]) {
      expect(workflow).toContain("run-macos-platform-proof.sh");
    }
  });

  it("moves one immutable Linux candidate through both host proofs", () => {
    expect(factory).toContain("factory-deck-workspaces.tar");
    expect(foundry).toContain("purpose-foundry-workspaces.tar");
    for (const workflow of [factory, foundry]) {
      expect(workflow).toContain("Pack immutable candidate with POSIX metadata");
      expect(workflow).toContain("Materialize immutable candidate");
      expect(workflow).toContain("platform-evidence/**");
      expect(workflow).toContain("Restore Windows checkpoint evidence");
      expect(workflow).toContain("Restore macOS checkpoint evidence");
    }
  });

  it("does not pass generated workspaces forward as host evidence", () => {
    const factoryWindows = factory.slice(
      factory.indexOf("Preserve Windows evidence"),
      factory.indexOf("  macos:"),
    );
    const factoryMac = factory.slice(
      factory.indexOf("Preserve macOS evidence"),
      factory.indexOf("  build:"),
    );
    const foundryWindows = foundry.slice(
      foundry.indexOf("Preserve Windows evidence"),
      foundry.indexOf("  macos:"),
    );
    const foundryMac = foundry.slice(
      foundry.indexOf("Preserve macOS evidence"),
      foundry.indexOf("  verify:"),
    );
    for (const section of [
      factoryWindows,
      factoryMac,
      foundryWindows,
      foundryMac,
    ]) {
      expect(section).toContain("platform-evidence/**");
      expect(section).not.toContain("workspaces/**");
    }
  });
});
