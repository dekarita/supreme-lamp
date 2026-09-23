# helper-ghrdp-connect.ps1 - remediated ghrdp:// handler.
# Flow: parse ghrdp://connect?server=<ip>&t=<token> -> redeem the one-time token for the HOST only
#       -> launch mstsc /v:<host>.
# Credentials come from the user's OWN Windows Credential Manager entry (created once, interactively).
# This handler NEVER fetches, sees, or stores a password; it writes no local RDP config file, does no
# Mark-of-the-Web handling, sets no auth-suppression flags, and uses a normal window.
param([string]$Url)
$ErrorActionPreference = 'SilentlyContinue'
$logDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'ghrdp-connect.log'
function L($m) { try { [System.IO.File]::AppendAllText($logFile, ('[' + ([DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss')) + '] ' + $m + "`r`n")) } catch { } }
L '=== ghrdp handler invoked ==='
L "url=$Url"

# ---- parse ghrdp://connect?server=<ip>&t=<token> ----
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
$server = Pick @('server', 'ip', 'host', 'h')
$port = Pick @('port'); if (-not $port) { $port = '7331' }
$token = Pick @('token', 't')

# ---- resolve HOST only (never credentials) ----
$rdpHost = ''
if ($token -and $server) {
    try {
        $resp = Invoke-RestMethod -Uri ("http://${server}:${port}/api/rdp-creds?token=" + [uri]::EscapeDataString($token)) -TimeoutSec 5 -ErrorAction Stop
        $rdpHost = [string]$resp.host
        L "resolved host via token: $rdpHost"
    } catch { L "token host-resolve failed: $($_.Exception.Message)" }
}
if (-not $rdpHost) { $rdpHost = $server }
if (-not $rdpHost) { L 'FATAL: no host resolved (no token result and no server= in URL)'; exit 0 }

# ---- launch mstsc against the host ----
# No credentials are passed. mstsc uses the user's own Credential Manager entry for the host, created
# once by the user via Windows Credential Manager. With NLA/CredSSP and a trusted server certificate,
# this connects with zero prompts and zero warnings - no suppression needed.
Start-Process 'mstsc.exe' -ArgumentList "/v:$rdpHost" -WindowStyle Normal
L "mstsc launched for $rdpHost"
exit 0
