# Install-Desktop-Icon.ps1
# Creates a Desktop shortcut "Factory Deck" with the blue Ford-oval-style icon
# that launches the local AI software factory. Re-run any time to refresh it.
# It also creates or repairs the separate Purpose Foundry shortcut.
# (ASCII-only on purpose so Windows PowerShell 5.1 parses it cleanly.)
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher    = Join-Path $projectRoot "scripts\start-factory.cmd"
$icoPath     = Join-Path $projectRoot "assets\factory-deck.ico"

# Generate the icon if it's missing.
if (-not (Test-Path $icoPath)) {
    Write-Host "Icon missing - generating it..."
    Push-Location $projectRoot
    & pnpm exec tsx scripts/make-icon.ts | Out-Null
    Pop-Location
}

# Resolve the REAL desktop (handles OneDrive redirection automatically).
$shell   = New-Object -ComObject WScript.Shell
$desktop = $shell.SpecialFolders.Item("Desktop")
$lnkPath = Join-Path $desktop "Factory Deck.lnk"

$shortcut = $shell.CreateShortcut($lnkPath)
# Build /c "<launcher>" without backtick-escaping (avoids quote-parsing pitfalls).
$shortcut.TargetPath       = "cmd.exe"
$shortcut.Arguments        = '/c "' + $launcher + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation     = "$icoPath,0"
$shortcut.Description       = "Factory Deck - Local AI Software Factory"
$shortcut.WindowStyle       = 1
$shortcut.Save()

Write-Host "Created shortcut: $lnkPath"
Write-Host "Icon: $icoPath"

$foundryInstaller = Join-Path $PSScriptRoot "Install-Purpose-Foundry-Icon.ps1"
if (-not (Test-Path -LiteralPath $foundryInstaller -PathType Leaf)) {
    throw "Purpose Foundry shortcut installer is missing: $foundryInstaller"
}
& $foundryInstaller
