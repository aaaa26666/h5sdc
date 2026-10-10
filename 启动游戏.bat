@echo off
REM ===========================================================================
REM  One-click launcher for the H5 extraction shooter.
REM
REM  IMPORTANT: keep this file ASCII-only.
REM  cmd.exe reads .bat files using the OEM code page (GBK/936 on Chinese
REM  Windows). Chinese characters stored as UTF-8 would be garbled here.
REM  All localized output is produced by tools\launch.mjs instead, where the
REM  encoding is unambiguous.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo           This game needs Node.js 18 or newer.
  echo           Download: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

REM Use UTF-8 for the console so the launcher's Chinese output renders correctly.
chcp 65001 >nul 2>nul

node "tools\launch.mjs" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo   [ERROR] Launcher exited with code %EXITCODE%.
  echo           See the messages above for details.
  echo.
  pause
)

endlocal
exit /b %EXITCODE%
