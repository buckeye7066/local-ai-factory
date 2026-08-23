import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PaidFirstOneRoundProvider } from "../providers/paidFirst.js";
import { ProviderAbortError } from "../providers/types.js";
import type { LLMProvider } from "../../shared/types.js";

function fake(name: "anthropic" | "free", behaviour: () => unknown): LLMProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    isConfigured: () => true,
    generateText: async () => {
      p.calls += 1;
      const out = behaviour();
      return { text: String(out), provider: name };
    },
    generateJson: async () => {
      p.calls += 1;
      return behaviour();
    },
  };
  return p as unknown as LLMProvider & { calls: number };
}

const json = { system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }), schemaName: "Probe" };

describe("auto mode critical stage: paid first, ONE round, then free", () => {
  it("serves from paid when the single paid attempt succeeds; free is never called", async () => {
    const paid = fake("anthropic", () => ({ ok: true }));
    const free = fake("free", () => ({ ok: false }));
    const lines: string[] = [];
    const p = new PaidFirstOneRoundProvider(paid, free, (m) => lines.push(m));
    expect(await p.generateJson(json)).toEqual({ ok: true });
    expect(paid.calls).toBe(1);
    expect(free.calls).toBe(0);
    expect(lines.join("\n")).toMatch(/paid first: anthropic served Probe/);
  });

  it("falls to free after ONE failed or refused paid attempt — never a second paid try", async () => {
    const paid = fake("anthropic", () => {
      throw new Error("paid rescue budget exhausted: 24/day");
    });
    const free = fake("free", () => ({ ok: true }));
    const lines: string[] = [];
    const p = new PaidFirstOneRoundProvider(paid, free, (m) => lines.push(m));
    expect(await p.generateJson(json)).toEqual({ ok: true });
    expect(paid.calls).toBe(1);
    expect(free.calls).toBe(1);
    expect(lines.join("\n")).toMatch(/fell to free for Probe after paid rescue budget exhausted/);
    // The next CALL gets its own single paid round again (one round per call).
    await p.generateJson(json);
    expect(paid.calls).toBe(2);
    expect(free.calls).toBe(2);
  });

  it("a cancel/deadline abort on the paid attempt propagates — the run is not continued on free", async () => {
    const paid = fake("anthropic", () => {
      throw new ProviderAbortError("cancelled");
    });
    const free = fake("free", () => ({ ok: true }));
    const p = new PaidFirstOneRoundProvider(paid, free);
    await expect(p.generateJson(json)).rejects.toBeInstanceOf(ProviderAbortError);
    expect(free.calls).toBe(0);
  });

  it("generateText follows the same one-round rule", async () => {
    const paid = fake("anthropic", () => {
      throw new Error("503 overloaded");
    });
    const free = fake("free", () => "free text");
    const p = new PaidFirstOneRoundProvider(paid, free);
    expect((await p.generateText({ system: "s", prompt: "p" })).text).toBe("free text");
    expect(paid.calls).toBe(1);
    expect(free.calls).toBe(1);
  });
});
