# helper-ghrdp-connect.ps1 v3 — clean, silent, no popup dialogs.
# Deployed by install.ps1 to %LOCALAPPDATA%\ghrdp\ghrdp-connect.ps1
# (registry keeps pointing here; content is now v3-equivalent to launch.ps1).
param([string]$Url)
$ErrorActionPreference = 'SilentlyContinue'
$logDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'ghrdp-connect.log'
function L($m) { try { [System.IO.File]::AppendAllText($logFile, ('[' + ([DateTime]::UtcNow.ToString('HH:mm:ss.fff')) + '] ' + $m + "`r`n")) } catch { } }
L "=== v3 helper invoked ==="
L "url=$Url"

$raw = $Url -replace '^ghrdp:(//)?', '' -replace '^connect\??', '' -replace '^/', ''
$p = @{}
foreach ($kv in ($raw -split '&')) {
    $eq = $kv.IndexOf('=')
    if ($eq -gt 0) {
        $k = [uri]::UnescapeDataString($kv.Substring(0, $eq)).ToLower()
        $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
        $p[$k] = $v
    }
}
function Pick { param([string[]]$keys) foreach ($k in $keys) { if ($p.ContainsKey($k) -and $p[$k]) { return [string]$p[$k] } } return '' }

$mode = Pick @('mode')
$server = Pick @('server', 'ip', 'computer', 'host', 'h')
$port = Pick @('port'); if (-not $port) { $port = '7331' }
$token = Pick @('token', 't')
$clip = ((Pick @('clip', 'clipboard')) -eq '1')
$mic = ((Pick @('mic', 'microphone')) -eq '1')
$prn = ((Pick @('printers', 'print')) -eq '1')
$drv = ((Pick @('drives', 'drivestoredirect')) -eq '1')

# ---- install mode: download latest install.ps1 and re-run silently ----
if ($mode -eq 'install') {
    $src = Pick @('src')
    if (-not $src -and $server) { $src = "http://${server}:${port}/install.ps1" }
    if (-not $src) { L 'install mode: missing src'; exit 0 }
    $tmp = Join-Path $env:TEMP ('ghrdp-install-' + [guid]::NewGuid().ToString('N') + '.ps1')
    try {
        Invoke-WebRequest -Uri $src -OutFile $tmp -UseBasicParsing -TimeoutSec 90 -ErrorAction Stop
        L "install downloaded to $tmp; launching hidden pwsh"
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $tmp + '"')) -WindowStyle Hidden
    } catch { L "install download failed: $($_.Exception.Message)" }
    exit 0
}

# ---- Tailscale peer discovery if server missing ----
if (-not $server) {
    $ts = 'C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path $ts) {
        try {
            $tj = (& $ts status --json 2>$null) | ConvertFrom-Json
            if ($tj -and $tj.Peer) {
                foreach ($peer in $tj.Peer.PSObject.Properties) {
                    if ($peer.Value.Online) { $server = @($peer.Value.TailscaleIPs)[0]; break }
                }
            }
        } catch { }
    }
}
if (-not $server) { L 'FATAL: no server'; exit 0 }

# ---- launcher-hello handshake (fire-and-forget) ----
try {
    Start-Job -ScriptBlock {
        param($s, $po, $bd)
        try {
            $r = [System.Net.HttpWebRequest]::Create("http://${s}:${po}/api/launcher-hello?ver=3&build=$bd")
            $r.Timeout = 3000; $r.GetResponse().Close()
        } catch { }
    } -ArgumentList $server, $port, ([Environment]::OSVersion.Version.Build) | Out-Null
} catch { }

# ---- Fetch creds: token (primary) → legacy no-token → embedded-URL (last-resort fallback F6) ----
$creds = $null
$credSource = ''
if ($token) {
    try {
        $creds = Invoke-RestMethod -Uri ("http://${server}:${port}/api/rdp-creds?token=" + [uri]::EscapeDataString($token)) -TimeoutSec 5 -ErrorAction Stop
        $credSource = 'token'
        L 'creds via token'
    } catch { L "token cred fetch: $($_.Exception.Message)" }
}
if (-not $creds) {
    try {
        $creds = Invoke-RestMethod -Uri "http://${server}:${port}/api/rdp-creds" -TimeoutSec 5 -ErrorAction Stop
        $credSource = 'legacy'
        L 'creds via legacy'
    } catch { L "legacy fetch: $($_.Exception.Message)" }
}
# F6: embedded-creds fallback. Some URLs carry user/pass; if server is unreachable AND the URL had them,
# use them so the user's static dashboard anchor keeps working. Base64URL decoded when 'b64u:' prefix seen.
if (-not $creds) {
    function Expand-B64U([string]$s) {
        try {
            $x = $s -replace '^b64u:', ''
            $x = $x.Replace('-', '+').Replace('_', '/')
            switch ($x.Length % 4) { 2 { $x += '==' } 3 { $x += '=' } }
            return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($x))
        } catch { return $s }
    }
    $embUser = Pick @('user', 'u', 'username')
    $embPass = Pick @('pass', 'p', 'password', 'pw')
    if ($embUser -match '^b64u:') { $embUser = Expand-B64U $embUser }
    if ($embPass -match '^b64u:') { $embPass = Expand-B64U $embPass }
    if ($embUser -and $embPass) {
        $creds = [pscustomobject]@{ host = $server; user = $embUser; pass = $embPass; hostip = $server }
        $credSource = 'embedded'
        L ('creds via embedded link (fallback): ' + $embUser + '@' + $server)
    }
}
if (-not $creds) { L 'FATAL: no creds (token/legacy/embedded all failed)'; exit 0 }

$rdpHost = [string]$creds.host; if (-not $rdpHost) { $rdpHost = $server }
$rdpUser = [string]$creds.user
$rdpPass = [string]$creds.pass
if (-not $rdpUser -or -not $rdpPass) { L 'FATAL: incomplete creds'; exit 0 }
L ("creds ok: " + $rdpUser + '@' + $rdpHost + ' src=' + $credSource)

# ---- Pre-trust host to suppress publisher warnings ----
try {
    $ldPath = 'HKCU:\Software\Microsoft\Terminal Server Client\LocalDevices'
    if (-not (Test-Path $ldPath)) { New-Item -Path $ldPath -Force | Out-Null }
    $mask = 0x01
    if ($clip) { $mask = $mask -bor 0x20 }
    if ($drv) { $mask = $mask -bor 0x04 }
    if ($prn) { $mask = $mask -bor 0x08 }
    if ($mic) { $mask = $mask -bor 0x40 }
    New-ItemProperty -Path $ldPath -Name $rdpHost -PropertyType DWord -Value $mask -Force | Out-Null
} catch { }

# ---- cmdkey stash ----
& cmdkey /generic:"TERMSRV/$rdpHost" /user:$rdpUser /pass:$rdpPass >$null 2>&1

# ---- Write CORRECT .rdp (fixes `connect type:i:6` and gatewayusagemethod bugs) ----
$rdpFile = Join-Path $logDir ('sess-' + (Get-Date -Format 'yyyyMMddHHmmssfff') + '.rdp')
$lines = @(
    ('full address:s:' + $rdpHost)
    ('username:s:' + $rdpUser)
    'screen mode id:i:2'
    'use multimon:i:0'
    'desktopwidth:i:1920'
    'desktopheight:i:1080'
    'session bpp:i:32'
    'compression:i:1'
    'keyboardhook:i:2'
    'audiomode:i:0'
    ('audiocapturemode:i:' + $(if ($mic) { '1' } else { '0' }))
    'videoplaybackmode:i:1'
    'connection type:i:7'
    'networkautodetect:i:1'
    'bandwidthautodetect:i:1'
    'displayconnectionbar:i:1'
    'disable wallpaper:i:0'
    'allow font smoothing:i:1'
    'allow desktop composition:i:1'
    'bitmapcachepersistenable:i:1'
    'autoreconnection enabled:i:1'
    'authentication level:i:0'
    'prompt for credentials:i:0'
    'negotiate security layer:i:1'
    'enablecredsspsupport:i:1'
    'gatewayusagemethod:i:0'
    ('redirectclipboard:i:' + $(if ($clip) { '1' } else { '0' }))
    ('redirectprinters:i:' + $(if ($prn) { '1' } else { '0' }))
    ('drivestoredirect:s:' + $(if ($drv) { '*' } else { '' }))
    'redirectcomports:i:0'
    'redirectsmartcards:i:1'
    'redirectposdevices:i:0'
)
[System.IO.File]::WriteAllText($rdpFile, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
try { Unblock-File -Path $rdpFile -ErrorAction SilentlyContinue } catch { }
try { $zi = $rdpFile + ':Zone.Identifier'; if (Test-Path -LiteralPath $zi) { Remove-Item -LiteralPath $zi -Force } } catch { }

# ---- Launch mstsc silently ----
Start-Process 'mstsc.exe' -ArgumentList ('"' + $rdpFile + '"') -WindowStyle Hidden
L 'mstsc launched'

# ---- Background cleanup ----
Start-Job -ScriptBlock {
    param($f, $t, $l)
    Start-Sleep -Seconds 15
    try { Remove-Item -LiteralPath $f -Force } catch { }
    & cmdkey /delete:$t >$null 2>&1
    try { [System.IO.File]::AppendAllText($l, ('[' + ([DateTime]::UtcNow.ToString('HH:mm:ss.fff')) + '] cleanup done' + "`r`n")) } catch { }
} -ArgumentList $rdpFile, "TERMSRV/$rdpHost", $logFile | Out-Null

L 'v3 exit 0'
exit 0
