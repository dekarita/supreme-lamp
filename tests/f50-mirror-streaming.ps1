# [F50/F51] Streaming upload + Downloads auto-upload lab (Windows lane).
#
# F50 (streaming): 100 MB / 1 GB / 3 GB / 6 GB fsutil-created sparse files
#   streamed through the SHIPPED Send-F46GofileUpload (HttpClient +
#   MultipartFormDataContent + StreamContent(FileStream)) to a discarding
#   loopback listener - byte-exact length-delimited multipart, zero auth
#   headers, sub-2 GB memory profile (no whole-file byte array anywhere).
#   The retry matrix (429 / 500 / 502 / connection reset / 403 / 413) and the
#   zero-network preflight refusals (size/type) run over the REAL streaming
#   transport, not a mock.
# F51 (auto-upload): unit truth table for the Downloads-root classifier + a
#   REAL watcher run: a file landing in Downloads uploads AUTOMATICALLY with
#   mirror=false (no opt-in), while the same marker on Desktop stays
#   tracked-not-uploaded.
# No live host is called; nothing leaves the runner. Exit 0 only when every
# check passes. Writes only under $env:RUNNER_TEMP (plus two proof files in
# the lab user's Downloads/Desktop, removed at the end).
$ErrorActionPreference = 'Stop'
$script:failures = 0

function Check([string]$Name, [bool]$Cond, [string]$Detail) {
    if ($Cond) {
        Write-Host ('  [PASS] ' + $Name)
    } else {
        $script:failures = $script:failures + 1
        Write-Host ('  [FAIL] ' + $Name + ' :: ' + $Detail)
        $ann = (('::error title=F50 check::' + $Name + ' :: ' + $Detail) -replace '[\r\n]+', ' ')
        Write-Host $ann
    }
}

$root = $env:GITHUB_WORKSPACE
if (-not $root) { $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$modPath = Join-Path $root 'payloads\ghrdp-mirror.ps1'
if (-not (Test-Path -LiteralPath $modPath)) { $modPath = Join-Path $root 'payloads/ghrdp-mirror.ps1' }
if (-not (Test-Path -LiteralPath $modPath)) { throw ('F50: the mirror module is missing at ' + $modPath) }
. $modPath
Write-Host ('[F50] module loaded: ' + $modPath)

$tmp = $env:RUNNER_TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath() }
$labRoot = Join-Path $tmp ('f50-lab-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
[void][System.IO.Directory]::CreateDirectory($labRoot)

$pwshExe = 'pwsh'
try { $c = Get-Command pwsh -ErrorAction Stop; if ($c) { $pwshExe = $c.Source } } catch { }

# --- shared helpers ---------------------------------------------------------
function Start-F50Listener {
    param([int]$PortBase)
    foreach ($off in 0..24) {
        $p = $PortBase + $off
        $l = New-Object System.Net.HttpListener
        try {
            $l.Prefixes.Add('http://127.0.0.1:' + $p + '/')
            $l.Start()
            return @{ listener = $l; port = $p }
        } catch { try { $l.Close() } catch { } }
    }
    return $null
}

function Get-F50Context {
    # Async context wait with a deadline + client-exit bailout: a hung peer can
    # never deadlock the lane.
    param($Listener, [int]$TimeoutMs, $ClientProc)
    $iar = $Listener.BeginGetContext($null, $null)
    $waited = 0
    while (-not $iar.IsCompleted) {
        if (-not $iar.AsyncWaitHandle.WaitOne(500)) {
            $waited = $waited + 500
            if ($waited -ge $TimeoutMs) { return $null }
            if ($ClientProc -and $ClientProc.HasExited) {
                Start-Sleep -Milliseconds 1500
                if (-not $iar.IsCompleted) { return $null }
            }
        }
    }
    try { return $Listener.EndGetContext($iar) } catch { return $null }
}

function Read-F50Request {
    # Discarding reader: counts every byte, captures the first 4 KB for the
    # contract markers. Never buffers the body.
    param($Ctx, [int]$HeadBytes = 4096)
    $head = New-Object System.Collections.Generic.List[byte]
    $total = [long]0
    $buf = New-Object byte[] 65536
    $s = $Ctx.Request.InputStream
    while (($n = $s.Read($buf, 0, $buf.Length)) -gt 0) {
        $total = $total + [long]$n
        if ($head.Count -lt $HeadBytes) {
            for ($j = 0; $j -lt $n -and $head.Count -lt $HeadBytes; $j++) { [void]$head.Add($buf[$j]) }
        }
    }
    return [ordered]@{
        method = [string]$Ctx.Request.HttpMethod
        path = [string]$Ctx.Request.Url.AbsolutePath
        ctype = [string]$Ctx.Request.ContentType
        clen = [long]$Ctx.Request.ContentLength64
        auth = [string]$Ctx.Request.Headers['Authorization']
        cookie = [string]$Ctx.Request.Headers['Cookie']
        hostTok = [string]$Ctx.Request.Headers['X-Gofile-Token']
        bytes = $total
        head = [System.Text.Encoding]::ASCII.GetString($head.ToArray())
    }
}

function Send-F50Response {
    param($Ctx, [string]$Json, [int]$Status = 200, [string]$RetryAfter = '')
    $rb = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $Ctx.Response.StatusCode = $Status
    $Ctx.Response.ContentType = 'application/json'
    if ($RetryAfter) { try { $Ctx.Response.Headers['Retry-After'] = $RetryAfter } catch { } }
    $Ctx.Response.ContentLength64 = $rb.Length
    $Ctx.Response.OutputStream.Write($rb, 0, $rb.Length)
    $Ctx.Response.Close()
}

function Start-F50Client {
    # The client runs in its OWN pwsh process (the production engine) so the
    # upload's memory profile is measurable. Returns the Process object; the
    # caller serves the listener WHILE it runs, then Wait-F50Client.
    param([string]$ScriptPath)
    $outLog = $ScriptPath + '.out.log'
    $errLog = $ScriptPath + '.err.log'
    $p = Start-Process -FilePath $pwshExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    return @{ proc = $p; outLog = $outLog; errLog = $errLog }
}

function Wait-F50Client {
    param($Cli, [int]$TimeoutSec = 120)
    $null = $Cli.proc.WaitForExit(($TimeoutSec * 1000))
    $peak = [long]0
    try { $peak = [long]$Cli.proc.PeakWorkingSet64 } catch { $peak = [long]0 }
    if (-not $Cli.proc.HasExited) { try { $Cli.proc.Kill() } catch { } }
    $Cli.peakBytes = $peak
    return $peak
}

function Read-F50Result {
    param([string]$Path)
    try { return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json) } catch { return $null }
}

$okBody = '{"status":"ok","data":{"id":"f50-wire-id","downloadPage":"https://gofile.test/d/f50wire","code":"f50wire"}}'

$attemptClientTpl = @'
$ErrorActionPreference = 'Stop'
$outPath = '@@OUT@@'
try {
    . '@@MOD@@'
    $h = Get-F46DefaultHost
    $h.enabled = $true
    $h.uploadHostMode = 'auto'
    $h.uploadHost = '127.0.0.1:@@PORT@@'
    $h.uploadPath = '/uploadfile'
    $h.uploadScheme = 'http'
    $h.timeoutSec = @@TIMEOUT@@
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-F46MirrorAttempt -HostCfg $h -Path '@@FILE@@' -Name '@@NAME@@' -Size ([long]@@SIZE@@) -AttemptNo 1
    $sw.Stop()
    $res = [ordered]@{ ok = [bool]$r.ok; phase = [string]$r.phase; status = [string]$r.httpStatus; fileId = [string]$r.fileId; code = [string]$r.code; link = [string]$r.directUrl; msg = [string]$r.hostMessage; authMode = [string]$r.authMode; ms = [int]$sw.ElapsedMilliseconds }
    [System.IO.File]::WriteAllText($outPath, ($res | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    exit 0
} catch {
    $res = [ordered]@{ ok = $false; threw = [string]$_.Exception.Message }
    [System.IO.File]::WriteAllText($outPath, ($res | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    exit 1
}
'@

$policyClientTpl = @'
$ErrorActionPreference = 'Stop'
$outPath = '@@OUT@@'
try {
    . '@@MOD@@'
    $script:transportCalls = 0
    $h = Get-F46DefaultHost
    $h.enabled = $true
    $h.uploadHostMode = 'auto'
    $h.uploadHost = '127.0.0.1:@@PORT@@'
    $h.uploadPath = '/uploadfile'
    $h.uploadScheme = 'http'
    $h.timeoutSec = 90
    @@HOSTEXTRA@@
    $transport = {
        param($HostCfg, $Path, $Name, $Size)
        $script:transportCalls = $script:transportCalls + 1
        return (Send-F46GofileUpload -HostCfg $HostCfg -Path $Path -Name $Name -TimeoutSec 60)
    }
    $r = Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path '@@FILE@@' -Name '@@NAME@@' -Size ([long]@@SIZE@@) -Transport $transport -Sleeper { param($ms) Start-Sleep -Milliseconds ([Math]::Min([int]$ms, 3000)) } -Rand01 0
    $phases = @()
    foreach ($a in @($r.attempts)) { $phases += [string]$a.phase }
    $res = [ordered]@{ ok = [bool]$r.ok; phase = [string]$r.phase; status = [string]$r.httpStatus; msg = [string]$r.hostMessage; authMode = [string]$r.authMode; attempts = @($r.attempts).Count; transportCalls = [int]$script:transportCalls; link = [string]$r.link; phases = @($phases) }
    [System.IO.File]::WriteAllText($outPath, ($res | ConvertTo-Json -Compress -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    exit 0
} catch {
    $res = [ordered]@{ ok = $false; threw = [string]$_.Exception.Message }
    [System.IO.File]::WriteAllText($outPath, ($res | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    exit 1
}
'@

try {
    # =====================================================================
    # [F51] Part A - unit: the Downloads-root classifier truth table
    # =====================================================================
    Write-Host '[F51] unit: auto-upload classifier truth table'
    $roots51 = @('C:\Users\u\Downloads', 'C:\Users\u\Desktop', 'C:\Users\u\Documents', 'C:\Users\u\AppData\Local\Temp', 'D:\RDP-Storage', 'D:\Torrents', 'C:\Users\u\Downloads\')
    Check 'A Downloads root file is auto' (Test-F51AutoUploadPath -Path 'C:\Users\u\Downloads\setup.exe' -Roots $roots51) 'direct child not matched'
    Check 'A Downloads SUB-folder file is auto' (Test-F51AutoUploadPath -Path 'C:\Users\u\Downloads\qBittorrent\big.iso' -Roots $roots51) 'sub-folder not matched'
    Check 'A trailing-slash root entry still matches' (Test-F51AutoUploadPath -Path 'C:\Users\u\Downloads\x.bin' -Roots $roots51) 'trailing slash broke the match'
    Check 'A the match is case-insensitive' (Test-F51AutoUploadPath -Path 'c:\users\U\DOWNLOADS\X.BIN' -Roots $roots51) 'case sensitivity crept in'
    Check 'A Desktop is NOT auto (opt-in required)' (-not (Test-F51AutoUploadPath -Path 'C:\Users\u\Desktop\note.txt' -Roots $roots51)) 'desktop matched'
    Check 'A Documents is NOT auto (opt-in required)' (-not (Test-F51AutoUploadPath -Path 'C:\Users\u\Documents\a.pdf' -Roots $roots51)) 'documents matched'
    Check 'A Temp is NOT auto (opt-in required)' (-not (Test-F51AutoUploadPath -Path 'C:\Users\u\AppData\Local\Temp\a.bin' -Roots $roots51)) 'temp matched'
    Check 'A RDP-Storage is NOT auto (opt-in required)' (-not (Test-F51AutoUploadPath -Path 'D:\RDP-Storage\a.zip' -Roots $roots51)) 'rdp-storage matched'
    Check 'A a torrent save path is NOT auto (opt-in required)' (-not (Test-F51AutoUploadPath -Path 'D:\Torrents\a.iso' -Roots $roots51)) 'torrents matched'
    Check 'A a folder merely NAMED Downloads under Desktop is NOT auto' (-not (Test-F51AutoUploadPath -Path 'C:\Users\u\Desktop\Downloads\a.bin' -Roots $roots51)) 'a non-watched Downloads-named folder matched'
    $hosts51 = @(Get-F46Hosts -Cfg ([pscustomobject]@{ mirrorHosts = @() }))
    $autoHost51 = Select-F51AutoUploadHost -Hosts $hosts51
    Check 'A the auto host is the first configured host, enabled for the attempt' (($null -ne $autoHost51) -and ([string]$autoHost51.id -eq 'gofile') -and [bool]$autoHost51.enabled -and ([string]$autoHost51.apiRoot -eq 'https://api.gofile.io')) ('host=' + $(if ($autoHost51) { [string]$autoHost51.id + ' enabled=' + [string]$autoHost51.enabled } else { 'none' }))
    Check 'A the config host list is NOT mutated by the auto copy' (-not [bool]($hosts51[0].enabled)) 'the shipped default host was flipped in place'
    $ledger51 = Format-F51AutoLedger -HostId 'gofile' -At '2026-09-29T00:00:00Z'
    Check 'A the F51 ledger line is the pinned format' (($ledger51 -match '^\[mirror\] AUTO-UPLOAD: root=Downloads scope=this-run source=auto host=gofile at=2026-09-29T00:00:00Z') -and ($ledger51 -match 'token-less guest, no credential, no opt-in')) ($ledger51)

    # =====================================================================
    # [F50] Part B - real streaming: 100 MB / 1 GB / 3 GB / 6 GB sparse files
    # =====================================================================
    Write-Host '[F50] streaming: fsutil sparse files -> discarding loopback listener'
    $lB = Start-F50Listener -PortBase 18680
    if (-not $lB) { Check 'B a local listener could be started' $false 'no free port' }
    $framingBySize = @{}
    if ($lB) {
        foreach ($sz in @(
            @{ mb = 100; bytes = 104857600L },
            @{ mb = 1024; bytes = 1073741824L },
            @{ mb = 3072; bytes = 3221225472L },
            @{ mb = 6144; bytes = 6442450944L }
        )) {
            $bigPath = Join-Path $labRoot ('f50-stream-{0:d5}mb.bin' -f [int]$sz.mb)
            & fsutil.exe file createnew $bigPath ([string]$sz.bytes) | Out-Null
            $fsRc = $LASTEXITCODE
            & fsutil.exe sparse setflag $bigPath | Out-Null
            try { & fsutil.exe file setzerodata rangeoffset=0 length=([string]$sz.bytes) | Out-Null } catch { }
            $lenOk = $false
            try { $lenOk = ((Get-Item -LiteralPath $bigPath).Length -eq [long]$sz.bytes) } catch { $lenOk = $false }
            $tag = ('{0} MiB' -f [int]$sz.mb)
            Check ('B sparse file {0} created (fsutil rc={1})' -f $tag, $fsRc) ($fsRc -eq 0 -and $lenOk) ('lenOk=' + $lenOk)
            $outRes = Join-Path $labRoot ('result-{0:d5}.json' -f [int]$sz.mb)
            $clientScript = Join-Path $labRoot ('client-{0:d5}.ps1' -f [int]$sz.mb)
            $body = $attemptClientTpl.Replace('@@OUT@@', $outRes).Replace('@@MOD@@', $modPath).Replace('@@PORT@@', [string]$lB.port).Replace('@@TIMEOUT@@', '900').Replace('@@FILE@@', $bigPath).Replace('@@NAME@@', ([System.IO.Path]::GetFileName($bigPath))).Replace('@@SIZE@@', ([string][long]$sz.bytes))
            [System.IO.File]::WriteAllText($clientScript, $body, (New-Object System.Text.UTF8Encoding($false)))
            $cli = Start-F50Client -ScriptPath $clientScript
            $ctx = Get-F50Context -Listener $lB.listener -TimeoutMs 300000 -ClientProc $cli.proc
            if ($null -eq $ctx) {
                $null = Wait-F50Client -Cli $cli -TimeoutSec 30
                Check ('B {0}: a request reached the listener' -f $tag) $false ('client out: ' + $(try { [System.IO.File]::ReadAllText($cli.outLog) } catch { '' }) + ' err: ' + $(try { [System.IO.File]::ReadAllText($cli.errLog) } catch { '' }))
            } else {
                $wire = Read-F50Request -Ctx $ctx
                Send-F50Response -Ctx $ctx -Json $okBody -Status 200
                $null = Wait-F50Client -Cli $cli -TimeoutSec 120
                $res = Read-F50Result -Path $outRes
                Check ('B {0}: the upload succeeds end to end' -f $tag) ($res -and [bool]$res.ok -and ([string]$res.fileId -eq 'f50-wire-id') -and ([string]$res.link -eq 'https://gofile.test/d/f50wire')) ('res=' + $(if ($res) { $res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }))
                Check ('B {0}: body bytes == Content-Length == framing+size (length-delimited, not chunked)' -f $tag) (($wire.bytes -eq [long]$wire.clen) -and ($wire.clen -gt [long]$sz.bytes)) ('bytes=' + $wire.bytes + ' clen=' + $wire.clen + ' size=' + $sz.bytes)
                $framingBySize[[int]$sz.mb] = ([long]$wire.bytes - [long]$sz.bytes)
                Check ('B {0}: multipart field name=file + octet-stream part + our filename' -f $tag) (($wire.head -match 'name="file"') -and ($wire.head -match 'Content-Type: application/octet-stream') -and ($wire.head -match ('filename="' + [System.IO.Path]::GetFileName($bigPath) + '"'))) ('head=' + $wire.head.Substring(0, [Math]::Min(160, $wire.head.Length)))
                Check ('B {0}: request is a POST /uploadfile with multipart Content-Type' -f $tag) (($wire.method -eq 'POST') -and ([string]$wire.path -eq '/uploadfile') -and ([string]$wire.ctype -like 'multipart/form-data; boundary=*')) ('req=' + [string]$wire.method + ' ' + [string]$wire.path + ' ctype=' + [string]$wire.ctype)
                Check ('B {0} [F48]: NO auth headers on the wire (token-less guest)' -f $tag) (($wire.auth -eq '') -and ([string]$wire.cookie -eq '') -and ([string]$wire.hostTok -eq '')) ('auth=[' + [string]$wire.auth + '] cookie=[' + [string]$wire.cookie + '] hostTok=[' + [string]$wire.hostTok + ']')
                $peakMb = [math]::Round($cli.peakBytes / 1MB, 1)
                Write-Host ('  [INFO] {0} streamed in {1} ms; client peak working set {2} MB' -f $tag, $(if ($res) { [string]$res.ms } else { '-1' }), $peakMb)
                Check ('B {0}: client memory stays under 2 GiB (no whole-file buffer)' -f $tag) ($cli.peakBytes -lt 2147483648L) ('peakMB=' + $peakMb)
            }
            try { Remove-Item -LiteralPath $bigPath -Force -ErrorAction SilentlyContinue } catch { }
        }
        if (@($framingBySize.Keys).Count -ge 4) {
            $f1 = [long]$framingBySize[100]
            $framingStable = ($f1 -gt 0)
            foreach ($k in @($framingBySize.Keys)) { if ([long]$framingBySize[$k] -ne $f1) { $framingStable = $false } }
            Check 'B the framing overhead is IDENTICAL across all four sizes (exact length math)' $framingStable (('framing=' + ((@($framingBySize.Keys) | Sort-Object) | ForEach-Object { [string]$_ + ':' + [string]$framingBySize[$_] }) -join ','))
        }
        try { $lB.listener.Stop(); $lB.listener.Close() } catch { }
    }

    # =====================================================================
    # [F50] Part C - the policy matrix over the REAL streaming transport
    # =====================================================================
    Write-Host '[F50] policy matrix over the real streaming transport (loopback)'
    $smallPath = Join-Path $labRoot 'f50-policy-payload.bin'
    [System.IO.File]::WriteAllBytes($smallPath, (New-Object byte[] 262144))
    function Invoke-F50PolicyCase {
        param([string]$Name, [array]$Modes, [string]$HostExtra = '', [long]$Size = 262144L, [string]$FilePath = '')
        $l = Start-F50Listener -PortBase 18760
        if (-not $l) { Check ('C {0}: listener started' -f $Name) $false 'no free port'; return @{ res = $null; served = -1 } }
        $outRes = Join-Path $labRoot ('result-c-' + ($Name -replace '[^a-z0-9]', '') + '.json')
        $clientScript = $outRes + '.client.ps1'
        $body = $policyClientTpl.Replace('@@OUT@@', $outRes).Replace('@@MOD@@', $modPath).Replace('@@PORT@@', [string]$l.port).Replace('@@FILE@@', $FilePath).Replace('@@NAME@@', ([System.IO.Path]::GetFileName($FilePath))).Replace('@@SIZE@@', ([string]$Size)).Replace('@@HOSTEXTRA@@', $HostExtra)
        [System.IO.File]::WriteAllText($clientScript, $body, (New-Object System.Text.UTF8Encoding($false)))
        $cli = Start-F50Client -ScriptPath $clientScript
        $served = 0
        foreach ($mode in @($Modes)) {
            $ctx = Get-F50Context -Listener $l.listener -TimeoutMs 120000 -ClientProc $cli.proc
            if ($null -eq $ctx) { break }
            $served = $served + 1
            if ($mode -eq 'abort') {
                $null = Read-F50Request -Ctx $ctx
                try { $ctx.Response.Abort() } catch { }
            } elseif ($mode -eq 'ok') {
                Send-F50Response -Ctx $ctx -Json $okBody -Status 200
            } elseif ($mode -eq '429') {
                Send-F50Response -Ctx $ctx -Json '{"status":"error-rateLimit"}' -Status 429 -RetryAfter '1'
            } elseif ($mode -eq '403') {
                Send-F50Response -Ctx $ctx -Json '{"status":"error-token"}' -Status 403
            } elseif ($mode -eq '413') {
                Send-F50Response -Ctx $ctx -Json '{"status":"error-limits"}' -Status 413
            } else {
                # a raw non-2xx with NO gofile envelope (the transient class)
                Send-F50Response -Ctx $ctx -Json ('lab listener says ' + $mode + ' (no gofile envelope)') -Status ([int]$mode)
            }
        }
        try { $l.listener.Stop(); $l.listener.Close() } catch { }
        $null = Wait-F50Client -Cli $cli -TimeoutSec 60
        $res = Read-F50Result -Path $outRes
        return @{ res = $res; served = $served }
    }

    $c429 = Invoke-F50PolicyCase -Name '429x5' -Modes @('429', '429', '429', '429', '429') -FilePath $smallPath
    Check 'C 429 => 5 attempts over the real transport, phase=http status=429' ($c429.res -and (-not [bool]$c429.res.ok) -and ([int]$c429.res.attempts -eq 5) -and ([int]$c429.res.transportCalls -eq 5) -and ([string]$c429.res.status -eq '429') -and ([string]$c429.res.phase -eq 'http')) ('res=' + $(if ($c429.res) { $c429.res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }))

    $c500 = Invoke-F50PolicyCase -Name '500thenok' -Modes @('500', '500', 'ok') -FilePath $smallPath
    Check 'C 500,500,ok => 3rd attempt succeeds with the parsed link' ($c500.res -and [bool]$c500.res.ok -and ([int]$c500.res.attempts -eq 3) -and ([string]$c500.res.link -eq 'https://gofile.test/d/f50wire')) ('res=' + $(if ($c500.res) { $c500.res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }))

    $c502 = Invoke-F50PolicyCase -Name '502x5' -Modes @('502', '502', '502', '502', '502') -FilePath $smallPath
    Check 'C 502 => retries to the 5-attempt budget, terminal http' ($c502.res -and (-not [bool]$c502.res.ok) -and ([int]$c502.res.attempts -eq 5) -and ([string]$c502.res.phase -eq 'http')) ('res=' + $(if ($c502.res) { $c502.res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }))

    $cReset = Invoke-F50PolicyCase -Name 'resetthenok' -Modes @('abort', 'ok') -FilePath $smallPath
    $resetPhaseOk = $false
    if ($cReset.res -and @($cReset.res.phases).Count -ge 1) { $resetPhaseOk = ((@('tcp', 'tls', 'http') -contains [string](@($cReset.res.phases)[0]))) }
    Check 'C connection reset mid-upload (the tls-reset class) => transport failure, retried, then ok' ($cReset.res -and [bool]$cReset.res.ok -and ([int]$cReset.res.attempts -eq 2) -and $resetPhaseOk) ('res=' + $(if ($cReset.res) { $cReset.res | ConvertTo-Json -Compress -Depth 4 } else { 'none' }))

    $c403 = Invoke-F50PolicyCase -Name '403failfast' -Modes @('403', 'ok') -FilePath $smallPath
    Check 'C 403 => EXACTLY 1 attempt, phase=auth, the F48 labeled reason' ($c403.res -and (-not [bool]$c403.res.ok) -and ([int]$c403.res.attempts -eq 1) -and ([string]$c403.res.phase -eq 'auth') -and ([string]$c403.res.authMode -eq 'requires-account') -and (([string]$c403.res.msg).StartsWith('host requires account token; token-less mode unsupported'))) ('res=' + $(if ($c403.res) { $c403.res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }))

    $c413 = Invoke-F50PolicyCase -Name '413failfast' -Modes @('413') -FilePath $smallPath
    Check 'C 413 => 1 attempt, phase=size (fail-fast)' ($c413.res -and (-not [bool]$c413.res.ok) -and ([int]$c413.res.attempts -eq 1) -and ([string]$c413.res.phase -eq 'size')) ('res=' + $(if ($c413.res) { $c413.res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }))

    # Preflight refusals: ZERO network tries (the client-side transport
    # counter is the authority; the listener would have counted any request).
    $big2mb = Join-Path $labRoot 'f50-preflight-size.bin'
    [System.IO.File]::WriteAllBytes($big2mb, (New-Object byte[] 2097152))
    $cSize = Invoke-F50PolicyCase -Name 'preflightsize' -Modes @() -HostExtra '$h.maxFileBytes = 1048576' -Size 2097152L -FilePath $big2mb
    Check 'C size cap => 1 labeled attempt, 0 network tries, phase=size' ($cSize.res -and (-not [bool]$cSize.res.ok) -and ([int]$cSize.res.attempts -eq 1) -and ([int]$cSize.res.transportCalls -eq 0) -and ($cSize.served -eq 0) -and ([string]$cSize.res.phase -eq 'size')) ('res=' + $(if ($cSize.res) { $cSize.res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }) + ' served=' + [string]$cSize.served)

    $isoPath = Join-Path $labRoot 'f50-preflight-type.iso'
    [System.IO.File]::WriteAllBytes($isoPath, (New-Object byte[] 262144))
    $cType = Invoke-F50PolicyCase -Name 'preflighttype' -Modes @() -HostExtra '$h.blockedExtensions = @(".iso")' -FilePath $isoPath
    Check 'C blocked type => 1 labeled attempt, 0 network tries, phase=type' ($cType.res -and (-not [bool]$cType.res.ok) -and ([int]$cType.res.attempts -eq 1) -and ([int]$cType.res.transportCalls -eq 0) -and ($cType.served -eq 0) -and ([string]$cType.res.phase -eq 'type')) ('res=' + $(if ($cType.res) { $cType.res | ConvertTo-Json -Compress -Depth 3 } else { 'none' }) + ' served=' + [string]$cType.served)

    # =====================================================================
    # [F51] Part D - REAL watcher run: a download into Downloads auto-uploads
    # =====================================================================
    Write-Host '[F51] end-to-end: real watcher, mirror=false, file lands in Downloads'
    $marker51 = 'F51-AUTO-PROOF-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $prof = [string]$env:USERPROFILE
    $dlDir = Join-Path $prof 'Downloads'
    if (-not (Test-Path -LiteralPath $dlDir)) { [void][System.IO.Directory]::CreateDirectory($dlDir) }
    $deskDir = Join-Path $prof 'Desktop'
    $dlFile = Join-Path $dlDir 'f51-auto-proof.bin'
    $deskFile = Join-Path $deskDir 'f51-desktop-proof.bin'
    $payloadTxt = ($marker51 + ' benign lab download marker. ') * 96
    [System.IO.File]::WriteAllText($dlFile, $payloadTxt, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($deskFile, ('F51-DESKTOP-PROOF benign tracked-not-uploaded marker. ' * 64), (New-Object System.Text.UTF8Encoding($false)))
    $lD = Start-F50Listener -PortBase 18840
    if (-not $lD) { Check 'D a local listener could be started' $false 'no free port' }
    $watchRoot = Join-Path $labRoot 'watcher-root'
    [void][System.IO.Directory]::CreateDirectory($watchRoot)
    foreach ($f in @('ghrdp-lib.ps1', 'ghrdp-mirror.ps1', 'ghrdp-watcher.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root ('payloads\' + $f)) -Destination (Join-Path $watchRoot $f) -Force
    }
    $nowIso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $cfg51 = [ordered]@{
        mirror = $false
        encryptMode = 'none'
        rdpUser = [string]$env:USERNAME
        sessionStartedAt = $nowIso
        watcherDeadline = $nowIso
        hiddenFiles = @()
        mirrorHosts = @([ordered]@{ id = 'gofile'; displayName = 'gofile.io (lab listener)'; uploadHostMode = 'auto'; uploadHost = ('127.0.0.1:' + $lD.port); uploadPath = '/uploadfile'; uploadScheme = 'http'; enabled = $false; timeoutSec = 60 })
    }
    [System.IO.File]::WriteAllText((Join-Path $watchRoot 'config.json'), ($cfg51 | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $listenerResultPath = Join-Path $labRoot 'f51-listener-result.json'
    $listenerJob = Start-Job -ScriptBlock {
        param($Port, $ResultPath)
        $l = New-Object System.Net.HttpListener
        $l.Prefixes.Add('http://127.0.0.1:' + $Port + '/')
        $l.Start()
        $served = @()
        foreach ($i in 0..1) {
            $ctx = $l.GetContext()
            $head = New-Object System.Collections.Generic.List[byte]
            $total = [long]0
            $buf = New-Object byte[] 65536
            while (($n = $ctx.Request.InputStream.Read($buf, 0, $buf.Length)) -gt 0) {
                $total = $total + [long]$n
                if ($head.Count -lt 4096) { for ($j = 0; $j -lt $n -and $head.Count -lt 4096; $j++) { [void]$head.Add($buf[$j]) } }
            }
            $served += [ordered]@{ method = [string]$ctx.Request.HttpMethod; path = [string]$ctx.Request.Url.AbsolutePath; ctype = [string]$ctx.Request.ContentType; clen = [long]$ctx.Request.ContentLength64; auth = [string]$ctx.Request.Headers['Authorization']; cookie = [string]$ctx.Request.Headers['Cookie']; hostTok = [string]$ctx.Request.Headers['X-Gofile-Token']; bytes = $total; head = [System.Text.Encoding]::ASCII.GetString($head.ToArray()) }
            $body = '{"status":"ok","data":{"id":"f51-auto-id","downloadPage":"https://gofile.test/d/f51auto","code":"f51auto"}}'
            $rb = [System.Text.Encoding]::UTF8.GetBytes($body)
            $ctx.Response.StatusCode = 200
            $ctx.Response.ContentType = 'application/json'
            $ctx.Response.ContentLength64 = $rb.Length
            $ctx.Response.OutputStream.Write($rb, 0, $rb.Length)
            $ctx.Response.Close()
            [System.IO.File]::WriteAllText($ResultPath, (ConvertTo-Json -InputObject ([ordered]@{ served = @($served) }) -Depth 6 -Compress))
        }
    } -ArgumentList $lD.port, $listenerResultPath
    $wOut = Join-Path $labRoot 'watcher-out.log'
    $wErr = Join-Path $labRoot 'watcher-err.log'
    $watcherProc = Start-Process -FilePath $pwshExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $watchRoot 'ghrdp-watcher.ps1'), '-Root', $watchRoot, '-MaxMinutes', '3') -PassThru -WindowStyle Hidden -RedirectStandardOutput $wOut -RedirectStandardError $wErr
    $sawOk = $false
    $deadlineD = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadlineD) {
        Start-Sleep -Seconds 5
        if (Test-Path -LiteralPath (Join-Path $watchRoot 'progress.json')) {
            $progTxt = ''
            try { $progTxt = [System.IO.File]::ReadAllText((Join-Path $watchRoot 'progress.json')) } catch { $progTxt = '' }
            if ($progTxt.Contains('[mirror] OK f51-auto-proof') -or $progTxt.Contains('AUTO-UPLOAD: root=Downloads')) { $sawOk = $true }
        }
        if ($sawOk) { break }
        if ($watcherProc.HasExited) { break }
    }
    Start-Sleep -Seconds 5
    try { if (-not $watcherProc.HasExited) { $watcherProc.Kill() } } catch { }
    try { Remove-Job -Job $listenerJob -Force -ErrorAction SilentlyContinue } catch { }
    $lr = Read-F50Result -Path $listenerResultPath
    $progJson = $null
    try { $progJson = ([System.IO.File]::ReadAllText((Join-Path $watchRoot 'progress.json')) | ConvertFrom-Json) } catch { $progJson = $null }
    $logLines = @()
    if ($progJson -and $progJson.PSObject.Properties['log']) { $logLines = @($progJson.log) }
    $logText = $logLines -join "`n"
    $cfgAfter = $null
    try { $cfgAfter = ([System.IO.File]::ReadAllText((Join-Path $watchRoot 'config.json')) | ConvertFrom-Json) } catch { $cfgAfter = $null }
    $servedCount = 0
    $servedHead = ''
    $servedAllHeads = ''
    $servedWire = $null
    if ($lr) {
        $servedCount = @($lr.served).Count
        foreach ($sv in @($lr.served)) { $servedAllHeads = $servedAllHeads + [string]$sv.head }
        if ($servedCount -ge 1) { $servedWire = @($lr.served)[0]; $servedHead = [string]$servedWire.head }
    }
    $doneRow = $null
    if ($progJson -and $progJson.PSObject.Properties['files']) {
        $doneRow = @($progJson.files) | Where-Object { (([string]$_.name) -eq 'f51-auto-proof.bin') -and (([string]$_.status) -eq 'done') }
    }
    Check 'D the Downloads file uploaded AUTOMATICALLY (no opt-in, mirror=false)' (($servedCount -ge 1) -and ($servedAllHeads.Contains($marker51))) ('served=' + [string]$servedCount + ' marker=' + $marker51)
    Check 'D the auto upload hit the guest multipart wire contract' (($servedWire -ne $null) -and (([string]$servedWire.method) -eq 'POST') -and (([string]$servedWire.path) -eq '/uploadfile') -and ([string]$servedWire.auth -eq '') -and ([string]$servedWire.cookie -eq '') -and ([string]$servedWire.hostTok -eq '') -and ($servedHead -match 'name="file"')) ('wire=' + $(if ($servedWire) { $servedWire | ConvertTo-Json -Compress -Depth 3 } else { 'none' }))
    Check 'D the body was length-delimited (bytes == Content-Length)' (($servedWire -ne $null) -and ([long]$servedWire.bytes -eq [long]$servedWire.clen)) ('bytes=' + $(if ($servedWire) { [string]$servedWire.bytes } else { '-1' }) + ' clen=' + $(if ($servedWire) { [string]$servedWire.clen } else { '-1' }))
    Check 'D the watcher ledgered the F51 AUTO-UPLOAD line' ($logText.Contains('[mirror] AUTO-UPLOAD: root=Downloads scope=this-run source=auto')) ('log-tail=' + ((@($logLines) | Select-Object -First 5) -join ' | '))
    Check 'D the watcher recorded a DONE row with the host link' (($logText.Contains('[mirror] OK f51-auto-proof')) -and ($null -ne $doneRow)) ('files=' + $(if ($progJson -and $progJson.PSObject.Properties['files']) { @($progJson.files) | ConvertTo-Json -Compress -Depth 2 } else { 'none' }))
    Check 'D the DESKTOP file was tracked but NOT uploaded (opt-in still required)' ((-not $servedAllHeads.Contains('F51-DESKTOP-PROOF')) -and (-not $logText.Contains('f51-desktop-proof'))) 'a desktop attempt line or marker exists'
    Check 'D the MIRROR IS OFF ledger line still names the non-auto gate' ($logText.Contains('MIRROR IS OFF')) 'the non-auto gate line is missing'
    Check 'D mirrorDiag reports the auto-upload state' (($progJson -and $progJson.mirrorDiag -and (([string]$progJson.mirrorDiag.autoUpload) -eq 'downloads'))) ('diag=' + $(if ($progJson -and $progJson.mirrorDiag) { [string]$progJson.mirrorDiag.autoUpload } else { 'none' }))
    Check 'D config.json on disk keeps mirror=false (the F49 status truth is untouched)' (($cfgAfter -ne $null) -and (-not [bool]$cfgAfter.mirror) -and (-not [bool](@($cfgAfter.mirrorHosts)[0].enabled))) ('mirror=' + $(if ($cfgAfter) { [string]$cfgAfter.mirror } else { '?' }))
    if (-not $sawOk) {
        Write-Host ('  [INFO] watcher stdout tail: ' + $(try { ((Get-Content -LiteralPath $wOut -ErrorAction SilentlyContinue | Select-Object -Last 12) -join ' | ') } catch { '' }))
        Write-Host ('  [INFO] watcher stderr tail: ' + $(try { ((Get-Content -LiteralPath $wErr -ErrorAction SilentlyContinue | Select-Object -Last 6) -join ' | ') } catch { '' }))
    }
    try { Remove-Item -LiteralPath $dlFile, $deskFile -Force -ErrorAction SilentlyContinue } catch { }
} catch {
    Check 'lab aborted' $false ($_.Exception.Message + ' | ' + $_.ScriptStackTrace)
} finally {
    try { Remove-Item -LiteralPath $labRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

if ($script:failures -gt 0) {
    Write-Host ('::error::[F50/F51] mirror streaming + auto-upload lab failed: ' + $script:failures + ' check(s)')
    exit 1
}
Write-Host '[F50/F51] streaming + auto-upload lab: ALL CHECKS PASS (loopback only, no live host, no content leaves the runner)'
exit 0
