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
$script:WebDeskHtml = ''
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
    $method = 'GET'
    if ($lines.Count -gt 0 -and $lines[0]) { $tok0 = ($lines[0].Trim() -split ' ')[0]; if ($tok0) { $method = $tok0.ToUpper() } }
    return @{ path = $path; headers = $headers; query = $query; method = $method }
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
$headerDone = $false
$idx = -1
$cl = 0
$bodyBytes = New-Object System.Collections.Generic.List[byte]
while ($true) {
$n = 0
try { $n = $Stream.Read($buf, 0, $buf.Length) } catch { break }
if ($n -le 0) { break }
if (-not $headerDone) {
[void]$acc.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
$txt = $acc.ToString()
$idx = $txt.IndexOf("`r`n`r`n")
if ($idx -ge 0) {
$headerDone = $true
$m = [regex]::Match($txt, '(?im)^Content-Length:\s*(\d+)')
if ($m.Success) { $cl = [int]$m.Groups[1].Value }
$priorLen = $acc.Length - $n
$bodyStart = ($idx + 4) - $priorLen
if ($bodyStart -lt 0) { $bodyStart = 0 }
if ($bodyStart -lt $n) { $bodyBytes.AddRange([byte[]]$buf[$bodyStart..($n - 1)]) }
if ($bodyBytes.Count -ge $cl) { break }
}
if ($acc.Length -gt 65536) { break }
} else {
$bodyBytes.AddRange([byte[]]$buf[0..($n - 1)])
if ($bodyBytes.Count -ge $cl) { break }
}
}
$head = $acc.ToString()
if ($idx -ge 0) { $head = $head.Substring(0, $idx + 4) }
return @{ head = $head; body = $bodyBytes.ToArray() }
}
function Send-ClientResponse {
    param($Stream, [int]$Code, [string]$CType, [byte[]]$Body)
    $status = 'OK'
    if ($Code -eq 401) { $status = 'Unauthorized' }
    if ($Code -eq 404) { $status = 'Not Found' }
    if ($Code -eq 500) { $status = 'Server Error' }
    $hdr = "HTTP/1.1 $Code $status`r`nContent-Type: $CType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Methods: GET,POST,OPTIONS`r`n`r`n"
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
        $rr = Read-ClientRequest -Stream $stream
        if (-not $rr -or -not $rr.head) { return }
        $parts = Get-RequestParts -Raw ([string]$rr.head)
        $parts['body'] = [byte[]]$rr.body
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
        if ($path -eq '/install.bat') {
            $ipForBat = '127.0.0.1'
            try { $cfgBat = Read-JsonFile -Path $script:CfgPath; if ($cfgBat -and $cfgBat.rdpIp) { $ipForBat = [string]$cfgBat.rdpIp } } catch { }
            $bat = "@echo off`r`ntitle GHRDP installer`r`npowershell -NoProfile -ExecutionPolicy Bypass -Command `"irm http://" + $ipForBat + ":7331/install.ps1 | iex`"`r`necho.`r`necho If nothing happened above, copy the printed command and run it manually.`r`npause`r`n"
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/octet-stream' -Body ([System.Text.Encoding]::ASCII.GetBytes($bat))
            return
        }
        if ($path -eq '/connect-now.bat') {
            $cip = [string]$cfg.rdpIp; $cu = [string]$cfg.rdpUser; $cpBat = ([string]$cfg.rdpPass) -replace '\^', '^^'
            $bat = '@echo off' + "`r`n" + 'title GHRDP auto-connect' + "`r`n" + 'cmdkey /generic:TERMSRV/' + $cip + ' /user:' + $cu + ' /pass:' + $cpBat + ' >nul 2>&1' + "`r`n" + 'start "" mstsc /v:' + $cip + "`r`n" + 'timeout /t 15 >nul' + "`r`n" + 'cmdkey /delete:TERMSRV/' + $cip + ' >nul 2>&1' + "`r`n" + 'exit /b 0' + "`r`n"
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/octet-stream' -Body ([System.Text.Encoding]::ASCII.GetBytes($bat))
            return
        }
        if ($path -eq '/webdesk-boot') {
            $outB = @{ ok = $false; message = '' }
            try {
                try { . 'C:\ghrdp\ghrdp-lib.ps1' } catch { }
                $cfgB = Read-JsonFile -Path $script:CfgPath
                $made = Start-GhrdpLoopbackSession -User ([string]$cfgB.rdpUser) -Pass ([string]$cfgB.rdpPass)
                $outB.ok = $true; $outB.message = ('loopback bootstrap ran; session row=' + $made + '; diag=C:\ghrdp\webdesk\boot-diag.txt')
            } catch { $outB.message = $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(($outB | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-probe') {
            $wPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-pub2.ps1'
            $bPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-bootstrap-session.ps1'
            $task = $false
            try { $task = [bool](Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue) } catch { }
            $sess = $false
            try { $q = (& quser.exe 2>$null) -join "`n"; $LASTEXITCODE = 0; $cfgP = Read-JsonFile -Path $script:CfgPath; if (($q -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($q -match 'runneradmin')) { $sess = $true } } catch { }
            $sessState = 'no-session'
            try { $ql2 = @(& quser.exe 2>$null); $LASTEXITCODE = 0; foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin')) -and ($qr2 -match '\bActive\b')) { $sessState = 'Active'; break } }; if ($sessState -eq 'no-session') { foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin'))) { $sessState = 'Disc'; break } } } } catch { $sessState = 'error' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ webdeskPs = $wPs; bootstrapPs = $bPs; task = $task; session = $sess; diag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\boot-diag.txt') } catch { '' }); wdErr = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); mstscDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\mstsc-exit-diag.txt') } catch { '' }); tsPath = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\ts-path.txt') } catch { '' }); aliveAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-alive.txt')).TotalMilliseconds } catch { -1 }); capFail = $(try { $cfi = Get-Item 'C:\ghrdp\webdesk\webdesk-capture-fail.txt' -ErrorAction Stop; if (((Get-Date) - $cfi.LastWriteTime).TotalSeconds -lt 60) { [System.IO.File]::ReadAllText($cfi.FullName) } else { '' } } catch { '' }); version = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-version.txt') } catch { '' }); manualDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\diag-manual.txt') } catch { '' }); displayCount = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\display-count.txt') } catch { '' }); frameExists = $(Test-Path 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction SilentlyContinue); frameSize = $(try { (Get-Item 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction Stop).Length } catch { -1 }); startAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-start.txt')).TotalMilliseconds } catch { -1 }); initResult = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-init.txt') } catch { '' }); captureProcAlive = $(try { $m = [System.Threading.Mutex]::OpenExisting('Global\GhrdpWebDeskSingle'); $h = $m.WaitOne(0); if (-not $h) { 'RUNNING (mutex held)' } else { $m.ReleaseMutex(); 'NOT RUNNING' } } catch { 'NOT RUNNING' }); pidFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk.pid') } catch { '' }); errFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); trace = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-trace.txt') } catch { '' }); captureProcs = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\procs.txt') } catch { '' }); sessionState = $sessState; taskState = $(try { $t = Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() } else { 'not-registered' } } catch { 'error' }); taskLastRun = $(try { $i = Get-ScheduledTaskInfo -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($i) { $i.LastRunTime.ToString() + ' result=' + $i.LastTaskResult } else { 'never' } } catch { 'error' }) } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-status') {
            $ageMs = -1
            try { $tsTxt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\frame-ts.txt'); $ageMs = [int]((Get-Date) - [datetime]$tsTxt).TotalMilliseconds } catch { }
            $outJ = @{ ok = ($ageMs -ge 0 -and $ageMs -lt 15000); frameAgeMs = $ageMs } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
            return
        }
        if ($path -eq '/webdesk-frame') {
            try { $b = [System.IO.File]::ReadAllBytes('C:\ghrdp\webdesk\frame.jpg'); Send-ClientResponse -Stream $stream -Code 200 -CType 'image/jpeg' -Body $b } catch { Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('no frame yet')) }
            return
        }
        if ($path -eq '/webdesk-input') {
            $btxt = ''
            try { $btxt = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) } catch { }
            $wrote = $false
            try {
                $bj = $null
                try { $bj = $btxt | ConvertFrom-Json } catch { }
                $linesOut = @()
                if ($bj -is [System.Collections.IEnumerable] -and $bj -isnot [string]) { foreach ($e1 in @($bj)) { $linesOut += ($e1 | ConvertTo-Json -Compress) } } else { $linesOut += $btxt }
                $dir = 'C:\ghrdp\webdesk'
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null }
                try {
                    [System.IO.File]::AppendAllText((Join-Path $dir 'input.ndjson'), (($linesOut -join "`n") + "`n"))
                    $wrote = $true
                } catch {
                    try { Add-Content -LiteralPath (Join-Path $dir 'input.ndjson') -Value (($linesOut -join "`n")) -Encoding UTF8; $wrote = $true } catch { }
                }
            } catch { }
            try { $cf = 'C:\ghrdp\webdesk\input-count.txt'; $n = 0; if (Test-Path -LiteralPath $cf) { try { $n = [int]([System.IO.File]::ReadAllText($cf).Trim()) } catch { } }; [System.IO.File]::WriteAllText($cf, ([string]($n + 1))) } catch { }
            $okTxt = if ($wrote) { 'true' } else { 'false' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":' + $okTxt + '}'))
            return
        }
        if ($path -eq '/webdesk-clip') {
            if ([string]$parts.method -eq 'POST') {
                try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-set.json', ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body))) } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                return
            }
            try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-get.flag', (Get-Date).ToUniversalTime().ToString('o')) } catch { }
            $txt = $null
            try { if (Test-Path 'C:\ghrdp\webdesk\clip.txt') { $txt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\clip.txt') } } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ text = $txt } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-ctl') {
            if ($parts.method -eq 'POST') {
                try {
                    $body = [System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)
                    $j = $body | ConvertFrom-Json
                    if ($j -and $null -ne $j.q -and $null -ne $j.scale) {
                        $qq = [long]$j.q; $ss = [double]$j.scale
                        if ($qq -ge 1 -and $qq -le 100 -and $ss -gt 0 -and $ss -le 1) {
                            [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\ctl.json', ('{"q":' + $qq + ',"scale":' + $ss.ToString([System.Globalization.CultureInfo]::InvariantCulture) + '}'))
                        }
                    }
                } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                return
            } else {
                $cur = @{ q = 35; scale = 0.5 }
                if (Test-Path -LiteralPath 'C:\ghrdp\webdesk\ctl.json') {
                    try {
                        $raw2 = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\ctl.json').Trim()
                        if ($raw2.Length -gt 0) { $cur = $raw2 | ConvertFrom-Json } else { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\ctl.json', '{"q":35,"scale":0.5}') }
                    } catch { }
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(($cur | ConvertTo-Json -Compress)))
                return
            }
        }
        if ($path -eq '/terminal') {
            $termPage = @'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHRDP Terminal</title>
<style>
:root{--glass:rgba(255,255,255,.08);--stroke:rgba(255,255,255,.16);--txt:#f5f5f7;--dim:rgba(245,245,247,.6)}
*{box-sizing:border-box}
body{margin:0;height:100vh;color:var(--txt);font:14px/1.45 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif;background:#0b0e14;overflow:hidden}
body::before{content:'';position:fixed;inset:-20%;background:radial-gradient(40% 35% at 20% 20%,rgba(64,120,255,.35),transparent 60%),radial-gradient(35% 30% at 80% 25%,rgba(255,80,160,.28),transparent 60%),radial-gradient(45% 40% at 50% 85%,rgba(60,220,180,.22),transparent 60%);filter:blur(40px) saturate(160%);animation:drift 18s ease-in-out infinite alternate;z-index:0}
@keyframes drift{from{transform:translate3d(-2%,-1%,0) scale(1)}to{transform:translate3d(2%,2%,0) scale(1.06)}}
.glass{position:relative;z-index:1;background:var(--glass);border:1px solid var(--stroke);border-radius:18px;backdrop-filter:saturate(180%) blur(22px);-webkit-backdrop-filter:saturate(180%) blur(22px);box-shadow:0 8px 32px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12)}
#app{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;height:100vh;padding:14px}
#bar{display:flex;gap:8px;align-items:center;padding:10px 12px;flex-wrap:wrap}
#bar input,#bar select{background:rgba(255,255,255,.06);border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 10px;font:inherit;outline:none}
#bar input:focus{border-color:rgba(120,170,255,.7);box-shadow:0 0 0 3px rgba(90,140,255,.25)}
button{background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.08));border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 12px;font:inherit;cursor:pointer;backdrop-filter:blur(8px)}
button:hover{background:linear-gradient(180deg,rgba(255,255,255,.3),rgba(255,255,255,.14))}
button.primary{background:linear-gradient(180deg,#4f8cff,#2f6bff);border-color:rgba(255,255,255,.35)}
#code{flex:0 0 26vh;background:rgba(0,0,0,.35);border:1px solid var(--stroke);border-radius:16px;color:#e8f0ff;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:none;outline:none;backdrop-filter:blur(14px)}
#out{flex:1;overflow:auto;background:rgba(0,0,0,.45);border:1px solid var(--stroke);border-radius:16px;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;backdrop-filter:blur(14px)}
.meta{color:#7ee787}.err{color:#ff7b72}.dim{color:var(--dim)}
#chip{margin-left:auto;font-size:12px;color:var(--dim)}
</style></head><body>
<div id="app">
 <div id="bar" class="glass">
  <input id="cmd" size="52" placeholder="one-line command (inline mode)">
  <button id="bCmd" class="primary">Run Cmd</button>
  <input id="fpath" size="34" placeholder="C:\path\script.ps1 (file mode)">
  <button id="bFile">Run File</button>
  <select id="sess"><option value="system">SYSTEM (s0)</option><option value="interactive">INTERACTIVE (user session)</option></select>
  <input id="tmo" size="6" value="60000">
  <button id="bPaste">Run Paste</button>
  <button id="bCopy">Copy Out</button>
  <span id="chip">GHRDP Terminal · liquid glass</span>
 </div>
 <textarea id="code" class="glass" placeholder="paste long .ps1 here → Run Paste (upload mode, base64-safe)"></textarea>
 <div id="out" class="glass"><span class="dim">ready.</span></div>
</div>
<script>
var tok=new URLSearchParams(location.search).get('token')||'';
var out=document.getElementById('out');
function show(j){out.innerHTML='';var m=document.createElement('div');m.className='meta';m.textContent='exit='+j.exitCode+' timedOut='+j.timedOut+' ms='+j.durationMs+' session='+j.session+' file='+j.scriptPath;out.appendChild(m);var o=document.createElement('div');o.textContent=j.output||'(no stdout)';out.appendChild(o);if(j.error){var e=document.createElement('div');e.className='err';e.textContent='STDERR:\n'+j.error;out.appendChild(e);}}
function run(body){out.innerHTML='<span class="dim">running…</span>';fetch('/terminal-exec',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(show).catch(function(e){out.textContent='FETCH ERROR: '+e;});}
document.getElementById('bCmd').onclick=function(){run({mode:'inline',cmd:document.getElementById('cmd').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bFile').onclick=function(){run({mode:'file',file:document.getElementById('fpath').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bPaste').onclick=function(){var t=document.getElementById('code').value;run({mode:'upload',script_b64:btoa(unescape(encodeURIComponent(t))),session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bCopy').onclick=function(){navigator.clipboard.writeText(out.innerText);};
</script></body></html>
'@
                      $htmlT = $null
                      try { if (Test-Path -LiteralPath 'C:\ghrdp\terminal-ui.html') { $htmlT = [System.IO.File]::ReadAllText('C:\ghrdp\terminal-ui.html') } } catch { }
                      if (-not $htmlT) { $htmlT = $termPage }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($htmlT))
            return
        }
                if ($path -eq '/terminal-exec') {
                    $timeoutMs = 60000
                    $tmode = 'inline'
                    $tsess = 'system'
                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $tid = ''
                    $tscript = ''
                    $toutF = ''
                    $terrF = ''
                    $workDir = 'C:\ghrdp\webdesk\term'
                    try {
                        $req = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                        $tmode = if ($req.mode) { [string]$req.mode } else { 'inline' }
                        if ($req.timeout) { $timeoutMs = [int]$req.timeout }
                        if ($timeoutMs -gt 300000) { $timeoutMs = 300000 }
                        if ($timeoutMs -lt 1000) { $timeoutMs = 1000 }
                        if ($req.session -eq 'interactive') { $tsess = 'interactive' }
                        New-Item -ItemType Directory -Path $workDir -Force -ErrorAction SilentlyContinue | Out-Null
                        $tid = [guid]::NewGuid().ToString('N').Substring(0, 8)
                        $tscript = Join-Path $workDir ('run-' + $tid + '.ps1')
                        $toutF = Join-Path $workDir ('out-' + $tid + '.txt')
                        $terrF = Join-Path $workDir ('err-' + $tid + '.txt')
                        $ownScript = $true
                        if ($tmode -eq 'upload') {
                            if (-not [string]$req.script_b64) { throw 'missing script_b64' }
                            [System.IO.File]::WriteAllText($tscript, ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$req.script_b64))))
                        } elseif ($tmode -eq 'file') {
                            if (-not (Test-Path -LiteralPath ([string]$req.file))) { throw ('file not found: ' + [string]$req.file) }
                            $tscript = [string]$req.file
                            $ownScript = $false
                        } else {
                            if (-not [string]$req.cmd) { throw 'empty cmd' }
                            [System.IO.File]::WriteAllText($tscript, ([string]$req.cmd))
                        }
                        try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\terminal-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' mode=' + $tmode + ' session=' + $tsess + ' file=' + $tscript + "`n")) } catch { }
                      $statusFile = Join-Path $workDir ('status-' + $tid + '.txt')
                      [System.IO.File]::WriteAllText($statusFile, 'running')
                      if ($tsess -eq 'system') {
                          try {
                              $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $tscript + '"')) -WorkingDirectory $workDir -RedirectStandardOutput $toutF -RedirectStandardError $terrF -NoNewWindow -PassThru
                              Start-Job -ScriptBlock { param($pid2,$tmo,$sf) $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue; if ($p) { if (-not $p.WaitForExit($tmo)) { try { $p.Kill() } catch { }; [System.IO.File]::WriteAllText($sf,'timeout') } else { [System.IO.File]::WriteAllText($sf,('exit=' + $p.ExitCode)) } } else { [System.IO.File]::WriteAllText($sf,'exit=-1') } } -ArgumentList $proc.Id, $timeoutMs, $statusFile | Out-Null
                          } catch { [System.IO.File]::WriteAllText($statusFile, ('error=' + $_.Exception.Message)) }
                      } else {
                          $activeUser = ''
                          try { $qu = & quser.exe 2>$null; $LASTEXITCODE = 0; foreach ($line in @($qu)) { if ($line -match '^\s*>?\s*(\S+)\s+\S+\s+\d+\s+Active') { $activeUser = $Matches[1]; break } } } catch { }
                          if (-not $activeUser) { [System.IO.File]::WriteAllText($statusFile, 'error=no active user session') }
                          else {
                              $taskName = 'GhrdpTerm-' + $tid
                              $wrapPath = Join-Path $workDir ('wrap-' + $tid + '.ps1')
                              $wrap = 'param($sp,$op,$ep2)' + "`r`n" + '$p = Start-Process -FilePath ''powershell.exe'' -ArgumentList @(''-NoProfile'',''-ExecutionPolicy'',''Bypass'',''-File'',([char]34 + $sp + [char]34)) -RedirectStandardOutput $op -RedirectStandardError $ep2 -NoNewWindow -Wait -PassThru' + "`r`n" + 'exit $p.ExitCode'
                              [System.IO.File]::WriteAllText($wrapPath, $wrap)
                              try {
                                  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $wrapPath + '" "' + $tscript + '" "' + $toutF + '" "' + $terrF + '"')
                                  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(1)
                                  $principal = New-ScheduledTaskPrincipal -UserId $activeUser -LogonType Interactive -RunLevel Highest
                                  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMilliseconds($timeoutMs))
                                  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
                                  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
                                  Start-Job -ScriptBlock { param($tn,$tmo,$sf) $deadline = (Get-Date).AddMilliseconds($tmo); while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $ti = Get-ScheduledTaskInfo -TaskName $tn -ErrorAction SilentlyContinue; if ($ti) { $lr = [int]$ti.LastTaskResult; if ($lr -ne 267009 -and $lr -ne 267010 -and $lr -ne 267011) { [System.IO.File]::WriteAllText($sf, ('exit=' + $lr)); try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue } catch { }; return } } }; [System.IO.File]::WriteAllText($sf, 'timeout'); try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue } catch { } } -ArgumentList $taskName, $timeoutMs, $statusFile | Out-Null
                              } catch { [System.IO.File]::WriteAllText($statusFile, ('error=' + $_.Exception.Message)) }
                          }
                      }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ runId = $tid; session = $tsess; scriptPath = $tscript })
                      return
                    } catch {
                      $errMsg = $_.Exception.Message
                      try {
                        if ($tid) {
                          $sfErr = Join-Path $workDir ('status-' + $tid + '.txt')
                          [System.IO.File]::WriteAllText($sfErr, ('error=' + $errMsg))
                        }
                      } catch { }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ error = $errMsg })
                      return
                    }
                  }
                  # ============= /terminal-result (GET ?id=) =============
                  if ($path -eq '/terminal-result') {
                      $rid = ''
                      if ($parts.query -and $parts.query.ContainsKey('id')) { $rid = [string]$parts.query['id'] }
                      $workDir2 = 'C:\ghrdp\webdesk\term'
                      $sf2 = Join-Path $workDir2 ('status-' + $rid + '.txt')
                      $st = 'running'; if (Test-Path -LiteralPath $sf2) { try { $st = [System.IO.File]::ReadAllText($sf2).Trim() } catch { } }
                      $done = ($st -ne 'running')
                      $exitCode = $null; $timedOut = $false; $errMsg = ''
                      if ($st -like 'exit=*') { $exitCode = [int]($st.Substring(5)) }
                      elseif ($st -eq 'timeout') { $timedOut = $true }
                      elseif ($st -like 'error=*') { $errMsg = $st.Substring(6) }
                      $outTxt = ''; $errTxt = ''
                      if ($done) {
                          for ($a = 1; $a -le 5; $a++) {
                              $o1 = $true; $o2 = $true
                              try { $op = Join-Path $workDir2 ('out-' + $rid + '.txt'); if (Test-Path -LiteralPath $op) { $outTxt = [System.IO.File]::ReadAllText($op) } } catch { $o1 = $false }
                              try { $ep2 = Join-Path $workDir2 ('err-' + $rid + '.txt'); if (Test-Path -LiteralPath $ep2) { $errTxt = [System.IO.File]::ReadAllText($ep2) } } catch { $o2 = $false }
                              if ($o1 -and $o2) { break }
                              Start-Sleep -Milliseconds 300
                          }
                          if ($errMsg -and -not $errTxt) { $errTxt = $errMsg }
                      }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ done = $done; exitCode = $exitCode; timedOut = $timedOut; output = $outTxt; error = $errTxt })
                      return
                  }
        if ($path -eq '/remote-exec') {
            $timeout = 30000
            $out = ''
            try {
                $rj = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                $sb64 = [string]$rj.script_b64
                if (-not $sb64) { throw 'missing script_b64' }
                if ($rj.timeout) { $timeout = [int]$rj.timeout }
                $scriptContent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sb64))
                try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\remote-exec-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' REMOTE-EXEC len=' + $scriptContent.Length + ' head=' + $scriptContent.Substring(0, [Math]::Min(200, $scriptContent.Length)) + "`n")) } catch { }
                $tmpScript = Join-Path $env:TEMP ('ghrdp-remote-' + [guid]::NewGuid().ToString('N') + '.ps1')
                [System.IO.File]::WriteAllText($tmpScript, $scriptContent)
                $job = Start-Job -ScriptBlock { param($s) powershell -NoProfile -ExecutionPolicy Bypass -File $s } -ArgumentList $tmpScript
                $job | Wait-Job -Timeout ($timeout / 1000) | Out-Null
                if ($job.State -eq 'Running') { $job | Stop-Job -Force; $out = 'TIMEOUT after ' + ($timeout / 1000) + 's' }
                else { $out = ($job | Receive-Job | Out-String); if (-not $out) { $out = '(no output)' } }
                try { $job | Remove-Job -Force } catch { }
                try { Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue } catch { }
            } catch { $out = 'ERROR: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(('{"output":' + ([string]$out | ConvertTo-Json) + '}')))
            return
        }
        if ($path -eq '/webdesk') {
            $html = $null
            try { if (Test-Path -LiteralPath 'C:\ghrdp\webdesk-ui.html') { $html = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk-ui.html') } } catch { }
            if (-not $html) { $html = $script:WebDeskHtml }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        if ($path -eq '/novnc') {
            $htmlN = @'
<!doctype html><html><head><meta charset="utf-8"><title>GHRDP Web Desktop</title>
<style>html,body{margin:0;height:100%;background:#101418;overflow:hidden}#screen{width:100%;height:100%}#bar{position:fixed;top:0;left:0;right:0;padding:8px 12px;font:13px system-ui;color:#e8eef3;background:#1b2530;display:flex;gap:12px;align-items:center;z-index:9}#bar .st{color:#8aa0ad}#bar button{background:#153e5c;color:#e8eef3;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}</style>
</head><body>
<div id="bar"><b>GHRDP Web Desktop</b><span class="st" id="st">checking backend...</span><button id="re">Retry</button></div>
<div id="screen"></div>
<script type="module">
const st=document.getElementById('st');
const WS='ws://'+location.hostname+':7333/';
function wsProbe(url){return new Promise((res,rej)=>{let w;try{w=new WebSocket(url);}catch(e){rej(e);return;}const t=setTimeout(()=>{try{w.close();}catch(e){}rej(new Error('timeout - bridge not answering'));},5000);w.onopen=()=>{clearTimeout(t);try{w.close();}catch(e){}res(true);};w.onerror=()=>{clearTimeout(t);rej(new Error('websocket refused/blocked - firewall 7333 or websockify down'));};});}
let rfb=null;
async function boot(){
  st.textContent='checking backend...';
  try{
    const r=await fetch('/vncstatus',{cache:'no-store'});
    const j=await r.json();
    if(!j.ok){ st.textContent='backend down: vnc5900='+j.vnc+' bridge7333='+j.bridge+' - keep-alive self-heals every 2 min; click Retry'; return; }
  }catch(e){ st.textContent='cannot reach /vncstatus: '+e; return; }
  st.textContent='probing websocket '+WS+' ...';
  try{ await wsProbe(WS); }catch(e){ st.textContent='WS probe failed: '+e.message; return; }
  st.textContent='loading noVNC + connecting...';
  try{
    const mod=await import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.4.0/core/rfb.js');
    if(rfb){ try{rfb.disconnect();}catch(e){} }
    rfb=new mod.default(document.getElementById('screen'),WS,{});
    rfb.scaleViewport=true; rfb.clipboardCapable=true;
    rfb.addEventListener('connect',()=>{st.textContent='connected - clipboard active';});
    rfb.addEventListener('securityfailure',e=>{st.textContent='VNC security rejected: '+e.detail.reason+' (type '+e.detail.status+')';});
    rfb.addEventListener('disconnect',e=>{st.textContent='disconnected code='+((e.detail&&e.detail.code)||'none')+' reason='+((e.detail&&e.detail.reason)||'none')+' clean='+((e.detail&&e.detail.clean)||false)+' - Retry';});
    rfb.addEventListener('credentialsrequired',()=>{st.textContent='server demands a password but auth should be NONE - run PATCH 1 on the runner';});
  }catch(e){ st.textContent='noVNC load failed: '+e; }
}
document.getElementById('re').onclick=boot;
boot();
</script></body></html>
'@
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($htmlN))
            return
        }
        if ($path -eq '/vncstatus') {
            $vncUp = $false; $brUp = $false
            try { $vncUp = [bool](Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue) } catch { }
            try { $brUp = [bool](Get-NetTCPConnection -LocalPort 7333 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $outJ = @{ ok = ($vncUp -and $brUp); vnc = $vncUp; bridge = $brUp } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
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
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
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
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj.conn = $conn
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
        if ($path -eq '/rdp') {
            $rdpIp2 = ''; $rdpUser2 = ''
            if ($cfg) { $rdpIp2 = [string]$cfg.rdpIp; $rdpUser2 = [string]$cfg.rdpUser }
            $lines = @(
                'screen mode id:i:2',
                'desktopwidth:i:1920',
                'desktopheight:i:1080',
                'session bpp:i:32',
                'compression:i:1',
                'keyboardhook:i:2',
                'audiocapturemode:i:0',
                'videoplaybackmode:i:0',
                'connection type:i:3',
                'networkautodetect:i:0',
                'bandwidthautodetect:i:0',
                'disable wallpaper:i:1',
                'disable full window drag:i:1',
                'disable menu anims:i:1',
                'disable themes:i:0',
                'disable cursor setting:i:1',
                'bitmapcachepersist:i:1',
                'smart sizing:i:0',
                'redirectclipboard:i:1',
                'redirectprinters:i:0',
                'redirectcomports:i:0',
                'redirectsmartcards:i:0',
                'redirectdrives:i:0',
                'autoreconnection enabled:i:1',
                'prompt credential once:i:0',
                'enableworkspacereconnect:i:0',
                'use multimon:i:0',
                'enablerdpudp:i:1',
                ('full address:s:' + $rdpIp2),
                ('username:s:' + $rdpUser2),
                'prompt for credentials:i:1',
                'negotiate security layer:i:1'
            )
            $rdpTxt = ($lines -join "`r`n")
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/x-rdp-file; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($rdpTxt))
            return
        }
        if ($path -eq '/ping') {
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ts = (Get-Date -Format o); wire = $script:Wire })
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
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
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
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj2.conn = $conn
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj2)
            return
        }
        if ($path -eq '/parsec-push') {
            $j = $null
            try { $j = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json } catch { }
            if (-not $j -or (-not $j.binB64)) {
                Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"message":"missing binB64"}'))
                return
            }
            $ru = [string]$cfg.rdpUser
            $prof = $null
            try {
                $keys = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction SilentlyContinue
                foreach ($k in $keys) {
                    $img = (Get-ItemProperty -Path $k.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
                    if ($img -and ((Split-Path -Leaf ([string]$img)) -ieq $ru)) { $prof = [string]$img; break }
                }
            } catch { }
            if (-not $prof) { $prof = 'C:\Users\' + $ru }
            $dest = Join-Path $prof 'AppData\Roaming\Parsec'
            try {
                New-Item -ItemType Directory -Path $dest -Force -ErrorAction Stop | Out-Null
                $cfgName = if ($j.cfgName) { [string]$j.cfgName } else { 'config.txt' }
                if ($j.cfgB64) { [System.IO.File]::WriteAllBytes((Join-Path $dest $cfgName), [Convert]::FromBase64String([string]$j.cfgB64)) }
                [System.IO.File]::WriteAllBytes((Join-Path $dest 'user.bin'), [Convert]::FromBase64String([string]$j.binB64))
                if ($j.hkB64) { [System.IO.File]::WriteAllBytes((Join-Path $dest 'hotkey.json'), [Convert]::FromBase64String([string]$j.hkB64)) }
                [System.IO.File]::WriteAllText((Join-Path $dest 'ghrdp-push.ok'), (Get-Date -Format o), $script:NoBom)
                $parsecExe = $null
                foreach ($cand in @('C:\Program Files\Parsec\parsecd.exe', 'C:\Program Files\Parsec\parsec.exe')) { if (Test-Path -LiteralPath $cand) { $parsecExe = $cand; break } }
                if ($parsecExe -and $ru) {
                    try { Get-Process -Name parsecd,parsec -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
                    try {
                        $ruPass = [string]$cfg.rdpPass
                        & schtasks.exe /Create /F /SC ONLOGON /TN 'GhrdpParsecStart' /TR ('"' + $parsecExe + '"') /RU $ru /RP $ruPass /IT 2>$null | Out-Null
                        $LASTEXITCODE = 0
                        & schtasks.exe /Run /TN 'GhrdpParsecStart' 2>$null | Out-Null
                        $LASTEXITCODE = 0
                    } catch { }
                }
                $out = @{ ok = $true; dest = $dest; cfg = $cfgName; src = ([string]$j.src) } | ConvertTo-Json -Compress
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($out))
            } catch {
                $out = @{ ok = $false; error = ($_.Exception.Message) } | ConvertTo-Json -Compress
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($out))
            }
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
$script:Wire = $null
$lastWirePing = [datetime]::MinValue
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
$wireProbeScript = @'
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$out = 'C:\ghrdp\wire-probe.json'
$hist = New-Object System.Collections.ArrayList
while ($true) {
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); rtt = $null; via = 'unknown'; direct = $false; peerIp = ''; peerName = ''; jit = $null; hist = @() }
  try {
    $j = (& $ts status --json 2>$null) | ConvertFrom-Json
    $peer = $null
    if ($j -and $j.Peer) { foreach ($p in $j.Peer.PSObject.Properties) { if ($p.Value.Online) { $peer = $p.Value; break } } }
    if ($peer) {
      $obj.peerIp = @($peer.TailscaleIPs)[0]
      $obj.peerName = [string]$peer.HostName
      $o = (& $ts ping -c 1 --timeout 5s $obj.peerIp 2>$null) -join ' '
      if ($o -match 'in ([0-9]+)ms') { $obj.rtt = [int]$Matches[1] }
      if ($o -match 'via DERP\(([a-z0-9]+)\)') { $obj.via = 'DERP(' + $Matches[1] + ')'; $obj.direct = $false }
      elseif ($o -match 'via ([0-9][0-9.:]+)') { $obj.via = 'DIRECT ' + $Matches[1]; $obj.direct = $true }
      if ($null -ne $obj.rtt) { [void]$hist.Add([int]$obj.rtt); if ($hist.Count -gt 20) { $hist.RemoveAt(0) } }
      if ($hist.Count -ge 3) { $d = 0; for ($i = 1; $i -lt $hist.Count; $i++) { $d += [math]::Abs([int]$hist[$i] - [int]$hist[$i-1]) }; $obj.jit = [math]::Round($d / ($hist.Count - 1), 1) }
      $obj.hist = @($hist)
    }
  } catch { }
  try { [System.IO.File]::WriteAllText($out, ($obj | ConvertTo-Json -Compress)) } catch { }
  Start-Sleep -Seconds 4
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'wire-probe.ps1'), $wireProbeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'wire-probe.ps1') -WindowStyle Hidden } catch { }
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Bind), $Port)
try { $listener.Start() } catch {
    try { [System.IO.File]::WriteAllText($script:OkFile, 'LISTEN_FAIL: ' + $_.Exception.Message, $script:NoBom) } catch { }
    exit 1
}
[System.IO.File]::WriteAllText($script:OkFile, ('LISTENING pid={0} bind={1} port={2} at={3}' -f $PID, $Bind, $Port, (Get-Date -Format o)), $script:NoBom)
$probeScript = @'
$ErrorActionPreference='Continue'
$ts='C:\Program Files\Tailscale\tailscale.exe'
$out='C:\ghrdp\conn-probe.json'
while($true){
  $obj=@{ts=(Get-Date).ToString('o'); rtt=$null; via='unknown'; direct=$false; peer=''}
  try{
    $j=(& $ts status --json 2>$null)|ConvertFrom-Json
    if($j -and $j.Peer){
      foreach($p in $j.Peer.PSObject.Properties){
        $peer=$p.Value
        if($peer.Online){
          $obj.peer=@($peer.TailscaleIPs)[0]
          break
        }
      }
    }
    if($obj.peer){
      $o=(& $ts ping -c 1 --timeout 2s $obj.peer 2>$null) -join ' '
      if($o -match 'via (DERP[A-Za-z0-9]*|[Dd]irect[A-Za-z0-9]*)'){ $obj.via=$Matches[1]; $obj.direct=($Matches[1] -like 'irect*' -or $Matches[1] -like 'D*irect*') }
      if($o -match 'in ([0-9.]+)\s*ms'){ $obj.rtt=[double]$Matches[1] }
    }
  }catch{}
  try{ [System.IO.File]::WriteAllText($out,($obj|ConvertTo-Json -Compress)) }catch{}
  Start-Sleep -Seconds 4
}
'@
$probePath = Join-Path $Root 'conn-probe.ps1'
[System.IO.File]::WriteAllText($probePath, $probeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$probePath -WindowStyle Hidden } catch { }
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
    Start-Sleep -Milliseconds 50
}
try { $listener.Stop() } catch { }
