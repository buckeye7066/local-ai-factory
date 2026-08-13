import { describe, it, expect } from "vitest";
import { dispatchConcurrent } from "../providers/concurrentDispatcher.js";
import type { LLMProvider } from "../../shared/types.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A fake backend with a controllable, distinct latency per call. */
class FakeProvider implements LLMProvider {
  constructor(
    readonly name: "free" | "anthropic" | "openai" | "mock" | "stub",
    private latencyMs: number,
  ) {}
  isConfigured() {
    return true;
  }
  async generateText() {
    await sleep(this.latencyMs);
    return { text: `from ${this.name}`, provider: this.name };
  }
  async generateJson() {
    await sleep(this.latencyMs);
    return { from: this.name } as never;
  }
}

describe("dispatchConcurrent", () => {
  it("pulls tasks off a SHARED queue — a fast backend does more work than a slow one", async () => {
    const fast = new FakeProvider("free", 5);
    const slow = new FakeProvider("anthropic", 60);
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      run: async (p: LLMProvider) => {
        const r = await p.generateText({ system: "", prompt: "" });
        return r.provider;
      },
    }));

    const summary = await dispatchConcurrent([fast, slow], tasks);

    expect(summary.outcomes).toHaveLength(10);
    // Every provider that actually served a task shows up in the tally.
    expect(Object.keys(summary.tasksByProvider).sort()).toEqual(
      ["anthropic", "free"].sort(),
    );
    // Real concurrency proof: the fast backend, pulling from the same queue the
    // whole time, picks up strictly more tasks than the slow one — it is never
    // idle waiting for its "turn" the way a round-robin/sequential split would be.
    expect(summary.tasksByProvider.free).toBeGreaterThan(
      summary.tasksByProvider.anthropic,
    );
    expect(summary.tasksByProvider.free + summary.tasksByProvider.anthropic).toBe(10);
  });

  it("isolates a failing task without stopping the others", async () => {
    const provider = new FakeProvider("free", 1);
    const tasks = [
      { id: "ok-1", run: async () => "fine" },
      {
        id: "boom",
        run: async () => {
          throw new Error("kaboom");
        },
      },
      { id: "ok-2", run: async () => "fine" },
    ];
    const summary = await dispatchConcurrent([provider], tasks);
    const boom = summary.outcomes.find((o) => o.id === "boom");
    expect(boom?.error).toBeInstanceOf(Error);
    expect(summary.outcomes.filter((o) => !o.error)).toHaveLength(2);
  });

  it("de-dupes providers with the same name", async () => {
    const p1 = new FakeProvider("free", 1);
    const p2 = new FakeProvider("free", 1);
    const summary = await dispatchConcurrent(
      [p1, p2],
      [{ id: "t1", run: async () => "x" }],
    );
    expect(summary.tasksByProvider.free).toBe(1);
  });

  it("throws when given no providers", async () => {
    await expect(
      dispatchConcurrent([], [{ id: "t1", run: async () => "x" }]),
    ).rejects.toThrow();
  });

  it("runs a single-provider queue to completion (degenerate but correct case)", async () => {
    const provider = new FakeProvider("free", 1);
    const summary = await dispatchConcurrent(
      [provider],
      [
        { id: "a", run: async () => "a" },
        { id: "b", run: async () => "b" },
      ],
    );
    expect(summary.tasksByProvider.free).toBe(2);
    expect(summary.outcomes.map((o) => o.result).sort()).toEqual(["a", "b"]);
  });
});
