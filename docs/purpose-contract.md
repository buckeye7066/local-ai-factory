# Purpose & Acceptance Contract — Factory Deck

**Version:** 0.3  
**Application:** Factory Deck  
**Repository:** [buckeye7066/local-ai-factory](https://github.com/buckeye7066/local-ai-factory)  
**Default branch:** `main`  
**Launcher:** `C:\Users\firer\local-ai-factory\scripts\start-factory.cmd` → `start-factory.ps1`

## Intended users

Operators who need a provider-neutral, local-first software factory that turns an
idea or existing repository goal into a purpose-aligned, independently
reviewable change with durable state, executable evidence, bounded cost, and
honest failure.

## Primary problem solved

Orchestrate a multi-agent software-factory workflow with:

- a real local/free provider by default, with optional paid providers
- durable, inspectable job state and workspace artifacts
- generated-command execution disabled unless the operator supplies real OS
  containment
- cancel during long operations without corrupting authoritative inputs
- a citation-linked, model-inferred Purpose Constitution for existing applications
- current, cited competitive intelligence when the requested goal makes a
  comparative claim

## Core user journey (must remain intact)

1. **Launch** from `scripts/start-factory.cmd` (or `pnpm start` / `pnpm factory`) on a tree whose SHA matches the exact `main` tip.
2. **Submit a live factory job** using the configured free/local route or an
   explicitly configured paid provider.
3. **Observe** stage progress, completion (or honest failure), and inspectable workspace + attribution artifacts.
4. **Provider / cancel / timeout failures** do not corrupt source inputs; workspaces remain jailed under `WORKSPACE_ROOT`.
5. **Cancel** a running job and confirm terminal `cancelled` status with durable audit/attribution.
6. After an unplanned backend interruption, use **Resume** (or `POST /api/runs/:id/resume`) and continue from the last private durable stage artifact without replaying completed provider stages.

## Scope that must not be narrowed

Mock/stub providers are hermetic test fixtures only. They are not exposed as an
owner-facing run mode, are never delivery evidence, and can never satisfy
readiness. Silent coercion of a live run into mock success is forbidden.

For an existing application, a plausible model-written description is not a
substitute for purpose evidence. Purpose, core workflows, invariants, and
current gaps must cite inspected repository files. A request to outperform or
compare competitors must retain current source health and at least five
inspected product competitors, separate from open-source implementation
candidates; incomplete coverage must block the superiority claim.

Purpose citation validation proves that every retained claim points to an
immutable excerpt collected from the repository snapshot. It does **not**
independently prove that the excerpt semantically entails the model's wording;
the report surfaces that limitation explicitly.

## Production acceptance tests

| Gate                  | Requirement                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-provider journey | A live job completes (or fails honestly) through the configured free/local or paid route; unavailable providers are named exactly                                                                    |
| Purpose evidence      | Existing-app purpose, workflows, invariants, gaps, and uncertainty cite immutable inspected excerpts, survive through planning/QA/reporting, and disclose that semantic entailment is model-inferred |
| Competitive evidence  | Comparative goals include at least five inspected products, source URLs/health collected within seven days, a feature-gap decision, and mapped acceptance criteria—or the claim is held              |
| No fake-success       | Live paths never fall back to mock/stub; unavailable routes produce an explicit error                                                                                                                |
| Controls              | Executable `release:check`, `.github/workflows/production-readiness.yml`, typechecking, and the complete automated test suite                                                                        |
| Evidence              | This contract, exact-revision CI results, changed-file digests, executed commands/exit statuses, and journey evidence                                                                                |
| Verification          | Author and verifier contexts are recorded separately; implementation output alone is not readiness evidence                                                                                          |
| Command safety        | Generated install/build/test scripts remain disabled on the host unless execution occurs in a disposable container/VM with workspace-only write access and no host secrets                           |
| Identity              | Exact default-branch SHA equals local launcher/runtime tree before Production Ready                                                                                                                  |

## Explicit blockers (honest)

- No usable live provider route → **BLOCKED** with the exact unavailable route or
  credential name. Paid credentials are optional when the free route is healthy.
- Missing purpose, competitive, command, or independent-verification evidence required
  by the requested goal → **BLOCKED** for the corresponding readiness claim.
- Launcher/runtime SHA ≠ `main` tip → **BLOCKED** for Production Ready (sync required).

## Forbidden claims

- Prior “PRODUCTION READY” / mock-first control-plane proofs as full readiness
- Production Ready based only on implementation-generated evidence
- `proof:mock-e2e` alone as purpose fulfillment
- Mock/stub output as evidence for any live-provider requirement
- “Better than competitors” without five-product evidence and executed
  acceptance criteria

## Deployment target

Local Windows factory. GitHub `main` is source of truth. Runtime under `C:\Users\firer\local-ai-factory` must match the exact `main` SHA before Production Ready.
