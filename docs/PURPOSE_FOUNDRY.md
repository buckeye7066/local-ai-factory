# Purpose Foundry

Purpose Foundry is an optional orchestration mode in Factory Deck. It does not
replace or absorb the specialist applications. Factory Deck, Scout a Program,
Repo Rewards, PromoPilot, FlexFactor, The Crucible, App Store Publisher, and
Watchtower remain independently addressable. The six standalone applications
retain their own repositories, data, credentials, and interfaces; The Crucible
and Watchtower operate as Foundry services.

## Automatic station adapters

Starting a project now dispatches the active station automatically. Purpose
Foundry uses the programs' existing public interfaces rather than absorbing
their implementations:

| Station | Adapter | Work performed |
| --- | --- | --- |
| Scout | FlexFactor CLI | Profiles the target and produces a Repo Rewards scouting report. |
| Repo Rewards | HTTP search API | Searches for maintained, relevant open-source components and records the result set. |
| PromoPilot | authenticated HTTP API | Collects control-plane, campaign, attribution, destination, and advertisement data. |
| Factory Deck | local run API | Receives the completed discovery and market handoffs, builds or extends the named target, and waits for its durable run result. |
| FlexFactor | local CLI | Runs the production-readiness repair workflow against the target. |
| The Crucible | independent review provider | Assumes the result is wrong and returns evidence-backed findings or a hardened verdict. |
| App Store Publisher | local HTTP API | Checks stores, submissions, and release-artifact readiness. It stops visibly when no signed artifact exists. |
| Watchtower | HTTP probes | Measures the explicitly configured deployment endpoints and returns failures to the line. |

An adapter that lacks credentials, a target, a release artifact, or a deployed
endpoint moves to **needs attention** instead of pretending its work passed.
Correct the configuration and use **Retry** on that station. Adapter output is
stored under `.factory/foundry/artifacts/<project>/<station>/` and referenced
from the hash-chained evidence ledger.

New projects run discovery and market evidence before Factory Deck so the
implementation receives those findings instead of researching after the build.
Existing project records retain their stored station order for continuity.

## Adapter configuration

```dotenv
# Existing Obsidian intake
PURPOSE_FOUNDRY_OBSIDIAN_INBOX=C:\Users\YourUserName\Documents\Obsidian Vault\Purpose Foundry

# Existing deployed/local programs
PURPOSE_FOUNDRY_REPO_REWARDS_URL=https://web-production-d7db7.up.railway.app
PURPOSE_FOUNDRY_PROMOPILOT_URL=https://promopilot-production-6370.up.railway.app
PURPOSE_FOUNDRY_PROMOPILOT_TOKEN=the-existing-promopilot-admin-token
PURPOSE_FOUNDRY_APP_STORE_PUBLISHER_URL=http://127.0.0.1:4000

# Existing FlexFactor installation
PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT=C:\Users\firer\flexfactor\flexfactor.py
PURPOSE_FOUNDRY_PYTHON=python
PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER=ollama
PURPOSE_FOUNDRY_FLEXFACTOR_MAX_COST=150

# Explicit deployments for Watchtower; comma/semicolon/newline separated
PURPOSE_FOUNDRY_WATCH_URLS=https://example.app/health,https://api.example.app/health
```

`PURPOSE_FOUNDRY_FLEXFACTOR_PROVIDER` accepts `ollama`, `anthropic`, or
`openai`. When omitted, Factory Deck's free route maps to local Ollama; a paid
Factory Deck selection maps to the corresponding FlexFactor provider. Cloud
Scout does not send program context unless
`PURPOSE_FOUNDRY_ALLOW_REMOTE_PROGRAM_CONTEXT=1` is explicitly configured.

## Station contract

Purpose Foundry protocol `1.0` exposes the station catalog at
`GET /api/foundry/stations`. Projects enter through the UI, `POST
/api/foundry/projects`, or an Obsidian Markdown note. A station reports durable
progress through:

`POST /api/foundry/projects/:projectId/stations/:stationId/events`

```json
{
  "status": "completed",
  "summary": "What the station established",
  "artifacts": ["path-or-url"],
  "evidence": { "tests": ["command and result"] }
}
```

The control plane advances only after a station records its outcome. An
external program may still report its own event through this endpoint; the
built-in adapters use the same state transition rules. All events
are appended to `.factory/foundry/evidence.jsonl` in a SHA-256 hash chain.

## Obsidian intake

Set `PURPOSE_FOUNDRY_OBSIDIAN_INBOX` to a folder inside an Obsidian vault. The
server scans once at startup and then every five seconds; unsetting the variable
disables automatic polling. **Scan inbox** remains available for an immediate
manual scan. Markdown uses a small, deterministic frontmatter subset:

```markdown
---
project: IPlay
purpose: Produce believable avatar musical performances
target_users: musicians, creators
success: correct fingering, synchronized audio, stable rendering
targets: buckeye7066/IPlay
constraints: preserve existing workflows
---

# IPlay

Additional instructions and context.
```

Unchanged notes are deduplicated by absolute path and content hash.

## Desktop launcher

Run `scripts\Install-Purpose-Foundry-Icon.ps1` once. The resulting **Purpose
Foundry** desktop shortcut starts the same dependable Factory Deck backend but
opens `?mode=foundry`. The existing Factory Deck shortcut continues to open its
normal New Run screen.

The launchers do not bypass Windows execution policy. If a downloaded checkout
is marked as blocked, inspect the scripts and explicitly run
`Get-ChildItem scripts\*.ps1 | Unblock-File` once.
