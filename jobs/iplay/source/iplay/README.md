# IPlay

IPlay is a Windows music-video pipeline for creating a believable avatar performance of piano, guitar, or violin music while keeping one continuous master soundtrack.

The product now has **two deliberately different performance modes**:

1. **Full Avatar Performance** — preferred when a real synchronized performance video of the target song exists. The real performance drives motion; Wan2.2-Animate replacement mode regenerates the complete visible performer as the chosen avatar scene-by-scene.
2. **Beat-Timed Approximation** — fallback for audio-only material. A real-playing reference clip is retimed to the beat grid. It is rhythmic approximation, not exact fingering/chord/pick/bow reconstruction.

The distinction is intentional. IPlay must not label BPM-aligned generic playing as exact performance.

## Install and launch

Core requirements:

- Python 3.11 or 3.12
- FFmpeg and FFprobe 6+ on `PATH`
- packages from the repository root `requirements.txt`

```powershell
python -m pip install -r requirements.txt
python iplay.pyw
```

Equivalent:

```powershell
cd iplay
python iplay.pyw
```

`Launch-IPlay.cmd` is the double-click Windows entry point at the repository root.
`iplay.pyw` opens the mode chooser. Output defaults to the current Windows user's `Videos\IPlay` directory.

## Full Avatar Performance

See `EXACT_PERFORMANCE.md` for the detailed contract.

The goal is **not** a face swap. The source musician is motion evidence only. The final performer must be the supplied avatar from head to toe.

### Pipeline

1. Validate the synchronized source performance and select its master audio stream.
2. Analyze tempo/onsets only to find musical scene boundaries.
3. Split the performance into manageable outer scenes, normally 4–9 seconds.
4. Extract a representative full-avatar reference image from the supplied avatar photo/video.
5. Use the official Wan2.2-Animate preprocessing path in `replace` mode for every scene. IPlay requests an expanded replacement mask so the performer and instrument-interaction envelope are regenerated rather than intentionally preserving source body fragments.
6. Load `WanAnimatePipeline` once in a persistent worker and render every planned scene with:
   - avatar reference image;
   - source pose video;
   - source face/expression guidance;
   - source background video;
   - replacement mask video;
   - replacement mode;
   - 77-frame internal temporal segments with previous-segment conditioning.
7. Reject missing, truncated, or excessively time-drifted scenes. Exact mode does **not** substitute the original musician or generic reference footage.
8. Concatenate only validated avatar scenes.
9. Restore the untouched original master soundtrack.
10. Run IPlay's cinematic local director over the completed avatar performance and validate final audio/video coverage.

### Wan2.2 runtime

Exact full-avatar mode uses the official Wan2.2-Animate stack locally. Configure either through the UI or environment variables:

- `IPLAY_WAN_HOME` — official Wan2.2 checkout containing `wan/modules/animate/preprocess/preprocess_data.py`
- `IPLAY_WAN_ANIMATE_CKPT` — Wan2.2-Animate-14B folder containing `process_checkpoint`
- `IPLAY_WAN_DIFFUSERS_MODEL` — optional Diffusers model path/id; defaults to `Wan-AI/Wan2.2-Animate-14B-Diffusers`

A current CUDA-capable PyTorch/Diffusers environment with `WanAnimatePipeline` support is required for practical rendering. This path does not require Anthropic, OpenAI, or HeyGen API keys.

### Accuracy contract

Full-avatar mode is **source-driven**, not mathematically guaranteed contact reconstruction. Wan2.2 can still generate incorrect fingers, fret contact, pick contact, bow/string contact, keys, or instrument geometry. The real source performance gives IPlay much stronger motion evidence than BPM retiming, but a generated scene still requires visual QA.

The next major quality layer is automated hand/instrument contact verification plus scene-level retry. IPlay should eventually reject and rerender scenes whose generated hand/instrument mechanics diverge materially from the source performance.

## Beat-Timed Approximation

When no synchronized performance video exists, IPlay can use tracked real-playing reference clips:

- `piano_raw.webm`
- `guitar_raw.webm`
- `violin_raw.webm`

`sync.py` supports `warp`, `cut`, and `loop` policies. These align gestures to the music but do not prove exact keys, frets, strings, fingers, picks, chords, or bow contacts.

## Cinematic director

The local director keeps one continuous performance timeline and original soundtrack while creating virtual camera variation through crop/pan/zoom/cut framing. Scene boundaries prefer musical beat/downbeat locations. Optional mood/B-roll assets are kept separate from the performance-motion authority.

## Audio authority

The selected original source audio stream is the master soundtrack. A temporary 22.05 kHz mono WAV may be used for timing analysis, but it is never substituted for the final soundtrack.

## Validation and fail-closed behavior

IPlay validates media before publishing it. Depending on the path, checks include:

- decodable video and audio streams;
- expected duration;
- per-stream coverage;
- output dimensions;
- timing drift;
- missing replacement scenes;
- atomic partial-to-final promotion;
- UHD preflight and explicit 1080p fallback labeling.

Full-avatar mode additionally refuses these as successful output:

- avatar head on source body;
- intentional reuse of source torso/arms/hands/clothing as the generated character;
- short avatar footage followed by the original musician;
- generic beat-only footage substituted for a failed exact scene;
- missing/truncated replacement scenes;
- excessive scene timing drift.

## HeyGen boundary

IPlay does not use HeyGen to generate fingering, picking, strumming, bowing, keyboard motion, or the core performance. Legacy direct performance-generation calls remain retired. Optional HeyGen production-asset metadata is limited to non-performance material such as backgrounds or B-roll.

## YouTube adapter

`ytadapter.py` can place permitted downloads in `%USERPROFILE%\Videos\IPlay\youtube`. Use it only for media you own, Creative Commons media, or material with an official download right.

## Offline tests

From the repository root:

```powershell
python test_choose_policy.py
python test_motionsync.py
python iplay/test_repo_hygiene.py
python iplay/test_pipeline_resilience.py
python iplay/test_performance_source.py
python iplay/test_scenes.py
python iplay/test_performance_transfer.py
python iplay/test_production_bridge.py
```

Local timeline preview (no Wan/HeyGen):

```powershell
python iplay/preview_timeline.py path\to\song.mp4 guitar %TEMP%\iplay_preview.json
```

CI compiles the full-avatar orchestration and worker modules but does not download or execute the 14B Wan model. The external model runtime must be validated on the production Windows/GPU environment.

Production readiness thresholds for sync, audio hashes, and the Windows journey are documented in `READINESS_THRESHOLDS.md`.

## Known limits

- Full-avatar generation can still make hand/instrument errors even when driven by the correct performance.
- The generic virtual-camera crop coordinates are not instrument-calibrated hand tracking.
- Beat-only fallback remains gesture-timed rather than note-accurate.
- UHD may require substantial compute and disk space; validated 1080p fallback remains an intentional delivery path when UHD is not safe.
