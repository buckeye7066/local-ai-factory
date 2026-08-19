## Hardening Pass (PR 1)

- Added a central user-facing error formatter in `/home/runner/work/local-ai-factory/local-ai-factory/src/server/errors.ts` so network failures, disk-full conditions, OOMs, API timeouts, and invalid model/request configuration errors surface as clear redacted messages instead of raw library text.
- Extended `/home/runner/work/local-ai-factory/local-ai-factory/src/server/orchestrator/envFailure.ts` so verification failures caused by disk exhaustion, memory exhaustion, unreachable services, or request timeouts are classified as environment issues and skip pointless repair-loop retries.
- Sanitized request/crash/foundry/provider error logging paths so secret-shaped values are redacted before they are written to logs or returned in API errors.
- Preserved graceful degradation behavior: advisory research and final-review model failures remain non-fatal, free-route failover still retries or rescues, and environment-only verification failures now report the real cause without crashing the run.
- Added focused regression coverage in `/home/runner/work/local-ai-factory/local-ai-factory/src/server/__tests__/errors.test.ts` and `/home/runner/work/local-ai-factory/local-ai-factory/src/server/__tests__/envFailure.test.ts`.
