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
const freeFallback = readFileSync(
  resolve("scripts/ci/provision-aitime-free-fallback.sh"),
  "utf8",
);

describe("automatic cloud model-ladder contract", () => {
  it("attempts the current strongest Anthropic model first", () => {
    for (const workflow of [factory, foundry]) {
      expect(workflow).toContain("ANTHROPIC_MODEL: claude-opus-5");
      expect(workflow).toContain("FACTORY_FABLE_OR_OPUS_MODEL: claude-opus-5");
      expect(workflow).toContain("FACTORY_ANTHROPIC_MODEL_LADDER: claude-opus-5");
      expect(workflow).toContain("FACTORY_OPENAI_MODEL_LADDER: gpt-5.6-sol");
      expect(workflow).not.toContain("claude-opus-4-8");
    }
  });

  it("does not override catalog resolution with the retired OpenAI model", () => {
    for (const workflow of [factory, foundry]) {
      expect(workflow).toContain("OPENAI_MODEL: gpt-5.6-sol");
      expect(workflow).toContain("FACTORY_SOL_MODEL: gpt-5.6-sol");
      expect(workflow).not.toContain("gpt-5.5");
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

  it("keeps option-like Factory prompts out of positional CLI parsing", () => {
    expect(factory).toContain("FACTORY_IDEA:");
    expect(factory).toContain('FACTORY_PROJECT_ID: "factory-deck-cloud-proof"');
    expect(factory).toContain("run: pnpm exec tsx src/cli/factory.ts");
    expect(factory).not.toContain(
      'run: pnpm exec tsx src/cli/factory.ts "$env:FACTORY_IDEA"',
    );
  });

  it("keeps paid credential fallbacks optional on both model-execution phases", () => {
    expect(
      factory.match(
        /secrets\.PAID_PRODUCTION_ANTHROPIC_KEY \|\| secrets\.ANTHROPIC_API_KEY/g,
      ),
    ).toHaveLength(2);
    expect(
      factory.match(
        /secrets\.PAID_PRODUCTION_OPENAI_KEY \|\| secrets\.OPENAI_API_KEY/g,
      ),
    ).toHaveLength(2);
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

  it("keeps Purpose Foundry's real end-to-end smoke and upload reserve", () => {
    expect(foundry).toContain('PURPOSE_FOUNDRY_FACTORY_TIMEOUT_MS: "19200000"');
    expect(foundry).toContain('PURPOSE_FOUNDRY_SMOKE_TIMEOUT_MS: "19200000"');
    expect(foundry).toContain("node scripts/ci/run-purpose-foundry-smoke.mjs");
    expect(foundry).toContain("purpose-foundry-server.log");
    expect(foundry).toContain(".factory/**");
    expect(foundry).toContain("workspaces/**");
  });

  it.each([
    ["Factory Deck", factory],
    ["Purpose Foundry", foundry],
  ])(
    "%s provisions one real AI Time free terminal rung in both execution phases",
    (_name, workflow) => {
      expect(
        workflow.match(/bash scripts\/ci\/provision-aitime-free-fallback\.sh/g),
      ).toHaveLength(2);
      expect(workflow.match(/FACTORY_FREE_ENABLED: "1"/g)).toHaveLength(2);
      expect(workflow).not.toContain('FACTORY_FREE_ENABLED: "0"');
      expect(workflow).not.toMatch(/No (?:Anthropic|OpenAI) production credential/);
    },
  );

  it("provisions and probes a real local model without mock or stub evidence", () => {
    expect(freeFallback).toContain("ollama/ollama:latest");
    expect(freeFallback).toContain("qwen2.5-coder:7b");
    expect(freeFallback).toContain("qwen2.5-coder:3b");
    expect(freeFallback).toContain('cost_class: "local-unlimited"');
    expect(freeFallback).toContain('api: "ollama"');
    expect(freeFallback).toContain("/api/chat");
    expect(freeFallback).toContain(
      "AI_ROTATE_CALL_TIMEOUT_MS=${AITIME_OLLAMA_CALL_TIMEOUT_MS:-600000}",
    );
    expect(freeFallback).toContain(
      "No AI Time free candidate could serve a real inference.",
    );
    expect(freeFallback).not.toMatch(/mock|stub/i);
  });

  it("treats sustainable runner capacity as part of free-route availability", () => {
    // A 7B model can answer a trivial warm-up probe on a small hosted runner
    // and then terminate Ollama when the real architect prompt arrives, so the
    // runner's usable memory must gate whether 7B is offered at all.
    expect(freeFallback).toContain("AITIME_OLLAMA_7B_MIN_BYTES");
    expect(freeFallback).toContain("MemAvailable");
    expect(freeFallback).toContain(
      'candidates=("qwen2.5-coder:7b" "qwen2.5-coder:3b" "qwen2.5-coder:1.5b")',
    );
    expect(freeFallback).toContain(
      'candidates=("qwen2.5-coder:3b" "qwen2.5-coder:1.5b")',
    );
    // An explicit operator candidate list still wins over the memory heuristic.
    expect(freeFallback).toContain('read -r -a candidates <<< "${AITIME_OLLAMA_CANDIDATES}"');
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

  it("proves one exact CLI candidate on Windows and macOS before automatic-ladder finalization", () => {
    expect(factory).toContain("runs-on: windows-latest");
    expect(factory).toContain("runs-on: macos-latest");
    expect(factory).toContain("needs: windows");
    expect(factory).toContain("needs: macos");
    expect(factory).toContain(
      "pnpm exec tsx src/cli/factory-platform-proof.ts validate",
    );
    expect(factory).toContain("run-windows-platform-proof.ps1");
    expect(factory).toContain("run-macos-platform-proof.sh");
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
  });

  it("resumes the same Purpose Foundry candidate after secret-free Windows and macOS proof", () => {
    expect(foundry).toContain("runs-on: windows-latest");
    expect(foundry).toContain("runs-on: macos-latest");
    expect(foundry).toContain("needs: windows");
    expect(foundry).toContain("needs: macos");
    expect(foundry).toContain(
      "pnpm exec tsx src/cli/factory-platform-proof.ts validate",
    );
    expect(foundry).toContain("run-windows-platform-proof.ps1");
    expect(foundry).toContain("run-macos-platform-proof.sh");
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
  });

  it.each([
    ["Factory Deck", factory],
    ["Purpose Foundry", foundry],
  ])(
    "%s preserves exact artifact identities across failed-job retries",
    (_name, workflow) => {
      expect(workflow.match(/overwrite: true/g)).toHaveLength(4);
      expect(workflow).not.toMatch(
        /^\s+name: (?:factory-deck|purpose-foundry)[^\n]*github\.run_attempt/m,
      );
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
