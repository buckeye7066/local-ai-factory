# Factory Deck — `local-ai-factory`

A **local-first AI software factory**. You describe an app; a line of specialist
agents — Product Spec → Architect → Task Planner → Builder → Test Writer → QA
Critic → Repair Loop → Final Review — collaborate locally to design, generate,
test, and self-repair a small working app, then hand you a report and a
workspace folder you can open and run.

It ships with a premium control-room UI ("Factory Deck") that visualizes the
assembly line in real time. There is **no demo, mock, dry-run, or simulate
mode**: every run does real work against real providers, so what you watch on
the deck is what actually happened.

---

## How the assembly line works

```
Idea
  └─▶ Intake → Product Spec → Architecture → Task Plan
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

Live runs now research beyond named dependencies. Before planning is finalized, Factory Deck:

1. derives multiple discovery queries from the product specification;
2. finds and deduplicates relevant open-source products, libraries, APIs, and documentation;
3. inspects repository metadata, maintenance signals, file trees, and the most relevant source files;
4. records deterministic license evidence and classifies reuse as direct-use, conditional-review, or reference-only;
5. produces an evidence-linked feature comparison and selects specific elements to integrate; and
6. passes the selected approach and enforced reuse mode into planning and file generation.

Unknown, proprietary, or reciprocal licenses cannot be promoted to direct source reuse by a model response. Those candidates remain reference-only or are implemented as clean-room patterns. The crawl is bounded by query, candidate, file, byte, and timeout budgets so research cannot run indefinitely.

---

## Install

```bash
pnpm install
```

Requires Node ≥ 20 and pnpm.

## Create your `.env`

```bash
cp .env.example .env
```

Then edit `.env`:

```ini
ANTHROPIC_API_KEY=your_real_claude_api_key_here
OPENAI_API_KEY=your_real_openai_api_key_here
ANTHROPIC_MODEL=claude-opus-4-8
OPENAI_MODEL=gpt-5.5
DEFAULT_CODE_PROVIDER=free
DEFAULT_REVIEW_PROVIDER=free
MAX_REPAIR_LOOPS=3
MAX_MODEL_CALLS_PER_RUN=30
FACTORY_PAID_RESCUES_PER_HOUR=6
FACTORY_PAID_RESCUES_PER_DAY=24
FACTORY_PAID_MAX_USD_PER_DAY=2
WORKSPACE_ROOT=./workspaces
```

> A run needs a real provider. Start the FREE route ("Claude Code - FREE
> (Ollama)") or set a paid key — there is no offline fallback, because a run
> with no provider must fail loudly rather than fabricate a result. A paid key
> is configuration, not permission: only deliberately selecting Claude or
> OpenAI for a run authorizes billable calls.

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
  `POST /api/runs/:id/resume`. Legacy v1/v2 checkpoints are migrated to v3 and
  atomically rewritten; corrupt checkpoints fail explicitly instead of being
  treated as absent.
- **Workspaces** — the generated app folders.
- **Settings** — shows which keys are configured (never the keys themselves),
  models, and finite execution/spend limits.

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
- **Commands are conservative.** Only an allowlist (npm/pnpm `install` / `build`
  / `test` / `typecheck`) may run, and only _inside_ a workspace, with `shell`
  disabled (no injection surface). Commands really execute — there is no
  preview/dry-run mode (`src/server/workspace/commandRunner.ts`); the allowlist
  and the workspace jail are the safety boundary.

## Cost control

- `MAX_MODEL_CALLS_PER_RUN` hard-caps LLM calls per run.
- `MAX_REPAIR_LOOPS` bounds the repair loop.
- FREE-ONLY is the default and does not authorize paid fallback.
- Selecting Claude/OpenAI grants paid permission for that run only. Every paid
  call then needs a durable capacity/cost reservation under finite hourly,
  daily, and USD caps.
- `/api/health` reports settled spend and in-flight reservations using finite,
  JSON-safe values.

The complete maintenance contract and regression checklist are in
[`docs/FACTORY_DECK_HARDENING.md`](docs/FACTORY_DECK_HARDENING.md).

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
