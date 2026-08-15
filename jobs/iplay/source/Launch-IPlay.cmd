@echo off
setlocal
cd /d "%~dp0"
where pythonw >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" pythonw "%~dp0iplay.pyw"
  exit /b 0
)
where python >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" python "%~dp0iplay.pyw"
  exit /b 0
)
echo Python was not found on PATH. Install Python 3.11+ and retry.
pause
exit /b 1
