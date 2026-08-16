import { describe, it, expect } from "vitest";
import { z } from "zod";
import { withRetry, isNonRetryable } from "../providers/types.js";

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("isNonRetryable", () => {
  it("treats 4xx client errors as non-retryable", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isNonRetryable(httpError(status))).toBe(true);
    }
  });

  it("keeps retrying rate limits, timeouts, server and network errors", () => {
    for (const status of [408, 429, 500, 529]) {
      expect(isNonRetryable(httpError(status))).toBe(false);
    }
    expect(isNonRetryable(new Error("socket hang up"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("fails fast on a 400 instead of burning backoff time", async () => {
    let calls = 0;
    await expect(
      withRetry("test", async () => {
        calls++;
        throw httpError(400);
      }),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });

  it("retries transient failures and succeeds", async () => {
    let calls = 0;
    const result = await withRetry("test", async () => {
      calls++;
      if (calls < 2) throw httpError(529);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("schema failures are not transport faults (2026-08-16)", () => {
  // Live GrantFlow slice: a ZodError escaping the repair loop was re-run by
  // withRetry as if it were a network blip — six ~60k-token paid calls
  // (~$10) for the same missing field. The repair loop already spent its
  // attempts WITH the error fed back; re-running it from scratch is pure
  // re-billing.
  it("classifies a ZodError as non-retryable", () => {
    const r = z.object({ element: z.string() }).safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(isNonRetryable(r.error)).toBe(true);
  });

  it("withRetry gives a ZodError exactly one attempt", async () => {
    let calls = 0;
    await expect(
      withRetry("test", async () => {
        calls++;
        const r = z.object({ element: z.string() }).safeParse({});
        if (!r.success) throw r.error;
        return "unreachable";
      }),
    ).rejects.toThrow(/failed after 1 attempt/);
    expect(calls).toBe(1);
  });
});
