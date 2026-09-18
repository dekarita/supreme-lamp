param([string]$Url)
$ErrorActionPreference = 'SilentlyContinue'
$logDir = "$env:LOCALAPPDATA\GhrdpLauncher"; New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'last.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) }
L ("launch url=" + $Url)
$q = @{}; $uri = [System.Uri]$Url
foreach ($kv in $uri.Query.TrimStart('?') -split '&') { if ($kv) { $p = $kv -split '=', 2; if ($p.Count -eq 2) { $q[$p[0]] = [System.Uri]::UnescapeDataString($p[1]) } } }
$ip = if ($q['ip']) { $q['ip'] } elseif ($q['h']) { $q['h'] } elseif ($q['host']) { $q['host'] } else { '' }
$tok = if ($q['t']) { $q['t'] } elseif ($q['token']) { $q['token'] } else { '' }
if (-not $ip -or -not $tok) { L 'missing ip/token - silent exit'; exit 0 }
try { $b = [System.Net.IPAddress]::Parse($ip).GetAddressBytes(); if (-not ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127)) { L 'ip outside 100.64.0.0/10 - exit'; exit 0 } } catch { L 'bad ip - exit'; exit 0 }
$cred = $null
try { $cred = Invoke-RestMethod ("http://" + $ip + ":7331/api/rdp-creds?token=" + $tok) -TimeoutSec 8 } catch { L ("creds fail " + $_.Exception.Message); exit 0 }
if (-not $cred -or -not $cred.host) { L 'creds empty - exit'; exit 0 }
cmdkey /generic:("TERMSRV/" + $cred.host) /user:($cred.user) /pass:($cred.pass) | Out-Null
L ("cmdkey set " + $cred.host)
$mon = 1; try { Add-Type -AssemblyName System.Windows.Forms; $mon = [System.Windows.Forms.Screen]::AllScreens.Count } catch { }
$mm = if ($mon -gt 1) { 1 } else { 0 }
$rdp = Join-Path $env:TEMP ("ghrdp-" + [guid]::NewGuid().ToString('N') + ".rdp")
$lines = @(
 'screen mode id:i:2', ('use multimon:i:' + $mm), 'span monitors:i:0', 'desktopwidth:i:1920', 'desktopheight:i:1080',
 'session bpp:i:32', 'compression:i:1', 'keyboardhook:i:2', 'audiocapturemode:i:1', 'videoplaybackmode:i:1',
 'connection type:i:7', 'networkautodetect:i:1', 'bandwidthautodetect:i:1', 'displayconnectionbar:i:1',
 'disable wallpaper:i:0', 'allow font smoothing:i:1', 'allow desktop composition:i:1', 'bitmapcachepersistenable:i:1',
 ('full address:s:' + $cred.host), ('username:s:' + $cred.user), 'prompt for credentials:i:0',
 'negotiate security layer:i:1', 'remoteapplicationmode:i:0', 'alternate shell:s:', 'shell working directory:s:',
 'gatewayhostname:s:', 'gatewayusagemethod:i:4', 'gatewaycredentialssource:i:4', 'gatewayprofileusagemethod:i:0',
 'promptcredentialonce:i:0', 'use redirection server name:i:0', 'rdgiskdcproxy:i:0', 'kdcproxyname:s:',
 'redirectclipboard:i:1', 'redirectprinters:i:1', 'redirectdrives:i:1', 'redirectcomports:i:0', 'redirectsmartcards:i:0',
 'redirectwebdevices:i:1', 'redirectposdevices:i:0', 'devicestoredirect:s:*', 'drivestoredirect:s:*',
 'audiomode:i:0', 'autoreconnection enabled:i:1', 'authentication level:i:2', 'enablecredsspsupport:i:1'
)
Set-Content -Path $rdp -Value ($lines -join "`r`n") -Encoding ASCII
L ("rdp " + $rdp)
Start-Process mstsc.exe -ArgumentList ('"' + $rdp + '"')
Start-Job -ScriptBlock { param($f) Start-Sleep -Seconds 6; Remove-Item $f -Force -ErrorAction SilentlyContinue } -ArgumentList $rdp | Out-Null
L 'launched mstsc'; exit 0
