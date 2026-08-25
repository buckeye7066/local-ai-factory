import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  extractJson,
  salvageTruncatedJson,
  generateJsonWithRepair,
  describeZodShape,
  JsonExtractionError,
} from "../providers/types.js";

/**
 * Regression suite for the failure that killed three real runs on 2026-08-13
 * (incognito twice, iplay once), all at the architect stage:
 *
 *   Run failed: Unexpected token 'I', "I'll resea"... is not valid JSON
 *
 * The free model answered with a reasoning preamble instead of JSON.
 * `extractJson` threw from inside `callOnce`, so the schema-repair round-trip
 * that follows it never executed — a prose answer was an instant hard failure
 * with zero retries.
 */

const Shape = z.object({ overview: z.string(), risks: z.array(z.string()) });
type Shape = z.infer<typeof Shape>;

/** Build a fake provider call that replays a scripted list of responses. */
function scripted(responses: string[]) {
  const calls: { prompt: string; maxTokens: number }[] = [];
  const call = async (prompt: string, maxTokens: number): Promise<unknown> => {
    calls.push({ prompt, maxTokens });
    const text = responses[Math.min(calls.length - 1, responses.length - 1)];
    return extractJson(text);
  };
  return { call, calls };
}

const GOOD = JSON.stringify({ overview: "A local-first SPA.", risks: ["none"] });
const PROSE = "I'll research the existing architecture before proposing a design.";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson(GOOD)).toEqual({
      overview: "A local-first SPA.",
      risks: ["none"],
    });
  });

  it("still unwraps a properly fenced ```json block", () => {
    const fenced = "```json\n" + GOOD + "\n```";
    expect(extractJson(fenced)).toEqual({
      overview: "A local-first SPA.",
      risks: ["none"],
    });
  });

  it("still strips prose that merely SURROUNDS a complete JSON object", () => {
    expect(extractJson(`Here you go:\n${GOOD}\nHope that helps!`)).toEqual({
      overview: "A local-first SPA.",
      risks: ["none"],
    });
  });

  it("throws JsonExtractionError (not a bare SyntaxError) on prose with no JSON", () => {
    expect(() => extractJson(PROSE)).toThrow(JsonExtractionError);
  });
});

describe("salvageTruncatedJson", () => {
  it("recovers an array cut off mid-element", () => {
    const cut = '{"overview":"x","risks":["a","b","cc';
    expect(salvageTruncatedJson(cut)).toEqual({ overview: "x", risks: ["a", "b"] });
  });

  it("recovers a nested object cut off mid-value", () => {
    const cut =
      '{"tasks":[{"order":1,"title":"a"},{"order":2,"title":"b"},{"order":3,"ti';
    expect(salvageTruncatedJson(cut)).toEqual({
      tasks: [
        { order: 1, title: "a" },
        { order: 2, title: "b" },
      ],
    });
  });

  it("recovers a response whose ```json fence was opened but never closed", () => {
    const cut = '```json\n{"overview":"x","risks":["a","b"';
    expect(salvageTruncatedJson(cut)).toEqual({ overview: "x", risks: ["a", "b"] });
  });

  it("does not mistake a truncated string containing braces for structure", () => {
    // The cut lands inside a string that itself contains a '}'.
    const cut = '{"overview":"use } carefully","risks":["a"],"note":"unclosed { here';
    expect(salvageTruncatedJson(cut)).toEqual({
      overview: "use } carefully",
      risks: ["a"],
    });
  });

  it("recovers a response cut off INSIDE a long string value", () => {
    // The exact shape behind incognito's 23:04 failure: "Unexpected end of
    // JSON input" — a big architect response cut mid-sentence at max_tokens.
    const cut =
      '{"overview":"A local-first SPA.","frontend":"React + Vite","backend":"none","risks":["state grows unbounded"],"dataModel":"the entities are described as foll';
    expect(salvageTruncatedJson(cut)).toEqual({
      overview: "A local-first SPA.",
      frontend: "React + Vite",
      backend: "none",
      risks: ["state grows unbounded"],
    });
  });

  it("returns undefined for genuine prose (nothing to salvage)", () => {
    expect(salvageTruncatedJson(PROSE)).toBeUndefined();
  });

  it("is used by extractJson, so a truncated response parses instead of throwing", () => {
    expect(extractJson('{"overview":"x","risks":["a","b')).toEqual({
      overview: "x",
      risks: ["a"],
    });
  });
});

describe("generateJsonWithRepair", () => {
  const input = {
    system: "sys",
    prompt: "design it",
    schema: Shape,
    schemaName: "Architecture",
  };

  it("returns on the first call when the response is valid — no repair round", async () => {
    const { call, calls } = scripted([GOOD]);
    const out = await generateJsonWithRepair<Shape>({
      input,
      call,
      attempts: 3,
      baseMaxTokens: 8192,
    });
    expect(out.overview).toBe("A local-first SPA.");
    expect(calls).toHaveLength(1);
    expect(calls[0].maxTokens).toBe(8192);
  });

  it("REGRESSION: a prose-only response triggers repair instead of throwing", async () => {
    const { call, calls } = scripted([PROSE, GOOD]);
    const out = await generateJsonWithRepair<Shape>({
      input,
      call,
      attempts: 3,
      baseMaxTokens: 8192,
    });
    expect(out.risks).toEqual(["none"]);
    expect(calls).toHaveLength(2);
    // The repair prompt must name the REAL problem, not "schema validation".
    expect(calls[1].prompt).toMatch(/contained NO JSON/);
    expect(calls[1].prompt).not.toMatch(/failed schema validation/);
    // …and it must widen the budget, since narrating then being cut off is
    // exactly how a prose-only answer is produced.
    expect(calls[1].maxTokens).toBeGreaterThan(calls[0].maxTokens);
  });

  it("recovers from prose on TWO consecutive attempts (a habit, not a one-off)", async () => {
    const { call, calls } = scripted([PROSE, PROSE, GOOD]);
    const out = await generateJsonWithRepair<Shape>({
      input,
      call,
      attempts: 3,
      baseMaxTokens: 8192,
    });
    expect(out.overview).toBe("A local-first SPA.");
    expect(calls).toHaveLength(3);
  });

  it("fails LOUDLY, naming the schema, when every attempt is prose", async () => {
    const { call, calls } = scripted([PROSE]);
    await expect(
      generateJsonWithRepair<Shape>({ input, call, attempts: 3, baseMaxTokens: 8192 }),
    ).rejects.toThrow(
      /Architecture: the model returned no usable JSON after 3 attempt/,
    );
    expect(calls).toHaveLength(3);
  });

  it("still repairs a schema mismatch, with the schema-issue prompt", async () => {
    const wrongShape = JSON.stringify({ overview: 42, risks: "not-an-array" });
    const { call, calls } = scripted([wrongShape, GOOD]);
    const out = await generateJsonWithRepair<Shape>({
      input,
      call,
      attempts: 3,
      baseMaxTokens: 8192,
    });
    expect(out.risks).toEqual(["none"]);
    expect(calls[1].prompt).toMatch(/failed schema validation/);
  });

  it("throws the ZodError when the shape is still wrong on the final attempt", async () => {
    const wrongShape = JSON.stringify({ overview: 42, risks: "nope" });
    const { call } = scripted([wrongShape]);
    await expect(
      generateJsonWithRepair<Shape>({ input, call, attempts: 2, baseMaxTokens: 8192 }),
    ).rejects.toThrow(z.ZodError);
  });

  it("NEVER swallows a transport error — that belongs to the failover layer", async () => {
    let calls = 0;
    const call = async () => {
      calls++;
      throw new Error("free route stalled (no stream events for 600s)");
    };
    await expect(
      generateJsonWithRepair<Shape>({ input, call, attempts: 3, baseMaxTokens: 8192 }),
    ).rejects.toThrow(/free route stalled/);
    expect(calls).toBe(1); // propagated immediately, not retried in here
  });

  it("salvages a truncated response end-to-end when it satisfies the schema", async () => {
    const cut = '{"overview":"A local-first SPA.","risks":["a","b","cc';
    const { call, calls } = scripted([cut]);
    const out = await generateJsonWithRepair<Shape>({
      input,
      call,
      attempts: 3,
      baseMaxTokens: 8192,
    });
    expect(out.risks).toEqual(["a", "b"]);
    expect(calls).toHaveLength(1);
  });
});

/**
 * 2026-08-16, live GrantFlow slice: the competitive-selection call failed
 * validation on `selected[].element` six times (~$10 billed) because the model
 * was only ever told the schema's NAME — it had to guess the field names, and
 * required-without-default fields are exactly where guessing dies. The shape
 * now rides in the prompt on every attempt.
 */
describe("the model is shown the actual field names", () => {
  const Selection = z.object({
    summary: z.string().default(""),
    selected: z
      .array(
        z.object({
          candidateId: z.string(),
          element: z.string(),
          why: z.string().default(""),
          reuseMode: z.enum(["dependency", "reference-only"]),
        }),
      )
      .default([]),
  });

  const selInput = {
    system: "s",
    prompt: "TASK",
    schema: Selection,
    schemaName: "CompetitiveSelection",
  };

  it("describeZodShape renders literal field names, optionality, and enums", () => {
    const shape = describeZodShape(Selection);
    expect(shape).toContain('"element": string');
    expect(shape).toContain('"candidateId": string');
    expect(shape).toContain('"summary"?'); // defaulted => optional
    expect(shape).toContain('"selected"?');
    expect(shape).toContain('"dependency" | "reference-only"');
  });

  it("the FIRST attempt's prompt already carries every required field name", async () => {
    const { call, calls } = scripted([JSON.stringify({ selected: [] })]);
    await generateJsonWithRepair({
      input: selInput,
      call,
      attempts: 2,
      baseMaxTokens: 512,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("TASK");
    expect(calls[0].prompt).toContain('"element"');
    expect(calls[0].prompt).toContain('"candidateId"');
  });

  it("repair prompts keep the shape alongside the Zod issues", async () => {
    const bad = JSON.stringify({
      selected: [{ candidateId: "c1", why: "no element field" }],
    });
    const good = JSON.stringify({
      selected: [
        { candidateId: "c1", element: "profile form", reuseMode: "reference-only" },
      ],
    });
    const { call, calls } = scripted([bad, good]);
    const out = await generateJsonWithRepair<z.infer<typeof Selection>>({
      input: selInput,
      call,
      attempts: 2,
      baseMaxTokens: 512,
    });
    expect(out.selected[0].element).toBe("profile form");
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('"element"'); // the shape
    expect(calls[1].prompt).toContain("failed schema validation"); // the issues
  });

  it("a schema too deep or exotic to render degrades to no shape, never a crash", () => {
    // A self-referential schema via z.lazy has no _def.typeName we handle.
    type Node = { next?: Node };
    const Lazy: z.ZodType<Node> = z.lazy(() => z.object({ next: Lazy.optional() }));
    expect(() => describeZodShape(Lazy)).not.toThrow();
  });
});
