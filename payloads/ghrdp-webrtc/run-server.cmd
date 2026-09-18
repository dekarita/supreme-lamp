@echo off
setlocal enabledelayedexpansion
:: Supervisor wrapper — restarts webrtc-server.exe on crash, logs to crash.log.
:: Exit codes 0 (clean), 42 (session guard), 43 (mutex) are terminal.
set "DIR=%~dp0"
set "EXE=%DIR%webrtc-server.exe"
set "CRASH=%DIR%crash.log"
set "SLOG=%DIR%server.log"
:loop
echo [%date% %time%] START >> "%CRASH%"
"%EXE%" 2>> "%SLOG%"
set RC=!ERRORLEVEL!
echo [%date% %time%] EXIT code=!RC! >> "%CRASH%"
if !RC! EQU 0 goto :done
if !RC! EQU 42 goto :done
if !RC! EQU 43 goto :done
echo [%date% %time%] RESTART in 3s >> "%CRASH%"
timeout /t 3 /nobreak >nul 2>&1
goto :loop
:done
