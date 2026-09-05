# Factory Deck production smoke — 2026-09-05

This marker records the session production verification trigger after the startup-health, dead-owner lock recovery, and Windows owner-read race repairs merged to `main`.

The authoritative evidence is the `factory-deck-cloud` workflow started by this commit. It must generate a real immutable candidate, verify the same candidate on Linux, Windows, and macOS, and finalize the automatic provider ladder. A skipped workflow or mock/stub execution is not production evidence.
