# Changelog — Portfolio Hardening (Factory Deck / `local-ai-factory`)

Date: 2026-07-18 · Not a git repo — each edited file has a `.bak-2026-07-18` sibling.
No push / publish / deploy. No generated product was executed. Priorities addressed: #4, #2+#9, #6, #12.

## Changed files (+ backups)

| File | Backup | Change |
|---|---|---|
| `src/server/workspace/commandRunner.ts` | `.bak-2026-07-18` | **#2 no inherited secrets:** `sanitizeChildEnv()` strips credential-shaped env vars (`KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/AUTH/SESSION/COOKIE`) before every child spawn; child now runs with sanitized env (was `{...process.env}`). **#4 no arbitrary exec:** `hardenArgs()` injects `--ignore-scripts` on `install`/`ci` so untrusted generated `package.json` lifecycle hooks can't run code. Both exported for tests. |
| `src/server/index.ts` | `.bak-2026-07-18` | **#12 idempotent start / no orphan:** added server `error` handler — on `EADDRINUSE` logs a clear message and exits code 0 (was an unhandled crash that orphaned the launcher's browser-poll helper). |
| `scripts/start-factory.ps1` | `.bak-2026-07-18` | **#12:** preflight idempotency guard — if `/api/health` already answers, open the running app and exit instead of spawning a duplicate backend / orphaned poller. |
| `vitest.config.ts` | `.bak-2026-07-18` | **Test isolation (supports #2/#6):** `env.FACTORY_DATA_DIR=".vitest-factory-data"` + `globalSetup` so the suite never writes into the user's real `.factory/` run history. |

## New files (no backup — additive)

| File | Purpose |
|---|---|
| `src/server/__tests__/commandEnvHardening.test.ts` | 7 tests: secret env sanitization; `--ignore-scripts` install neutralization (prompt-injection mitigation) incl. idempotency + allowlist/shell-safety; model-call budget enforcement (`ModelBudgetError`). |
| `vitest.globalSetup.ts` | Removes the throwaway test data dir before/after the suite. |
| `PORTFOLIO_AUDIT.md` | Derived contract + spec 5.15 matrix + verification. |
| `CHANGELOG_PORTFOLIO_HARDENING.md` | This file. |

## Verification

- `vitest run`: 42 passed (35 prior + 7 new). `tsc --noEmit` (server): clean. `prettier --check` changed files: clean.
- Launcher idempotency proven live: 2nd backend instance exits code 0 (`EADDRINUSE`), clean stop leaves no listener, logs contain no secret material, `.factory` unchanged (17 records) after the whole exercise.

## Not changed (already adequate — see PORTFOLIO_AUDIT.md matrix)

Path jail / canonical validation (#9), command allowlist + dry-run (#4 base), durable restart-safe run
store (#6), health booleans / redacted logs (#7/#8), local-first default (#1). No revert needed.

---

# Follow-up round — Codex review (6 defects, defense-in-depth)

Goal: turning `DRY_RUN_COMMANDS=false` must **not** open env-exfil / out-of-workspace writes / PM
shadowing. New `.bak-2026-07-18` copies were made for files not already backed up.

## Follow-up changed files (+ backups)

| File | Backup | Change |
|---|---|---|
| `src/server/workspace/commandRunner.ts` | `.bak-2026-07-18` (pristine original, kept) | **#1** `sanitizeChildEnv` rewritten to an **allowlist of safe env-var names** + drops any credential-URL value (`looksLikeCredentialUrl`) + strips workspace dirs from PATH — so `DATABASE_URL`/`MONGODB_URI`/`REDIS_URL` (names without a secret keyword) no longer reach children. **#2/#3** new `isScriptExecuting()` + **approval gate**: test/build/run/typecheck/npx refused unless `allowScriptExecution` is set (dry-run off is not enough). **#4** new `resolvePmBinary()` resolves the PM to an **absolute path from PATH dirs outside the workspace**; `spawnPm()` runs that absolute path (cmd.exe verbatim on Windows) so a planted `pnpm.cmd` can't shadow it. **#5** jail comment/logic clarified as a cwd boundary check, explicitly **not** a runtime FS sandbox. |
| `src/server/config.ts` | `.bak-2026-07-18` (new) | Added `allowUntrustedScripts` config (env `ALLOW_UNTRUSTED_SCRIPTS`, default **false**); added `service: "factory-deck"` marker + `FACTORY_SERVICE_ID` to `toHealth`; new `isFactoryHealthPayload()` predicate (**#6**). |
| `src/server/index.ts` | `.bak-2026-07-18` (pristine original, kept) | **#6** `EADDRINUSE` handler now probes `/api/health` and verifies the Factory Deck marker: exit 0 only if it's really ours, else exit **1** ("port in use by another process") instead of exiting 0 for any listener. |
| `src/server/orchestrator/runFactory.ts` | `.bak-2026-07-18` (new) | Passes `allowScriptExecution: config.allowUntrustedScripts` to `runCommand` (**#2/#3** wiring). |
| `scripts/start-factory.ps1` | `.bak-2026-07-18` (pristine original, kept) | **#6** preflight now parses `/api/health` and only treats the port as ours when `service -eq "factory-deck"`; a foreign service → clear error, exit 1, not opened. |
| `src/server/__tests__/commandShellSafety.test.ts` | (1-line test edit; original arg was `{ workspaceRoot: process.cwd(), dryRun: false }`) | Added `allowScriptExecution: true` so the shell-safety assertion is reached past the new approval gate. |

## Follow-up new files

| File | Purpose |
|---|---|
| `src/server/__tests__/commandSandbox.test.ts` | 11 tests, one+ per defect: credential-URL/DSN env drop + PATH stripping (#1); script-exec classification + approval-gate refusal of `pnpm test` with dry-run off (#2/#3); `resolvePmBinary` skips workspace shims (#4); cwd boundary behavior (#5); health-signature accept/reject (#6). |

## Follow-up verification — each defect closed

- **#1** `DATABASE_URL=postgres://user:pass@…` and `MONGODB_URI=mongodb+srv://…` are **not** in the child env (allowlist + value redaction); PATH loses workspace dirs. Test-proven.
- **#2/#3** `runCommand("pnpm test", dryRun:false)` with no approval → `executed:false, allowed:false`, reason cites `ALLOW_UNTRUSTED_SCRIPTS`. Install still runs but only with `--ignore-scripts` + sanitized env. Test-proven.
- **#4** a workspace `pnpm.cmd` placed first on PATH is **not** resolved; the trusted dir wins; workspace-only → `null` (refused). Test-proven.
- **#5** boundary check documented as non-sandbox; real containment now rests on the #2/#3 gate. Test-proven.
- **#6** verified **live**: foreign listener (`service:"grafana"`) on :5179 → backend exits **1** with "in use by another process"; a real second Factory instance → exits **0**. Launcher PS parses; marker `service:"factory-deck"` present on `/api/health`.
- `vitest run`: **53 passed** (11 files). `tsc -p tsconfig.json --noEmit`: clean. `prettier --check "src/**"`: clean. `.factory` history unchanged (17). No untrusted product executed.

---

# Round 3 — Codex residual: launcher opened a foreign service

**[STILL-BROKEN] `scripts/start-factory.ps1`** — sibling of the EADDRINUSE marker fix. The preflight's
broad `catch` treated a **200 with a non-JSON body** (`ConvertFrom-Json` throws) as "nothing answered"
and continued; the hidden browser-open poller (old line 60-61) then opened `$backendUrl` after **any**
HTTP 200 on `/api/health` **without** re-checking `service:"factory-deck"` — so a foreign service on the
port got opened in the browser.

**Fix (`scripts/start-factory.ps1`, backup `.bak-2026-07-18b`; pristine original `.bak-2026-07-18` kept):**
- **Preflight (lines ~12-33):** separate "connection refused → nothing listening → continue" from
  "something answered". Any response that is not JSON-with-`service:"factory-deck"` (incl. non-JSON
  200s and marker-less JSON) is a foreign service → clear message + `exit 1`, never opened.
- **Poller (lines ~59-64):** opens `$backendUrl` **only** after `/api/health` parses as JSON **and**
  `service -eq 'factory-deck'`; otherwise it keeps waiting and never opens. Same marker check as the
  preflight, applied consistently to both paths.

**Verification:**
- Marker decision (`ConvertFrom-Json).service -eq 'factory-deck'` in try/catch): non-JSON `ok` → **no
  open**; `{"ok":true}` → **no open**; `{"service":"grafana"}` → **no open**; `{"service":"factory-deck"}`
  → open. Confirmed in PowerShell.
- **Live:** foreign 200/`text-plain` `ok` responder on :5179 → real `start-factory.ps1` **exits 1**
  ("in use by another (non-Factory Deck) service"), does **not** open it, does **not** build/run.
- `start-factory.ps1` parses cleanly. `vitest` 53 passed · `tsc` clean · `prettier` clean · `.factory`
  unchanged (17) · no orphan listener on :5179.

---

# Round 4 — Codex residual: dev-mode fallback poller opened :5180 without the marker

**[STILL-BROKEN] `scripts/start-factory.ps1:60` (old)** — the build-failure / no-previous-build
fallback started an OLD dev-mode poller that opened `http://localhost:5180` on ANY successful
`Invoke-WebRequest` (bare root, no JSON parse, no marker) — a foreign 200 on :5180 could be opened.

**Fix (`scripts/start-factory.ps1:59-66`, backup `.bak-2026-07-18c`):** the dev-fallback poller now
polls `http://localhost:5180/api/health` (Vite proxies `/api` → backend :5179, so the marker is
present in dev too) and opens the dev UI **only** when the body parses as JSON with
`service -eq 'factory-deck'`. Same check as the production preflight + poller.

**Whole-launcher audit — every URL-open / port-ours decision now requires the marker:**
- `:32` preflight `Start-Process $backendUrl` — inside `if ($marker -eq "factory-deck")`. ✓
- `:65` dev-fallback poller — opens `:5180` only on marker. ✓ (this fix)
- `:77` production poller — opens `$backendUrl` only on marker. ✓
- (the two `Start-Process powershell` calls only spawn the poller helpers, not URLs.)

**Verification:** foreign 200 `text/plain` responder on **:5180** → the exact dev-poller decision
evaluates to **do-not-open**. `start-factory.ps1` parses cleanly. `vitest` 53 passed · `tsc` clean ·
`prettier` clean · `.factory` unchanged (17).

---

# Round 5 — Codex residual: preflight misclassified a non-2xx foreign responder as a free port

**[STILL-BROKEN, minor] `scripts/start-factory.ps1:21-23` (old)** — the preflight `catch` treated ANY
`Invoke-WebRequest` failure as "nothing is listening". In Windows PowerShell a **non-2xx** HTTP
response (404/500/401) THROWS, so a foreign service on :5179 returning 404 on `/api/health` fell
through as a free port (launcher continued into backend startup + EADDRINUSE) instead of being
classified foreign. No foreign URL-open occurred (opens are marker-gated), but the classification was
wrong.

**Fix (`scripts/start-factory.ps1:19-45`, backup `.bak-2026-07-18d`):** the preflight now distinguishes
a **connection-refused** error (`$_.Exception.Response` is null → port free → continue) from an
**HTTP-error response** (`$_.Exception.Response` non-null → something IS listening → foreign, since our
own `/api/health` always returns 200 with the marker → clear message + `exit 1`). A 2xx still parses
the body and requires the `factory-deck` marker as before.

**Verification (live):**
- Foreign responder on :5179 returning **404** on `/api/health` → `start-factory.ps1` **exits 1**
  ("in use by another (non-Factory Deck) service"), classified foreign (not free).
- Genuinely free port (:5599, connection refused) → classified **free (continue)** — no false positive.
- `start-factory.ps1` parses cleanly · `vitest` 53 passed · `tsc` clean · `prettier` clean ·
  `.factory` unchanged (17) · :5179 clean.

---

# Round 6 — Codex residual: every null-HTTP-response error treated as free (incl. non-refused)

**[NEW-BUG, minor] preflight null-response branch** — round 5 classified *any* error with no HTTP
`.Response` as "free". That covers actively-refused, but ALSO a non-HTTP foreign listener that
accepts/holds the socket (HTTP probe times out, no `.Response`) — misclassified as free.

**Empirical finding on this host:** a genuinely FREE port does **not** refuse — both the HTTP probe and
a raw TCP connect **time out** (`WebException.Status = Timeout`). So the literal "only ConnectFailure =
free" rule would misclassify every free port as foreign and **break startup**. `WebException.Status`
is therefore unusable here as the discriminator.

**Fix (`scripts/start-factory.ps1:9-58`, backup `.bak-2026-07-18e`):** added `Test-PortListening`
(a raw `TcpClient.ConnectAsync` with timeout) as the authoritative "is the port occupied" signal. In
the null-HTTP-response branch we now probe TCP: a **reachable listener** (connect established) →
FOREIGN/occupied → exit 1; **no reachable listener** (refused OR timed-out connect) → FREE → continue.
The 2xx-requires-marker and HTTP-error(`.Response`!=null)=foreign branches are unchanged. (`$backendHost`
/`$backendPort` vars introduced so the probe and messages track the port.)

**Full preflight classification now:**
| Port state | Result |
|---|---|
| 2xx `/api/health` + `service:"factory-deck"` | OURS → open, exit 0 |
| 2xx without marker / non-JSON body | FOREIGN → exit 1 |
| non-2xx HTTP (404/500/401) | FOREIGN → exit 1 |
| no HTTP response **but** a TCP listener exists | FOREIGN/occupied → exit 1 |
| no HTTP response **and** no TCP listener | FREE → continue |

**Verification (live):**
- Raw **non-HTTP** listener on :5179 (accepts + holds, no HTTP reply) → `start-factory.ps1` **exits 1**
  ("in use by another (non-Factory Deck) service") — no longer treated as free.
- Genuinely free :5179 (no listener) → classified **FREE (continue)** — no regression.
- (Retained from earlier: 404 foreign → exit 1; 200 non-JSON foreign → exit 1; marker → open.)
- `start-factory.ps1` parses cleanly · `vitest` 53 passed · `tsc` clean · `prettier` clean ·
  `.factory` unchanged (17) · :5179 clean.

---

# Round 7 — Codex adversarial review (5 findings) — TARGETED THE WRONG CODEBASE (no code changed)

> **Follow-up (see Round 8 below):** the coordinator re-ran the Codex adversarial pass against the
> **real** Factory Deck files. That correctly-targeted pass confirmed the architecture read here
> (linear assembly line; `safeResolve` contains generated writes; bounded repair loop; no
> model-supplied command strings) **and** surfaced **4 genuine defects in the actual code** — all now
> fixed and regression-tested in **Round 8**. So: the *original* 5 findings were against the wrong
> codebase (below), but the *re-pointed* pass produced real, actionable results.

Date: 2026-07-18. An independent OpenAI/Codex adversarial pass returned **needs-attention** with 5
findings against a security subsystem laid out as `orchestrator/src/agents/action-log.js`,
`orchestrator/src/security/permissions.js`, `orchestrator/src/security/log-redact.js`, and
`orchestrator/src/security/canonical.js`. **None of those files, and none of the functions they name,
exist anywhere in this repository.** The findings describe a *different* kind of system — a stateful,
tool-calling agent with a SQLite approval/permissions table, an HMAC-chained durable action log, and
`memory_search` / `memory_keyword` / `rag_search` retrieval tools. Factory Deck has none of that
architecture; it is a linear, batch LLM assembly line (`src/server/orchestrator/runFactory.ts`:
Intake → Product Spec → Architect → Task Planner → Builder → Test Writer → QA → Repair → Final Review)
with a workspace command runner and a plain-JSON run store.

**Honest decision: no source was fabricated.** Inventing an `action-log.js`/`permissions.js`/
`log-redact.js`/`canonical.js` subsystem (with dead, unreachable code + tests) purely to make a review
of a non-existent module "pass" would be fake hardening — exactly the "reports success while achieving
nothing" anti-pattern this portfolio guards against. The correct action is to reject the premise with
proof and keep the real suite green.

## Proof each finding does not apply (all searches over `src/`, `scripts/`, `dist/`, workspaces)

| # | Finding (Codex) | Cited path | Reality in this repo |
|---|---|---|---|
| 1 | Chain verification accepts truncated logs (`verifyChain`) | `orchestrator/src/agents/action-log.js:178` | No `action-log.js`, no `verifyChain`, no HMAC/`createHmac`, no JSONL action log. Durable state = plain `.factory/runs/<id>.json` (`runsStore.ts`), no hash chain. **0 matches.** |
| 2 | Approval consumption not atomic (`consumeApproval`) | `orchestrator/src/security/permissions.js:266` | No `permissions.js`, no `consumeApproval`, no SQLite / approval rows. The only "approval" is a synchronous boolean env flag `ALLOW_UNTRUSTED_SCRIPTS` → `allowScriptExecution` (`commandRunner.ts`); no DB row, no read-then-update, no race. **0 matches.** |
| 3 | Sensitive retrieval results not redacted (`memory_search`/`rag_search`) | `orchestrator/src/security/log-redact.js:28` | No `log-redact.js`, no `logAction`, no `result_preview`, no `memory_*`/`rag_search` tools. Factory Deck has no memory/RAG retrieval; logs are assembly-line stage strings. **0 matches.** |
| 4 | Unknown risk values auto-approve (`shouldAutoApprove`) | `orchestrator/src/agents/action-log.js:117` | No `shouldAutoApprove`, no `riskLevel`/`risk_level`/`high_risk_only`, no per-tool risk enum. **0 matches.** |
| 5 | Canonicalization can throw (`canonicalJson`/`fingerprintParams`) | `orchestrator/src/security/canonical.js:17` | No `canonical.js`, no `canonicalJson`, no `fingerprintParams`, no params-fingerprint approval gate. **0 matches.** |

Search method: ripgrep over the whole tree for every identifier in the five findings
(`verifyChain`, `consumeApproval`, `canonicalJson`, `fingerprintParams`, `shouldAutoApprove`,
`memory_search`, `memory_keyword`, `rag_search`, `result_preview`, `riskLevel`, `high_risk_only`,
`createHmac`, `sqlite`, `toolRegistry`, `action-log`, …) → **0 hits each**. `find` for
`*action-log*`/`*permission*`/`*redact*`/`*canonical*` → no such files. The only `orchestrator`
directory is `src/server/orchestrator/` (`cancellation.ts`, `repairLoop.ts`, `runFactory.ts`,
`stages.ts`).

## What this means for the review verdict

The Codex pass reviewed a codebase that is not `local-ai-factory`/Factory Deck (most likely a
different tool-calling-agent project, or a hallucinated module tree). **Zero of the 5 findings are
reproducible here, so none can be "fixed" and no regression test can be written for functions that do
not exist.** No `.bak` files were created for source (nothing was edited); only these two audit docs
were backed up (`.bak-2026-07-18`) before this entry was added.

## Verification (real suite, unchanged)

- `npm test` (`vitest run`): **53 passed / 53** across **11 files** (no new tests — there is no new
  code to cover; adding tests for absent modules is impossible/dishonest).
- No source file changed; the prior Rounds 1–6 hardening remains intact.

## Residual / recommendation (honest)

If the intent was genuinely to add an HMAC-chained action log, a consumable approval store, retrieval
redaction, a risk enum, and canonical fingerprinting **to Factory Deck as new features**, that is a
net-new build (new product surface), not a hardening fix — it should be scoped and requested as such,
not smuggled in as "fixing" a review of files that were never here. Recommend re-pointing the Codex
adversarial pass at the correct repository (its findings closely match a permissioned tool-calling
agent — e.g. a GrantFlow/Anya-style agent with a tool registry and approvals), then re-running.

---

# Round 8 — Codex adversarial pass re-targeted at the REAL files (4 genuine defects, all fixed)

Date: 2026-07-18. After Round 7, the Codex pass was re-run (task mode) against the actual Factory Deck
source. It confirmed the architecture read **and** found 4 real defects. Each was reproduced from the
code, fixed with the smallest robust change, and covered by a focused regression test. **Suite: was
53/53 → now 71/71 (15 files).** `tsc` (server + ui) clean · `prettier --check "src/**"` clean ·
`.factory` history unchanged (17) · no untrusted product executed · no network side effects.

## Changed files (+ backups)

| File | Backup | Change |
|---|---|---|
| `src/server/workspace/commandRunner.ts` | `.bak-2026-07-18` (pre-existing, kept) | **#1** `isScriptExecuting()` now returns **true for install/ci too** (fail closed) — a project-controlled `.pnpmfile.cjs` runs during `pnpm install` resolution and `--ignore-scripts` does NOT disable it, so the approval gate at `runCommand` must cover installs. `hardenArgs()` additionally injects **`--ignore-pnpmfile`** for pnpm installs (defense for the approved path). **#3** `RunCommandOptions.shouldCancel?()`: refuses to spawn if a cancel is already pending, and a 200 ms poll **force-kills the child** if cancel arrives mid-run (returns `executed:false`, cancelled reason). |
| `src/server/index.ts` | `.bak-2026-07-18` (pre-existing, kept) | **#2** Binds **loopback by default** via `resolveBindHost` (was hard-coded `0.0.0.0`); LAN opt-in requires a token or the process **exits 1** (fail closed). Added an `/api` **auth middleware** (`authorizeApiRequest`): loopback trusted, every remote request needs a matching bearer token (constant-time). **#4** `:runId` route params validated with `isValidRunId` (404 on non-UUID) before any store lookup. |
| `src/server/config.ts` | `.bak-2026-07-18` (pre-existing, kept) | **#2** Added `bindLan` (`FACTORY_BIND_LAN`, default false) to `AppConfig` and `authToken` (`FACTORY_AUTH_TOKEN`) to `AppSecrets` (kept in the secrets object, never in `toHealth`). |
| `src/server/orchestrator/runFactory.ts` | `.bak-2026-07-18` (pre-existing, kept) | **#3** `throwIfCancelled(run.id)` now runs at the top of `writeBuild` and before **each** command spawn; passes `shouldCancel: () => isCancelRequested(run.id)` into `runCommand`. |
| `src/server/orchestrator/stages.ts` | `.bak-2026-07-18` (new) | **#2** `makeLog()` runs every message through `redactSecrets()` — the single choke point for durable logs, so a pasted key / `.env` line in the idea or a QA summary is masked before it is persisted or served. |
| `src/server/storage/runsStore.ts` | `.bak-2026-07-18` (new) | **#4** New `storeFilePath()` containment helper: run id must be a UUID (no separators/`..`/absolute) or the path build throws — used by `saveRun`/`getRun`/`saveRunFiles`/`getRunFiles`. `getRun`/`listRuns` also **reject any record whose `id` ≠ its filename stem**, and skip non-UUID filenames. |
| `src/shared/schemas.ts` | `.bak-2026-07-18` (new) | **#4** Added `RunIdSchema = z.string().uuid()` + `isValidRunId()`; `RunRecordSchema.id` is now `RunIdSchema` — a crafted/corrupt record with a traversal `id` fails validation on load (so `normalizeLoaded → saveRun` can never rewrite it outside the store). |
| `src/server/__tests__/commandSandbox.test.ts` | `.bak-2026-07-18` (new) | Updated the `isScriptExecuting` assertions to the new fail-closed behavior (install/ci now gated); removed the obsolete "install is not gated" case. |
| `src/server/__tests__/commandEnvHardening.test.ts` | `.bak-2026-07-18` (post-edit copy) | Updated `hardenArgs` assertions to expect `--ignore-pnpmfile` on pnpm installs (test-only edit). |

## New files (security helpers + regression tests)

| File | Purpose |
|---|---|
| `src/server/security/access.ts` | Pure network-policy helpers: `resolveBindHost` (loopback default, token-gated LAN, fail closed), `authorizeApiRequest` (loopback trusted, remote needs bearer token), `isLoopbackAddress`, `bearerToken`, `safeEqual` (constant-time). |
| `src/server/security/redact.ts` | `redactSecrets()` — masks API keys (`sk-…`), AWS keys, Slack/GitHub tokens, JWTs, private-key blocks, and `.env` `SECRET=value` assignments. Conservative (targets recognizable shapes). |
| `src/server/__tests__/installGate.test.ts` | **#1** (3 tests): install classified as script-executing; a planted hostile `.pnpmfile.cjs` never runs because `pnpm install` (dry-run off, no approval) is **refused pre-spawn** (sentinel file never created); `hardenArgs` adds `--ignore-pnpmfile` (idempotent, pnpm-only). |
| `src/server/__tests__/lanAuth.test.ts` | **#2** (11 tests): loopback-default + token-gated bind; loopback allowed w/o token; remote w/o or w/ wrong token → 401; correct token → allowed; header parse + length-safe compare; config wiring; secret redaction (masks + leaves prose intact + removes the secret). |
| `src/server/__tests__/commandCancel.test.ts` | **#3** (1 test): with a pending cancel, `runCommand` returns `executed:false` (cancel reason) and does **not** spawn (sentinel never written) — even when script execution is approved. |
| `src/server/__tests__/runIdContainment.test.ts` | **#4** (4 tests): `isValidRunId` accepts UUIDs / rejects traversal + plain names; `RunRecordSchema` rejects a non-UUID id; `saveRun` **rejects** a traversal id (no escape file); a planted `seed.json` with a traversal id + `status:"running"` is **skipped by `listRuns` and never rewritten** to `<cwd>/outside-idguard.json`. |

## Per-defect verification (reproduced → fixed → tested)

- **#1 install ran project code without the gate** — `isScriptExecuting` returned false for install/ci, so `runCommand`'s approval gate never applied to `pnpm install`, which `runFactory` runs whenever `DRY_RUN_COMMANDS=false`; `--ignore-scripts` does not stop a `.pnpmfile.cjs`. **Fixed:** installs are gated (fail closed) + pnpm gets `--ignore-pnpmfile`. Test proves a hostile `.pnpmfile.cjs` is not executed without approval.
- **#2 unauthenticated LAN exposure + no redaction** — server bound `0.0.0.0` with zero auth on `/api/runs*`, returning full records + generated file contents; raw idea logged verbatim. **Fixed:** loopback default, token-gated LAN opt-in (fail closed), bearer-token middleware for remote, and secret redaction on all durable log lines. Tests cover bind policy, auth decisions, and redaction. **Residual:** `run.idea` and generated file *contents* are still persisted verbatim (the model needs the idea; the Files panel needs the contents) — they are now reachable only via loopback or an authenticated LAN request; full content redaction/opt-in was not done to avoid corrupting the product's own output (documented below).
- **#3 cancel didn't stop writes/spawns mid-stage** — cancel was only checked at stage boundaries + before model calls. **Fixed:** `writeBuild` and each command spawn now check `throwIfCancelled`, and `runCommand` takes a `shouldCancel` signal that refuses-to-spawn / force-kills the child. Test proves no spawn on a pending cancel. **Residual:** the *mid-run child-kill* path (the 200 ms poll) is exercised by code but not unit-tested, because doing so would require spawning a real long-running child (a real side effect we avoid); the refuse-to-spawn guard is the tested regression.
- **#4 no run-id containment** — paths were built from raw string ids and `RunRecordSchema.id` was `z.string()`, so a planted `seed.json` with `id:"../../outside"` + `status:"running"` would load and, via `normalizeLoaded → saveRun`, write outside `.factory/runs`. **Fixed:** strict UUID schema + `storeFilePath` containment + id≠stem rejection + route-param validation. Test proves the planted seed is skipped and no escape file is written.

## Honest residuals (not forced green)

1. Generated **file contents** and the raw **idea** remain stored verbatim (functional necessity) — protected by the new loopback-default + token gate, not by content redaction.
2. The **mid-run child-kill** on cancel is not unit-tested (would need a real spawned process); only the pre-spawn refusal is asserted.
3. Redaction is **pattern-based** and conservative — it catches common secret shapes, not every possible secret, and a log token that literally contains `KEY`/`TOKEN`/… followed by `=`/`:` and a value will be masked (rare false-positive, logs only).

---

# Round 9 — Codex residual sweep on the real fixes (7 residuals, all closed)

Date: 2026-07-18. Codex confirmed the Round-8 CORE fixes are closed for the real-app path (install gate
unconditional, LAN middleware covers all `/api/runs*`, IP read from `socket.remoteAddress` so XFF/Host
spoofing is ignored, run-id UUID validation blocks traversal) and flagged 7 residuals. Each was proved
from the code, fixed with the smallest fail-closed change, and given a regression test. **Suite: was
71/71 → now 81/81 (18 files).** `tsc` (server + ui) clean · `prettier --check "src/**"` clean ·
`.factory` unchanged (17) · no untrusted product executed · no network side effects.

## Changed files (+ backups)

| File | Backup | Change |
|---|---|---|
| `src/server/workspace/commandRunner.ts` | `.bak-2026-07-18` (kept) | **#1** `hardenArgs` was substring-fragile (`includes("--ignore-scripts")` misses `--ignore-scripts=false`). Now **strips every `--ignore-scripts*` / `--ignore-pnpmfile*` variant** (regex `HARDENING_FLAG`) then appends the canonical flags LAST — no caller value can override them. |
| `src/server/orchestrator/runFactory.ts` | `.bak-2026-07-18` (kept) | **#2** `throwIfCancelled(run.id)` now runs **before AND after each per-file `writeWorkspaceFile`** in `writeBuild` (was only once at the top of the loop). **#3** added `throwIfCancelled(run.id)` **immediately after the `finalReviewerAgent` await**, before the terminal `run.finalReport = …`/`status="completed"` mutation (a cancel in flight there had no later boundary to catch it). **#7** `run.error` is now `redactSecrets(…)`-wrapped before it is persisted/served. |
| `src/server/storage/runsStore.ts` | `.bak-2026-07-18` (kept) | **#4** run-id containment was LEXICAL only — a symlinked/junctioned `.factory/runs` (or `files`) is followed by `writeFile`/`readFile` and escapes. Added `guardStoreDirs()` (memoized, fail-closed): refuses a store dir that is a symlink OR whose **realpath** resolves outside the realpath of the data root; `safeStorePath()` additionally refuses an individual symlinked `<id>.json`. **Every** persistence/read/prune path (`saveRun`/`getRun`/`listRuns`/`pruneOldRuns`/`saveRunFiles`/`getRunFiles`) now routes through these after UUID validation. |
| `src/server/security/access.ts` | `.bak-2026-07-18` (new) | **#5** `safeEqual` no longer early-returns on length mismatch (which leaked token length via timing); it hashes both inputs to fixed-length SHA-256 digests and `timingSafeEqual`s those. **#6** `authorizeApiRequest`: once a token is configured it is required for **every** request **including loopback** (a local reverse-proxy/tunnel makes remote callers appear as `127.0.0.1`, so loopback is no longer an auth bypass); loopback stays trusted only when NO token is set (local-first default). |
| `src/server/index.ts` | `.bak-2026-07-18` (kept) | **#6** `/api/health` moved ABOVE the auth middleware (it exposes only non-secret booleans + the launcher `service` marker and must stay reachable for the EADDRINUSE/idempotency probe even when a token gates every other route); auth-boundary comment updated (fail-closed-under-proxy + IP-from-socket). |
| `src/server/__tests__/installGate.test.ts` | `.bak-2026-07-18` (new) | Added the **#1** regression case. |
| `src/server/__tests__/lanAuth.test.ts` | `.bak-2026-07-18` (new) | Added the **#5** and **#6** regression cases. |

## New regression tests

| File | Purpose |
|---|---|
| `src/server/__tests__/cancellationDeep.test.ts` | **#2 + #3** (2 tests): drives a real stub run and trips the cancel from inside the mocked seam. #2 — cancel on the first `writeWorkspaceFile` → only 1 file written (builder emits several), run `cancelled`. #3 — cancel during the `finalReviewerAgent` call → run ends `cancelled` with `finalReport === null` (terminal mutation skipped). |
| `src/server/__tests__/errorRedact.test.ts` | **#7** (1 test): forces a run failure whose error embeds `OPENAI_API_KEY=sk-ant-…`; asserts the persisted `run.error` no longer contains the secret and carries a `[REDACTED…]` placeholder. |
| `src/server/__tests__/runStoreSymlink.test.ts` | **#4** (1 test): makes `.factory/runs` a junction (Windows) / dir symlink (POSIX) to an outside dir; asserts `saveRun` and `listRuns` **reject** and nothing is written into the symlink target. Self-skips honestly if the host forbids link creation (verified here: junction creation + realpath-escape detection both work). |
| `installGate.test.ts` / `lanAuth.test.ts` | +1 (#1), +5 (#5/#6) cases appended (see above). |

## Per-residual verification (proved → fixed → tested)

- **#1** `hardenArgs(["install","--ignore-scripts=false","--ignore-pnpmfile=false"])` → `["install","--ignore-scripts","--ignore-pnpmfile"]` (variants stripped, canonical flags win). CLOSED.
- **#2** cancel mid multi-file `writeBuild` → remaining files not written (`writeCalls === 1`). CLOSED.
- **#3** cancel during final review → `status === "cancelled"`, `finalReport === null` (was `completed`). CLOSED.
- **#4** symlinked/junctioned store dir → `saveRun`/`listRuns` reject; no file in the link target; realpath guard catches junctions even when `isSymbolicLink()` is false. CLOSED (residual: file-level symlink refusal via `safeStorePath` is coded and covered by the same dir test path; a dedicated file-symlink case is not separately asserted because a *file* symlink needs elevated privileges on Windows).
- **#5** `safeEqual` compares fixed-length digests; equal/unequal-length inputs all take the same path, no early length return, never throws. CLOSED.
- **#6** with `FACTORY_AUTH_TOKEN` set, a loopback `/api` request without the token → 401; with the token → allowed; loopback trusted only when no token configured. CLOSED. **Consequence (documented):** setting a token means local clients (the UI) must also present it — `/api/health` is exempt so the launcher marker keeps working.
- **#7** `run.error` redacted before persistence/serving. CLOSED.

## Honest residuals (Round 9)

1. Carried forward: generated **file contents** + raw **idea** stored verbatim (functional), protected by the loopback/token gate. **(Superseded in Round 10 — the served/persisted copies of idea, finalReport, and file contents are now redaction-scrubbed; see below.)**
2. The **mid-run child-kill** on cancel remains code-only (not unit-tested — avoids spawning a real process); the pre-spawn refusal and the per-file/post-await `writeBuild`/final-review cancel checks ARE tested.
3. **#4** file-level (`<id>.json`) symlink refusal is implemented in `safeStorePath` but only the store-**dir** escape is asserted in a test (creating a *file* symlink needs privileges on Windows); the realpath dir guard is the primary, tested containment. **(Round 10 now asserts the file-symlink path too — file symlinks work on this host.)**
4. Setting `FACTORY_AUTH_TOKEN` now requires the browser UI to send the token on `/api` calls (health is exempt). Wiring the token into the UI client is a product task, not a security hole — the fail-closed default (loopback-only, no token) is unchanged.

---

# Round 10 — Codex residual sweep #2 (6 residuals: 1 TOCTOU + extend redaction to served fields)

Date: 2026-07-18. Codex confirmed cancel, token-compare, `/api` auth, and `run.error` redaction are
CLOSED, and flagged 6 more: **#2 is a real TOCTOU** (the store-dir guard memoized success), and
**#4-6 extend the same `redactSecrets` applied to `run.error` to the other served fields** (idea,
finalReport, file contents). All reproduced, fixed fail-closed, and regression-tested. **Suite: was
81/81 → now 87/87 (21 files).** `tsc` (server + ui) clean · `prettier --check "src/**"` clean ·
`.factory` unchanged (17) · no untrusted product executed · no network side effects.

## Changed files (+ backups)

| File | Backup | Change |
|---|---|---|
| `src/server/workspace/commandRunner.ts` | `.bak-2026-07-18` (kept) | **#1** `HARDENING_FLAG` strip regex is now **case-insensitive** (`/^--ignore-(scripts\|pnpmfile).*$/i`) so `--Ignore-Scripts=false` / `--IGNORE-PNPMFILE=false` can't survive the strip. |
| `src/server/storage/runsStore.ts` | `.bak-2026-07-18` (kept) | **#2 (HIGH TOCTOU)** `guardStoreDirs` no longer caches a SUCCESSFUL result — it re-lstats/realpaths the store dirs on **every** call (a cached success let an attacker pass once then swap a dir to a symlink and write through it). Only a FAILURE is latched (fail closed). **#3** `pruneOldRuns` now resolves each entry through `safeStorePath` **before** `stat()`, so a symlinked `<id>.json` is skipped (never followed for metadata) instead of `stat(join(...))` following it. **#6** `saveRunFiles` runs each file's `contents` through `redactSecrets` before caching + persisting — the served/`.factory/files` copy is scrubbed (the raw workspace file, i.e. the product, is written elsewhere and untouched). |
| `src/server/orchestrator/runFactory.ts` | `.bak-2026-07-18` (kept) | **#4** `run.idea` is persisted/served as `redactSecrets(args.idea)`; the **raw** `args.idea` is passed to `productSpecAgent` so generation is unaffected. **#5** `run.finalReport = redactDeep(report)` — recursively scrubs every string field of the provider report before persist/serve. |
| `src/server/security/redact.ts` | `.bak-2026-07-18` (new) | Added `redactDeep(value)` — recursively applies `redactSecrets` to every string in a JSON-like value (objects/arrays/strings), returns a new value, doesn't mutate. |
| `src/server/__tests__/installGate.test.ts` | `.bak-2026-07-18` (kept) | Added the **#1** case-insensitive regression case. |
| `src/server/__tests__/cancellation.test.ts` | `.bak-2026-07-18` (new) | Made the pre-existing "cancel flag cleared" assertion wait for the flag inside `vi.waitFor` — the #2 change (guard re-checks every `saveRun`) slightly slowed `flush()`, widening the always-present window between `status="cancelled"` (set in `catch`) and `clearCancel` (in `finally`). Test race, not a product bug. |

## New regression tests

| File | Purpose |
|---|---|
| `src/server/__tests__/runStoreTOCTOU.test.ts` | **#2 + #3** (2 tests): #2 — guard passes on normal dirs, then `.factory/runs` is swapped to a junction/symlink → the NEXT `saveRun` re-checks and **rejects**, nothing written to the target (proves success is not cached). #3 — a symlinked `<uuid>.json` in the runs dir is **skipped** by `pruneOldRuns` (still a symlink, target untouched) while real files prune normally. |
| `src/server/__tests__/servedRedaction.test.ts` | **#4 + #5** (1 test): drives a real stub run with a secret in the idea and a mocked secret-bearing final report; asserts the model **received the raw idea**, `run.idea` is redacted, and every `finalReport` string field is redacted. |
| `src/server/__tests__/fileContentsRedact.test.ts` | **#6** (2 tests): `saveRunFiles` → `getRunFiles` redacts secret-shaped content in the in-memory served copy (non-secret content preserved) and in the disk-persisted copy read back by a fresh store. |

## Per-residual verification (proved → fixed → tested)

- **#1** mixed-case `--Ignore-Scripts=false` is stripped; canonical lowercase flags win. CLOSED.
- **#2** store-dir guard **re-checks on every use** — no cached-success TOCTOU; swap-after-pass is refused on the next write. CLOSED.
- **#3** `pruneOldRuns` no longer `stat`s a raw joined path; a symlinked `<id>.json` is not followed. CLOSED.
- **#4** `run.idea` redacted on the served/persisted copy; the model still gets the raw idea. CLOSED.
- **#5** `run.finalReport` recursively redacted before persist/serve. CLOSED.
- **#6** generated file **contents** redacted before persist/serve (raw workspace product untouched). CLOSED.

## Honest residuals (Round 10)

1. Redaction remains conservative **pattern-based** scrubbing (common secret shapes: `sk-…`, AWS/Slack/GitHub tokens, JWTs, private-key blocks, `NAME=value` where NAME looks secret). It is not a guarantee that every possible secret is caught — but idea/finalReport/file-contents/error/logs served copies now all pass through it.
2. The **mid-run child-kill** on cancel is still code-only (not unit-tested — avoids spawning a real process).
3. QA/repair/test-writer agents still receive the **raw** in-memory file contents (needed to analyze/patch real code); only the persisted+served copy is redacted. This is intentional (the redacted copy is what leaves the process).

---

# Round 11 — Codex residual sweep #3 (redaction was WRITE-time only; redactor too weak)

Date: 2026-07-18. Codex confirmed the write-path fixes are closed but found redaction was **write-time
only** (old/planted records served RAW) and the redactor **missed common secret shapes**. Fixed all 7
(1-5 priority: move redaction to the SERVE boundary + strengthen it). **Suite: was 87/87 → now 101/101
(25 files).** `tsc` (server + ui) clean · `prettier --check "src/**"` clean · `.factory` unchanged (17)
· no untrusted product executed · no network side effects.

## Changed files (+ backups)

| File | Backup | Change |
|---|---|---|
| `src/server/security/redact.ts` | `.bak-2026-07-18` (kept) | **#5** strengthened `redactSecrets`: new `CRED_URL` strips inline `scheme://user:pass@host` userinfo (catches `DATABASE_URL=…` whose name has no keyword); `ENV_SECRET` is now **case-insensitive** and adds `URL\|URI\|DSN\|AUTH\|SESSION` names (so `password=`, lowercase `openai_api_key=` match); added `github_pat_…` token shape (keeps `ghp_`/`gho_`/…). **#1-#4 serve-boundary helpers:** `sanitizeRunRecordForServe(record)` (redacts idea/appName/workspacePath/error/log messages/file-summary path+purpose, `redactDeep` finalReport) and `sanitizeFileRecords(files)` (`redactDeep` each FileContent = path+purpose+contents). Idempotent. |
| `src/server/storage/runsStore.ts` | `.bak-2026-07-18` (kept) | **#1** `getRun` returns `sanitizeRunRecordForServe(…)` (copy) for BOTH memory-hit and disk-load; `listRuns` redacts idea/appName/workspacePath in the summary — so OLD/PLANTED raw records are scrubbed on load, before returning/caching. **#2/#4** `saveRunFiles` + `getRunFiles` route through `sanitizeFileRecords` (path+purpose+contents), on write AND on load. **#6** new `writeFileContained` (exported): opens the target with `O_NOFOLLOW` where the platform supports it + re-checks the opened fd is a regular file (`fstat`) before writing — narrows the lstat→write TOCTOU; used by `saveRun`/`saveRunFiles`. **#7** `guardStoreDirs` no longer latches a failure permanently — it revalidates the live FS on every call, so a TRANSIENT junction refuses writes while present but the store RECOVERS once it's removed (no wedge-until-restart), while still failing closed WHILE unsafe. |
| `src/server/orchestrator/runFactory.ts` | `.bak-2026-07-18` (kept) | **#3** `run.appName = redactSecrets(spec.appName)` (model-controlled, served by `/api/runs` + `/:runId` + logs). |

## New regression tests

| File | Purpose |
|---|---|
| `src/server/__tests__/redactStrength.test.ts` | **#5** (7): the 4 confirmed bypasses now redacted (`DATABASE_URL` creds, `password=hunter2`, lowercase `openai_api_key=`, `github_pat_…`), pre-existing shapes still redacted, ordinary prose preserved, idempotent. |
| `src/server/__tests__/serveLoadRedaction.test.ts` | **#1/#2/#3/#4** (3): a PLANTED raw run json (secrets in idea/appName/workspacePath/error/logs/finalReport/file-summary) is scrubbed by `getRun` and `listRuns`; a planted raw file-content json (secret in path/purpose/contents) is scrubbed by `getRunFiles`. |
| `src/server/__tests__/writeContainedFd.test.ts` | **#6** (3): `writeFileContained` round-trips a normal write; refuses a non-regular-file (directory) target; on O_NOFOLLOW platforms refuses a symlinked target (self-documents the Windows residual otherwise). |
| `src/server/__tests__/guardRecovery.test.ts` | **#7** (1): guard refuses while a junction is present, then the NEXT write SUCCEEDS once the junction is removed (no permanent latch/wedge). |

## Per-finding verification (proved → fixed → tested)

- **#1** old/planted raw run records are redacted at the **serve boundary** (`getRun`/`listRuns` on load, before return/cache). CLOSED.
- **#2** old/planted raw file records are redacted on load in `getRunFiles`. CLOSED.
- **#3** `run.appName` redacted where served (write-time + serve-boundary). CLOSED.
- **#4** file **path/purpose** (not just contents) redacted on write AND load. CLOSED.
- **#5** redactor now catches credential-URLs, case-insensitive env names, `URL/URI/DSN/AUTH/SESSION` names, and GitHub `github_pat_`/`ghp_` tokens; prose preserved. CLOSED.
- **#6** contained fd write (`O_NOFOLLOW` + `fstat` re-check) NARROWS the TOCTOU; **honest residual documented** — Windows/Node has no `O_NOFOLLOW`, so a same-user swap in the lstat→open window can still be followed; full closure needs OS-level data-dir permissions. NARROWED + DOCUMENTED (not claimed fully closed).
- **#7** guard-latch removed → a transient junction no longer wedges the store until restart; still fails closed while unsafe. CLOSED.

## Honest residuals (Round 11)

1. Redaction is conservative pattern-matching — now catches the common shapes above but still not a proof that every possible secret is caught. The `AUTH`/`URL`/… env-name shapes can occasionally over-redact ordinary `NAME: value` prose in served copies (safe direction).
2. **#6** on Windows the lstat→open symlink race is NARROWED (fstat rejects non-regular-file swaps) but not fully closed without OS-level filesystem permissions on the data dir — documented in code + here.
3. The mid-run child-kill on cancel remains code-only (unchanged from Round 9).

---

# Round 12 — Codex residual: CRED_URL missed a BARE `user@` userinfo

Date: 2026-07-18. Codex confirmed all Round-11 fixes CLOSED and found ONE residual: the credential-URL
redactor only stripped `user:pass@` (colon-password) userinfo, not a **bare `user@`** — so a
token-in-userinfo like `https://tokensecret@git.example/repo.git` leaked in served logs/files/finalReport.

**Fix (`src/server/security/redact.ts`, `.bak-2026-07-18` kept):** `CRED_URL` changed from
`/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi` (requires a colon) to
`/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi` — it now strips the **entire** userinfo run (covering both
`user@` and `user:pass@`) while keeping scheme + host. The userinfo class excludes `/ ? #` and
whitespace so it can never reach past the authority into a path/query, so a plain `https://host/path`,
an `@` in prose, or a bare `user@example.com` email is never matched/mangled.

**Test (`src/server/__tests__/redactStrength.test.ts`, +3):** `https://useronlysecret@git.example/repo.git`
→ userinfo gone, host kept; `https://user:pass@host/db` still redacted; `https://host.example/path?x=1`
and `contact me @ foo or user@example.com` are left byte-for-byte unchanged.

**Verification:** `npm test` → **104 passed / 104** (25 files; was 101/101). `npm run typecheck`
(server + ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17). No side effects.

**Confirm:** bare-userinfo URLs (`scheme://user@host`) are now redacted at the serve boundary along
with `user:pass@` forms; plain URLs and prose `@` are not mangled.

## Honest residuals (Round 12)

1. Carried forward: redaction is conservative pattern-matching (not a proof every secret is caught); the Windows lstat→open symlink race is narrowed-not-closed; the mid-run child-kill is code-only.

---

# Round 13 — Codex residuals: multi-@ URL userinfo + opaque Bearer tokens

Date: 2026-07-18. Codex confirmed the Round-12 bare-userinfo fix and found 2 more redactor edges (both
serve-boundary, since `sanitizeRunRecordForServe`/`sanitizeFileRecords` route through the redactor).
Both fixed with a regression test each. **Suite: was 104/104 → now 108/108 (25 files).** `tsc`
(server + ui) clean · `prettier --check "src/**"` clean · `.factory` unchanged (17) · no side effects.

## Changed file (+ backup)

`src/server/security/redact.ts` (`.bak-2026-07-18` kept):

- **#1 [MED] multi-@ userinfo leaked the tail.** `CRED_URL` was `…:\/\/)[^\s/@?#]+@` — it excluded `@`
  from the userinfo run, so it stopped at the FIRST `@`. Per WHATWG URL the userinfo runs to the LAST
  `@` before the host, so `https://a@stillsecret@example.com/repo` left `stillsecret@example.com`
  exposed. **Fix:** allow `@` inside the run — `…:\/\/)[^\s/?#]+@` — so the greedy match extends through
  the final authority `@`. Still excludes `/ ? #`/whitespace, so it can't cross into a path/query and a
  plain URL / prose `@` is never matched. Now → `https://[REDACTED]@example.com/repo`.
- **#2 [MED] opaque Bearer tokens not fully redacted.** Only a JWT-shaped token was matched; an opaque
  `Authorization: Bearer opaque-secret-token-…` was redacted only via `ENV_SECRET` on the name
  "Authorization" (whose value capture stops at the first space) → the token was left behind. **Fix:**
  new PATTERNS entry `/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi` (label `BEARER_TOKEN`, runs FIRST so it also
  consumes a JWT) that redacts the WHOLE `Bearer <token>` run — opaque, JWT, or base64url —
  case-insensitively. Requires a token after the keyword, so a stray word "bearer" (end/punctuation, no
  token) is not mangled.

## Regression test

`src/server/__tests__/redactStrength.test.ts` (+4): multi-@ userinfo fully redacted with host kept;
path-`@` / query-`@` NOT mangled; `Bearer <opaque>` / `Bearer <jwt>` / lowercase `bearer <token>` all
fully redacted (no token remnant); a stray "bearer." / "bearer," with no token is left byte-for-byte
unchanged.

**Confirm:** multi-@ URL userinfo and opaque Bearer tokens are now fully redacted at the serve boundary,
without over-matching paths, queries, or prose.

## Honest residuals (Round 13)

1. Carried forward: redaction is conservative pattern-matching (not a proof every secret is caught); the Windows lstat→open symlink race is narrowed-not-closed; the mid-run child-kill is code-only.

---

# Round 14 — Codex residual: auth-header partial-redaction leaks (redact whole header value)

Date: 2026-07-18. Codex confirmed Round-13 (multi-@ userinfo + Bearer, incl. %40/IPv6/no-token edges)
and found 4 auth-header **partial-redaction** leaks — all serve-boundary (they route through
`sanitizeRunRecordForServe`/`sanitizeFileRecords`, so they can be served in error/workspacePath/
finalReport/file contents). Fixed with one whole-value header rule + tests. **Suite: was 108/108 → now
110/110 (25 files).** `tsc` (server + ui) clean · `prettier --check "src/**"` clean · `.factory`
unchanged (17) · no side effects.

## Proven leaks (all left a secret remnant)

- `Authorization: Basic dXNlcjpwYXNz` → `ENV_SECRET` matched name "Authorization" (contains AUTH) but its
  value capture `[^\s"']+` stops at the first space → captured only `Basic`, leaving the base64. Same for
  `Proxy-Authorization: Basic …`.
- `X-Api-Key: opaque secret-tail` → `ENV_SECRET` matched `Key: opaque`, leaving ` secret-tail`.
- `Authorization: Bearer abc$stillsecret` → the `Bearer` token class `[A-Za-z0-9._~+\/=-]+` stops at `$`,
  leaving `$stillsecret`.

## Fix (`src/server/security/redact.ts`, `.bak-2026-07-18` kept)

New `HEADER_SECRET` rule redacts the **ENTIRE value to end-of-line** for known secret-bearing headers,
keeping the header name — run FIRST (before the narrower token rules):

```
/^([ \t]*(?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Api-Key|X-Amz-Security-Token|Cookie|Set-Cookie))[ \t]*:[ \t]*.+$/gim
```

- `m` flag + `.+` (no `s`) → the value stops at the line end (never crosses a newline); `^…$` anchors to
  a line so a header embedded mid-sentence or a non-secret header like `Content-Type:` is not touched.
- `i` flag → case-insensitive header names; the captured name (original casing/indent) is preserved:
  `Authorization: [REDACTED]`.
- This uniformly covers `Basic`, `Digest`, `Bearer`-with-odd-chars, opaque `X-Api-Key`, and `Cookie`
  values. The standalone `BEARER_TOKEN` pattern is kept for a bare `Bearer <token>` in FREE PROSE (noted
  in a comment as best-effort for out-of-class chars there; the header-line case is now fully covered).

## Regression test (`src/server/__tests__/redactStrength.test.ts`, +2)

`Authorization: Basic …`, `Proxy-Authorization: Basic …`, `X-Api-Key: opaque secret-tail`,
`Authorization: Bearer abc$stillsecret`, `Cookie: …`, `Set-Cookie: …`, `X-Amz-Security-Token: …` → each
becomes `<Name>: [REDACTED]` (value fully gone to EOL, no remnant); `Content-Type: application/json` and
the non-auth lines of a multi-line log are NOT over-redacted (only the auth line changes); all prior
shapes still redact.

**Confirm:** secret-bearing HTTP header values are now **fully redacted to end-of-line** at the serve
boundary, header name kept, without over-redacting non-secret headers or non-header lines.

## Honest residuals (Round 14)

1. Carried forward: redaction is conservative pattern-matching (not a proof every secret is caught); a bare `Bearer <token>` with out-of-class chars in FREE PROSE (not a header line) is best-effort; the Windows lstat→open symlink race is narrowed-not-closed; the mid-run child-kill is code-only.

---

# Round 15 — Codex residuals: key-aware structured redaction + obs-fold header continuation

Date: 2026-07-18. Codex confirmed the header-LINE redaction and found 2 more serve-boundary edges (both
reachable via `sanitizeRunRecordForServe`/`sanitizeFileRecords` over a structured finalReport / file
records). Both fixed with tests. **Suite: was 110/110 → now 115/115 (25 files).** `tsc` (server + ui)
clean · `prettier --check "src/**"` clean · `.factory` unchanged (17) · no side effects.

## Proven edges

- **#1 [MED] `redactDeep` was VALUE-ONLY, not key-aware.** It applied the string regexes to values but
  never looked at the KEY, so a structured header/cred object identified by its key leaked:
  `{ "authorization": "Basic dXNlcjpwYXNz" }` stayed raw (the bare value isn't a `^header:` line, has no
  `NAME=value` assignment, and matches no token shape); `{ "x-api-key": "opaque$secret" }` stayed raw;
  `{ "authorization": "Bearer abc$def" }` → partial `[REDACTED_BEARER_TOKEN]$def`.
- **#2 [LOW] obs-fold continuation leaked.** `HEADER_SECRET`'s `.+$` stopped at the first line end, so an
  RFC 7230 folded value `Authorization: Basic\n\tcontinued$secret` redacted the first line but left the
  folded `\tcontinued$secret`.

## Fix (`src/server/security/redact.ts`, `.bak-2026-07-18` kept)

- **#1** `redactDeep` is now **KEY-AWARE**: a new normalized `SECRET_KEYS` set (lowercase, `-`/`_`
  stripped — `authorization`, `proxy-authorization`, `www-authenticate`, `cookie`/`set-cookie(2)`,
  `x-api-key`/`api-key`/`apikey`, `x-auth-token`/`x-access-token`/`access_token`/`refresh_token`,
  `x-amz-security-token`, `private-token`, `x-vault-token`, `password`/`passwd`/`pwd`, `secret`/
  `client_secret`, `token`, `session`/`sessionid`, `private_key`/`privatekey`). When a KEY is secret its
  ENTIRE value is replaced with `[REDACTED]` regardless of shape (string/object/array — no recursion, so
  nested token objects can't leak parts). All other keys recurse and their string values still pass
  through `redactSecrets`.
- **#2** `HEADER_SECRET` value now also consumes obs-fold continuation lines:
  `…[ \t]*.+(?:\r?\n[ \t]+.+)*$`. A continuation must start with whitespace, so a normal next header
  (column 0) is not over-consumed. The whole folded value collapses to `<Name>: [REDACTED]`.

## Regression tests

- `src/server/__tests__/redactStrength.test.ts` (+5): secret-keyed values redacted by key regardless of
  shape (string/object/array, case/`-`/`_` variants); non-secret keys untouched but their string values
  still run the shape regexes; obs-fold value fully redacted; a normal next header not over-consumed.
- `src/server/__tests__/fileContentsRedact.test.ts` (`.bak-2026-07-18` new): raised the two
  `freshStore()`-based tests' timeouts (20 s / 15 s) — the `vi.resetModules()` re-transform can exceed
  the default 5 s under full-suite parallel load; a stability fix, no behavior change.

**Confirm:** structured secret-KEYED values (e.g. `{authorization:…}`, `{x-api-key:…}`, nested token
objects) and obs-fold header continuations are now redacted at the serve boundary.

## Honest residuals (Round 15)

1. Carried forward: redaction is conservative pattern-matching (not a proof every secret is caught); a bare `Bearer <token>` with out-of-class chars in FREE PROSE (not a header line, not a secret-keyed object) stays best-effort; the Windows lstat→open symlink race is narrowed-not-closed; the mid-run child-kill is code-only.

---

# Round 16 — Codex residuals: stem-key detection, cycle/depth guard, Map/Set, prose Basic

Date: 2026-07-18. Codex confirmed the named/header/value-regex/obs-fold/key-aware(listed) shapes are
closed and found 4 residuals in `src/server/security/redact.ts` (structured-value serve path). All fixed
with tests. **Suite: was 115/115 → now 124/124 (25 files).** `tsc` (server + ui) clean · `prettier
--check "src/**"` clean · `.factory` unchanged (17) · no side effects.

## Proven residuals

- **#1 [HIGH] EXACT-membership secret keys** — `isSecretKey` did `SECRET_KEYS.has(normalized)`, so
  camelCase/compound variants leaked: `authToken`, `bearerToken`, `sessionToken`, `idToken`, `xApiKey`,
  `x.api.key`, `api token` weren't secret → `{authToken:{scheme:"Basic",value:"dXNlcjpwYXNz"}}` stayed raw.
- **#2 [MED] no cycle/depth guard** — `redactDeep` recursed unbounded → `RangeError` ("Maximum call stack
  size exceeded") on a cyclic or very-deep record on the SERVE path.
- **#3 [MED] Map/Set → `{}`** — `Object.entries(new Map(...))` is `[]`, so a Map silently became `{}`
  (data loss).
- **#4 [LOW] prose `Basic <b64>`** — a bare `{note:"Basic dXNlcjpwYXNz…"}` (non-secret key, not a header
  line) was not caught (header-line Basic IS covered by HEADER_SECRET).

## Fix (`src/server/security/redact.ts`, `.bak-2026-07-18` kept)

- **#1** `isSecretKey` now does STEM/substring matching on a fully-normalized key (lowercase, strip ALL
  non-alphanumerics incl. `. _ - space`): secret if it contains any of `token`, `secret`, `password`,
  `passwd`, `apikey`, `credential`, `privatekey`, `clientsecret`, `cookie`, `bearer`, `sessionid`,
  `accesskey`, `authorization` — so `authToken`/`idToken`→"token", `xApiKey`/`x.api.key`→"apikey", etc.
  The exact header-name set is retained (covers `pwd`, `session`, `authentication`). Innocents
  (`monkey`, `author`, `keyboard`, `name`, `title`, `content-type`) do NOT match; stem-containing
  non-secrets (`tokenCount`, `cookies`, `secretary`) are SAFE over-redaction (documented).
- **#2** `redactDeep` rewritten around an internal `walk(value, depth, seen)` with a WeakSet cycle guard
  (ancestor chain: add-on-enter / delete-on-exit, so DAG siblings aren't falsely flagged → `[Circular]`
  on a real cycle) and a `MAX_DEPTH=40` cap (→ `[REDACTED_DEEP]`). The public `redactDeep` wraps `walk`
  in try/catch and NEVER throws (worst case → `[REDACTED]`).
- **#3** `walk` handles `Map` (rebuilds a Map, applies the key-aware rule to string keys, redacts values)
  and `Set` (rebuilds a Set, redacts elements); a non-plain object (Date/Buffer/class instance) is
  stringified-then-redacted instead of silently emptied.
- **#4** new PATTERNS entry `/\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g` (label `BASIC_AUTH`) redacts a Basic
  base64 credential in prose; the ≥16-char threshold avoids mangling a short "Basic auth" phrase.

## Regression tests (`src/server/__tests__/redactStrength.test.ts`, +9)

Round-16 #1 (camelCase/compound secret keys redacted; innocents preserved; `tokenCount`/`cookies` safe
over-redaction documented), #2 (cyclic object + 120-deep nesting both sanitize without throwing), #3 (Map
secret-key value redacted / normal kept — not `{}`; Set elements traversed & shape-redacted), #4 (prose
Basic redacted incl. under a non-secret key; short "Basic auth" not mangled). The Round-15 `cookies`
sibling assertion was updated to `tags` (since `cookies` now matches the `cookie` stem).

**Confirm:** compound/camelCase secret keys are redacted (substring stems, innocents preserved beyond the
documented safe over-redaction); `redactDeep` never throws (cycle + depth guard); Map/Set are handled
(no silent `{}`); prose `Basic <b64>` is caught.

## Honest residuals (Round 16)

1. Carried forward: redaction is conservative pattern-matching; stem matching intentionally accepts rare SAFE over-redaction (`tokenCount`, `cookies`, `secretary`, `forbearer`); a bare `Bearer <odd-char token>` in FREE PROSE stays best-effort; the Windows lstat→open symlink race is narrowed-not-closed; the mid-run child-kill is code-only.
