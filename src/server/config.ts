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
  return value === "free" ||
    value === "anthropic" ||
    value === "openai" ||
    value === "stub" ||
    value === "mock"
    ? value
    : fallback;
}

/**
 * The FREE local route — the FCC proxy that "Claude Code - FREE (Ollama)"
 * turns on. This is the DEFAULT primary for every live run; Anthropic and
 * OpenAI exist only as a rescue tier for when it is genuinely wedged.
 */
export interface FreeRouteSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  /** Only used for out-of-band liveness evidence, never for model calls. */
  ollamaUrl: string;
  /** Mirrors the proxy's PROVIDER_MAX_CONCURRENCY; drives queue patience. */
  maxConcurrency: number;
  /** How long to skip the free route after a PROVEN stall. */
  holdMs: number;
  /** Free attempts for ordinary (non-stall) failures before rescuing. */
  attempts: number;
  /** Spacing between free attempts; matches the proxy's rate window. */
  retrySpacingMs: number;
  /** Cap on patient retries when the backend reports backpressure. */
  maxBackpressureRetries: number;
  /** Restart fcc-server when the proxy is found dead. */
  autoRestart: boolean;
}

/** Stable signature identifying a Factory Deck backend on /api/health. */
export const FACTORY_SERVICE_ID = "factory-deck" as const;

export interface AppConfig {
  free: FreeRouteSettings;
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
   * Real, keyless web-research step (search + fetch, no API key) between
   * architecture and task planning. Defaults ON for real usage — "insert
   * this as a real step... not a decorative feature nobody actually calls."
   * Tests default it OFF (see vitest.config.ts) so `npm test` stays
   * network-independent; demo runs skip it regardless of this flag.
   */
  enableResearch: boolean;
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
  /**
   * Bearer token the local FCC proxy expects. Not a paid credential — it
   * gates a loopback service — but it is handled like one so it can never be
   * logged or served.
   */
  freeAuthToken: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  /** Bearer token required for any non-loopback API access. "" = none set. */
  authToken: string;
}

/** Build the typed config from process.env (pure — easy to test). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    free: {
      enabled: bool(env.FACTORY_FREE_ENABLED, true),
      baseUrl: env.FACTORY_FREE_BASE_URL || "http://127.0.0.1:8082",
      // A Claude-shaped id the proxy maps onto its free backend. "sonnet" lands
      // on the proxy's MODEL_SONNET tier (glm-5.2 here) rather than the much
      // weaker haiku tier — verified live 2026-08-11.
      model: env.FACTORY_FREE_MODEL || "claude-sonnet-4-5",
      ollamaUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      maxConcurrency: num(env.FACTORY_FREE_MAX_CONCURRENCY, 2),
      holdMs: num(env.FACTORY_FREE_HOLD_MS, 300_000),
      attempts: num(env.FACTORY_FREE_ATTEMPTS, 3),
      retrySpacingMs: num(env.FACTORY_FREE_RETRY_SPACING_MS, 6_000),
      maxBackpressureRetries: num(env.FACTORY_FREE_BACKPRESSURE_RETRIES, 20),
      autoRestart: bool(env.FACTORY_FREE_AUTORESTART, true),
    },
    anthropicModel: env.ANTHROPIC_MODEL || "claude-opus-4-8",
    openaiModel: env.OPENAI_MODEL || "gpt-5.5",
    // FREE-PRIMARY. The paid providers are a rescue tier, never the default —
    // a config that defaults to paid is the exact failure this deck guards
    // against.
    defaultCodeProvider: provider(env.DEFAULT_CODE_PROVIDER, "free"),
    defaultReviewProvider: provider(env.DEFAULT_REVIEW_PROVIDER, "free"),
    maxRepairLoops: num(env.MAX_REPAIR_LOOPS, 3),
    maxModelCallsPerRun: num(env.MAX_MODEL_CALLS_PER_RUN, 30),
    // Sized for the FREE route, which is the default primary. A single free
    // call measured 128-302s here (cold start + queue), and a run makes up to
    // MAX_MODEL_CALLS_PER_RUN of them, so the old 10-minute default would have
    // killed almost every free run mid-assembly — and the "fix" for that would
    // have been to go back to paid. 0 disables. Mock/offline journeys finish in
    // seconds regardless.
    runTimeoutMs: num(env.FACTORY_RUN_TIMEOUT_MS, 14_400_000),
    // Always resolved under the project root; the workspace writer enforces this too.
    workspaceRoot: resolve(process.cwd(), env.WORKSPACE_ROOT || "./workspaces"),
    dryRunCommands: bool(env.DRY_RUN_COMMANDS, true),
    enableResearch: bool(env.FACTORY_RESEARCH_ENABLED, true),
    allowUntrustedScripts: bool(env.ALLOW_UNTRUSTED_SCRIPTS, false),
    bindLan: bool(env.FACTORY_BIND_LAN, false),
    port: num(env.PORT, 5179),
  };
}

/** Secrets are kept apart so they are never accidentally spread into logs. */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env): AppSecrets {
  return {
    freeAuthToken:
      env.FACTORY_FREE_AUTH_TOKEN?.trim() ||
      env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      "freecc",
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
export function isFreeConfigured(config: AppConfig): boolean {
  return config.free.enabled && config.free.baseUrl.length > 0;
}

export function toHealth(config: AppConfig, secrets: AppSecrets, route?: unknown) {
  const anthropicConfigured = isAnthropicConfigured(secrets);
  const openaiConfigured = isOpenAiConfigured(secrets);
  const freeConfigured = isFreeConfigured(config);
  const providersAvailable: ProviderName[] = ["mock", "stub"];
  if (freeConfigured) providersAvailable.push("free");
  if (anthropicConfigured) providersAvailable.push("anthropic");
  if (openaiConfigured) providersAvailable.push("openai");
  return {
    freeConfigured,
    freeBaseUrl: config.free.baseUrl,
    freeModel: config.free.model,
    ...(route ? { route } : {}),
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
