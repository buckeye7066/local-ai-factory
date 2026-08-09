import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import type { ProviderName } from "../shared/schemas.js";

/**
 * config.ts — loads environment safely.
 *
 * SECURITY BOUNDARY:
 *  - Secrets live ONLY in this module's `secrets` object, which is never
 *    serialized or returned to any caller wholesale.
 *  - `publicConfig()` and `toHealth()` expose booleans ("configured") and
 *    non-secret settings only.
 *  - Nothing here is ever sent to a model or to the frontend.
 */

// override: true makes this project's .env authoritative. Factory Deck is a
// local-first app whose .env is the documented single source of truth for keys
// and models; without override, a stale machine-wide OPENAI_API_KEY/OPENAI_MODEL
// (or similar) silently shadows .env and the app uses the wrong key.
loadDotenv({ override: true });

function num(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function provider(value: string | undefined, fallback: ProviderName): ProviderName {
  return value === "anthropic" ||
    value === "openai" ||
    value === "stub" ||
    value === "mock"
    ? value
    : fallback;
}

/** Stable signature identifying a Factory Deck backend on /api/health. */
export const FACTORY_SERVICE_ID = "factory-deck" as const;

export interface AppConfig {
  anthropicModel: string;
  openaiModel: string;
  defaultCodeProvider: ProviderName;
  defaultReviewProvider: ProviderName;
  maxRepairLoops: number;
  maxModelCallsPerRun: number;
  /** Overall run wall-clock timeout in ms (0 = disabled). */
  runTimeoutMs: number;
  workspaceRoot: string;
  dryRunCommands: boolean;
  /**
   * Explicit approval to execute model-authored scripts (test/build/run/etc.).
   * Defaults to false: turning DRY_RUN off alone must not run untrusted code.
   */
  allowUntrustedScripts: boolean;
  /**
   * Opt-in to bind the backend on all interfaces (LAN), instead of loopback
   * only. Refused at startup unless an auth token is also configured.
   */
  bindLan: boolean;
  port: number;
}

export interface AppSecrets {
  anthropicApiKey: string;
  openaiApiKey: string;
  /** Bearer token required for any non-loopback API access. "" = none set. */
  authToken: string;
}

/** Build the typed config from process.env (pure — easy to test). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    anthropicModel: env.ANTHROPIC_MODEL || "claude-opus-4-8",
    openaiModel: env.OPENAI_MODEL || "gpt-5.5",
    defaultCodeProvider: provider(env.DEFAULT_CODE_PROVIDER, "anthropic"),
    defaultReviewProvider: provider(env.DEFAULT_REVIEW_PROVIDER, "openai"),
    maxRepairLoops: num(env.MAX_REPAIR_LOOPS, 3),
    maxModelCallsPerRun: num(env.MAX_MODEL_CALLS_PER_RUN, 30),
    // Default 10 minutes; 0 disables. Mock/offline journeys finish far sooner.
    runTimeoutMs: num(env.FACTORY_RUN_TIMEOUT_MS, 600_000),
    // Always resolved under the project root; the workspace writer enforces this too.
    workspaceRoot: resolve(process.cwd(), env.WORKSPACE_ROOT || "./workspaces"),
    dryRunCommands: bool(env.DRY_RUN_COMMANDS, true),
    allowUntrustedScripts: bool(env.ALLOW_UNTRUSTED_SCRIPTS, false),
    bindLan: bool(env.FACTORY_BIND_LAN, false),
    port: num(env.PORT, 5179),
  };
}

/** Secrets are kept apart so they are never accidentally spread into logs. */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env): AppSecrets {
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || "",
    openaiApiKey: env.OPENAI_API_KEY?.trim() || "",
    authToken: env.FACTORY_AUTH_TOKEN?.trim() || "",
  };
}

export function isAnthropicConfigured(secrets: AppSecrets): boolean {
  return secrets.anthropicApiKey.length > 0;
}

export function isOpenAiConfigured(secrets: AppSecrets): boolean {
  return secrets.openaiApiKey.length > 0;
}

/**
 * Public, secret-free view of configuration. Safe to return from /api/health
 * and to log. Notice there is no field that could carry an API key.
 */
export function toHealth(config: AppConfig, secrets: AppSecrets) {
  const anthropicConfigured = isAnthropicConfigured(secrets);
  const openaiConfigured = isOpenAiConfigured(secrets);
  const providersAvailable: ProviderName[] = ["mock", "stub"];
  if (anthropicConfigured) providersAvailable.push("anthropic");
  if (openaiConfigured) providersAvailable.push("openai");
  return {
    ok: true as const,
    // Control-plane health is independent of paid provider availability (#237).
    controlPlaneOk: true as const,
    // Marker lets a launcher confirm THIS is Factory Deck before treating an
    // occupied port as "already running" (vs. some unrelated service).
    service: FACTORY_SERVICE_ID,
    mockConfigured: true as const,
    anthropicConfigured,
    openaiConfigured,
    providersAvailable,
    anthropicModel: config.anthropicModel,
    openaiModel: config.openaiModel,
    defaultCodeProvider: config.defaultCodeProvider,
    defaultReviewProvider: config.defaultReviewProvider,
    maxRepairLoops: config.maxRepairLoops,
    maxModelCallsPerRun: config.maxModelCallsPerRun,
    runTimeoutMs: config.runTimeoutMs,
    workspaceRoot: config.workspaceRoot,
    dryRunCommands: config.dryRunCommands,
    allowUntrustedScripts: config.allowUntrustedScripts,
  };
}

/**
 * True only when a parsed /api/health payload is genuinely a Factory Deck
 * backend. Used by the launcher/EADDRINUSE path so a foreign service holding
 * the port is never mistaken for a running factory.
 */
export function isFactoryHealthPayload(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { ok?: unknown }).ok === true &&
    (payload as { service?: unknown }).service === FACTORY_SERVICE_ID
  );
}

/** Cached singletons for the running server. */
let _config: AppConfig | null = null;
let _secrets: AppSecrets | null = null;

export function getConfig(): AppConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

export function getSecrets(): AppSecrets {
  if (!_secrets) _secrets = loadSecrets();
  return _secrets;
}
