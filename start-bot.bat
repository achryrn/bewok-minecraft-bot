@echo off
title minecraft-bot
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
if errorlevel 1 (
  echo.
  echo ************************************************************
  echo  The bot stopped with an error - see the messages above and
  echo  the file logs\bot.log
  echo ************************************************************
  pause
)
