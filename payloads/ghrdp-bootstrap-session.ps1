$ErrorActionPreference = 'Continue'
try { Start-Process explorer.exe } catch { }
Start-Sleep -Seconds 2
try { Start-Process powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ghrdp\ghrdp-watcher.ps1"' -WindowStyle Hidden } catch { }
try { Start-Process powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ghrdp\ghrdp-pub2.ps1"' -WindowStyle Hidden } catch { }
exit 0
