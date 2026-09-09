# Build target selection

Use npm run build:smart -- --dry-run to inspect the detected host and selected format. Run npm run build:smart to build. Add --target android, windows, macos, ios, safari or web when preparing files for another device. Host simulation (--host win32|darwin|linux) is dry-run only. Dependencies must already be installed.

| Target | Output |
|---|---|
| auto on Windows/macOS/Linux | dist/ browser assets |
| windows/macOS/iOS/Safari/web | Browser assets; no native installer |
| android | Browser assets; no APK configured |

Safari is a browser. Web assets must be hosted over HTTPS with the backend; copying dist onto a phone does not install an app. Each recipient needs their own authenticated account. No owner URL, session, data archive or key is added by this selector. Existing update flows retain their device/runtime selection. The script does not install apps, deploy, publish, create accounts or reset data.
