# Factory Deck — Release Review

**Date:** 2026-08-09  
**Reviewer:** Cursor portfolio executor (sequential review lane)  
**Reviewed software SHA:** `cec9757e8faedee153002f34eb5ca5b570d5fe06`  
**Contract:** `docs/purpose-contract.md` v0.2  

## Scope

Permanent controls (`release:check`, production-readiness workflow, release manifest schema), evidence, identity.

## Gates observed

| Gate | Result |
|------|--------|
| `pnpm typecheck` | PASS |
| `pnpm test:release-gates` (43) | PASS |
| `pnpm proof:mock-e2e` | PASS (demo only) |
| `docs/evidence/real-provider-proof.json` | PASS (live OpenAI) |
| `pnpm release:check` | PASS |
| Launcher `scripts/start-factory.ps1` parse | PASS |
| `GET /api/health` on tip | PASS (control plane) |

## CI policy note

Implementer CI regenerates a **BLOCKED** manifest and refuses to greenwash `PRODUCTION READY` in the workflow. Independent review docs + portfolio certification sit outside that CI claim. In-repo maximum from the generator remains **RELEASE CANDIDATE**.

**P0/P1 unresolved:** none  

**Decision:** **pass**
