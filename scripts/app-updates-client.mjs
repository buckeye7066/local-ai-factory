/* global location, window, document, navigator, AbortController, localStorage, Notification, CustomEvent, DOMParser, fetch, setInterval, setTimeout, clearTimeout */
/** Shared wire validation. Package versions are deliberately not release identity. */
export function usableUpdate(value, current) {
  return Boolean(value && value.schema === 1 && value.app === current.app
    && typeof value.build === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value.build)
    && value.build !== current.build && Number.isFinite(Date.parse(value.builtAt)));
}

/** Runs as a standalone script so every app framework gets the same behavior. */
export function startAppUpdates(current, usableUpdate) {
  if (!/^https?:$/.test(location.protocol) || window.Capacitor?.isNativePlatform?.()) return;
  const scriptUrl = document.currentScript?.src;
  if (!scriptUrl || new URL(scriptUrl).origin !== location.origin) return;
  const feedUrl = new URL('app-update.json', scriptUrl);
  const shellUrl = new URL('index.html', scriptUrl);
  let available = null;
  let busy = false;
  let applying = false;
  let banner;
  let message;
  let updateButton;
  let laterButton;

  async function request(url, type) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok || (response.url && new URL(response.url).origin !== location.origin)) throw new Error('Unavailable');
      if (type === 'script' && !/(?:java|ecma)script/i.test(response.headers.get('content-type') || '')) throw new Error('Script unavailable');
      if (type === 'style' && !/text\/css/i.test(response.headers.get('content-type') || '')) throw new Error('Styles unavailable');
      if (type === 'json') return await response.json();
      const text = await response.text();
      if (['script', 'style'].includes(type) && !text.trim()) throw new Error('Empty asset');
      return text;
    } finally { clearTimeout(timer); }
  }

  async function readDeployed() {
    const url = new URL(feedUrl);
    url.searchParams.set('_check', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return request(url, 'json');
  }

  async function verifyAssets(html, release) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const assets = new Map();
    for (const node of parsed.querySelectorAll('script[src],link[rel=stylesheet],link[rel=modulepreload]')) {
      const raw = node.getAttribute('src') || node.getAttribute('href');
      const url = new URL(raw, shellUrl);
      if (url.origin !== location.origin) continue;
      assets.set(url.href, node.getAttribute('rel') === 'stylesheet' ? 'style' : 'script');
    }
    for (const asset of release.assets || []) {
      if (!asset || !['script', 'style'].includes(asset.kind) || typeof asset.path !== 'string') throw new Error('Invalid assets');
      const url = new URL(asset.path, scriptUrl);
      if (url.origin !== location.origin) throw new Error('Invalid asset origin');
      assets.set(url.href, asset.kind);
    }
    const queue = [...assets];
    await Promise.all(Array.from({length: Math.min(4, queue.length)}, async () => {
      while (queue.length) {
        const [url, kind] = queue.shift();
        await request(url, kind);
      }
    }));
  }

  function showUpdate() {
    if (!banner) {
      banner = document.createElement('section');
      banner.className = 'app-release-update';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.setAttribute('aria-label', 'Application update');
      message = document.createElement('span');
      message.textContent = 'An update is available. Save your work, then update.';
      updateButton = document.createElement('button');
      updateButton.type = 'button';
      updateButton.textContent = 'Update';
      updateButton.addEventListener('click', apply);
      laterButton = document.createElement('button');
      laterButton.type = 'button';
      laterButton.textContent = 'Later';
      laterButton.addEventListener('click', () => {
        message.hidden = true;
        laterButton.hidden = true;
        updateButton.textContent = 'Update available';
      });
      banner.append(message, updateButton, laterButton);
      document.body.append(banner);
    }
    // A permission already granted to this app can provide a system notice too.
    // The in-app path always works without requesting notification permission.
    try {
      const key = `app-update-notified:${current.app}`;
      if (window.Notification?.permission === 'granted' && localStorage.getItem(key) !== available.build) {
        localStorage.setItem(key, available.build);
        const notification = new Notification('An app update is available', { body: 'Open the app and choose Update.', tag: key });
        notification.onclick = () => { window.focus(); notification.close(); };
      }
    } catch { /* Storage or notification restrictions never block the update button. */ }
  }

  async function check() {
    if (busy || applying || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    busy = true;
    try {
      const value = await readDeployed();
      if (usableUpdate(value, current)) {
        available = value;
        showUpdate();
      } else if (value?.schema === 1 && value.app === current.app && value.build === current.build) {
        available = null;
        banner?.remove();
        banner = null;
      }
    } catch { /* Keep the working app available offline; retry on resume/online/interval. */ }
    finally { busy = false; }
  }

  function waitForWorker(worker, states = ['installed', 'activated', 'redundant']) {
    if (!worker || states.includes(worker.state)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, 5000);
      function done() { clearTimeout(timer); worker.removeEventListener('statechange', changed); resolve(); }
      function changed() { if (states.includes(worker.state)) done(); }
      worker.addEventListener('statechange', changed);
    });
  }

  async function activateWorker() {
    if (!navigator.serviceWorker) return;
    const registration = await navigator.serviceWorker.getRegistration(location.href);
    if (!registration || registration.scope !== new URL('./', scriptUrl).href) return;
    await Promise.race([registration.update().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    await waitForWorker(registration.installing);
    if (!registration.waiting) return;
    const worker = registration.waiting;
    worker.postMessage({ type: 'APP_UPDATE_ACTIVATE' });
    await waitForWorker(worker, ['activated', 'redundant']);
    if (registration.waiting === worker && worker.state !== 'activated') {
      // A legacy worker that cannot activate must not strand this page behind
      // an unregistered controller. Keep the installation intact for retry.
      throw new Error('Close and reopen the app to finish this legacy update');
    }
  }

  async function apply() {
    if (!available || applying) return;
    if (!window.dispatchEvent(new CustomEvent('app-update:before-apply', { cancelable: true, detail: available }))) return;
    applying = true;
    const startedAtUrl = location.href;
    let workChanged = false;
    const observeWork = (event) => { if (!banner?.contains(event.target)) workChanged = true; };
    document.addEventListener('input', observeWork, true);
    document.addEventListener('pointerdown', observeWork, true);
    updateButton.disabled = true;
    message.hidden = false;
    message.textContent = 'Checking that the update is ready…';
    try {
      if (navigator.onLine === false) throw new Error('Offline');
      // A cache-first worker can ignore fetch's no-store option. Activate the
      // selected release's worker after the click, before validating its shell.
      await activateWorker();
      const deployed = await readDeployed();
      if (!usableUpdate(deployed, current)) throw new Error('No different deployed release');
      available = deployed;
      const url = new URL(shellUrl);
      url.searchParams.set('_app_update', available.build);
      const html = await request(url, 'text');
      if (!html.includes(`app-update-${available.build}.js`)) throw new Error('Deployment is not ready');
      await verifyAssets(html, available);
      if (location.href !== startedAtUrl || workChanged) {
        message.textContent = 'You made changes while checking. Save your work, then choose Update again.';
        return;
      }
      if (!window.dispatchEvent(new CustomEvent('app-update:before-apply', {cancelable:true, detail:available}))) return;
      const destination = new URL(location.href);
      destination.searchParams.set('_app_update', available.build);
      // Normal navigation preserves the app's beforeunload unsaved-work guard.
      location.assign(destination.href);
    } catch (error) {
      message.textContent = error.message.startsWith('Close and reopen') ? error.message : 'The update is not reachable yet. Your work is safe; try again when connected.';
    } finally {
      document.removeEventListener('input', observeWork, true);
      document.removeEventListener('pointerdown', observeWork, true);
      applying = false;
      updateButton.disabled = false;
    }
  }

  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  window.addEventListener('pageshow', check);
  setInterval(check, 60000);
  check();
}
