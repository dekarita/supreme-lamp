$d = "$env:LOCALAPPDATA\GhrdpLauncher"; New-Item -ItemType Directory -Path $d -Force | Out-Null
$log = "$d\install.log"; function L($m){ Add-Content $log ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) }
$cands = @()
try { $ts = 'C:\Program Files\Tailscale\tailscale.exe'; if (Test-Path $ts) { $st = (& $ts status --json 2>$null) | ConvertFrom-Json; foreach ($pk in $st.Peer.PSObject.Properties) { foreach ($tip in $pk.Value.TailscaleIPs) { $cands += $tip } } } } catch { }
$got = $false
foreach ($c in ($cands | Select-Object -Unique)) {
  try { Invoke-WebRequest ("http://" + $c + ":7331/launcher.ps1") -OutFile "$d\launch.ps1" -UseBasicParsing -TimeoutSec 8; $got = $true; L ("launcher from " + $c); break } catch { }
}
if (-not $got) { L 'no runner reachable'; exit 1 }
reg add "HKCU\Software\Classes\ghrdp" /ve /d "URL:GHRDP" /f | Out-Null
reg add "HKCU\Software\Classes\ghrdp" /v "URL Protocol" /d "" /f | Out-Null
reg add "HKCU\Software\Classes\ghrdp\shell\open\command" /ve /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$d\launch.ps1`" -Url `"%1`"" /f | Out-Null
Remove-Item "$env:LOCALAPPDATA\ghrdp\ghrdp-connect.ps1" -Force -ErrorAction SilentlyContinue
reg add "HKCU\Software\Microsoft\Terminal Server Client" /v PublisherBypass /t REG_DWORD /d 1 /f | Out-Null
L 'install complete - protocol now launch.ps1 v3 (powershell.exe hidden)'
exit 0
