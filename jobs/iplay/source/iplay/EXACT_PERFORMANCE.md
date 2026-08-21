# IPlay exact-performance avatar mode

The target is one coherent lifelike video in which **the chosen avatar, not a
hybrid of the avatar and the source musician, performs the whole song**. The
source performance is motion evidence only. The final visible performer must be
regenerated as the avatar from head to toe, including clothing, arms, hands and
instrument appearance.

## Why the old face-only bridge was rejected

A face swap preserved the source musician's body and hands. That produced a
visual hybrid rather than the requested avatar. Exact mode no longer contains a
FaceFusion path or any face-only success state.

## Full-replacement pipeline

1. Validate the synchronized performance and keep its original audio as the
   master clock.
2. Analyze the music and split the performance on musical boundaries into
   manageable 4–9 second outer scenes. This bounds memory and makes scene-level
   failure/retry possible.
3. Extract a representative full-avatar reference image from the supplied avatar
   photo/footage.
4. Preprocess each driving scene with the official Wan2.2-Animate replacement
   pipeline. IPlay requests an expanded performance-envelope mask so the
   musician, limbs and instrument interaction area are regenerated rather than
   leaving visible source fragments.
5. Load Wan2.2-Animate-14B once in a persistent worker and generate every scene
   in `replace` mode. Wan itself further handles the scene in short temporal
   segments with previous-frame conditioning.
6. Validate every generated scene. A scene whose duration drifts by more than
   2.5% is rejected rather than time-stretched into a visibly false performance.
   Small encoder-duration differences are normalized back to the source scene
   clock.
7. Concatenate only validated avatar replacement scenes. No source-performer
   scene is permitted as a fallback.
8. Restore the untouched original soundtrack after the visual replacement is
   complete.
9. Run IPlay's existing source-preserved cinematic director over the resulting
   avatar-only performance and validate final audio/video coverage.

## Important accuracy boundary

This architecture is much closer to IPlay's goal because the real synchronized
performance drives the replacement rather than generic BPM-based strumming.
However, Wan2.2 replacement is still generative. It can make mistakes in fingers,
fret contact, pick contact, bow/string contact, or instrument geometry. Therefore
IPlay reports this mode as **source-driven full replacement**, not as mathematically
proven note-contact reconstruction. Final human/video QA remains required before
calling a render performance-accurate.

The next engineering layer is an automated hand/instrument contact verifier and
scene-level retry loop. That verifier should compare source and generated hand
trajectories/contact regions, reject bad scenes, and rerender only those scenes.

## Local runtime

Full-avatar mode uses the official open Wan2.2-Animate pipeline locally.
Configuration can be supplied through the UI or environment variables:

- `IPLAY_WAN_HOME`: official Wan2.2 checkout containing
  `wan/modules/animate/preprocess/preprocess_data.py`
- `IPLAY_WAN_ANIMATE_CKPT`: Wan2.2-Animate-14B checkpoint folder containing
  `process_checkpoint`
- `IPLAY_WAN_DIFFUSERS_MODEL`: optional local/Hugging Face Diffusers model path;
  defaults to `Wan-AI/Wan2.2-Animate-14B-Diffusers`

The runtime requires a current PyTorch/Diffusers environment with
`WanAnimatePipeline` support and a practical CUDA setup. It does **not** use an
Anthropic, OpenAI, or HeyGen API key.

## Fail-closed contract

Exact mode does not publish any of these as success:

- avatar head on the source musician's body;
- source torso, arms, hands or clothing intentionally retained as the character;
- a short avatar segment followed by the original musician;
- generic beat-only strumming substituted for a failed exact scene;
- a missing/truncated replacement scene;
- excessive timing drift;
- an output whose master audio is not restored from the synchronized source.

Launch `iplay/exact_avatar.pyw` or use `performance_transfer.py` directly.
The offline contract is covered by `test_performance_transfer.py` and CI; the
14B model itself is an external local runtime and is not downloaded in CI.
