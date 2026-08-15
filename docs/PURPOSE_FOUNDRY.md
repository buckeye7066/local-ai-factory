# Purpose Foundry

Purpose Foundry is an optional orchestration mode in Factory Deck. It does not
replace or absorb the specialist applications. Factory Deck, FlexFactor, Scout a
Program, Repo Rewards, PromoPilot, and App Store Publisher remain independently
launchable and retain their own repositories, data, credentials, and interfaces.

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

The control plane advances only after a station records its outcome. All events
are appended to `.factory/foundry/evidence.jsonl` in a SHA-256 hash chain.

## Obsidian intake

Set `PURPOSE_FOUNDRY_OBSIDIAN_INBOX` to a folder inside an Obsidian vault, then
choose **Scan inbox**. Markdown uses a small, deterministic frontmatter subset:

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
