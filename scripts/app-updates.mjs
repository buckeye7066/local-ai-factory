import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startAppUpdates, usableUpdate } from './app-updates-client.mjs';

const css = '.app-release-update{position:fixed;z-index:2147483000;inset:auto 1rem max(1rem,env(safe-area-inset-bottom)) auto;max-width:min(34rem,calc(100vw - 2rem));display:flex;flex-wrap:wrap;align-items:center;gap:.65rem;padding:1rem;background:#13283c;color:#fff;border:1px solid #6b92b6;border-radius:.75rem;box-shadow:0 6px 24px #0005;font:15px/1.4 system-ui,sans-serif}.app-release-update button{cursor:pointer;font:inherit;border:1px solid #b6d2eb;border-radius:.4rem;padding:.4rem .8rem;background:#fff;color:#13283c}.app-release-update button:disabled{opacity:.65;cursor:wait}.app-release-update button:focus-visible{outline:3px solid #78c8ff;outline-offset:3px}.app-release-update [hidden]{display:none}';

/** Vite build adapter; nothing runs in development or on the application server. */
export default function appUpdates({ app }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(app)) throw new Error('A stable app identifier is required');
  let config;
  let manifest;
  let clientName;
  let cssName;
  const bundleVersion = `1.0.${Date.now()}`;
  return {
    name: 'app-release-updates',
    apply: 'build',
    config() { return { define: { 'import.meta.env.VITE_APP_UPDATE_VERSION': JSON.stringify(bundleVersion) } }; },
    configResolved(value) { config = value; },
    buildStart() {
      let revision = process.env.VERCEL_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '';
      if (!revision) {
        try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
        catch { revision = ''; }
      }
      // A fresh identity also covers rebuilding the same commit with new config.
      // It is embedded in both the running client and the deployed manifest.
      manifest = { schema: 1, app, build: randomUUID(), builtAt: new Date().toISOString(), bundleVersion, revision: /^[a-f0-9]{40,64}$/i.test(revision) ? revision : null };
      clientName = `app-update-${manifest.build}.js`;
      cssName = `app-update-${manifest.build}.css`;
    },
    transformIndexHtml: {
      order: 'post',
      handler() {
        const base = config.base.endsWith('/') ? config.base : `${config.base}/`;
        return [
          { tag: 'link', attrs: { rel: 'stylesheet', href: `${base}${cssName}` }, injectTo: 'head' },
          { tag: 'script', attrs: { defer: true, src: `${base}${clientName}` }, injectTo: 'head' },
        ];
      },
    },
    generateBundle(_options, bundle = {}) {
      manifest.assets = [
        {path: clientName, kind: 'script'}, {path: cssName, kind: 'style'},
        ...Object.values(bundle).filter((asset) => /\.(?:m?js|css)$/.test(asset.fileName)).map((asset) => ({path: asset.fileName, kind: asset.fileName.endsWith('.css') ? 'style' : 'script'})),
      ];
      this.emitFile({ type: 'asset', fileName: 'app-update.json', source: JSON.stringify(manifest) });
      this.emitFile({ type: 'asset', fileName: clientName, source: `(${startAppUpdates.toString()})(${JSON.stringify(manifest)}, ${usableUpdate.toString()});` });
      this.emitFile({ type: 'asset', fileName: cssName, source: css });
    },
    async closeBundle() {
      if (!manifest || !config) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      for (const name of ['sw.js', 'service-worker.js']) {
        const filename = path.join(outDir, name);
        let source;
        try { source = await readFile(filename, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        source += `\n// App release ${manifest.build}\nself.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));\nself.addEventListener('message', (event) => { if (event.data && event.data.type === 'APP_UPDATE_ACTIVATE') self.skipWaiting(); });\n`;
        await writeFile(filename, source);
      }
    },
  };
}
