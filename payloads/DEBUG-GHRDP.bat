@echo off
title GHRDP Debug (read-only)
echo === GHRDP debug collector (read-only) ===
where pwsh.exe >nul 2>nul
if %errorlevel% EQU 0 (
    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ghrdp\DEBUG-GHRDP.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ghrdp\DEBUG-GHRDP.ps1"
)
echo.
pause
