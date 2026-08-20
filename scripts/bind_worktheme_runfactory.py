#!/usr/bin/env python3
# Bind WorkTheme wraps onto runFactory.ts (restored from main).
# No double-quote chars in this source (MCP/JSON-safe).
from __future__ import annotations

from pathlib import Path

DQ = chr(34)
TARGET = Path('src/server/orchestrator/runFactory.ts')
IMPORT = 'import { createWorkTheme, withWorkTheme } from ' + DQ + './workTheme.js' + DQ + ';\n'
ANCHOR = (
    'import { ingestAdditionalSource } from '
    + DQ
    + './ingestAdditionalSource.js'
    + DQ
    + ';\n'
)
C1 = (
    'Never treat node_modules/, dist/, build/, .next/, out/, or coverage/ '
    'as the fix target — edit the source that produced them.'
)
C2 = 'Stay on this program' + chr(39) + 's verified failure; do not invent unrelated refactors.'


def q(s):
    return DQ + s + DQ


def theme_block(indent, with_app):
    app = ('\n' + indent + '  appName: prepared.run.appName,') if with_app else ''
    idea = 'prepared.args.idea' if with_app else 'args.idea'
    stage_src = 'prepared.args.options' if with_app else 'args.options'
    return (
        indent
        + 'const theme = createWorkTheme({\n'
        + indent
        + '  idea: '
        + idea
        + ','
        + app
        + '\n'
        + indent
        + '  stage: '
        + stage_src
        + '.mode === '
        + q('extend')
        + ' ? '
        + q('extend')
        + ' : '
        + q('build')
        + ',\n'
        + indent
        + '  constraints: [\n'
        + indent
        + '    '
        + q(C1)
        + ',\n'
        + indent
        + '    '
        + q(C2)
        + ',\n'
        + indent
        + '  ],\n'
        + indent
        + '});\n'
    )


def main():
    text = TARGET.read_text(encoding='utf-8')
    head = text.lstrip()[:80]
    if head.startswith('@file:') or 'PLACEHOLDER_RESTORE' in head:
        raise SystemExit('runFactory.ts still looks like a stub')

    if 'createWorkTheme' not in text:
        if ANCHOR not in text:
            raise SystemExit('import anchor missing')
        text = text.replace(ANCHOR, ANCHOR + IMPORT, 1)

    if 'withWorkTheme(theme,' in text:
        TARGET.write_text(text, encoding='utf-8')
        print('already bound')
        return

    old = (
        '  void executeRun(prepared.run, prepared.args, prepared.checkpoint)'
        '.catch(async (err) => {\n'
        '    await restoreFailedResume(prepared.run, err).catch(() => {});\n'
        '  });\n'
        '  return prepared.run;\n'
        '}'
    )
    new = (
        theme_block('  ', True)
        + '  void withWorkTheme(theme, () =>\n'
        + '    executeRun(prepared.run, prepared.args, prepared.checkpoint),\n'
        + '  ).catch(async (err) => {\n'
        + '    await restoreFailedResume(prepared.run, err).catch(() => {});\n'
        + '  });\n'
        + '  return prepared.run;\n'
        + '}'
    )
    if old not in text:
        raise SystemExit('resumeRun executeRun pattern missing')
    text = text.replace(old, new, 1)

    old = (
        '  const prepared = await prepareResume(runId, config, secrets);\n'
        '  try {\n'
        '    await executeRun(prepared.run, prepared.args, prepared.checkpoint);\n'
        '  } catch (err) {\n'
        '    await restoreFailedResume(prepared.run, err);\n'
        '    throw err;\n'
        '  }\n'
        '  return prepared.run;\n'
        '}'
    )
    new = (
        '  const prepared = await prepareResume(runId, config, secrets);\n'
        + theme_block('  ', True)
        + '  try {\n'
        + '    await withWorkTheme(theme, () =>\n'
        + '      executeRun(prepared.run, prepared.args, prepared.checkpoint),\n'
        + '    );\n'
        + '  } catch (err) {\n'
        + '    await restoreFailedResume(prepared.run, err);\n'
        + '    throw err;\n'
        + '  }\n'
        + '  return prepared.run;\n'
        + '}'
    )
    if old not in text:
        raise SystemExit('resumeFactory body pattern missing')
    text = text.replace(old, new, 1)

    queued = q('run.queued')
    old = (
        '  void appendAuditEvent({ type: '
        + queued
        + ', runId: run.id });\n'
        + '  void saveRun(run).then(() => executeRun(run, args));\n'
        + '  return run;\n'
        + '}'
    )
    new = (
        '  void appendAuditEvent({ type: '
        + queued
        + ', runId: run.id });\n'
        + theme_block('  ', False)
        + '  void saveRun(run).then(() => withWorkTheme(theme, () => executeRun(run, args)));\n'
        + '  return run;\n'
        + '}'
    )
    if old not in text:
        raise SystemExit('startRun body pattern missing')
    text = text.replace(old, new, 1)

    old = (
        'export async function runFactory(args: StartRunArgs): Promise<RunRecord> {\n'
        + '  const run = createRecord(args);\n'
        + '  await appendAuditEvent({ type: '
        + queued
        + ', runId: run.id });\n'
        + '  await saveRun(run);\n'
        + '  await executeRun(run, args);\n'
        + '  return run;\n'
        + '}'
    )
    new = (
        'export async function runFactory(args: StartRunArgs): Promise<RunRecord> {\n'
        + theme_block('  ', False)
        + '  return withWorkTheme(theme, async () => {\n'
        + '    const run = createRecord(args);\n'
        + '    await appendAuditEvent({ type: '
        + queued
        + ', runId: run.id });\n'
        + '    await saveRun(run);\n'
        + '    await executeRun(run, args);\n'
        + '    return run;\n'
        + '  });\n'
        + '}'
    )
    if old not in text:
        raise SystemExit('runFactory body pattern missing')
    text = text.replace(old, new, 1)

    old = (
        'export async function runFactoryTracked(\n'
        + '  args: StartRunArgs,\n'
        + '  onCreated: (run: RunRecord) => void | Promise<void>,\n'
        + '): Promise<RunRecord> {\n'
        + '  const run = createRecord(args);\n'
        + '  await appendAuditEvent({ type: '
        + queued
        + ', runId: run.id });\n'
        + '  await saveRun(run);\n'
        + '  await onCreated(run);\n'
        + '  await executeRun(run, args);\n'
        + '  return run;\n'
        + '}'
    )
    new = (
        'export async function runFactoryTracked(\n'
        + '  args: StartRunArgs,\n'
        + '  onCreated: (run: RunRecord) => void | Promise<void>,\n'
        + '): Promise<RunRecord> {\n'
        + theme_block('  ', False)
        + '  return withWorkTheme(theme, async () => {\n'
        + '    const run = createRecord(args);\n'
        + '    await appendAuditEvent({ type: '
        + queued
        + ', runId: run.id });\n'
        + '    await saveRun(run);\n'
        + '    await onCreated(run);\n'
        + '    await executeRun(run, args);\n'
        + '    return run;\n'
        + '  });\n'
        + '}'
    )
    if old not in text:
        raise SystemExit('runFactoryTracked body pattern missing')
    text = text.replace(old, new, 1)

    if 'withWorkTheme' not in text:
        raise SystemExit('bind failed')
    TARGET.write_text(text, encoding='utf-8')
    print('bound ok', len(text))


if __name__ == '__main__':
    main()
