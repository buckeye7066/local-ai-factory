@echo off
REM Factory Deck launcher - thin wrapper so the desktop shortcut keeps working.
REM All logic lives in start-factory.ps1 (readiness poll, conditional rebuild,
REM single-process production mode).
title Factory Deck
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-factory.ps1"
