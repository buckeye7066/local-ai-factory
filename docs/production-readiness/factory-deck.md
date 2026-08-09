# Factory Deck — production readiness (INVALIDATED)

**Status:** Prior PRODUCTION READY claim **INVALID** (release-gate correction run).  
**Reason:** Mock-provider synthetic job is **not** purpose fulfillment.  
**Current contract:** `docs/purpose-contract.md` v0.2  

Do **not** treat this historical document as certification.

## What still counts as software proofs (not readiness)

| Item | Meaning |
|------|---------|
| Mock E2E (`pnpm proof:mock-e2e`) | Offline demo only |
| Control-plane health without paid keys | OK for launcher/health; not live journey |
| Cancel / sandbox / redaction suites | Required software gates |

## What is required now

1. `pnpm release:check` + `.github/workflows/production-readiness.yml`
2. Machine-readable `docs/release-manifest.json` with `mock_only_core: false` for RC/PR
3. `pnpm proof:real-provider` evidence (`docs/evidence/real-provider-proof.json`) **or** honest `BLOCKED` naming exact missing credentials
4. Independent functional + security + release reviews
5. Exact `main` SHA = launcher runtime SHA

Implementer maximum status: **RELEASE CANDIDATE** (never self-certify Production Ready).
