# Factory Deck (`local-ai-factory`) — Security / QA Hardening Audit

Date: 2026-07-18 · Scope: spec 5.15 (minimum safety/quality requirements)
Repo is **not** a git checkout — every edited file has a timestamped `.bak-2026-07-18`.

---

## 1. Derived contract — what this program actually is

Derived from the code itself (README.md, package.json, `src/**`, `scripts/**`), not the name.

**Factory Deck is a local-first "AI software factory": a single-user desktop web app that turns a
one-line app idea into a small, real, self-tested app via a fixed chain of LLM "agents".**

- **Assembly line** (`src/server/orchestrator/runFactory.ts`): Intake → Product Spec → Architect →
  Task Planner → File Builder → Test Writer → QA Critic → bounded Repair Loop → Final Review.
- **Agents** (`src/server/agents/*`) each have a strict **Zod** input/output schema
  (`src/shared/schemas.ts`); model output is JSON validated before use (no free-form parsing).
- **Providers** (`src/server/providers/*`): `anthropic`, `openai`, and an offline `stub`. With **no
  keys the app degrades to `stub`/demo mode** and makes zero network calls.
- **Generated apps** are written to an isolated per-run **workspace** under `WORKSPACE_ROOT`
  (`workspace/createWorkspace.ts`, `fileWriter.ts`).
- **Package-manager commands** (install/test/build) run only through an **allowlist + workspace jail
  + dry-run** guard (`workspace/commandRunner.ts`); `DRY_RUN_COMMANDS=true` is the default.
- **Run history** is durable local JSON in `.factory/` (`storage/runsStore.ts`); a **local Express
  API** (`server/index.ts`) serves the React "Factory Deck" UI (`src/ui/**`).
- **Launcher**: `scripts/start-factory.cmd` → `start-factory.ps1` (single-process production mode).

Keys live only in the backend process; `/api/health` returns booleans, never key values.
This is **not** a cloud/multi-tenant service and has no publish/push/deploy capability anywhere.

---

## 2. Contract matrix — spec 5.15 vs. the actual checkout

Legend: ADEQUATE = already correct in the checkout · FIXED = real defect reproduced & repaired ·
PARTIAL = adequate for the threat model, residual noted · HONORED = respected during this audit.

| # | Requirement | State | Evidence / Fix (file:line) |
|---|---|---|---|
| 1 | Local-first default; cloud needs explicit config + disclosure | **ADEQUATE** | `runFactory.ts:44-46` demo/stub when no keys; providers active only when key in `.env` (`providers/index.ts:24-29`); disclosed in `README.md` "Security". |
| 2 | Isolated workspace, **no inherited secrets** | **FIXED (2 rounds)** | Isolation OK (`createWorkspace.ts`, `fileWriter.ts:safeResolve`). R1: child inherited full `process.env`. R2 (Codex #1): name-only denylist missed credential **URLs/DSNs** (`DATABASE_URL`, `MONGODB_URI`). **Fix:** `sanitizeChildEnv` now uses an **allowlist of safe names** + drops credential-URL values + strips workspace dirs from PATH (`commandRunner.ts:sanitizeChildEnv`). |
| 3 | Generated code + prompts are **untrusted** | **FIXED** | Zod validation of all agent output; files jailed. Codex #2/#3: `pnpm test/build/run` execute model-authored scripts = arbitrary code even with `--ignore-scripts`. **Fix:** `isScriptExecuting` + **approval gate** — such commands refused unless `ALLOW_UNTRUSTED_SCRIPTS=true`; dry-run off alone is insufficient. |
| 4 | **No arbitrary shell / install / exec / publish / push / deploy** without approval | **FIXED (2 rounds)** | Allowlist + `shell:false` on POSIX + dry-run default. R1: install lifecycle scripts → `hardenArgs` injects `--ignore-scripts`. R2 (Codex #4): Windows `shell:true` let a workspace `pnpm.cmd` shadow the real PM via cwd. **Fix:** `resolvePmBinary` resolves an **absolute** PM path from PATH dirs **outside** the workspace; `spawnPm` executes that path (cmd verbatim on Windows). Script-executing commands gated behind explicit approval (#3). No publish/push/deploy in the allowlist. |
| 5 | CPU / time / disk / network budgets + cancellation | **PARTIAL** | Present: model-call budget (`stages.ts:CountingProvider` + `ModelBudgetError`), repair-loop cap, 120s command timeout w/ SIGKILL (`commandRunner.ts:205`), cooperative cancel (`cancellation.ts`). Added budget test. **Residual (noted):** no explicit generated-file disk cap; no network-egress budget — mitigated because dry-run + `--ignore-scripts` remove the only egress vector at rest. |
| 6 | Durable job state survives restart **without duplicating work** | **ADEQUATE** | Every mutation flushed to `.factory/runs/<id>.json` (`runsStore.ts:27`); `normalizeLoaded` marks interrupted `queued`/`running` as `failed` — no ghost run, no re-execution (`runsStore.ts:44-56`). Covered by `runsStorePersistence.test.ts`. |
| 7 | Health checks + honest degraded states | **ADEQUATE** | `/api/health` = provider-configured booleans + models + limits + dry-run flag (`config.ts:toHealth`); registry degrades to stub honestly. Live model-reachability ping intentionally omitted (would make a paid call — see #14). |
| 8 | Redacted logs; no prompt/file secret leakage | **ADEQUATE** | Secrets isolated in `config.ts`; `withRetry` logs generic labels only (`providers/types.ts:34`); providers never log keys. **Verified** in launcher run — no key material in logs. #2 fix also blocks secrets reaching child stdout that is captured into logs. |
| 9 | Canonical path validation + cleanup can't escape job dir | **ADEQUATE** | `safeResolve` rejects absolute + `..` + Windows drive-letter tricks (`fileWriter.ts:24-45`); `isInsideWorkspace` guards command cwd; `pruneOldRuns` deletes only names under `.factory`. Covered by `workspace.test.ts`. |
| 10 | Preview + diff before applying changes | **PARTIAL (by design)** | Dry-run previews commands; UI has Files/diff panels + `SafetySettingsPreview`. File writes go straight to the disposable jailed workspace (the product's purpose); no host-side approval gate needed since writes cannot escape or execute. |
| 11 | Rollback/restore on failed build/test | **PARTIAL** | Failed runs marked `failed`; repair loop re-generates; no destructive host action ever taken. Full VCS-style rollback not implemented — low risk (workspace is isolated + disposable). Noted. |
| 12 | Idempotent start/stop, no orphans | **FIXED (6 rounds)** | R1: no already-running guard → clean handler + preflight. R2 (Codex #6): server + launcher require the `service:"factory-deck"` marker before treating an occupied port as ours (else exit 1). R3: prod preflight + poller could open a foreign/non-JSON 200 → both marker-gated. R4: **dev-mode fallback poller** opened `:5180` on a bare 200 → now marker-gated. R5: non-2xx foreign responder (404/500) misclassified as free → HTTP-error response now = foreign. R6: a non-HTTP foreign listener (HTTP times out, no `.Response`) was still classified free → added a raw TCP-connect probe (`Test-PortListening`) as the authoritative occupancy signal (a free port on this host *times out* rather than refusing, so status-based classification is unusable). **Final classification:** marker→ours(exit 0); any other HTTP reply→foreign(exit 1); no HTTP but TCP listener present→foreign(exit 1); no HTTP and no listener→free(continue). **Verified live:** foreign on :5179 (200/404/raw-non-HTTP) and :5180 → never opened, classified foreign; genuinely free → continues; real 2nd instance → exit 0; clean stop → no listener. |
| 13 | Tests: sandbox-escape, prompt-injection, budget, crash-recovery, path-traversal, launcher | **MOSTLY PRESENT + ADDED** | Existing: path-traversal/allowlist/outside-jail (`workspace.test.ts`), shell-injection (`commandShellSafety.test.ts`), crash-recovery (`runsStorePersistence.test.ts`), cancellation. **Added** `commandEnvHardening.test.ts`: secret-isolation, untrusted-install neutralization (prompt-injection mitigation), model-call budget. Launcher idempotency verified manually (port-binding not suited to vitest). |
| 14 | **Never publish/execute generated products during verification** | **HONORED** | All verification used stub/dry-run/temp dirs. No generated app was installed, built, or run. Launcher tested with the backend only (no run created, no model call). |

---

## 3. Additional hygiene defect found & fixed (test isolation → supports #2/#6)

`stubRun.test.ts` and `cancellation.test.ts` drive full (stub) runs; `runsStore.ts` resolves its
data root from `FACTORY_DATA_DIR` **at import time** and defaults to the real `.factory`. So every
`pnpm test` wrote demo run records into the user's real history. **Fix:** isolate the store globally
via `vitest.config.ts` `env.FACTORY_DATA_DIR = ".vitest-factory-data"` + `vitest.globalSetup.ts`
(removes the throwaway dir before/after the suite). Verified: suite run leaves `.factory` unchanged
(17 → 17) and cleans its temp dir.

---

## 4. Verification results (after Codex follow-up round)

- `npx vitest run` — **53 passed** (35 pre-existing + 7 + 11 new), 11 files.
- `npx tsc -p tsconfig.json --noEmit` — **clean**.
- `prettier --check "src/**/*.{ts,tsx,css}"` — **clean**.
- Launcher idempotency + #6 (real, no keys/run/product): foreign listener (`service:"grafana"`) on
  :5179 → backend exits **1** ("in use by another process"); a real 2nd Factory instance → exits
  **0**; clean stop leaves **no listener**. `start-factory.ps1` parses with no syntax errors.
- Defense-in-depth (DRY_RUN off): credential URLs/DSNs dropped from child env; `pnpm test` refused
  without `ALLOW_UNTRUSTED_SCRIPTS`; workspace `pnpm.cmd` never resolved. All test-proven.
- No secret material in any captured log; `.factory` history unchanged (17 records).

See **CHANGELOG_PORTFOLIO_HARDENING.md** for the full per-file follow-up and backups list.

## 5. Unreproduced / residual (honest remainder)

- **#5 disk & network budgets** — not implemented (would need per-run byte accounting + egress
  policy); current mitigations (dry-run default, `--ignore-scripts`, no-network stub) cover the at-rest
  threat. Not a reproduced defect, a scope-bounded gap.
- **#11 true rollback / #10 approval-gated diff-apply** — product-design gaps, not safety holes; the
  workspace is isolated, non-executing, and disposable.
- **Launcher unit test** — idempotency proven by live run, not encoded in vitest (port binding is a
  poor vitest fixture).

## 6. External blockers

- Anthropic credits are empty on this machine (per project memory) — irrelevant here: all work used
  stub/dry-run, no live provider call was made or needed.

---

## 7. Round 7 (2026-07-18) — Codex adversarial pass mis-targeted; premise rejected with proof

A follow-up Codex adversarial review returned **needs-attention** with 5 findings, all against
`orchestrator/src/agents/action-log.js`, `orchestrator/src/security/permissions.js`,
`.../log-redact.js`, and `.../canonical.js`. **These files do not exist in this repo, and neither do
any of the functions they cite** (`verifyChain`, `consumeApproval`, `canonicalJson`,
`fingerprintParams`, `shouldAutoApprove`) nor the tools they reference (`memory_search`,
`memory_keyword`, `rag_search`) nor the concepts (HMAC/`createHmac` action-log chain, SQLite approval
rows, `result_preview`, per-tool `risk` enum). Verified by ripgrep over the entire tree
(`src/`, `scripts/`, `dist/`, `workspaces/`, incl. `node_modules`) → **0 matches for every
identifier**, and by `find` → no `*action-log*`/`*permission*`/`*redact*`/`*canonical*` file exists.
The only `orchestrator` directory is `src/server/orchestrator/` (`cancellation.ts`, `repairLoop.ts`,
`runFactory.ts`, `stages.ts`), a linear LLM assembly line with **no tool registry, no approval DB, no
retrieval tools, no hash-chained log, no risk levels, and no params fingerprinting**.

**Conclusion:** the review targeted a different (tool-calling-agent) codebase — not Factory Deck. All 5
findings are **NON-REPRODUCIBLE / NOT-APPLICABLE** here; none can be fixed and no regression test can
cover functions that do not exist. Per the no-fabrication rule, **no fake subsystem was invented** to
make the review "pass." No source file was edited; only these two audit docs were touched (backups
`.bak-2026-07-18`). Real suite re-run: `npm test` → **53 passed / 53**, 11 files, unchanged. Full
finding-by-finding proof table is in `CHANGELOG_PORTFOLIO_HARDENING.md` → "Round 7". Recommendation:
re-point the Codex pass at the intended repository and re-run.

> **Update:** the recommendation was taken. The Codex pass was re-run against the **real** Factory Deck
> files and confirmed the architecture read here — **and** found **4 genuine defects in the actual
> code**, all now fixed + regression-tested (see §8). So the wrong-codebase note above stands for the
> *original* 5 findings, while the *re-pointed* pass produced real, actionable results.

---

## 8. Round 8 (2026-07-18) — Codex pass re-targeted at the real files; 4 real defects fixed

The re-pointed adversarial pass validated Factory Deck's design (linear assembly line; `safeResolve`
contains generated writes; bounded repair loop; no model-supplied command strings) and surfaced 4 real
defects. Each was reproduced from the code, fixed with the smallest robust change, and given a focused
regression test.

| # | Severity | Defect | Fix (file) | Regression test |
|---|---|---|---|---|
| 1 | HIGH | `pnpm install` runs project-controlled code (`.pnpmfile.cjs`, which `--ignore-scripts` doesn't disable) **without** the approval gate | `isScriptExecuting` gates install/ci (fail closed); `hardenArgs` adds `--ignore-pnpmfile` for pnpm (`commandRunner.ts`) | `installGate.test.ts` (3) |
| 2 | HIGH | Persisted run data + generated file contents exposed over **unauthenticated LAN HTTP** (`0.0.0.0`, no auth); raw idea logged verbatim | Loopback-default bind, token-gated LAN opt-in (fail closed), bearer-token `/api` middleware, `RunId` param validation, secret redaction in durable logs (`index.ts`, `config.ts`, `security/access.ts`, `security/redact.ts`, `stages.ts`) | `lanAuth.test.ts` (11) |
| 3 | MEDIUM | Cancellation didn't stop **file writes / child spawns** inside an active stage | Cancel checks before every `writeBuild` + command spawn; `runCommand` `shouldCancel` refuses-to-spawn / force-kills the child (`runFactory.ts`, `commandRunner.ts`) | `commandCancel.test.ts` (1) |
| 4 | MEDIUM | Run persistence lacked **id containment** for non-UUID ids (a planted `seed.json` with `id:"../../outside"` could write outside `.factory`) | Strict `RunIdSchema` (uuid) + `storeFilePath` containment + id≠stem rejection + route-param validation (`schemas.ts`, `runsStore.ts`, `index.ts`) | `runIdContainment.test.ts` (4) |

**Verification:** `npm test` → **71 passed / 71** (15 files; was 53/53). `npm run typecheck` (server +
ui) clean. `prettier --check "src/**"` clean. `.factory` history unchanged (17 records). No untrusted
product executed; no network side effects. Backups: pre-existing `.bak-2026-07-18` kept for
commandRunner/index/config/runFactory; new `.bak-2026-07-18` for stages/runsStore/schemas and the two
edited test files. **Honest residuals** (documented in the CHANGELOG Round 8): generated file contents
+ raw idea remain stored verbatim (now loopback/token-protected, not content-redacted); the mid-run
child-kill path is code-exercised but not unit-tested (avoids spawning a real process); redaction is
conservative pattern-matching, not exhaustive.

---

## 9. Round 9 (2026-07-18) — Codex residual sweep on the real fixes; 7 residuals closed

Codex confirmed the Round-8 core fixes hold (install gate unconditional; LAN middleware covers all
`/api/runs*`; IP taken from `socket.remoteAddress` so XFF/Host spoofing is ignored; UUID run-id
validation blocks traversal) and flagged 7 residuals. All reproduced, fixed fail-closed, and tested.

| # | Sev | Residual | Fix (file) | Test |
|---|---|---|---|---|
| 1 | MED | `hardenArgs` substring-fragile — `--ignore-scripts=false` defeats it | strip all `--ignore-(scripts\|pnpmfile)*` variants, append canonical flags LAST (`commandRunner.ts`) | `installGate.test.ts` +1 |
| 2 | MED | cancel not checked per-file in a multi-file `writeBuild` | `throwIfCancelled` before + after each `writeWorkspaceFile` (`runFactory.ts`) | `cancellationDeep.test.ts` |
| 3 | MED | cancel during the final-reviewer call was lost → `completed` | `throwIfCancelled` right after the `finalReviewerAgent` await, before the terminal mutation (`runFactory.ts`) | `cancellationDeep.test.ts` |
| 4 | MED/HIGH | run-id containment LEXICAL only — a symlinked/junctioned store dir escapes | `guardStoreDirs` (realpath-under-data-root + reject symlink dir) + `safeStorePath` (reject symlink file); route **every** persist/read/prune path through them (`runsStore.ts`) | `runStoreSymlink.test.ts` |
| 5 | LOW | token compare early-returns on length mismatch (timing leak) | compare fixed-length SHA-256 digests via `timingSafeEqual` (`access.ts`) | `lanAuth.test.ts` +2 |
| 6 | MED | remote-via-local-proxy bypass — loopback trusted unconditionally | when a token is configured, require it for **every** `/api` request incl. loopback; `/api/health` exempted for the launcher marker (`access.ts`, `index.ts`) | `lanAuth.test.ts` +3 |
| 7 | MED | `run.error` persisted/served un-redacted | `redactSecrets(run.error)` before persistence (`runFactory.ts`) | `errorRedact.test.ts` |

**Verification:** `npm test` → **81 passed / 81** (18 files; was 71/71). `npm run typecheck` (server +
ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17). No untrusted product executed;
no network side effects. New `.bak-2026-07-18` for `access.ts` + the two edited test files; existing
backups kept for commandRunner/runFactory/runsStore/index. **Residuals (Round 9, honest):** the
file-level (`<id>.json`) symlink refusal is coded (`safeStorePath`) but only the store-**dir** escape is
asserted (a *file* symlink needs elevated privileges on Windows); the mid-run child-kill on cancel is
still code-only (not unit-tested to avoid spawning a real process); and setting `FACTORY_AUTH_TOKEN`
now requires the UI/local clients to send the token on `/api` calls (health exempt) — a product wiring
task, not a security hole, with the loopback-only-no-token default unchanged.

---

## 10. Round 10 (2026-07-18) — Codex residual sweep #2; 6 residuals closed (TOCTOU + served-field redaction)

Codex confirmed cancel / token-compare / `/api` auth / `run.error` redaction are CLOSED and flagged 6
more: **#2 a real TOCTOU** in the store-dir guard, and **#4-6 extending redaction to the other served
fields**. All reproduced, fixed fail-closed, tested.

| # | Sev | Residual | Fix (file) | Test |
|---|---|---|---|---|
| 1 | LOW | `hardenArgs` strip regex case-SENSITIVE (`--Ignore-Scripts=false` survives) | strip regex `…/i` (`commandRunner.ts`) | `installGate.test.ts` +1 |
| 2 | HIGH | `guardStoreDirs` memoized SUCCESS → swap-after-pass TOCTOU | re-check dirs on every call; latch only failures (`runsStore.ts`) | `runStoreTOCTOU.test.ts` |
| 3 | MED | `pruneOldRuns` `stat`s raw joined path → follows a symlinked `<id>.json` | resolve via `safeStorePath` before `stat`, skip refused entries (`runsStore.ts`) | `runStoreTOCTOU.test.ts` |
| 4 | MED | `run.idea` persisted/served raw | `redactSecrets(args.idea)` for the served copy; raw idea still passed to the model (`runFactory.ts`) | `servedRedaction.test.ts` |
| 5 | MED | `finalReport` assigned raw | `redactDeep(report)` — recursive string redaction (`runFactory.ts`, `redact.ts`) | `servedRedaction.test.ts` |
| 6 | MED | generated file contents persisted/served raw | `redactSecrets` per file in `saveRunFiles` (served/persisted copy; workspace product untouched) (`runsStore.ts`) | `fileContentsRedact.test.ts` |

**Verification:** `npm test` → **87 passed / 87** (21 files; was 81/81). `npm run typecheck` (server +
ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17). No untrusted product executed;
no network side effects. New `.bak-2026-07-18` for `redact.ts` + `cancellation.test.ts`; existing
backups kept for commandRunner/runsStore/runFactory/installGate.

**Documented-residual update:** the earlier "verbatim idea / file contents stored" residual (Rounds
8-9) is now **superseded on the served copies** — `run.idea`, `run.finalReport`, generated file
`contents`, `run.error`, and all durable log lines are redaction-scrubbed before they are persisted or
returned by the API. The raw idea still reaches the model, and the raw generated file still lands in
the disposable workspace (the product), by design. **Residuals (Round 10, honest):** redaction stays
conservative pattern-matching (not a guarantee every secret shape is caught); the mid-run child-kill on
cancel is still code-only (not unit-tested); QA/repair agents still see raw in-memory file contents to
analyze/patch real code — only the copy that leaves the process is redacted.

---

## 11. Round 11 (2026-07-18) — Codex residual sweep #3; redaction moved to the SERVE boundary + strengthened

Codex confirmed the write-path fixes are closed but found redaction was **write-time only** (old/planted
records served RAW) and the redactor **missed common secret shapes**. All 7 fixed (1-5 priority).

| # | Sev | Residual | Fix (file) | Test |
|---|---|---|---|---|
| 1 | HIGH | `getRun`/`listRuns` serve OLD/PLANTED raw run records | `sanitizeRunRecordForServe` on load (getRun copy + listRuns summary) (`runsStore.ts`, `redact.ts`) | `serveLoadRedaction.test.ts` |
| 2 | HIGH | `getRunFiles` serves OLD/PLANTED raw file records | `sanitizeFileRecords` on load + cache (`runsStore.ts`) | `serveLoadRedaction.test.ts` |
| 3 | MED | `spec.appName` stored raw | `run.appName = redactSecrets(spec.appName)` (`runFactory.ts`) + serve-boundary | `serveLoadRedaction.test.ts` |
| 4 | MED | file **path/purpose** metadata not redacted (only contents) | `redactDeep` each FileContent (path+purpose+contents) on write + load (`runsStore.ts`, `redact.ts`) | `serveLoadRedaction.test.ts` |
| 5 | HIGH | redactor missed cred-URLs, case-insensitive env, `github_pat_` | `CRED_URL` userinfo strip; `ENV_SECRET` `/i` + `URL\|URI\|DSN\|AUTH\|SESSION`; `github_pat_` shape (`redact.ts`) | `redactStrength.test.ts` |
| 6 | MED | non-atomic lstat→write window | `writeFileContained` = `O_NOFOLLOW` (where supported) + `fstat` regular-file re-check (`runsStore.ts`) — **narrowed + documented**, Windows residual honest | `writeContainedFd.test.ts` |
| 7 | LOW | guard **failure latch** wedges the store until restart | `guardStoreDirs` revalidates every call, no latch — recovers when the unsafe condition is removed (`runsStore.ts`) | `guardRecovery.test.ts` |

**Verification:** `npm test` → **101 passed / 101** (25 files; was 87/87). `npm run typecheck` (server +
ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17). No untrusted product executed;
no network side effects. Existing `.bak-2026-07-18` kept for redact/runsStore/runFactory.

**Confirmations:** redaction now happens at the **SERVE boundary** — old/planted records are redacted on
load by `getRun`/`listRuns`/`getRunFiles`; the redactor catches **credential-URLs, case-insensitive env
names, and GitHub tokens**; **appName + file path/purpose** are redacted; the **TOCTOU is narrowed +
documented** (O_NOFOLLOW where available; Windows residual honest); and the **guard-latch can recover**
from a transient condition. **Residuals (Round 11, honest):** redaction is still conservative
pattern-matching (can occasionally over-redact `NAME: value` prose — safe direction); the Windows
lstat→open symlink race is narrowed but not fully closed without OS-level data-dir permissions; the
mid-run child-kill on cancel remains code-only.

---

## 12. Round 12 (2026-07-18) — Codex residual: CRED_URL missed a bare `user@` userinfo

Single MEDIUM residual: the credential-URL redactor only stripped `user:pass@` (colon-password), not a
**bare `user@`** — a token-in-userinfo (`https://tokensecret@git/repo`) leaked in served
logs/files/finalReport.

| # | Sev | Residual | Fix (file) | Test |
|---|---|---|---|---|
| 1 | MED | `CRED_URL` only matched `user:pass@`, not bare `user@` | strip the whole userinfo run `…://[^\s/@?#]+@` → `…://[REDACTED]@` (`redact.ts`) | `redactStrength.test.ts` +3 |

**Verification:** `npm test` → **104 passed / 104** (25 files; was 101/101). `npm run typecheck`
(server + ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17). No side effects.
`.bak-2026-07-18` for `redact.ts` kept.

**Confirm:** bare-userinfo URLs (`scheme://user@host`) are now redacted at the serve boundary alongside
`user:pass@`; plain `https://host/path` and prose `@`/emails are not mangled. **Residuals:** unchanged
from Round 11 (conservative pattern-matching; Windows lstat→open race narrowed-not-closed; mid-run
child-kill code-only).

---

## 13. Round 13 (2026-07-18) — Codex residuals: multi-@ URL userinfo + opaque Bearer tokens

Two serve-boundary redactor edges (both route through the redactor via
`sanitizeRunRecordForServe`/`sanitizeFileRecords`).

| # | Sev | Residual | Fix (`redact.ts`) | Test |
|---|---|---|---|---|
| 1 | MED | `CRED_URL` stopped at the FIRST `@`, leaking a multi-@ userinfo tail (`a@stillsecret@host`) | allow `@` inside the userinfo run (`…:\/\/)[^\s/?#]+@`) so it reaches the LAST authority `@` | `redactStrength.test.ts` +2 |
| 2 | MED | opaque `Bearer <token>` left the token (only JWT-shaped matched) | new `BEARER_TOKEN` pattern `/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi` (runs first, case-insensitive) redacts the whole `Bearer <token>` | `redactStrength.test.ts` +2 |

**Verification:** `npm test` → **108 passed / 108** (25 files; was 104/104). `npm run typecheck`
(server + ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17). No side effects.
`.bak-2026-07-18` for `redact.ts` kept.

**Confirm:** multi-@ URL userinfo (`scheme://a@secret@host`) and opaque Bearer tokens are now fully
redacted at the serve boundary — without over-matching paths (`https://host/a@b`), queries
(`?x=a@b`), prose/emails, or a stray "bearer" with no token. **Residuals:** unchanged (conservative
pattern-matching; Windows lstat→open race narrowed-not-closed; mid-run child-kill code-only).

---

## 14. Round 14 (2026-07-18) — Codex residual: auth-header partial-redaction leaks

Four serve-boundary leaks where only a keyword/token was redacted, leaving the rest of a secret HTTP
header value.

| # | Sev | Residual | Fix (`redact.ts`) | Test |
|---|---|---|---|---|
| 1 | MED | `Authorization/Proxy-Authorization: Basic <b64>` — only `Basic` matched, base64 remained | whole-value `HEADER_SECRET` rule | `redactStrength.test.ts` +2 |
| 2 | MED | `X-Api-Key: opaque secret-tail` — only first token redacted | whole-value `HEADER_SECRET` rule | ″ |
| 3 | MED | `Authorization: Bearer abc$stillsecret` — token class stopped at `$` | whole-value `HEADER_SECRET` rule (header case) | ″ |
| 4 | MED | `Cookie`/`Set-Cookie`/`X-Amz-Security-Token`/`X-Auth-Token`/`Api-Key` values served raw | covered by the same rule | ″ |

**Fix:** new `HEADER_SECRET = /^([ \t]*(?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Api-Key|X-Amz-Security-Token|Cookie|Set-Cookie))[ \t]*:[ \t]*.+$/gim` — redacts EVERYTHING after the colon to
end-of-line (keeping the header name), run BEFORE the narrower token rules; `m`/`.+` stops at line end so
non-header lines and `Content-Type:` are untouched. The bare-prose `BEARER_TOKEN` rule is retained
(best-effort for odd chars in prose; header lines fully covered).

**Verification:** `npm test` → **110 passed / 110** (25 files; was 108/108). `npm run typecheck`
(server + ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17). No side effects.
`.bak-2026-07-18` for `redact.ts` kept.

**Confirm:** secret-bearing HTTP header values (Basic/Bearer/opaque/Cookie/…) are now **fully redacted to
end-of-line** at the serve boundary, header name kept, without over-redacting non-secret headers or
non-header lines. **Residuals:** conservative pattern-matching; bare `Bearer <odd-char token>` in free
prose is best-effort; Windows lstat→open race narrowed-not-closed; mid-run child-kill code-only.

---

## 15. Round 15 (2026-07-18) — Codex residuals: key-aware structured redaction + obs-fold

Two serve-boundary edges over structured finalReport / file records (`redactDeep` path).

| # | Sev | Residual | Fix (`redact.ts`) | Test |
|---|---|---|---|---|
| 1 | MED | `redactDeep` value-only — a secret-KEYED value (`{authorization:"Basic …"}`, `{x-api-key:"opaque$secret"}`, `{authorization:"Bearer abc$def"}`) leaked/partial | KEY-AWARE `redactDeep`: `SECRET_KEYS` set (normalized) → whole value → `[REDACTED]` regardless of shape (no recurse into secret-keyed objects) | `redactStrength.test.ts` +5 |
| 2 | LOW | `HEADER_SECRET` `.+$` stopped at first EOL → obs-fold continuation leaked | value also consumes `(?:\r?\n[ \t]+.+)*` continuation lines (whitespace-led), not a column-0 next header | `redactStrength.test.ts` |

Also raised timeouts on the two `freshStore()`-based `fileContentsRedact` tests (`.bak-2026-07-18` new):
the `vi.resetModules()` re-transform can exceed the default 5 s under full-suite parallel load — a
stability fix, no behavior change.

**Verification:** `npm test` → **115 passed / 115** (25 files; was 110/110), stable across repeated runs.
`npm run typecheck` (server + ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17).
No side effects. `.bak-2026-07-18` for `redact.ts` kept.

**Confirm:** structured secret-KEYED values (incl. nested token objects) and obs-fold header
continuations are now redacted at the serve boundary. **Residuals:** conservative pattern-matching; a
bare `Bearer <odd-char token>` in free prose (not a header line, not a secret-keyed object) stays
best-effort; Windows lstat→open race narrowed-not-closed; mid-run child-kill code-only.

---

## 16. Round 16 (2026-07-18) — Codex residuals: stem keys, cycle/depth guard, Map/Set, prose Basic

Four `redactDeep`/redactor residuals on the structured-value serve path.

| # | Sev | Residual | Fix (`redact.ts`) | Test |
|---|---|---|---|---|
| 1 | HIGH | exact-membership secret keys miss camelCase/compound (`authToken`, `xApiKey`, `x.api.key`) | STEM/substring match on fully-normalized key (+ retain exact set) | `redactStrength.test.ts` +3 |
| 2 | MED | `redactDeep` no cycle/depth guard → `RangeError` on cyclic/deep records | WeakSet ancestor-chain cycle guard + `MAX_DEPTH=40`; never throws (try/catch) | `redactStrength.test.ts` +2 |
| 3 | MED | Map/Set silently become `{}` (data loss) | `walk` handles Map (key-aware) / Set; non-plain objects stringified-then-redacted | `redactStrength.test.ts` +2 |
| 4 | LOW | prose `Basic <b64>` under a non-secret key not caught | `BASIC_AUTH` pattern `/\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g` (≥16 threshold) | `redactStrength.test.ts` +2 |

**Verification:** `npm test` → **124 passed / 124** (25 files; was 115/115), stable across repeated runs.
`npm run typecheck` (server + ui) clean. `prettier --check "src/**"` clean. `.factory` unchanged (17).
No side effects. `.bak-2026-07-18` for `redact.ts` kept; `redactStrength.test.ts` backed up.

**Confirm:** compound/camelCase secret keys redacted (substring stems; innocents `monkey`/`author`/
`keyboard`/`name`/`title`/`content-type` preserved, with `tokenCount`/`cookies`/`secretary` as documented
SAFE over-redaction); `redactDeep` never throws (cycle + depth guard); Map/Set handled (no silent `{}`);
prose `Basic <b64>` caught. **Residuals:** conservative pattern-matching + intentional rare safe
over-redaction from stems; bare odd-char `Bearer` in free prose best-effort; Windows lstat→open race
narrowed-not-closed; mid-run child-kill code-only.
