/**
 * First-class client for the Program Scout service implemented in RepoRewards.
 *
 * The client creates a durable Scout job, recovers an already-active job, and
 * polls the service until it has produced a verified branch or a terminal
 * failure. It never turns a mention, a 202 response, or a partial research
 * record into completed evidence.
 */

export type ProgramScoutJobStatus =
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "cancelled";

export interface ProgramScoutSource {
  url: string;
  title: string;
  kind: "target" | "documentation" | "external" | "open-source";
  excerpt: string;
  retrievedAt: string;
}

export interface ProgramScoutCapability {
  id: string;
  name: string;
  description: string;
  priority: "core" | "important" | "supporting";
  roles: string[];
  acceptanceCriteria: string[];
  evidenceUrls: string[];
}

export interface ProgramScoutJob {
  id: string;
  targetUrl: string;
  normalizedUrl: string;
  targetHost: string;
  programSlug: string;
  status: ProgramScoutJobStatus;
  stage: string;
  progress: number;
  branchName: string | null;
  headSha: string | null;
  research: {
    programName: string;
    description: string;
    sources: ProgramScoutSource[];
    openSourceReferences: Array<{
      fullName: string;
      url: string;
      description: string | null;
      commitSha: string | null;
      evidencePaths: string[];
    }>;
  } | null;
  specification: {
    purpose: string;
    intendedUsers: string[];
    roles: string[];
    capabilities: ProgramScoutCapability[];
    workflows: Array<{
      name: string;
      steps: string[];
      capabilityIds: string[];
    }>;
    integrations: Array<{ name: string; purpose: string; required: boolean }>;
    unknowns: string[];
    cleanRoomNotice: string;
  } | null;
  verification: {
    state: "pending" | "passed" | "failed";
    commitSha: string;
    requiredChecks: string[];
    passedChecks: string[];
    failedChecks: string[];
    checkedAt: string;
  } | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface ProgramScoutConfiguration {
  endpoints: string[];
  token: string;
  configured: boolean;
}

export interface ProgramScoutResult {
  configured: boolean;
  endpoint: string | null;
  job: ProgramScoutJob | null;
  completed: boolean;
  reason: string;
}

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2_000_000;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function programScoutConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ProgramScoutConfiguration {
  const explicit =
    env.PURPOSE_FOUNDRY_PROGRAM_SCOUT_URL?.trim() ||
    env.FACTORY_PROGRAM_SCOUT_URL?.trim();
  const endpoints = explicit
    ? [trimSlash(explicit)]
    : [
        "http://127.0.0.1:3000",
        trimSlash(
          env.PURPOSE_FOUNDRY_REPO_REWARDS_URL?.trim() ||
            env.FACTORY_REPO_REWARDS_PRODUCTION_URL?.trim() ||
            "https://web-production-d7db7.up.railway.app",
        ),
      ];
  const token =
    env.PURPOSE_FOUNDRY_PROGRAM_SCOUT_TOKEN?.trim() ||
    env.FACTORY_PROGRAM_SCOUT_TOKEN?.trim() ||
    env.SCOUT_API_TOKEN?.trim() ||
    env.ADMIN_TOKEN?.trim() ||
    "";
  return {
    endpoints: [...new Set(endpoints)],
    token,
    configured: token.length > 0,
  };
}

function asJob(value: unknown): ProgramScoutJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = value as Partial<ProgramScoutJob>;
  if (
    typeof job.id !== "string" ||
    typeof job.targetUrl !== "string" ||
    !["queued", "running", "ready", "failed", "cancelled"].includes(
      String(job.status),
    )
  ) {
    return null;
  }
  return job as ProgramScoutJob;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Program Scout response exceeded 2 MB.");
  }
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Program Scout returned non-JSON HTTP ${response.status}.`);
  }
  return { status: response.status, ok: response.ok, body };
}

function sameTarget(job: ProgramScoutJob, targetUrl: string): boolean {
  const normalize = (value: string) => trimSlash(value.trim().toLowerCase());
  return (
    normalize(job.targetUrl) === normalize(targetUrl) ||
    normalize(job.normalizedUrl) === normalize(targetUrl)
  );
}

export async function runProgramScout(
  targetUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<ProgramScoutResult> {
  const env = options.env ?? process.env;
  const config = programScoutConfiguration(env);
  if (!config.configured) {
    return {
      configured: false,
      endpoint: null,
      job: null,
      completed: false,
      reason:
        "Program Scout is not configured; set PURPOSE_FOUNDRY_PROGRAM_SCOUT_TOKEN or SCOUT_API_TOKEN.",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl =
    options.sleepImpl ??
    ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const timeoutMs =
    options.timeoutMs ??
    positiveInt(env.PURPOSE_FOUNDRY_PROGRAM_SCOUT_TIMEOUT_MS, 7_200_000);
  const pollMs =
    options.pollMs ??
    positiveInt(env.PURPOSE_FOUNDRY_PROGRAM_SCOUT_POLL_MS, 5_000);
  const failures: string[] = [];

  for (const endpoint of config.endpoints) {
    let job: ProgramScoutJob | null = null;
    try {
      const created = await requestJson(
        fetchImpl,
        `${endpoint}/api/scout/jobs`,
        config.token,
        { method: "POST", body: JSON.stringify({ url: targetUrl }) },
      );
      job = asJob(created.body.job);
      if (created.status === 409) {
        const listed = await requestJson(
          fetchImpl,
          `${endpoint}/api/scout/jobs?limit=100`,
          config.token,
        );
        const jobs = Array.isArray(listed.body.jobs)
          ? listed.body.jobs
              .map(asJob)
              .filter((item): item is ProgramScoutJob => Boolean(item))
          : [];
        job =
          jobs.find(
            (item) =>
              sameTarget(item, targetUrl) &&
              (item.status === "queued" || item.status === "running"),
          ) ??
          jobs.find((item) => sameTarget(item, targetUrl)) ??
          null;
      } else if (!created.ok) {
        throw new Error(
          `HTTP ${created.status}: ${String(created.body.error ?? "job creation failed")}`,
        );
      }
      if (!job)
        throw new Error("job response did not contain a valid Scout job");

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (job.status === "ready") {
          const verified =
            job.verification?.state === "passed" &&
            Boolean(job.branchName) &&
            Boolean(job.headSha) &&
            job.verification.commitSha === job.headSha;
          return {
            configured: true,
            endpoint,
            job,
            completed: verified,
            reason: verified
              ? "Program Scout produced a verified branch from its research and specification."
              : "Program Scout reported ready without matching passed verification and branch evidence.",
          };
        }
        if (job.status === "failed" || job.status === "cancelled") {
          return {
            configured: true,
            endpoint,
            job,
            completed: false,
            reason:
              job.failureMessage ||
              `Program Scout ended ${job.status} at stage ${job.stage}.`,
          };
        }
        if (Date.now() >= deadline) {
          return {
            configured: true,
            endpoint,
            job,
            completed: false,
            reason: `Program Scout is still ${job.status} at stage ${job.stage} after the configured timeout.`,
          };
        }
        await sleepImpl(pollMs);
        const polled = await requestJson(
          fetchImpl,
          `${endpoint}/api/scout/jobs/${encodeURIComponent(job.id)}`,
          config.token,
        );
        if (!polled.ok) {
          throw new Error(
            `poll HTTP ${polled.status}: ${String(polled.body.error ?? "unknown error")}`,
          );
        }
        const next = asJob(polled.body.job);
        if (!next)
          throw new Error("poll response did not contain a valid Scout job");
        job = next;
      }
    } catch (error) {
      failures.push(
        `${endpoint}: ${String((error as Error)?.message ?? error).slice(0, 240)}`,
      );
    }
  }

  return {
    configured: true,
    endpoint: null,
    job: null,
    completed: false,
    reason: `Program Scout could not be reached (${failures.join("; ")}).`,
  };
}
