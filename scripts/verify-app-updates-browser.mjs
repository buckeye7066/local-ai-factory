import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium, webkit } = await import(process.env.APP_UPDATE_BROWSER_DEPS ? pathToFileURL(path.join(process.env.APP_UPDATE_BROWSER_DEPS, 'node_modules/playwright/index.mjs')).href : 'playwright');
const browserType = process.env.APP_UPDATE_BROWSER === 'webkit' ? webkit : chromium;
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import appUpdates from './app-updates.mjs';

async function release() {
  const root = await mkdtemp(path.join(tmpdir(), 'update-browser-'));
  const plugin = appUpdates({ app: 'browser-test' });
  plugin.configResolved({ root, base: '/', build: { outDir: 'dist' } });
  plugin.buildStart();
  const files = new Map();
  plugin.generateBundle.call({ emitFile: ({ fileName, source }) => files.set(`/${fileName}`, source) });
  const manifest = JSON.parse(files.get('/app-update.json'));
  files.set('/index.html', `<!doctype html><html><head><script defer src="/app-update-${manifest.build}.js"></script></head><body><h1>${manifest.build}</h1><input id="work"><script>navigator.serviceWorker.register('/sw.js');</script></body></html>`);
  files.set('/sw.js', `const CACHE='shell-${manifest.build}';self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.add('/index.html'))));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/'||new URL(e.request.url).pathname==='/index.html')e.respondWith(caches.open(CACHE).then(c=>c.match('/index.html')))});`);
  try {
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist/sw.js'), files.get('/sw.js'));
    await plugin.closeBundle();
    files.set('/sw.js', await readFile(path.join(root, 'dist/sw.js'), 'utf8'));
  } finally { await rm(root, {recursive:true,force:true}); }
  return { files, manifest };
}
const originalRelease = await release();
let active = originalRelease;
let missingAsset = false;
const first = active.manifest.build;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const content = missingAsset && pathname.endsWith('.js') ? undefined : active.files.get(pathname);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.css') ? 'text/css' : 'text/html');
  res.writeHead(content ? 200 : 404);
  res.end(content || 'missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await browserType.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => localStorage.setItem('saved-profile', 'preserve-me'));
  assert.equal(await page.locator('.app-release-update').count(), 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  active = await release();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Update', exact: true }).waitFor();
  assert.equal(await page.locator('h1').textContent(), first, 'notification must not reload automatically');
  await page.evaluate(() => window.addEventListener('app-update:before-apply', event => event.preventDefault(), { once: true }));
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  assert.equal(await page.locator('h1').textContent(), first, 'app can defer while work is unsaved');
  missingAsset = true;
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText(/not reachable yet/).waitFor();
  assert.equal(await page.locator('h1').textContent(), first, 'missing new assets must retain the working page');
  missingAsset = false;
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText(/not reachable yet/).waitFor();
  assert.equal(await page.locator('h1').textContent(), first);
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.getByRole('button', { name: 'Update available', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Update available', exact: true }).click();
  await page.waitForFunction((build) => document.querySelector('h1')?.textContent === build, active.manifest.build, { timeout: 20000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('saved-profile')), 'preserve-me');
  assert.equal(await page.locator('.app-release-update').count(), 0);
  active = originalRelease;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.waitForFunction((build) => document.querySelector('h1')?.textContent === build, first, {timeout:20000});
  assert.equal(await page.evaluate(() => localStorage.getItem('saved-profile')), 'preserve-me');
  console.log('PASS: old installed shell detects release, waits for click, retries offline, activates new worker, preserves saved data.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
