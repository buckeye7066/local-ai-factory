/* global location, window, document, navigator, AbortController, localStorage, Notification, CustomEvent, fetch, setInterval, setTimeout, clearTimeout */
/** Shared wire validation. Package versions are deliberately not release identity. */
export function usableUpdate(value, current) {
  return Boolean(value && value.schema === 1 && value.app === current.app
    && typeof value.build === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value.build)
    && value.build !== current.build && Number.isFinite(Date.parse(value.builtAt))
    && Date.parse(value.builtAt) > Date.parse(current.builtAt));
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
      return type === 'json' ? await response.json() : await response.text();
    } finally { clearTimeout(timer); }
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
      const url = new URL(feedUrl);
      url.searchParams.set('_check', String(Date.now()));
      const value = await request(url, 'json');
      if (usableUpdate(value, current)) {
        available = value;
        showUpdate();
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
    if (!registration) return;
    await Promise.race([registration.update().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    await waitForWorker(registration.installing);
    if (!registration.waiting) return;
    const worker = registration.waiting;
    worker.postMessage({ type: 'APP_UPDATE_ACTIVATE' });
    await waitForWorker(worker, ['activated', 'redundant']);
    if (registration.waiting === worker && worker.state !== 'activated') {
      // Older workers may not understand activation messages. Unregister only
      // this app's matching worker; never delete caches, IndexedDB, or profiles.
      await registration.unregister();
    }
  }

  async function apply() {
    if (!available || applying) return;
    if (!window.dispatchEvent(new CustomEvent('app-update:before-apply', { cancelable: true, detail: available }))) return;
    applying = true;
    updateButton.disabled = true;
    message.hidden = false;
    message.textContent = 'Checking that the update is ready…';
    try {
      if (navigator.onLine === false) throw new Error('Offline');
      // A cache-first worker can ignore fetch's no-store option. Activate the
      // selected release's worker after the click, before validating its shell.
      await activateWorker();
      const url = new URL(shellUrl);
      url.searchParams.set('_app_update', available.build);
      const html = await request(url, 'text');
      if (!html.includes(`app-update-${available.build}.js`)) throw new Error('Deployment is not ready');
      const destination = new URL(location.href);
      destination.searchParams.set('_app_update', available.build);
      // Normal navigation preserves the app's beforeunload unsaved-work guard.
      location.assign(destination.href);
    } catch {
      message.textContent = 'The update is not reachable yet. Your work is safe; try again when connected.';
    } finally {
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
