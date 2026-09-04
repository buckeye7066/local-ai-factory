import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import type { ProviderName } from "../shared/schemas.js";
import { isSupportedFableOrOpusModel } from "./orchestrator/readinessModels.js";

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

export type ModelLadderProvider = "anthropic" | "openai" | "free";

export const DEFAULT_ANTHROPIC_MODEL_LADDER = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
] as const;

export const DEFAULT_OPENAI_MODEL_LADDER = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

function modelIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function modelLadder(value: string | undefined): ModelLadderProvider[] {
  const requested = (value ?? "")
    .split(/[;,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(
      (entry): entry is Exclude<ModelLadderProvider, "free"> =>
        entry === "anthropic" || entry === "openai",
    );
  const paid = [...new Set([...requested, "anthropic", "openai"])] as Exclude<
    ModelLadderProvider,
    "free"
  >[];
  // Free/local rotation is one final rung, never a separate owner-selected
  // route and never ahead of a configured paid model.
  return [...paid, "free"];
}

/**
 * The final free/local ladder rung — the FCC proxy that "Claude Code - FREE
 * (Ollama)" turns on. It is never an owner-selected route and never precedes a
 * configured paid model.
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
  /**
   * Strongest-to-weakest Anthropic model order inside the paid Anthropic rung.
   * Optional for compatibility with embedders that construct AppConfig directly.
   */
  anthropicModels?: string[];
  openaiModel: string;
  /**
   * Strongest-to-weakest OpenAI model order inside the single paid ladder.
   * Optional for compatibility with embedders that construct AppConfig directly.
   */
  openaiModels?: string[];
  /** OpenAI model used when the unified readiness ladder reaches OpenAI. */
  solModel: string;
  /** Legacy Anthropic readiness preference retained for configuration compatibility. */
  fableOrOpusModel: string;
  /**
   * Strongest-to-weakest provider order. Optional only for compatibility with
   * tests/embedders that construct AppConfig directly.
   */
  modelLadder?: ModelLadderProvider[];
  /** Legacy fields retained for stored configuration compatibility. */
  defaultCodeProvider: ProviderName;
  defaultReviewProvider: ProviderName;
  maxRepairLoops: number;
  maxModelCallsPerRun: number;
  /** Overall run wall-clock timeout in ms (0 = disabled). */
  runTimeoutMs: number;
  workspaceRoot: string;
  /**
   * Real, keyless web-research step (search + fetch, no API key) between
   * architecture and task planning. Defaults ON for real usage — "insert
   * this as a real step... not a decorative feature nobody actually calls."
   * Tests default it OFF (see vitest.config.ts) so `npm test` stays
   * network-independent; demo runs skip it regardless of this flag.
   */
  enableResearch: boolean;
  /**
   * Execute repository/model-authored scripts without an OS filesystem
   * sandbox. Defaults FALSE: cwd validation is not a write jail, and a test can
   * otherwise modify sibling workspaces or host files. Explicit opt-in remains
   * available for owners who run Factory Deck inside their own container/VM.
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
  const anthropicModel = env.ANTHROPIC_MODEL || "claude-fable-5-1";
  const requestedAnthropicModels = modelIds(env.FACTORY_ANTHROPIC_MODEL_LADDER);
  const anthropicModels = requestedAnthropicModels.length
    ? [...new Set(requestedAnthropicModels)]
    : [...new Set([anthropicModel, ...DEFAULT_ANTHROPIC_MODEL_LADDER])];
  const openaiModel = env.OPENAI_MODEL || "gpt-6-astra";
  const requestedOpenAiModels = modelIds(env.FACTORY_OPENAI_MODEL_LADDER);
  const openaiModels = requestedOpenAiModels.length
    ? [...new Set(requestedOpenAiModels)]
    : [...new Set([openaiModel, ...DEFAULT_OPENAI_MODEL_LADDER])];
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
    anthropicModel,
    anthropicModels,
    openaiModel,
    openaiModels,
    // Readiness models are separate from ordinary build routing. Helper models
    // may build, but they can never impersonate the required production brains.
    solModel: env.FACTORY_SOL_MODEL || openaiModel,
    fableOrOpusModel: env.FACTORY_FABLE_OR_OPUS_MODEL || anthropicModel,
    // One route: paid models in explicit strength order, then the strongest
    // available free/local rotation rung. The env var changes order only; it
    // cannot create a paid-only or free-only execution path.
    modelLadder: modelLadder(env.FACTORY_MODEL_LADDER),
    // Read only for compatibility with older deployments and records.
    defaultCodeProvider: provider(env.DEFAULT_CODE_PROVIDER, "free"),
    defaultReviewProvider: provider(env.DEFAULT_REVIEW_PROVIDER, "free"),
    maxRepairLoops: num(env.MAX_REPAIR_LOOPS, 3),
    maxModelCallsPerRun: num(env.MAX_MODEL_CALLS_PER_RUN, 30),
    // Sized for the final free/local rung. A single free call measured
    // 128-302s here (cold start + queue), and an exhausted paid ladder may make
    // up to MAX_MODEL_CALLS_PER_RUN of them. 0 disables. Mock/offline journeys
    // finish in seconds regardless.
    runTimeoutMs: num(env.FACTORY_RUN_TIMEOUT_MS, 14_400_000),
    // Always resolved under the project root; the workspace writer enforces this too.
    workspaceRoot: resolve(process.cwd(), env.WORKSPACE_ROOT || "./workspaces"),
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

/** Backward-compatible export backed by the explicit readiness model class. */
export function isFableOrOpusModel(model: string): boolean {
  return isSupportedFableOrOpusModel(model);
}

/** Mandatory non-demo readiness floor for the single paid model ladder. */
export function readinessBrainFloor(config: AppConfig, secrets: AppSecrets) {
  const solConfigured =
    isOpenAiConfigured(secrets) && config.solModel.trim().length > 0;
  const fableOrOpusModels = [
    ...new Set([
      config.fableOrOpusModel,
      ...(config.anthropicModels ?? [config.anthropicModel]),
    ]),
  ].filter(isSupportedFableOrOpusModel);
  const fableOrOpusConfigured =
    isAnthropicConfigured(secrets) && fableOrOpusModels.length > 0;
  const anthropicConfigured =
    isAnthropicConfigured(secrets) &&
    (config.anthropicModels ?? [config.anthropicModel]).some(
      (model) => model.trim().length > 0,
    );
  const openaiConfigured = solConfigured;
  const paidProviders = (config.modelLadder ?? ["anthropic", "openai", "free"]).filter(
    (name): name is "anthropic" | "openai" =>
      (name === "anthropic" && anthropicConfigured) ||
      (name === "openai" && openaiConfigured),
  );
  return {
    configured: paidProviders.length > 0,
    paidProviders,
    anthropicConfigured,
    openaiConfigured,
    // Legacy diagnostic fields remain truthful while stored clients age out.
    solConfigured,
    fableOrOpusConfigured,
    solModel: config.solModel,
    fableOrOpusModel: config.fableOrOpusModel,
    fableOrOpusModels,
  };
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
  const brainFloor = readinessBrainFloor(config, secrets);
  const providersAvailable: ProviderName[] = ["mock", "stub"];
  if (freeConfigured) providersAvailable.push("free");
  if (anthropicConfigured) providersAvailable.push("anthropic");
  if (openaiConfigured) providersAvailable.push("openai");
  const modelLadder = (config.modelLadder ?? ["anthropic", "openai", "free"]).filter(
    (name) => providersAvailable.includes(name),
  );
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
    // The singular compatibility field names the model actually tried first,
    // never a legacy ANTHROPIC_MODEL excluded by the explicit ladder.
    anthropicModel: config.anthropicModels?.[0] ?? config.anthropicModel,
    anthropicModels: config.anthropicModels ?? [config.anthropicModel],
    openaiModel: config.openaiModels?.[0] ?? config.openaiModel,
    openaiModels: config.openaiModels ?? [config.openaiModel],
    mandatoryProductionReadiness: true as const,
    readinessBrainFloorConfigured: brainFloor.configured,
    readinessPaidProviders: brainFloor.paidProviders,
    solConfigured: brainFloor.solConfigured,
    fableOrOpusConfigured: brainFloor.fableOrOpusConfigured,
    solModel: brainFloor.solModel,
    fableOrOpusModel: brainFloor.fableOrOpusModel,
    modelLadder,
    ownerExternalMatters: "owner-managed-outside-cyberland" as const,
    defaultCodeProvider: config.defaultCodeProvider,
    defaultReviewProvider: config.defaultReviewProvider,
    maxRepairLoops: config.maxRepairLoops,
    maxModelCallsPerRun: config.maxModelCallsPerRun,
    runTimeoutMs: config.runTimeoutMs,
    workspaceRoot: config.workspaceRoot,
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
