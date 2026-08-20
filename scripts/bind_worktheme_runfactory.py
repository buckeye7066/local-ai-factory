#!/usr/bin/env python3
"""Bind createWorkTheme/withWorkTheme onto runFactory entrypoints (main → directed)."""
from __future__ import annotations

from pathlib import Path

TARGET = Path("src/server/orchestrator/runFactory.ts")

IMPORT = 'import { createWorkTheme, withWorkTheme } from "./workTheme.js";\n'
ANCHOR = 'import { ingestAdditionalSource } from "./ingestAdditionalSource.js";\n'

CONSTRAINTS = """[
      "Never treat node_modules/, dist/, build/, .next/, out/, or coverage/ as the fix target — edit the source that produced them.",
      "Stay on this program's verified failure; do not invent unrelated refactors.",
    ]"""


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")
    head = text.lstrip()[:80]
    if head.startswith("@file:") or "PLACEHOLDER_RESTORE" in head:
        raise SystemExit("runFactory.ts still looks like a stub")

    if "createWorkTheme" not in text:
        if ANCHOR not in text:
            raise SystemExit("import anchor missing")
        text = text.replace(ANCHOR, ANCHOR + IMPORT, 1)

    if "withWorkTheme(theme," in text:
        TARGET.write_text(text, encoding="utf-8")
        print(f"already bound ({len(text)} bytes)")
        return

    replacements: list[tuple[str, str]] = [
        (
            """  void executeRun(prepared.run, prepared.args, prepared.checkpoint).catch(async (err) => {
    await restoreFailedResume(prepared.run, err).catch(() => {});
  });
  return prepared.run;
}""",
            f"""  const theme = createWorkTheme({{
    idea: prepared.args.idea,
    appName: prepared.run.appName,
    stage: prepared.args.options.mode === \"extend\" ? \"extend\" : \"build\",
    constraints: {CONSTRAINTS},
  }});
  void withWorkTheme(theme, () =>
    executeRun(prepared.run, prepared.args, prepared.checkpoint),
  ).catch(async (err) => {{
    await restoreFailedResume(prepared.run, err).catch(() => {{}});
  }});
  return prepared.run;
}}""",
        ),
        (
            """export async function resumeFactory(
  runId: string,
  config: AppConfig,
  secrets: AppSecrets,
): Promise<RunRecord> {
  const prepared = await prepareResume(runId, config, secrets);
  try {
    await executeRun(prepared.run, prepared.args, prepared.checkpoint);
  } catch (err) {
    await restoreFailedResume(prepared.run, err);
    throw err;
  }
  return prepared.run;
}""",
            f"""export async function resumeFactory(
  runId: string,
  config: AppConfig,
  secrets: AppSecrets,
): Promise<RunRecord> {{
  const prepared = await prepareResume(runId, config, secrets);
  const theme = createWorkTheme({{
    idea: prepared.args.idea,
    appName: prepared.run.appName,
    stage: prepared.args.options.mode === \"extend\" ? \"extend\" : \"build\",
    constraints: {CONSTRAINTS},
  }});
  try {{
    await withWorkTheme(theme, () =>
      executeRun(prepared.run, prepared.args, prepared.checkpoint),
    );
  }} catch (err) {{
    await restoreFailedResume(prepared.run, err);
    throw err;
  }}
  return prepared.run;
}}""",
        ),
        (
            """export function startRun(args: StartRunArgs): RunRecord {
  const run = createRecord(args);
  putRunInMemory(run);
  void appendAuditEvent({ type: \"run.queued\", runId: run.id });
  void saveRun(run).then(() => executeRun(run, args));
  return run;
}""",
            f"""export function startRun(args: StartRunArgs): RunRecord {{
  const run = createRecord(args);
  putRunInMemory(run);
  void appendAuditEvent({{ type: \"run.queued\", runId: run.id }});
  const theme = createWorkTheme({{
    idea: args.idea,
    stage: args.options.mode === \"extend\" ? \"extend\" : \"build\",
    constraints: {CONSTRAINTS},
  }});
  void saveRun(run).then(() => withWorkTheme(theme, () => executeRun(run, args)));
  return run;
}}""",
        ),
        (
            """export async function runFactory(args: StartRunArgs): Promise<RunRecord> {
  const run = createRecord(args);
  await appendAuditEvent({ type: \"run.queued\", runId: run.id });
  await saveRun(run);
  await executeRun(run, args);
  return run;
}""",
            f"""export async function runFactory(args: StartRunArgs): Promise<RunRecord> {{
  const theme = createWorkTheme({{
    idea: args.idea,
    stage: args.options.mode === \"extend\" ? \"extend\" : \"build\",
    constraints: {CONSTRAINTS},
  }});
  return withWorkTheme(theme, async () => {{
    const run = createRecord(args);
    await appendAuditEvent({{ type: \"run.queued\", runId: run.id }});
    await saveRun(run);
    await executeRun(run, args);
    return run;
  }});
}}""",
        ),
        (
            """export async function runFactoryTracked(
  args: StartRunArgs,
  onCreated: (run: RunRecord) => void | Promise<void>,
): Promise<RunRecord> {
  const run = createRecord(args);
  await appendAuditEvent({ type: \"run.queued\", runId: run.id });
  await saveRun(run);
  await onCreated(run);
  await executeRun(run, args);
  return run;
}""",
            f"""export async function runFactoryTracked(
  args: StartRunArgs,
  onCreated: (run: RunRecord) => void | Promise<void>,
): Promise<RunRecord> {{
  const theme = createWorkTheme({{
    idea: args.idea,
    stage: args.options.mode === \"extend\" ? \"extend\" : \"build\",
    constraints: {CONSTRAINTS},
  }});
  return withWorkTheme(theme, async () => {{
    const run = createRecord(args);
    await appendAuditEvent({{ type: \"run.queued\", runId: run.id }});
    await saveRun(run);
    await onCreated(run);
    await executeRun(run, args);
    return run;
  }});
}}""",
        ),
    ]

    for old, new in replacements:
        if old not in text:
            raise SystemExit(f"pattern not found:\n{old[:120]}...")
        text = text.replace(old, new, 1)

    if "withWorkTheme" not in text or "createWorkTheme" not in text:
        raise SystemExit("WorkTheme bind missing after patch")
    if text.lstrip().startswith("@file:"):
        raise SystemExit("still starts with @file:")

    TARGET.write_text(text, encoding="utf-8")
    print(f"restored+bound runFactory.ts ({len(text)} bytes)")


if __name__ == "__main__":
    main()
