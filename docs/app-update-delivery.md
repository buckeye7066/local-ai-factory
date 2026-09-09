# App update delivery

Each production Vite build of local-ai-factory emits a same-origin app-update.json and embeds that exact build identity in its HTML. Once that build is deployed, an older running browser or installed PWA checks on startup, resume, reconnection, and once a minute while visible. It shows Update and Later. It never reloads just because a new build exists. Already-permitted system notifications can also announce the update; no notification permission is requested automatically.

Update first activates the waiting worker for this app and verifies the deployed HTML contains the advertised build before navigating. Offline or incomplete deployments retain the current page and expose retry. Profiles, caches belonging to other apps, localStorage and IndexedDB are not cleared. Applications can cancel app-update:before-apply while saving work. Normal beforeunload handling also remains active.

This mechanism reaches online browsers and home-screen installations at the deployed origin. It does not distribute native executables, replace a local server checkout, or deliver push while the app is closed. Builds installed before this updater must receive the first updater-enabled release through their existing update/install path. Capacitor native apps use their platform updater instead of reloading a bundled file URL.

Verification: npm run test:updates checks version identity and worker generation. App update delivery CI exercises Chromium and WebKit with a real cache-first service worker, no automatic reload, offline retry, explicit Update, and saved data preservation. Existing repository checks remain required.

The Home workstation bridge returned HTTP 504 during this change. Required Obsidian note/bus synchronization could not be confirmed; this checked-in record preserves the implementation and limitation for replay after reconnection.
