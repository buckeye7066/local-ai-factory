# Factory Deck hardening contract

This document is the maintenance playbook for the failure classes fixed in
the checkpoint, provider-routing, spend-control, repair, and verification
pipelines. These are executable invariants, not suggestions. A future Factory
Deck change that weakens one needs a replacement test proving an equally strong
boundary.

## 1. Checkpoints are durable execution state

- The only writable checkpoint shape is v3 (`FactoryCheckpointSchema`).
- The loader accepts v1/v2, migrates them deterministically, and atomically
  rewrites v3 before returning execution state.
- A legacy explicit `anthropic` or `openai` selection migrates as paid
  authorization. Configured keys and server defaults never do.
- Missing is the only condition that returns `null`. Malformed JSON, an unknown
  schema version, an identity mismatch, and I/O failure throw a typed
  `CheckpointPersistenceError`.
- Writes use a same-directory exclusive temporary file, file `fsync`, atomic
  rename, and best-effort directory `fsync`. The in-memory record is updated
  only after durable persistence succeeds.

Why: treating corrupt state as “no checkpoint” replays paid model calls and may
repeat workspace writes. Truncating the live JSON file can turn a power loss
into that exact condition.

When the checkpoint shape changes, add a new schema version and a deterministic
migration. Never add permissive parsing at call sites.

## 2. Paid work requires two independent grants

A paid SDK request may start only when both are true:

1. the run/session explicitly carries `allowPaidProviderCalls: true`; and
2. the paid-budget ledger durably reserves capacity for the prospective call.

The FREE card is FREE-ONLY. The presence of an API key, a paid default in
`.env`, a critical stage, a free-route stall, an epic planner, a clarification
turn, or a resume does not create authorization. Selecting Claude/OpenAI in the
UI sets the grant. Resume provider changes persist that grant or revocation in
the checkpoint before execution becomes queued.

Every concrete run provider is wrapped once:

```text
quota routing -> budget gate (paid only) -> model-call counter -> SDK/free backend
```

Quota alternates must be selected from the same wrapped provider map. Passing a
raw registry provider as an alternate bypasses both accounting and the spend
gate.

## 3. The paid ledger fails closed

Default limits are finite and JSON-safe: 6 calls/hour, 24 calls/day, and
$2/day unless the owner deliberately changes `FACTORY_PAID_*` values. Infinity
must never reach `/api/health` because JSON serializes it as `null` and breaks
the shared health contract.

Before a paid call, `reservePaidCall` records:

- one concurrent call slot;
- a conservative UTF-8 input-token ceiling;
- the requested maximum output tokens; and
- estimated maximum cost.

The synchronous reservation decision and atomic ledger write happen before the
provider is invoked. Concurrent callers therefore cannot all observe the last
open slot. Real usage is appended independently, then a successful logical call
releases its exact reservation ID; this avoids same-provider calls consuming
one another's slots when they finish out of order. An error with uncertain
billing leaves its reservation in place. A corrupt or unwritable ledger blocks
paid work instead of resetting spend to zero.

## 4. Acceptance is an immutable evidence map

At specification time, user flows and acceptance criteria receive stable IDs:
`UF-1`, `UF-2`, … and `AC-1`, `AC-2`, …. Agents must carry those IDs through the
test plan. Text similarity is not coverage.

Generated tests are parsed mechanically. The gate rejects skipped/todo tests,
literal-only assertions, and browser fixtures that never navigate to the real
app. UI behavior requires a real browser flow with an app navigation,
interaction, and meaningful assertion (plus reload where persistence is part
of the requirement).

Verification runs each generated test path directly using an engine-selected
Vitest, Jest, Playwright, or Pytest command. Structured reporter output must
name at least one passing test and zero skipped/pending tests. A green host
suite that did not execute the run's tests is not evidence for the run.

## 5. Repair cannot manufacture success

- A repair can write only product files that the run created or fully inspected.
- It cannot edit tests, manifests, lockfiles, or test/build configuration to
  make the signal green.
- Refused writes are durable. A required refusal blocks delivery even after a
  restart.
- Zero accepted writes are reported as zero writes; model prose cannot claim a
  patch landed.
- Verification runs after each accepted repair and before QA is re-evaluated.
- Missing execution evidence and deterministic environment failures skip the
  paid repair loop. File edits cannot repair a missing native binary or invent
  a test execution receipt.

## 6. Final review is not the release authority

The narrative reviewer may summarize evidence but cannot override it. Release
requires all of the following:

- grounded QA passes;
- directly relevant tests pass;
- every required command/evidence item completed;
- no blocking write refusal remains; and
- current deliverable bytes match the SHA-256 verification receipt.

If any condition fails, Factory Deck performs no commit, push, pull request, or
release. If the reviewer model itself fails, the deck produces a deterministic
evidence-only report; it does not convert a verified build into a failure or an
unverified build into a success.

## Regression checklist

Run with Node 20, the supported floor:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Focused suites for these boundaries include:

- `checkpointDurability.test.ts` and `checkpointResume.test.ts`
- `paidBudgetGate.test.ts`, `freeRouteFailover.test.ts`, and
  `quotaFailover.test.ts`
- `liveNoMockFallback.test.ts` and `runOptionsStrict.test.ts`
- `acceptanceGate.test.ts` and `directTestEvidence.test.ts`
- `groundedEditEngine.test.ts`, `honestRunAccounting.test.ts`,
  `qaGrounding.test.ts`, `releaseRun.test.ts`, and `runOutcome.test.ts`

Review rule: trace every alternate, retry, resume, and advisory fallback to the
same authorization, counting, persistence, and evidence choke points as the
primary path. Most prior failures were bypass paths, not failures of the main
happy path.
