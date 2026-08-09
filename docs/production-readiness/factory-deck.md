# Factory Deck — Production Readiness Report

**Program:** Factory Deck (Local AI Software Factory)  
**Agent:** Cursor portfolio executor  
**Branch:** `cursor/production-ready/factory-deck`  
**Repo:** buckeye7066/local-ai-factory (private)  
**Launcher:** `C:\Users\firer\local-ai-factory\scripts\start-factory.cmd`  
**Updated:** 2026-08-09  
**Certified software SHA:** `cec9757e8faedee153002f34eb5ca5b570d5fe06`  
**Contract:** `docs/purpose-contract.md` v0.2  

## Status

**RELEASE CANDIDATE** in-repo (generator forbids implementer `PRODUCTION READY`; CI regenerates BLOCKED and refuses PR greenwash).  
Portfolio lane status after sequential reviews: **PRODUCTION READY** against certified software SHA above.

## Purpose fulfillment

| Gate | Result | Evidence |
|------|--------|----------|
| Real-provider journey | PASS | `docs/evidence/real-provider-proof.json` — OpenAI live completed (`demo: false`) |
| No fake-success | PASS | `liveNoMockFallback.test.ts`; missing keys name exact env vars |
| Permanent controls | PASS | `release:check`, `.github/workflows/production-readiness.yml`, manifest schema |
| Reviews | PASS | `docs/reviews/{functional,security,release}.md` |
| Identity | PASS | Local tree matched certified `main` tip at review time; docs-ahead allowed for certification commits |

## Verification (this session)

```text
pnpm typecheck                          # PASS
pnpm test:release-gates                 # 43 PASS
pnpm proof:mock-e2e                     # PASS (demo only)
GET http://127.0.0.1:5179/api/health    # controlPlaneOk + paid providers configured
scripts/start-factory.ps1 parse         # OK
```

## Residual

- In-repo `docs/release-manifest.json` may remain `RELEASE CANDIDATE` while CI working copies regenerate `BLOCKED` — by design.
- Anthropic credit balance may force OpenAI-only live path (already noted in real-provider proof).
