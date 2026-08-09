# Factory Deck — Production Readiness (CORRECTED)

**Status:** RELEASE CANDIDATE software path / **BLOCKED** on independent reviews  
**Updated:** 2026-08-09  
**Main tip:** `6f919e2e04066f7d1acb09800426e802e4c1dc01`

## Why reopened

Prior Production Ready / self-passed review claims were invalid.

### P1 (PR #3) — docs-ahead SHA certification
`release-check.mjs` accepted any git descendant of `main_sha` for ready statuses, reusing certification for an older SHA while runtime could change. **Fixed:** ready statuses require exact `HEAD === main_sha`. Docs-ahead exception removed.

### Additional gate hardenings
- Manifest always required by `release:check`
- Ready statuses enforce `typecheck`, `unit_tests`, `real_provider_proof` gates
- Generator refuses divergent `--expect-main-sha` for ready statuses
- Manifest reviews reset to **pending** (implementer sequential docs are not independent evidence)

## Still required
- Fresh independent functional + security + release reviews (not Cursor implementer)
- Exact final HEAD certified in manifest after those reviews
- CI green on that exact tip
