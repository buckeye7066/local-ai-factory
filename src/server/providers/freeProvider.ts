import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import { extractJson, generateJsonWithRepair } from "./types.js";
import {
  FreeRouteStallError,
  FreeRouteBackpressureError,
  getThresholds,
  isBackpressure,
  notePatienceGranted,
  probeLiveness,
  queueBonusGrants,
  queueDepth,
  enterFreeCall,
  exitFreeCall,
  type StallMeasurement,
} from "./freeRoute.js";

/**
 * freeProvider.ts — the FREE route: Claude-shaped calls served by the local
 * FCC proxy ("Claude Code - FREE (Ollama)"), at zero cost.
 *
 * Two hard-won implementation facts, both verified live on this host
 * (2026-08-11) — change either and the provider breaks silently:
 *
 *  1. IT MUST STREAM. The proxy answers /v1/messages with an SSE body even when
 *     `stream` is not requested. A non-streaming `messages.create` therefore
 *     "succeeds" in ~1s and returns a Message whose `model` and `content` are
 *     BOTH undefined — a silent failure, not an error. Only
 *     `messages.stream(...).finalMessage()` parses the body correctly
 *     (verified: model=z-ai/glm-5.2, content=[{type:"text",text:"OK"}]).
 *
 *  2. `apiKey` MUST BE EXPLICITLY null. The Anthropic SDK prefers
 *     ANTHROPIC_API_KEY (x-api-key) over an auth token (Bearer). This project's
 *     .env legitimately holds a real paid key for the rescue tier, so leaving
 *     the SDK to read the environment sends x-api-key to the proxy and every
 *     call 401s — surfacing as generic transport failures, not as an auth
 *     error. Passing apiKey:null plus an explicit authToken and baseURL makes
 *     the SDK ignore the environment entirely (verified: a deliberately
 *     poisoned ANTHROPIC_API_KEY in env did not break the free call).
 *
 * Liveness policy lives in freeRoute.ts; this file is where the idle-progress
 * clock actually runs.
 */

export interface FreeProviderOptions {
  baseUrl: string;
  authToken: string;
  model: string;
  /** Ollama base URL, used only for out-of-band liveness evidence. */
  ollamaUrl: string;
  /** Proxy PROVIDER_MAX_CONCURRENCY — drives queue-depth patience. */
  maxConcurrency: number;
  /** How long to wait before retrying after a backpressure signal. */
  backpressureRetryMs: number;
  enabled: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class FreeProvider implements LLMProvider {
  readonly name = "free" as const;
  private client: Anthropic | null;
  private opts: FreeProviderOptions;

  constructor(opts: FreeProviderOptions) {
    this.opts = opts;
    this.client = opts.enabled && opts.baseUrl ? this.build() : null;
  }

  private build(): Anthropic {
    return new Anthropic({
      // Explicit null + explicit authToken/baseURL: the SDK must ignore every
      // credential env var, or the paid key in .env poisons the free route.
      apiKey: null,
      authToken: this.opts.authToken,
      baseURL: this.opts.baseUrl,
      // Our own idle-progress watchdog is the timeout. The SDK's socket timer
      // resets on keep-alive bytes and so never fires on the hang we care
      // about; leaving it high just keeps it out of the way.
      timeout: 3_600_000,
      // Retries are the failover layer's job — an SDK retry would silently
      // multiply the patience budget.
      maxRetries: 0,
    });
  }

  /**
   * Drop and rebuild the HTTP client. After a stall the old connection pool
   * may still own the wedged keep-alive socket, so reusing it would make the
   * retry inherit the hang.
   */
  resetTransport(): void {
    if (this.opts.enabled && this.opts.baseUrl) this.client = this.build();
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private ensure(): Anthropic {
    if (!this.client) {
      throw new Error(
        "Free provider is not configured (FACTORY_FREE_ENABLED=0 or no base URL).",
      );
    }
    return this.client;
  }

  /**
   * Stream one call while watching for PROGRESS, not elapsed time.
   *
   * The clock resets on every parsed stream event. Note that it resets on
   * CONTENT events, not on raw socket bytes: the FCC keep-alive hang keeps
   * pushing SSE comment bytes forever while producing no content, so counting
   * bytes would mark a wedged stream as healthy. The SSE parser drops comments,
   * which makes "no stream events" exactly the right silence signal.
   */
  private async streamWithProgress(
    args: Anthropic.MessageCreateParams,
  ): Promise<Anthropic.Message> {
    const client = this.ensure();
    const t = getThresholds();
    const startedAt = Date.now();

    enterFreeCall();
    try {
      const stream = client.messages.stream(args as Anthropic.MessageStreamParams);

      let lastEventAt = Date.now();
      let sawFirstEvent = false;
      let eventCount = 0;
      stream.on("streamEvent", () => {
        lastEventAt = Date.now();
        sawFirstEvent = true;
        eventCount += 1;
      });
      // A rejected stream with no attached error handler would crash the
      // process; finalMessage() below is the real consumer of that rejection.
      stream.on("error", () => {});

      let settled = false;
      const final = stream.finalMessage().finally(() => {
        settled = true;
      });

      const watchdog = (async (): Promise<never> => {
        let patienceGrants = 0;
        const allowedGrants =
          t.maxPatienceGrants +
          queueBonusGrants(queueDepth(), this.opts.maxConcurrency);

        for (;;) {
          if (settled) {
            // finalMessage won the race; park forever so Promise.race resolves
            // on the real result rather than on this loop.
            await new Promise<never>(() => {});
          }
          const window = sawFirstEvent ? t.idleGapWindowMs : t.firstTokenWindowMs;
          const silentMs = Date.now() - lastEventAt;
          const elapsedMs = Date.now() - startedAt;

          if (elapsedMs > t.backstopMs) {
            throw new FreeRouteStallError({
              phase: "backstop",
              silentMs,
              windowMs: t.backstopMs,
              bytesReceived: eventCount,
              elapsedMs,
              patienceGrants,
              liveness: "inconclusive",
              livenessDetail: "outer backstop reached",
              queueDepth: queueDepth(),
            });
          }

          if (silentMs < window) {
            // Still inside the silence budget — sleep until it would expire,
            // capped so a stream event can reset us promptly.
            await sleep(Math.min(Math.max(window - silentMs, 50), 1000));
            continue;
          }

          // Silence budget exhausted. Do NOT fail over yet — ask the backend
          // directly whether it is alive.
          const evidence = await probeLiveness(this.opts.baseUrl, this.opts.ollamaUrl);
          if (settled) await new Promise<never>(() => {});

          const measurement: StallMeasurement = {
            phase: sawFirstEvent ? "inter-token" : "first-token",
            silentMs: Date.now() - lastEventAt,
            windowMs: window,
            bytesReceived: eventCount,
            elapsedMs: Date.now() - startedAt,
            patienceGrants,
            liveness: evidence.verdict,
            livenessDetail: evidence.detail,
            queueDepth: queueDepth(),
          };

          if (evidence.verdict === "dead") {
            // In-band silence AND out-of-band death agree. This is a wedge.
            throw new FreeRouteStallError(measurement);
          }

          // BEFORE the first token, a live backend is allowed to stay silent
          // for as long as the outer backstop permits.
          //
          // This asymmetry is the heart of the design. Pre-first-token silence
          // is cold start plus queue: measured on this host at up to 302s, and
          // there is no in-band signal to distinguish "third in line" from
          // "wedged" — the out-of-band probe is the ONLY evidence available,
          // and it says alive. Capping patience here is precisely how a deck
          // starts paying for healthy calls, so it is not capped; the backstop
          // is the safety net instead.
          if (!sawFirstEvent) {
            patienceGrants += 1;
            notePatienceGranted(
              `pre-first-token silence ${Math.round(
                measurement.silentMs / 1000,
              )}s > ${Math.round(window / 1000)}s but liveness=${evidence.verdict} ` +
                `(${evidence.detail}); this is cold-start/queue, waiting instead of paying ` +
                `[grant ${patienceGrants}, queueDepth=${measurement.queueDepth}, ` +
                `backstop ${Math.round(t.backstopMs / 1000)}s]`,
            );
            lastEventAt = Date.now();
            continue;
          }

          // AFTER the first token, patience is bounded even when the probe
          // claims health — because once a model is emitting, healthy gaps are
          // sub-second (max 244ms measured), so minutes of mid-stream silence
          // is the FCC keep-alive hang, which keeps /health answering 200
          // forever while producing nothing.
          if (patienceGrants < allowedGrants) {
            // The backend is alive (or we are unsure, which resolves toward
            // free). Wait another window and record that we nearly paid.
            patienceGrants += 1;
            notePatienceGranted(
              `${measurement.phase} silence ${Math.round(
                measurement.silentMs / 1000,
              )}s > ${Math.round(window / 1000)}s but liveness=${
                evidence.verdict
              } (${evidence.detail}); waiting instead of paying ` +
                `[grant ${patienceGrants}/${allowedGrants}, queueDepth=${measurement.queueDepth}]`,
            );
            lastEventAt = Date.now();
            continue;
          }

          // Mid-stream patience exhausted while the backend still claims to be
          // alive. Generous, counted, logged — but finite.
          throw new FreeRouteStallError(measurement);
        }
      })();

      try {
        return await Promise.race([final, watchdog]);
      } catch (err) {
        stream.abort();
        void final.catch(() => {});
        if (err instanceof FreeRouteStallError) this.resetTransport();
        throw this.classify(err);
      }
    } finally {
      exitFreeCall();
    }
  }

  /**
   * Map a raw failure onto the taxonomy the failover layer reasons about.
   * Backpressure ("alive, come back shortly") must never reach the paid tier.
   */
  private classify(err: unknown): unknown {
    if (err instanceof FreeRouteStallError) return err;
    if (isBackpressure(err)) {
      const status = (err as { status?: number })?.status;
      return new FreeRouteBackpressureError(
        status ? `HTTP ${status}` : (err as Error)?.message?.slice(0, 120) || "busy",
        this.opts.backpressureRetryMs,
      );
    }
    return err;
  }

  private textOf(msg: Anthropic.Message): string {
    return (msg.content ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const msg = await this.streamWithProgress({
      model: this.opts.model,
      max_tokens: input.maxTokens ?? 4096,
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
    });
    return { text: this.textOf(msg), provider: "free" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const system = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, or any prose outside the JSON.`;

    // THREE attempts on the free route. A local/free model answering with a
    // reasoning preamble ("I'll research the existing architecture first…")
    // instead of JSON is a HABIT, not a one-off, and a repair round-trip here
    // costs nothing — unlike a dead run, which costs the whole run.
    return generateJsonWithRepair({
      input,
      attempts: 3,
      baseMaxTokens: input.maxTokens ?? 8192,
      call: async (prompt, maxTokens) => {
        const msg = await this.streamWithProgress({
          model: this.opts.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: prompt }],
        });
        return extractJson(this.textOf(msg));
      },
    });
  }
}
