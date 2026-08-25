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

### Autonomous competitive intelligence

Live runs research beyond named dependencies. Before planning is finalized,
Factory Deck:

1. derives multiple discovery queries from the product specification;
2. searches Firecrawl v2 first, with an honest DuckDuckGo fallback and explicit
   source-health reporting;
3. reserves separate capacity for real product competitors and requires five
   verified products before a five-competitor claim is considered covered;
4. inspects open-source repository metadata, maintenance signals, file trees,
   and relevant source separately from product competitors;
5. records deterministic license evidence and classifies reuse as direct-use,
   conditional-review, or reference-only; and
6. produces an evidence-linked comparison and passes selected, legally allowed
   advantages into planning and file generation.

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
ANTHROPIC_MODEL=claude-opus-4-8
OPENAI_MODEL=gpt-5.5
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
- Every owner-facing run chooses a strict economic tier. **Free** stays on the
  $0 rotator with paid fallback disabled. **Paid** uses only configured paid
  providers, budget-gating each call and quota-failing over only within Paid.
- Paid call-count limits are atomic only within one Factory Node process. The
  USD ledger is an estimated admission guard, not an actual billing cap; use
  provider-native account caps for a hard actual-dollar guarantee.

## Changing models

Edit `ANTHROPIC_MODEL` / `OPENAI_MODEL` in `.env`, and the default routing with
`DEFAULT_CODE_PROVIDER` / `DEFAULT_REVIEW_PROVIDER`. The Settings screen reflects
the active values.

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

Purpose Foundry is the optional portfolio assembly-line mode. It coordinates Factory Deck, Scout a Program, Repo Rewards, PromoPilot, FlexFactor, The Crucible, App Store Publisher, and Watchtower through a durable station contract and hash-chained evidence ledger. Every existing application remains independently launchable.

Set `PURPOSE_FOUNDRY_OBSIDIAN_INBOX` to an Obsidian folder to ingest saved Markdown project notes automatically. Run `pnpm install:purpose-foundry-icon` once to create the separate **Purpose Foundry** desktop shortcut; the existing Factory Deck shortcut is unchanged. See [`docs/PURPOSE_FOUNDRY.md`](docs/PURPOSE_FOUNDRY.md).

Purpose Foundry launchers do not bypass Windows execution policy. If Windows marks a freshly downloaded checkout as blocked, review the scripts and explicitly run `Get-ChildItem scripts\\*.ps1 | Unblock-File` once before installing the shortcuts.
