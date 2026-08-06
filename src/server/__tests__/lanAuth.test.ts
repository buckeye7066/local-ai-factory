import { describe, it, expect } from "vitest";
import {
  resolveBindHost,
  authorizeApiRequest,
  isLoopbackAddress,
  bearerToken,
  safeEqual,
} from "../security/access.js";
import { redactSecrets } from "../security/redact.js";
import { loadConfig, loadSecrets } from "../config.js";

/**
 * Round-7 finding #2 — persisted run data + generated file contents must not be
 * reachable over unauthenticated LAN HTTP. Default bind is loopback; LAN is an
 * explicit, token-gated opt-in; every remote /api request needs a bearer token;
 * and secret-shaped content is redacted before it reaches the durable log.
 */

describe("Round-7 #2 bind host is loopback-default + token-gated", () => {
  it("defaults to loopback", () => {
    expect(resolveBindHost({ bindLan: false, token: "" }).host).toBe("127.0.0.1");
    expect(resolveBindHost({ bindLan: false, token: "tok" }).host).toBe("127.0.0.1");
  });

  it("refuses to bind LAN without a token (fail closed)", () => {
    const d = resolveBindHost({ bindLan: true, token: "" });
    expect(d.host).toBe("127.0.0.1"); // did NOT open the LAN
    expect(d.error).toBeTruthy();
  });

  it("binds 0.0.0.0 only when LAN opt-in AND a token are both present", () => {
    const d = resolveBindHost({ bindLan: true, token: "secret" });
    expect(d.host).toBe("0.0.0.0");
    expect(d.error).toBeUndefined();
  });
});

describe("Round-7 #2 API authorization", () => {
  it("allows loopback requests without any token", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(ip)).toBe(true);
      expect(
        authorizeApiRequest({ remoteAddress: ip, authorization: undefined, token: "" })
          .ok,
      ).toBe(true);
    }
  });

  it("rejects remote requests with a missing/blank or wrong token (401)", () => {
    expect(
      authorizeApiRequest({
        remoteAddress: "192.168.1.50",
        authorization: undefined,
        token: "",
      }),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      authorizeApiRequest({
        remoteAddress: "192.168.1.50",
        authorization: undefined,
        token: "right",
      }),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      authorizeApiRequest({
        remoteAddress: "192.168.1.50",
        authorization: "Bearer wrong",
        token: "right",
      }),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("allows a remote request with the correct bearer token", () => {
    expect(
      authorizeApiRequest({
        remoteAddress: "192.168.1.50",
        authorization: "Bearer right",
        token: "right",
      }).ok,
    ).toBe(true);
  });

  it("parses the bearer header and compares tokens in a length-safe way", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer   xyz  ")).toBe("xyz");
    expect(bearerToken(undefined)).toBeNull();
    expect(safeEqual("a", "aa")).toBe(false);
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "diff")).toBe(false);
  });
});

// Round-9 #5 — token compare must be constant-time even across length mismatch
// (compares fixed-length digests, so no early length-based return).
describe("Round-9 #5 safeEqual is length-independent (digest compare)", () => {
  it("returns correct results for equal and unequal-length inputs", () => {
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("token-123", "token-123")).toBe(true);
    expect(safeEqual("short", "a-much-longer-token-value")).toBe(false);
    expect(safeEqual("a-much-longer-token-value", "short")).toBe(false);
    expect(safeEqual("almost", "almos")).toBe(false); // off-by-one length
  });

  it("never throws on wildly different lengths (both go through the hash path)", () => {
    expect(() => safeEqual("x", "y".repeat(10000))).not.toThrow();
    expect(safeEqual("x", "y".repeat(10000))).toBe(false);
  });
});

// Round-9 #6 — when a token is configured, loopback is NOT an auth bypass
// (a local reverse proxy makes remote callers appear as 127.0.0.1).
describe("Round-9 #6 configured token is required even on loopback", () => {
  it("401s a loopback /api request without the token when a token is set", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(
        authorizeApiRequest({
          remoteAddress: ip,
          authorization: undefined,
          token: "secret",
        }),
      ).toMatchObject({ ok: false, status: 401 });
      // Wrong token from loopback is also refused.
      expect(
        authorizeApiRequest({
          remoteAddress: ip,
          authorization: "Bearer nope",
          token: "secret",
        }),
      ).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("allows a loopback request that DOES present the correct token", () => {
    expect(
      authorizeApiRequest({
        remoteAddress: "127.0.0.1",
        authorization: "Bearer secret",
        token: "secret",
      }).ok,
    ).toBe(true);
  });

  it("keeps loopback trusted only when NO token is configured (local-first default)", () => {
    expect(
      authorizeApiRequest({
        remoteAddress: "127.0.0.1",
        authorization: undefined,
        token: "",
      }).ok,
    ).toBe(true);
  });
});

describe("Round-7 #2 config wiring", () => {
  it("reads bindLan + auth token from env", () => {
    expect(loadConfig({}).bindLan).toBe(false);
    expect(loadConfig({ FACTORY_BIND_LAN: "1" }).bindLan).toBe(true);
    expect(loadSecrets({ FACTORY_AUTH_TOKEN: "tok" }).authToken).toBe("tok");
    expect(loadSecrets({}).authToken).toBe("");
  });
});

describe("Round-7 #2 secret redaction in durable logs", () => {
  it("masks API keys, AWS keys, private keys, and .env secret assignments", () => {
    expect(redactSecrets("using sk-ant-abcdef0123456789XYZ now")).toContain(
      "[REDACTED_API_KEY]",
    );
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
    expect(redactSecrets("OPENAI_API_KEY=sk-supersecretvalue123456")).toContain(
      "[REDACTED]",
    );
    const priv =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(priv)).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("leaves ordinary prose untouched", () => {
    const s = "Build a Bible reading habit tracker with streaks and reminders";
    expect(redactSecrets(s)).toBe(s);
  });

  it("removes the secret from the output entirely", () => {
    const secret = "sk-ant-DEADBEEFdeadbeef0123456789";
    const out = redactSecrets(`token=${secret}`);
    expect(out).not.toContain(secret);
  });
});
