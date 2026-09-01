import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FATAL_EXIT_CODE } from "../exitCodes.js";

/**
 * The launcher supervisor must never become a respawn loop.
 *
 * scripts/start-factory.ps1 relaunches the backend when it dies. That is only
 * correct for a TRANSIENT death. A child that dies instantly for a permanent
 * reason — a refused LAN bind, a port held by a foreign service, a crash at
 * import — used to be retried on a flat 5s timer, which is the "console window
 * that keeps reappearing" failure class.
 *
 * The decision was extracted into Get-RestartDecision so it can be tested
 * WITHOUT launching the app. These tests drive the real PowerShell function.
 */

const policyPath = resolve(process.cwd(), "scripts", "lib", "RestartPolicy.ps1");
const launcherPath = resolve(process.cwd(), "scripts", "start-factory.ps1");
const commandLauncherPath = resolve(process.cwd(), "scripts", "start-factory.cmd");

/** Windows PowerShell is what the .cmd launcher actually runs. */
function powershellAvailable(): boolean {
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", "exit 0"], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

interface Decision {
  Restart: boolean;
  DelayMs: number;
  Reason: string;
  Fatal: boolean;
}

function decide(args: {
  exitCode: number;
  attempt: number;
  maxAttempts?: number;
  ranForSeconds: number;
  consecutiveFastFailures?: number;
}): Decision {
  const script =
    `. '${policyPath}'; ` +
    `Get-RestartDecision -ExitCode ${args.exitCode} -Attempt ${args.attempt} ` +
    `-MaxAttempts ${args.maxAttempts ?? 5} -RanForSeconds ${args.ranForSeconds} ` +
    `-ConsecutiveFastFailures ${args.consecutiveFastFailures ?? 0} ` +
    `| ConvertTo-Json -Compress`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(out.trim()) as Decision;
}

const hasPowershell = powershellAvailable();

describe("launcher supervisor — the respawn-loop guard", () => {
  it.skipIf(!hasPowershell)("never restarts a clean exit (the user closed it)", () => {
    const d = decide({ exitCode: 0, attempt: 1, ranForSeconds: 900 });
    expect(d.Restart).toBe(false);
    expect(d.Fatal).toBe(false);
  });

  it.skipIf(!hasPowershell)(
    "never restarts a FATAL exit, even on the very first attempt",
    () => {
      // A refused LAN bind / foreign process on the port. Retrying this is
      // exactly what produced a window that died and reopened on a timer.
      const d = decide({
        exitCode: FATAL_EXIT_CODE,
        attempt: 1,
        ranForSeconds: 0.2,
      });
      expect(d.Restart).toBe(false);
      expect(d.Fatal).toBe(true);
      expect(d.Reason).toMatch(/permanent/i);
    },
  );

  it.skipIf(!hasPowershell)(
    "stops after two INSTANT deaths — a startup crash is not retried forever",
    () => {
      // One instant death may be bad luck; two in a row is a crash at import.
      const first = decide({
        exitCode: 1,
        attempt: 1,
        ranForSeconds: 0.3,
        consecutiveFastFailures: 1,
      });
      expect(first.Restart).toBe(true);

      const second = decide({
        exitCode: 1,
        attempt: 2,
        ranForSeconds: 0.3,
        consecutiveFastFailures: 2,
      });
      expect(second.Restart).toBe(false);
      expect(second.Fatal).toBe(true);
      expect(second.Reason).toMatch(/startup crash/i);
    },
  );

  it.skipIf(!hasPowershell)("does restart a genuine transient crash", () => {
    // Ran for 10 minutes, then died — restarting is the right call.
    const d = decide({ exitCode: 1, attempt: 1, ranForSeconds: 600 });
    expect(d.Restart).toBe(true);
    expect(d.Fatal).toBe(false);
  });

  it.skipIf(!hasPowershell)("backs off exponentially, and caps the delay", () => {
    const delays = [1, 2, 3, 4].map(
      (attempt) =>
        decide({ exitCode: 1, attempt, maxAttempts: 99, ranForSeconds: 600 }).DelayMs,
    );
    // Strictly increasing — never a flat timer that can spin.
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    expect(delays[0]).toBeGreaterThanOrEqual(2000);

    const capped = decide({
      exitCode: 1,
      attempt: 20,
      maxAttempts: 99,
      ranForSeconds: 600,
    });
    expect(capped.DelayMs).toBeLessThanOrEqual(30_000);
  });

  it.skipIf(!hasPowershell)("honours the attempt budget", () => {
    const d = decide({
      exitCode: 1,
      attempt: 5,
      maxAttempts: 5,
      ranForSeconds: 600,
    });
    expect(d.Restart).toBe(false);
    expect(d.Reason).toMatch(/gave up/i);
  });
});

describe("launcher wiring — the guard is actually used", () => {
  it("the policy library exists and the launcher dot-sources it", () => {
    expect(existsSync(policyPath)).toBe(true);
    const launcher = readFileSync(launcherPath, "utf8");
    expect(launcher).toContain("RestartPolicy.ps1");
    expect(launcher).toContain("Get-RestartDecision");
    // The old unconditional flat-timer retry must be gone: a bare
    // `Start-Sleep -Seconds 5` in the supervisor is the thing being replaced.
    expect(launcher).not.toMatch(
      /if \(\$attempt -lt \$maxAttempts\) \{ Start-Sleep -Seconds 5 \}/,
    );
  });

  it("the PowerShell fatal code matches the server's FATAL_EXIT_CODE", () => {
    // A drifting constant would silently turn the fatal guard back into a
    // retry loop, so the two definitions are pinned to each other.
    const policy = readFileSync(policyPath, "utf8");
    expect(policy).toContain(`$script:FactoryFatalExitCode = ${FATAL_EXIT_CODE}`);
  });

  it("the launcher scripts are ASCII-only (PS 5.1 reads no-BOM as CP1252)", () => {
    for (const p of [policyPath, launcherPath]) {
      const bytes = readFileSync(p);
      const nonAscii = [...bytes].filter((b) => b > 127);
      expect(nonAscii, `${p} must stay ASCII-only`).toHaveLength(0);
    }
  });
});
