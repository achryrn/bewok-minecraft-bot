@echo off
title minecraft-bot - tests
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0test.ps1"
if errorlevel 1 (
  echo.
  echo ************************************************************
  echo  Some tests failed - see the details above.
  echo ************************************************************
  pause
) else (
  echo.
  pause
)
