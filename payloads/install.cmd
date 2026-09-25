@echo off
rem [F10-1] ghrdp PS-FREE one-time handler installer (DOUBLE-CLICK).
rem No script host. No download. No UAC (HKCU only). Uses the in-box
rem .NET Framework 4.x C# compiler that ships with Windows 8/10/11.
rem Place this file NEXT TO ghrdp-rdp-launcher.cs, then double-click.
setlocal
set SRC=%~dp0ghrdp-rdp-launcher.cs
set DST=%LOCALAPPDATA%\ghrdp
set EXE=%DST%\ghrdp-launcher.exe
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
if not exist "%DST%" mkdir "%DST%"
"%CSC%" /nologo /target:exe /optimize+ /out:"%EXE%" "%SRC%"
if errorlevel 1 (
  echo [install] ERROR: compile failed.
  pause & exit /b 1
)
reg add "HKCU\Software\Classes\ghrdp" /ve /d "URL:ghrdp Protocol" /f >nul
reg add "HKCU\Software\Classes\ghrdp" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\ghrdp\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
echo [install] ghrdp protocol handler installed to %EXE%
echo [install] You can now use WINDOWS AUTO-LOGIN on Mission Control.
pause
endlocal
