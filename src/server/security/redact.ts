import type { RunRecord, FileContent } from "../../shared/schemas.js";

/**
 * security/redact.ts — mask secret-shaped substrings before they are persisted
 * or served over the API. A user, an injected intake, or model output can carry
 * an API key, a credential URL, or a `.env` line; redaction targets recognizable
 * credential shapes so ordinary prose is (mostly) untouched.
 *
 * Redaction runs both at WRITE time (defense-in-depth) and — authoritatively —
 * at the SERVE/LOAD boundary (`sanitizeRunRecordForServe` / `sanitizeFileRecords`)
 * so that OLD pre-fix records and locally-PLANTED raw records are scrubbed on the
 * way out regardless of when/whether they were redacted on write.
 */

const PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    label: "PRIVATE_KEY",
  },
  // Bare `Bearer <token>` appearing in FREE PROSE (not a header line — those are
  // handled whole-value by HEADER_SECRET below). Redacts the token run after the
  // keyword. BEST-EFFORT in prose: a token containing out-of-class chars (e.g.
  // `abc$def`) is only redacted up to the first out-of-class char here; the
  // header-line form is fully covered by HEADER_SECRET. Requires a token after
  // the keyword, so a stray word "bearer" (end/punctuation, no token) is safe.
  // Runs before the JWT rule so it consumes an `eyJ…` JWT too.
  { re: /\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, label: "BEARER_TOKEN" },
  // `Basic <base64>` credential appearing in FREE PROSE (header-line form is
  // covered whole-value by HEADER_SECRET). Length threshold ≥16 base64 chars so
  // a short innocent phrase like "Basic auth" is not matched.
  { re: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g, label: "BASIC_AUTH" },
  // OpenAI / Anthropic style: sk-..., sk-ant-...
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, label: "API_KEY" },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "SLACK_TOKEN" },
  // GitHub fine-grained PAT (github_pat_...) — must come before the short forms.
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "GITHUB_TOKEN" },
  // GitHub classic/other tokens (ghp_, gho_, ghs_, ghr_, ghu_)
  { re: /\bgh[posru]_[A-Za-z0-9]{20,}\b/g, label: "GITHUB_TOKEN" },
  // AWS access key id
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY" },
  // JWTs (three base64url segments)
  {
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    label: "JWT",
  },
];

/**
 * Credential-bearing URL/DSN: `scheme://<userinfo>@host…`. Strip the ENTIRE
 * userinfo (keep scheme + host), covering `user@`, `user:pass@`, and — per the
 * WHATWG URL spec — userinfo containing `@` (the userinfo runs to the LAST `@`
 * before the host), so `https://a@stillsecret@example.com/repo` →
 * `https://[REDACTED]@example.com/repo`. The run excludes `/ ? #` and whitespace
 * so it cannot cross the authority into a path/query — a plain `https://host/path`,
 * a query `?x=a@b`, or an `@` in prose is never matched. `@` IS allowed inside the
 * run so the greedy match reaches the final authority `@`.
 */
const CRED_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;

/**
 * Secret-bearing HTTP header LINES: redact the ENTIRE value (everything after the
 * colon, to end-of-line), keeping the header name. This uniformly covers `Basic`,
 * `Digest`, `Bearer` (incl. odd chars), and opaque `X-Api-Key`/`Cookie` values —
 * a keyword/token-only rule leaves the rest of the value behind. Anchored to the
 * start of a line (`^`…`$` with the `m` flag) so a header embedded mid-sentence,
 * or a non-secret header like `Content-Type:`, is not over-redacted. Runs BEFORE
 * the narrower token rules.
 *
 * OBS-FOLD (RFC 7230 deprecated line folding): the value also consumes any
 * following CONTINUATION lines that begin with whitespace (`\r?\n[ \t]+…`), so a
 * folded credential is fully redacted. A normal next header starts at column 0
 * (no leading whitespace) and is therefore not over-consumed.
 */
const HEADER_SECRET =
  /^([ \t]*(?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Api-Key|X-Amz-Security-Token|Cookie|Set-Cookie))[ \t]*:[ \t]*.+(?:\r?\n[ \t]+.+)*$/gim;

/**
 * `.env`/config-style `NAME = value` (or `NAME: value`) where NAME looks like a
 * secret. CASE-INSENSITIVE (so `password=`, `openai_api_key=` match) and covers
 * URL/URI/DSN/AUTH/SESSION names in addition to KEY/TOKEN/SECRET/PASSWORD/etc.
 */
const ENV_SECRET =
  /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|URL|URI|DSN|AUTH|SESSION)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"']+)\3/gi;

/** Return `input` with any secret-shaped substrings replaced by a placeholder. */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  // Whole-value redaction of secret-bearing header LINES first, so Basic/opaque/
  // odd-char values are fully covered before the narrower token rules run.
  out = out.replace(HEADER_SECRET, (_m, name) => `${name}: [REDACTED]`);
  for (const { re, label } of PATTERNS) out = out.replace(re, `[REDACTED_${label}]`);
  // Strip inline URL credentials (keep scheme + host).
  out = out.replace(CRED_URL, (_m, scheme) => `${scheme}[REDACTED]@`);
  // Redact secret-named assignments (value only).
  out = out.replace(ENV_SECRET, (_m, key, sep) => `${key}${sep}[REDACTED]`);
  return out;
}

/**
 * Object KEYS that name a secret regardless of the value's shape (a structured
 * header/credential object). Normalized to lowercase with `-`/`_` stripped, so
 * e.g. `Authorization`, `x-api-key`, `api_key`, `access_token` all match.
 */
const SECRET_KEYS = new Set(
  [
    "authorization",
    "proxy-authorization",
    "www-authenticate",
    "authentication",
    "cookie",
    "set-cookie",
    "set-cookie2",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
    "x-access-token",
    "access_token",
    "refresh_token",
    "x-amz-security-token",
    "private-token",
    "x-vault-token",
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "token",
    "session",
    "sessionid",
    "private_key",
    "privatekey",
  ].map((k) => k.replace(/[-_]/g, "")),
);

/**
 * Unambiguous secret STEMS: if the normalized key CONTAINS one, it is secret.
 * This catches camelCase/compound/variant keys (authToken, bearerToken,
 * sessionToken, idToken, xApiKey, `x.api.key`, "api token") that exact membership
 * misses, WITHOUT matching innocents: `monkey`/`keyboard` contain "key" but not
 * "apikey"; `author` contains "auth" but not "authorization"/"token". Chosen so
 * false positives are rare and, when they occur (e.g. `tokenCount`, `secretary`),
 * are SAFE over-redaction — accepted per the security-first policy.
 */
const SECRET_STEMS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "credential",
  "privatekey",
  "clientsecret",
  "cookie",
  "bearer",
  "sessionid",
  "accesskey",
  "authorization",
] as const;

/** Normalize a key: lowercase and strip ALL non-alphanumerics (`. _ - space` …). */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const norm = normalizeKey(key);
  if (SECRET_KEYS.has(norm)) return true; // exact header/cred names (e.g. pwd, session)
  return SECRET_STEMS.some((stem) => norm.includes(stem)); // compound/camelCase variants
}

/** Best-effort String() that never throws. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unstringifiable]";
  }
}

/** Depth beyond which we stop recursing and redact conservatively. */
const MAX_DEPTH = 40;

/**
 * Internal recursive walker with a cycle guard (`seen` = current ancestor chain,
 * added on enter / removed on exit so DAG siblings are NOT falsely flagged) and a
 * depth cap. Handles arrays, Maps, Sets, plain objects, and non-plain objects.
 */
function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return redactSecrets(value as string);
  if (t !== "object") return value; // number/boolean/bigint/function/symbol

  if (depth > MAX_DEPTH) return "[REDACTED_DEEP]"; // stop; never blow the stack
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]"; // cycle
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, depth + 1, seen));
    }
    if (value instanceof Map) {
      const m = new Map<unknown, unknown>();
      for (const [k, v] of value.entries()) {
        const secret = typeof k === "string" && isSecretKey(k);
        m.set(k, secret ? "[REDACTED]" : walk(v, depth + 1, seen));
      }
      return m;
    }
    if (value instanceof Set) {
      const s = new Set<unknown>();
      for (const v of value.values()) s.add(walk(v, depth + 1, seen));
      return s;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      // Non-plain object (Date, Buffer, class instance): don't silently empty via
      // Object.entries → {}; stringify + redact so nothing is dropped or leaked.
      return redactSecrets(safeString(value));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "[REDACTED]" : walk(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Recursively redact a JSON-like value. KEY-AWARE for objects/Maps: if a key names
 * a secret (`isSecretKey`), its ENTIRE value is replaced by the placeholder no
 * matter its shape (string/object/array) — so `{ authorization: "Basic …" }`,
 * `{ authToken: { value: "…" } }`, or a Map with a secret key can't leak parts the
 * value-regexes miss. All other keys recurse and their string values still pass
 * through `redactSecrets`. Guards against cycles and pathological depth, handles
 * Map/Set/non-plain objects, and NEVER throws. Returns a new value; input unchanged.
 */
export function redactDeep<T>(value: T): T {
  try {
    return walk(value, 0, new WeakSet<object>()) as T;
  } catch {
    return "[REDACTED]" as unknown as T;
  }
}

/**
 * SERVE-BOUNDARY sanitizer for a run record. Produces a redacted COPY (the
 * caller's canonical in-memory record is never mutated) with every
 * model/user-controlled string scrubbed: idea, appName, workspacePath, error,
 * each log message, each file summary's path/purpose, and the whole finalReport.
 * Idempotent — running it on an already-redacted record is a no-op.
 */
export function sanitizeRunRecordForServe(r: RunRecord): RunRecord {
  return {
    ...r,
    idea: redactSecrets(r.idea),
    appName: r.appName == null ? r.appName : redactSecrets(r.appName),
    workspacePath:
      r.workspacePath == null ? r.workspacePath : redactSecrets(r.workspacePath),
    error: r.error == null ? r.error : redactSecrets(r.error),
    steering: (r.steering ?? []).map((item) => ({
      ...item,
      instruction: redactSecrets(item.instruction),
    })),
    logs: r.logs.map((l) => ({ ...l, message: redactSecrets(l.message) })),
    files: r.files.map((f) => ({
      ...f,
      path: redactSecrets(f.path),
      purpose: redactSecrets(f.purpose),
    })),
    finalReport: r.finalReport == null ? r.finalReport : redactDeep(r.finalReport),
  };
}

/**
 * SERVE-BOUNDARY sanitizer for generated file-content records: redacts every
 * string field (path, purpose, contents) of each FileContent. Idempotent.
 */
export function sanitizeFileRecords(files: FileContent[]): FileContent[] {
  return files.map((f) => redactDeep(f));
}

