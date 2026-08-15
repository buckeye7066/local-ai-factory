@echo off
REM Purpose Foundry launcher - opens the Foundry floor while preserving Factory Deck.
title Purpose Foundry
setlocal
set "FACTORY_START_PATH=?mode=foundry"
powershell -NoLogo -NoProfile -File "%~dp0start-factory.ps1"
endlocal
