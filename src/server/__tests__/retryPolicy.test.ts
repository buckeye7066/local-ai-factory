import { describe, it, expect } from "vitest";
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
