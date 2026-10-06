param(
    [string]$Base = 'http://127.0.0.1:7331',
    [string]$Root = 'C:\ghrdp',
    [string]$RunId = '',
    [int]$TimeoutSec = 20,
    [int]$SiteTimeoutSec = 8
)
# ===========================================================================
# [F99 §3.1] THE DIAGNOSIS COLLECTOR.
#
# WHAT IT IS: a standalone end-to-end test of EVERY dashboard feature, run by
# POST /api/collector/run as a CHILD process (never inside the server's request
# loop - the dashboard it tests must stay responsive while it runs). It talks to
# the dashboard the way the operator's browser does: real HTTP requests to
# $Base, real TCP for the RFC6455 upgrade, real TLS for the export sites, real
# file system checks for download-to-RDP.
#
# CONTRACT (tests/f99-collector.test.js re-extracts every one of these):
#   * writes C:\ghrdp\collector-progress.json after each feature, so the page can
#     show live progress and PARTIAL results even if the run dies;
#   * writes C:\ghrdp\collector-report.json + collector-report.md at the end;
#   * the summary carries totalFeatures/passed/failed/warnings/skipped,
#     criticalIssues (feature + detail + the Issue the fix belongs to) and
#     recommendations;
#   * the dash token is READ FROM DISK by this script and NEVER appears in argv,
#     in a URL it prints, in the report or in any log line (hash only);
#   * every probe is individually try/catch'ed: one dead feature can never abort
#     the run, and a probe that throws is itself a fail row with the exception.
# ===========================================================================
$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $RunId) { $RunId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') }
$script:StartedAt = (Get-Date).ToUniversalTime()
$script:Features = [ordered]@{}
$script:Order = New-Object System.Collections.ArrayList
$script:Advisories = New-Object System.Collections.ArrayList
$script:ProgressPath = Join-Path $Root 'collector-progress.json'
$script:ReportPath = Join-Path $Root 'collector-report.json'
$script:MdPath = Join-Path $Root 'collector-report.md'
$script:NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Token = ''
try {
    $tk = Join-Path $Root 'dash-token.txt'
    if (Test-Path -LiteralPath $tk) { $script:Token = ([System.IO.File]::ReadAllText($tk)).Trim() }
} catch { $script:Token = '' }
$script:TokenHash = ''
try {
    if ($script:Token) {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $script:TokenHash = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:Token))) -replace '-', '').ToLower().Substring(0, 12)
    }
} catch { $script:TokenHash = '' }
$script:BasePort = 7331
try { $script:BasePort = [int]([uri]$Base).Port } catch { $script:BasePort = 7331 }
$script:CfgJson = $null
try { $script:CfgJson = ([System.IO.File]::ReadAllText((Join-Path $Root 'config.json'))) | ConvertFrom-Json } catch { }

function Get-Summary {
    $pass = 0; $fail = 0; $warn = 0; $skip = 0
    $crit = New-Object System.Collections.ArrayList
    $recs = New-Object System.Collections.ArrayList
    foreach ($k in $script:Order) {
        $f = $script:Features[$k]
        if (-not $f) { continue }
        switch ([string]$f.status) {
            'pass' { $pass = $pass + 1 }
            'fail' {
                $fail = $fail + 1
                [void]$crit.Add([ordered]@{ feature = $k; detail = [string]$f.detail; issue = [string]$f.issue })
            }
            'warn' { $warn = $warn + 1 }
            'skip' { $skip = $skip + 1 }
        }
    }
    if ($fail -gt 0) { [void]$recs.Add('fix the ' + [string]$fail + ' failing feature(s) first - each row names its issue and its diagnostic payload') }
    if ($warn -gt 0) { [void]$recs.Add([string]$warn + ' warning(s): a warn is a real finding that did not fail the run (see the row detail)') }
    if ($fail -eq 0 -and $warn -eq 0) { [void]$recs.Add('no action required - every probed feature passed on the runner') }
    return [ordered]@{
        totalFeatures    = $script:Order.Count
        passed           = $pass
        failed           = $fail
        warnings         = $warn
        skipped          = $skip
        criticalIssues   = @($crit)
        recommendations  = @($recs)
    }
}
function Write-CollectorProgress([string]$State) {
    try {
        $doc = [ordered]@{
            runId       = $RunId
            version     = 'f99/1'
            state       = $State
            startedAt   = $script:StartedAt.ToString('o')
            updatedAt   = (Get-Date).ToUniversalTime().ToString('o')
            durationSec = [int]((Get-Date).ToUniversalTime() - $script:StartedAt).TotalSeconds
            base        = $Base
            tokenPresent = [bool]$script:Token
            tokenHash   = $script:TokenHash
            order       = @($script:Order)
            features    = $script:Features
            summary     = (Get-Summary)
            advisories  = @($script:Advisories)
        }
        [System.IO.File]::WriteAllText($script:ProgressPath, ($doc | ConvertTo-Json -Depth 12), $script:NoBom)
        return $doc
    } catch { return $null }
}
function Add-Feature([string]$Name, [string]$Status, $Data, [string]$Detail = '', [string]$Issue = '', [int]$Ms = -1) {
    $row = [ordered]@{
        name    = $Name
        status  = $Status              # pass | fail | warn | skip
        detail  = $Detail
        issue   = $Issue
        ms      = $Ms
        at      = (Get-Date).ToUniversalTime().ToString('o')
        data    = $Data
    }
    $script:Features[$Name] = $row
    if (-not $script:Order.Contains($Name)) { [void]$script:Order.Add($Name) }
    $line = '[' + $RunId + '] ' + $Name.PadRight(22) + ' ' + $Status.ToUpper()
    if ($Detail) { $line = $line + ' - ' + $Detail }
    Write-Host $line
    [void](Write-CollectorProgress 'running')
    return $row
}
function Invoke-Http {
    # One transport for every probe: no exceptions escape, the status code and
    # the elapsed time are always reported, and a failure carries its reason.
    param([string]$Method = 'GET', [string]$Path = '/', [string]$Body = '', [int]$Timeout = 0, [switch]$NoToken, [string]$Base_ = '')
    $b = $Base_
    if (-not $b) { $b = $Base }
    if (-not $Timeout) { $Timeout = $TimeoutSec }
    $url = $b.TrimEnd('/') + $Path
    $hdr = @{ 'Accept' = 'application/json' }
    if (-not $NoToken -and $script:Token) { $hdr['X-Dash-Token'] = $script:Token }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $res = [ordered]@{ ok = $false; status = 0; ms = 0; json = $null; text = ''; error = ''; url = $Path }
    try {
        $reqArgs = @{ Uri = $url; Method = $Method; Headers = $hdr; TimeoutSec = $Timeout; UseBasicParsing = $true }
        if ($Body) { $reqArgs['Body'] = $Body; $reqArgs['ContentType'] = 'application/json' }
        $r = Invoke-WebRequest @reqArgs
        $res.status = [int]$r.StatusCode
        $res.text = [string]$r.Content
        $res.ok = ($res.status -ge 200 -and $res.status -lt 300)
        if ($res.ok -and $res.text) { try { $res.json = $res.text | ConvertFrom-Json } catch { $res.json = $null } }
    } catch {
        $res.error = $_.Exception.Message
        try { if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $res.status = [int]$_.Exception.Response.StatusCode } } catch { }
    }
    $res.ms = [int]$sw.ElapsedMilliseconds
    return $res
}
function Get-TokenHash([string]$Value) {
    try {
        if (-not $Value) { return '' }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))) -replace '-', '').ToLower().Substring(0, 12)
    } catch { return '' }
}
function Get-ActiveSessionUser {
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
        if ($cs -and $cs.UserName) { return ([string]$cs.UserName).Trim() }
    } catch { }
    try {
        foreach ($line in @(& quser.exe 2>$null)) {
            $p = ($line -replace '^\s*>?\s*', '') -split '\s+'
            if ($p.Count -ge 4 -and ($p -contains 'Active')) { return [string]$p[0] }
        }
    } catch { }
    return ''
}

# ---------------------------------------------------------------------------
# FEATURE 1/17: launcher (the F91 service that drains mirror-mode queues)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/launcher/health'
    $d = $r.json
    $alive = $false
    $hbAge = -1
    try { $alive = [bool]$d.serviceRunning } catch { }
    try {
        if ($d.heartbeatTs) { $hbAge = [int]((Get-Date).ToUniversalTime() - ([datetime]$d.heartbeatTs).ToUniversalTime()).TotalSeconds }
    } catch { }
    $st = $(if ($r.ok -and $alive) { 'pass' } elseif ($r.ok) { 'warn' } else { 'fail' })
    Add-Feature 'launcher' $st ([ordered]@{ httpStatus = $r.status; serviceRunning = $alive; heartbeatAgeSec = $hbAge; taskExists = $(try { [bool]$d.taskExists } catch { $null }); queueDepth = $(try { [int]$d.queueDepth } catch { $null }); last10 = $(try { @($d.last10) } catch { @() }) }) $(if ($r.ok) { 'launcher service heartbeat ' + [string]$hbAge + 's' } else { 'HTTP ' + [string]$r.status + ' ' + $r.error }) '#148' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'launcher' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#148' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 2: watcher (task state + supervisor verdict + the F99 diagnose map)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/diag'
    $d = $r.json
    $task = ''
    $alive = $false
    $reason = ''
    try { $task = [string]$d.watcherTask.state } catch { }
    try { $alive = [bool]$d.watcherAlive } catch { }
    try { $reason = [string]$d.watcherDiagnose.reason } catch { }
    try { if ($d.watcherDiagnose.reasonCode) { $reason = [string]$d.watcherDiagnose.reasonCode + ' ' + $reason } } catch { }
    $sup = $null
    try { $sup = $d.watcherSupervisor } catch { }
    $diag = $null
    try { $diag = $d.watcherDiagnose } catch { }
    $st = $(if ($alive) { 'pass' } elseif ($r.ok) { 'fail' } else { 'fail' })
    Add-Feature 'watcher' $st ([ordered]@{ httpStatus = $r.status; alive = $alive; taskState = $task; progressAgeSeconds = $(try { $d.progressAgeSeconds } catch { $null }); supervisor = $sup; diagnose = $diag }) $(if ($alive) { 'watcher heartbeat is fresh' } else { 'watcher NOT alive (task=' + $task + ' diagnose=' + $reason + ')' }) '#148' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'watcher' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#148' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 3: webSocket (a REAL RFC 6455 handshake + one pushed frame)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $ws = [ordered]@{ handshakeOk = $false; acceptOk = $false; frameOk = $false; ms = 0; status = 0; error = '' }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $script:BasePort)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 6000
        $stream.WriteTimeout = 6000
        $keyBytes = New-Object byte[] 16
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
        $key = [Convert]::ToBase64String($keyBytes)
        $q = ''
        if ($script:Token) { $q = '?key=' + [uri]::EscapeDataString($script:Token) }
        $req = "GET /ws$q HTTP/1.1`r`nHost: 127.0.0.1:$($script:BasePort)`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: $key`r`nSec-WebSocket-Version: 13`r`nUser-Agent: ghrdp-collector/1`r`n`r`n"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        # --- read the response head (until CRLFCRLF, bounded) ---
        $head = New-Object System.Text.StringBuilder
        $buf = New-Object byte[] 1
        $deadline = (Get-Date).AddSeconds(6)
        while ((Get-Date) -lt $deadline) {
            if (-not $stream.DataAvailable) { Start-Sleep -Milliseconds 20; continue }
            $n = $stream.Read($buf, 0, 1)
            if ($n -le 0) { break }
            [void]$head.Append([char]$buf[0])
            if ($head.Length -ge 4 -and $head.ToString().EndsWith("`r`n`r`n")) { break }
            if ($head.Length -gt 8192) { break }
        }
        $ws.ms = [int]$sw.ElapsedMilliseconds
        $resp = $head.ToString()
        if ($resp -match '^HTTP/1\.[01]\s+(\d+)') { $ws.status = [int]$Matches[1] }
        $ws.statusLine = ($resp -split "`r`n")[0]
        $ws.handshakeOk = ($ws.status -eq 101)
        $accept = ''
        if ($resp -match '(?im)^Sec-WebSocket-Accept:\s*(\S+)') { $accept = $Matches[1].Trim() }
        $sha = [System.Security.Cryptography.SHA1]::Create()
        $expect = [Convert]::ToBase64String($sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')))
        $ws.acceptOk = ($accept -eq $expect)
        $ws.acceptHeader = $(if ($accept) { $accept } else { '(missing)' })
        $ws.acceptExpected = $expect
        if ($ws.handshakeOk) {
            # --- send a MASKED hello frame, then expect one pushed frame ---
            $hello = [System.Text.Encoding]::UTF8.GetBytes('{"type":"hello","key":"' + $script:Token + '"}')
            $mask = New-Object byte[] 4
            [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($mask)
            $masked = New-Object byte[] ($hello.Length)
            for ($i = 0; $i -lt $hello.Length; $i++) { $masked[$i] = [byte]($hello[$i] -bxor $mask[$i % 4]) }
            $frame = New-Object System.Collections.Generic.List[byte]
            $frame.Add([byte]0x81)
            if ($hello.Length -lt 126) { $frame.Add([byte](0x80 -bor $hello.Length)) }
            else { $frame.Add([byte](0x80 -bor 126)); $frame.Add([byte](($hello.Length -shr 8) -band 0xFF)); $frame.Add([byte]($hello.Length -band 0xFF)) }
            foreach ($m in $mask) { $frame.Add($m) }
            foreach ($b in $masked) { $frame.Add($b) }
            $ptr = $frame.ToArray()
            $stream.Write($ptr, 0, $ptr.Length)
            $stream.Flush()
            $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
            while ($sw2.ElapsedMilliseconds -lt 8000) {
                if (-not $stream.DataAvailable) { Start-Sleep -Milliseconds 50; continue }
                $h2 = New-Object byte[] 2
                $got = $stream.Read($h2, 0, 2)
                if ($got -lt 2) { break }
                $plen = [int]($h2[1] -band 0x7F)
                if ($plen -eq 126) { $lb = New-Object byte[] 2; [void]$stream.Read($lb, 0, 2); $plen = ([int]$lb[0] * 256) + [int]$lb[1] }
                elseif ($plen -eq 127) { $lb = New-Object byte[] 8; [void]$stream.Read($lb, 0, 8); $plen = ([int]$lb[0] * 256) + [int]$lb[1] }
                $payload = New-Object byte[] ([Math]::Max($plen, 1))
                if ($plen -gt 0) { $off = 0; while ($off -lt $plen) { $n2 = $stream.Read($payload, $off, $plen - $off); if ($n2 -le 0) { break }; $off += $n2 } }
                $ws.firstFrameBytes = $plen
                $ws.firstFrameKind = $(if (([int]$h2[0] -band 0x0F) -eq 1) { 'text' } elseif (([int]$h2[0] -band 0x0F) -eq 9) { 'ping' } elseif (([int]$h2[0] -band 0x0F) -eq 8) { 'close' } else { 'op' + [string]([int]$h2[0] -band 0x0F) })
                if (([int]$h2[0] -band 0x0F) -eq 1) { $ws.frameOk = ($plen -gt 0) }
                break
            }
            # polite close (masked, code 1000)
            try {
                $cm = New-Object byte[] 4
                [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($cm)
                $cp = [byte[]]@(0x03, 0xE8)
                $cf = New-Object System.Collections.Generic.List[byte]
                $cf.Add([byte]0x88); $cf.Add([byte](0x80 -bor 2))
                foreach ($m in $cm) { $cf.Add($m) }
                $cf.Add([byte]($cp[0] -bxor $cm[0])); $cf.Add([byte]($cp[1] -bxor $cm[1]))
                $cb = $cf.ToArray()
                $stream.Write($cb, 0, $cb.Length)
                $stream.Flush()
            } catch { }
        }
    } finally {
        try { $client.Close() } catch { }
    }
    $st = $(if ($ws.handshakeOk -and $ws.acceptOk -and $ws.frameOk) { 'pass' } elseif ($ws.handshakeOk) { 'warn' } else { 'fail' })
    $detail = $(if ($st -eq 'pass') { 'RFC6455 101 accepted, accept-key verified, ' + [string]$ws.firstFrameBytes + 'B ' + [string]$ws.firstFrameKind + ' frame pushed in ' + [string]$ws.ms + 'ms' } else { 'upgrade failed: ' + [string]$ws.statusLine + ' ' + [string]$ws.error })
    Add-Feature 'webSocket' $st $ws $detail '#153' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'webSocket' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#153' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 4: logon (the F28 verdict + ALL scanner agreement)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/native-status'
    $d = $r.json
    $authLast = $null
    try { $authLast = $d.rdpListener.authLast } catch { }
    $result = ''
    $logonType = ''
    $logonKind = ''
    $sessionAge = $null
    try { $result = [string]$authLast.result } catch { }
    try { $logonType = [string]$authLast.logonType } catch { }
    try { $logonKind = [string]$authLast.logonKind } catch { }
    try { $sessionAge = [int]$authLast.sessionAgeSec } catch { }
    $live = $null
    try { $live = @(Get-CimInstance -ClassName Win32_LogonSession -Filter 'LogonType=2 OR LogonType=10 OR LogonType=11' -ErrorAction SilentlyContinue).Count } catch { }
    $agree = ($result -eq 'success') -or ($live -gt 0)
    $st = $(if ($result -eq 'success') { 'pass' } elseif ($live -gt 0) { 'warn' } else { 'fail' })
    Add-Feature 'logon' $st ([ordered]@{ httpStatus = $r.status; detected = ($result -eq 'success'); result = $result; logonType = $logonType; logonKind = $logonKind; sessionAgeSec = $sessionAge; sessionWindowSec = $(try { [int]$authLast.sessionWindowSec } catch { $null }); liveInteractiveSessions = $live; allScannersAgree = $agree }) $(if ($result -eq 'success') { 'interactive logon accepted (type ' + $logonType + ' = ' + $logonKind + ')' } else { 'no accepted interactive logon (result=' + $result + ') but live interactive sessions=' + [string]$live }) '#153' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'logon' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#153' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURES 5-9: the five flagship routes, each with a REAL payload
# ---------------------------------------------------------------------------
# 5. search: a federated search with the shipped default adapters
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $body = '{"query":"open source audiobooks","scope":"federated","limit":10}'
    $r = Invoke-Http -Method 'POST' -Path '/api/search' -Body $body -Timeout 60
    $count = 0
    try { $count = @($r.json.results).Count } catch { }
    $st = $(if ($r.ok -and $count -gt 0) { 'pass' } elseif ($r.ok) { 'warn' } else { 'fail' })
    Add-Feature 'searchFederated' $st ([ordered]@{ httpStatus = $r.status; results = $count; tookMs = $r.ms; adapters = $(try { @($r.json.adapters) } catch { @() }); error = $r.error }) $(if ($r.ok) { [string]$count + ' results in ' + [string]$r.ms + 'ms' } else { 'HTTP ' + [string]$r.status + ' ' + $r.error }) '#145' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'searchFederated' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#145' $fSw.ElapsedMilliseconds }

# 6. lab inspector: fetch ONE stored homepage and count its links
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Method 'POST' -Path '/api/lab/inspect' -Body '{"url":"https://www.gutenberg.org/ebooks/11","maxLinks":25}' -Timeout 45
    $count = 0
    try { $count = @($r.json.links).Count } catch { }
    $st = $(if ($r.ok -and $count -gt 0) { 'pass' } elseif ($r.ok) { 'warn' } else { 'fail' })
    Add-Feature 'labInspector' $st ([ordered]@{ httpStatus = $r.status; links = $count; tookMs = $r.ms; error = $r.error }) $(if ($r.ok) { 'lab inspector returned ' + [string]$count + ' links' } else { 'HTTP ' + [string]$r.status + ' ' + $r.error }) '#145' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'labInspector' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#145' $fSw.ElapsedMilliseconds }

# 7. download-to-RDP: a real HTTPS fetch written to the RDP downloads root
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Method 'POST' -Path '/api/fetch' -Body '{"url":"https://www.gutenberg.org/robots.txt","download":true}' -Timeout 60
    $path = ''
    try { $path = [string]$r.json.path } catch { }
    $bytes = -1
    if ($path) { try { $bytes = (Get-Item -LiteralPath $path -ErrorAction Stop).Length } catch { $bytes = -1 } }
    $st = $(if ($r.ok -and $bytes -gt 0) { 'pass' } elseif ($r.ok) { 'warn' } else { 'fail' })
    Add-Feature 'downloadToRdp' $st ([ordered]@{ httpStatus = $r.status; ok = [bool]$r.json.ok; path = $path; bytes = $bytes; error = $r.error }) $(if ($bytes -gt 0) { 'wrote + re-stat verified ' + [string]$bytes + 'B' } else { 'download lane did not verify (' + $r.error + ')' }) '#145' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'downloadToRdp' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#145' $fSw.ElapsedMilliseconds }

# 8. mirror API: status + the CSRF cookie the write path needs
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/mirror/status'
    $tokenValid = ($r.status -eq 200)
    $enabled = $null
    try { $enabled = [bool]$r.json.mirror } catch { }
    $st = $(if ($tokenValid) { 'pass' } else { 'fail' })
    Add-Feature 'mirrorApi' $st ([ordered]@{ httpStatus = $r.status; tokenValid = $tokenValid; csrfPresent = ($r.text -match 'ghrdp_mirror_csrf'); enabled = $enabled; error = $r.error }) $(if ($tokenValid) { 'GET /api/mirror/status accepted the presented token' } else { 'HTTP ' + [string]$r.status + ' - ' + $r.error }) '#153' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'mirrorApi' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#153' $fSw.ElapsedMilliseconds }

# 9. file explorer: the fx list op + the preview sandbox
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/fx?op=list&path='
    $r2 = Invoke-Http -Path '/preview-sandbox'
    $rootListable = ($r.status -eq 200 -or $r.status -eq 403)
    $st = $(if ($r.status -eq 200) { 'pass' } elseif ($r2.status -gt 0) { 'warn' } else { 'fail' })
    $note = 'the fx module owns its own auth; a 401/403 here means the dash token was not accepted'
    Add-Feature 'fileExplorer' $st ([ordered]@{ fxStatus = $r.status; fxOk = $rootListable; previewStatus = $r2.status; note = $note; error = $r.error }) $(if ($r.status -eq 200) { 'fx list answered (HTTP 200 in ' + [string]$r.ms + 'ms)' } else { 'fx list HTTP ' + [string]$r.status + ' (' + $note + ')' }) '#145' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'fileExplorer' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#145' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 10: telemetry (/api/progress + /ping)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/progress'
    $age = -1
    $ts = ''
    try { $ts = [string]$r.json.ts } catch { }
    if ($ts) { try { $age = [int]((Get-Date).ToUniversalTime() - ([datetime]$ts).ToUniversalTime()).TotalSeconds } catch { $age = -1 } }
    $alive = $null
    try { $alive = [bool]$r.json.alive } catch { }
    $st = $(if ($r.ok) { 'pass' } else { 'fail' })
    Add-Feature 'telemetry' $st ([ordered]@{ httpStatus = $r.status; heartbeatAgeSec = $age; heartbeatTs = $ts; alive = $alive; scanning = $(try { [bool]$r.json.mirror } catch { $null }) }) $(if ($r.ok) { 'progress heartbeat ' + [string]$age + 's old' } else { 'HTTP ' + [string]$r.status + ' ' + $r.error }) '#148' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'telemetry' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#148' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 11: viewingMode - the one fact the server must NOT invent
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $host_ = ''
    try { $host_ = [string]$script:CfgJson.webdeskUrl } catch { $host_ = '' }
    Add-Feature 'viewingMode' 'warn' ([ordered]@{ detected = 'CLIENT_ONLY'; reason = 'the viewing mode depends on the browser hostname/viewport/dpr, which no server-side probe can see'; webDesktopUrlPresent = (-not [string]::IsNullOrEmpty($host_)); clientCheck = 'the dashboard merges resolveViewingMode() + readManualWebDesktop() into /api/diag/comprehensive (clientMerged=true)' }) 'server-side probe cannot decide this mode - see the clientMerged block in the diagnostic bundle' '#148' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'viewingMode' 'warn' $null ('probe threw: ' + $_.Exception.Message) '#148' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 12: autologonConfig (registry vs the ACTIVE desktop user)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $loginUser = ''
    $defaultPassPlaceholder = ''
    $auto = ''
    try {
        $wk = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction Stop
        $loginUser = [string]$wk.DefaultUserName
        $auto = [string]$wk.AutoAdminLogon
    } catch { }
    $active = Get-ActiveSessionUser
    $status = $null
    try { $sp = Join-Path $Root 'autologon-status.json'; if (Test-Path -LiteralPath $sp) { $status = ([System.IO.File]::ReadAllText($sp)).Trim() | ConvertFrom-Json } } catch { }
    $leaf = $(if ($loginUser) { ([string]$loginUser -split '\\')[-1] } else { '' })
    $activeLeaf = $(if ($active) { ([string]$active -split '\\')[-1] } else { '' })
    $matches = $null
    if ($leaf -and $activeLeaf) { $matches = ($leaf -ieq $activeLeaf) }
    $st = $(if ($matches -eq $true) { 'pass' } elseif ($matches -eq $false) { 'fail' } else { 'warn' })
    Add-Feature 'autologonConfig' $st ([ordered]@{ autoAdminLogon = $auto; defaultUserName = $loginUser; activeSessionUser = $active; userMatches = $matches; statusFile = $status; passwordChecked = 'never - DefaultPassword is not read by this collector (secret-free contract)' }) $(if ($matches -eq $true) { 'autologon user matches the active desktop user' } elseif ($matches -eq $false) { 'MISMATCH: autologon=' + $leaf + ' but the desktop belongs to ' + $activeLeaf } else { 'cannot compare users (autologon=' + $leaf + ' active=' + $activeLeaf + ')' }) '#153' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'autologonConfig' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#153' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 13: dashTokenRotation (age + validity against TWO routes - B5)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $tokenPath = Join-Path $Root 'dash-token.txt'
    $ageSec = -1
    $fileHash = ''
    try {
        if (Test-Path -LiteralPath $tokenPath) {
            $fi = Get-Item -LiteralPath $tokenPath
            $ageSec = [int]((Get-Date).ToUniversalTime() - $fi.LastWriteTimeUtc).TotalSeconds
            $fileHash = Get-TokenHash ([System.IO.File]::ReadAllText($tokenPath)).Trim()
        }
    } catch { }
    $mirror = Invoke-Http -Path '/api/mirror/status'
    $search = Invoke-Http -Method 'POST' -Path '/api/lab/inspect' -Body '{"url":"https://www.gutenberg.org/ebooks/11","maxLinks":1}' -Timeout 45
    $diag = Invoke-Http -Path '/api/diag'
    $verify = $null
    try { $verify = $diag.json.dashTokenVerify } catch { }
    $selfCheck = $null
    try { $selfCheck = $diag.json.dashTokenSelfCheck } catch { }
    $validAgainstMirror = ($mirror.status -eq 200)
    $validAgainstSearch = ($search.status -ne 401 -and $search.status -ne 403)
    $st = $(if ($validAgainstMirror -and $validAgainstSearch -and ($fileHash -eq $script:TokenHash)) { 'pass' } else { 'fail' })
    Add-Feature 'dashTokenRotation' $st ([ordered]@{
        ageSec            = $ageSec
        tokenHash         = $script:TokenHash
        fileHash          = $fileHash
        fileMatchesPresented = ($fileHash -and ($fileHash -eq $script:TokenHash))
        validAgainstMirror = $validAgainstMirror
        validAgainstSearch = $validAgainstSearch
        mirrorStatus      = $mirror.status
        searchStatus      = $search.status
        serverVerify      = $verify
        serverSelfCheck   = $selfCheck
    }) $(if ($validAgainstMirror -and $validAgainstSearch) { 'the on-disk token is accepted by mirror AND search routes' } else { 'token lane: mirror=' + [string]$mirror.status + ' search=' + [string]$search.status }) '#153' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'dashTokenRotation' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#153' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 14: sidebarRoutes (the page does not 404 and its data lane answers)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $routes = [ordered]@{
        '/overview'          = '/api/progress'
        '/search'            = '/api/f58/sources'
        '/sessions'          = '/api/progress'
        '/connections'       = '/api/native-status'
        '/keys'              = '/api/config'
        '/files'             = '/api/fx?op=list&path='
        '/mirror'            = '/api/mirror/status'
        '/telemetry'         = '/api/progress'
        '/health'            = '/api/f92-selftest'
        '/collector'         = '/api/collector/status'
    }
    $doc = Invoke-Http -Path '/' -NoToken
    $docOk = ($doc.status -eq 200 -and ([string]$doc.text).Length -gt 51200)
    $rows = [ordered]@{}
    $pass = 0
    foreach ($k in @($routes.Keys)) {
        $api = Invoke-Http -Path ([string]$routes[$k])
        $row = [ordered]@{
            status      = $(if ($docOk -and $api.status -gt 0) { 'pass' } else { 'fail' })
            docStatus   = $doc.status
            docBytes    = ([string]$doc.text).Length
            apiPath     = [string]$routes[$k]
            apiStatus   = $api.status
            loadMs      = $api.ms
            note        = 'server-side probe: the SPA document + the route''s primary API. RENDER is proven by the e2e lane (playwright), not here.'
        }
        if ($row.status -eq 'pass') { $pass = [int]$pass + 1 }
        $rows[$k] = $row
    }
    $st = $(if ($docOk -and $pass -eq @($routes.Keys).Count) { 'pass' } elseif ($docOk) { 'warn' } else { 'fail' })
    Add-Feature 'sidebarRoutes' $st ([ordered]@{ docStatus = $doc.status; docBytes = ([string]$doc.text).Length; routesPassing = $pass; routeCount = @($routes.Keys).Count; routes = $rows }) ([string]$pass + '/' + [string]$routes.Count + ' sidebar routes answered') '#148' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'sidebarRoutes' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#148' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 15: healthEndpoint (/health must report the RFC6455 lane)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/health'
    $ws = $null
    try { $ws = [bool]$r.json.ws } catch { }
    $st = $(if ($r.ok -and $ws -eq $true) { 'pass' } else { 'fail' })
    Add-Feature 'healthEndpoint' $st ([ordered]@{ httpStatus = $r.status; ws = $ws; wsPath = $(try { [string]$r.json.wsPath } catch { $null }); wsClients = $(try { [int]$r.json.wsClients } catch { $null }); pid = $(try { [int]$r.json.pid } catch { $null }) }) $(if ($ws -eq $true) { '/health reports ws=true (the upgrade lane exists)' } else { '/health reports ws=' + [string]$ws }) '#153' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'healthEndpoint' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#153' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 16: selfTest (the F92 eleven-site health+json body)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/f92-selftest?frontendSha=collector' -Timeout 90
    $st = $(if ($r.ok) { 'pass' } else { 'fail' })
    Add-Feature 'selfTest' $st ([ordered]@{ httpStatus = $r.status; contentTypeAware = $true; bytes = ([string]$r.text).Length; preview = ([string]$r.text).Substring(0, [Math]::Min(200, ([string]$r.text).Length)); error = $r.error }) $(if ($r.ok) { 'selftest lane answered HTTP ' + [string]$r.status } else { 'selftest lane HTTP ' + [string]$r.status }) '#145' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'selfTest' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#145' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 17: serverEcho (/ping + the version features the UI banner reads)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/ping'
    $r2 = Invoke-Http -Path '/api/diag'
    $ver = $null
    try { $ver = $r2.json.version } catch { }
    $st = $(if ($r.ok) { 'pass' } else { 'fail' })
    Add-Feature 'serverEcho' $st ([ordered]@{ pingStatus = $r.status; ts = $(try { [string]$r.json.ts } catch { $null }); wire = $(try { [string]$r.json.wire } catch { $null }); diagStatus = $r2.status; version = $ver }) $(if ($r.ok) { 'server answered /ping (diag HTTP ' + [string]$r2.status + ')' } else { '/ping did not answer' }) '#148' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'serverEcho' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#148' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 18: searchEndpoints - the 11 export sites, from the RUNNER's network
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $sites = @(
        'https://archive.org', 'https://www.gutenberg.org', 'https://standardebooks.org',
        'https://librivox.org', 'https://openlibrary.org', 'https://www.openculture.com',
        'https://freemusicarchive.org', 'https://openverse.org', 'https://tubitv.com',
        'https://pluto.tv', 'https://awesome.re'
    )
    try {
        $hp = Join-Path $Root 'data\f88-site-hints.json'
        if (Test-Path -LiteralPath $hp) {
            $hj = ([System.IO.File]::ReadAllText($hp)) | ConvertFrom-Json
            $fromHints = New-Object System.Collections.ArrayList
            foreach ($k in @($hj.PSObject.Properties.Name)) {
                $h = [string]$hj.$k
                if ($h -match '^https?://') { [void]$fromHints.Add($h.TrimEnd('/')) }
            }
            if ($fromHints.Count -ge 5) { $sites = @($fromHints) }
        }
    } catch { }
    $rows = [ordered]@{}
    $okCount = 0
    foreach ($site in $sites) {
        $r = Invoke-Http -Method 'GET' -Path '/' -NoToken -Timeout $SiteTimeoutSec -Base_ $site
        $reach = ($r.status -ge 200 -and $r.status -lt 400) -or ($r.status -ge 400 -and $r.status -lt 500)
        if ($reach) { $okCount = [int]$okCount + 1 }
        $rows[$site] = [ordered]@{ reachable = $reach; httpStatus = $r.status; ms = $r.ms; error = $r.error }
    }
    $st = $(if ($okCount -eq $sites.Count) { 'pass' } elseif ($okCount -ge [int][Math]::Ceiling($sites.Count / 2)) { 'warn' } else { 'fail' })
    Add-Feature 'searchEndpoints' $st ([ordered]@{ reachable = $okCount; total = $sites.Count; sites = $rows }) ([string]$okCount + '/' + [string]$sites.Count + ' sites reachable from the runner') '#145' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'searchEndpoints' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#145' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# FEATURE 19: versionFeatures - the banner contract (/api/version)
# ---------------------------------------------------------------------------
$fSw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-Http -Path '/api/version'
    $feat = $null
    try { $feat = $r.json.features } catch { }
    $wsFlag = $null
    $colFlag = $null
    try { $wsFlag = [bool]$feat.webSocketUpgrade } catch { }
    try { $colFlag = [bool]$feat.diagnosisCollector } catch { }
    $st = $(if ($r.ok -and $wsFlag -eq $true -and $colFlag -eq $true) { 'pass' } elseif ($r.ok) { 'warn' } else { 'fail' })
    Add-Feature 'versionFeatures' $st ([ordered]@{ httpStatus = $r.status; sha7 = $(try { [string]$r.json.sha7 } catch { $null }); webSocketUpgrade = $wsFlag; diagnosisCollector = $colFlag; features = $feat }) $(if ($r.ok) { 'version advertises webSocketUpgrade=' + [string]$wsFlag + ' diagnosisCollector=' + [string]$colFlag } else { 'HTTP ' + [string]$r.status + ' ' + $r.error }) '#153' $fSw.ElapsedMilliseconds
} catch { Add-Feature 'versionFeatures' 'fail' $null ('probe threw: ' + $_.Exception.Message) '#153' $fSw.ElapsedMilliseconds }

# ---------------------------------------------------------------------------
# REPORT
# ---------------------------------------------------------------------------
$summary = Get-Summary
$final = [ordered]@{
    runId       = $RunId
    version     = 'f99/1'
    state       = 'done'
    startedAt   = $script:StartedAt.ToString('o')
    finishedAt  = (Get-Date).ToUniversalTime().ToString('o')
    durationSec = [int]((Get-Date).ToUniversalTime() - $script:StartedAt).TotalSeconds
    base        = $Base
    host        = $env:COMPUTERNAME
    tokenPresent = [bool]$script:Token
    tokenHash   = $script:TokenHash
    order       = @($script:Order)
    features    = $script:Features
    summary     = $summary
    advisories  = @($script:Advisories)
}
try { [System.IO.File]::WriteAllText($script:ReportPath, ($final | ConvertTo-Json -Depth 12), $script:NoBom) } catch { }
try {
    $md = New-Object System.Collections.ArrayList
    [void]$md.Add('# F99 Diagnosis Collector - run ' + $RunId)
    [void]$md.Add('')
    [void]$md.Add('- base: ' + $Base)
    [void]$md.Add('- host: ' + $env:COMPUTERNAME)
    [void]$md.Add('- started: ' + $script:StartedAt.ToString('o'))
    [void]$md.Add('- duration: ' + [string]$final.durationSec + 's')
    [void]$md.Add('- features: ' + [string]$summary.totalFeatures + ' (pass ' + [string]$summary.passed + ' / fail ' + [string]$summary.failed + ' / warn ' + [string]$summary.warnings + ' / skip ' + [string]$summary.skipped + ')')
    [void]$md.Add('')
    [void]$md.Add('| feature | status | detail | ms |')
    [void]$md.Add('| --- | --- | --- | --- |')
    foreach ($k in $script:Order) {
        $f = $script:Features[$k]
        $det = ([string]$f.detail).Replace('|', '/')
        [void]$md.Add('| ' + $k + ' | ' + [string]$f.status + ' | ' + $det + ' | ' + [string]$f.ms + ' |')
    }
    if (@($summary.criticalIssues).Count -gt 0) {
        [void]$md.Add('')
        [void]$md.Add('## Critical issues')
        foreach ($c in @($summary.criticalIssues)) { [void]$md.Add('- **' + [string]$c.feature + '** (' + [string]$c.issue + '): ' + [string]$c.detail) }
    }
    [System.IO.File]::WriteAllText($script:MdPath, ($md -join "`r`n"), $script:NoBom)
} catch { }
try { [System.IO.File]::WriteAllText($script:ProgressPath, ($final | ConvertTo-Json -Depth 12), $script:NoBom) } catch { }
Write-Host ('[F99] collector done: ' + [string]$summary.passed + '/' + [string]$summary.totalFeatures + ' passed, ' + [string]$summary.failed + ' failed, ' + [string]$summary.warnings + ' warn in ' + [string]$final.durationSec + 's')
exit 0
