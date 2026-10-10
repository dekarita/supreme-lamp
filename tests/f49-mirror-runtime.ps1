# [F49] Mirror runtime (one-click) opt-in lab (Windows lane).
#
# Drives the SHIPPED payloads/ghrdp-mirror.ps1 helpers plus the REAL
# payloads/ghrdp-server.ps1 over loopback HTTP:
#   UNIT        config-object convergence (enable flips flags+marker, the
#               status truth table, idempotent re-POST, disable reverts, the
#               ledger format, the beacon file) - no socket.
#   INTEGRATION the real server: status auth (loopback read, wrong-token 401,
#               query-credential 401), method 405s, enable/disable token+CSRF
#               gates, the config+beacon+flag effects, the preflight, and the
#               audit line without secrets.
#   WIRE        upload-after-enable over a REAL loopback socket: the opted-in
#               host hits the guest multipart contract with zero auth headers.
#   A11Y        the ConfirmModal contract, pinned over both shipped UIs.
# No live host is called; no content is uploaded; nothing is written outside
# $env:RUNNER_TEMP / the OS temp dir. Exit 0 only when every check passes.
$ErrorActionPreference = 'Stop'
$script:failures = 0

function Check([string]$Name, [bool]$Cond, [string]$Detail) {
    if ($Cond) {
        Write-Host ('  [PASS] ' + $Name)
    } else {
        $script:failures = $script:failures + 1
        Write-Host ('  [FAIL] ' + $Name + ' :: ' + $Detail)
        $ann = (('::error title=F49 check::' + $Name + ' :: ' + $Detail) -replace '[\r\n]+', ' ')
        Write-Host $ann
    }
}

function Send-F49Raw {
    param([int]$Port, [string]$Method, [string]$Target, [hashtable]$Headers = @{}, [int]$TimeoutMs = 15000)
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $Port)
    $stream = $client.GetStream()
    try { $stream.ReadTimeout = $TimeoutMs } catch { }
    $head = $Method + ' ' + $Target + "`r`nHost: 127.0.0.1`r`nConnection: close`r`n"
    foreach ($k in @($Headers.Keys)) { $head += ($k + ': ' + $Headers[$k] + "`r`n") }
    $head += ("Content-Length: 0`r`n`r`n")
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($hb, 0, $hb.Length)
    $stream.Flush()
    $ms = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 8192
    while ($true) {
        $n = 0
        try { $n = $stream.Read($buf, 0, $buf.Length) } catch { break }
        if ($n -le 0) { break }
        $ms.Write($buf, 0, $n)
    }
    $all = $ms.ToArray()
    $ms.Dispose()
    try { $stream.Close(); $client.Close() } catch { }
    $idx = -1
    for ($i = 0; $i -le ($all.Length - 4); $i++) {
        if ($all[$i] -eq 13 -and $all[$i + 1] -eq 10 -and $all[$i + 2] -eq 13 -and $all[$i + 3] -eq 10) { $idx = $i; break }
    }
    $headText = ''
    $bodyOut = [byte[]]@()
    if ($idx -ge 0) {
        $headText = [System.Text.Encoding]::ASCII.GetString($all, 0, $idx)
        if ($all.Length -gt ($idx + 4)) { $bodyOut = $all[($idx + 4)..($all.Length - 1)] }
    } else {
        $headText = [System.Text.Encoding]::ASCII.GetString($all)
    }
    $code = 0
    if ($headText -match '^HTTP/1\.1 (\d{3})') { $code = [int]$Matches[1] }
    $hdr = @{}
    foreach ($hl in ($headText -split "`r`n")) {
        $ix = $hl.IndexOf(':')
        if ($ix -gt 0) {
            $k = $hl.Substring(0, $ix).Trim().ToLower()
            $v = $hl.Substring($ix + 1).Trim()
            if ($hdr.ContainsKey($k)) { $hdr[$k] = [string]$hdr[$k] + ' | ' + $v } else { $hdr[$k] = $v }
        }
    }
    return @{ Code = $code; Head = $headText; Headers = $hdr; Body = $bodyOut; Text = [System.Text.Encoding]::UTF8.GetString($bodyOut) }
}


$root = $env:GITHUB_WORKSPACE
if (-not $root) { $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$modPath = Join-Path $root 'payloads\\ghrdp-mirror.ps1'
if (-not (Test-Path -LiteralPath $modPath)) { $modPath = Join-Path $root 'payloads/ghrdp-mirror.ps1' }
if (-not (Test-Path -LiteralPath $modPath)) { throw ('F49: the mirror module is missing at ' + $modPath) }
. $modPath
$serverPath = Join-Path $root 'payloads\\ghrdp-server.ps1'
if (-not (Test-Path -LiteralPath $serverPath)) { $serverPath = Join-Path $root 'payloads/ghrdp-server.ps1' }
if (-not (Test-Path -LiteralPath $serverPath)) { throw ('F49: the server is missing at ' + $serverPath) }
Write-Host ('[F49] module loaded: ' + $modPath)

$tmp = $env:RUNNER_TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath() }
$labRoot = Join-Path $tmp ('f49-lab-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
[void][System.IO.Directory]::CreateDirectory($labRoot)

try {
    # --- UNIT: config-object convergence ----------------------------------
    Write-Host '[F49] unit: opt-in converge + status truth table + ledger'
    $cfgOff = '{"mirror":false}' | ConvertFrom-Json
    $stOff = Get-F49OptInStatus -Cfg $cfgOff
    Check 'U default config is off/off with this-run scope' ((-not [bool]$stOff.enabled) -and ([string]$stOff.source -eq 'off') -and ([string]$stOff.scope -eq 'this-run')) ('enabled=' + $stOff.enabled + ' source=' + $stOff.source)
    Check 'U default config lists the disabled gofile host' ((@($stOff.hosts).Count -eq 1) -and (([string](@($stOff.hosts)[0].id)) -eq 'gofile') -and (-not [bool](@($stOff.hosts)[0].enabled))) ('hosts=' + (@($stOff.hosts) | ConvertTo-Json -Compress -Depth 3))
    $cfgSet = '{"mirror":false}' | ConvertFrom-Json
    $setRes = Set-F49RuntimeOptIn -Cfg $cfgSet -At '2026-09-28T18:00:00Z'
    Check 'U enable flips mirror + first host' (([bool]$setRes.changed) -and [bool]$cfgSet.mirror -and [bool](@($cfgSet.mirrorHosts)[0].enabled) -and (@($cfgSet.mirrorHosts)[0].id -eq 'gofile')) ('changed=' + $setRes.changed)
    $mk = Get-F49RuntimeOptIn -Cfg $cfgSet
    Check 'U enable stamps the runtime marker' (($mk -ne $null) -and ([string]$mk.at -eq '2026-09-28T18:00:00Z') -and ([string]$mk.source -eq 'runtime') -and ([string]$mk.scope -eq 'this-run') -and ([string]$mk.by -eq 'dashboard')) ('marker=' + ($mk | ConvertTo-Json -Compress))
    $stOn = Get-F49OptInStatus -Cfg $cfgSet
    Check 'U status after enable is runtime/gofile' (([bool]$stOn.enabled) -and ([string]$stOn.source -eq 'runtime') -and ([string]$stOn.host -eq 'gofile')) ('enabled=' + $stOn.enabled + ' source=' + $stOn.source + ' host=' + $stOn.host)
    $cfgDis = '{"mirror":true,"mirrorHosts":[{"id":"gofile","enabled":true}]}' | ConvertFrom-Json
    $stDis = Get-F49OptInStatus -Cfg $cfgDis
    Check 'U enabled-without-marker reports dispatch' (([bool]$stDis.enabled) -and ([string]$stDis.source -eq 'dispatch')) ('source=' + $stDis.source)
    $cfgHalf = '{"mirror":false,"mirrorHosts":[{"id":"gofile","enabled":true}]}' | ConvertFrom-Json
    Check 'U master-off + host-on is still disabled' (-not (Test-F49MirrorEnabled -Cfg $cfgHalf)) 'the master switch was ignored'
    $cfgHalf2 = '{"mirror":true}' | ConvertFrom-Json
    Check 'U master-on + no enabled host is still disabled' (-not (Test-F49MirrorEnabled -Cfg $cfgHalf2)) 'the host gate was ignored'
    $setAgain = Set-F49RuntimeOptIn -Cfg $cfgSet -At '2026-09-28T19:00:00Z'
    Check 'U idempotent re-POST keeps the original marker' ((-not [bool]$setAgain.changed) -and ([string](Get-F49RuntimeOptIn -Cfg $cfgSet).at -eq '2026-09-28T18:00:00Z')) ('changed=' + $setAgain.changed)
    $line = Format-F49OptInLedger -Marker (Get-F49RuntimeOptIn -Cfg $cfgSet) -HostId 'gofile'
    Check 'U ledger line is the §3 format' (($line -match '^\[mirror\] RUNTIME OPT-IN: enabled=true scope=this-run source=runtime host=gofile at=2026-09-28T18:00:00Z') -and ($line -match 'token-less guest, no credential')) ($line)
    Check 'U opt-out ledger is the exact clear line' ((Format-F49OptOutLedger) -eq '[mirror] RUNTIME OPT-IN: cleared by dashboard (mirror=false, hosts disabled)') (Format-F49OptOutLedger)
    $clrRes = Clear-F49RuntimeOptIn -Cfg $cfgSet
    $stClr = Get-F49OptInStatus -Cfg $cfgSet
    Check 'U disable reverts to default-off' (([bool]$clrRes.changed) -and (-not [bool]$stClr.enabled) -and ([string]$stClr.source -eq 'off') -and ((Get-F49RuntimeOptIn -Cfg $cfgSet) -eq $null)) ('enabled=' + $stClr.enabled + ' source=' + $stClr.source)
    $cfgKeep = '{"mirror":false,"mirrorHosts":[{"id":"gofile","enabled":false},{"id":"other","enabled":false}]}' | ConvertFrom-Json
    [void](Set-F49RuntimeOptIn -Cfg $cfgKeep -At '2026-09-28T18:00:00Z')
    Check 'U enable keeps the host list shape (first entry on)' ((@($cfgKeep.mirrorHosts).Count -eq 2) -and [bool](@($cfgKeep.mirrorHosts)[0].enabled) -and (-not [bool](@($cfgKeep.mirrorHosts)[1].enabled))) ('count=' + @($cfgKeep.mirrorHosts).Count)

    # --- UNIT: beacon file -------------------------------------------------
    Write-Host '[F49] unit: opt-in beacon file'
    $cfgBeacon = '{"mirror":false}' | ConvertFrom-Json
    [void](Set-F49RuntimeOptIn -Cfg $cfgBeacon -At '2026-09-28T18:00:00Z')
    $beaconPath = Write-F49OptInBeacon -Root $labRoot -Marker (Get-F49RuntimeOptIn -Cfg $cfgBeacon) -HostId 'gofile'
    $beaconOk = (Test-Path -LiteralPath $beaconPath) -and ($beaconPath -like '*mirror-optin-beacon.json')
    $beacon = $null
    try { $beacon = ([System.IO.File]::ReadAllText($beaconPath) | ConvertFrom-Json) } catch { $beacon = $null }
    Check 'U beacon file is written with the opt-in record' ($beaconOk -and ($beacon -ne $null) -and ([string]$beacon.event -eq 'mirror-runtime-opt-in') -and [bool]$beacon.enabled -and ([string]$beacon.scope -eq 'this-run') -and ([string]$beacon.source -eq 'runtime') -and ([string]$beacon.host -eq 'gofile') -and ([string](ConvertTo-F49UtcIso $beacon.at) -eq '2026-09-28T18:00:00Z')) ('path=' + $beaconPath)
    Remove-F49OptInBeacon -Root $labRoot
    Check 'U beacon file is removed by disable' (-not (Test-Path -LiteralPath (Join-Path $labRoot 'mirror-optin-beacon.json'))) 'beacon still present'
    $removeThrew = $false
    try { Remove-F49OptInBeacon -Root $labRoot } catch { $removeThrew = $true }
    Check 'U beacon remove is a no-op when absent' (-not $removeThrew) 'remove threw'

    # --- INTEGRATION: the real server over loopback -------------------------
    Write-Host '[F49] integration: real ghrdp-server.ps1 over loopback HTTP'
    $dashToken = 'F49LABDASHTOKEN0123456789abcdef'
    $srvRoot = Join-Path $labRoot 'srv'
    [void][System.IO.Directory]::CreateDirectory($srvRoot)
    [System.IO.File]::WriteAllText((Join-Path $srvRoot 'dash-token.txt'), $dashToken, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText((Join-Path $srvRoot 'config.json'), '{"mirror":false,"mirrorHosts":[]}', (New-Object System.Text.UTF8Encoding($false)))
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), 0)
    $l.Start()
    $port = $l.LocalEndpoint.Port
    $l.Stop()
    $srvOut = Join-Path $srvRoot 'server-out.log'
    $srvErr = Join-Path $srvRoot 'server-err.log'
    $exe = 'powershell.exe'
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { $exe = 'pwsh' }
    $srvArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $serverPath, '-Port', ([string]$port), '-Bind', '127.0.0.1', '-Root', $srvRoot, '-LimitMinutes', '5')
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        $proc = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr -ArgumentList $srvArgs
    } else {
        $proc = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr -ArgumentList $srvArgs
    }
    $okFile = Join-Path $srvRoot 'server-ok.txt'
    $up = $false
    $markerPid = ''
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $okFile) { $t = [System.IO.File]::ReadAllText($okFile); if ($t -match 'LISTENING') { $up = $true; if ($t -match 'pid=(\d+)') { $markerPid = $Matches[1] } } }
        if ($proc.HasExited) { break }
    }
    Check 'I server reached LISTENING' $up ('server-ok.txt absent; stdout=[' + (Get-Content -LiteralPath $srvOut -Raw -ErrorAction SilentlyContinue) + ']')
    if ($up) {
        # [F45-R] readiness is marker + HTTP 200 + MATCHING pid (a stale
        # marker over a recycled port must fail, not read as ready).
        $r = Send-F49Raw -Port $port -Method 'GET' -Target '/health'
        Check 'I /health 200 from loopback' ([int]$r.Code -eq 200) ('code=' + $r.Code)
        Check 'I /health reports the ghrdp app' ([string]$r.Text -match '"app":"ghrdp"') ('text=' + $r.Text)
        $hJson = $null
        try { $hJson = ($r.Text | ConvertFrom-Json) } catch { $hJson = $null }
        Check 'I /health pid matches the LISTENING marker' (($hJson -ne $null) -and ([string]$hJson.pid -eq [string]$markerPid)) ('health pid=[' + [string]$hJson.pid + '] marker pid=[' + $markerPid + ']')
        $r = Send-F49Raw -Port $port -Method 'GET' -Target '/api/mirror/status'
        Check 'I status 200 from loopback without a token (read)' ([int]$r.Code -eq 200) ('code=' + $r.Code)
        $j0 = $null
        try { $j0 = ($r.Text | ConvertFrom-Json) } catch { $j0 = $null }
        Check 'I status body reports off/off' (($j0 -ne $null) -and (-not [bool]$j0.enabled) -and ([string]$j0.source -eq 'off')) ('text=' + $r.Text)
        $csrfTok = ''
        try { $csrfTok = [string]$r.Headers['x-csrf-token'] } catch { $csrfTok = '' }
        Check 'I status delivers the CSRF response header' ($csrfTok -match '^[0-9a-f]{48}$') ('csrf=[' + $csrfTok + ']')
        $cookieTxt = ''
        try { $cookieTxt = [string]$r.Headers['set-cookie'] } catch { $cookieTxt = '' }
        Check 'I status sets the SameSite=Strict CSRF cookie' (($cookieTxt.Contains('ghrdp_mirror_csrf=')) -and ($cookieTxt.Contains('SameSite=Strict'))) ('cookie=[' + $cookieTxt + ']')
        $exposeTxt = ''
        try { $exposeTxt = [string]$r.Headers['access-control-expose-headers'] } catch { $exposeTxt = '' }
        Check 'I status exposes the CSRF header for the 7332 fallback' ($exposeTxt.Contains('X-CSRF-Token')) ('expose=[' + $exposeTxt + ']')
        $r = Send-F49Raw -Port $port -Method 'GET' -Target '/api/mirror/status' -Headers @{ 'X-Dash-Token' = 'wrong-token-value-000000' }
        Check 'I status 401 on a wrong dash token' ([int]$r.Code -eq 401) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'GET' -Target ('/api/mirror/status?key=' + $dashToken)
        Check 'I status 401 when the credential is in the query' ([int]$r.Code -eq 401) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'GET' -Target '/api/mirror/enable'
        Check 'I GET on enable is 405' ([int]$r.Code -eq 405) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'POST' -Target '/api/mirror/status'
        Check 'I POST on status is 405' ([int]$r.Code -eq 405) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'POST' -Target '/api/mirror/enable'
        Check 'I enable 401 without a dash token (even loopback)' ([int]$r.Code -eq 401) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'POST' -Target '/api/mirror/enable' -Headers @{ 'X-Dash-Token' = $dashToken }
        Check 'I enable 403 without CSRF' ([int]$r.Code -eq 403) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'POST' -Target '/api/mirror/enable' -Headers @{ 'X-Dash-Token' = $dashToken; 'X-CSRF-Token' = 'deadbeef' }
        Check 'I enable 403 on a wrong CSRF token' ([int]$r.Code -eq 403) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'POST' -Target ('/api/mirror/enable?key=' + $dashToken) -Headers @{ 'X-Dash-Token' = $dashToken; 'X-CSRF-Token' = $csrfTok }
        Check 'I enable 401 when the query carries a credential' ([int]$r.Code -eq 401) ('code=' + $r.Code)
        $r = Send-F49Raw -Port $port -Method 'POST' -Target '/api/mirror/enable' -Headers @{ 'X-Dash-Token' = $dashToken; 'X-CSRF-Token' = $csrfTok }
        Check 'I enable 200 with dash token + CSRF' ([int]$r.Code -eq 200) ('code=' + $r.Code + ' text=' + $r.Text)
        $cfgAfter = $null
        try { $cfgAfter = ([System.IO.File]::ReadAllText((Join-Path $srvRoot 'config.json')) | ConvertFrom-Json) } catch { $cfgAfter = $null }
        Check 'I enable wrote config.json (mirror + host + marker)' (($cfgAfter -ne $null) -and [bool]$cfgAfter.mirror -and [bool](@($cfgAfter.mirrorHosts)[0].enabled) -and ([string]$cfgAfter.mirrorRuntimeOptIn.source -eq 'runtime')) ('mirror=' + [bool]$cfgAfter.mirror + ' encryptMode=' + [string]$cfgAfter.encryptMode + ' markerSource=' + [string]$cfgAfter.mirrorRuntimeOptIn.source)
        Check 'I enable wrote the beacon file' (Test-Path -LiteralPath (Join-Path $srvRoot 'mirror-optin-beacon.json')) 'beacon missing'
        Check 'I enable queued the opt-in flag + the flush flag' ((Test-Path -LiteralPath (Join-Path $srvRoot 'mirror-enable.flag')) -and (Test-Path -LiteralPath (Join-Path $srvRoot 'flush.flag'))) 'flag(s) missing'
        $r = Send-F49Raw -Port $port -Method 'GET' -Target '/api/mirror/status' -Headers @{ 'X-Dash-Token' = $dashToken }
        $j1 = $null
        try { $j1 = ($r.Text | ConvertFrom-Json) } catch { $j1 = $null }
        Check 'I status after enable is runtime + pending' (($j1 -ne $null) -and [bool]$j1.enabled -and ([string]$j1.source -eq 'runtime') -and [bool]$j1.pending) ('text=' + $r.Text)
        $r = Send-F49Raw -Port $port -Method 'POST' -Target '/api/mirror/disable' -Headers @{ 'Authorization' = ('Bearer ' + $dashToken); 'X-CSRF-Token' = $csrfTok }
        Check 'I disable 200 via the Bearer form' ([int]$r.Code -eq 200) ('code=' + $r.Code + ' text=' + $r.Text)
        $cfgOff2 = $null
        try { $cfgOff2 = ([System.IO.File]::ReadAllText((Join-Path $srvRoot 'config.json')) | ConvertFrom-Json) } catch { $cfgOff2 = $null }
        $markerGone = $true
        try { $markerGone = ($null -eq $cfgOff2.PSObject.Properties['mirrorRuntimeOptIn']) } catch { $markerGone = $true }
        Check 'I disable reverted config.json (mirror + hosts + marker)' (($cfgOff2 -ne $null) -and (-not [bool]$cfgOff2.mirror) -and (-not [bool](@($cfgOff2.mirrorHosts)[0].enabled)) -and $markerGone) 'revert incomplete'
        Check 'I disable removed the beacon and queued the opt-out flag' ((-not (Test-Path -LiteralPath (Join-Path $srvRoot 'mirror-optin-beacon.json'))) -and (Test-Path -LiteralPath (Join-Path $srvRoot 'mirror-disable.flag'))) 'beacon present or flag missing'
        $r = Send-F49Raw -Port $port -Method 'OPTIONS' -Target '/api/mirror/enable'
        $allowTxt = ''
        try { $allowTxt = [string]$r.Headers['access-control-allow-headers'] } catch { $allowTxt = '' }
        Check 'I preflight 204 carries the F49 headers' (([int]$r.Code -eq 204) -and ($allowTxt.Contains('X-Dash-Token')) -and ($allowTxt.Contains('X-CSRF-Token'))) ('code=' + $r.Code + ' allow=[' + $allowTxt + ']')
        $auditTxt = ''
        try { $auditTxt = [System.IO.File]::ReadAllText((Join-Path $srvRoot 'client-audit.log')) } catch { $auditTxt = '' }
        Check 'I audit line records the enable without secrets' (($auditTxt.Contains('mirror POST /api/mirror/enable -> 200')) -and (-not $auditTxt.Contains($dashToken)) -and (-not $auditTxt.Contains($csrfTok))) ('audit=[' + $auditTxt + ']')
    }
    try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch { }

    # --- WIRE: upload-after-enable hits the guest contract ------------------
    Write-Host '[F49] wire: opted-in upload over a real loopback socket'
    $listener = $null
    $portF49 = 0
    for ($i = 0; $i -lt 25 -and -not $listener; $i++) {
        $tryPort = 18520 + $i
        $wl = New-Object System.Net.HttpListener
        try {
            $wl.Prefixes.Add('http://127.0.0.1:' + $tryPort + '/')
            $wl.Start()
            $listener = $wl
            $portF49 = $tryPort
        } catch { try { $wl.Close() } catch { } }
    }
    if (-not $listener) {
        Check 'W a local listener could be started for the wire contract' $false 'no free port / listener refused'
    } else {
        Write-Host ('[F49] local listener on http://127.0.0.1:' + $portF49 + '/uploadfile (contract only; no external host)')
        $payPath = Join-Path $labRoot 'f49-wire-payload.bin'
        [System.IO.File]::WriteAllBytes($payPath, (New-Object byte[] 2048))
        $cfgJson = '{"mirror":false}'
        $clientJob = Start-Job -ScriptBlock {
            param($Mod, $CfgText, $Path, $Port)
            $ErrorActionPreference = 'Stop'
            . $Mod
            $cfg = ($CfgText | ConvertFrom-Json)
            [void](Set-F49RuntimeOptIn -Cfg $cfg -At '2026-09-28T18:00:00Z')
            $sel = Select-F46UploadHost -Hosts @(Get-F46Hosts -Cfg $cfg)
            if (-not $sel) { return @{ ok = $false; phase = 'policy'; link = ''; msg = 'no host selected after opt-in' } }
            $sel.uploadHost = ('127.0.0.1:' + $Port)
            $sel.uploadScheme = 'http'
            $rr = Invoke-F46MirrorAttempt -HostCfg $sel -Path $Path -Name 'f49-wire-payload.bin' -Size ([long]2048) -AttemptNo 1
            return @{ ok = [bool]$rr.ok; phase = [string]$rr.phase; link = [string]$rr.directUrl; msg = [string]$rr.hostMessage }
        } -ArgumentList $modPath, $cfgJson, $payPath, $portF49
        $wire = $null
        try {
            $ctx = $listener.GetContext()
            $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream)
            $bodyTxt = $sr.ReadToEnd()
            $sr.Close()
            $wire = [ordered]@{ method = $ctx.Request.HttpMethod; path = $ctx.Request.Url.AbsolutePath; auth = [string]$ctx.Request.Headers['Authorization']; cookie = [string]$ctx.Request.Headers['Cookie']; hostTokHdr = [string]$ctx.Request.Headers['X-Gofile-Token']; body = $bodyTxt }
            $respTxt = '{"status":"ok","data":{"id":"f49-wire-id","downloadPage":"https://gofile.test/d/f49wire","code":"f49wirecode"}}'
            $rb = [System.Text.Encoding]::UTF8.GetBytes($respTxt)
            $ctx.Response.StatusCode = 200
            $ctx.Response.ContentType = 'application/json'
            $ctx.Response.ContentLength64 = $rb.Length
            $ctx.Response.OutputStream.Write($rb, 0, $rb.Length)
            $ctx.Response.Close()
        } catch { Write-Host ('[F49] listener context failed: ' + $_.Exception.Message) }
        $client = $null
        try { if (Wait-Job -Job $clientJob -Timeout 60) { $client = Receive-Job -Job $clientJob } } catch { $client = $null }
        try { Remove-Job -Job $clientJob -Force -ErrorAction SilentlyContinue } catch { }
        Check 'W upload-after-enable POSTs /uploadfile' (($wire -ne $null) -and ($wire.method -eq 'POST') -and ($wire.path -eq '/uploadfile')) ('req=' + $(if ($wire) { $wire.method + ' ' + $wire.path } else { 'none' }))
        Check 'W NO Authorization header on the wire (token-less guest)' (($wire -ne $null) -and ([string]$wire.auth -eq '')) ('auth=' + $(if ($wire) { '[' + $wire.auth + ']' } else { 'none' }))
        Check 'W NO Cookie and NO X-Gofile-Token header on the wire' (($wire -ne $null) -and ([string]$wire.cookie -eq '') -and ([string]$wire.hostTokHdr -eq '')) 'host credential header present'
        Check 'W multipart body declares the field name file' (($wire -ne $null) -and ($wire.body -match 'name="file"')) 'field name missing'
        Check 'W id + downloadPage parse into a success row with a link' (($client -ne $null) -and [bool]$client.ok -and ($client.link -eq 'https://gofile.test/d/f49wire')) ('client=' + ($client | ConvertTo-Json -Compress -Depth 3))
        try { $listener.Stop(); $listener.Close() } catch { }
    }

    # --- A11Y: the ConfirmModal contract over both shipped UIs --------------
    Write-Host '[F49] a11y: ConfirmModal contract in v1 + v2 sources'
    $uiPath = Join-Path $root 'payloads\\ui.html'
    if (-not (Test-Path -LiteralPath $uiPath)) { $uiPath = Join-Path $root 'payloads/ui.html' }
    $uiTxt = [System.IO.File]::ReadAllText($uiPath)
    Check 'A v1 modal carries dialog roles + labels' (($uiTxt.Contains('id="mirrorOptInModal"')) -and ($uiTxt.Contains('role="dialog" aria-modal="true"')) -and ($uiTxt.Contains('aria-labelledby="mirrorOptInTitle"')) -and ($uiTxt.Contains('aria-describedby="mirrorOptInDesc"'))) 'v1 modal roles/labels missing'
    Check 'A v1 modal is Escape-dismissible with focus to [Enable & Upload]' (($uiTxt.Contains('closeMirrorOptIn()')) -and ($uiTxt.Contains("if(e.key==='Escape')")) -and ($uiTxt.Contains("mirrorOptInConfirm');if(c)c.focus()"))) 'v1 modal Esc/focus missing'
    Check 'A v1 banner + gated flush exist' (($uiTxt.Contains('id="mirrorOptInBanner"')) -and ($uiTxt.Contains('openMirrorOptIn(btn)')) -and ($uiTxt.Contains('role="status"'))) 'v1 banner/gate missing'
    $cardPath = Join-Path $root 'src\\components\\domain\\MirrorCard.tsx'
    if (-not (Test-Path -LiteralPath $cardPath)) { $cardPath = Join-Path $root 'src/components/domain/MirrorCard.tsx' }
    $cardTxt = [System.IO.File]::ReadAllText($cardPath)
    $fbPath = Join-Path $root 'src\\components\\primitives\\Feedback.tsx'
    if (-not (Test-Path -LiteralPath $fbPath)) { $fbPath = Join-Path $root 'src/components/primitives/Feedback.tsx' }
    $fbTxt = [System.IO.File]::ReadAllText($fbPath)
    Check 'A v2 card gates the upload on the modal + banner' (($cardTxt.Contains('mirror-disabled-banner')) -and ($cardTxt.Contains('onUploadNow')) -and ($cardTxt.Contains('mirror.optInTitle')) -and ($cardTxt.Contains('mirror.enableUpload'))) 'v2 banner/modal wiring missing'
    Check 'A v2 modal primitive keeps dialog roles + focus trap + Escape' (($fbTxt.Contains('role="dialog"')) -and ($fbTxt.Contains('aria-modal="true"')) -and ($fbTxt.Contains("e.key === ""Tab""")) -and ($fbTxt.Contains("e.key === ""Escape"""))) 'v2 modal a11y regressed'
    $enTxt = [System.IO.File]::ReadAllText((Join-Path $root 'src/i18n/en.json'))
    Check 'A the primary label is [Enable & Upload]' ($enTxt.Contains('"enableUpload": "Enable & Upload"')) 'primary label drifted'
} catch {
    Check 'lab aborted' $false ($_.Exception.Message)
} finally {
    try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch { }
    try { Remove-Item -LiteralPath $labRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

if ($script:failures -gt 0) {
    Write-Host ('::error::[F49] runtime opt-in lab failed: ' + $script:failures + ' check(s)')
    exit 1
}
Write-Host '[F49] runtime opt-in lab: ALL CHECKS PASS (no live host, no content uploaded)'
exit 0
