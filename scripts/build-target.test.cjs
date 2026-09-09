'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, options } = require('./build-target.cjs');
const config = require('./build-targets.json');
test('auto selects host capability without confusing build host with recipient', () => {
  for (const host of ['win32', 'darwin', 'linux']) {
    const target = config.defaults[host];
    if (config.targets[target]) assert.equal(plan(host).target, target);
    else assert.throws(() => plan(host), /does not provide target/);
  }
});
test('explicit targets respect supported host restrictions', () => {
  for (const [target, entry] of Object.entries(config.targets)) {
    for (const host of ['win32', 'darwin', 'linux']) {
      if (entry.hosts && !entry.hosts.includes(host)) assert.throws(() => plan(host, target), /requires a/);
      else {
        const selected = plan(host, target);
        assert.equal(selected.target, target);
        assert.equal(selected.format, entry.format);
        assert.ok(selected.commands.length);
        assert.ok(selected.commands.every(x => !x.args.some(a => /install|deploy|publish/.test(a) && a !== 'package:installer')));
      }
    }
  }
});
test('host simulation cannot override actual execution and invalid flags fail closed', () => {
  assert.throws(() => options(['--host', 'win32']), /dry-run/);
  assert.equal(options(['--host', 'darwin', '--dry-run']).host, 'darwin');
  assert.equal(options(['--target', 'android']).target, 'android');
  assert.throws(() => options(['--target']), /requires a value/);
  assert.throws(() => options(['--unknown']), /Unknown argument/);
  assert.throws(() => plan('plan9', 'web'), /Unsupported build host/);
  assert.throws(() => plan('win32', 'fake'), /does not provide target/);
});
test('Apple targets never return Windows installers or Android APKs', () => {
  for (const target of ['ios', 'macos', 'safari']) {
    if (config.targets[target]) assert.equal(plan('win32', target).format, 'web');
    else assert.throws(() => plan('win32', target), /does not provide target/);
  }
});
