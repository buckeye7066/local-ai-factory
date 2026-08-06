import { createHash, timingSafeEqual } from "node:crypto";

/**
 * security/access.ts — network exposure + request authorization.
 *
 * Factory Deck is a single-user local app. By default the backend binds to
 * loopback only, so nothing on the LAN can read run history or generated file
 * contents. Exposing it to other devices is an explicit, token-gated opt-in:
 *  - FACTORY_BIND_LAN=1 asks to bind 0.0.0.0, but is REFUSED unless
 *    FACTORY_AUTH_TOKEN is also set (fail closed — never expose without a token).
 *  - Every non-loopback /api request must then present a matching bearer token
 *    (compared in constant time). Loopback requests are trusted as before.
 *
 * The helpers are pure so the policy can be unit-tested without a live socket.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** True when the peer address is the local machine. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return LOOPBACK.has(addr) || addr.startsWith("127.");
}

/**
 * Constant-time string comparison. We compare fixed-length SHA-256 digests so a
 * length mismatch is NOT distinguishable by an early return (which would leak
 * the token length via timing on a low-noise LAN). Both inputs always hash to
 * 32 bytes, so `timingSafeEqual` runs the same work regardless of input length.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : null;
}

export interface AccessDecision {
  ok: boolean;
  status: number;
  reason?: string;
}

/**
 * Authorize an /api request (excludes /api/health, which is unauthenticated by
 * design — see index.ts).
 *
 * FAIL CLOSED under a proxy: once a token is configured, it is required for
 * EVERY request, including loopback. Behind a local reverse-proxy/tunnel the
 * socket peer is 127.0.0.1, so a remote caller would appear as loopback —
 * trusting loopback unconditionally would let that caller bypass the token. So
 * a configured token is authoritative and loopback is not an auth bypass.
 *
 * When NO token is configured, the app is loopback-only (local-first default)
 * and loopback requests are trusted; any non-loopback request is refused.
 */
export function authorizeApiRequest(opts: {
  remoteAddress: string | undefined | null;
  authorization: string | undefined | null;
  token: string;
}): AccessDecision {
  if (opts.token) {
    const provided = bearerToken(opts.authorization);
    if (!provided || !safeEqual(provided, opts.token)) {
      return { ok: false, status: 401, reason: "Invalid or missing bearer token." };
    }
    return { ok: true, status: 200 };
  }
  // No token configured → local-first: only loopback is served.
  if (isLoopbackAddress(opts.remoteAddress)) return { ok: true, status: 200 };
  return {
    ok: false,
    status: 401,
    reason: "Remote access is disabled (no FACTORY_AUTH_TOKEN configured).",
  };
}

export interface BindDecision {
  host: string;
  lan: boolean;
  error?: string;
}

/**
 * Decide which interface to bind. Default: loopback. LAN is opt-in via
 * `bindLan` AND requires a token; asking for LAN without a token is refused
 * (returns an error and keeps the host on loopback — the caller must fail loud).
 */
export function resolveBindHost(opts: {
  bindLan: boolean;
  token: string;
}): BindDecision {
  if (!opts.bindLan) return { host: "127.0.0.1", lan: false };
  if (!opts.token) {
    return {
      host: "127.0.0.1",
      lan: true,
      error:
        "FACTORY_BIND_LAN is set but FACTORY_AUTH_TOKEN is empty — refusing to " +
        "expose Factory Deck on the LAN without a bearer token. Set " +
        "FACTORY_AUTH_TOKEN, or unset FACTORY_BIND_LAN to stay loopback-only.",
    };
  }
  return { host: "0.0.0.0", lan: true };
}
