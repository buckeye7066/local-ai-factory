import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import appUpdates from './app-updates.mjs';
import { usableUpdate } from './app-updates-client.mjs';

const current = { app: 'example', build: 'old-123', builtAt: '2026-09-01T00:00:00.000Z' };
const newer = { schema: 1, app: 'example', build: 'new-456', builtAt: '2026-09-02T00:00:00.000Z' };

test('detects a new deployed build without requiring a package version bump', () => {
  assert.equal(usableUpdate(newer, current), true);
  assert.equal(usableUpdate({ ...newer, build: current.build }, current), false);
});

test('ignores malformed, foreign and future-schema feeds; permits deployed rollbacks', () => {
  for (const value of [null, {}, { ...newer, schema: 2 }, { ...newer, app: 'another-app' },
    { ...newer, build: '../../evil' }, { ...newer, builtAt: 'invalid' }]) {
    assert.equal(usableUpdate(value, current), false);
  }
  assert.equal(usableUpdate({ ...newer, builtAt: '2026-08-01T00:00:00.000Z' }, current), true);
});

test('emits a matching client, HTML reference, and version feed under a subpath', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-update-build-'));
  try {
    const plugin = appUpdates({ app: 'example' });
    plugin.configResolved({ command: 'build', base: '/family/', root, build: { outDir: 'dist' } });
    plugin.buildStart();
    const files = [];
    plugin.generateBundle.call({ emitFile: (file) => files.push(file) });
    const manifest = JSON.parse(files.find((file) => file.fileName === 'app-update.json').source);
    assert.equal(JSON.parse(plugin.config().define['import.meta.env.VITE_APP_UPDATE_VERSION']), manifest.bundleVersion);
    assert.match(manifest.bundleVersion, /^1\.0\.\d{13}$/);
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.app, 'example');
    assert.ok(Date.parse(manifest.builtAt));
    const client = files.find((file) => file.fileName.endsWith('.js'));
    const tags = plugin.transformIndexHtml.handler();
    assert.equal(tags.find((tag) => tag.tag === 'script').attrs.src, `/family/${client.fileName}`);
    assert.ok(client.source.includes(manifest.build));
    assert.ok(files.some((file) => file.fileName.endsWith('.css')));
    const second = appUpdates({ app: 'example' });
    second.configResolved({ command: 'build', base: '/', root, build: { outDir: 'dist' } });
    second.buildStart();
    const nextFiles = [];
    second.generateBundle.call({ emitFile: (file) => nextFiles.push(file) });
    assert.notEqual(JSON.parse(nextFiles.find((file) => file.fileName === 'app-update.json').source).build, manifest.build);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('adds user-controlled worker activation without changing application caches or data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-update-worker-'));
  try {
    await mkdir(path.join(root, 'dist'));
    const original = "self.addEventListener('fetch', () => {});\n";
    await writeFile(path.join(root, 'dist/sw.js'), original);
    const plugin = appUpdates({ app: 'example' });
    plugin.configResolved({ command: 'build', base: '/', root, build: { outDir: 'dist' } });
    plugin.buildStart();
    await plugin.closeBundle();
    const worker = await readFile(path.join(root, 'dist/sw.js'), 'utf8');
    const callbacks = new Map();
    let activations = 0;
    const self = { addEventListener: (event, fn) => callbacks.set(event, fn), skipWaiting: () => { activations += 1; } };
    Function('self', worker)(self);
    assert.ok(callbacks.has('fetch'));
    callbacks.get('message')({ data: { type: 'UNRELATED' } });
    assert.equal(activations, 0);
    callbacks.get('message')({ data: { type: 'APP_UPDATE_ACTIVATE' } });
    assert.equal(activations, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
