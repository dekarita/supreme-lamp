# helper-ghrdp-connect.ps1 - remediated ghrdp:// handler.
#
# Flow: parse ghrdp://connect?server=<tailnet-ip-or-fqdn>&t=<token>
#       -> sweep stale TERMSRV/*.ts.net cmdkey entries (log-only)
#       -> POST /api/rdp-creds with {token:...} to get the RDP FQDN
#       -> acquire Global\GHRDP-<fqdn> mutex (prevents concurrent mstsc races)
#       -> launch `mstsc /v:<fqdn>.<tailnet>.ts.net`
#       -> release mutex on exit.
#
# Discipline:
#   - `server=` reaches the ghrdp-server API only. It is NEVER the mstsc target.
#   - The mstsc target MUST be the MagicDNS FQDN the server returns. Any other
#     shape (IP, non-.ts.net, empty) is a hard fail.
#   - Token is redeemed via POST body only (P3). GET was deprecated because it
#     leaks the token to browser history / access logs / proxies.
#   - No password is fetched, seen, or stored. The user's cmdkey entry for
#     TERMSRV/<fqdn> handles auth; NLA/CredSSP + tailnet LE cert => zero prompts,
#     zero warnings, zero suppression flags.
#   - This script writes no local RDP config file, does no Mark-of-the-Web
#     handling, sets no auth-suppression flags, and uses a normal window.
param([string]$Url)
$ErrorActionPreference = 'SilentlyContinue'

# ---- logging (structured JSONL per line) ---------------------------------------
$logDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'ghrdp-connect.log'
function A {
    param([hashtable]$Fields)
    try {
        $Fields['ts'] = [DateTime]::UtcNow.ToString('o')
        $line = ($Fields | ConvertTo-Json -Compress -Depth 4)
        [System.IO.File]::AppendAllText($logFile, $line + "`r`n")
    } catch { }
}
A @{ event = 'invoked'; url = $Url }

# ---- P3 startup sweep: stale TERMSRV/*.ts.net entries (log-only) ---------------
# We do NOT delete. Users may keep entries for hosts they aren't reaching this
# session but still want. Report them so the user (or ghrdp-uninstall.ps1) can
# clean them up deliberately.
try {
    $cklist = @(& cmdkey /list 2>$null)
    foreach ($line in $cklist) {
        if ($line -match 'Target:\s+(?:LegacyGeneric:target=)?TERMSRV/([^\s]+\.ts\.net)') {
            $t = $matches[1]
            $resolves = $false
            try {
                $r = [System.Net.Dns]::GetHostEntry($t)
                if ($r -and $r.AddressList -and $r.AddressList.Count -gt 0) { $resolves = $true }
            } catch { }
            if (-not $resolves) { A @{ event = 'stale-cmdkey'; target = "TERMSRV/$t"; note = 'DNS did not resolve; entry may be orphaned' } }
        }
    }
} catch { A @{ event = 'sweep-error'; err = $_.Exception.Message } }

# ---- parse ghrdp://connect?server=<host>&t=<token> -----------------------------
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

# ---- validate the API endpoint reachability parameter --------------------------
# [U1 tightening] Accept ONLY *.ts.net MagicDNS FQDNs; drop the raw 100.64.0.0/10
# tailnet-CGNAT IP fallback. The dashboard is reached at its MagicDNS name (bound
# to the LE cert), so an IP `server=` value would mean either a stale link or a
# spoofed one; hard-fail without redemption.
$apiHostOk = ($server -and ($server -match '\.ts\.net$'))
if (-not $apiHostOk) { A @{ event = 'fatal'; reason = 'server-not-magicdns-fqdn'; server = $server }; exit 1 }
if (-not $token)     { A @{ event = 'fatal'; reason = 'no-token' }; exit 1 }

# ---- redeem token for the MagicDNS FQDN via POST body (P3) ---------------------
$rdpHost = ''
try {
    $bodyJson = @{ token = $token } | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod `
        -Uri ("http://${server}:${port}/api/rdp-creds") `
        -Method POST `
        -Body $bodyJson `
        -ContentType 'application/json' `
        -TimeoutSec 5 `
        -ErrorAction Stop
    $rdpHost = [string]$resp.host
    A @{ event = 'redeemed'; server = $server; fqdn = $rdpHost }
} catch {
    A @{ event = 'redeem-failed'; err = $_.Exception.Message }
    exit 1
}

# ---- ENFORCE: mstsc target must be a MagicDNS FQDN -----------------------------
if ($rdpHost -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
    A @{ event = 'fatal'; reason = 'server-returned-non-fqdn'; got = $rdpHost }
    exit 1
}

# ---- P3 per-host mutex: prevent racing / duplicate concurrent mstsc launches ---
$mutexName = 'Global\GHRDP-' + ($rdpHost -replace '[^a-zA-Z0-9.-]', '_')
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$held = $false
try {
    $held = $mutex.WaitOne(2000)  # 2s: another launch in flight? bail.
    if (-not $held) {
        A @{ event = 'mutex-contended'; mutex = $mutexName; note = 'another handler holds the mutex; skipping' }
        exit 0
    }

    # ---- launch mstsc against the FQDN --------------------------------------
    # No credentials are passed. mstsc uses the user's own TERMSRV/<fqdn>
    # cmdkey entry (created interactively via `cmdkey /generic:TERMSRV/<fqdn>
    # /user:<user>`, password typed at the prompt - never on the command line).
    # NLA + CredSSP + tailnet LE cert => zero prompts, zero warnings.
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process 'mstsc.exe' -ArgumentList "/v:$rdpHost" -WindowStyle Normal -PassThru
    A @{ event = 'mstsc-started'; fqdn = $rdpHost; pid = $proc.Id }

    # Wait long enough for mstsc to establish (or bail if it dies fast). We do
    # NOT block the URI-handler indefinitely - hold the mutex only through the
    # startup window. If mstsc closes fast (auth failure), record exit code.
    try {
        if ($proc.WaitForExit(1500)) {
            A @{ event = 'mstsc-exited-fast'; fqdn = $rdpHost; exit = $proc.ExitCode; ms = $sw.ElapsedMilliseconds }
        } else {
            A @{ event = 'mstsc-running'; fqdn = $rdpHost; ms = $sw.ElapsedMilliseconds }
        }
    } catch { A @{ event = 'mstsc-wait-error'; err = $_.Exception.Message } }
}
finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit 0
