@echo off
REM Purpose Foundry launcher - opens the Foundry floor while preserving Factory Deck.
title Purpose Foundry
set "FACTORY_START_PATH=?mode=foundry"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-factory.ps1"
