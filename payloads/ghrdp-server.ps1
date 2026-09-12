param(
    [int]$Port = 7331,
    [string]$Bind = '0.0.0.0',
    [string]$Root = 'C:\ghrdp',
    [int]$LimitMinutes = 350
)
$ErrorActionPreference = 'Continue'
$script:CfgPath = Join-Path $Root 'config.json'
$script:ProgPath = Join-Path $Root 'progress.json'
$script:UiPath = Join-Path $Root 'ui.html'
$script:InstPath = Join-Path $Root 'ghrdp-install.ps1'
$script:OkFile = Join-Path $Root 'server-ok.txt'
$script:FlushFlag = Join-Path $Root 'flush.flag'
$script:NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Token = ''
try {
    $tp = Join-Path $Root 'dash-token.txt'
    if (Test-Path -LiteralPath $tp) { $script:Token = ([System.IO.File]::ReadAllText($tp)).Trim() }
} catch { }

function Read-JsonFile {
    param([string]$Path)
    for ($a = 1; $a -le 3; $a++) {
        try {
            if (-not (Test-Path -LiteralPath $Path)) { return $null }
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $ms = New-Object System.IO.MemoryStream
            $fs.CopyTo($ms)
            $fs.Dispose()
            $b = $ms.ToArray()
            $ms.Dispose()
            if ($b.Length -eq 0) { return $null }
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
            $t = [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
            return ($t | ConvertFrom-Json)
        } catch { Start-Sleep -Milliseconds 40 }
    }
    return $null
}
function Get-RequestParts {
    param([string]$Raw)
    $headers = @{}
    $query = @{}
    $lines = @($Raw -split "`r`n")
    $path = '/'
    if ($lines.Count -gt 0 -and $lines[0]) {
        $first = $lines[0].Trim()
        $sp = $first.IndexOf(' ')
        if ($sp -gt 0) {
            $rest = $first.Substring($sp + 1).Trim()
            $target = (@($rest -split ' '))[0]
            $qAt = $target.IndexOf('?')
            if ($qAt -ge 0) {
                $path = $target.Substring(0, $qAt)
                foreach ($kv in ($target.Substring($qAt + 1) -split '&')) {
                    $eq = $kv.IndexOf('=')
                    if ($eq -gt 0) {
                        $k = [uri]::UnescapeDataString($kv.Substring(0, $eq)).ToLower()
                        $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
                        $query[$k] = $v
                    }
                }
            } else {
                $path = $target
            }
        }
    }
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]
        $ix = $l.IndexOf(':')
        if ($ix -gt 0) { $headers[$l.Substring(0, $ix).Trim().ToLower()] = $l.Substring($ix + 1).Trim() }
    }
    return @{ path = $path; headers = $headers; query = $query }
}
function Test-ClientAllowed {
    param($Client, $Query, $Token)
    try {
        $ip = $Client.Client.RemoteEndPoint.Address
        if ($ip.IsLoopback) { return $true }
        $oct = $ip.GetAddressBytes()
        if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) { return $true }
    } catch { }
    if ([string]::IsNullOrEmpty($Token)) { return $true }
    if ($Query -and $Query.ContainsKey('key') -and ([string]$Query['key'] -eq [string]$Token)) { return $true }
    return $false
}
function Read-ClientRequest {
    param($Stream)
    $acc = New-Object System.Text.StringBuilder
    $buf = New-Object byte[] 4096
    try { $Stream.ReadTimeout = 5000 } catch { }
    while ($true) {
        $n = 0
        try { $n = $Stream.Read($buf, 0, $buf.Length) } catch { break }
        if ($n -le 0) { break }
        [void]$acc.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
        if ($acc.ToString().Contains("`r`n`r`n")) { break }
        if ($acc.Length -gt 16384) { break }
    }
    return $acc.ToString()
}
function Send-ClientResponse {
    param($Stream, [int]$Code, [string]$CType, [byte[]]$Body)
    $status = 'OK'
    if ($Code -eq 401) { $status = 'Unauthorized' }
    if ($Code -eq 404) { $status = 'Not Found' }
    if ($Code -eq 500) { $status = 'Server Error' }
    $hdr = "HTTP/1.1 $Code $status`r`nContent-Type: $CType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
    $Stream.Write($hb, 0, $hb.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}
function To-IsoUtc {
    param([string]$S)
    if (-not $S) { return '' }
    $s2 = $S.Trim()
    if ($s2 -match 'Z$' -or $s2 -match '[+-]\d{2}:\d{2}$') { return $s2 }
    $dt = [datetime]::MinValue
    if ([datetime]::TryParse($s2, [ref]$dt)) { return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return $s2
}
function ConvertTo-JsonBytes {
    param($Obj)
    return [System.Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth 10 -Compress))
}
function Invoke-ClientRequest {
    param($Client, $Token)
    $stream = $null
    try {
        $stream = $Client.GetStream()
        $raw = Read-ClientRequest -Stream $stream
        if (-not $raw) { return }
        $parts = Get-RequestParts -Raw $raw
        $path = [string]$parts.path
        if (-not $path) { $path = '/' }
        if (-not (Test-ClientAllowed -Client $Client -Query $parts.query -Token $Token)) {
            Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('unauthorized'))
            return
        }
        $cfg = Read-JsonFile -Path $script:CfgPath
        if ($path -eq '/rentrydiag') {
            $editCode = [string]$cfg.rentryEditCode
            $pageCode = ([string]$cfg.legacyIndexUrl -replace '^https://rentry\.co/', '')
            if (-not $pageCode) { $pageCode = 'myurl0' }
            $apply = ($parts.query.ContainsKey('apply') -and ([string]$parts.query['apply'] -eq '1'))
            $jar = Join-Path $env:TEMP ('ghrdp-diag-' + [guid]::NewGuid().ToString('N') + '.txt')
            $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            $patterns = @(
                @{ name = 'edit/<edit_code>';  url = ('https://rentry.co/edit/' + [uri]::EscapeDataString($editCode)) },
                @{ name = 'edit/<page_code>';  url = ('https://rentry.co/edit/' + $pageCode) },
                @{ name = '<page_code>/edit';  url = ('https://rentry.co/' + $pageCode + '/edit') }
            )
            $results = New-Object System.Collections.ArrayList
            $workUrl = $null; $workCsrf = $null; $workCurrent = $null
            foreach ($pt in $patterns) {
                $html = (& curl.exe -sL -b $jar -c $jar --max-time 15 -A $ua $pt.url 2>$null) -join "`n"
                $csrf = ''; $cur = ''; $isErr = ($html -match '<title>Error</title>')
                if ($html -match 'name="csrfmiddlewaretoken"\s+value="([^"]+)"') { $csrf = $Matches[1] }
                if ($html -match '(?s)<textarea[^>]*name="text"[^>]*>(.*?)</textarea>') { $cur = [System.Net.WebUtility]::HtmlDecode($Matches[1]) }
                [void]$results.Add(@{ pattern = $pt.name; url = $pt.url; errorPage = $isErr; csrfFound = ([bool]$csrf); textareaFound = ([bool]$cur) })
                if ($csrf -and $cur -and (-not $workUrl)) { $workUrl = $pt.url; $workCsrf = $csrf; $workCurrent = $cur }
            }
            $applied = $false; $applyMsg = 'not applied'
            if ($apply -and $workUrl) {
                $body = $workCurrent
                $idxJson = $null
                try { $idxJson = Read-JsonFile -Path (Join-Path $script:Root 'mirror-index.json') } catch { }
                if ($idxJson) {
                    $body += "`r`n`r`nCURRENT RUN FILES:`r`n"
                    $i = 1
                    foreach ($it in @($idxJson)) {
                        $body += ('{0}. {1} ({2} bytes) {3} {4}' -f $i, [string]$it.name, [string]$it.size, [string]$it.time, [string]$it.link) + "`r`n"
                        $i++
                    }
                    if ([string]$cfg.mirrorKey) { $body += ("`r`nCurrent decrypt key: " + [string]$cfg.mirrorKey) }
                }
                $bf = Join-Path $env:TEMP ('ghrdp-apply-' + [guid]::NewGuid().ToString('N') + '.txt')
                [System.IO.File]::WriteAllText($bf, $body, $script:NoBom)
                $po = (& curl.exe -s -b $jar -A $ua -e $workUrl -X POST $workUrl --data-urlencode ('csrfmiddlewaretoken=' + $workCsrf) --data-urlencode ('edit_code=' + $editCode) --data-urlencode ('text@' + $bf) 2>$null) -join "`n"
                $applied = ($po -notmatch '<title>Error</title>')
                $applyMsg = if ($applied) { 'myurl0 append SUCCEEDED via ' + ($results | Where-Object { $_.csrfFound -and $_.textareaFound } | Select-Object -First 1).pattern } else { 'append still failed (rentry rejected POST)' }
                Remove-Item -LiteralPath $bf -Force -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $jar -Force -ErrorAction SilentlyContinue
            $out = [ordered]@{ editCode = $editCode; pageCode = $pageCode; patterns = $results; workingPattern = $workUrl; applied = $applied; applyMsg = $applyMsg }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $out)
            return
        }
        if ($path -eq '/flush') {
            $note = 'flush flag set - the watcher will upload everything on its next pass'
            try { [System.IO.File]::WriteAllText($script:FlushFlag, (Get-Date -Format o), $script:NoBom) } catch { $note = 'flush flag write failed: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $note })
            return
        }
        if ($path -eq '/launch') {
            $msg = 'watcher task start requested'
            try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction Stop } catch { $msg = 'could not start watcher task (log in via RDP first): ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $msg })
            return
        }
        if ($path -eq '/diag') {
            $prog = Read-JsonFile -Path $script:ProgPath
            $listen7332 = $false
            try { $listen7332 = [bool](Get-NetTCPConnection -LocalPort 7332 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $watcherState = 'not found'
            try { $wt = Get-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue; if ($wt) { $watcherState = [string]$wt.State } } catch { }
            $progAge = $null
            try { if ($prog -and $prog.ts) { $progAge = [int]((Get-Date) - [datetime]$prog.ts).TotalSeconds } } catch { }
            $d = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                port = $Port
                pid = $PID
                rust7332Listening = $listen7332
                watcherTask = $watcherState
                progressAgeSeconds = $progAge
                watcherAlive = [bool]$prog.alive
                note = 'ps server 7331 (fallback); rust realtime dashboard 7332 when available'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $d)
            return
        }
        if ($path -eq '/install.ps1') {
            if (Test-Path -LiteralPath $script:InstPath) {
                Send-ClientResponse -Stream $stream -Code 200 -CType 'text/plain; charset=utf-8' -Body ([System.IO.File]::ReadAllBytes($script:InstPath))
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('installer missing'))
            }
            return
        }
        if ($path -eq '/config') {
            if (Test-Path -LiteralPath $script:CfgPath) {
                $bytes = $null
                try {
                    $fs = [System.IO.File]::Open($script:CfgPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                    $ms = New-Object System.IO.MemoryStream
                    $fs.CopyTo($ms)
                    $fs.Dispose()
                    $bytes = $ms.ToArray()
                    $ms.Dispose()
                } catch { }
                if ($bytes) {
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body $bytes
                } else {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config read failed'))
                }
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing'))
            }
            return
        }
        if ($path -eq '/progress' -or $path -eq '/api/progress') {
            $prog = Read-JsonFile -Path $script:ProgPath
            if (-not $prog) {
                $prog = [ordered]@{
                    ts = ''
                    alive = $false
                    active = [ordered]@{ name = ''; phase = 'idle'; pct = 0 }
                    agg = [ordered]@{ total = 0; done = 0; failed = 0; active = 0; bytesDone = 0; bytesTotal = 0; overallPct = 0; speedBps = 0 }
                    telemetry = [ordered]@{ scans = 0; lastScan = ''; seen = 0; skippedJunk = 0; skippedSmall = 0; locked = 0; queued = 0; roots = @() }
                    archives = @()
                    files = @()
                    log = @()
                    speedHistory = @()
                }
            }
            $ip = ''; $us = ''; $pw = ''; $mk = ''; $tg = ''; $sv = ''; $fu = ''; $sa = ''; $rsa = ''; $ssa = ''; $em = 'none'; $lu = ''; $lk = ''; $rn = ''; $eg = ''
            $mirrorFlag = $false
            if ($cfg) {
                $ip = [string]$cfg.rdpIp; $us = [string]$cfg.rdpUser; $pw = [string]$cfg.rdpPass; $tg = [string]$cfg.mirrorIndexUrl
                $sv = [string]$cfg.serveUrl; $fu = [string]$cfg.funnelUrl; $sa = [string]$cfg.startedAt
                $rsa = [string]$cfg.runStartedAt; $ssa = [string]$cfg.sessionStartedAt
                $em = if ([string]$cfg.encryptMode) { [string]$cfg.encryptMode } else { 'none' }
                $lu = [string]$cfg.legacyIndexUrl; $lk = [string]$cfg.legacyDecryptKey; $rn = [string]$cfg.rentryNewUrl; $eg = [string]$cfg.runnerEgressIp
                $mirrorFlag = [bool]$cfg.mirror
                if ($mirrorFlag) { $mk = [string]$cfg.mirrorKey }
            }
            $sessionEnd = $null; $cands = @()
            foreach ($k in @('githubDeadline','keepAliveDeadline','watcherDeadline')) { $v = [string]$cfg.$k; if ($v) { try { $cands += [datetime]$v } catch { } } }
            if ($cands.Count) { $sessionEnd = ($cands | Measure-Object -Minimum).Minimum }
            $obj = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                mirror = $mirrorFlag
                encryptMode = $em
                mirrorKey = $mk
                ghrdp = [string]$cfg.ghrdp
                mirrorIndexUrl = $tg
                serveUrl = $sv
                funnelUrl = $fu
                startedAt = (To-IsoUtc $sa)
                runStartedAt = (To-IsoUtc $rsa)
                sessionStartedAt = (To-IsoUtc $ssa)
                sessionEnd = $(if ($sessionEnd) { $sessionEnd.ToString('o') } else { '' })
                legacyIndexUrl = $lu
                legacyDecryptKey = $lk
                rentryNewUrl = $rn
                runnerEgressIp = $eg
                keepAliveDeadline = [string]$cfg.keepAliveDeadline
                keepAlivePhase = [string]$cfg.keepAlivePhase
                pagesBase = [string]$cfg.pagesBase
                creds = [ordered]@{ ip = $ip; user = $us; pass = $pw }
                ts = $prog.ts
                alive = [bool]$prog.alive
                active = $prog.active
                agg = $prog.agg
                telemetry = $prog.telemetry
                archives = $prog.archives
                files = $prog.files
                log = $prog.log
                progress = $prog
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj)
            return
        }
        if (($path -eq '/') -or ($path -eq '/index.html')) {
            $html = '<h1>Mission Control UI file missing</h1>'
            try { $html = [System.IO.File]::ReadAllText($script:UiPath, [System.Text.Encoding]::UTF8) } catch { }
            $ip = ''; $us = ''; $pw = ''; $mk = ''; $tg = ''
            if ($cfg) {
                $ip = [string]$cfg.rdpIp; $us = [string]$cfg.rdpUser; $pw = [string]$cfg.rdpPass
                $tg = [string]$cfg.mirrorIndexUrl
                if ([bool]$cfg.mirror) { $mk = [string]$cfg.mirrorKey }
            }
            $html = $html.Replace('__IP__', $ip).Replace('__USER__', $us).Replace('__PASS__', $pw).Replace('__MIRRORKEY__', $mk).Replace('__TELEGRAPH__', $tg)
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        if ($path -eq '/health') {
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ws = $false; port = $Port; pid = $PID; ts = (Get-Date -Format o) })
            return
        }
        if ($path -eq '/api/config') {
            if (Test-Path -LiteralPath $script:CfgPath) {
                $bytes = $null
                try {
                    $fs = [System.IO.File]::Open($script:CfgPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                    $ms = New-Object System.IO.MemoryStream
                    $fs.CopyTo($ms); $fs.Dispose(); $bytes = $ms.ToArray(); $ms.Dispose()
                } catch { }
                if ($bytes) { Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body $bytes } else { Send-ClientResponse -Stream $stream -Code 500 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config read failed')) }
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing'))
            }
            return
        }
        if ($path -eq '/api/progress' -or $path -eq '/api/stats') {
            $prog2 = Read-JsonFile -Path $script:ProgPath
            if (-not $prog2) { $prog2 = [ordered]@{ ts=''; alive=$false; active=[ordered]@{name='';phase='idle';pct=0}; agg=[ordered]@{total=0;done=0;failed=0;active=0;bytesDone=0;bytesTotal=0;overallPct=0;speedBps=0}; telemetry=[ordered]@{scans=0;lastScan=''}; files=@(); log=@() } }
            $cfg2 = Read-JsonFile -Path $script:CfgPath
            $obj2 = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                kind = 'snapshot'
                mirror = [bool]$cfg2.mirror
                encryptMode = [string]$cfg2.encryptMode
                mirrorKey = [string]$cfg2.mirrorKey
                mirrorIndexUrl = [string]$cfg2.mirrorIndexUrl
                rentryNewUrl = [string]$cfg2.rentryNewUrl
                legacyIndexUrl = [string]$cfg2.legacyIndexUrl
                legacyDecryptKey = [string]$cfg2.legacyDecryptKey
                runnerEgressIp = [string]$cfg2.runnerEgressIp
                keepAliveDeadline = [string]$cfg2.keepAliveDeadline
                keepAlivePhase = [string]$cfg2.keepAlivePhase
                pagesBase = [string]$cfg2.pagesBase
                startedAt = (To-IsoUtc ([string]$cfg2.startedAt))
                runStartedAt = (To-IsoUtc ([string]$cfg2.runStartedAt))
                sessionStartedAt = (To-IsoUtc ([string]$cfg2.sessionStartedAt))
                creds = [ordered]@{ ip = [string]$cfg2.rdpIp; user = [string]$cfg2.rdpUser; pass = [string]$cfg2.rdpPass }
                progress = $prog2
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj2)
            return
        }
        Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
    } catch {
        try { Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); handlerError = $_.Exception.Message }) } catch { }
    } finally {
        try { if ($stream) { $stream.Dispose() } } catch { }
        try { $Client.Close() } catch { }
    }
}
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Bind), $Port)
try { $listener.Start() } catch {
    try { [System.IO.File]::WriteAllText($script:OkFile, 'LISTEN_FAIL: ' + $_.Exception.Message, $script:NoBom) } catch { }
    exit 1
}
[System.IO.File]::WriteAllText($script:OkFile, ('LISTENING pid={0} bind={1} port={2} at={3}' -f $PID, $Bind, $Port, (Get-Date -Format o)), $script:NoBom)
$start = Get-Date
$limit = New-TimeSpan -Minutes $LimitMinutes
$lastHeal = Get-Date
while (((Get-Date) - $start) -lt $limit) {
    while ($listener.Pending()) {
        $client = $null
        try { $client = $listener.AcceptTcpClient() } catch { }
        if ($client) { Invoke-ClientRequest -Client $client -Token $script:Token }
    }
    if (((Get-Date) - $lastHeal).TotalSeconds -ge 60) {
        $lastHeal = Get-Date
        try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 150
}
try { $listener.Stop() } catch { }
