# Temporary Purpose Foundry production-readiness agent manifest

Delete this file before final review.

## Intended purpose
Purpose Foundry is the portfolio control plane. It accepts a project purpose, coordinates independent specialist applications through explicit station contracts, preserves a durable evidence chain, and advances work only when each handoff is truthful and verified. It must not absorb the specialist apps into a monolith, invent station success, silently spend outside the chosen tier, lose resumability, or claim production when delivery/release evidence is absent.

## Required work
1. Start from current `main`; record its exact SHA. Read the Purpose Foundry constitution, station contracts, evidence model, Obsidian intake, UI, adapters, routing, checkpoints, and launch paths. Keep each specialist app independently usable.
2. Inspect recent PRs, issues, Actions, review threads, and recurring incidents: directed WorkTheme, `flexfactor_run.py` and provider selection, Factory Deck handoff, Crucible evidence, Watchtower probes, Repo Rewards and PromoPilot evidence, Publisher artifact/submission handoff, station restart/resume, hash-chain integrity, strict free/paid behavior, and false station completion.
3. Reproduce current defects rather than copying old branches. Make only Purpose Foundry changes needed to improve orchestration, evidence, and independent-app handoffs. Shared local-ai-factory code may change only when necessary, with explicit tests proving Factory Deck is not regressed.
4. Fix every repository-controlled blocker you can prove. Never weaken station authorization, evidence containment, hash chains, routing boundaries, exact-target identity, delivery receipts, or production-readiness gates. Add regression tests for every repair.
5. Run the complete clean-install server/UI typechecks, formatting, entire test suite, build, release policy/check, Foundry adapter and restart journeys, mock/offline end-to-end flow, security/secret checks, and exact-head CI. Live specialist credentials and external deployments are owner/external prerequisites; never fabricate their success.
6. Review the full diff line by line, delete this manifest, and update the PR with start/final SHAs, recurring issues, exact commands/results, skips, files changed, cross-impact on Factory Deck, external prerequisites, and a precise production decision.

Do not call Purpose Foundry production-ready while any repository-controlled station contract, evidence invariant, review finding, or exact-head check remains unresolved.