import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "../tools/htmlEntities.js";

describe("bounded HTML entity decoding", () => {
  it("decodes named, decimal, and hexadecimal entities used by evidence text", () => {
    expect(
      decodeHtmlEntities("doesn&#39;t &amp; won&#x27;t &mdash; but isn&apos;t"),
    ).toBe("doesn't & won't &mdash; but isn't");
  });

  it.each([
    "&#0;",
    "&#1;",
    "&#x0B;",
    "&#127;",
    "&#x9F;",
    "&#xD800;",
    "&#xFDD0;",
    "&#x1FFFE;",
    "&#x110000;",
  ])("leaves unsafe numeric entity %s literal", (entity) => {
    expect(decodeHtmlEntities(`before${entity}after`)).toBe(`before${entity}after`);
  });

  it("retains semantic whitespace entities for later whitespace normalization", () => {
    expect(decodeHtmlEntities("a&#9;b&#10;c&#13;d")).toBe("a\tb\nc\rd");
  });
});
