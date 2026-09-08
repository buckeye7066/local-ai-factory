# Windows launcher reinstallation

The authoritative shared desktop launcher is
`scripts/Repair-All-Axiom-App-Shortcuts.ps1` in `buckeye7066/local-ai-factory`.
Its installed copy is `%LOCALAPPDATA%\AxiomProgramLaunchers\AxiomAppLauncher.ps1`.
The ForgePress application's source repository does not own this shared launcher.

## Repair or reinstall only ForgePress shortcuts

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Repair-All-Axiom-App-Shortcuts.ps1 -InstallOnly -OnlyApps ForgePress
```

Use the current `main` revision, not an old downloaded copy. This reinstalls the
launcher and repairs existing ForgePress shortcuts in the configured folders.
Other shortcuts are unchanged when `-OnlyApps ForgePress` is used. Without that
filter, the original all-app repair behavior remains available.

The executable launch path must omit `ArgumentList` when no arguments exist.
Windows PowerShell rejects an explicitly empty collection before the executable
starts. The installer also recreates ForgePress's hidden console configuration,
preserves its icon, and backs up overwritten launcher and shortcut files.

## Regression verification

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-axiom-app-shortcuts.ps1`.
The Windows launcher CI workflow runs this same test on relevant changes.

The test executes a harmless native process with no arguments, checks argument
quoting and missing targets, installs twice with a simulated stale launcher
between passes, reinstalls from the installed copy itself, and verifies backups,
hidden shortcuts, duplicate shortcut names, original icons and app scoping.
Its desktop and LOCALAPPDATA are temporary. It does not open or edit manuscripts.
The pre-fix source fails the no-argument launch regression.

This protects installations generated from the corrected source. It is not a
filesystem lock or a guarantee against manually running unrelated old scripts,
restoring old backups, moving the application, or deleting the installation.
No startup watcher, scheduled task, elevated permissions or background service
is installed. ForgePress does not need a remote connection to launch.
