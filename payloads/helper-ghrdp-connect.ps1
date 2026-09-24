# helper-ghrdp-connect.ps1 - remediated ghrdp:// handler with U4 verb router.
#
# Verbs (parsed from ghrdp://<verb>[?params]):
#   install  - copy self to %LOCALAPPDATA%\ghrdp\ and register HKCU\Software\
#              Classes\ghrdp so ghrdp:// URIs dispatch here. HKCU writes need
#              NO admin / UAC; the machine-wide HKLM class is never touched.
#   setup    - spawn an INTERACTIVE console that runs cmdkey /generic:
#              TERMSRV/<server> /user:<prompted>. Windows prompts for the
#              password inside its own console; this script NEVER sees,
#              stores, transmits, or logs it. /pass: on the command line
#              is banned (would leak plaintext to wmic/ETW/Sysmon).
#   check    - local MessageBox summarising registry presence, cmdkey list
#              lines matching TERMSRV/<server>, and truncated `tailscale
#              status`. Read-only introspection.
#   connect  - existing token-redeem flow. Parses ?server=<fqdn>&t=<tok>,
#              POSTs /api/rdp-creds to get the mstsc FQDN, launches
#              `mstsc /v:<fqdn>` under a per-host mutex. Handler NEVER
#              reads/writes/deletes the stored TERMSRV cred.
#
# Every verb fires-and-forgets POST /api/handler-hello {verb,ok,details}
# when it knows a `server=` to phone (dashboard uses the result to render
# the "last handler action" row). `details` is a short status string;
# credentials are NEVER placed in it.
#
# Discipline (unchanged from P2/P3):
#   - No password fetched, seen, stored, or transmitted by this script.
#   - No cmdkey /pass:  ANYWHERE.  No Unblock-File, no Zone.Identifier strip.
#   - `server=` reaches ghrdp-server API only; NEVER a mstsc target.
#   - mstsc target MUST be a MagicDNS *.ts.net FQDN the server returns.
#   - No NLA / CredSSP suppression; no fPromptForPassword=0; no
#     AuthenticationLevelOverride; no LocalDevices arming; no publisher
#     bypass; no hidden mstsc windows.
param([string]$Url)
$ErrorActionPreference = 'SilentlyContinue'

# ---- logging (structured JSONL per line; no secrets) ---------------------------
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

# ---- parse ghrdp://<verb>[?k=v&...] --------------------------------------------
# Verb = everything between the scheme and the '?' (or end). Query keys
# lower-cased. Missing scheme prefix accepted (some browsers strip it).
$rest = $Url -replace '^ghrdp:(//)?', ''
$verb = ''
$qs = ''
$slash = $rest.IndexOf('/')
if ($slash -ge 0) { $rest = $rest.Substring(0, $slash) + $rest.Substring($slash + 1) }
$qAt = $rest.IndexOf('?')
if ($qAt -ge 0) { $verb = $rest.Substring(0, $qAt); $qs = $rest.Substring($qAt + 1) }
else            { $verb = $rest }
$verb = ($verb -replace '[^A-Za-z]', '').ToLower()
if (-not $verb) { $verb = 'connect' }  # legacy: bare ghrdp:// URL

$p = @{}
foreach ($kv in ($qs -split '&')) {
    $eq = $kv.IndexOf('=')
    if ($eq -gt 0) {
        $k = [uri]::UnescapeDataString($kv.Substring(0, $eq)).ToLower()
        $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
        $p[$k] = $v
    }
}
function Pick { param([string[]]$keys) foreach ($k in $keys) { if ($p.ContainsKey($k) -and $p[$k]) { return [string]$p[$k] } } return '' }
$server = Pick @('server', 'ip', 'host', 'h')
$port   = Pick @('port'); if (-not $port) { $port = '7331' }
$token  = Pick @('token', 't')

# `server=` (when present) is only accepted as a *.ts.net MagicDNS FQDN.
# Bare CGNAT IPs are a stale/spoofed link vector; hard-refuse per U1 tightening.
$serverOk = ($server -and ($server -match '\.ts\.net$'))

# ---- hello beacon (fire-and-forget; skip silently if no server) ----------------
function Send-Hello {
    param([string]$V, [bool]$Ok, [string]$Details)
    if (-not $serverOk) { return }
    try {
        $body = @{ verb = $V; ok = $Ok; details = $Details } | ConvertTo-Json -Compress
        Invoke-RestMethod `
            -Uri ("http://${server}:${port}/api/handler-hello") `
            -Method POST `
            -Body $body `
            -ContentType 'application/json' `
            -TimeoutSec 3 `
            -ErrorAction SilentlyContinue | Out-Null
        A @{ event = 'hello-sent'; verb = $V; ok = $Ok }
    } catch { A @{ event = 'hello-failed'; verb = $V; err = $_.Exception.Message } }
}

# ---- verb: install (HKCU protocol registration; no admin, no UAC) --------------
if ($verb -eq 'install') {
    $ok = $false; $det = ''
    try {
        $target = Join-Path $logDir 'helper-ghrdp-connect.ps1'
        $self = $PSCommandPath
        if (-not $self) { $self = $MyInvocation.MyCommand.Path }
        if ($self -and (Test-Path -LiteralPath $self) -and ($self -ne $target)) {
            Copy-Item -LiteralPath $self -Destination $target -Force -ErrorAction Stop
        }
        # HKCU class registration: user-scope only, no elevation prompt.
        $classPath = 'HKCU:\Software\Classes\ghrdp'
        $cmdPath   = 'HKCU:\Software\Classes\ghrdp\shell\open\command'
        New-Item -Path $classPath -Force | Out-Null
        Set-ItemProperty -Path $classPath -Name '(Default)'   -Value 'URL:GHRDP Protocol' -Force
        Set-ItemProperty -Path $classPath -Name 'URL Protocol' -Value ''                   -Force
        New-Item -Path $cmdPath -Force | Out-Null
        $pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
        if (-not $pwsh) { $pwsh = (Get-Command powershell.exe -ErrorAction Stop).Source }
        $cmdLine = '"' + $pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + $target + '" "%1"'
        Set-ItemProperty -Path $cmdPath -Name '(Default)' -Value $cmdLine -Force
        $ok = $true; $det = "registered HKCU\\Software\\Classes\\ghrdp -> $target"
        A @{ event = 'install-ok'; target = $target }
    } catch {
        $det = 'install failed: ' + $_.Exception.Message
        A @{ event = 'install-failed'; err = $_.Exception.Message }
    }
    Send-Hello -V 'install' -Ok $ok -Details $det
    exit ([int](-not $ok))
}

# ---- verb: setup (interactive cmdkey; password stays in Windows) ---------------
if ($verb -eq 'setup') {
    if (-not $serverOk) {
        A @{ event = 'fatal'; verb = 'setup'; reason = 'server-not-magicdns-fqdn'; server = $server }
        exit 1
    }
    $ok = $false; $det = ''
    try {
        # Spawn an interactive PowerShell console. That console prompts for the
        # username (visible, non-secret) and runs cmdkey; cmdkey then prompts
        # for the password inside its own console. Neither this parent script
        # nor the child ever assigns the password to a variable or a log field.
        # /pass: on the command line is banned - it puts plaintext in the
        # child process command line where wmic / Get-CimInstance / ETW /
        # Sysmon can read it.
        $inner = @"
`$srv = '$server'
Write-Host ''
Write-Host ('  GHRDP setup for ' + `$srv) -ForegroundColor Cyan
Write-Host '  Enter the RDP account username. Windows will then prompt for the'
Write-Host '  password in its own console; nothing is transmitted or logged here.'
Write-Host ''
`$u = Read-Host '  RDP username'
if ([string]::IsNullOrWhiteSpace(`$u)) { Write-Host 'ABORTED - empty username' -ForegroundColor Yellow; Read-Host 'press Enter'; exit 2 }
& cmdkey.exe /generic:('TERMSRV/' + `$srv) /user:`$u
Write-Host ''
Write-Host '  Done. Verify:  cmdkey /list' -ForegroundColor Green
Write-Host ('  Remove later: cmdkey /delete:TERMSRV/' + `$srv)
Read-Host 'press Enter to close'
"@
        $pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
        if (-not $pwsh) { $pwsh = (Get-Command powershell.exe -ErrorAction Stop).Source }
        $proc = Start-Process $pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$inner -Wait -WindowStyle Normal -PassThru
        $ok  = ($proc.ExitCode -eq 0)
        $det = "cmdkey generic TERMSRV/$server (interactive); child exit=$($proc.ExitCode)"
        A @{ event = 'setup-done'; fqdn = $server; exit = $proc.ExitCode }
    } catch {
        $det = 'setup failed: ' + $_.Exception.Message
        A @{ event = 'setup-failed'; err = $_.Exception.Message }
    }
    Send-Hello -V 'setup' -Ok $ok -Details $det
    exit ([int](-not $ok))
}

# ---- verb: check (local MessageBox with read-only diagnostics) -----------------
if ($verb -eq 'check') {
    $regPresent = $false
    try {
        $rp = Get-ItemProperty -Path 'HKCU:\Software\Classes\ghrdp\shell\open\command' -Name '(Default)' -ErrorAction Stop
        if ($rp) { $regPresent = $true }
    } catch { }
    $cmdkeyLine = '(none)'
    try {
        $ck = @(& cmdkey.exe /list 2>$null)
        if ($serverOk) {
            $match = $ck | Where-Object { $_ -match ('TERMSRV/' + [regex]::Escape($server)) } | Select-Object -First 1
            if ($match) { $cmdkeyLine = ($match.Trim()) }
        } elseif ($ck) {
            $anyTs = $ck | Where-Object { $_ -match 'TERMSRV/[^ ]+\.ts\.net' } | Select-Object -First 1
            if ($anyTs) { $cmdkeyLine = 'any TERMSRV/*.ts.net: ' + $anyTs.Trim() }
        }
    } catch { }
    $tsLines = @()
    try { $tsLines = @(& tailscale.exe status 2>$null) } catch { }
    $tsTxt = if ($tsLines.Count -gt 0) { ($tsLines | Select-Object -First 6) -join "`r`n" } else { '(tailscale not on PATH or not running)' }
    if ($tsTxt.Length -gt 500) { $tsTxt = $tsTxt.Substring(0,500) + '...' }
    $msg = @()
    $msg += 'GHRDP Check'
    $msg += ''
    $msg += 'server=       ' + $(if ($server) { $server } else { '(not supplied)' })
    $msg += 'ghrdp:// reg  ' + $(if ($regPresent) { 'PRESENT (HKCU)' } else { 'MISSING - run RUN INSTALL' })
    $msg += 'cmdkey        ' + $cmdkeyLine
    $msg += ''
    $msg += 'tailscale status (first 6 lines):'
    $msg += $tsTxt
    $msgStr = ($msg -join "`r`n")
    try {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        [System.Windows.Forms.MessageBox]::Show($msgStr, 'GHRDP Check', 'OK', 'Information') | Out-Null
    } catch {
        A @{ event = 'check-msgbox-failed'; err = $_.Exception.Message }
    }
    $det = "reg=$regPresent; cmdkey=$($cmdkeyLine.Length -gt 0 -and $cmdkeyLine -ne '(none)'); tsLines=$($tsLines.Count)"
    A @{ event = 'check-done'; regPresent = $regPresent; hasCmdkey = ($cmdkeyLine -ne '(none)'); tsLines = $tsLines.Count }
    Send-Hello -V 'check' -Ok $true -Details $det
    exit 0
}

# ---- verb: connect (unchanged token-redeem flow) -------------------------------
if ($verb -ne 'connect') {
    A @{ event = 'fatal'; reason = 'unknown-verb'; verb = $verb }
    exit 1
}
if (-not $serverOk) { A @{ event = 'fatal'; reason = 'server-not-magicdns-fqdn'; server = $server }; exit 1 }
if (-not $token)    { A @{ event = 'fatal'; reason = 'no-token' }; exit 1 }

# Startup sweep: stale TERMSRV/*.ts.net cmdkey entries (log-only; never delete).
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

# Redeem token for the MagicDNS FQDN via POST body (P3).
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
    Send-Hello -V 'connect' -Ok $false -Details ('redeem-failed: ' + $_.Exception.Message)
    exit 1
}

# ENFORCE: mstsc target must be a MagicDNS FQDN.
if ($rdpHost -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
    A @{ event = 'fatal'; reason = 'server-returned-non-fqdn'; got = $rdpHost }
    Send-Hello -V 'connect' -Ok $false -Details ('non-fqdn: ' + $rdpHost)
    exit 1
}

# Beacon: mark the handler as installed on this PC (drops handler-not-seen).
Send-Hello -V 'connect' -Ok $true -Details ('mstsc /v:' + $rdpHost)

# Per-host mutex: prevent racing / duplicate concurrent mstsc launches.
$mutexName = 'Global\GHRDP-' + ($rdpHost -replace '[^a-zA-Z0-9.-]', '_')
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$held = $false
try {
    $held = $mutex.WaitOne(2000)
    if (-not $held) {
        A @{ event = 'mutex-contended'; mutex = $mutexName; note = 'another handler holds the mutex; skipping' }
        exit 0
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process 'mstsc.exe' -ArgumentList "/v:$rdpHost" -WindowStyle Normal -PassThru
    A @{ event = 'mstsc-started'; fqdn = $rdpHost; pid = $proc.Id }
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
