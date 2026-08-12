import { describe, it, expect } from "vitest";
import { extractJson } from "../providers/types.js";

describe("extractJson", () => {
  it("parses a bare JSON object with no fence", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a ```json fenced object", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses a fence tagged with a non-json language (the reported bug)", () => {
    // A model that judges its own output as shell/code sometimes tags the
    // fence accordingly even when JSON was required. The language tag must
    // not end up glued to the extracted content.
    expect(extractJson('```bash\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```ts\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses JSON preceded by prose outside the fence", () => {
    expect(extractJson('Here is the result:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("still throws when the fenced content has no JSON at all", () => {
    expect(() => extractJson("```bash\nnpm install\n```")).toThrow();
  });

  it("parses unfenced JSON whose own string values contain a markdown fence (the reported bug)", () => {
    // A generated README.md's usage example ("```\nnpm install\n```") sits
    // INSIDE a JSON string value here, with no fence wrapping the response
    // itself. Scanning for the first ``` anywhere previously extracted that
    // embedded snippet instead of the real JSON object.
    const payload = {
      files: [
        {
          path: "README.md",
          contents: "## Getting Started\n\n```\nnpm install\nnpm run dev\n```\n",
        },
      ],
    };
    expect(extractJson(JSON.stringify(payload))).toEqual(payload);
  });
});
