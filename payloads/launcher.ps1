param([string]$Url)
$ErrorActionPreference = 'SilentlyContinue'
$log = "$env:LOCALAPPDATA\GhrdpLauncher\last.log"
function L($m) { Add-Content $log ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) }
L "url=$Url"
$q = @{}; $u = [System.Uri]$Url
foreach ($kv in $u.Query.TrimStart('?') -split '&') { if ($kv) { $p = $kv -split '=', 2; if ($p.Count -eq 2) { $q[$p[0]] = [Uri]::UnescapeDataString($p[1]) } } }
if ($u.Fragment) { foreach ($kv in $u.Fragment.TrimStart('#') -split '&') { if ($kv) { $p = $kv -split '=', 2; if ($p.Count -eq 2 -and -not $q[$p[0]]) { $q[$p[0]] = [Uri]::UnescapeDataString($p[1]) } } } }
$ip  = if ($q.ip) { $q.ip } elseif ($q.h) { $q.h } elseif ($q.host) { $q.host } else { '' }
$tok = if ($q.t) { $q.t } elseif ($q.token) { $q.token } else { '' }
$usr = if ($q.u) { $q.u } elseif ($q.user) { $q.user } else { '' }
$pw  = if ($q.p) { try { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($q.p)) } catch { '' } } else { '' }
# --- IP auto-discovery via Tailscale peers (dashboard ip නැතත් වැඩ කරනවා) ---
$cands = @()
if ($ip) { $cands += $ip }
try {
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  if (-not $ts) { $tsPath = 'C:\Program Files\Tailscale\tailscale.exe'; if (Test-Path $tsPath) { $ts = $tsPath } }
  if ($ts) {
    $st = (& $ts status --json 2>$null) | ConvertFrom-Json
    if ($st.PSObject.Properties['Peer']) { foreach ($pk in $st.Peer.PSObject.Properties) { foreach ($tip in $pk.Value.TailscaleIPs) { $cands += $tip } } }
  }
} catch { L 'tailscale status fail' }
$cands = $cands | Where-Object { $_ -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.' } | Select-Object -Unique
L "candidates=$($cands -join ',')"
# --- creds: token exchange → else cached → else fail silent ---
$hn = $null
if (-not $pw) {
  foreach ($c in $cands) {
    if ($tok) { try { $cr = Invoke-RestMethod "http://${c}:7331/api/rdp-creds?token=$tok" -TimeoutSec 4; if ($cr -and $cr.host) { $ip = $c; $hn = $cr.host; $usr = $cr.user; $pw = $cr.pass; break } } catch { } }
  }
}
if (-not $pw) {
  $cache = "$env:LOCALAPPDATA\GhrdpLauncher\creds.cache"
  if (Test-Path $cache) { $cj = Get-Content $cache -Raw | ConvertFrom-Json; if ($cj -and ((Get-Date) - $cj.at) -lt (New-TimeSpan -Hours 8)) { $hn = $cj.host; $usr = $cj.user; $pw = $cj.pass; $ip = if ($ip) { $ip } else { $cj.hostip } ; L 'used cache' } }
}
if (-not $pw) { L 'no creds obtainable - silent exit'; exit 0 }
if (-not $hn) { $hn = $ip }
if (-not $ip) { L 'no ip - silent exit'; exit 0 }
cmdkey /generic:"TERMSRV/$hn" /user:$usr /pass:$pw | Out-Null
@{ at = (Get-Date); host = $hn; hostip = $ip; user = $usr; pass = $pw } | ConvertTo-Json -Compress | Set-Content "$env:LOCALAPPDATA\GhrdpLauncher\creds.cache"
L "cmdkey set $hn"
$mon = 1; try { Add-Type -AssemblyName System.Windows.Forms; $mon = [Windows.Forms.Screen]::AllScreens.Count } catch { }
$mm = if ($mon -gt 1) { 1 } else { 0 }
$rdp = Join-Path $env:TEMP ("ghrdp-" + [guid]::NewGuid().ToString('N') + ".rdp")
$lines = @(
  'screen mode id:i:2', "use multimon:i:$mm", 'desktopwidth:i:1920', 'desktopheight:i:1080', 'session bpp:i:32',
  'keyboardhook:i:2', 'audiocapturemode:i:1', 'videoplaybackmode:i:1', 'connection type:i:7',
  'networkautodetect:i:1', 'bandwidthautodetect:i:1', 'allow font smoothing:i:1', 'allow desktop composition:i:1',
  'bitmapcachepersistenable:i:1', "full address:s:$hn", "username:s:$usr", 'prompt for credentials:i:0',
  'authentication level:i:2', 'enablecredsspsupport:i:1', 'redirectclipboard:i:1', 'redirectprinters:i:1',
  'redirectdrives:i:1', 'redirectcomports:i:0', 'redirectsmartcards:i:0', 'redirectwebdevices:i:1',
  'devicestoredirect:s:*', 'drivestoredirect:s:*', 'audiomode:i:0', 'autoreconnection enabled:i:1'
)
Set-Content $rdp -Value ($lines -join "`r`n") -Encoding ASCII
L "rdp=$rdp"
Start-Process mstsc.exe -ArgumentList "`"$rdp`""
Start-Job { param($f) Start-Sleep 6; Remove-Item $f -Force -ErrorAction SilentlyContinue } -ArgumentList $rdp | Out-Null
L 'launched mstsc'; exit 0
