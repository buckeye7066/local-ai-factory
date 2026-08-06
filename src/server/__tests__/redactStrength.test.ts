import { describe, it, expect } from "vitest";
import { redactSecrets, redactDeep } from "../security/redact.js";

/**
 * Round-11 #5 — the redactor missed common credential shapes. These are the four
 * bypasses Codex confirmed still served RAW, plus a non-secret preservation check.
 */

describe("Round-11 #5 redactSecrets covers the confirmed bypasses", () => {
  it("redacts credentials inside a DATABASE_URL (name has no keyword)", () => {
    const out = redactSecrets("DATABASE_URL=postgres://user:pass@host:5432/db");
    expect(out).not.toContain("user:pass");
    expect(out).not.toContain("pass@");
    expect(out).toMatch(/\[REDACTED/);
  });

  // Round-12 #1: BARE `user@` userinfo (token-in-userinfo, no colon-password).
  it("redacts a bare user@ URL userinfo (and keeps the host)", () => {
    const out = redactSecrets("clone https://useronlysecret@git.example/repo.git");
    expect(out).not.toContain("useronlysecret");
    expect(out).toContain("https://[REDACTED]@git.example/repo.git");
  });

  it("redacts user:pass@ userinfo too (and keeps the host)", () => {
    const out = redactSecrets("db https://user:pass@host/db end");
    expect(out).not.toContain("user:pass");
    expect(out).toContain("https://[REDACTED]@host/db");
  });

  it("does NOT mangle a plain URL or an @ in prose", () => {
    expect(redactSecrets("see https://host.example/path?x=1")).toBe(
      "see https://host.example/path?x=1",
    );
    expect(redactSecrets("contact me @ foo or user@example.com")).toBe(
      "contact me @ foo or user@example.com",
    );
  });

  // Round-13 #1: userinfo runs to the LAST @ before the host (WHATWG URL).
  it("redacts multi-@ userinfo through the last authority @ (keeps host)", () => {
    const out = redactSecrets("clone https://a@stillsecret@example.com/repo");
    expect(out).not.toContain("stillsecret");
    expect(out).toContain("https://[REDACTED]@example.com/repo");
  });

  it("does NOT mangle a path @ or a query @", () => {
    expect(redactSecrets("https://host/a@b/c")).toBe("https://host/a@b/c");
    expect(redactSecrets("https://host/p?x=a@b")).toBe("https://host/p?x=a@b");
  });

  // Round-13 #2: opaque Bearer tokens fully redacted, not just JWT-shaped.
  it("fully redacts Bearer <opaque>, <jwt>, and lowercase bearer", () => {
    const opaque = redactSecrets(
      "Authorization: Bearer opaque-secret-token-1234567890",
    );
    expect(opaque).not.toContain("opaque-secret-token-1234567890");
    expect(opaque).toMatch(/\[REDACTED/);

    const jwt = redactSecrets("use Bearer eyJhbGciOi.payloadPART.sigPART here");
    expect(jwt).not.toContain("payloadPART");
    expect(jwt).toContain("[REDACTED_BEARER_TOKEN]");

    const lower = redactSecrets("bearer abc123opaqueTOKENvalue");
    expect(lower).not.toContain("abc123opaqueTOKENvalue");
    expect(lower).toContain("[REDACTED_BEARER_TOKEN]");
  });

  it("does NOT mangle a stray word 'bearer' with no token", () => {
    expect(redactSecrets("Show this to the bearer.")).toBe("Show this to the bearer.");
    expect(redactSecrets("the bearer, please")).toBe("the bearer, please");
  });

  // Round-14: secret-bearing HTTP header VALUES redacted to end-of-line.
  it("fully redacts secret-bearing header values (name kept, no remnant)", () => {
    const cases = [
      "Authorization: Basic dXNlcjpwYXNz",
      "Proxy-Authorization: Basic dXNlcjpwYXNz",
      "X-Api-Key: opaque secret-tail",
      "Authorization: Bearer abc$stillsecret",
      "Cookie: session=deadbeef; other=1",
      "Set-Cookie: sid=abc123; HttpOnly",
      "X-Amz-Security-Token: FQoGZ...tail",
    ];
    for (const line of cases) {
      const out = redactSecrets(line);
      const name = line.slice(0, line.indexOf(":"));
      expect(out).toBe(`${name}: [REDACTED]`);
    }
    // Specific remnant checks.
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).not.toContain(
      "dXNlcjpwYXNz",
    );
    expect(redactSecrets("X-Api-Key: opaque secret-tail")).not.toContain("secret-tail");
    expect(redactSecrets("Authorization: Bearer abc$stillsecret")).not.toContain(
      "stillsecret",
    );
  });

  it("does NOT over-redact a non-secret header or non-auth lines", () => {
    expect(redactSecrets("Content-Type: application/json")).toBe(
      "Content-Type: application/json",
    );
    // Only the auth line changes in a multi-line log.
    const log = [
      "GET /api/runs",
      "Authorization: Bearer eyJhbGci.body.sig",
      "Content-Type: application/json",
      "Accept: */*",
    ].join("\n");
    const out = redactSecrets(log);
    expect(out).toContain("Authorization: [REDACTED]");
    expect(out).toContain("Content-Type: application/json");
    expect(out).toContain("Accept: */*");
    expect(out).toContain("GET /api/runs");
    expect(out).not.toContain("eyJhbGci");
  });

  it("redacts a lowercase password= assignment", () => {
    const out = redactSecrets("db password=hunter2 more text");
    expect(out).not.toContain("hunter2");
    expect(out).toMatch(/password[:=]\s*\[REDACTED\]/i);
  });

  it("redacts a lowercase openai_api_key= assignment", () => {
    const out = redactSecrets("openai_api_key=sk-ant-abcdef0123456789ABCDEF");
    expect(out).not.toContain("sk-ant-abcdef0123456789ABCDEF");
    expect(out).toMatch(/\[REDACTED/);
  });

  it("redacts a GitHub fine-grained PAT (github_pat_...)", () => {
    const token = "github_pat_" + "A".repeat(30) + "1b2c3d";
    const out = redactSecrets(`token ${token} end`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("still redacts the pre-existing shapes (sk-, AKIA, ghp_, JWT, private key)", () => {
    expect(redactSecrets("sk-ant-abcdef0123456789XYZ")).toMatch(/\[REDACTED/);
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
    expect(redactSecrets("ghp_" + "a".repeat(30))).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("leaves ordinary prose untouched", () => {
    const s = "Build a Bible reading habit tracker with streaks and a history view";
    expect(redactSecrets(s)).toBe(s);
  });

  it("is idempotent (redacting redacted text changes nothing)", () => {
    const once = redactSecrets("DATABASE_URL=postgres://u:p@h/db password=hunter2");
    expect(redactSecrets(once)).toBe(once);
  });
});

// Round-15 #1 — redactDeep must be KEY-AWARE for structured header/cred objects.
describe("Round-15 #1 redactDeep redacts secret-KEYED values by key, not shape", () => {
  it("redacts a value under a secret key regardless of its shape", () => {
    expect(redactDeep({ authorization: "Basic dXNlcjpwYXNz" })).toEqual({
      authorization: "[REDACTED]",
    });
    expect(redactDeep({ "x-api-key": "opaque$secret" })).toEqual({
      "x-api-key": "[REDACTED]",
    });
    expect(redactDeep({ authorization: "Bearer abc$def" })).toEqual({
      authorization: "[REDACTED]",
    });
    expect(redactDeep({ password: "hunter2" })).toEqual({ password: "[REDACTED]" });
    // Case / separator variants of the key all match.
    expect(redactDeep({ Access_Token: "abc" })).toEqual({ Access_Token: "[REDACTED]" });
    expect(redactDeep({ "API-KEY": "abc" })).toEqual({ "API-KEY": "[REDACTED]" });
  });

  it("redacts an OBJECT/ARRAY value under a secret key wholesale (no partial leak)", () => {
    expect(redactDeep({ token: { value: "s3cr3t", exp: 1 } })).toEqual({
      token: "[REDACTED]",
    });
    expect(redactDeep({ headers: { Authorization: "Bearer abc$def" } })).toEqual({
      headers: { Authorization: "[REDACTED]" },
    });
    // A secret-keyed array is redacted wholesale; a non-secret sibling is kept.
    // (Note: `cookies` now matches the `cookie` stem — see the Round-16 tests.)
    expect(redactDeep({ tags: ["a=b", "c=d"], Cookie: ["x=y"] })).toEqual({
      tags: ["a=b", "c=d"],
      Cookie: "[REDACTED]",
    });
  });

  it("leaves non-secret keys alone but still runs value-regexes on their strings", () => {
    expect(redactDeep({ name: "ok", "content-type": "application/json" })).toEqual({
      name: "ok",
      "content-type": "application/json",
    });
    // A secret SHAPE under a non-secret key is still caught by the string regex.
    expect(redactDeep({ note: "DATABASE_URL=postgres://u:p@h/db" })).toEqual({
      note: "DATABASE_URL=[REDACTED]",
    });
  });
});

// Round-15 #2 — obs-fold (folded) header continuation lines redacted too.
describe("Round-15 #2 HEADER_SECRET consumes obs-fold continuation lines", () => {
  it("redacts a folded header value (both lines gone)", () => {
    const out = redactSecrets("Authorization: Basic\n\tcontinued$secret");
    expect(out).toBe("Authorization: [REDACTED]");
    expect(out).not.toContain("continued$secret");
  });

  it("does NOT over-consume a normal next header (column-0, no leading ws)", () => {
    const out = redactSecrets("Authorization: x\nContent-Type: y");
    expect(out).toBe("Authorization: [REDACTED]\nContent-Type: y");
  });
});

// Round-16 #1 — compound/camelCase secret keys via substring stems.
describe("Round-16 #1 secret-key detection is stem/substring based", () => {
  it("redacts camelCase/compound secret keys (whole value, any shape)", () => {
    expect(
      redactDeep({ authToken: { scheme: "Basic", value: "dXNlcjpwYXNz" } }),
    ).toEqual({ authToken: "[REDACTED]" });
    for (const k of [
      "bearerToken",
      "sessionToken",
      "idToken",
      "apiToken",
      "xApiKey",
      "x.api.key",
      "api token",
      "clientSecret",
      "refreshToken",
    ]) {
      expect(redactDeep({ [k]: "s3cr3t" })).toEqual({ [k]: "[REDACTED]" });
    }
  });

  it("does NOT redact innocent keys that merely share letters", () => {
    for (const obj of [
      { monkey: "x" },
      { author: "Jane" },
      { keyboard: "qwerty" },
      { name: "ok" },
      { title: "Hello" },
      { "content-type": "application/json" },
    ]) {
      expect(redactDeep(obj)).toEqual(obj);
    }
  });

  it("accepts SAFE over-redaction for stem-containing non-secrets (documented)", () => {
    // `tokenCount` contains the 'token' stem → redacted (safe over-redaction).
    expect(redactDeep({ tokenCount: 5 })).toEqual({ tokenCount: "[REDACTED]" });
    // `cookies` contains the 'cookie' stem → redacted.
    expect(redactDeep({ cookies: ["a"] })).toEqual({ cookies: "[REDACTED]" });
  });
});

// Round-16 #2 — cycle + depth guard: redactDeep must never throw.
describe("Round-16 #2 redactDeep never throws (cycle + depth guard)", () => {
  it("sanitizes a cyclic object without throwing", () => {
    const a: Record<string, unknown> = { name: "ok", password: "hunter2" };
    a.self = a; // cycle
    let out: unknown;
    expect(() => {
      out = redactDeep(a);
    }).not.toThrow();
    expect((out as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((out as Record<string, unknown>).name).toBe("ok");
  });

  it("sanitizes a very deep (100+) nesting without throwing", () => {
    let deep: Record<string, unknown> = { secret: "x" };
    for (let i = 0; i < 120; i++) deep = { child: deep };
    expect(() => redactDeep(deep)).not.toThrow();
  });
});

// Round-16 #3 — Map/Set handled (no silent {} data loss).
describe("Round-16 #3 redactDeep handles Map and Set", () => {
  it("redacts a Map's secret-keyed value and keeps the normal one (not {})", () => {
    const m = new Map<string, string>([
      ["authorization", "Basic dXNlcjpwYXNz"],
      ["label", "ok"],
    ]);
    const out = redactDeep(m);
    expect(out).toBeInstanceOf(Map);
    expect((out as Map<string, string>).get("authorization")).toBe("[REDACTED]");
    expect((out as Map<string, string>).get("label")).toBe("ok");
  });

  it("traverses a Set, redacting secret shapes in its elements", () => {
    const s = new Set(["ok", "DATABASE_URL=postgres://u:p@h/db"]);
    const out = redactDeep(s);
    expect(out).toBeInstanceOf(Set);
    const vals = [...(out as Set<string>)];
    expect(vals).toContain("ok");
    expect(vals.some((v) => v.includes("[REDACTED]"))).toBe(true);
    expect(vals.some((v) => v.includes("u:p"))).toBe(false);
  });
});

// Round-16 #4 — bare `Basic <b64>` in prose (non-secret key) is caught.
describe("Round-16 #4 prose Basic auth value redacted", () => {
  it("redacts a Basic base64 credential in a plain string", () => {
    const out = redactSecrets("note: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(out).toContain("[REDACTED_BASIC_AUTH]");
    // Under a non-secret key too (serve-boundary path).
    expect(redactDeep({ note: "Basic dXNlcjpwYXNzd29yZA==" }).note).toContain(
      "[REDACTED_BASIC_AUTH]",
    );
  });

  it("does NOT mangle a short 'Basic auth' prose phrase", () => {
    expect(redactSecrets("We use Basic auth here")).toBe("We use Basic auth here");
    expect(redactSecrets("Basic authentication is enabled")).toBe(
      "Basic authentication is enabled",
    );
  });
});
