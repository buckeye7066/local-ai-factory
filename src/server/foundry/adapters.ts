import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import { getConfig, getSecrets } from "../config.js";
import { underWorkTheme } from "../orchestrator/themeBind.js";
import { createProviderRegistry } from "../providers/index.js";
import { getRun } from "../storage/runsStore.js";
import { withExtendPersistenceGoals } from "../orchestrator/composeExtendIdea.js";
import { repoNameProblem, RunOptionsSchema } from "../../shared/schemas.js";
import {
  STATIONS,
  type FoundryProject,
  type FoundryStore,
  type StationId,
} from "./model.js";

export const FOUNDRY_FLEXFACTOR_PROVIDER_RE =
  /^(ollama|anthropic|openai|xai|grok)$/;
export const FOUNDRY_FLEXFACTOR_PROVIDER_ERROR =
  "PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER must be ollama, anthropic, openai, xai, or grok.";

/** Same directed path as Factory Deck / FlexFactor: coding routes + one open issue. */
function foundryProviderRegistry() {
  const config = getConfig();
  const secrets = getSecrets();
  return createProviderRegistry(
    config,
    secrets,
    () => {},
    undefined,
    "purpose-foundry",
  );
}

function flexfactorDirectedScript(): string {
  // Prefer flexfactor_run.py so directed install() is live even when flexfactor.py
  // has no install one-liner (shared rule across Factory Deck / FlexFactor).
  return (
    process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT?.trim() ||
    "C:\\Users\\firer\\flexfactor\\flexfactor_run.py"
  );
}

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
const RELEASE_EXTENSIONS = new Set([".aab", ".apk", ".ipa"]);
const MAX_RELEASE_SCAN_ENTRIES = 5_000;

type PublisherStore = {
  id: string;
  label?: string;
  configured: boolean;
  hint?: string;
};
type PublisherPreset = {
  id: string;
  label: string;
  repo?: string;
  packageName?: string;
  appleBundleId?: string;
  galaxyContentId?: string;
};
type ReleaseArtifact = {
  path: string;
  extension: ".aab" | ".apk" | ".ipa";
  size: number;
  mtimeMs: number;
};

const PublisherStoresSchema = z.object({
  stores: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      configured: z.boolean(),
      hint: z.string().optional(),
    }),
  ),
});
const PublisherPresetsSchema = z.object({
  presets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      repo: z.string().optional(),
      packageName: z.string().optional(),
      appleBundleId: z.string().optional(),
      galaxyContentId: z.string().optional(),
    }),
  ),
});

function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  return value === undefined
    ? fallback
    : /^(1|true|yes|on)$/i.test(value.trim());
}

function numberEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizedIdentity(value: string): string {
  let result = value
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\.git$/, "");
  try {
    const url = new URL(result);
    result = `${url.hostname}${url.pathname}`.replace(/^www\./, "");
  } catch {
    // Project names and owner/repository references are not URLs.
  }
  return result.replace(/^github\.com\//, "").replace(/^\/+|\/+$/g, "");
}

export function publisherPresetForProject(
  project: FoundryProject,
  presets: PublisherPreset[],
): PublisherPreset | null {
  const identities = [project.name, ...project.constitution.targets]
    .map(normalizedIdentity)
    .filter(Boolean);
  const exactRepo = presets.find(
    (preset) =>
      preset.repo && identities.includes(normalizedIdentity(preset.repo)),
  );
  if (exactRepo) return exactRepo;
  const byName = presets.filter((preset) => {
    const candidates = [preset.id, preset.label].map(normalizedIdentity);
    return candidates.some((candidate) => identities.includes(candidate));
  });
  return byName.length === 1 ? byName[0] : null;
}

function pathWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function releaseRoots(project: FoundryProject): Promise<string[]> {
  const candidates = [
    getConfig().workspaceRoot,
    ...project.constitution.targets.filter(
      (item) => /^[A-Za-z]:[\\/]/.test(item.trim()) || isAbsolute(item.trim()),
    ),
  ];
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(resolve(candidate));
      const info = await lstat(canonical);
      if (info.isDirectory() && !roots.includes(canonical))
        roots.push(canonical);
    } catch {
      // A target may be a future path or remote repository; it is not a release root yet.
    }
  }
  return roots;
}

async function discoverReleaseArtifacts(
  project: FoundryProject,
): Promise<ReleaseArtifact[]> {
  const roots = await releaseRoots(project);
  if (!roots.length) return [];
  const references = [
    ...new Set(project.stations.flatMap((station) => station.artifacts)),
  ];
  const found = new Map<string, ReleaseArtifact>();
  let visited = 0;

  const inspectPath = async (candidate: string): Promise<void> => {
    if (visited++ >= MAX_RELEASE_SCAN_ENTRIES) return;
    let canonical: string;
    let info;
    try {
      const original = await lstat(candidate);
      if (original.isSymbolicLink()) return;
      canonical = await realpath(candidate);
      if (!roots.some((root) => pathWithin(canonical, root))) return;
      info = await lstat(canonical);
    } catch {
      return;
    }
    if (info.isFile()) {
      const extension = extname(canonical).toLowerCase();
      if (RELEASE_EXTENSIONS.has(extension) && info.size > 0) {
        found.set(canonical, {
          path: canonical,
          extension: extension as ReleaseArtifact["extension"],
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      }
      return;
    }
    if (!info.isDirectory()) return;
    let entries;
    try {
      entries = await readdir(canonical, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_RELEASE_SCAN_ENTRIES) break;
      if (
        entry.isSymbolicLink() ||
        [".git", ".factory", "node_modules"].includes(entry.name)
      )
        continue;
      if (
        entry.isDirectory() ||
        (entry.isFile() &&
          RELEASE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      ) {
        await inspectPath(join(canonical, entry.name));
      }
    }
  };

  for (const reference of references) {
    if (/^https?:\/\//i.test(reference)) continue;
    await inspectPath(resolve(reference));
  }
  return [...found.values()].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path),
  );
}

function multipartUploadBody(
  artifact: ReleaseArtifact,
  sha256: string,
): {
  body: Readable;
  contentType: string;
  contentLength: number;
} {
  const boundary = `purpose-foundry-${createHash("sha256").update(`${artifact.path}:${sha256}`).digest("hex").slice(0, 24)}`;
  const safeName = basename(artifact.path).replace(/["\r\n]/g, "_");
  const expected = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="expectedSha256"\r\n\r\n${sha256}\r\n`,
  );
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="binary"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from(
    (async function* () {
      yield expected;
      yield fileHeader;
      yield* createReadStream(artifact.path);
      yield ending;
    })(),
  );
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength:
      expected.length + fileHeader.length + artifact.size + ending.length,
  };
}

function publisherEvidenceBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { approvalToken: _approvalToken, ...safe } = body;
  return safe;
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
          reject(
            new Error(
              `Process exited ${code}. Inspect FlexFactor's local run log.`,
            ),
          );
          return;
        }
        resolvePromise({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: 0,
        });
      },
    );
  });
}

function firstTarget(project: FoundryProject): string | null {
  return (
    project.constitution.targets.map((item) => item.trim()).find(Boolean) ??
    null
  );
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
    if (
      url.protocol === "https:" ||
      url.protocol === "http:" ||
      url.protocol === "ssh:"
    ) {
      return { type: "git", location: value };
    }
  } catch {
    // A prose target is intentionally left for Factory Deck's repo resolver.
  }
  return null;
}

export function repoRewardsQuery(project: FoundryProject): string {
  const criteria =
    project.constitution.successCriteria.join("; ") ||
    "fulfill its stated purpose";
  const constraints =
    project.constitution.constraints.join("; ") || "preserve existing behavior";
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
  return clean.length <= 500_000
    ? clean
    : `${clean.slice(0, 500_000)}\n[truncated]`;
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
      sleep:
        dependencies.sleep ??
        ((ms) => new Promise((done) => setTimeout(done, ms))),
    };
  }

  descriptors(): AdapterDescriptor[] {
    const config = getConfig();
    const flexScript = flexfactorDirectedScript();
    const reviewProvider = foundryProviderRegistry().resolveLive(
      undefined,
      config.defaultReviewProvider,
    );
    const map: Record<StationId, Omit<AdapterDescriptor, "stationId">> = {
      "factory-deck": {
        mode: "internal",
        configured: true,
        destination: "Factory Deck run API",
      },
      scout: {
        mode: "process",
        configured: Boolean(flexScript),
        destination: flexScript,
      },
      "repo-rewards": {
        mode: "http",
        configured: true,
        destination:
          process.env.PURPOSE_FOUNDRY_REPO_REWARDS_URL?.trim() ||
          "https://web-production-d7db7.up.railway.app",
      },
      "promo-pilot": {
        mode: "http",
        configured: Boolean(
          process.env.PURPOSE_FOUNDRY_PROMOPILOT_TOKEN?.trim(),
        ),
        destination:
          process.env.PURPOSE_FOUNDRY_PROMOPILOT_URL?.trim() ||
          "https://promopilot-production-6370.up.railway.app",
      },
      flexfactor: {
        mode: "process",
        configured: Boolean(flexScript),
        destination: flexScript,
      },
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
        destination:
          process.env.PURPOSE_FOUNDRY_WATCH_URLS?.trim() ||
          "No watch URLs configured",
      },
    };
    return STATIONS.map((station) => ({
      stationId: station.id,
      ...map[station.id],
    }));
  }

  async execute(
    project: FoundryProject,
    stationId: StationId,
  ): Promise<AdapterOutcome> {
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

  private async fetchJson(
    url: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      numberEnv("PURPOSE_FOUNDRY_HTTP_TIMEOUT_MS", 120_000),
    );
    timeout.unref();
    try {
      const response = await this.dependencies.fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const body = await response.text();
      if (body.length > MAX_HTTP_BYTES)
        throw new Error("Adapter response exceeded 2 MB.");
      if (!response.ok)
        throw new Error(`Adapter returned HTTP ${response.status}.`);
      return body ? (JSON.parse(body) as unknown) : {};
    } finally {
      clearTimeout(timeout);
    }
  }

  private async publisherJson(
    url: string,
    init: RequestInit = {},
  ): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      numberEnv("PURPOSE_FOUNDRY_PUBLISH_TIMEOUT_MS", 14_400_000),
    );
    timeout.unref();
    try {
      const response = await this.dependencies.fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > MAX_HTTP_BYTES)
        throw new Error("Publisher response exceeded 2 MB.");
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        throw new Error(
          `App Store Publisher returned non-JSON HTTP ${response.status}.`,
        );
      }
      return { status: response.status, ok: response.ok, body };
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
      .filter(
        (station) =>
          station.status === "completed" &&
          station.stationId !== "factory-deck",
      )
      .map((station) => ({
        stationId: station.stationId,
        summary: station.summary,
        artifacts: station.artifacts,
      }));
    const goals = [
      project.constitution.purpose,
      ...project.constitution.successCriteria.map(
        (item) => `Success criterion: ${item}`,
      ),
      ...project.constitution.constraints.map((item) => `Constraint: ${item}`),
      ...project.constitution.nonGoals.map((item) => `Non-goal: ${item}`),
      ...(upstreamEvidence.length
        ? [
            `Use these completed specialist handoffs as implementation evidence: ${JSON.stringify(upstreamEvidence)}`,
          ]
        : []),
    ];
    const extendGoals = target ? withExtendPersistenceGoals(goals) : goals;
    const options = target
      ? RunOptionsSchema.parse({
          mode: "extend",
          ...(repoSource ? { repoSource } : {}),
          goals: extendGoals,
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
            goals: extendGoals,
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
      ...(target
        ? [
            "Honor the EXTEND PERSISTENCE CONTRACT in the run goals (no host-shell rewrite, no _gh_ overlays, atomic server counters, no stub entity clients).",
          ]
        : []),
    ].join("\n");
    const runStart = (await this.fetchJson(
      `http://127.0.0.1:${config.port}/api/runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `purpose-foundry:${project.id}:factory-deck`,
          ...(secrets.authToken
            ? { authorization: `Bearer ${secrets.authToken}` }
            : {}),
        },
        body: JSON.stringify({ idea, options }),
      },
    )) as { runId?: unknown };
    if (typeof runStart.runId !== "string")
      throw new Error("Factory Deck did not return a run id.");

    const deadline =
      Date.now() + numberEnv("PURPOSE_FOUNDRY_FACTORY_TIMEOUT_MS", 14_400_000);
    let run = await getRun(runStart.runId);
    while (run && (run.status === "queued" || run.status === "running")) {
      if (Date.now() >= deadline)
        throw new Error("Factory Deck run exceeded the Foundry timeout.");
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
      summary:
        run.finalReport?.summary || `Factory Deck completed run ${run.id}.`,
      artifacts: [
        artifact,
        ...(run.workspacePath ? [run.workspacePath] : []),
        ...(run.destination?.url ? [run.destination.url] : []),
      ],
      evidence: {
        runId: run.id,
        status: run.status,
        destination: run.destination ?? null,
      },
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
    const script = flexfactorDirectedScript();
    const python = process.env.PURPOSE_FOUNDRY_PYTHON?.trim() || "python";
    const provider =
      process.env.PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER?.trim() ||
      (getConfig().defaultCodeProvider === "free"
        ? "ollama"
        : getConfig().defaultCodeProvider);
    if (!FOUNDRY_FLEXFACTOR_PROVIDER_RE.test(provider)) {
      throw new Error(FOUNDRY_FLEXFACTOR_PROVIDER_ERROR);
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
    const output = compactOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
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
      evidence: {
        exitCode: result.exitCode,
        provider,
        target,
        outputTail: output.slice(-2_000),
      },
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
      const repo =
        row.repo && typeof row.repo === "object"
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
        summary:
          "PromoPilot is reachable, but PURPOSE_FOUNDRY_PROMOPILOT_TOKEN is not configured for advertisement data.",
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
      {
        project: project.name,
        collectedAt: Date.now(),
        controlPlane,
        overview,
      },
    );
    return {
      status: "completed",
      summary:
        "PromoPilot supplied current campaign, attribution, destination, and advertisement evidence.",
      artifacts: [artifact],
      evidence: {
        sources: ["/api/control-plane", "/api/overview"],
        authenticated: true,
      },
    };
  }

  private async crucible(project: FoundryProject): Promise<AdapterOutcome> {
    const config = getConfig();
    const result = await underWorkTheme(
      {
        idea: `Purpose Foundry crucible for ${project.name}`,
        appName: project.name,
        stage: "crucible",
        issue:
          "Disprove every success claim using only supplied evidence; stay on this project's open release risks",
      },
      () => {
        const provider = foundryProviderRegistry().resolveLive(
          undefined,
          config.defaultReviewProvider,
        );
        return provider.generateJson({
          system:
            "You are The Crucible, an independent adversarial release reviewer. Assume the project is not ready. Try to disprove every success claim using only supplied evidence. Never reward effort, optimism, or self-attestation. A claim without evidence is a finding.",
          prompt: `Review this Purpose Foundry project.\n\nPROJECT:\n${JSON.stringify(
            {
              name: project.name,
              constitution: project.constitution,
              stationEvidence: project.stations.map((station) => ({
                stationId: station.stationId,
                status: station.status,
                summary: station.summary,
                artifacts: station.artifacts,
              })),
            },
          )}\n\nReturn hardened only when there are no critical/high unresolved findings and every stated success criterion has concrete evidence. Otherwise return needs_work with exact required fixes.`,
          schema: CrucibleResultSchema,
          schemaName: "CrucibleResult",
          temperature: 0.1,
          maxTokens: 12_000,
        });
      },
    );
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
      evidence: {
        verdict: result.verdict,
        findings: result.findings,
        testedClaims: result.testedClaims,
      },
    };
  }

  private async appStorePublisher(
    project: FoundryProject,
  ): Promise<AdapterOutcome> {
    const base = safeUrl(
      process.env.PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL?.trim() ||
        "http://127.0.0.1:4000",
      "App Store Publisher URL",
    );
    const [health, rawStores, rawPresets, submissions] = await Promise.all([
      this.fetchJson(`${base}/api/health`),
      this.fetchJson(`${base}/api/stores`),
      this.fetchJson(`${base}/api/presets`),
      this.fetchJson(`${base}/api/submissions`),
    ]);
    const stores = PublisherStoresSchema.parse(rawStores).stores;
    const presets = PublisherPresetsSchema.parse(rawPresets).presets;
    const preset = publisherPresetForProject(project, presets);
    const releaseArtifacts = await discoverReleaseArtifacts(project);
    const configured = new Map(
      stores
        .filter((store) => store.configured)
        .map((store) => [store.id, store]),
    );
    const unresolved: string[] = [];

    for (const storeId of ["google_play", "galaxy_store", "app_store"]) {
      const store = stores.find((candidate) => candidate.id === storeId);
      if (store && !store.configured) {
        unresolved.push(
          `${store.label || store.id} is not configured in App Store Publisher.`,
        );
      }
    }

    if (!preset)
      unresolved.push(
        "No exact App Store Publisher preset matches the project name or target repository.",
      );
    if (!releaseArtifacts.length)
      unresolved.push(
        "No real .aab, .apk, or .ipa file was found inside an approved project/workspace root.",
      );
    if (!configured.size)
      unresolved.push("No app store is configured in App Store Publisher.");

    const newest = (extension: ReleaseArtifact["extension"]) =>
      releaseArtifacts.find((artifact) => artifact.extension === extension);
    const assignments = new Map<
      string,
      { artifact: ReleaseArtifact; stores: PublisherStore[] }
    >();
    const assign = (
      store: PublisherStore,
      artifact: ReleaseArtifact | undefined,
    ) => {
      if (!artifact) {
        unresolved.push(
          `${store.label || store.id} is configured but its required release artifact is missing.`,
        );
        return;
      }
      const group = assignments.get(artifact.path) || { artifact, stores: [] };
      group.stores.push(store);
      assignments.set(artifact.path, group);
    };

    if (preset) {
      const google = configured.get("google_play");
      if (google) {
        if (!preset.packageName)
          unresolved.push(`${preset.label} preset has no Google packageName.`);
        else assign(google, newest(".aab") || newest(".apk"));
      }
      const galaxy = configured.get("galaxy_store");
      if (galaxy) {
        if (!preset.galaxyContentId)
          unresolved.push(
            `${preset.label} preset has no Galaxy Store contentId.`,
          );
        else assign(galaxy, newest(".apk"));
      }
      const apple = configured.get("app_store");
      if (apple) {
        if (!preset.appleBundleId)
          unresolved.push(`${preset.label} preset has no Apple bundleId.`);
        else assign(apple, newest(".ipa"));
      }
    }

    const handoffs: Array<Record<string, unknown>> = [];
    for (const {
      artifact: release,
      stores: targetStores,
    } of assignments.values()) {
      const sha256 = await sha256File(release.path);
      const multipart = multipartUploadBody(release, sha256);
      const upload = await this.publisherJson(`${base}/api/upload`, {
        method: "POST",
        headers: {
          "content-type": multipart.contentType,
          "content-length": String(multipart.contentLength),
          "x-purpose-foundry-client": "purpose-foundry",
        },
        body: multipart.body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      if (!upload.ok) {
        unresolved.push(
          `Upload of ${basename(release.path)} failed: ${String(upload.body.error || `HTTP ${upload.status}`)}`,
        );
        handoffs.push({
          artifact: release.path,
          sha256,
          upload: upload.body,
          submitted: false,
        });
        continue;
      }
      const uploadId =
        typeof upload.body.uploadId === "string" ? upload.body.uploadId : null;
      if (!uploadId || upload.body.sha256 !== sha256) {
        unresolved.push(
          `Publisher did not prove the uploaded bytes for ${basename(release.path)}.`,
        );
        handoffs.push({
          artifact: release.path,
          sha256,
          upload: upload.body,
          submitted: false,
        });
        continue;
      }

      const inspection =
        upload.body.inspection && typeof upload.body.inspection === "object"
          ? (upload.body.inspection as Record<string, unknown>)
          : {};
      const fields =
        inspection.fields && typeof inspection.fields === "object"
          ? (inspection.fields as Record<string, unknown>)
          : {};
      const metadata: Record<string, Record<string, unknown>> = {};
      const selected: string[] = [];
      for (const store of targetStores) {
        if (store.id === "google_play" && preset?.packageName) {
          selected.push(store.id);
          metadata[store.id] = {
            packageName: preset.packageName,
            track:
              process.env.PURPOSE_FOUNDRY_GOOGLE_PLAY_TRACK?.trim() ||
              "internal",
          };
        } else if (store.id === "galaxy_store" && preset?.galaxyContentId) {
          selected.push(store.id);
          metadata[store.id] = {
            contentId: preset.galaxyContentId,
            ...(process.env.PURPOSE_FOUNDRY_GALAXY_GMS?.trim()
              ? { gms: process.env.PURPOSE_FOUNDRY_GALAXY_GMS.trim() }
              : {}),
          };
        } else if (store.id === "app_store" && preset?.appleBundleId) {
          const versionString =
            typeof fields.versionName === "string"
              ? fields.versionName.trim()
              : "";
          if (!versionString) {
            unresolved.push(
              `Apple could not read CFBundleShortVersionString from ${basename(release.path)}; it was uploaded but not submitted.`,
            );
            continue;
          }
          selected.push(store.id);
          metadata[store.id] = {
            bundleId: preset.appleBundleId,
            versionString,
            platform: "IOS",
          };
        }
      }
      if (!selected.length) {
        handoffs.push({
          artifact: release.path,
          sha256,
          upload: upload.body,
          submitted: false,
        });
        continue;
      }

      const idempotencyKey = `purpose-foundry:${project.id}:${sha256}:${selected.sort().join(",")}`;
      const request = { uploadId, stores: selected, metadata, idempotencyKey };
      const dryRun = await this.publisherJson(`${base}/api/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-purpose-foundry-client": "purpose-foundry",
        },
        body: JSON.stringify({ ...request, dryRun: true }),
      });
      const approvalToken =
        typeof dryRun.body.approvalToken === "string"
          ? dryRun.body.approvalToken
          : null;
      if (!dryRun.ok || !approvalToken) {
        unresolved.push(
          `Publisher dry run failed for ${basename(release.path)}: ${String(dryRun.body.error || `HTTP ${dryRun.status}`)}`,
        );
        handoffs.push({
          artifact: release.path,
          sha256,
          upload: upload.body,
          dryRun: publisherEvidenceBody(dryRun.body),
          submitted: false,
        });
        continue;
      }

      const evidenceStores =
        dryRun.body.artifactEvidence &&
        typeof dryRun.body.artifactEvidence === "object"
          ? (
              dryRun.body.artifactEvidence as {
                stores?: Array<{
                  unknowns?: unknown[];
                  mismatches?: unknown[];
                }>;
              }
            ).stores || []
          : [];
      const unverified = evidenceStores.some(
        (store) =>
          (store.unknowns?.length || 0) > 0 ||
          (store.mismatches?.length || 0) > 0,
      );
      if (unverified) {
        unresolved.push(
          `Publisher could not fully verify ${basename(release.path)} against its store identity; automatic acknowledgement was refused.`,
        );
        handoffs.push({
          artifact: release.path,
          sha256,
          upload: upload.body,
          dryRun: publisherEvidenceBody(dryRun.body),
          submitted: false,
        });
        continue;
      }

      const production = metadata.google_play?.track === "production";
      const submission = await this.publisherJson(`${base}/api/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-purpose-foundry-client": "purpose-foundry",
        },
        body: JSON.stringify({
          ...request,
          confirm: true,
          approvalToken,
          ...(production ? { confirmProduction: "PUBLISH TO PRODUCTION" } : {}),
        }),
      });
      const effective =
        submission.status === 409 &&
        submission.body.duplicate === true &&
        submission.body.result
          ? (submission.body.result as Record<string, unknown>)
          : submission.body;
      const results = Array.isArray(effective.results)
        ? (effective.results as Array<Record<string, unknown>>)
        : [];
      const accepted =
        results.length === selected.length &&
        results.every(
          (result) =>
            result.status === "success" &&
            ["processing", "submitted", "approved", "published"].includes(
              String(result.state),
            ),
        );
      if (!accepted) {
        unresolved.push(
          `One or more stores did not accept ${basename(release.path)} for processing/review.`,
        );
      }
      handoffs.push({
        artifact: release.path,
        sha256,
        upload: upload.body,
        dryRun: publisherEvidenceBody(dryRun.body),
        submission: effective,
        submitted: accepted,
      });
    }

    const report = await this.store.writeArtifact(
      project.id,
      "app-store-publisher",
      "publisher-handoff.json",
      {
        health,
        stores,
        preset: preset ?? null,
        previousSubmissions: submissions,
        releaseArtifacts,
        handoffs,
        unresolved,
      },
    );
    const submittedStores = handoffs.reduce((count, handoff) => {
      const submission = handoff.submission as
        { results?: unknown[] } | undefined;
      return (
        count +
        (handoff.submitted && Array.isArray(submission?.results)
          ? submission.results.length
          : 0)
      );
    }, 0);
    return {
      status: unresolved.length ? "needs_attention" : "completed",
      summary: unresolved.length
        ? `App Store Publisher completed ${submittedStores} store handoff(s), with ${unresolved.length} issue(s) requiring attention.`
        : `App Store Publisher checksum-verified and submitted ${submittedStores} store handoff(s).`,
      artifacts: [report, ...releaseArtifacts.map((artifact) => artifact.path)],
      evidence: {
        publisherHealthy: true,
        preset: preset?.id ?? null,
        releaseArtifacts: releaseArtifacts.length,
        uploaded: handoffs.some((handoff) => {
          const upload = handoff.upload as Record<string, unknown> | undefined;
          return typeof upload?.uploadId === "string";
        }),
        submitted:
          handoffs.length > 0 &&
          handoffs.every((handoff) => handoff.submitted === true),
        submittedStores,
        unresolved,
      },
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
        summary:
          "Watchtower needs at least one explicit PURPOSE_FOUNDRY_WATCH_URLS endpoint.",
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
            signal: AbortSignal.timeout(
              numberEnv("PURPOSE_FOUNDRY_WATCH_TIMEOUT_MS", 20_000),
            ),
          });
          return {
            url,
            ok: response.ok,
            status: response.status,
            latencyMs: Date.now() - started,
          };
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
