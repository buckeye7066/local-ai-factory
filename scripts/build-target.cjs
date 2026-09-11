#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./build-targets.json');
const ROOT = path.resolve(__dirname, '..');
const HOSTS = ['win32', 'darwin', 'linux'];
const ALIASES = { win32: 'windows', win: 'windows', darwin: 'macos', mac: 'macos', iphone: 'ios', ipad: 'ios' };
function plan(host = process.platform, requested = 'auto') {
  if (!HOSTS.includes(host)) throw Error('Unsupported build host: ' + host + '. Use Windows, macOS, or Linux.');
  requested = ALIASES[requested] || requested;
  const target = requested === 'auto' ? config.defaults[host] : requested;
  const entry = config.targets[target];
  if (!entry) throw Error(config.name + ' does not provide target "' + target + '". ' + config.guidance);
  if (entry.hosts && !entry.hosts.includes(host)) {
    throw Error(target + ' requires a ' + entry.hosts.join(' or ') + ' build host. ' + config.guidance);
  }
  return { app: config.name, host, requested, target, format: entry.format,
    output: entry.output, notice: entry.notice,
    commands: entry.commands.map(step => ({ ...step, args: [...step.args] })) };
}
// Owner order: no dry-run or simulation modes in owner tooling. Naming a removed
// flag fails; it is never ignored. The build plan is printed before every real
// build, and tests simulate hosts through plan() directly.
const REMOVED_FLAGS = new Set(['--dry-run', '--host']);
function options(args) {
  const result = { target: 'auto', host: process.platform };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = arg.split('=')[0];
    if (REMOVED_FLAGS.has(flag)) {
      throw Error(flag + ' was removed: build:smart has no dry-run or host-simulation mode. Every run builds for this machine.');
    } else if (arg === '--help') result.help = true;
    else if (arg === '--target') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(arg + ' requires a value.');
      result.target = args[++i].toLowerCase();
    } else throw Error('Unknown argument: ' + arg);
  }
  return result;
}
function main(args) {
  const opts = options(args);
  if (opts.help) {
    console.log('Usage: node scripts/build-target.cjs [--target auto|' + Object.keys(config.targets).join('|') + ']');
    console.log('Auto detects the build host. --target selects the recipient device explicitly. The selected plan is printed, then built.');
    console.log(config.guidance);
    return;
  }
  const selected = plan(opts.host, opts.target);
  console.log(JSON.stringify(selected, null, 2));
  for (const step of selected.commands) {
    const cwd = path.resolve(ROOT, step.cwd || '.');
    let command = step.command, args = step.args;
    if (command === 'gradle') {
      command = process.platform === 'win32' ? 'cmd.exe' : 'bash';
      args = process.platform === 'win32' ? ['/d', '/s', '/c', 'gradlew.bat ' + args.join(' ')] : ['gradlew', ...args];
    } else if (command === 'npm' && process.platform === 'win32') {
      // All arguments come from the reviewed manifest, never user input.
      command = 'cmd.exe';
      args = ['/d', '/s', '/c', 'npm ' + args.join(' ')];
    }
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw Error('Build failed at ' + step.command + ': ' + (result.error?.message || result.status));
  }
  console.log('Build complete: ' + selected.output + '. No installation, upload, or deployment was performed.');
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { plan, options };
