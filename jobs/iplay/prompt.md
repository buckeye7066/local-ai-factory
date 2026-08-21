You are Factory Deck operating on the IPlay repository. Your assignment is to integrate the strongest capabilities of Music.AI/Moises, Klangio, Blender, Unreal Engine/MetaHuman, and ACE Studio into IPlay so it can convert a soundtrack into a synchronized, physically credible avatar performance.

Do not perform a superficial integration that merely displays chord names, makes an avatar sway to the beat, or plays generic instrument animations. The visible performance must be generated from the musical content of the uploaded soundtrack.

## 1. Preserve and advance IPlay’s original purpose

First inspect the entire IPlay repository, including:

- README and product documentation
- Source files
- Existing render pipelines
- Audio-analysis components
- Avatar and animation components
- Instrument implementations
- Tests and fixtures
- Issues, pull requests and commit history
- Deployment configuration
- Existing integrations, including HeyGen or other avatar providers
- Existing user workflows and exported videos

Determine and document IPlay’s original purpose before changing it.

The controlling product purpose is:

> IPlay transforms a user-supplied soundtrack and optional reference video into a complete avatar musical performance. The avatar must appear to play the music actually heard in the soundtrack, with visible movements synchronized to the recognized notes, chords, rhythm, articulations and instrument technique. It initially supports acoustic guitar, electric guitar, bass guitar, piano and violin. Its architecture must permit additional instruments and singing voices later without redesigning the system.

Preserve any existing implementation that already serves this purpose. Replace, repair or remove functionality that only creates decorative, generic or musically unrelated movement.

## 2. Operating requirements

Work autonomously through discovery, architecture, implementation, migration, testing and documentation.

Do not stop for minor design decisions. Make sound, reversible engineering decisions consistent with the existing stack.

Stop only if an action genuinely requires unavailable credentials, legal authorization, elevated permissions or a material product decision that cannot reasonably be inferred. Missing credentials must not prevent completion of provider adapters, configuration, tests or the remainder of the pipeline.

Never:

- Claim an integration works when only a placeholder or mock exists.
- Hard-code API keys, tokens or credentials.
- Scrape a provider’s private web interface in place of an authorized API.
- Copy proprietary source code.
- Use noncommercial model weights in a commercial production path.
- Represent generic hand motion as verified instrument performance.
- Treat chord labels alone as sufficient information for finger animation.
- Hide transcription uncertainty or silently invent notes.
- Use the same actor’s written assertion as proof that a feature works.

Use official APIs, SDKs, documented export formats and legally compatible open-source components. Verify current documentation, terms, supported formats and licensing before implementing each provider.

## 3. Required architecture

Implement the following pipeline:

```
Soundtrack or reference video
        ↓
Media ingestion and normalization
        ↓
Music.AI stem separation and beat analysis
        ↓
Klangio note/chord/tab transcription
        ↓
Optional independent transcription verification
        ↓
Canonical Musical Timeline
        ↓
IPlay Instrument Performance Compiler
        ↓
Blender deterministic performance animation
        ↓
Optional Unreal Engine/MetaHuman premium rendering
        ↓
ACE Studio vocal transformation and singing layer
        ↓
Audio/video synchronization, validation and export

```

Provider-specific code must not leak throughout the application. Create stable internal interfaces and adapters so a provider can be replaced without rewriting IPlay.

Implement provider interfaces equivalent to:

```
StemSeparationProvider
MusicTranscriptionProvider
TranscriptionVerificationProvider
PerformancePlanningProvider
AvatarAnimationProvider
AvatarRenderProvider
VocalSynthesisProvider
MediaAssemblyProvider

```

Provide feature flags and configuration for each external provider. The application must clearly distinguish:

- Configured and live
- Configured but failing
- Not configured
- Local fallback available
- Mock/test-only

Never silently substitute a mock in production.

## 4. Media ingestion

Implement a durable ingestion service that:

- Accepts common audio and video formats.
- Extracts audio from video without changing duration.
- Preserves the original media as an immutable source asset.
- Converts working audio to a documented internal format and sample rate.
- Measures duration, loudness, clipping and channel layout.
- Detects initial silence and offset.
- Creates a stable project and job ID.
- Uses content hashes to make repeated processing idempotent.
- Stores provider outputs and intermediate artifacts with provenance.
- Supports resumable processing after a worker or provider failure.
- Maintains synchronization using one canonical timebase.

Do not repeatedly recompress the original soundtrack.

## 5. Music.AI/Moises integration

Use the official Music.AI developer platform as the primary stem-separation and preliminary analysis provider.

Implement an authorized Music.AI adapter that can request, when available:

- Acoustic guitar stem
- Electric guitar stem
- Rhythm guitar stem
- Lead guitar stem
- Bass stem
- Piano/keyboard stem
- String stem
- Lead vocal stem
- Backing vocal stem
- Drum and remaining accompaniment stems
- Beat and downbeat timestamps
- Tempo and meter
- Chord analysis
- Instrument detection

Requirements:

1. Verify current official API endpoints, authentication, webhook behavior, quotas, timeouts and pricing before coding.
2. Submit long-running work asynchronously.
3. Verify webhook signatures if the provider supports signed callbacks.
4. Poll only through a bounded fallback mechanism.
5. Store the provider, model/version, settings, timestamps and output checksums.
6. Retry transient errors with bounded exponential backoff.
7. Do not retry permanent authentication, quota or unsupported-format errors indefinitely.
8. Validate that returned files are complete and have the expected duration.
9. Preserve the original full mix for the final video unless the user elects to replace or remix it.
10. Feed isolated stems—not only the full mix—into downstream transcription whenever possible.

The Music.AI chord result is supporting evidence. It must not replace note-level transcription.

## 6. Klangio integration

Use the official Klangio API as the principal transcription provider.

Request the most detailed supported outputs appropriate to each instrument:

- MIDI
- MusicXML
- Guitar Pro/GP5 or tablature for guitar and bass
- Chord timeline
- Beat/downbeat information
- Note onset and offset
- Pitch
- Velocity when available
- Articulation or expression data when available
- Confidence or uncertainty when exposed

Use instrument-specific transcription modes for:

- Acoustic guitar
- Electric guitar
- Bass guitar
- Piano
- Violin or strings
- Vocals

Use full-mix transcription only when an isolated stem is unavailable or as a comparison pass.

Requirements:

1. Verify current API access requirements and supported instruments.
2. Preserve raw provider responses.
3. Parse all outputs into IPlay’s canonical model.
4. Retain both quantized and unquantized timing when available.
5. Do not discard pitch bends, slides, sustain, note duration or rhythmic subdivisions.
6. Reconcile Klangio’s tempo map with the original media timebase.
7. Identify gaps, overlaps and low-confidence passages.
8. Allow corrected transcriptions to be saved without modifying the original provider output.
9. Cache identical requests when permitted by provider terms.
10. Expose clear failure and retry information without revealing secrets.

## 7. Independent transcription verification

Add a replaceable verification adapter.

Evaluate Mirelo/MuScriptor as a secondary full-mix-to-MIDI system. The openly published MuScriptor weights may have noncommercial restrictions. Do not ship or use restricted weights in IPlay’s commercial production path unless the license expressly permits IPlay’s intended use or a commercial agreement is obtained.

If an authorized commercial Mirelo API is available, use it as a second transcription opinion. Otherwise implement the adapter boundary and use a legally compatible alternative such as Spotify Basic Pitch for isolated-instrument verification.

Build a consensus process:

- Agreement between engines increases confidence.
- Disagreement does not automatically select one answer.
- Compare the result against the isolated stem, harmony, beat grid and instrument range.
- Reprocess uncertain passages using instrument-specific settings.
- Flag unresolved passages for the correction editor.
- Record which engine contributed each final event.

The system must continue operating with Klangio alone when the verifier is unavailable.

## 8. Canonical Musical Timeline

Create a provider-neutral musical data model. It must support at minimum:

```
Project
Track
Instrument
TempoMap
TimeSignature
Beat
ChordEvent
NoteEvent
ArticulationEvent
LyricEvent
PerformanceInstruction
ConfidenceEvidence
SourceProvenance
UserCorrection

```

Each note event must include, where applicable:

```
track_id
instrument_id
start_time_ms
end_time_ms
pitch_midi
pitch_name
velocity
confidence
source_provider
stem_reference
bend_curve
articulation
quantized_position
unquantized_time

```

Each chord event must include:

```
start_time_ms
end_time_ms
root
quality
bass_note
extensions
pitch_set
confidence
source_provider

```

Never collapse note-level information into chord labels and then attempt to reconstruct the original performance from the labels.

## 9. Build the IPlay Instrument Performance Compiler

This is the core proprietary IPlay component. It converts musical events into a physically playable performance plan.

The compiler must:

1. Validate that notes fall within the selected instrument’s playable range.
2. Generate all physically possible ways to produce each note or chord.
3. Score alternatives using biomechanical and musical constraints.
4. Select a continuous sequence that minimizes impossible or unnatural motion.
5. Preserve recognizable technique and articulation.
6. Generate timed targets for fingers, hands, wrists, elbows, shoulders and body posture.
7. Produce deterministic output from the same inputs and settings.
8. Support instrument-specific plugins rather than hard-coded conditionals throughout the application.
9. Detect impossible transitions and repair or flag them.
10. Maintain audio synchronization through the canonical timebase.

Create an `InstrumentDefinition` contract containing:

- Tuning and playable range
- Instrument geometry
- Strings, frets, keys or playable surfaces
- Fingering rules
- Hand-span constraints
- Allowed articulations
- Technique library
- IK targets
- Contact points
- Transition costs
- Preferred camera-safe poses
- Validation rules

### Acoustic and electric guitar

Implement:

- Standard tuning initially, with alternate tunings supported by configuration.
- String-and-fret assignment for every fretted note.
- Open strings.
- Barre chords.
- Chord voicings.
- Position shifts.
- Slides, bends, hammer-ons and pull-offs when supported by evidence.
- Muting and rests.
- Individual picking.
- Strumming.
- Palm muting and other visible techniques when supported.
- Left-hand contact with the appropriate string/fret region.
- Right-hand contact near the strings.

Infer downstroke/upstroke from onset order, rhythmic context and technique constraints when the audio does not uniquely determine it. Mark this as an inferred performance choice, not an observed fact.

Acoustic and electric guitar may share fretboard logic, but they must have separate posture, right-hand technique, instrument geometry and animation profiles.

### Bass guitar

Implement:

- Configurable four-, five- and six-string definitions.
- String-and-fret allocation.
- Fretted and open notes.
- Fingerstyle plucking.
- Pick playing.
- Slap/pop only when evidence or a user setting supports it.
- Position shifts and muting.
- Correct left-hand contact and plausible right-hand alternation.

Do not simply reuse guitar animations at a lower pitch.

### Piano

Implement:

- Exact MIDI-note-to-key mapping.
- Independent left- and right-hand allocation.
- Chord voicing.
- Fingering optimization.
- Hand crossover when necessary.
- Maximum hand span.
- Key depression synchronized with note onset.
- Key release synchronized with note end or sustain behavior.
- Sustain pedal animation when pedal information is available or credibly inferred.
- Finger contact with the actual key being sounded.

The avatar must not visibly press neighboring keys while different notes sound.

### Violin

Implement:

- Configurable tuning.
- String and position selection.
- Left-hand fingering.
- Open strings.
- Position shifts.
- Vibrato only where musically plausible.
- Bow direction planning.
- Bow changes.
- Bow speed and travel proportional to phrase duration and dynamics.
- Bow contact with the selected string.
- Pizzicato when detected or selected.
- Instrument placement under the chin and credible posture.

Recognize that audio alone may not uniquely reveal string choice, fingering or bow direction. Generate a physically valid, musically faithful plan and retain the distinction between observed evidence and inferred technique.

## 10. Optional reference-video analysis

When the user supplies a performance video, treat it as an additional source of truth.

Implement a reference-video pathway that can estimate:

- Body pose
- Hand position
- Instrument position
- Strumming or picking motion
- Bow direction and contact
- Piano hand regions
- Scene changes
- Camera framing
- Performer continuity

Musical transcription remains authoritative for what is heard. Reference video improves how the performance was physically executed.

Do not replace note-driven animation with blind motion transfer. Reconcile visible motion with the recognized musical timeline.

## 11. Blender integration

Use Blender as the initial deterministic animation and rendering backend.

Build or adapt:

- Rigged avatars with articulated fingers.
- Rigged acoustic guitar, electric guitar, bass, piano and violin assets.
- Instrument-specific IK targets.
- Finger-contact constraints.
- Hand, wrist, elbow and shoulder solvers.
- MIDI/timeline-driven animation generation.
- Body-performance layers for breathing, weight shifts and musical expression.
- Camera, lighting and scene templates.
- Headless rendering suitable for workers.
- Export of animation and scene metadata.
- Frame-accurate soundtrack synchronization.

Evaluate the Blender NLA MIDI Copier as an implementation reference or component. Verify its license and distribution implications before incorporating it. Do not let an add-on dictate IPlay’s domain model.

The Blender adapter must accept an IPlay Performance Plan, not raw provider-specific data.

The renderer must produce:

- Preview-quality output for rapid review.
- Final-quality output.
- A diagnostic render with visible note, chord, finger and contact overlays.
- Machine-readable validation information for each rendered frame or event.

## 12. Unreal Engine and MetaHuman integration

Implement Unreal Engine/MetaHuman as an optional premium rendering backend after the Blender pipeline works end to end.

Use:

- MetaHuman-compatible character rigs.
- Control Rig.
- Sequencer.
- Audio-driven facial animation.
- Imported or generated body and hand animation.
- Cinematic camera and lighting.
- Deterministic command-line or worker-driven rendering where supported.

Create a clear interchange contract between IPlay/Blender and Unreal, using supported formats such as FBX, USD or another verified format.

Unreal must not independently invent hand performance. It renders and refines the approved IPlay Performance Plan.

Keep Blender as a functional production renderer so IPlay is not dependent on Unreal for every job.

## 13. ACE Studio vocal integration

Add vocals behind a feature flag using an authorized ACE Studio integration pathway.

Verify whether ACE Studio currently offers an official API, SDK, enterprise integration or supported local automation mechanism. Do not automate its private user interface.

When authorized integration is available, support:

- Vocal stem ingestion.
- Vocal-to-MIDI and lyric extraction.
- MIDI-and-lyrics-to-singing generation.
- Voice replacement while retaining timing and phrasing.
- Low-register male voices suitable for bass singing.
- Chest resonance controls.
- Opera-style vocal controls.
- Choir and backing-vocal generation.
- Pitch, vibrato, dynamics and expression controls.
- Licensing metadata for every generated voice.

A deep bass result must use a voice model trained for a suitable low register. Do not achieve it solely by lowering pitch or formants.

Preserve:

- Original vocal option
- Generated vocal option
- Voice model identity
- Provider and model version
- Usage license
- User authorization for custom or cloned voices

Require affirmative proof that the user has the right to clone or transform a particular person’s voice. Premade voice models must be checked for commercial-use restrictions.

Synchronize MetaHuman or Blender facial animation to the final selected vocal audio, not an earlier draft.

## 14. Correction and review interface

Create an efficient correction workflow because automatic transcription will not always be perfect.

The user must be able to:

- Play the soundtrack with a synchronized note/chord cursor.
- Solo or mute stems.
- View waveform, beat grid, piano roll and tablature as appropriate.
- Inspect low-confidence events.
- Correct notes, chords, timing, duration, string, fret, finger, key, bow direction and articulation.
- Select alternate valid fingerings.
- Lock an approved passage against later reprocessing.
- Preview only a selected passage.
- Compare transcription providers.
- Compare animation before and after a correction.
- Regenerate only affected scenes rather than the entire video.

Keep the interface understandable to musicians who are not audio engineers.

## 15. Job orchestration and reliability

Long-running analysis and rendering must run as durable background jobs.

Implement:

- Explicit job states.
- Progress by stage and percentage.
- Idempotency.
- Resumption from the last valid artifact.
- Timeouts.
- Bounded retries.
- Cancellation.
- Partial rerendering.
- Provider rate limiting.
- Cost tracking by project and provider.
- Structured logs.
- Metrics and traces.
- Error reporting with correlation IDs.
- Dead-letter handling for unrecoverable jobs.
- Cleanup policies that never delete the original source unexpectedly.

A provider outage must not corrupt the project or cause completed stages to be repeated unnecessarily.

## 16. Security, privacy and licensing

Implement:

- Secrets through environment variables or the deployment secret manager.
- Encryption in transit.
- Appropriate storage access controls.
- Signed or authenticated artifact access.
- Validation of uploaded file type and size.
- Malware scanning where supported.
- Webhook signature verification.
- Protection against path traversal, command injection and unsafe media arguments.
- Sandboxed media processing and rendering workers.
- Dependency and container scanning.
- Retention and deletion controls.
- Audit records for provider submissions and generated assets.
- Content-rights confirmation for uploaded soundtracks, avatars and voices.

Create a provider licensing matrix covering:

- API terms
- Commercial-use permission
- Generated-output rights
- Model restrictions
- Attribution requirements
- Redistribution restrictions
- Data retention
- Training-on-customer-data terms

Do not place Mirelo/MuScriptor noncommercial weights in the production commercial path without appropriate permission.

## 17. Testing and objective acceptance criteria

Build a legal, reproducible ground-truth test corpus containing:

- Isolated acoustic guitar
- Isolated electric guitar
- Isolated bass
- Isolated piano
- Isolated violin
- Isolated vocals
- Full-band mixes
- Slow and rapid chord changes
- Distortion and effects
- Alternate tunings
- Slides, bends, sustain, pizzicato and bow changes
- Silence, count-ins and tempo changes
- Short and long projects

Where possible, generate controlled audio from known MIDI and performance plans so the expected notes, chords and timing are exact. Supplement it with owned or properly licensed human recordings.

Measure:

- Stem separation completeness and bleed.
- Chord accuracy.
- Note precision, recall and F1.
- Onset and offset timing error.
- Tempo and beat alignment.
- Instrument identification.
- Audio/video drift.
- Correct visible key, string and fret contact.
- Impossible hand positions.
- Finger transition continuity.
- Bow/string contact.
- Lip-sync timing.
- Render success and recovery rate.
- Processing time and provider cost.

Minimum production acceptance requirements:

1. Every supported instrument completes an end-to-end upload-to-video test.
2. Final audio/video drift remains below one rendered frame.
3. The diagnostic validator finds no impossible hand positions in approved fixtures.
4. Piano fingers contact the scheduled keys.
5. Guitar and bass fingers contact the selected strings and fret regions.
6. Violin bow contact follows the selected string plan.
7. No generic fallback animation is presented as verified playing.
8. Low-confidence musical events remain traceable.
9. Provider failure and worker restart resume without project corruption.
10. No production secret appears in source, logs, fixtures or client bundles.
11. Every enabled commercial provider has documented licensing status.
12. All supported workflows are tested through the actual user interface and backend, not only as isolated unit tests.
13. The exported video uses the intended soundtrack and retains synchronization through the final frame.
14. The same input and settings produce the same Performance Plan.
15. A correction to one passage can trigger a partial regeneration without rerendering unrelated scenes.

Do not fabricate favorable thresholds or results. Report actual measured performance by instrument and test condition.

## 18. Product truth and user-facing language

Use precise claims.

Appropriate:

- “Musically synchronized avatar performance.”
- “Note-driven instrument animation.”
- “Physically playable inferred fingering.”
- “Reference-video-guided performance.”
- “Confidence and correction tools included.”

Do not claim “the exact original fingering” from audio alone unless reference video or other evidence establishes it.

The application should explain:

> Audio can identify the music being performed, but some instruments allow the same sound to be produced in more than one physical way. When the original movement is not observable, IPlay selects a physically valid, musically faithful performance.

This limitation must not become an excuse for generic movement. The chosen performance must still be playable, synchronized and internally consistent.

## 19. Required implementation sequence

Execute in this order:

1. Repository and purpose audit.
2. Current end-to-end baseline and failure inventory.
3. Canonical Musical Timeline.
4. Provider interfaces and secure configuration.
5. Media ingestion and job orchestration.
6. Music.AI stem-separation adapter.
7. Klangio transcription adapter.
8. Independent verification adapter.
9. Performance Compiler foundation.
10. Piano solver and Blender proof of deterministic contact.
11. Guitar solver.
12. Bass solver.
13. Violin solver.
14. Acoustic/electric technique differentiation.
15. Correction interface.
16. Preview and partial-rerender workflow.
17. Final Blender renderer.
18. ACE vocal-provider boundary and authorized integration.
19. Unreal/MetaHuman premium renderer.
20. Full regression, security, performance and recovery testing.
21. Deployment, migration and operational documentation.
22. Final exact-commit evidence report.

Do not begin with visual polish while the musical and physical pipeline remains unproven.

## 20. Required deliverables

Produce and commit:

- Working implementation.
- Architecture decision records.
- Provider interface documentation.
- Canonical data-model documentation.
- Instrument-definition specification.
- Music.AI adapter.
- Klangio adapter.
- Verification adapter.
- Blender animation/render adapter.
- Unreal/MetaHuman adapter or clearly separated optional module.
- ACE vocal adapter or provider-ready boundary if official access is unavailable.
- Piano, acoustic guitar, electric guitar, bass and violin solvers.
- Migration scripts.
- Configuration examples without secrets.
- Automated tests.
- Ground-truth fixture manifest.
- Measured accuracy and synchronization report.
- Licensing matrix.
- Threat model.
- Operational runbook.
- Deployment and rollback instructions.
- User documentation.
- A final evidence matrix mapping every requirement to code, tests and artifacts on the exact final commit.

If an external provider cannot be activated because credentials or contractual access are unavailable, finish its production-grade adapter, contract tests, configuration, failure states and documentation. Mark only the live credentialed validation as pending; do not describe the integration itself as live until it has actually processed a real authorized request.

## Definition of done

IPlay is complete for this assignment only when a user can:

1. Upload an owned or authorized soundtrack.
2. Select acoustic guitar, electric guitar, bass, piano or violin.
3. Have the soundtrack separated and transcribed.
4. Inspect and correct recognized musical events.
5. Generate a physically playable instrument-performance plan.
6. Preview the avatar contacting the correct keys, strings and fret regions.
7. Render a synchronized performance video.
8. Preserve synchronization through the final frame.
9. Resume a failed job without starting over.
10. Add a future instrument through a new `InstrumentDefinition` and solver plugin rather than rewriting the application.
11. Add or transform vocals through the authorized vocal-provider pathway.
12. See honest provenance and confidence for inferred musical and physical choices.

Continue until these capabilities are implemented, tested and supported by reproducible evidence. Do not substitute documentation, placeholders, generic avatar motion or self-certification for working behavior.