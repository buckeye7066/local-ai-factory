# Factory Deck competitive strategy

Last verified: 2026-08-25

## Product purpose

Factory Deck is a local-first, provider-neutral software factory that turns an
owner's intent and an existing codebase into a verified change. Its product is
not model-generated code by itself. Its product is a reproducible, reviewable
claim that the resulting application fulfills its intended purpose without
hiding failed checks, unsafe writes, incomplete evidence, or unresolved risk.

Purpose Foundry extends that contract across a portfolio: applications remain
independently operable, while shared orchestration can discover, build, repair,
challenge, publish, and monitor them.

## Competitive benchmark

This is an overlap benchmark, not a market-share ranking. “Not established”
means the reviewed official documentation did not establish the capability; it
does not prove the capability is absent.

| Capability                          | Factory.ai                                    | Kiro                                                       | Devin                                                        | Cursor                                                           | OpenAI Codex                                                    | Factory Deck target                                                              |
| ----------------------------------- | --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Purpose/specification               | Missions with milestones and success criteria | Requirements → design → tasks, including EARS requirements | User-supplied completion criteria                            | Plans and rules                                                  | Prompts and `AGENTS.md`                                         | Versioned, evidence-cited Purpose Constitution with conflicts and uncertainty    |
| Autonomous repository work          | Strong                                        | Strong                                                     | Strong                                                       | Strong                                                           | Strong                                                          | Strong, with local/free and paid routes                                          |
| Parallel orchestration              | Missions and subagents                        | Parallel subagents                                         | Resumable dynamic workflows                                  | Parallel cloud agents                                            | Parallel agents/worktrees                                       | Durable role separation plus portfolio orchestration                             |
| Provider independence               | Broad BYOK/open/local support                 | Cross-vendor catalog                                       | Not established in reviewed cloud workflow docs              | Broad model catalog                                              | OpenAI ecosystem                                                | Provider-neutral and local-first, routed by role/risk/cost                       |
| Verification                        | QA and scripted checks                        | Testable requirements and checkpoints                      | Tests, browser, CI, security swarm                           | Tests plus screenshots/video/logs and Agent Review               | Tests, review, and security review                              | Clause-level evidence, real-system journeys, receipts, and mutation/fault checks |
| Independent evidence separation      | Not established                               | Not established                                            | Review surface documented; provider separation not established | Dedicated review surface; independence guarantee not established | Separate review surface; independence guarantee not established | Structurally separate author and verifier with recorded provenance               |
| Crash-safe resumption               | Not established                               | Checkpoint/rewind                                          | Documented resumable workflows                               | Not established                                                  | Long-running/background tasks                                   | Durable stage checkpoints and idempotent resume                                  |

Official evidence reviewed:

- [Factory Missions](https://docs.factory.ai/missions/overview),
  [Custom Droids](https://docs.factory.ai/harness/subagents), and
  [Custom Models](https://docs.factory.ai/model-independence/byok)
- [Kiro Feature Specs](https://kiro.dev/docs/specs/feature-specs/),
  [Autonomous mode](https://kiro.dev/docs/web/autonomous-mode/), and
  [checkpoints](https://kiro.dev/docs/checkpoints/)
- [Devin Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows),
  [SDLC integration](https://docs.devin.ai/essential-guidelines/sdlc-integration),
  and [Security Swarm](https://docs.devin.ai/work-with-devin/security-swarm)
- [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent),
  [subagents](https://cursor.com/docs/subagents), and
  [Agent Review](https://cursor.com/docs/agent/agent-review)
- [OpenAI Codex](https://openai.com/index/introducing-the-codex-app/),
  [Codex cloud](https://learn.chatgpt.com/docs/cloud), and
  [Codex best practices](https://developers.openai.com/codex/learn/best-practices)

## Defensible product position

Parallel agents, model choice, sandboxes, tests, worktrees, and PR creation are
now table stakes. Factory Deck should not compete primarily on agent count. It
should compete on **trustworthy fulfillment of intent**:

1. **Purpose Constitution** — derive explicit requirements, inferred intent,
   user outcomes, workflows, invariants, anti-goals, uncertainty, and source
   evidence from the real repository and owner instructions.
2. **Traceable execution** — map every plan item, edit, test, and release claim
   to a purpose clause and its acceptance evidence.
3. **Independent verification** — an implementation context cannot use its own
   output as proof; record author/verifier provider and model provenance.
4. **Evidence-backed Definition of Done** — bind claims to the exact revision,
   changed-file digests, executed commands, raw exit statuses, browser/runtime
   artifacts, unresolved limitations, and acceptance results.
5. **Real-system verification** — exercise buttons, routes, APIs, persistence,
   authentication, background work, integrations, and user-visible outcomes;
   correlate UI behavior with server logs and stored state.
6. **Purpose-preserving repair** — identify the causal defect class, fix every
   affected instance, add a regression guard, and rescan impacted surfaces.
7. **Truthful operations** — no fabricated success, no silent live-to-mock
   downgrade, no swallowed research gap, and no release when evidence is
   incomplete.
8. **License-aware competitive intelligence** — retain source URL, retrieval
   date, version/license evidence, reuse decision, and clean-room boundary.
9. **Cross-application governance** — preserve each application's independent
   operation while verifying dependencies and releases across Purpose Foundry.
10. **Continuous purpose assurance** — reopen acceptance clauses when code,
    dependencies, APIs, or production behavior drift.

## Delivery priorities

### P0 — trust moat

- Evidence-backed Purpose Constitution and typed repository context.
- A minimum of five inspected product competitors for comparative goals,
  separate from reusable open-source repositories.
- Firecrawl-first discovery with honest provider health and no synthetic
  search-success placeholders.
- Independent verifier provenance and a revision-bound evidence bundle.
- Release held when a requested comparative or acceptance claim lacks evidence.

### P1 — execution depth

- Factory-owned browser harness for greenfield applications.
- UI/API/database/authentication journey verification.
- Mutation and fault-injection checks proving that gates catch seeded defects.
- Crash-safe isolated repository operations and atomic file replacement.
- Controlled scope expansion when repair needs a previously untouched host
  integration file.

### P2 — durable scale

- Risk-, privacy-, cost-, and empirical-quality-based model adjudication.
- Cross-repository dependency maps and immutable candidate evidence bundles.
- Post-release purpose drift and production-outcome monitoring.

## Decision rule

Factory Deck may claim that a build is “better than competitors” only when the
run contains evidence no older than seven days for at least five inspected product competitors,
maps adopted advantages to acceptance criteria, and executes those criteria on
the resulting application. Otherwise it may report research as incomplete, but
must not convert incomplete coverage into a superiority claim.
