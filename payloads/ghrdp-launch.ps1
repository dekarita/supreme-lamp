# ghrdp-launch.ps1 v3 — silent, hidden, alias-tolerant zero-dialog auto-login
# Contract: called by HKCU protocol handler with a single ghrdp:// URL argument.
# Runs invisibly (parent -WindowStyle Hidden), never throws (exit 0 always),
# logs all steps to %LOCALAPPDATA%\GhrdpLauncher\last.log.
param([string]$Url)
$ErrorActionPreference = 'SilentlyContinue'
$logDir = Join-Path $env:LOCALAPPDATA 'GhrdpLauncher'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'last.log'
function L($m) { try { [System.IO.File]::AppendAllText($logFile, ('[' + ([DateTime]::UtcNow.ToString('HH:mm:ss.fff')) + '] ' + $m + "`r`n")) } catch { } }
try { [System.IO.File]::WriteAllText($logFile, '') } catch { }
L "=== v3 invoked ==="
L "url=$Url"
L "build=$([Environment]::OSVersion.Version) argv0=$($MyInvocation.MyCommand.Path)"

# ---- Parse alias-tolerant ghrdp:// (accepts every historical shape) ----
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
$server = Pick @('server', 'ip', 'computer', 'host', 'h')
$port = Pick @('port'); if (-not $port) { $port = '7331' }
$token = Pick @('token', 't')
$clip = ((Pick @('clip', 'clipboard')) -eq '1')
$mic = ((Pick @('mic', 'microphone')) -eq '1')
$prn = ((Pick @('printers', 'print')) -eq '1')
$drv = ((Pick @('drives', 'drivestoredirect')) -eq '1')
L ("parsed server=$server port=$port token=" + $(if ($token) { $token.Substring(0, [Math]::Min(8, $token.Length)) + '...' } else { '<none>' }) + " clip=$clip mic=$mic prn=$prn drv=$drv")

# ---- Tailscale peer auto-discovery if server missing ----
if (-not $server) {
    $ts = 'C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path $ts) {
        try {
            $tj = (& $ts status --json 2>$null) | ConvertFrom-Json
            if ($tj -and $tj.Peer) {
                foreach ($peer in $tj.Peer.PSObject.Properties) {
                    if ($peer.Value.Online) {
                        $server = @($peer.Value.TailscaleIPs)[0]
                        L "peer discovered via tailscale: $server ($($peer.Value.HostName))"
                        break
                    }
                }
            }
        } catch { L "tailscale discovery: $($_.Exception.Message)" }
    }
}
if (-not $server) { L 'FATAL: no server (URL had no ip/host and tailscale peer discovery failed)'; exit 0 }

# ---- Fire handshake (fire-and-forget so it never blocks) ----
try {
    Start-Job -ScriptBlock {
        param($s, $po, $bd)
        try {
            $r = [System.Net.HttpWebRequest]::Create("http://${s}:${po}/api/launcher-hello?ver=3&build=$bd")
            $r.Timeout = 3000
            $r.GetResponse().Close()
        } catch { }
    } -ArgumentList $server, $port, ([Environment]::OSVersion.Version.Build) | Out-Null
} catch { }

# ---- Fetch creds via single-use token (primary) or legacy no-token (fallback) ----
$creds = $null
if ($token) {
    try {
        $creds = Invoke-RestMethod -Uri ("http://${server}:${port}/api/rdp-creds?token=" + [uri]::EscapeDataString($token)) -TimeoutSec 5 -ErrorAction Stop
        L 'creds fetched via token'
    } catch { L "token cred fetch failed: $($_.Exception.Message)" }
}
if (-not $creds) {
    try {
        $creds = Invoke-RestMethod -Uri "http://${server}:${port}/api/rdp-creds" -TimeoutSec 5 -ErrorAction Stop
        L 'creds fetched via legacy no-token endpoint (tailnet-only)'
    } catch { L "legacy cred fetch failed: $($_.Exception.Message)" }
}
if (-not $creds) { L 'FATAL: no creds obtained'; exit 0 }

$rdpHost = [string]$creds.host; if (-not $rdpHost) { $rdpHost = $server }
$rdpUser = [string]$creds.user
$rdpPass = [string]$creds.pass
if (-not $rdpUser -or -not $rdpPass) { L 'FATAL: creds response missing user or pass'; exit 0 }
L "creds ok: $rdpUser@$rdpHost"

# ---- Pre-trust host to suppress unknown-publisher warning ----
try {
    $ldPath = 'HKCU:\Software\Microsoft\Terminal Server Client\LocalDevices'
    if (-not (Test-Path $ldPath)) { New-Item -Path $ldPath -Force | Out-Null }
    $mask = 0x01
    if ($clip) { $mask = $mask -bor 0x20 }
    if ($drv) { $mask = $mask -bor 0x04 }
    if ($prn) { $mask = $mask -bor 0x08 }
    if ($mic) { $mask = $mask -bor 0x40 }
    New-ItemProperty -Path $ldPath -Name $rdpHost -PropertyType DWord -Value $mask -Force | Out-Null
    L ("LocalDevices\\$rdpHost = 0x{0:X}" -f $mask)
} catch { L "LocalDevices set failed: $($_.Exception.Message)" }

# ---- cmdkey stash (auto-login credential) ----
& cmdkey /generic:"TERMSRV/$rdpHost" /user:$rdpUser /pass:$rdpPass >$null 2>&1
L "cmdkey stashed TERMSRV/$rdpHost"

# ---- Mechanism selection: (a) inline /v: when no redirections (no .rdp file => no 25H2 reputation prompt), (b) local .rdp otherwise ----
# Both paths are used because R3 demands full redirection; we always emit a
# MOTW-free file (no browser Zone.Identifier stream), so no untrusted-file
# prompt appears when the install-time trust keys are armed.
$build = 0
try { $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name CurrentBuildNumber).CurrentBuildNumber } catch { }
L "OS build=$build"

if ((-not $prn) -and (-not $drv) -and (-not $mic)) {
    L 'launch mstsc /v (no rdp file => no reputation prompt)'
    Start-Process 'mstsc.exe' -ArgumentList ('/v:' + $rdpHost) -WindowStyle Hidden
    L 'launch complete — exit 0'
    exit 0
}

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
L "rdp written: $rdpFile"
try { Unblock-File -Path $rdpFile -ErrorAction SilentlyContinue } catch { }
try {
    $zi = $rdpFile + ':Zone.Identifier'
    if (Test-Path -LiteralPath $zi) { Remove-Item -LiteralPath $zi -Force }
} catch { }

Start-Process 'mstsc.exe' -ArgumentList ('"' + $rdpFile + '"') -WindowStyle Hidden
L 'mstsc launched'

# ---- Background cleanup: delete .rdp and remove cmdkey after 15s ----
Start-Job -ScriptBlock {
    param($f, $t, $l)
    Start-Sleep -Seconds 15
    try { Remove-Item -LiteralPath $f -Force } catch { }
    & cmdkey /delete:$t >$null 2>&1
    try { [System.IO.File]::AppendAllText($l, ('[' + ([DateTime]::UtcNow.ToString('HH:mm:ss.fff')) + '] cleanup: rdp+cmdkey removed' + "`r`n")) } catch { }
} -ArgumentList $rdpFile, "TERMSRV/$rdpHost", $logFile | Out-Null

L 'launch complete — exit 0'
exit 0
