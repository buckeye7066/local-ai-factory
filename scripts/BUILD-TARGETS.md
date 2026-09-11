# Build target selection

Run npm run build:smart to build; it prints the detected host and selected format first, then builds. Add --target android, windows, macos, ios, safari or web when preparing files for another device. There is no dry-run or host-simulation mode: --dry-run and --host are removed flags and fail. Dependencies must already be installed.

| Target | Output |
|---|---|
| auto on Windows/macOS/Linux | dist/ui/ browser assets |
| windows/macOS/iOS/Safari/web | Browser assets; no native installer |
| android | Browser assets; no APK configured |

Safari is a browser. Web assets must be hosted over HTTPS with the backend; copying dist onto a phone does not install an app. Each recipient needs their own authenticated account. No owner URL, session, data archive or key is added by this selector. Existing update flows retain their device/runtime selection. The script does not install apps, deploy, publish, create accounts or reset data.
