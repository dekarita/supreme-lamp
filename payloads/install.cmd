@echo off
setlocal EnableExtensions
rem GHRDP [F10 s1] one-time protocol install - DOUBLE-CLICK, no script host.
rem Compiles ghrdp-rdp-launcher.cs with the in-box .NET Framework csc.exe
rem (no download, no admin/UAC, no script host) and registers the current-user
rem ghrdp:// protocol so [WINDOWS AUTO-LOGIN] can launch mstsc silently.
set "SRC=%~dp0ghrdp-rdp-launcher.cs"
set "OUTDIR=%LOCALAPPDATA%\ghrdp"
set "EXE=%OUTDIR%\ghrdp-rdp-launcher.exe"

if not exist "%SRC%" goto :nosrc
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
if not exist "%OUTDIR%" goto :nodir

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" goto :nocsc

"%CSC%" /nologo /optimize+ /target:winexe /out:"%EXE%" "%SRC%"
if errorlevel 1 goto :noamd64

reg add "HKCU\Software\Classes\ghrdp" /ve /d "URL:GHRDP Protocol" /f >nul
if errorlevel 1 goto :noreg
reg add "HKCU\Software\Classes\ghrdp" /v "URL Protocol" /d "" /f >nul
if errorlevel 1 goto :noreg
reg add "HKCU\Software\Classes\ghrdp\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
if errorlevel 1 goto :noreg

echo.
echo [install] OK: ghrdp:// handler registered for this Windows user.
echo [install]   exe  = %EXE%
echo [install]   verb = ghrdp://rdp?server=^<fqdn^>&user=^<user^>
echo.
echo Return to the dashboard and click [WINDOWS AUTO-LOGIN].
pause
exit /b 0

:nosrc
echo [install] ghrdp-rdp-launcher.cs must sit next to install.cmd. Nothing changed.
pause & exit /b 1
:nodir
echo [install] cannot create %OUTDIR%. Nothing changed.
pause & exit /b 1
:nocsc
echo [install] in-box csc.exe not found under %WINDIR%\Microsoft.NET. Nothing changed.
pause & exit /b 1
:noamd64
echo [install] compile failed - re-download both files and try again. Nothing registered.
pause & exit /b 1
:noreg
echo [install] registry registration failed for this Windows user. Try again.
pause & exit /b 1
