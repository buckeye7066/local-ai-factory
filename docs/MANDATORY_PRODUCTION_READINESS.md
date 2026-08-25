# Mandatory production readiness for Factory Deck and Purpose Foundry

This is an executable product contract, not optional guidance.

## Completion means production-ready

Factory Deck and Purpose Foundry must never label a live run or project `completed`, `ready`, `released`, or equivalent merely because the pipeline reached its last step. A non-demo app is complete only when the exact delivered bytes have a `factory.production-readiness.v1` receipt whose `ready` value is `true`.

The receipt is mandatory for every new and extended app. There is no user-facing opt-out and no environment variable that weakens it.

The gate must prove all of the following:

1. The app's purpose is stated and grounded in the supplied product brief or existing repository evidence.
2. The requested goals and every essential purpose workflow are covered by executable acceptance criteria.
3. Every criterion actually executed and passed. Generated prose, test files that never ran, and a green unrelated host suite are not evidence.
4. Grounded QA passed; required writes landed; verification is complete; the exact file-digest receipt remains valid; generated features are wired into the product; no placeholder, TODO, FIXME, stubbed route, coming-soon surface, or missing implementation remains; no high or critical technical security blocker remains; and the app is operationally runnable.
5. Every applicable platform has executed evidence: Safari/WebKit plus iOS and Android mobile browser profiles for web products, Android and iOS production builds for native mobile products, and Windows and macOS execution for desktop/CLI products. An unexecuted target is a blocker, not a portability claim.
6. The verified work reached its intended production destination:
   - existing repository: exact verified revision on the default branch;
   - hosted new app: live deployment observed answering;
   - private/local app: verified runnable production artifact. Public listing is not required for a private app.
7. A Sol lead and an independent Fable-or-Opus reviewer approved the same exact evidence digest.

A pending PR, held release, failed deployment, partial implementation, unexecuted criterion, unresolved purpose-critical gap, model-only claim, or missing second brain is not production-ready.

## Mandatory brain floor

The production-readiness brain floor is:

- **Sol**: OpenAI-family lead reviewer;
- **Fable or Opus**: Anthropic-family independent reviewer whose configured model name is Fable- or Opus-class.

Both must be configured for every non-demo Factory Deck run and Purpose Foundry project. Lower-cost/free helpers may assist earlier stages, but they cannot issue or substitute for the production-readiness receipt. The reviewers must use different provider families, review the same immutable evidence digest, and independently return purpose alignment, implementation completeness, technical readiness, and zero blockers.

Failure, unavailability, quota exhaustion, disagreement, stale evidence, or a weaker Anthropic model holds the run. It never silently falls back to one brain or self-review.

## Purpose Foundry enforcement

Purpose Foundry must always include the implementation and proof stations necessary to reach the same receipt. At minimum, its normalized selected-station plan includes Factory Deck, FlexFactor, The Crucible, and Watchtower. A station's `completed` callback is evidence only. The Foundry project itself reaches `completed` only when its Factory Deck run exposes a ready production receipt and the later verification/adversarial/operations evidence agrees with that exact revision.

The Factory Deck station must pass the project's full constitution, targets, success criteria, constraints, and non-goals into the run as authoritative obligations. The adapter may not request a draft-only run or downgrade the brain floor.

## Owner-managed matters outside cyberland

The automated gate evaluates product purpose, functional completeness, engineering quality, security and privacy controls, usability, performance, accessibility as a technical property, operational readiness, delivery, and executable evidence.

Legal, regulatory, contractual, licensing-policy, and similar owner decisions are not evaluated and are not automatic software blockers. They may be recorded separately for the owner, but Factory Deck and Purpose Foundry must neither fabricate legal clearance nor add legal-review noise to the cyberland readiness result.

This exclusion does not permit a technical defect to be relabeled as legal. A privacy leak, unsafe authorization path, insecure storage, clinical overclaim implemented in the product, destructive financial behavior, or missing security control remains a technical blocker.

## Required durable state and UI behavior

The run/project API and UI must display:

- readiness status: `not_evaluated`, `blocked`, or `ready`;
- policy version and immutable evidence digest;
- purpose/acceptance coverage;
- deterministic technical gate results;
- Sol review identity, provider, configured model, decision, and blockers;
- Fable-or-Opus review identity, provider, configured model, decision, and blockers;
- destination/release/deployment evidence;
- a clear statement that owner-managed external matters were not evaluated.

Demo/mock runs may still finish the simulation pipeline, but their readiness status is always blocked and their UI must say they are not production-ready.

## Repair and terminal behavior

A readiness review that identifies a repairable technical or purpose-completion blocker feeds a bounded implementation/verification loop. The loop must re-run the affected acceptance tests, QA, file receipt, and both independent brain reviews against a new evidence digest. It may not mark a blocker resolved from prose alone.

When the bounded loop cannot close every blocker, the run remains failed or needs attention with the exact blockers and evidence preserved. It does not become completed through timeout, skipped review, environment flag, or exhausted model budget.

## Regression requirements

Tests must prove at least:

- Sol alone cannot issue a receipt;
- Opus/Fable alone cannot issue a receipt;
- two labels backed by one provider family cannot issue a receipt;
- a lower Anthropic model cannot masquerade as Fable/Opus;
- stale/mismatched evidence digests fail;
- green tests with incomplete goals fail;
- production placeholders, TODO/FIXME markers, stubbed routes, and coming-soon surfaces fail;
- applicable Windows, Safari/WebKit, macOS, iOS, or Android targets without executed evidence fail;
- unexecuted acceptance criteria fail;
- existing-repo work not merged to trunk fails;
- failed or skipped hosted deployment fails;
- a genuinely local/private app can pass with a verified runnable artifact;
- demo/mock runs never become ready;
- Purpose Foundry cannot omit its required production stations;
- Foundry cannot mark a project complete without the Factory Deck readiness receipt;
- owner-handled legal/external notes neither satisfy nor block the technical receipt;
- no option, API payload, resume path, epic path, or environment variable bypasses the gate or brain floor.
