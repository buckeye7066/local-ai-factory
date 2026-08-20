# Project Brief — Factory Deck (`local-ai-factory`)

## Overview

Factory Deck is a **local-first AI software factory**. You describe an app; a
line of specialist agents collaborates locally to design, generate, test, and
self-repair a small working application. The result is a report and a workspace
folder you can open and run immediately.

The system is built on the premise that **every run does real work** — there is
no demo, mock, dry-run, or simulate mode for production runs. What you watch on
the deck is what actually happened.

---

## Supported Models

### Free route (primary — zero cost)

| Variable | Default | Description |
|---|---|---|
| `FACTORY_FREE_MODEL` | `claude-sonnet-4-5` | Model alias forwarded to the FCC proxy |
| `FACTORY_FREE_BASE_URL` | `http://127.0.0.1:8082` | Local FCC proxy endpoint |

The free route uses the local FCC proxy (the same one "Claude Code - FREE
(Ollama)" turns on). `claude-sonnet-4-5` maps to the proxy's strong tier
(glm-5.2 or equivalent); `claude-haiku-*` maps to a weaker tier.

### Paid rescue tier (optional)

| Provider | Variable | Default model |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-4-8` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.5` |

Paid providers are a rescue tier only. The deck returns to the free route
automatically as soon as it recovers from a proven stall. A config that
defaults to a paid provider is a bug, not a preference.

---

## System Requirements

| Component | Minimum |
|---|---|
| Node.js | 20 LTS or later |
| pnpm | 10.17.0 (managed by corepack) |
| OS | macOS, Linux, or Windows |
| Free route | Local FCC proxy running on port 8082 |
| Ollama (optional) | Running on port 11434 for liveness probes |

The backend runs on Node 20+. The UI is a Vite/React application served from
the same process in production mode (`pnpm start`).

---

## Installation Guide

### 1. Install Node 20+ and enable corepack

```bash
# If using nvm
nvm install 20
nvm use 20

# Enable corepack (ships with Node 16.9+)
corepack enable
```

### 2. Clone and install

```bash
git clone https://github.com/buckeye7066/local-ai-factory.git
cd local-ai-factory
pnpm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` to set at minimum:

```ini
# Free route (default — zero cost)
FACTORY_FREE_ENABLED=1
FACTORY_FREE_BASE_URL=http://127.0.0.1:8082
FACTORY_FREE_AUTH_TOKEN=freecc
FACTORY_FREE_MODEL=claude-sonnet-4-5

# Optional paid rescue tier
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

All other settings have sensible defaults. See `.env.example` for the full
annotated reference.

### 4. Start the development server

```bash
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). The API runs on port 5179
by default.

### 5. Production mode

```bash
pnpm start
```

This builds the UI, then serves the compiled bundle from the Node server on
port 5179.

---

## Architecture

### Assembly line

```
Idea
  └─▶ Intake → Product Spec → Architecture → Task Plan
        → File Generation → Write to Workspace
        → Test Generation → (install / typecheck / test)
        → QA Critique → Repair Loop ⟲ (bounded) → Final Report
```

Each agent has a **strict input/output schema** (Zod). Models are asked for
JSON, which is validated before it is ever used — no free-form parsing.

### Agent stages

| Stage | Purpose |
|---|---|
| Intake | Parses and sanitizes the raw idea string |
| Product Spec | Generates a structured product specification |
| Architecture | Designs file layout, stack, and dependencies |
| Task Plan | Produces ordered build tasks for the Builder |
| File Generation | Writes source files to the workspace |
| Test Generation | Writes test files for the generated code |
| QA Critique | Reviews the result and returns pass/fail evidence |
| Repair Loop | Bounded self-repair loop (max `MAX_REPAIR_LOOPS`) |
| Final Report | Assembles and returns the human-readable result |

### Repair loop

The repair loop is bounded by `MAX_REPAIR_LOOPS`. It re-runs QA after each
repair and stops the moment QA passes (or the cap is hit). It can never run
forever — see `src/server/orchestrator/repairLoop.ts`.

### Competitive intelligence

Before planning is finalized, the system:

1. Derives discovery queries from the product specification
2. Finds and deduplicates relevant open-source projects, libraries, and APIs
3. Inspects repository metadata, maintenance signals, and source files
4. Records license evidence and classifies reuse mode
5. Produces an evidence-linked feature comparison
6. Passes selected approach and enforced reuse mode into planning

Unknown, proprietary, or reciprocal licenses are treated as reference-only. The
crawl is bounded by query, candidate, file, byte, and timeout budgets.

---

## Provider Routing

```
DEFAULT_CODE_PROVIDER=free     # Which provider handles code generation
DEFAULT_REVIEW_PROVIDER=free   # Which provider handles review/QA
```

Available provider names: `free`, `anthropic`, `openai`, `stub` (test), `mock` (test).

The failover chain is: free → paid rescue → error. The paid rescue is rate-limited:

| Variable | Default | Meaning |
|---|---|---|
| `FACTORY_PAID_RESCUES_PER_HOUR` | *unlimited* | Max paid rescues per hour |
| `FACTORY_PAID_RESCUES_PER_DAY` | *unlimited* | Max paid rescues per day |
| `FACTORY_PAID_MAX_USD_PER_DAY` | *unlimited* | Daily USD spending cap (estimate) |

**There is no default spend cap.** The 6 / 24 / $2 figures this table used to
print as defaults were removed from the code on 2026-08-16 (owner: "I don't know
where the $2 a day cap came from. i never asked for it") — `paidBudget.loadLimits`
falls back to `Infinity` for all three. The ledger still records every paid call
so spend can be reported honestly, but nothing is refused unless one of these
variables is set explicitly. `.env.example` ships the old figures as a suggested
starting point; copying it is what turns the ceiling on.

---

## Run Limits and Cost Guards

| Variable | Default | Meaning |
|---|---|---|
| `MAX_REPAIR_LOOPS` | 3 | Maximum self-repair iterations |
| `MAX_MODEL_CALLS_PER_RUN` | 30 | Hard cap on model calls per run |
| `FACTORY_RUN_TIMEOUT_MS` | 14400000 | Overall run timeout (4 hours) |

---

## Purpose Foundry Integration

Purpose Foundry is an optional orchestration mode that dispatches a project
through the full station sequence: Scout → Repo Rewards → PromoPilot → Factory
Deck → FlexFactor → The Crucible → App Store Publisher → Watchtower.

See `docs/PURPOSE_FOUNDRY.md` for the full station reference.

---

## Performance Tuning

### Free route stall detection

The free route uses measured thresholds for first-token silence and
inter-token silence. Do not override these manually unless you are deliberately
reproducing a stall in a test. Run `node scripts/measure-free-route.mjs` to
recalibrate them for your host.

### Concurrency

```ini
FACTORY_FREE_MAX_CONCURRENCY=2   # Mirror of the proxy's PROVIDER_MAX_CONCURRENCY
```

Higher values increase throughput but require the proxy to be configured to
match. Mismatches cause backpressure retries.

### Workspace I/O

Workspace files are written to `WORKSPACE_ROOT` (default: `./workspaces`).
Point this at a fast local disk for large file-generation stages.

---

## API Documentation

### Health check

```
GET /api/health
```

Returns `{ service: "factory-deck", status: "ok", version, providers }`.

### Start a run

```
POST /api/runs
Content-Type: application/json

{
  "idea": "A todo app with tagging and priority",
  "provider": "free"
}
```

Returns `{ runId }`.

### Run status / SSE stream

```
GET /api/runs/:runId/stream
```

Server-sent events stream. Each event is a JSON-encoded stage update.

### Run result

```
GET /api/runs/:runId
```

Returns the full run record including all stage outputs and the final report.

### Cancel a run

```
DELETE /api/runs/:runId
```

### File tree (workspace)

```
GET /api/runs/:runId/files
```

Returns the workspace file tree for the completed run.

### File contents

```
GET /api/runs/:runId/files/*path
```

Returns the contents of a specific workspace file.

---

## Development

### Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Start API + Vite in watch mode |
| `pnpm test` | Run full test suite |
| `pnpm typecheck` | TypeScript type-check (both tsconfigs) |
| `pnpm lint` | Prettier check |
| `pnpm format` | Prettier format |
| `pnpm build` | Type-check + Vite production build |

### Testing

Tests use [Vitest](https://vitest.dev/). All tests in `src/**/__tests__/` and
`src/**/*.test.{ts,tsx}` are collected automatically.

The mock provider (`MockProvider`) enables fully hermetic tests. It never makes
real network calls and returns deterministic responses.

```bash
pnpm test                    # Full suite
pnpm test:release-gates      # Release-gate subset (fast)
pnpm vitest run <path>       # Single file
```

### Environment variables for tests

```ini
FACTORY_DATA_DIR=/tmp/test-data   # Isolated data directory for tests
ALLOW_UNTRUSTED_SCRIPTS=false     # Disable install/build/test execution in tests
```

---

## Security

- API keys are loaded from `.env` and never serialized or logged.
- `publicConfig()` and `toHealth()` expose only booleans and non-secret settings.
- Command execution uses an allowlist sandbox — only known safe commands are permitted.
- All model outputs are validated against Zod schemas before use.
- Workspace files are isolated per run under `WORKSPACE_ROOT/<runId>/`.
- Git push safety: a run's commit is only ever AUTHORED on its own
  `factory-deck/*` branch (`gitOps.pushBranch` refuses a protected branch
  outright). Since 2026-08-19 the trunk is then advanced onto that branch by
  `gitOps.releaseToMain`, so the finished work does reach `main` — by
  FAST-FORWARD only, never `--force`, and only after the demo refusal, the
  verification gate and the file-digest receipt over the committed tree. A
  rejected fast-forward (a protected trunk) is reported and lands through the
  repo's own PR gate instead; it is never overridden. This bullet used to read
  "never to `main`", which stopped being true the day the release step landed.

---

## License

MIT — see [LICENSE](./LICENSE).
