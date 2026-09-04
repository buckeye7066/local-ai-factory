# IPlay — Production Readiness Report

**Program:** IPlay (instrument performance compositor)  
**Agent:** production-agent-iplay  
**Branch:** `production-ready/iplay`  
**Repo:** buckeye7066/Iplay (default `main`)  
**Local source:** `D:\Projects\Iplay` (not `avatar-video`)  
**Launcher:** `D:\Projects\Iplay\iplay.pyw` / `Launch-IPlay.cmd`  
**PR:** https://github.com/buckeye7066/Iplay/pull/6  
**Branch SHA:** `eaa538c80098d60e6ac77ea825b81b5e6b0fbbae`  
**Main SHA (at branch point):** `62a20522c14e02e5869055417cdb6a9911489c7c`  
**Updated:** 2026-08-08  

## Verdict

**SOFTWARE COMPLETE, EXTERNAL RELEASE BLOCKER** pending owner Wan2.2 GPU reference-performance runs for Exit **210** visual/sync thresholds on piano, guitar, and violin. Unblocked software for Bridge **205–209** and Exit **211–212** (offline + launcher) is implemented and verified on this branch.

| Criterion | Status |
|-----------|--------|
| 210 Reference performances meet sync / action / audio-hash thresholds | **PARTIAL** — thresholds documented + solver/audio/consent gates offline; full-avatar Wan visual QA needs GPU |
| 211 HeyGen failure/retry cannot alter timeline or uncut audio | **PASS (software)** — bounded payload + `assert_timeline_untouched` + master PCM SHA-256 |
| 212 Clean Windows import/analyze/preview/render/resume/export + consent | **PASS (software)** for analyze/preview/resume/consent/launcher; full render needs Wan |

## Purpose contract

IPlay owns musical motion (fingering, bow/strum/pick, beat continuity, director). HeyGen is optional and limited to non-performance assets; Wan2.2 local replace is the full-avatar engine. Face-only / source-body fallback remains forbidden.

## Phase A — Source of truth

- GitHub: `https://github.com/buckeye7066/Iplay` · `main` @ `62a2052`
- Local: `D:\Projects\Iplay` on `production-ready/iplay`
- Prior board path `avatar-video\iplay` is incorrect for this program

## Phase B — Audit gaps closed

1. No typed performance timeline / HeyGen mutation boundary.
2. No instrument-specific action solvers with jump clamps.
3. No master-audio SHA-256 authority record across restore.
4. No required consent / license inventory sidecar.
5. No resume checkpoint keyed to audio hash.
6. Board launcher path missing at repo root.
7. Dishonest pose self-compare risk → deferred until generated pose exists.

## Phase C/D — Bridge 205–209

| # | Item | Implementation |
|---|------|----------------|
| 205 | Typed performance timeline | `iplay/performance_timeline.py` |
| 206 | Source vs audio tiers; motion ≠ avatar identity | timeline `motion_source_tier` + separate identities |
| 207 | Instrument solvers | `iplay/instrument_solvers.py` (guitar/violin/piano) |
| 208 | Director + bounded HeyGen instructions | existing `scenes.render_local_director` + `heygen_bounded_payload` |
| 209 | Sync metrics, audio hashes, resume, preview, launcher, licenses | `audio_authority`, `render_checkpoint`, `preview_timeline`, `Launch-IPlay.cmd`, `refs/manifest.json` |

## Phase E — Verification evidence

```text
python iplay/test_production_bridge.py   → Ran 10 tests OK
python iplay/test_performance_transfer.py → Ran 8 tests OK
python test_choose_policy.py             → PASS (8/8)
python test_motionsync.py                → PASS (onset recall 94%, tempo ok)
python iplay/preview_timeline.py _test_track.wav guitar %TEMP%\iplay_preview_test.json
  → scene_count=1, plausible guitar continuity, master_audio_hash recorded
```

CI workflow compiles new modules and runs `test_production_bridge.py`.

## Phase F/G — Review / integrate

- PR #6 opened: `production-ready/iplay` → `main`
- After merge, record exact main SHA and re-run offline suite on clean clone
- Full PRODUCTION READY requires owner Wan2.2 GPU reference runs per `iplay/READINESS_THRESHOLDS.md`

## External blockers (owner action)

1. Configure `IPLAY_WAN_HOME`, `IPLAY_WAN_ANIMATE_CKPT`, CUDA WanAnimatePipeline.
2. Run full-avatar reference performances for piano/guitar/violin; confirm drift ≤2.5%, replacement coverage, optional generated-pose fidelity.
3. Optional: HeyGen credentials only for non-performance B-roll — never for instrument motion.

## Key files

- `iplay/performance_timeline.py`, `instrument_solvers.py`, `audio_authority.py`
- `iplay/consent_records.py`, `render_checkpoint.py`, `preview_timeline.py`
- `iplay/performance_transfer.py`, `exact_avatar_app.py`
- `iplay.pyw`, `Launch-IPlay.cmd`, `iplay/READINESS_THRESHOLDS.md`
- `iplay/test_production_bridge.py`
