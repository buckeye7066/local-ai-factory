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

describe("paid cloud workflow contract", () => {
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
    ).toHaveLength(2);
    expect(
      factory.match(
        /secrets\.PAID_PRODUCTION_OPENAI_KEY \|\| secrets\.OPENAI_API_KEY/g,
      ),
    ).toHaveLength(2);
    expect(foundry).toContain(
      "secrets.PAID_PRODUCTION_ANTHROPIC_KEY || secrets.ANTHROPIC_API_KEY",
    );
    expect(foundry).toContain(
      "secrets.PAID_PRODUCTION_OPENAI_KEY || secrets.OPENAI_API_KEY",
    );
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
