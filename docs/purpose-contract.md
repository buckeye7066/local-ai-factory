# Purpose & Acceptance Contract — Factory Deck

**Version:** 0.2  
**Application:** Factory Deck  
**Repository:** [buckeye7066/local-ai-factory](https://github.com/buckeye7066/local-ai-factory)  
**Default branch:** `main`  
**Launcher:** `C:\Users\firer\local-ai-factory\scripts\start-factory.cmd` → `start-factory.ps1`

## Intended users

Operators who need a provider-agnostic **local AI software factory** that runs **real** factory jobs end-to-end (Anthropic and/or OpenAI), with durable job state, cancel/resume safety, and honest failure — not mock-only success presented as readiness.

## Primary problem solved

Orchestrate a multi-agent software-factory workflow with:

- real (paid) providers on the live path
- durable, inspectable job state and workspace artifacts
- sandboxed command execution defaults
- cancel during long operations without corrupting authoritative inputs
- explicit offline **demo** mode that never claims Production Ready

## Core user journey (must remain intact)

1. **Launch** from `scripts/start-factory.cmd` (or `pnpm start` / `pnpm factory`) on a tree whose SHA matches the certified `main` tip.
2. **Submit a live factory job** (not `--demo`) using Anthropic and/or OpenAI as configured in `.env`.
3. **Observe** stage progress, completion (or honest failure), and inspectable workspace + attribution artifacts.
4. **Provider / cancel / timeout failures** do not corrupt source inputs; workspaces remain jailed under `WORKSPACE_ROOT`.
5. **Cancel** a running job and confirm terminal `cancelled` status with durable audit/attribution.

## Scope that must not be narrowed

A **mock/stub provider completing a synthetic/demo job is not purpose fulfillment** and is **not** Production Ready. Offline demo remains a supported *development* path only when `options.demo === true` (or CLI `--demo`) is explicit.

Silent coercion of live runs into mock success when credentials are missing is **forbidden**.

## Production acceptance tests

| Gate | Requirement |
|------|-------------|
| Real-provider journey | Live job (`demo: false`) completes (or fails honestly) using Anthropic and/or OpenAI — **or** status is `BLOCKED` with the exact missing credential env var name(s) |
| No fake-success | Live path never falls back to mock/stub; missing keys return a clear credential error |
| Controls | Executable `release:check`, `.github/workflows/production-readiness.yml`, typechecking, and the complete automated test suite |
| Evidence | This contract, final-SHA GitHub Actions results, and real-provider journey evidence |
| Reviews | Independent functional, security, and release review is an owner-controlled external gate; implementation code must not self-attest it |
| Identity | Exact default-branch SHA equals local launcher/runtime tree before Production Ready |

## Explicit blockers (honest)

- Missing `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` for the live path → **BLOCKED** (list exact missing names). Still finish all unblocked software + permanent gates.
- Independent reviews are owner-controlled and external to repository bookkeeping; implementation code must not create a readiness attestation.
- Launcher/runtime SHA ≠ `main` tip → **BLOCKED** for Production Ready (sync required).

## Forbidden claims

- Prior “PRODUCTION READY” / mock-first control-plane proofs as full readiness
- Self-certified Production Ready by the implementer
- `proof:mock-e2e` alone as purpose fulfillment
- Mock/stub/offline alone for the real-provider requirement

## Deployment target

Local Windows factory. GitHub `main` is source of truth. Runtime under `C:\Users\firer\local-ai-factory` must match the certified `main` SHA before Production Ready.
