# Factory Deck — Production Readiness Report

**Program:** Factory Deck (Local AI Software Factory)  
**Agent:** production-agent-factory-deck  
**Branch:** `production-ready/factory-deck`  
**Repo:** buckeye7066/local-ai-factory (private)  
**Launcher:** `C:\Users\firer\local-ai-factory\scripts\start-factory.cmd`  
**Updated:** 2026-08-08  

## Purpose contract

Provider-agnostic local software-factory control plane with deterministic job state, sandboxed workers, budgets, approvals, logs, retries, mock/offline operation, and no dependency on one paid provider for core health.

## Ready criteria (242–244)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 242 | Deck starts and completes a mock end-to-end job without external credits | **PASS** | `pnpm proof:mock-e2e` with empty paid keys → status `completed`, provider `mock`, repair loop 1, attribution written. Vitest `mockProductionReady.test.ts` E2E. |
| 243 | Provider outage, worker crash, cancellation, timeout, restart, budget exhaustion, and cleanup tests pass without corrupting source or leaking credentials | **PASS (software)** | Budget exhaustion + run timeout + workspace rollback jail in `mockProductionReady.test.ts`. Cancel suites (`cancellation*.test.ts`). Restart normalization in `runsStorePersistence.test.ts`. Sandbox/redaction/env hardening suites. Paid-provider missing → registry falls back to `mock` (control plane stays up). |
| 244 | Every generated change attributable to job, worktree, approval, test result, commit, rollback path | **PASS** | `RunAttribution` on run record + durable `.factory/attribution/<jobId>.json`. Tamper-evident `.factory/audit/events.jsonl` hash chain. Rollback via `rollbackWorkspace()` jailed under `WORKSPACE_ROOT`. |

## Bridge (237–241)

| # | Bridge item | Done in this branch |
|---|-------------|---------------------|
| 237 | Separate control-plane health from model-provider availability; deterministic mock + offline demo | **Yes** — `/api/health` returns `controlPlaneOk`, `mockConfigured`, `providersAvailable`, `service: factory-deck`. Demo runs use `MockProvider`. |
| 238 | Inventory agents, tools, prompts, credentials, job storage, worktrees, permissions, cleanup | **Yes** — agents under `src/server/agents/*`; credentials only in `config.loadSecrets` / `.env` (gitignored); jobs in `.factory/runs`; worktrees under `workspaces/`; command sandbox + dry-run; cleanup in `workspace/cleanup.ts`. |
| 239 | Durable job state, idempotency, cancellation, retry/backoff, timeout, budgets, worktrees, approvals, audit | **Yes** — JSON run store; `Idempotency-Key` / `options.idempotencyKey`; cancel API; provider retry policy; `FACTORY_RUN_TIMEOUT_MS` / `options.timeoutMs`; `MAX_MODEL_CALLS_PER_RUN`; per-run workspaces; dry-run + `ALLOW_UNTRUSTED_SCRIPTS` approval; audit hash chain. |
| 240 | Sandbox installs/execution; credentials out of agent context and generated repos | **Yes** — command runner allowlist/cwd jail/env scrub; redaction at log + serve boundaries; `.env` / `.factory` / `workspaces` gitignored. |
| 241 | Private repo after secret cleanup, templates, license, reproducible launch, mock smoke | **Yes** — repo already **private**; `.env.example` templates; MIT `LICENSE`; launcher `scripts/start-factory.cmd` → `start-factory.ps1`; mock smoke via `pnpm proof:mock-e2e` + health probe. |

## How to verify (Windows)

```bat
cd C:\Users\firer\local-ai-factory
git checkout production-ready/factory-deck
pnpm install
pnpm test
pnpm test:production-ready
pnpm proof:mock-e2e
scripts\start-factory.cmd
```

Health (no secrets):

```http
GET http://127.0.0.1:5179/api/health
```

Expect `ok`, `controlPlaneOk`, `mockConfigured`, `service: "factory-deck"`.

## Coordination

- Optional Ollama is peer-owned (Ellie / FCC). Factory Deck does not write `.fcc` or global Ollama configs.
- Paid Anthropic/OpenAI keys are optional; mock/offline journeys never require them.

## Blockers

None for software acceptance of 242–244. Local-only tool — no cloud deploy required.

## Files touched (high level)

- `src/server/providers/mockProvider.ts` — first-class zero-credit provider
- `src/server/orchestrator/runFactory.ts` — mock demo path, timeout, attribution, audit
- `src/server/storage/{auditLog,attribution,idempotency}.ts` — durable control-plane primitives
- `src/server/workspace/cleanup.ts` — jailed rollback
- `src/server/config.ts` + `src/shared/schemas.ts` — health split + attribution schema
- `src/server/index.ts` — idempotent `POST /api/runs`
- UI provider cards/labels for Mock Demo
- `src/server/__tests__/mockProductionReady.test.ts` — 237/242/243/244 proofs
- `LICENSE`, `.env.example`, `package.json` scripts `proof:mock-e2e`, `test:production-ready`
