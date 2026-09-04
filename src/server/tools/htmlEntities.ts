const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  bull: "\u2022",
  copy: "\u00a9",
  deg: "\u00b0",
  hellip: "\u2026",
  gt: ">",
  laquo: "\u00ab",
  ldquo: "\u201c",
  lsquo: "\u2018",
  lt: "<",
  mdash: "\u2014",
  middot: "\u00b7",
  nbsp: " ",
  ndash: "\u2013",
  quot: '"',
  raquo: "\u00bb",
  rdquo: "\u201d",
  reg: "\u00ae",
  rsquo: "'",
  trade: "\u2122",
};

/**
 * Decode the bounded entity set needed by fetched evidence before semantic
 * analysis. Numeric entities cover the rest of Unicode, while invalid scalar,
 * control, and noncharacter values remain literal instead of introducing
 * replacement/control text.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#([0-9]+);?|#x([0-9a-f]+);?|([a-z]+);)/gi,
    (
      entity,
      decimal: string | undefined,
      hex: string | undefined,
      named: string | undefined,
    ) => {
      if (named) return NAMED_HTML_ENTITIES[named.toLowerCase()] ?? entity;
      const codePoint = Number.parseInt(decimal ?? hex ?? "", decimal ? 10 : 16);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint)) ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
        (codePoint & 0xffff) === 0xfffe ||
        (codePoint & 0xffff) === 0xffff
      ) {
        return entity;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}
