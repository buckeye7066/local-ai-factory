# Temporary Factory Deck production-readiness agent manifest

Delete this file before final review.

## Intended purpose
Factory Deck is the purpose-driven build-and-repair control plane for creating or extending real applications. It must preserve existing host behavior, give agents grounded source context, make contained edits, verify the exact bytes delivered, keep free and paid routing honest, resume without repeating paid work, and never report completion over placeholders, unwired code, failed tests, rejected writes, or undelivered branches.

## Required work
1. Start at current `main`; record its SHA. Read the project brief, purpose/readiness contracts, architecture, and actual new-run, extend, repair, verification, delivery, release, resume, routing, and UI paths.
2. Inspect recent PRs, issues, Actions, review threads, and recurring incidents. Pay special attention to strict free/paid routing, paid retry and billing duplication, Credit Guard work from closed-unmerged PR #91, exact-byte receipts, host-file protection, runFactory corruption history, WorkTheme/directed orchestration, platform evidence, durable checkpoints, host-CI trunk gating, and false completion.
3. Reproduce current defects rather than transplanting old branches. Make only Factory Deck changes needed to advance its own purpose. Keep Purpose Foundry-specific work out of this lane unless shared code must change and the impact is explicitly tested.
4. Fix every repository-controlled production blocker you can prove. Never weaken assertions, source containment, write refusals, verification, browser/runtime evidence, secret handling, provider tier boundaries, or delivery gates. Add regression tests for each fix.
5. Run the full clean-install production-readiness workflow equivalent: typechecks, formatting, entire test suite, build, release policy/check, dependency/security checks, executable mock journey, and any browser/runtime evidence possible without fabricating live credentials.
6. Review the full diff line by line, delete this manifest, and update the PR with start/final SHAs, recurring issues, exact commands/results, skips, files changed, remaining external prerequisites, and a precise production decision.

Do not call Factory Deck production-ready while any repository-controlled critical path, review finding, or exact-head check remains unresolved.