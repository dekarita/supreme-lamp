@echo off
rem [F10-1][F12-1 §1.1] ghrdp PS-FREE one-time handler installer (DOUBLE-CLICK).
rem No script host. No download. No UAC (HKCU only). Uses the in-box
rem .NET Framework 4.x C# compiler that ships with Windows 8/10/11.
rem Place this file NEXT TO ghrdp-rdp-launcher.cs, then double-click.
rem
rem [F12-1] This installer OVERWRITES whatever HKCU\Software\Classes\ghrdp
rem currently points at - the pre-F2 registration was powershell.exe, which is
rem why Windows asked "Open Windows PowerShell?" for ghrdp:// links. The
rem BEFORE value is printed so that stale registration is visible, and the
rem AFTER value is read back and verified (nonzero exit + message when the
rem write did not take). HKLM registrations lose to HKCU for this user, so an
rem old machine-wide entry cannot shadow this one.
setlocal EnableExtensions
set SRC=%~dp0ghrdp-rdp-launcher.cs
set DST=%LOCALAPPDATA%\ghrdp
set EXE=%DST%\ghrdp-launcher.exe
set CLS=HKCU\Software\Classes\ghrdp
set KEY=%CLS%\shell\open\command
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [install] ERROR: in-box .NET Framework 4.x csc.exe not found.
  pause & exit /b 1
)
if not exist "%SRC%" (
  echo [install] ERROR: ghrdp-rdp-launcher.cs must sit next to install.cmd.
  pause & exit /b 1
)
echo [install] handler BEFORE (whatever a previous install left here):
reg query "%KEY%" /ve 2>nul
if errorlevel 1 echo [install]   no HKCU ghrdp registration present yet
if not exist "%DST%" mkdir "%DST%"
"%CSC%" /nologo /target:exe /optimize+ /out:"%EXE%" "%SRC%"
if errorlevel 1 (
  echo [install] ERROR: compile failed.
  pause & exit /b 1
)
reg add "%CLS%" /ve /d "URL:ghrdp Protocol" /f >nul
reg add "%CLS%" /v "URL Protocol" /d "" /f >nul
reg add "%KEY%" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
echo [install] handler AFTER (verified below):
reg query "%KEY%" /ve
reg query "%KEY%" /ve 2>nul | find /i "%EXE%" >nul
if errorlevel 1 (
  echo [install] ERROR: the ghrdp registration does NOT point at %EXE%.
  echo [install]        A stale value survived - delete HKCU\Software\Classes\ghrdp and re-run.
  pause & exit /b 1
)
echo [install] OK: ghrdp:// now runs %EXE% - a stale PowerShell entry is gone.
echo [install] You can now use WINDOWS AUTO-LOGIN on Mission Control.
pause
endlocal
