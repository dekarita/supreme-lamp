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
# Do not put a bearer rid (from the protocol URI) into a local log.
A @{ event = 'invoked' }

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

# ---- parse ghrdp://<verb>?server=<host>&... ------------------------------------
# Verb dispatch: install / setup / check / connect (default). All verbs post a
# handler-hello beacon to /api/handler-hello so the dashboard's probe grid can
# tell what the last click did. Nothing writes creds server-side.
$rest = $Url -replace '^ghrdp:(//)?', '' -replace '^/', ''
$verb = 'connect'
if ($rest -match '^(?<v>[a-z\-]+)\??(?<rest>.*)$') { $verb = $Matches['v'].ToLower(); $rest = $Matches['rest'] }
$p = @{}
foreach ($kv in ($rest -split '&')) {
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
$hUser = Pick @('user', 'u'); if (-not $hUser) { $hUser = 'rdpuser' }

function Send-Hello {
    param([string]$Verb, [bool]$Ok, [string]$Details)
    if (-not $server) { return }
    if ($server -notmatch '\.ts\.net$') { return }
    try {
        $b = @{ verb = $Verb; ok = $Ok; details = $Details } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri ("http://${server}:${port}/api/handler-hello") -Method POST -Body $b -ContentType 'application/json' -TimeoutSec 3 -ErrorAction SilentlyContinue | Out-Null
    } catch { }
}

# ---- verb dispatch: install / setup / check ------------------------------------
if ($verb -eq 'install') {
    # Copy self to %LOCALAPPDATA%\ghrdp\helper-ghrdp-connect.ps1 (canonical) and
    # register HKCU\Software\Classes\ghrdp -> pwsh -File <canonical> "%1". No UAC.
    $canon = Join-Path $logDir 'helper-ghrdp-connect.ps1'
    try {
        if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath) -and ((Resolve-Path -LiteralPath $PSCommandPath).Path -ne (Resolve-Path -LiteralPath $canon -ErrorAction SilentlyContinue).Path)) {
            Copy-Item -LiteralPath $PSCommandPath -Destination $canon -Force
        }
        $cmd = ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" "%1"' -f (Get-Command powershell).Source, $canon)
        $reg = 'HKCU:\Software\Classes\ghrdp'
        New-Item -Path $reg -Force | Out-Null
        Set-ItemProperty -Path $reg -Name '(default)' -Value 'URL:ghrdp Protocol' -Force
        Set-ItemProperty -Path $reg -Name 'URL Protocol' -Value '' -Force
        New-Item -Path (Join-Path $reg 'shell\open\command') -Force | Out-Null
        Set-ItemProperty -Path (Join-Path $reg 'shell\open\command') -Name '(default)' -Value $cmd -Force
        A @{ event = 'install-ok'; canon = $canon }
        Send-Hello -Verb 'install' -Ok $true -Details ("hkcu-registered: " + $canon)
    } catch { A @{ event = 'install-failed'; err = $_.Exception.Message }; Send-Hello -Verb 'install' -Ok $false -Details $_.Exception.Message }
    exit 0
}
if ($verb -eq 'setup') {
    if ($server -notmatch '\.ts\.net$') { A @{ event = 'fatal'; reason = 'setup-server-not-tsnet'; server = $server }; Send-Hello -Verb 'setup' -Ok $false -Details 'server-not-tsnet'; exit 1 }
    # Interactive cmdkey - Windows prompts for the password itself; never
    # echo/log/transmit it. No `/pass:` argument, ever.
    try {
        & cmdkey.exe "/generic:TERMSRV/$server" "/user:$hUser" | Out-Null
        $verifyLine = ((& cmdkey.exe /list 2>$null) | Where-Object { $_ -match "TERMSRV/$([regex]::Escape($server))" }) -join ' '
        $ok = [bool]$verifyLine
        A @{ event = 'setup-done'; ok = $ok; fqdn = $server; user = $hUser }
        Send-Hello -Verb 'setup' -Ok $ok -Details ("target=TERMSRV/$server user=$hUser stored=" + ($ok.ToString().ToLower()))
    } catch { A @{ event = 'setup-failed'; err = $_.Exception.Message }; Send-Hello -Verb 'setup' -Ok $false -Details $_.Exception.Message }
    exit 0
}
if ($verb -eq 'check') {
    $regOk = Test-Path -LiteralPath 'HKCU:\Software\Classes\ghrdp\shell\open\command'
    $ckLine = ''
    try { $ckLine = ((& cmdkey.exe /list 2>$null) | Where-Object { $_ -match 'TERMSRV/[^\s]+\.ts\.net' }) -join ' | ' } catch { }
    $tsOn = $false
    try { $tsStat = & tailscale.exe status --json 2>$null; if ($tsStat) { $tsj = $tsStat | ConvertFrom-Json; if ($tsj.Self.Online) { $tsOn = $true } } } catch { }
    $summary = ("handler-reg={0}; cmdkey={1}; tailscale-online={2}" -f $regOk, ([bool]$ckLine), $tsOn)
    A @{ event = 'check'; details = $summary }
    Send-Hello -Verb 'check' -Ok ($regOk -and [bool]$ckLine) -Details $summary
    # Show a local result box so the user sees something happened (no secrets).
    try { [System.Windows.Forms.MessageBox]::Show($summary, 'ghrdp check', 'OK', 'Information') | Out-Null } catch {
        try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($summary, 'ghrdp check', 'OK', 'Information') | Out-Null } catch { Write-Host $summary }
    }
    exit 0
}
# [U5d] verb=direct - open a VISIBLE mstsc window against `server=<fqdn>` with no
# token redemption, no cred stashing, no /pass:, no .rdp file. The user's own
# per-user TERMSRV/<fqdn> cmdkey (§1.4) is consumed silently by mstsc via NLA +
# CredSSP against the tailnet LE-bound listener. Useful when the dashboard is
# unreachable (offline runner) but the user still has a valid cmdkey and wants
# a manual auto-login click.
if ($verb -eq 'direct') {
    if ($server -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
        A @{ event = 'fatal'; reason = 'direct-server-not-fqdn'; server = $server }
        Send-Hello -Verb 'direct' -Ok $false -Details 'server-not-tsnet'
        exit 1
    }
    $ok = $false; $details = ''
    try {
        $proc = Start-Process 'mstsc.exe' -ArgumentList "/v:$server" -WindowStyle Normal -PassThru -ErrorAction Stop
        $ok = ($null -ne $proc -and $proc.Id -gt 0)
        $details = ("fqdn=" + $server + "; pid=" + $(if ($proc) { $proc.Id } else { -1 }))
        A @{ event = 'direct-started'; fqdn = $server; pid = $(if ($proc) { $proc.Id } else { -1 }) }
    } catch {
        $details = $_.Exception.Message
        A @{ event = 'direct-failed'; err = $details }
    }
    Send-Hello -Verb 'direct' -Ok $ok -Details $details
    exit 0
}
# fall through: verb=connect (default)

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
    $rdpHost = [string]$resp.fqdn
    A @{ event = 'redeemed'; server = $server; fqdn = $rdpHost }
} catch {
    A @{ event = 'redeem-failed'; err = $_.Exception.Message }
    exit 1
}

# ---- [U3c/U4] handler-hello beacon (fire-and-forget) ---------------------------
# Signals to /api/native-status that this client PC has the handler installed;
# the dashboard flips 'Handler' from missing -> installed and drops the
# 'handler-not-seen' reason. verb=connect so lastHandlerVerb reflects the
# actual click. Never blocks the mstsc launch on network errors.
Send-Hello -Verb 'connect' -Ok $true -Details ("fqdn=" + $rdpHost)
A @{ event = 'handler-hello-sent'; server = $server }

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
