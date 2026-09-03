@echo off
REM Factory Deck launcher - repairs the Purpose Foundry desktop shortcut, then
REM synchronizes a current runtime without overwriting local source edits.
title Factory Deck
if exist "%~dp0Install-Purpose-Foundry-Icon.ps1" (
  powershell -NoLogo -NoProfile -File "%~dp0Install-Purpose-Foundry-Icon.ps1" -Quiet >nul 2>&1
)
if exist "%~dp0Sync-FactoryRuntime.ps1" (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Sync-FactoryRuntime.ps1"
) else (
  REM Backward-compatible fallback for incomplete/non-git installs.
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-factory.ps1"
)
set "FACTORY_EXIT=%ERRORLEVEL%"
if not "%FACTORY_EXIT%"=="0" (
  echo.
  echo Factory Deck could not start. The error above has been left visible.
  echo Press any key after taking a screenshot or noting the error.
  pause >nul
)
exit /b %FACTORY_EXIT%
