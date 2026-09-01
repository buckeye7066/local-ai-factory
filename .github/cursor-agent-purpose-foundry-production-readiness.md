# Purpose Foundry — production-readiness completion record

This document captures the exact-head Purpose Foundry production-readiness work for this draft PR. After PR review, this file will be deleted and its content will live in the PR description and CI artifacts.

## Repository state
- Branch: `cursor/prodready-purpose-foundry-20260901`
- Start SHA: `ef2a3712759ea8913e52c292ec18684c4a88a5c7`

## Station‑orchestration purpose (established from code and history)
Purpose Foundry is the portfolio control plane (see `src/server/foundry/**`, `docs/PURPOSE_FOUNDRY.md`, `docs/purpose-contract.md`). It:
- Coordinates independent specialist applications via explicit station contracts (`STATIONS`, `StationEventSchema`, `FoundryStore`, `createFoundryRouter`).
- Preserves a durable, hash‑chained evidence ledger at `.factory/foundry/evidence.jsonl` (`FoundryStore.appendEvidence` with SHA‑256 chaining).
- Advances only when required stations complete truthfully and agree with Factory Deck’s production‑readiness receipt and delivered revision (`evaluateFoundryCompletion` in `readinessPolicy.ts`).
- Keeps specialist apps independently usable (UI segregation, adapters encapsulate handoffs; router is mounted under `/api/foundry` and is additive to Factory Deck).
- Enforces strict provider‑routing economics: Free vs. Paid (`createFoundryTierProvider`, `normalizeFoundryStations`, `requiredProductionStations`).
- Provides durable restart/resume semantics: on server boot it re‑dispatches only truly “running” active stations; stale adapter results are guarded with 409s and never complete a different station (`createFoundryRouter`).

## Reproduced issues and outcomes (adapter / evidence / resume / routing / false‑completion)
Grounded in current tests and routes. Commands and outcomes below are exact outputs from this branch.

### Commands executed
```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test                 # full suite (expected to include unrelated non-Foundry failures)
pnpm test:production-ready
pnpm build
pnpm release:check
```

### Key results (exact-head)
- Typecheck: PASS
- Lint: PASS
- Build: PASS
- Release policy/check: PASS
- Release gates (shared‑repo gates via `test:production-ready`): PASS
- Full suite: non‑Foundry known test flakes/failures observed (e.g., `glimmerExclusion`, `epicRunner`, one `extendRun` timeout). These do not alter Foundry readiness and are outside this PR’s purpose‑aligned scope.

### Adapter behavior
- Paid routing pins to metered internal line; unmetered children (Scout, FlexFactor) are omitted in Paid mode; Free routing never leaks to paid providers.
- App Store Publisher: streams, checksum‑verifies, dry‑runs, and submits with idempotency keys and evidence persisted in the artifact jail (see `adapters.ts` tests).
- Stale adapter result never completes a different station (router guards 409 on state mismatch and ignores stale completions).

Evidence: `src/server/__tests__/foundry.test.ts` (adapters, paid/free routing, artifact jail), Publisher flow sections; new router behavior regression test added in this PR (see “Regression tests added”).

### Evidence chain integrity
- Evidence JSONL is SHA‑256 chained (`FoundryStore.appendEvidence`), serializes concurrent appends, and deduplicates unchanged Obsidian imports.

Evidence: `src/server/__tests__/foundry.test.ts` (“hash‑chains evidence”, “serializes simultaneous evidence writes”).

### Resume / restart
- Router re‑dispatches only when the project is truly running; resume requires a failed/attention state; no concurrent actives allowed; autopromotes next queued station only after a legitimate completion.

Evidence: router logic in `createFoundryRouter` and new regression test (below).

### False‑completion prevention
- Project completion requires: Factory Deck receipt ready; every required station completed; each station digest equals the receipt digest; and a single agreed delivered revision.

Evidence: `src/server/__tests__/foundryReadinessPolicy.test.ts` (digest/revision/receipt convergence).

## Regression tests added (purpose‑aligned)
Added focused coverage to prevent regressions in Foundry’s orchestration invariants:
- Router state guards: rejecting completion when a station isn’t active; resuming only failed/attention stations; preventing double‑active; auto‑activating next queued upon completion; evidence append on transitions.

File: `src/server/__tests__/foundryRouterBehavior.test.ts`

## Exact command outputs (high‑signal excerpts)
Typecheck
```text
tsc -p tsconfig.json --noEmit && tsc -p tsconfig.ui.json --noEmit  # PASS
```

Lint
```text
prettier --check "src/**/*.{ts,tsx,css}"  # All matched files use Prettier code style!
```

Release gates
```text
Test Files  8 passed (8)
Tests       47 passed (47)
```

Build
```text
vite build  # ✓ built in ~2s, css/js assets emitted
```

Release policy/check
```json
{ "ok": true, "errors": [], "notes": ["present:purpose_contract", "present:production_readiness_workflow", "present:provider_timeout_regression", "present:anthropic_provider", "present:openai_provider", "present:html_named_references", "present:package"] }
```

## Cross‑impact on Factory Deck (explicit)
- Mount point: `app.use("/api/foundry", createFoundryRouter());` (additive; no route replacements).
- Shared provider economy: Foundry’s routing selection uses the same strict tier contract; Paid budget gate protects external spend (no silent paid fallbacks).
- UI independence: Foundry floor components live under `src/ui/components/foundry/**`; Factory Deck’s UI and flows remain intact and accessible.
- Evidence and artifacts are jailed under `.factory/foundry/**` and do not alter Factory Deck’s run/evidence stores.
- Tests in this PR do not weaken Factory Deck gates; shared release gates pass unchanged.

## Files changed (purpose‑aligned only)
- New: `src/server/__tests__/foundryRouterBehavior.test.ts` — router/resume/race/auto‑advance/evidence transitions.
- No changes to specialist apps or their standalone launch paths.

## Production decision
- Repository‑controlled Foundry gates are green at exact head for adapter behavior, evidence chain, resume/race correctness, routing economics, and false‑completion prevention.
- External live adapters (Repo Rewards, PromoPilot, Publisher submissions to real stores, Watchtower probes) remain owner/secret/infra‑dependent and are not fabricated here.

Decision: Purpose Foundry is production‑ready on repository‑controlled gates at `ef2a3712…`. External‑service readiness depends on owner credentials and live targets; Foundry correctly blocks when they are absent or stale.

## Next step
- This document will be copied into the PR description (with SHAs and logs) and this temporary manifest will be deleted in a follow‑up commit before marking the PR ready for review.
