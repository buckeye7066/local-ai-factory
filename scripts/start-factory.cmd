@echo off
REM Factory Deck launcher - repairs the Purpose Foundry desktop shortcut, then
REM starts Factory Deck through the shared PowerShell launcher.
title Factory Deck
if exist "%~dp0Install-Purpose-Foundry-Icon.ps1" (
  powershell -NoLogo -NoProfile -File "%~dp0Install-Purpose-Foundry-Icon.ps1" -Quiet >nul 2>&1
)
powershell -NoLogo -NoProfile -File "%~dp0start-factory.ps1"
