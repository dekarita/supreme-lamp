$ErrorActionPreference = 'Continue'
try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue } catch { }
Start-Sleep -Seconds 1
$port = '7331'
$rustFlag = ''
try { $rustFlag = [string](Get-Content -LiteralPath 'C:\ghrdp\rust-flag.txt' -ErrorAction SilentlyContinue | Select-Object -First 1) } catch { }
if ($rustFlag -eq 'true') { $port = '7332' }
try { Start-Process ('http://127.0.0.1:' + $port) } catch { Write-Host ('open http://127.0.0.1:' + $port + ' manually') }
