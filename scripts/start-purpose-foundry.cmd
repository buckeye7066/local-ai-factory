@echo off
REM Purpose Foundry launcher - opens the Foundry floor while preserving Factory Deck.
title Purpose Foundry
setlocal
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Purpose-Foundry-Icon.ps1" -Quiet >nul 2>&1
set "FACTORY_START_PATH=?mode=foundry"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-factory.ps1"
set "FOUNDRY_EXIT=%ERRORLEVEL%"
if not "%FOUNDRY_EXIT%"=="0" (
  echo.
  echo Purpose Foundry could not start. The error above has been left visible.
  echo Press any key after taking a screenshot or noting the error.
  pause >nul
)
endlocal & exit /b %FOUNDRY_EXIT%
