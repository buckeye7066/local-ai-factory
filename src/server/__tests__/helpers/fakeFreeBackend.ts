import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * fakeFreeBackend.ts — a controllable stand-in for the FCC free proxy.
 *
 * The stall detector's whole job is to tell "slow but alive" apart from
 * "wedged". You cannot prove it does that by pointing it at the real proxy,
 * because you cannot make the real proxy hang on demand — and a check that
 * cannot fail proves nothing. So the regression tests drive this fake, which
 * can produce each behaviour exactly:
 *
 *   fast          — immediate complete response
 *   dribble       — a token every `chunkEveryMs` for `chunks` chunks; the
 *                   "slow but alive" case that MUST NOT cost money
 *   slow-first    — `firstTokenDelayMs` of silence, then a normal stream; the
 *                   cold-start/queue case that MUST NOT cost money
 *   silent        — accepts the request, sends SSE headers, then nothing,
 *                   forever; the genuine wedge that MUST fail over
 *   backpressure  — N × 429, then a normal stream; MUST retry on free and
 *                   never escalate
 *
 * It also serves the out-of-band liveness surfaces (/health,
 * /admin/api/status) so a test can make the backend look alive or dead
 * independently of what the stream is doing — which is the distinction the
 * whole design rests on.
 */

export type BackendMode =
  | "fast"
  | "dribble"
  | "slow-first"
  | "silent"
  | "stall-after-first"
  | "backpressure";

export interface FakeBackendOptions {
  mode: BackendMode;
  /** dribble: gap between content deltas. */
  chunkEveryMs?: number;
  /** dribble: how many content deltas to send. */
  chunks?: number;
  /** slow-first: silence before the first stream event. */
  firstTokenDelayMs?: number;
  /** backpressure: how many 429s to serve before succeeding. */
  backpressureCount?: number;
  /** When false, /health and /admin/api/status report failure. */
  livenessOk?: boolean;
  /** Text the completed message should contain. */
  text?: string;
}

export interface FakeBackend {
  url: string;
  /** Requests to /v1/messages received so far. */
  calls: number;
  /** Change behaviour mid-test (used by the recovery test). */
  configure(opts: Partial<FakeBackendOptions>): void;
  close(): Promise<void>;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(): string {
  return sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "fake-free-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

function messageTail(): string {
  return (
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }) +
    sse("message_stop", { type: "message_stop" })
  );
}

export async function startFakeFreeBackend(
  initial: FakeBackendOptions,
): Promise<FakeBackend> {
  let opts: FakeBackendOptions = {
    chunkEveryMs: 300,
    chunks: 10,
    firstTokenDelayMs: 1000,
    backpressureCount: 2,
    livenessOk: true,
    text: "OK",
    ...initial,
  };
  let calls = 0;
  let served429 = 0;
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/health") {
      if (opts.livenessOk) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "healthy" }));
      } else {
        res.writeHead(503).end();
      }
      return;
    }
    if (url === "/admin/api/status") {
      if (opts.livenessOk) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "running", model: "fake-free-model" }));
      } else {
        res.writeHead(503).end();
      }
      return;
    }
    if (url === "/api/ps") {
      // Stands in for Ollama when a test points ollamaUrl at this server.
      if (opts.livenessOk) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "fake:latest" }] }));
      } else {
        res.writeHead(503).end();
      }
      return;
    }

    if (!url.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }

    calls += 1;

    // Drain the request body so the socket is not left half-open.
    req.resume();

    if (opts.mode === "backpressure" && served429 < (opts.backpressureCount ?? 2)) {
      served429 += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (opts.mode === "silent") {
      // Headers sent, then nothing. Ever. A wedge with no first token.
      return;
    }

    if (opts.mode === "stall-after-first") {
      // The real FCC keep-alive hang: the stream starts, emits one token, then
      // goes quiet forever while /health keeps answering 200.
      res.write(messageStart());
      res.write(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        }),
      );
      return;
    }

    const startDelay =
      opts.mode === "slow-first" ? (opts.firstTokenDelayMs ?? 1000) : 0;
    const gap = opts.mode === "dribble" ? (opts.chunkEveryMs ?? 300) : 0;
    const total = opts.mode === "dribble" ? (opts.chunks ?? 10) : 1;
    const body = opts.text ?? "OK";

    const begin = setTimeout(() => {
      timers.delete(begin);
      if (res.writableEnded) return;
      res.write(messageStart());
      res.write(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );

      let sent = 0;
      const sendOne = () => {
        if (res.writableEnded) return;
        res.write(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: sent === 0 ? body : "." },
          }),
        );
        sent += 1;
        if (sent >= total) {
          res.write(messageTail());
          res.end();
          return;
        }
        const t = setTimeout(() => {
          timers.delete(t);
          sendOne();
        }, gap);
        timers.add(t);
      };
      sendOne();
    }, startDelay);
    timers.add(begin);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return calls;
    },
    configure(next: Partial<FakeBackendOptions>) {
      opts = { ...opts, ...next };
      if (next.mode === "backpressure") served429 = 0;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
