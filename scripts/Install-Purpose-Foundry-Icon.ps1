# Creates a standalone Purpose Foundry desktop shortcut. Factory Deck and every
# specialist program keep their existing shortcuts and standalone behavior.
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "scripts\start-purpose-foundry.cmd"
$icon = Join-Path $projectRoot "assets\purpose-foundry.ico"
if (-not (Test-Path $launcher)) { throw "Purpose Foundry launcher is missing: $launcher" }
if (-not (Test-Path $icon)) { throw "Purpose Foundry icon is missing: $icon" }
$shell = New-Object -ComObject WScript.Shell
$desktop = $shell.SpecialFolders.Item("Desktop")
$shortcutPath = Join-Path $desktop "Purpose Foundry.lnk"
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "cmd.exe"
$shortcut.Arguments = '/c "' + $launcher + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = "Purpose Foundry - coordinated product development assembly line"
$shortcut.WindowStyle = 1
$shortcut.Save()
Write-Host "Created shortcut: $shortcutPath"
