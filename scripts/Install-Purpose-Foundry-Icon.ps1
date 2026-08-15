# Creates or repairs a standalone Purpose Foundry desktop shortcut. Factory
# Deck and every specialist program keep their existing shortcuts and behavior.
# ASCII-only so Windows PowerShell 5.1 parses it consistently.
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "scripts\start-purpose-foundry.cmd"
$icon = Join-Path $projectRoot "assets\purpose-foundry.ico"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Purpose Foundry launcher is missing: $launcher"
}
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) {
    throw "Purpose Foundry icon is missing: $icon"
}

# WScript resolves the real Windows desktop, including OneDrive redirection.
$shell = New-Object -ComObject WScript.Shell
$desktop = $shell.SpecialFolders.Item("Desktop")
if ([string]::IsNullOrWhiteSpace($desktop)) {
    throw "Windows did not return a Desktop folder."
}
if (-not (Test-Path -LiteralPath $desktop -PathType Container)) {
    New-Item -ItemType Directory -Path $desktop -Force | Out-Null
}

$shortcutPath = Join-Path $desktop "Purpose Foundry.lnk"
$cmd = Join-Path $env:SystemRoot "System32\cmd.exe"
if (-not (Test-Path -LiteralPath $cmd -PathType Leaf)) { $cmd = "cmd.exe" }
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $cmd
$shortcut.Arguments = '/d /c ""' + $launcher + '""'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = "Purpose Foundry - coordinated product development assembly line"
$shortcut.WindowStyle = 1
$shortcut.Save()

if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    throw "Purpose Foundry shortcut was not created: $shortcutPath"
}
$saved = $shell.CreateShortcut($shortcutPath)
if ($saved.Arguments -notlike "*start-purpose-foundry.cmd*") {
    throw "Purpose Foundry shortcut verification failed: $shortcutPath"
}
if (-not $Quiet) {
    Write-Host "Created or repaired shortcut: $shortcutPath"
    Write-Host "Icon: $icon"
}
