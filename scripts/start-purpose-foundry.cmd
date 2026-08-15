@echo off
REM Purpose Foundry launcher - opens the Foundry floor while preserving Factory Deck.
title Purpose Foundry
setlocal
powershell -NoLogo -NoProfile -File "%~dp0Install-Purpose-Foundry-Icon.ps1" -Quiet >nul 2>&1
set "FACTORY_START_PATH=?mode=foundry"
powershell -NoLogo -NoProfile -File "%~dp0start-factory.ps1"
endlocal
