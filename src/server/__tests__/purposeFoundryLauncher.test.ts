import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function script(name: string) {
  return readFile(new URL(`../../../scripts/${name}`, import.meta.url), "utf8");
}

describe("Purpose Foundry desktop launcher", () => {
  it("creates a verified shortcut on the real redirected desktop", async () => {
    const installer = await script("Install-Purpose-Foundry-Icon.ps1");
    expect(installer).toContain('SpecialFolders.Item("Desktop")');
    expect(installer).toContain('"Purpose Foundry.lnk"');
    expect(installer).toContain('"scripts\\start-purpose-foundry.cmd"');
    expect(installer).toContain('"assets\\purpose-foundry.ico"');
    expect(installer).toContain("start-purpose-foundry.cmd*");
    expect(installer).not.toMatch(/C:\\Users\\[^$]/i);
  });

  it("repairs the Foundry shortcut whenever Factory Deck starts", async () => {
    const factory = await script("start-factory.cmd");
    const installerAt = factory.indexOf("Install-Purpose-Foundry-Icon.ps1");
    const launcherAt = factory.indexOf("start-factory.ps1");
    expect(installerAt).toBeGreaterThan(0);
    expect(launcherAt).toBeGreaterThan(installerAt);
    expect(factory).toContain("-Quiet");
    const repairCommand = factory
      .split(/\r?\n/)
      .find((line) => line.includes("Install-Purpose-Foundry-Icon.ps1"));
    expect(repairCommand).not.toContain("-ExecutionPolicy Bypass");
  });

  it("opens Foundry mode and preserves errors without bypassing policy", async () => {
    const foundry = await script("start-purpose-foundry.cmd");
    expect(foundry).toContain("Install-Purpose-Foundry-Icon.ps1");
    expect(foundry).toContain("FACTORY_START_PATH=?mode=foundry");
    expect(foundry).toContain("start-factory.ps1");
    expect(foundry).not.toContain("-ExecutionPolicy Bypass");
    expect(foundry).toContain('set "FOUNDRY_EXIT=%ERRORLEVEL%"');
    expect(foundry).toContain("Purpose Foundry could not start.");
    expect(foundry).toContain("pause >nul");
    expect(foundry).toContain("exit /b %FOUNDRY_EXIT%");
  });

  it("package icon installers preserve restrictive PowerShell policies", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["install:desktop-icon"]).not.toContain(
      "-ExecutionPolicy Bypass",
    );
    expect(pkg.scripts["install:purpose-foundry-icon"]).not.toContain(
      "-ExecutionPolicy Bypass",
    );
  });

  it("the standard desktop installer creates both independent icons", async () => {
    const installer = await script("Install-Desktop-Icon.ps1");
    expect(installer).toContain('"Factory Deck.lnk"');
    expect(installer).toContain("Install-Purpose-Foundry-Icon.ps1");
    expect(installer).toContain("& $foundryInstaller");
  });
});
