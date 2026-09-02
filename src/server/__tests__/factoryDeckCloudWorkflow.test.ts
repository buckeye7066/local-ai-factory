import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const factory = readFileSync(
  resolve(".github/workflows/factory-deck-cloud.yml"),
  "utf8",
);
const foundry = readFileSync(
  resolve(".github/workflows/purpose-foundry-cloud.yml"),
  "utf8",
);
const production = readFileSync(
  resolve(".github/workflows/production-readiness.yml"),
  "utf8",
);
const dockerfile = readFileSync(
  resolve("scripts/ci/verification-sandbox.Dockerfile"),
  "utf8",
);
const foundrySmoke = readFileSync(
  resolve("scripts/ci/run-purpose-foundry-smoke.mjs"),
  "utf8",
);
const commandRunner = readFileSync(
  resolve("src/server/workspace/commandRunner.ts"),
  "utf8",
);
const platformEvidenceRunner = readFileSync(
  resolve("src/server/workspace/platformEvidenceRunner.ts"),
  "utf8",
);
const windowsProofLauncher = readFileSync(
  resolve("scripts/ci/windows-proof-launcher.ps1"),
  "utf8",
);

describe("paid cloud workflow contract", () => {
  it("pins the current strongest Anthropic model for paid production", () => {
    for (const workflow of [factory, foundry]) {
      expect(workflow).toContain("ANTHROPIC_MODEL: claude-fable-5-1");
      expect(workflow).toContain("FACTORY_FABLE_OR_OPUS_MODEL: claude-fable-5-1");
      expect(workflow).not.toContain("claude-opus-4-8");
    }
  });

  it.each([
    ["Factory Deck", factory],
    ["Purpose Foundry", foundry],
  ])(
    "%s runs current main without checkout credentials or cancellation",
    (_name, workflow) => {
      expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
      expect(workflow).not.toMatch(/^\s+paths:/m);
      expect(workflow).toContain("persist-credentials: false");
      expect(workflow).not.toMatch(/^concurrency:/m);
      expect(workflow).toContain("timeout-minutes: 360");
      expect(workflow).toContain("if: always()");
    },
  );

  it.each([
    ["Factory Deck", factory, "factory-deck-workspaces.tar"],
    ["Purpose Foundry", foundry, "purpose-foundry-workspaces.tar"],
  ])(
    "%s transports one immutable POSIX-metadata candidate across every host",
    (_name, workflow, archive) => {
      const packIndex = workflow.indexOf(`tar --create --file ${archive}`);
      const firstUploadIndex = workflow.indexOf("uses: actions/upload-artifact@");
      expect(packIndex).toBeGreaterThan(0);
      expect(firstUploadIndex).toBeGreaterThan(packIndex);
      expect(
        workflow.match(new RegExp(archive.replace(".", "\\."), "g")),
      ).not.toBeNull();
      expect(workflow.match(/tar --extract --file/g)).toHaveLength(3);
      expect(workflow).not.toContain("--exclude='*/coverage/*'");
      expect(workflow).not.toContain("!workspaces/**/coverage/**");
      for (const excluded of [
        "node_modules",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".hypothesis",
        ".tox",
        ".nox",
        ".nyc_output",
      ]) {
        expect(workflow).toContain(`--exclude='*/${excluded}'`);
        expect(workflow).toContain(`--exclude='*/${excluded}/*'`);
      }
      for (const excluded of ["*/.coverage", "*/.coverage.*", "*.pyc", "*.pyo"]) {
        expect(workflow).toContain(`--exclude='${excluded}'`);
      }

      for (const [start, end] of [
        ["Preserve Windows evidence", "macos:"],
        ["Preserve macOS evidence", _name === "Factory Deck" ? "build:" : "verify:"],
      ]) {
        const upload = workflow.slice(workflow.indexOf(start), workflow.indexOf(end));
        expect(upload).not.toContain(archive);
        expect(upload).toContain("platform-evidence/**");
        expect(upload).not.toContain("workspaces/**");
      }

      expect(
        workflow.match(
          /Copy-Item -Path \.factory -Destination platform-evidence\/\.factory/g,
        ),
      ).toHaveLength(2);

      const macRestore = workflow.slice(
        workflow.indexOf(
          "Restore immutable seed candidate",
          workflow.indexOf("macos:"),
        ),
        workflow.indexOf("Materialize immutable candidate", workflow.indexOf("macos:")),
      );
      expect(macRestore).toContain(
        `${_name === "Factory Deck" ? "factory-deck" : "purpose-foundry"}-seed-`,
      );
      expect(macRestore).toContain(
        `${_name === "Factory Deck" ? "factory-deck" : "purpose-foundry"}-windows-`,
      );
    },
  );

  it("does not cancel or credential production-readiness checkouts", () => {
    expect(production).toContain(
      "group: production-readiness-${{ github.event_name }}-${{ github.ref }}",
    );
    expect(production).toContain("cancel-in-progress: false");
    expect(production).toContain("persist-credentials: false");
    expect(production).toContain("timeout-minutes: 60");
    expect(production).toContain("pnpm typecheck");
    expect(production).toContain("pnpm test");
    expect(production).toContain("pnpm release:check");
  });

  it.each([
    ["Factory Deck", factory],
    ["Purpose Foundry", foundry],
  ])(
    "%s builds the sandbox before production secrets are exposed",
    (_name, workflow) => {
      const buildIndex = workflow.indexOf("docker build --pull");
      const firstSecretIndex = workflow.indexOf("ANTHROPIC_API_KEY:");
      expect(buildIndex).toBeGreaterThan(0);
      expect(firstSecretIndex).toBeGreaterThan(buildIndex);
      expect(workflow).toContain("--file scripts/ci/verification-sandbox.Dockerfile");
      expect(workflow).toContain(
        'FACTORY_VERIFICATION_SANDBOX_IMAGE: "local-ai-factory-verifier:${{ github.sha }}"',
      );
      expect(workflow).toContain(
        'FACTORY_VERIFICATION_SANDBOX_STATE_ROOT: "${{ runner.temp }}/factory-verification-${{ github.run_id }}-${{ github.run_attempt }}"',
      );
      expect(workflow).toContain('ALLOW_UNTRUSTED_SCRIPTS: "true"');
      expect(workflow).toContain('FACTORY_RUN_TIMEOUT_MS: "19200000"');
      expect(workflow).not.toContain("21000000");
    },
  );

  it.each([
    ["Factory Deck", factory, "factory-deck-cloud/exact-main-proof"],
    ["Purpose Foundry", foundry, "purpose-foundry-cloud/exact-main-proof"],
  ])(
    "%s publishes a durable status for the exact main SHA",
    (_name, workflow, context) => {
      expect(workflow).toContain("statuses: write");
      expect(workflow).toContain(`PROOF_CONTEXT: ${context}`);
      expect(workflow).toContain("statuses/${process.env.GITHUB_SHA}");
      expect(workflow).toContain("PROOF_TARGET_URL:");
      expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    },
  );

  it("keeps option-like Factory prompts out of positional CLI parsing", () => {
    expect(factory).toContain("FACTORY_IDEA:");
    expect(factory).toContain('FACTORY_PROJECT_ID: "factory-deck-cloud-proof"');
    expect(factory).toContain("run: pnpm exec tsx src/cli/factory.ts");
    expect(factory).not.toContain(
      'run: pnpm exec tsx src/cli/factory.ts "$env:FACTORY_IDEA"',
    );
  });

  it("uses the same credential fallbacks in validation and paid execution", () => {
    expect(
      factory.match(
        /secrets\.PAID_PRODUCTION_ANTHROPIC_KEY \|\| secrets\.ANTHROPIC_API_KEY/g,
      ),
    ).toHaveLength(3);
    expect(
      factory.match(
        /secrets\.PAID_PRODUCTION_OPENAI_KEY \|\| secrets\.OPENAI_API_KEY/g,
      ),
    ).toHaveLength(3);
    expect(
      foundry.match(
        /secrets\.PAID_PRODUCTION_ANTHROPIC_KEY \|\| secrets\.ANTHROPIC_API_KEY/g,
      ),
    ).toHaveLength(2);
    expect(
      foundry.match(
        /secrets\.PAID_PRODUCTION_OPENAI_KEY \|\| secrets\.OPENAI_API_KEY/g,
      ),
    ).toHaveLength(2);
  });

  it("keeps Purpose Foundry's real paid end-to-end smoke and upload reserve", () => {
    expect(foundry).toContain('PURPOSE_FOUNDRY_FACTORY_TIMEOUT_MS: "19200000"');
    expect(foundry).toContain('PURPOSE_FOUNDRY_SMOKE_TIMEOUT_MS: "19200000"');
    expect(foundry).toContain("node scripts/ci/run-purpose-foundry-smoke.mjs");
    expect(foundry).toContain("purpose-foundry-server.log");
    expect(foundry).toContain(".factory/**");
    expect(foundry).toContain("workspaces/**");
  });

  it("uses greenfield proofs whose tests can be independently executed", () => {
    expect(factory).toContain("command-line only with no HTML, browser, or web UI");
    expect(foundrySmoke).toContain(
      "Command-line only; do not generate HTML, browser, or web UI code.",
    );
    expect(foundrySmoke).toContain(
      "Tasks persist in a local JSON file across separate CLI invocations.",
    );
    expect(factory).not.toContain("accessible single-page task checklist");
    expect(foundrySmoke).not.toContain("minimal accessible task checklist");
  });

  it("proves one exact CLI candidate on Windows and macOS before paid finalization", () => {
    expect(factory).toContain("runs-on: windows-latest");
    expect(factory).toContain("runs-on: macos-latest");
    expect(factory).toContain("needs: [seed, windows]");
    expect(factory).toContain("needs: [seed, windows, macos]");
    expect(factory).toContain(
      "pnpm exec tsx src/cli/factory-platform-proof.ts validate",
    );
    expect(
      factory.match(/pnpm exec tsx src\/cli\/factory-platform-proof\.ts record/g),
    ).toHaveLength(2);
    expect(factory).toContain("pnpm exec tsx src/cli/factory-resume.ts");
    expect(factory).toContain("continue-on-error: true");
    expect(factory).toContain("${{ steps.candidate.outcome }}");
    expect(factory).toContain("factory-deck-seed-${{ github.run_id }}");
    expect(factory).toContain("factory-deck-windows-${{ github.run_id }}");
    expect(factory).toContain("factory-deck-macos-${{ github.run_id }}");
    expect(factory).toContain("!workspaces/**/node_modules/**");

    const windowsProof = factory.slice(
      factory.indexOf("Execute Windows proof without production secrets"),
      factory.indexOf("Preserve Windows evidence"),
    );
    const macosProof = factory.slice(
      factory.indexOf("Execute macOS proof without production secrets"),
      factory.indexOf("Preserve macOS evidence"),
    );
    expect(windowsProof).not.toContain("API_KEY");
    expect(macosProof).not.toContain("API_KEY");
    expect(windowsProof).toContain("FACTORY_PLATFORM_SANDBOX_ROOT:");
    expect(macosProof).toContain("FACTORY_PLATFORM_SANDBOX_ROOT:");
  });

  it.each([
    ["Factory Deck", factory, "factory-deck-workspaces.tar"],
    ["Purpose Foundry", foundry, "purpose-foundry-workspaces.tar"],
  ])(
    "%s gives native proof commands only isolated low-privilege writable roots",
    (_name, workflow, archive) => {
      const windowsIsolation = workflow.slice(
        workflow.indexOf("Isolate untrusted Windows proof"),
        workflow.indexOf("Preserve Windows evidence"),
      );
      const macIsolation = workflow.slice(
        workflow.indexOf("Isolate untrusted macOS proof"),
        workflow.indexOf("Preserve macOS evidence"),
      );
      expect(windowsIsolation).toContain("New-LocalUser -Name $proofUser");
      expect(windowsIsolation).toContain("$env:GITHUB_WORKSPACE");
      expect(windowsIsolation).toContain("$env:RUNNER_TEMP");
      expect(windowsIsolation).toContain("/deny $writeDeny /T /Q");
      expect(windowsIsolation).toContain(
        '$env:PNPM_HOME /grant:r "${proofUser}:(OI)(CI)RX"',
      );
      expect(windowsIsolation).toContain(
        '& icacls.exe ".factory" /deny "${proofUser}:(OI)(CI)F"',
      );
      expect(windowsIsolation).toContain(
        `& icacls.exe "${archive}" /deny "\${proofUser}:F"`,
      );
      expect(windowsIsolation).toContain("FACTORY_PLATFORM_PROOF_USER:");
      expect(windowsIsolation).toContain("FACTORY_PLATFORM_PROOF_STATE_ROOT:");
      expect(windowsIsolation).toContain("FACTORY_PLATFORM_PROOF_WINDOWS_LAUNCHER:");
      expect(windowsIsolation).toContain("FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD:");

      expect(macIsolation).toContain('proof_user="factoryproof"');
      expect(macIsolation).toContain("PrimaryGroupID");
      expect(macIsolation).toContain(
        'sudo chmod -R go-w "${HOME}" "${GITHUB_WORKSPACE}" "${RUNNER_TEMP}"',
      );
      expect(macIsolation).toContain('chmod -R go+rX "${PNPM_HOME}"');
      expect(macIsolation).toContain("chmod -R go-rwx .factory");
      expect(macIsolation).toContain(`chmod go-rwx ${archive}`);
      expect(macIsolation).toContain("FACTORY_PLATFORM_PROOF_USER:");
      expect(macIsolation).toContain("FACTORY_PLATFORM_PROOF_STATE_ROOT:");
    },
  );

  it("requires and reaps the restricted native proof account", () => {
    expect(platformEvidenceRunner).toContain("requireHostSandbox: true");
    expect(platformEvidenceRunner).toContain(
      'groupWritable: hostPlatform === "darwin"',
    );
    expect(commandRunner).toContain("hostVerificationSandboxConfig");
    expect(commandRunner).toContain("killHostSandboxProcesses");
    expect(commandRunner).toContain('resolvePmBinary("taskkill"');
    expect(commandRunner).toContain('resolvePmBinary("pkill"');
    expect(windowsProofLauncher).toContain("$psi.Environment.Clear()");
    expect(windowsProofLauncher).toContain("$psi.UserName =");
    expect(windowsProofLauncher).toContain("$psi.Password =");
    expect(windowsProofLauncher).toContain(
      "Remove-Item Env:FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD",
    );
  });

  it("resumes the same Purpose Foundry candidate after secret-free Windows and macOS proof", () => {
    expect(foundry).toContain("runs-on: windows-latest");
    expect(foundry).toContain("runs-on: macos-latest");
    expect(foundry).toContain("needs: [seed, windows]");
    expect(foundry).toContain("needs: [seed, windows, macos]");
    expect(foundry).toContain(
      "pnpm exec tsx src/cli/factory-platform-proof.ts validate",
    );
    expect(
      foundry.match(/pnpm exec tsx src\/cli\/factory-platform-proof\.ts record/g),
    ).toHaveLength(2);
    expect(foundry).toContain("PURPOSE_FOUNDRY_SMOKE_PHASE: seed");
    expect(foundry).toContain("PURPOSE_FOUNDRY_SMOKE_PHASE: resume");
    expect(foundry).toContain("purpose-foundry-seed-${{ github.run_id }}");
    expect(foundry).toContain("purpose-foundry-windows-${{ github.run_id }}");
    expect(foundry).toContain("purpose-foundry-macos-${{ github.run_id }}");
    expect(foundry).toContain("!workspaces/**/node_modules/**");
    expect(foundrySmoke).toContain("purpose-foundry-cloud-smoke.json");
    expect(foundrySmoke).toContain("HELD FOR PLATFORM PROOF");

    const windowsProof = foundry.slice(
      foundry.indexOf("Execute Windows proof without production secrets"),
      foundry.indexOf("Preserve Windows evidence"),
    );
    const macosProof = foundry.slice(
      foundry.indexOf("Execute macOS proof without production secrets"),
      foundry.indexOf("Preserve macOS evidence"),
    );
    expect(windowsProof).not.toContain("API_KEY");
    expect(macosProof).not.toContain("API_KEY");
    expect(windowsProof).toContain("FACTORY_PLATFORM_SANDBOX_ROOT:");
    expect(macosProof).toContain("FACTORY_PLATFORM_SANDBOX_ROOT:");
  });

  it.each([
    ["Factory Deck", factory],
    ["Purpose Foundry", foundry],
  ])(
    "%s preserves exact artifact identities across failed-job retries",
    (name, workflow) => {
      const prefix = name === "Factory Deck" ? "factory-deck" : "purpose-foundry";
      const artifactNames = [
        ...workflow.matchAll(new RegExp(`^\\s+name: (${prefix}[^\\n]+)$`, "gm")),
      ].map((match) => match[1]);
      expect(artifactNames.length).toBeGreaterThan(0);
      for (const artifactName of artifactNames) {
        expect(artifactName).toContain("${{ github.run_id }}");
        expect(artifactName).not.toContain("${{ github.run_attempt }}");
      }
      expect(workflow.match(/overwrite: true/g)).toHaveLength(4);

      const sealIndex = workflow.indexOf(
        "pnpm exec tsx src/cli/factory-platform-proof.ts validate",
      );
      const seedUploadIndex = workflow.indexOf(`name: ${prefix}-seed-`);
      expect(sealIndex).toBeGreaterThan(0);
      expect(seedUploadIndex).toBeGreaterThan(sealIndex);
    },
  );

  it("builds a verifier image with Node, Python, native tools, and no entrypoint", () => {
    expect(dockerfile).toContain(
      "FROM node:20.19.5-bookworm-slim@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3",
    );
    for (const tool of [
      "build-essential",
      "chromium",
      "fonts-liberation",
      "fonts-noto-color-emoji",
      "git",
      "python3",
      "python3-pip",
      "python3-pytest",
      "python-is-python3",
    ]) {
      expect(dockerfile).toContain(tool);
    }
    expect(dockerfile).toContain("pnpm@10.17.0");
    expect(dockerfile).not.toContain("pnpm@10.17.0 yarn@");
    expect(dockerfile).toContain('test "$(yarn --version)" = "1.22.22"');
    expect(dockerfile).toContain("ENTRYPOINT []");
  });
});
