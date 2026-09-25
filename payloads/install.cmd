@echo off
setlocal EnableExtensions
rem GHRDP one-time handler install - NO PowerShell, NO admin, NO binary download.
set "SRC=%~dp0ghrdp-rdp-launcher.cs"
set "DIR=%LOCALAPPDATA%\ghrdp"
set "EXE=%DIR%\ghrdp-rdp-launcher.exe"
if not exist "%SRC%" (
  echo ERROR: ghrdp-rdp-launcher.cs not found next to install.cmd.
  echo Copy BOTH files from the repo payloads folder into one folder first.
  pause & exit /b 1
)
mkdir "%DIR%" 2>nul
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" ( echo ERROR: csc.exe not found. & pause & exit /b 1 )
echo BEFORE: & reg query "HKCU\Software\Classes\ghrdp\shell\open\command" /ve 2>nul
"%CSC%" /nologo /target:winexe /out:"%EXE%" /r:System.dll /r:System.Windows.Forms.dll "%SRC%"
if errorlevel 1 ( echo ERROR: compile failed. & pause & exit /b 1 )
reg add "HKCU\Software\Classes\ghrdp" /ve /d "URL:ghrdp Protocol" /f >nul
reg add "HKCU\Software\Classes\ghrdp" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\ghrdp\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
echo AFTER: & reg query "HKCU\Software\Classes\ghrdp\shell\open\command" /ve
echo.
echo DONE - the AFTER line must show ghrdp-rdp-launcher.exe, NOT powershell.
echo Now click WINDOWS AUTO-LOGIN on the dashboard.
pause
