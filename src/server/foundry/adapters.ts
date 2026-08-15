import { execFile } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { getConfig, getSecrets } from "../config.js";
import { createProviderRegistry } from "../providers/index.js";
import { getRun } from "../storage/runsStore.js";
import { repoNameProblem, RunOptionsSchema } from "../../shared/schemas.js";
import {
  STATIONS,
  type FoundryProject,
  type FoundryStore,
  type StationId,
} from "./model.js";

export type AdapterOutcome = {
  status: "completed" | "needs_attention" | "failed";
  summary: string;
  artifacts: string[];
  evidence: Record<string, unknown>;
};

export type AdapterDescriptor = {
  stationId: StationId;
  mode: "internal" | "http" | "process";
  configured: boolean;
  destination: string;
};

type ProcessResult = { stdout: string; stderr: string; exitCode: number };
type ProcessRunner = (
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<ProcessResult>;

type AdapterDependencies = {
  fetch: typeof fetch;
  processRunner: ProcessRunner;
  sleep: (ms: number) => Promise<void>;
};

const CrucibleResultSchema = z.object({
  verdict: z.enum(["hardened", "needs_work"]),
  summary: z.string().min(1).max(4_000),
  findings: z
    .array(
      z.object({
        severity: z.enum(["critical", "high", "medium", "low"]),
        claim: z.string().min(1).max(1_000),
        evidence: z.string().min(1).max(2_000),
        requiredFix: z.string().min(1).max(2_000),
      }),
    )
    .max(50),
  testedClaims: z.array(z.string().min(1).max(1_000)).max(100),
});

const MAX_HTTP_BYTES = 2_000_000;
const MAX_PROCESS_OUTPUT = 4 * 1024 * 1024;

function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value.trim());
}

function numberEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
  parsed.username = "";
  parsed.password = "";
  return trimSlash(parsed.toString());
}

function defaultProcessRunner(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: MAX_PROCESS_OUTPUT,
        windowsHide: true,
        encoding: "utf8",
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : 1;
          // Child output can contain provider diagnostics or secret-shaped
          // environment values. A failed process is recorded generically;
          // raw stdout/stderr is never copied into the evidence ledger.
          reject(new Error(`Process exited ${code}. Inspect FlexFactor's local run log.`));
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
      },
    );
  });
}

function firstTarget(project: FoundryProject): string | null {
  return project.constitution.targets.map((item) => item.trim()).find(Boolean) ?? null;
}

/** Convert explicit local paths and GitHub references into Factory Deck input. */
export function repoSourceFromTarget(
  target: string,
): { type: "path" | "git"; location: string } | null {
  const value = target.trim();
  if (!value) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || isAbsolute(value)) {
    return { type: "path", location: value };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return { type: "git", location: `https://github.com/${value}.git` };
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "ssh:") {
      return { type: "git", location: value };
    }
  } catch {
    // A prose target is intentionally left for Factory Deck's repo resolver.
  }
  return null;
}

export function repoRewardsQuery(project: FoundryProject): string {
  const criteria = project.constitution.successCriteria.join("; ") || "fulfill its stated purpose";
  const constraints = project.constitution.constraints.join("; ") || "preserve existing behavior";
  return [
    `Find reusable open-source repositories for ${project.name}.`,
    `Purpose: ${project.constitution.purpose}`,
    `Success: ${criteria}.`,
    `Constraints: ${constraints}.`,
    "Prefer maintained, permissively licensed projects with evidence of real adoption.",
  ].join(" ");
}

function compactOutput(value: string): string {
  const clean = value.replace(/\u001b\[[0-9;]*m/g, "").trim();
  return clean.length <= 500_000 ? clean : `${clean.slice(0, 500_000)}\n[truncated]`;
}

export class FoundryAdapters {
  private readonly dependencies: AdapterDependencies;

  constructor(
    private readonly store: FoundryStore,
    dependencies: Partial<AdapterDependencies> = {},
  ) {
    this.dependencies = {
      fetch: dependencies.fetch ?? fetch,
      processRunner: dependencies.processRunner ?? defaultProcessRunner,
      sleep: dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    };
  }

  descriptors(): AdapterDescriptor[] {
    const config = getConfig();
    const secrets = getSecrets();
    const flexScript =
      process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT?.trim() ||
      "C:\\Users\\firer\\flexfactor\\flexfactor.py";
    const reviewProvider = createProviderRegistry(config, secrets).resolveLive(
      undefined,
      config.defaultReviewProvider,
    );
    const map: Record<StationId, Omit<AdapterDescriptor, "stationId">> = {
      "factory-deck": { mode: "internal", configured: true, destination: "Factory Deck run API" },
      scout: { mode: "process", configured: Boolean(flexScript), destination: flexScript },
      "repo-rewards": {
        mode: "http",
        configured: true,
        destination:
          process.env.PURPOSE_FOUNDRY_REPO_REWARDS_URL?.trim() ||
          "https://web-production-d7db7.up.railway.app",
      },
      "promo-pilot": {
        mode: "http",
        configured: Boolean(process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN?.trim()),
        destination:
          process.env.PURPOSE_FOUNDRY_PROMOPILOT_URL?.trim() ||
          "https://promopilot-production-6370.up.railway.app",
      },
      flexfactor: { mode: "process", configured: Boolean(flexScript), destination: flexScript },
      crucible: {
        mode: "internal",
        configured: reviewProvider.isConfigured(),
        destination: `independent ${reviewProvider.name} adversarial review`,
      },
      "app-store-publisher": {
        mode: "http",
        configured: true,
        destination:
          process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL?.trim() ||
          "http://127.0.0.1:4000",
      },
      watchtower: {
        mode: "http",
        configured: Boolean(process.env.PURPOSE_FOUNDRY_WATCH_URLS?.trim()),
        destination: process.env.PURPOSE_FOUNDRY_WATCH_URLS?.trim() || "No watch URLs configured",
      },
    };
    return STATIONS.map((station) => ({ stationId: station.id, ...map[station.id] }));
  }

  async execute(project: FoundryProject, stationId: StationId): Promise<AdapterOutcome> {
    switch (stationId) {
      case "factory-deck":
        return this.factoryDeck(project);
      case "scout":
        return this.flexfactorProcess(project, "scout");
      case "repo-rewards":
        return this.repoRewards(project);
      case "promo-pilot":
        return this.promoPilot(project);
      case "flexfactor":
        return this.flexfactorProcess(project, "prodready");
      case "crucible":
        return this.crucible(project);
      case "app-store-publisher":
        return this.appStorePublisher(project);
      case "watchtower":
        return this.watchtower(project);
    }
  }

  private async fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      numberEnv("PURPOSE_FOUNDRY_HTTP_TIMEOUT_MS", 120_000),
    );
    timeout.unref();
    try {
      const response = await this.dependencies.fetch(url, { ...init, signal: controller.signal });
      const body = await response.text();
      if (body.length > MAX_HTTP_BYTES) throw new Error("Adapter response exceeded 2 MB.");
      if (!response.ok) throw new Error(`Adapter returned HTTP ${response.status}.`);
      return body ? (JSON.parse(body) as unknown) : {};
    } finally {
      clearTimeout(timeout);
    }
  }

  private async factoryDeck(project: FoundryProject): Promise<AdapterOutcome> {
    const config = getConfig();
    const secrets = getSecrets();
    const target = firstTarget(project);
    const repoSource = target ? repoSourceFromTarget(target) : null;
    const upstreamEvidence = project.stations
      .filter((station) => station.status === "completed" && station.stationId !== "factory-deck")
      .map((station) => ({
        stationId: station.stationId,
        summary: station.summary,
        artifacts: station.artifacts,
      }));
    const goals = [
      project.constitution.purpose,
      ...project.constitution.successCriteria.map((item) => `Success criterion: ${item}`),
      ...project.constitution.constraints.map((item) => `Constraint: ${item}`),
      ...project.constitution.nonGoals.map((item) => `Non-goal: ${item}`),
      ...(upstreamEvidence.length
        ? [
            `Use these completed specialist handoffs as implementation evidence: ${JSON.stringify(upstreamEvidence)}`,
          ]
        : []),
    ];
    const options = target
      ? RunOptionsSchema.parse({
          mode: "extend",
          ...(repoSource ? { repoSource } : {}),
          goals,
          pushToOrigin: true,
          idempotencyKey: `purpose-foundry:${project.id}:factory-deck`,
        })
      : (() => {
          if (repoNameProblem(project.name)) {
            throw new Error(
              "A new project needs a GitHub-safe project name or an explicit target repository.",
            );
          }
          return RunOptionsSchema.parse({
            mode: "new",
            goals,
            newRepo: { name: project.name, private: true, createRemote: true },
            idempotencyKey: `purpose-foundry:${project.id}:factory-deck`,
          });
        })();
    const idea = [
      `Purpose Foundry project: ${project.name}`,
      `Purpose: ${project.constitution.purpose}`,
      `Target users: ${project.constitution.targetUsers.join(", ") || "not specified"}`,
      `Success criteria: ${project.constitution.successCriteria.join("; ") || "not specified"}`,
      `Constraints: ${project.constitution.constraints.join("; ") || "none specified"}`,
      `Upstream specialist handoffs: ${upstreamEvidence.length ? JSON.stringify(upstreamEvidence) : "none"}`,
    ].join("\n");
    const runStart = (await this.fetchJson(`http://127.0.0.1:${config.port}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `purpose-foundry:${project.id}:factory-deck`,
        ...(secrets.authToken ? { authorization: `Bearer ${secrets.authToken}` } : {}),
      },
      body: JSON.stringify({ idea, options }),
    })) as { runId?: unknown };
    if (typeof runStart.runId !== "string") throw new Error("Factory Deck did not return a run id.");

    const deadline = Date.now() + numberEnv("PURPOSE_FOUNDRY_FACTORY_TIMEOUT_MS", 14_400_000);
    let run = await getRun(runStart.runId);
    while (run && (run.status === "queued" || run.status === "running")) {
      if (Date.now() >= deadline) throw new Error("Factory Deck run exceeded the Foundry timeout.");
      await this.dependencies.sleep(2_000);
      run = await getRun(runStart.runId);
    }
    if (!run) throw new Error("Factory Deck run record disappeared.");
    const artifact = await this.store.writeArtifact(
      project.id,
      "factory-deck",
      "factory-run.json",
      run,
    );
    if (run.status !== "completed") {
      return {
        status: "failed",
        summary: `Factory Deck run ${run.id} ended ${run.status}: ${run.error || "no error detail"}`,
        artifacts: [artifact],
        evidence: { runId: run.id, status: run.status },
      };
    }
    return {
      status: "completed",
      summary: run.finalReport?.summary || `Factory Deck completed run ${run.id}.`,
      artifacts: [artifact, ...(run.workspacePath ? [run.workspacePath] : []), ...(run.destination?.url ? [run.destination.url] : [])],
      evidence: { runId: run.id, status: run.status, destination: run.destination ?? null },
    };
  }

  private async flexfactorProcess(
    project: FoundryProject,
    mode: "scout" | "prodready",
  ): Promise<AdapterOutcome> {
    const target = firstTarget(project);
    if (!target) {
      return {
        status: "needs_attention",
        summary: `${mode === "scout" ? "Scout" : "FlexFactor"} needs a target path, URL, or owner/repository in the project constitution.`,
        artifacts: [],
        evidence: { missing: "constitution.targets" },
      };
    }
    const script =
      process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT?.trim() ||
      "C:\\Users\\firer\\flexfactor\\flexfactor.py";
    const python = process.env.PURPOSE_FOUNDRY_PYTHON?.trim() || "python";
    const provider =
      process.env.PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER?.trim() ||
      (getConfig().defaultCodeProvider === "free" ? "ollama" : getConfig().defaultCodeProvider);
    if (!/^(ollama|anthropic|openai)$/.test(provider)) {
      throw new Error("PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER must be ollama, anthropic, or openai.");
    }
    const args = [script, mode, "--program", target, "--provider", provider];
    if (mode === "scout") {
      args.push("--top", String(numberEnv("PURPOSE_FOUNDRY_SCOUT_TOP", 8)));
      const rewardsUrl =
        process.env.PURPOSE_FOUNDRY_REPO_REWARDS_URL?.trim() ||
        "https://web-production-d7db7.up.railway.app";
      args.push("--repo-rewards-url", rewardsUrl);
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(rewardsUrl)) {
        args.push("--allow-remote-repo-rewards");
      }
      if (boolEnv("PURPOSE_FOUNDRY_ALLOW_REMOTE_PROGRAM_CONTEXT")) {
        args.push("--allow-remote-program-context");
      }
    } else {
      args.push(
        "--yes",
        "--no-dashboard",
        "--max-cost",
        String(numberEnv("PURPOSE_FOUNDRY_FLEXFACTOR_MAX_COST", 150)),
      );
    }
    const result = await this.dependencies.processRunner(python, args, {
      cwd: dirname(resolve(script)),
      timeoutMs: numberEnv("PURPOSE_FOUNDRY_FLEXFACTOR_TIMEOUT_MS", 14_400_000),
    });
    const output = compactOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
    const artifact = await this.store.writeArtifact(
      project.id,
      mode === "scout" ? "scout" : "flexfactor",
      `${mode}-output.txt`,
      output,
    );
    return {
      status: "completed",
      summary: `${mode === "scout" ? "Scout" : "FlexFactor"} completed for ${target}.`,
      artifacts: [artifact],
      evidence: { exitCode: result.exitCode, provider, target, outputTail: output.slice(-2_000) },
    };
  }

  private async repoRewards(project: FoundryProject): Promise<AdapterOutcome> {
    const base = safeUrl(
      process.env.PURPOSE_FOUNDRY_REPO_REWARDS_URL?.trim() ||
        "https://web-production-d7db7.up.railway.app",
      "Repo Rewards URL",
    );
    const query = repoRewardsQuery(project);
    const result = await this.fetchJson(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, lens: "best", sessionId: project.id }),
    });
    const artifact = await this.store.writeArtifact(
      project.id,
      "repo-rewards",
      "repo-rewards.json",
      result,
    );
    const rows = Array.isArray((result as { results?: unknown }).results)
      ? (result as { results: Array<Record<string, unknown>> }).results
      : null;
    const count = rows?.length ?? null;
    const topCandidates = (rows ?? []).slice(0, 5).map((row) => {
      const repo = row.repo && typeof row.repo === "object"
        ? (row.repo as Record<string, unknown>)
        : row;
      return {
        fullName: typeof repo.fullName === "string" ? repo.fullName : null,
        score: typeof row.finalScore === "number" ? row.finalScore : null,
        license: typeof repo.licenseSpdx === "string" ? repo.licenseSpdx : null,
      };
    });
    return {
      status: "completed",
      summary: `Repo Rewards completed its search${count === null ? "" : ` and returned ${count} candidate(s)`}${topCandidates.length ? `; leading matches: ${topCandidates.map((item) => item.fullName || "unnamed").join(", ")}` : ""}.`,
      artifacts: [artifact],
      evidence: { query, resultCount: count, topCandidates },
    };
  }

  private async promoPilot(project: FoundryProject): Promise<AdapterOutcome> {
    const token = process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN?.trim();
    if (!token) {
      return {
        status: "needs_attention",
        summary: "PromoPilot is reachable, but PURPOSE_FOUNDRY_PROMOPILOT_TOKEN is not configured for advertisement data.",
        artifacts: [],
        evidence: { missing: "PURPOSE_FOUNDRY_PROMOPILOT_TOKEN" },
      };
    }
    const base = safeUrl(
      process.env.PURPOSE_FOUNDRY_PROMOPILOT_URL?.trim() ||
        "https://promopilot-production-6370.up.railway.app",
      "PromoPilot URL",
    );
    const headers = { authorization: `Bearer ${token}` };
    const [controlPlane, overview] = await Promise.all([
      this.fetchJson(`${base}/api/control-plane`, { headers }),
      this.fetchJson(`${base}/api/overview`, { headers }),
    ]);
    const artifact = await this.store.writeArtifact(
      project.id,
      "promo-pilot",
      "advertisement-data.json",
      { project: project.name, collectedAt: Date.now(), controlPlane, overview },
    );
    return {
      status: "completed",
      summary: "PromoPilot supplied current campaign, attribution, destination, and advertisement evidence.",
      artifacts: [artifact],
      evidence: { sources: ["/api/control-plane", "/api/overview"], authenticated: true },
    };
  }

  private async crucible(project: FoundryProject): Promise<AdapterOutcome> {
    const config = getConfig();
    const provider = createProviderRegistry(config, getSecrets()).resolveLive(
      undefined,
      config.defaultReviewProvider,
    );
    const result = await provider.generateJson({
      system:
        "You are The Crucible, an independent adversarial release reviewer. Assume the project is not ready. Try to disprove every success claim using only supplied evidence. Never reward effort, optimism, or self-attestation. A claim without evidence is a finding.",
      prompt: `Review this Purpose Foundry project.\n\nPROJECT:\n${JSON.stringify({
        name: project.name,
        constitution: project.constitution,
        stationEvidence: project.stations.map((station) => ({
          stationId: station.stationId,
          status: station.status,
          summary: station.summary,
          artifacts: station.artifacts,
        })),
      })}\n\nReturn hardened only when there are no critical/high unresolved findings and every stated success criterion has concrete evidence. Otherwise return needs_work with exact required fixes.`,
      schema: CrucibleResultSchema,
      schemaName: "CrucibleResult",
      temperature: 0.1,
      maxTokens: 12_000,
    });
    const artifact = await this.store.writeArtifact(
      project.id,
      "crucible",
      "crucible-verdict.json",
      result,
    );
    return {
      status: result.verdict === "hardened" ? "completed" : "needs_attention",
      summary: result.summary,
      artifacts: [artifact],
      evidence: { verdict: result.verdict, findings: result.findings, testedClaims: result.testedClaims },
    };
  }

  private async appStorePublisher(project: FoundryProject): Promise<AdapterOutcome> {
    const base = safeUrl(
      process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL?.trim() ||
        "http://127.0.0.1:4000",
      "App Store Publisher URL",
    );
    const [health, stores, submissions] = await Promise.all([
      this.fetchJson(`${base}/api/health`),
      this.fetchJson(`${base}/api/stores`),
      this.fetchJson(`${base}/api/submissions`),
    ]);
    const releaseArtifacts = project.stations
      .flatMap((station) => station.artifacts)
      .filter((item) => /\.(aab|apk|ipa|msix|appx|zip)$/i.test(item));
    const artifact = await this.store.writeArtifact(
      project.id,
      "app-store-publisher",
      "publisher-readiness.json",
      { health, stores, submissions, releaseArtifacts },
    );
    if (!releaseArtifacts.length) {
      return {
        status: "needs_attention",
        summary: "App Store Publisher is available, but no signed release artifact was produced by an earlier station.",
        artifacts: [artifact],
        evidence: { publisherHealthy: true, releaseArtifacts: 0 },
      };
    }
    return {
      status: "completed",
      summary: `App Store Publisher verified ${releaseArtifacts.length} release artifact reference(s) and recorded current store readiness.`,
      artifacts: [artifact, ...releaseArtifacts],
      evidence: { publisherHealthy: true, releaseArtifacts: releaseArtifacts.length },
    };
  }

  private async watchtower(project: FoundryProject): Promise<AdapterOutcome> {
    const configured = (process.env.PURPOSE_FOUNDRY_WATCH_URLS ?? "")
      .split(/[;,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!configured.length) {
      return {
        status: "needs_attention",
        summary: "Watchtower needs at least one explicit PURPOSE_FOUNDRY_WATCH_URLS endpoint.",
        artifacts: [],
        evidence: { missing: "PURPOSE_FOUNDRY_WATCH_URLS" },
      };
    }
    const checks = await Promise.all(
      configured.map(async (item) => {
        const url = safeUrl(item, "Watchtower URL");
        const started = Date.now();
        try {
          const response = await this.dependencies.fetch(url, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(numberEnv("PURPOSE_FOUNDRY_WATCH_TIMEOUT_MS", 20_000)),
          });
          return { url, ok: response.ok, status: response.status, latencyMs: Date.now() - started };
        } catch (error) {
          return {
            url,
            ok: false,
            status: null,
            latencyMs: Date.now() - started,
            error: error instanceof Error ? error.name : "request_failed",
          };
        }
      }),
    );
    const artifact = await this.store.writeArtifact(
      project.id,
      "watchtower",
      "deployment-health.json",
      { checkedAt: Date.now(), checks },
    );
    const failures = checks.filter((check) => !check.ok);
    return {
      status: failures.length ? "needs_attention" : "completed",
      summary: failures.length
        ? `Watchtower found ${failures.length} unhealthy endpoint(s) out of ${checks.length}.`
        : `Watchtower verified ${checks.length} deployed endpoint(s).`,
      artifacts: [artifact],
      evidence: { checks },
    };
  }
}
