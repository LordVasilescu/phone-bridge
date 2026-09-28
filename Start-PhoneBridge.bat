@REM (c) 2026 Mathew. All rights reserved.
@echo off
title PhoneBridge v2 - Grok
cd /d "%~dp0"
echo.
echo  Starting PhoneBridge (Grok)...
echo  Keep this window open while you use your phone.
echo.
node server.js
if errorlevel 1 (
  echo.
  echo  Failed. Is Node.js installed?  node -v
  pause
)
