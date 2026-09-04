# Factory Deck — `local-ai-factory`

A **local-first, provider-neutral software factory**. You describe a new app or
an outcome for an existing repository; Factory Deck links its model-inferred
purpose to immutable repository excerpts, researches the real competitive field, builds
the change, executes acceptance checks, repairs failures, and reports exactly
what the evidence does—and does not—prove.

It ships with a premium control-room UI ("Factory Deck") that visualizes the
assembly line in real time. There is **no demo, mock, dry-run, or simulate
mode**: every run does real work against real providers, so what you watch on
the deck is what actually happened.

---

## How the assembly line works

```
Idea or existing repository goal
  └─▶ Intake → Purpose Constitution → Product Spec → Architecture → Task Plan
        → File Generation → Write to Workspace
        → Test Generation → (install / typecheck / test)
        → QA Critique → Repair Loop ⟲ (bounded) → Final Report
```

- Each agent has a **strict input/output schema** (Zod). Models are asked for
  JSON, which is validated before it is ever used — no free-form parsing.
- The **repair loop** is bounded by `MAX_REPAIR_LOOPS`. It re-runs QA after each
  repair and stops the moment QA passes (or the cap is hit). It can never run
  forever — see `src/server/orchestrator/repairLoop.ts`.
- Every model call is metered against `MAX_MODEL_CALLS_PER_RUN` (a cost guard).

### Durable purpose and cross-run memory

Every live run is joined to a stable, credential-free project identity. A new
GitHub project and every later extend run share the same canonical repository
key, so the founding mission follows the app instead of the one-time creation
request. Before the product spec is accepted, Factory Deck reconciles the current request with
repository purpose evidence and prior project memory into one
`factory.goal-contract.v1` object. That contract contains the purpose, target
users, active goals, constraints, non-goals, prior run IDs, carried decisions,
and prior research. Its SHA-256 digest is verified on resume, stamped into the
product spec, converted into executable acceptance criteria, and shown in the
final report.

The bounded project-memory record survives successful checkpoint cleanup.
Factory Deck writes the exact goal, spec, and competitive evidence before the
task planner or builder may proceed, then records the delivered revision,
summary, and next improvements at completion. Pre-build plans remain audit
evidence, but only completed runs become authoritative continuity. A later run
inherits that completed context; model wording cannot silently rename or
repurpose the app. A purpose change is accepted only when the current request
explicitly asks to change, redefine, pivot, replace, or repurpose the product
mission or audience. Purpose Foundry also sends its constitution as explicit
`Mission:` and `Audience:` directives, which become code-owned contract
fields instead of model-authored prose.

### Autonomous competitive intelligence

Live runs research beyond named dependencies. Before planning is finalized,
Factory Deck:

1. derives multiple discovery queries from the durable product mission,
   target users, active goal, and feature set—not an invented app name;
2. queries the real RepoRewards `POST /api/search` service for ranked
   implementation candidates and searches Firecrawl v2 with an honest
   DuckDuckGo fallback, recording source health;
3. reserves separate capacity for real product competitors and requires five
   verified, evidence-linked products on every live production run;
4. inspects open-source repository metadata, maintenance signals, file trees,
   and relevant source separately from product competitors;
5. records deterministic license evidence and classifies reuse as direct-use,
   conditional-review, or reference-only; and
6. produces an evidence-linked comparison, converts every selected advantage
   into an acceptance criterion, and passes concrete integration instructions,
   reuse mode, and source URL into planning and file generation.

RepoRewards and the five-product comparison are production gates. Purpose
Foundry's required Scout discovery station separately creates and polls authenticated
Program Scout jobs through `POST /api/scout/jobs` and `GET /api/scout/jobs/:id`;
it completes only after the service returns a verified branch whose verification
commit equals its head SHA. If discovery is disabled, RepoRewards is unreachable,
or five verified/compared/selected
product advantages cannot be established, the run stops before the planner or
builder instead of pretending research occurred.

Unknown, proprietary, or reciprocal licenses cannot be promoted to direct
source reuse by a model response. Those candidates remain reference-only or
are implemented as clean-room patterns. The crawl is bounded by query,
concurrency, candidate, file, byte, and timeout budgets. See the dated
[competitive benchmark and product strategy](docs/COMPETITIVE_STRATEGY.md).

---

## Install

```bash
corepack enable
pnpm install --frozen-lockfile
```

Requires Node ≥ 20. Corepack reads the repository's pinned pnpm version from
`package.json`; do not substitute npm merely because a compatibility
`package-lock.json` is present.

## Create your `.env`

```bash
cp .env.example .env
```

Then edit `.env`. Paid keys and a Firecrawl key are optional:

```ini
FACTORY_FREE_ENABLED=1
FACTORY_FREE_BASE_URL=http://127.0.0.1:8082
FACTORY_FREE_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_MODEL=claude-fable-5-1
OPENAI_MODEL=gpt-6-astra
FACTORY_OPENAI_MODEL_LADDER=gpt-6-astra,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna
FIRECRAWL_API_KEY=optional_firecrawl_key
DEFAULT_CODE_PROVIDER=free
DEFAULT_REVIEW_PROVIDER=free
MAX_REPAIR_LOOPS=3
MAX_MODEL_CALLS_PER_RUN=30
WORKSPACE_ROOT=./workspaces
```

> A run needs a real provider. Start the FREE route ("Claude Code - FREE
> (Ollama)") or set a paid key — there is no offline fallback, because a run
> with no provider must fail loudly rather than fabricate a result.

---

## Run the polished UI

```bash
pnpm dev
```

This starts the local backend (`http://127.0.0.1:5179`) and the Factory Deck UI
(`http://localhost:5190`). Open the UI, type an idea, and watch the assembly
line run.

- **New Run** — the hero screen with provider-routing cards and safety preview.
- **Stop** — a running run can be cancelled from the run header (or
  `POST /api/runs/:id/cancel`); it halts at the next stage/model-call
  checkpoint and is recorded as `cancelled`.
- **Runs** — history of past runs (persisted locally). Generated file contents
  are persisted too. A process-interrupted run is marked failed and
  **Resume** continues from its private durable stage checkpoint without
  replaying completed provider stages. The same action is available as
  `POST /api/runs/:id/resume`.
- **Workspaces** — the generated app folders.
- **Settings** — shows which keys are configured (never the keys themselves),
  models, limits, and whether command execution is live or blocked by the
  script gate. There is no dry-run flag; that mode was removed.

## Run from the CLI

```bash
pnpm factory "build me a family chore tracker with rewards"
```

Streams stage-by-stage progress and prints the final workspace path + report.

---

## Security & safety boundaries

This is designed to be safe to run on your own machine:

- **Keys never reach the browser.** They live only in the backend process. The
  `/api/health` endpoint returns _booleans_ (`configured` / `missing`), never
  values. There is no UI field to type a key — add keys by editing `.env`.
- **Model calls are server-side only.** The frontend talks to a local API.
- **`.env` is never sent to a model** and is git-ignored.
- **Generated files are jailed to `./workspaces`.** Writes go through
  `safeResolve`, which rejects absolute paths and `..` traversal
  (`src/server/workspace/fileWriter.ts`).
- **Generated commands are blocked by default.** The allowlist and `shell: false`
  reduce command-injection risk, but a process whose current directory is a
  workspace is **not** contained there by the operating system. Keep
  `ALLOW_UNTRUSTED_SCRIPTS=false` unless Factory Deck itself runs in a disposable
  container/VM with a workspace-only writable mount, no host secrets, and an
  appropriate network policy (`src/server/workspace/commandRunner.ts`).

## Cost control

- `MAX_MODEL_CALLS_PER_RUN` hard-caps LLM calls per run.
- `MAX_REPAIR_LOOPS` bounds the repair loop.
- Every live run uses one orchestrated model ladder: the strongest configured
  paid model first, weaker configured paid models next, and free/local last.
  Credit, quota, capacity, or configured budget exhaustion demotes the run; the
  orchestrator never silently promotes it again mid-run.
- Paid call-count limits are atomic only within one Factory Node process. The
  USD ledger is an estimated admission guard, not an actual billing cap; use
  provider-native account caps for a hard actual-dollar guarantee.

## Changing models

Edit `ANTHROPIC_MODEL` / `OPENAI_MODEL` in `.env`. Order models inside the
Anthropic family with
`FACTORY_ANTHROPIC_MODEL_LADDER=claude-fable-5-1,claude-opus-5,claude-sonnet-5,claude-haiku-4-5`,
then order provider families with `FACTORY_MODEL_LADDER=anthropic,openai`.
Missing rungs are skipped and the free/local rotator is always appended last.
The mandatory lead and challenger reviews each start from the same strongest
paid rung, independently descend the same ordered paid ladder, and record the
actual provider/model that answered. They never fall through to free, mock, or
stub capacity, and readiness no longer deadlocks at a provider-family boundary.
`DEFAULT_CODE_PROVIDER` and `DEFAULT_REVIEW_PROVIDER` remain legacy
compatibility fields only. The Settings screen reflects the active values.

---

## Scripts

| Script                  | What it does                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | Backend + UI together (dev, hot reload)                                                                                    |
| `pnpm start`            | Production mode: build the UI, then serve everything from the backend on `http://127.0.0.1:5179` (single process, no Vite) |
| `pnpm server`           | Backend only (tsx watch)                                                                                                   |
| `pnpm ui`               | Vite UI only                                                                                                               |
| `pnpm factory "<idea>"` | Run the factory from the CLI                                                                                               |
| `pnpm test`             | Vitest suite                                                                                                               |
| `pnpm typecheck`        | Type-check server + UI                                                                                                     |
| `pnpm build`            | Type-check + production UI build                                                                                           |
| `pnpm lint`             | Prettier formatting check                                                                                                  |

---

## Project layout

```
src/
  server/
    config.ts                 # env loading; secret-free health view
    index.ts                  # local Express API
    providers/                # anthropic / openai / stub (one interface)
    agents/                   # 8 specialist agents (strict schemas)
    orchestrator/             # runFactory, stages, bounded repair loop
    workspace/                # path jail, command allowlist, summaries
    storage/                  # local JSON run history
  cli/factory.ts              # CLI entrypoint
  shared/                     # Zod schemas + types (one source of truth)
  ui/                         # Factory Deck — React + Tailwind + Framer Motion
    components/{layout,factory,logs,files,reports,history,settings,ui}
```

---

## Desktop shortcut

A blue **Ford-oval-style "Factory Deck" icon** is generated to your Desktop by:

```bash
pnpm exec tsx scripts/make-icon.ts   # or run scripts\Install-Desktop-Icon.ps1
```

Double-clicking it launches `pnpm dev` and opens the UI in your browser.

## Purpose Foundry

Purpose Foundry is the optional portfolio assembly-line mode. Its default route now runs Repo Rewards first, persists a bounded typed handoff of insights, sources, and repository candidates, and supplies that handoff to Factory Deck before implementation. It then coordinates Factory Deck, The Crucible, and Watchtower as the mandatory production line; Scout a Program, PromoPilot, FlexFactor, and App Store Publisher remain selectable specialists. Every transition uses a durable station contract and hash-chained evidence ledger. Its internal model calls use the same single paid-first ladder; the FlexFactor child owns its own equivalent orchestrator instead of being pinned to a separate free or paid route. Every existing application remains independently launchable.

Set `PURPOSE_FOUNDRY_OBSIDIAN_INBOX` to an Obsidian folder to ingest saved Markdown project notes automatically. Run `pnpm install:purpose-foundry-icon` once to create the separate **Purpose Foundry** desktop shortcut; the existing Factory Deck shortcut is unchanged. See [`docs/PURPOSE_FOUNDRY.md`](docs/PURPOSE_FOUNDRY.md).

Purpose Foundry launchers do not bypass Windows execution policy. If Windows marks a freshly downloaded checkout as blocked, review the scripts and explicitly run `Get-ChildItem scripts\\*.ps1 | Unblock-File` once before installing the shortcuts.
