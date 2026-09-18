$d = "$env:LOCALAPPDATA\GhrdpLauncher"; New-Item -ItemType Directory -Path $d -Force | Out-Null
$log = "$d\install.log"; function L($m){ Add-Content $log ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) }
L 'install v2 start'
$cands = @('127.0.0.1')
try { $ts='C:\Program Files\Tailscale\tailscale.exe'; if (Test-Path $ts) { $st=(& $ts status --json 2>$null)|ConvertFrom-Json; foreach($pk in $st.Peer.PSObject.Properties){ foreach($t in $pk.Value.TailscaleIPs){ $cands += $t } } } } catch {}
$runner=''
foreach($c in ($cands|Select-Object -Unique)){ try { $r=Invoke-WebRequest ("http://"+$c+":7331/launcher.ps1") -UseBasicParsing -TimeoutSec 6; Set-Content "$d\launch.ps1" $r.Content -Encoding UTF8; $runner=$c; L ("launcher from "+$c); break } catch {} }
if(-not $runner){ L 'no runner reachable'; exit 1 }
Set-Content "$d\runner.txt" $runner
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
reg add "HKCU\Software\Classes\ghrdp" /ve /d "URL:GHRDP" /f | Out-Null
reg add "HKCU\Software\Classes\ghrdp" /v "URL Protocol" /d "" /f | Out-Null
reg add "HKCU\Software\Classes\ghrdp\shell\open\command" /ve /d ("`"" + $ps + "`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $d + "\launch.ps1`" -Url `"%1`"") /f | Out-Null
Remove-Item "$env:LOCALAPPDATA\ghrdp\ghrdp-connect.ps1" -Force -ErrorAction SilentlyContinue
reg add "HKCU\Software\Microsoft\Terminal Server Client" /v PublisherBypass /t REG_DWORD /d 1 /f | Out-Null
try { Invoke-RestMethod ("http://"+$runner+":7331/api/launcher-hello") -Method POST -TimeoutSec 5 | Out-Null; L 'hello posted' } catch {}
L 'install v2 complete'
exit 0
