# Factory Deck — `local-ai-factory`

A **local-first AI software factory**. You describe an app; a line of specialist
agents — Product Spec → Architect → Task Planner → Builder → Test Writer → QA
Critic → Repair Loop → Final Review — collaborate locally to design, generate,
test, and self-repair a small working app, then hand you a report and a
workspace folder you can open and run.

It ships with a premium control-room UI ("Factory Deck") that visualizes the
assembly line in real time, and a fully offline **demo mode** so you can see the
whole thing animate before adding any API keys.

---

## How the assembly line works

```
Idea
  └─▶ Intake → Product Spec → Architecture → Task Plan
        → File Generation → Write to Workspace
        → Test Generation → (install / typecheck / test*)
        → QA Critique → Repair Loop ⟲ (bounded) → Final Report
```

- Each agent has a **strict input/output schema** (Zod). Models are asked for
  JSON, which is validated before it is ever used — no free-form parsing.
- The **repair loop** is bounded by `MAX_REPAIR_LOOPS`. It re-runs QA after each
  repair and stops the moment QA passes (or the cap is hit). It can never run
  forever — see `src/server/orchestrator/repairLoop.ts`.
- Every model call is metered against `MAX_MODEL_CALLS_PER_RUN` (a cost guard).

\* Commands only run when you opt out of dry-run mode (see Security below).

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
DEFAULT_CODE_PROVIDER=anthropic
DEFAULT_REVIEW_PROVIDER=openai
MAX_REPAIR_LOOPS=3
MAX_MODEL_CALLS_PER_RUN=30
WORKSPACE_ROOT=./workspaces
DRY_RUN_COMMANDS=true
```

> You do **not** need any keys to try it — demo mode runs fully offline.

---

## Run the polished UI

```bash
pnpm dev
```

This starts the local backend (`http://127.0.0.1:5179`) and the Factory Deck UI
(`http://localhost:5180`). Open the UI, type an idea (or click **Demo Mode** in
the sidebar), and watch the assembly line run.

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
  models, limits, and the dry-run flag.

## Run from the CLI

```bash
pnpm factory "build me a family chore tracker with rewards"
```

Streams stage-by-stage progress and prints the final workspace path + report.

## Demo mode (no keys required)

```bash
pnpm demo
```

Uses the **stub provider**: it generates a tiny but real Vite + React + TS app,
injects one QA issue, runs exactly one repair loop, and finishes with a passing
report — so you can see the whole flow (and every animation) offline.

---

## Security & safety boundaries

This is designed to be safe to run on your own machine:

- **Keys never reach the browser.** They live only in the backend process. The
  `/api/health` endpoint returns *booleans* (`configured` / `missing`), never
  values. There is no UI field to type a key — add keys by editing `.env`.
- **Model calls are server-side only.** The frontend talks to a local API.
- **`.env` is never sent to a model** and is git-ignored.
- **Generated files are jailed to `./workspaces`.** Writes go through
  `safeResolve`, which rejects absolute paths and `..` traversal
  (`src/server/workspace/fileWriter.ts`).
- **Commands are conservative.** Only an allowlist (npm/pnpm `install` / `build`
  / `test` / `typecheck`) may run, and only *inside* a workspace, with `shell`
  disabled (no injection surface). With `DRY_RUN_COMMANDS=true` (the default),
  commands are **previewed, not executed** (`src/server/workspace/commandRunner.ts`).

## Cost control

- `MAX_MODEL_CALLS_PER_RUN` hard-caps LLM calls per run.
- `MAX_REPAIR_LOOPS` bounds the repair loop.
- Demo mode makes **zero** API calls.

## Changing models

Edit `ANTHROPIC_MODEL` / `OPENAI_MODEL` in `.env`, and the default routing with
`DEFAULT_CODE_PROVIDER` / `DEFAULT_REVIEW_PROVIDER`. The Settings screen reflects
the active values.

---

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Backend + UI together (dev, hot reload) |
| `pnpm start` | Production mode: build the UI, then serve everything from the backend on `http://127.0.0.1:5179` (single process, no Vite) |
| `pnpm server` | Backend only (tsx watch) |
| `pnpm ui` | Vite UI only |
| `pnpm factory "<idea>"` | Run the factory from the CLI |
| `pnpm demo` | Offline stub demo run |
| `pnpm test` | Vitest suite |
| `pnpm typecheck` | Type-check server + UI |
| `pnpm build` | Type-check + production UI build |
| `pnpm lint` | Prettier formatting check |

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
