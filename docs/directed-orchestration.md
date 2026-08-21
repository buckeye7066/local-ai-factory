# Directed orchestration (shared rule)

**One open issue. Coding models only. Never wander.**

This rule is identical across:

- **Factory Deck** — `buckeye7066/local-ai-factory` (server + agents)
- **Purpose Foundry** — same repo, `src/server/foundry/` (uses the same provider registry + WorkTheme)
- **FlexFactor** — `buckeye7066/flexfactor` (`flexfactor_directed` / `flexfactor_run.py`)

## The rule

1. Every concurrent / rotated model call on one job carries the **same theme** and the **same open issue**.
2. Catalog routes that cannot author or review code (prompt-guard, TTS, vision-only, embed, content-safety, etc.) are **excluded** before rotation picks them.
3. Failure repair never targets generated trees (`node_modules/`, `dist/`, `build/`, `.next/`, `out/`, `coverage/`). Edit the source that produced them.
4. Correct the failing line. Do not ship launchers or boundary-only patches as a substitute for the broken path.

## How each surface applies it

| Surface | Mechanism |
|---|---|
| Factory Deck | `workTheme.ts` + `themeBind` / `underWorkTheme` at start/resume/epic; `ThemedProvider` on `resolveLive`; `routeFitness` + extended-transport buildability gate in `filterRoutableCatalog` |
| Purpose Foundry | Same registry (`app: "purpose-foundry"`) — including the rotation ring and the CLI/Cursor pools, no separate wiring; Crucible and other LLM stations run under `underWorkTheme`; FlexFactor process default is `flexfactor_run.py` |
| FlexFactor | `flexfactor_directed.install` via `flexfactor_run.py` (and desktop launchers); `_directed_work_theme_block`; skip-dir failure paths; unfit-route filter. Prefer `python flexfactor_run.py` over bare `flexfactor.py` so install is always live. |

## Extended transports (CLI + Cursor pools)

Rotation also walks the local flat-rate CLIs (`claude-code` → `claude`,
`codex-cli` → `codex`) and `cursor`, behind `FACTORY_ROTATION_EXTENSIONS=1`.
They obey the same rule as every HTTP route:

- The system prompt `ThemedProvider` stamped — the **DIRECTED WORK THEME**
  block — is **prepended to the CLI's stdin body**, never passed as an
  argument. So a rotated CLI turn attacks the same open issue as every other
  backend, and no free text ever crosses a `cmd.exe` shim.
- Every call is bounded (`FACTORY_CLI_TIMEOUT_MS`, default 600s) and expiry
  kills the process tree; a missing binary, non-zero exit, EMPTY output or
  cancellation all fail closed so the rotator rolls to the next pool.
- The provider refuses to run inside another CLI-provider call, so a rotation
  sweep cannot fan out into nested agents.
- Rotation stays **$0**: these are `subscription` cost-class, and `allowPaid`
  is still never set.

A route is admitted **only when its adapter is provably buildable** —
importable *and* constructible — never merely because a binary is on `PATH`.
Unbuildable comes back as a named reason, never an exception, so one broken
adapter cannot take the catalog filter down. See
`src/server/providers/extendedTransports.ts`.

**Pools, not model names.** `claude-code` deliberately shares AI Time's
`anthropic:max-plan` pool: the CLI and the FCC proxy drain one subscription,
and a private pool would tell the rotator it had two ledgers. `codex-cli`
(`codex:plan`) and `cursor` (`cursor:subscription`) really are new ledgers.

## Obsidian

Cross-agent decisions live in `G:\Obsidian Vault\AI Bus\messages.jsonl` (topics `#factory-deck`, `#flexfactor`, `#local-ai-factory`). Durable note: `Correct-not-avoid-Factory-Deck-FlexFactor-2026-08-20`.
