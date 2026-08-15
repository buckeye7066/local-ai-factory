# IPlay readiness thresholds (Master Prompt 210–212)

These thresholds gate production-ready claims. They are enforced in software
where offline-testable; full-avatar visual QA still requires a local Wan2.2 GPU
run against reference performances.

## Sync / continuity (210)

| Check | Threshold | Enforced by |
|-------|-----------|-------------|
| Scene timing drift vs source scene | ≤ 2.5% | `performance_transfer._normalize_scene` |
| Source A/V duration gap (source-preserved) | ≤ max(50 ms, 2/fps) | `performance_source.validate_performance_media` |
| Replacement mask near-noop mean delta | ≥ 0.012 | `performance_qa.replacement_coverage` |
| Replacement unchanged fraction | ≤ 0.965 | `performance_qa.replacement_coverage` |
| Pose median normalized distance | ≤ 0.055 | `performance_qa.pose_fidelity` (enforced when generated pose exists; otherwise `pose_qa.status=deferred`) |
| Pose p90 normalized distance | ≤ 0.11 | `performance_qa.pose_fidelity` (same deferred rule) |
| Guitar max fret jump (solver) | ≤ 5 frets | `instrument_solvers` |
| Violin max position jump (solver) | ≤ 2 positions | `instrument_solvers` |
| Piano same-hand key jump (solver) | ≤ 12 keys | `instrument_solvers` |
| Beat-onset stroke tolerance (legacy verify) | ≤ 50 ms | `motionsync` / verify harness |

## Audio authority (210 / 211)

| Check | Threshold | Enforced by |
|-------|-----------|-------------|
| Pre-render master PCM SHA-256 recorded | required | `audio_authority.hash_master_audio` |
| Restored soundtrack empty/missing | reject | `audio_authority.verify_restored_audio_hash` |
| HeyGen/Wan may alter master audio | false | timeline `immutable` + HeyGen bounded payload |
| HeyGen failure/retry may alter timeline | false | `assert_timeline_untouched` |

## Windows install journey (212)

| Step | Requirement |
|------|-------------|
| Launcher | `C:\Users\firer\Iplay\iplay.pyw` or `Launch-IPlay.cmd` |
| Runtime | Python 3.11/3.12, FFmpeg/FFprobe 6+, `requirements.txt` |
| Exact mode extras | `IPLAY_WAN_HOME`, `IPLAY_WAN_ANIMATE_CKPT`, CUDA WanAnimatePipeline |
| Consent | UI checkbox / `--rights-acknowledged`; sidecar `consent.json` |
| License inventory | `iplay/refs/manifest.json` copied into consent sidecar |
| Resume | `--work-dir` + `iplay_render_checkpoint.json` |
| Export sidecars | `.iplay/consent.json`, `performance_timeline.json`, `audio_authority.json` |

## Honest limits

Full-avatar Wan2.2 replacement is **source-driven**, not mathematically proven
note-contact reconstruction. Automated hand/instrument contact retry remains a
quality layer after these gates. Beat-timed approximation must never be labeled
exact performance.
