# [F50 §3] Mirror large-file streaming lab (Windows lane).
#
# WHY THIS FILE EXISTS: the watcher logged
#   phase=http status=- msg=upload failed: Exception calling "Write" with "3"
#   argument(s): "Stream was too long."
# on a multi-GB mirror file. The uploader copied the file through a 64 KiB
# FileStream loop, but into `HttpWebRequest.GetRequestStream()` with the .NET
# default `AllowWriteStreamBuffering = true`, so the whole multipart body was
# assembled in a `MemoryStream` first - and a MemoryStream cannot pass
# Int32.MaxValue (2 GiB). The second 2 GiB wall was the AES-256 encryptor
# (`ReadAllBytes` + a whole-file `byte[]` + a `List[byte]` container).
#
# This lab proves BOTH walls are gone, on the SHIPPED payloads/ghrdp-mirror.ps1:
#   * the reported symptom is reproduced from first principles (cell A1) so the
#     root cause is evidence, not narrative;
#   * real 100 MB / 1 GB / 3 GB / 6 GB payloads go out over a loopback listener
#     that DISCARDS the body, with the uploader process's peak working set
#     bounded far below the file size (no whole-file blob, ever);
#   * the streamed AES-256-CBC-PBKDF2 container encrypts and round-trips above
#     the GCM one-shot cap, and the GCM decrypt cap refuses honestly;
#   * the F44 policy is unchanged on the new transport: 429 / 500 / 502 with
#     jittered backoff and a Retry-After FLOOR, a TLS-handshake reset and a TCP
#     refusal retried as transients, 502 -> success recovery, 403/413 fail-fast;
#   * preflight size/type still refuse with ZERO network tries - including a
#     6 GiB size UNDER the host cap, which must be allowed through (the fix may
#     not invent a 2 GiB cap of its own).
#
# No live host is called: every byte goes to 127.0.0.1. [F48/F49] the guest
# ladder is asserted on the wire at every size - no auth header, no host-token
# header, no session header, no credential in the URL, ever.
#
# Sizes are SPARSE files (fsutil setflag + SetLength): the logical length is the
# real multi-GB value while the allocation stays near zero, so a 6 GiB cell runs
# inside a hosted runner's disk budget. Cell C1 proves the sparse mechanism
# before any cell depends on it, and C2 measures the runtime's baseline peak so
# every memory ceiling is relative, not a guess.
#
# Every cell prints exactly:
#   CELL=<id> EXPECT=<expectation> OBSERVED=<observation> RESULT=PASS|FAIL
# and a FAIL also emits a ::error:: annotation naming the cell (the run-log blob
# host is not reachable from the dev sandbox - F37/F48 lesson).
# Exit 0 only when every cell passes.
$ErrorActionPreference = 'Stop'
$script:failures = 0
$script:cells = 0

function Cell {
    param([string]$Id, [string]$Expect, [bool]$Ok, [string]$Observed)
    $script:cells = $script:cells + 1
    $res = 'FAIL'
    if ($Ok) { $res = 'PASS' }
    $obs = ([string]$Observed) -replace '[\r\n]+', ' | '
    if ($obs.Length -gt 400) { $obs = $obs.Substring(0, 400) + '...' }
    Write-Host ('CELL=' + $Id + ' EXPECT=' + $Expect + ' OBSERVED=' + $obs + ' RESULT=' + $res)
    if (-not $Ok) {
        $script:failures = $script:failures + 1
        $ann = (('::error title=F50 cell ' + $Id + '::EXPECT=' + $Expect + ' OBSERVED=' + $obs) -replace '[\r\n]+', ' ')
        Write-Host $ann
    }
}

function Fmt-Bytes {
    param([long]$N)
    if ($N -ge 1073741824) { return ([string][Math]::Round(($N / 1073741824.0), 3) + ' GiB (' + [string]$N + ' B)') }
    if ($N -ge 1048576) { return ([string][Math]::Round(($N / 1048576.0), 2) + ' MiB (' + [string]$N + ' B)') }
    return ([string]$N + ' B')
}

function Invoke-F50Native {
    # fsutil writes progress text to stdout and complaints to stderr; with
    # $ErrorActionPreference='Stop' a redirected native stderr can throw, so
    # native calls are captured under 'Continue' and their text is returned.
    # ($NativeArgs, not $Args: $Args is an automatic variable.)
    param([string]$Exe, $NativeArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return [string](((& $Exe @NativeArgs) 2>&1) | Out-String) } catch { return ('native call threw: ' + $_.Exception.Message) }
    finally { $ErrorActionPreference = $prev }
}

function New-F50SparseFile {
    # Logical length = $Size, allocation ~ 0: mark the file sparse FIRST, then
    # extend it, so NTFS fills the extension with a hole instead of sectors.
    param([string]$Path, [long]$Size)
    $drv = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Path))
    $before = $drv.AvailableFreeSpace
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try { $fs.SetLength(0) } finally { try { $fs.Dispose() } catch { } }
    $flagOut = Invoke-F50Native -Exe 'fsutil' -NativeArgs @('sparse', 'setflag', $Path)
    $fs2 = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try { $fs2.SetLength($Size) } finally { try { $fs2.Dispose() } catch { } }
    $after = $drv.AvailableFreeSpace
    $q = Invoke-F50Native -Exe 'fsutil' -NativeArgs @('sparse', 'queryflag', $Path)
    $logical = 0
    try { $logical = (Get-Item -LiteralPath $Path).Length } catch { $logical = 0 }
    return @{ path = $Path; logical = [long]$logical; allocated = [long]($before - $after); sparse = $q; flagOut = $flagOut }
}

function Get-F50Sha256 {
    # Streamed hash: never loads the file (that is the whole point of F50).
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { return [System.BitConverter]::ToString($sha.ComputeHash($fs)) } finally { try { $fs.Dispose() } catch { } }
    } finally { try { $sha.Dispose() } catch { } }
}

# --- module + workspace ----------------------------------------------------
$root = $env:GITHUB_WORKSPACE
if (-not $root) { $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$modPath = Join-Path $root 'payloads\ghrdp-mirror.ps1'
if (-not (Test-Path -LiteralPath $modPath)) { $modPath = Join-Path $root 'payloads/ghrdp-mirror.ps1' }
if (-not (Test-Path -LiteralPath $modPath)) { throw ('F50: the mirror module is missing at ' + $modPath) }
. $modPath
Write-Host ('[F50] module loaded: ' + $modPath)
Write-Host ('[F50] transport: ' + [string]$script:F50Transport + ' | stream buffer: ' + [string]$script:F50StreamBufferBytes + ' B | GCM one-shot cap: ' + (Fmt-Bytes ([long]$script:F50GcmOneShotMaxBytes)) + ' | GCM decrypt cap: ' + (Fmt-Bytes ([long]$script:F50GcmDecryptMaxBytes)))
$gcmUsable = $false
try { $gcmUsable = Test-F46AesGcmUsable } catch { $gcmUsable = $false }
Write-Host ('[F50] AES-256-GCM on this runner: ' + $(if ($gcmUsable) { 'usable (one-shot path below the cap)' } else { 'unusable (streamed CBC path at every size)' }))

$tmp = $env:RUNNER_TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath() }
$tmp = Join-Path $tmp ('f50-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Write-Host ('[F50] workspace: ' + $tmp + ' | volume free at start: ' + (Fmt-Bytes ([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($tmp)).AvailableFreeSpace)))

# ============================================================================
# A. ROOT CAUSE + SOURCE TRUTH (no network, no disk)
# ============================================================================
# A1 - reproduce the reported symptom from first principles: a MemoryStream
# cannot pass Int32.MaxValue, and that is exactly what the watcher logged.
$reproMsg = ''
$reproType = ''
try {
    $ms = New-Object System.IO.MemoryStream
    try { $ms.SetLength(2147483648) } finally { try { $ms.Dispose() } catch { } }
} catch {
    $ex = $_.Exception
    $depth = 0
    while ($ex -and $depth -lt 5) {
        if ($ex -is [System.IO.IOException]) { $reproType = $ex.GetType().FullName; $reproMsg = [string]$ex.Message; break }
        $ex = $ex.InnerException
        $depth = $depth + 1
    }
    if (-not $reproMsg) { $reproType = $_.Exception.GetType().FullName; $reproMsg = [string]$_.Exception.Message }
}
Cell 'A1-repro-stream-too-long' 'a body past Int32.MaxValue throws IOException "Stream was too long." (the reported symptom, reproduced with zero allocation)' ($reproMsg -match 'Stream was too long') ('type=' + $reproType + ' msg=' + $reproMsg)

# A2-A4 - the module no longer contains the buffering transport, does contain
# the streaming one, and the uploader builds no whole-file array. Comment lines
# are stripped: the file header documents the retired shape on purpose.
$modLines = [System.IO.File]::ReadAllLines($modPath)
$codeTxt = ((@($modLines | Where-Object { $_ -notmatch '^\s*#' })) -join "`n")
$wrHits = [regex]::Matches($codeTxt, '\[System\.Net\.WebRequest\]::Create').Count
$bufHits = [regex]::Matches($codeTxt, 'AllowWriteStreamBuffering').Count
Cell 'A2-no-buffering-transport' 'no HttpWebRequest construction and no AllowWriteStreamBuffering in code lines (the buffering transport is retired)' (($wrHits -eq 0) -and ($bufHits -eq 0)) ('webrequest=' + $wrHits + ' buffering=' + $bufHits)
Cell 'A3-streaming-transport' 'the transport is HttpClient + MultipartFormDataContent + StreamContent + HttpRequestMessage' (($codeTxt -match 'System\.Net\.Http\.HttpClient') -and ($codeTxt -match 'System\.Net\.Http\.MultipartFormDataContent') -and ($codeTxt -match 'System\.Net\.Http\.StreamContent') -and ($codeTxt -match 'System\.Net\.Http\.HttpRequestMessage')) ('httpclient=' + ($codeTxt -match 'System\.Net\.Http\.HttpClient') + ' multipart=' + ($codeTxt -match 'System\.Net\.Http\.MultipartFormDataContent') + ' streamcontent=' + ($codeTxt -match 'System\.Net\.Http\.StreamContent') + ' requestmessage=' + ($codeTxt -match 'System\.Net\.Http\.HttpRequestMessage'))
$sendStart = -1
$sendEnd = -1
for ($i = 0; $i -lt $modLines.Count; $i++) {
    if ($modLines[$i] -match '^function Send-F46GofileUpload \{') { $sendStart = $i }
    elseif ($sendStart -ge 0 -and $sendEnd -lt 0 -and $modLines[$i] -match '^\}') { $sendEnd = $i }
}
$sendBody = ''
if ($sendStart -ge 0 -and $sendEnd -gt $sendStart) { $sendBody = ((@($modLines[$sendStart..$sendEnd] | Where-Object { $_ -notmatch '^\s*#' })) -join "`n") }
Cell 'A4-no-whole-file-array-in-upload' 'Send-F46GofileUpload has no ReadAllBytes, no MemoryStream, no List[byte], and opens a FileStream' (($sendBody -ne '') -and (-not ($sendBody -match 'ReadAllBytes')) -and (-not ($sendBody -match 'MemoryStream')) -and (-not ($sendBody -match 'List\[byte\]')) -and ($sendBody -match '\[System\.IO\.File\]::Open\(')) ('bodyChars=' + $sendBody.Length + ' readallbytes=' + ($sendBody -match 'ReadAllBytes') + ' memorystream=' + ($sendBody -match 'MemoryStream') + ' listbyte=' + ($sendBody -match 'List\[byte\]') + ' filestream=' + ($sendBody -match '\[System\.IO\.File\]::Open\('))

# A5-A7 - the size-aware timeout floor. HttpClient.Timeout covers the WHOLE
# request (body included), so a 120s setting would kill every multi-GB upload;
# the retired HttpWebRequest.ReadWriteTimeout was per-write, which is why 120s
# used to survive big files.
$t6g = Get-F50UploadTimeoutSec -Size 6442450944 -ConfiguredSec 120
$t100m = Get-F50UploadTimeoutSec -Size 104857600 -ConfiguredSec 120
$tHuge = Get-F50UploadTimeoutSec -Size 1099511627776 -ConfiguredSec 120
Cell 'A5-timeout-floor-6gib' 'a 6 GiB upload gets size/2MiBps = 3072s, not the 120s whole-request default' (([int]$t6g.sec -eq 3072) -and ([int]$t6g.floor -eq 3072) -and (-not [bool]$t6g.capped) -and ([int]$t6g.configured -eq 120)) ('sec=' + $t6g.sec + ' floor=' + $t6g.floor + ' configured=' + $t6g.configured + ' capped=' + $t6g.capped)
Cell 'A6-timeout-floor-small' 'a 100 MiB upload keeps the configured 120s (the floor is a floor, never an inflation)' (([int]$t100m.sec -eq 120) -and ([int]$t100m.floor -eq 50)) ('sec=' + $t100m.sec + ' floor=' + $t100m.floor)
Cell 'A7-timeout-cap' 'an absurd size is capped at the documented 21600s ceiling' (([int]$tHuge.sec -eq 21600) -and ([bool]$tHuge.capped)) ('sec=' + $tHuge.sec + ' capped=' + $tHuge.capped)

# A8 - the F44 attempt policy the brief requires to be preserved exactly.
Cell 'A8-f44-policy-intact' 'fail-fast 401/403/413/415 = 1 attempt; transient dns/tcp/tls/http = 5; Retry-After cap 120000ms' (((@($script:F46FailFastStatuses) -join ',') -eq '401,403,413,415') -and ((@($script:F46TransientPhases) -join ',') -eq 'dns,tcp,tls,http') -and ([int]$script:F46MaxAttempts -eq 5) -and ([int]$script:F46RetryAfterCapMs -eq 120000) -and ([int](Get-F46MaxAttempts -Phase 'size' -Status 413) -eq 1) -and ([int](Get-F46MaxAttempts -Phase 'auth' -Status 403) -eq 1) -and ([int](Get-F46MaxAttempts -Phase 'type' -Status 415) -eq 1) -and ([int](Get-F46MaxAttempts -Phase 'http' -Status 502) -eq 5) -and ([int](Get-F46MaxAttempts -Phase 'tls' -Status $null) -eq 5)) ('failFast=' + (@($script:F46FailFastStatuses) -join ',') + ' transient=' + (@($script:F46TransientPhases) -join ',') + ' max=' + $script:F46MaxAttempts + ' retryAfterCap=' + $script:F46RetryAfterCapMs)

# ============================================================================
# B. PREFLIGHT REFUSALS WITH ZERO NETWORK TRIES (3 GiB / 6 GiB sizes)
# ============================================================================
$script:networkCalls = 0
$mockTransport = {
    param($HostCfg, $Path, $Name, $Size)
    $script:networkCalls = $script:networkCalls + 1
    return @{ ok = $true; phase = $null; httpStatus = 200; hostMessage = ''; fileId = 'f50-mock-id'; code = 'f50-mock-code'; downloadPage = 'https://gofile.test/d/f50mock' }
}
$capHost = Get-F46DefaultHost
$capHost.enabled = $true
$capHost.maxFileBytes = 5368709120   # 5 GiB cap: a 6 GiB file must be refused pre-flight
$capHost.blockedExtensions = @('.exe')

$script:networkCalls = 0
$preSize = Invoke-F46MirrorUploadWithPolicy -HostCfg $capHost -Path (Join-Path $tmp 'nope.bin') -Name 'f50-6gib.bin' -Size ([long]6442450944) -Transport $mockTransport -Sleeper { param($ms) }
Cell 'B1-preflight-size-6gib-network0' 'a 6 GiB file over a 5 GiB host cap is refused at phase=size with ZERO network tries and exactly ONE attempt' (([string]$preSize.phase -eq 'size') -and ($script:networkCalls -eq 0) -and ([int]$preSize.attemptsUsed -eq 1) -and ([string]$preSize.hostMessage).Contains('preflight (0 network tries)')) ('phase=' + $preSize.phase + ' network=' + $script:networkCalls + ' attempts=' + $preSize.attemptsUsed + ' msg=' + $preSize.hostMessage)

$script:networkCalls = 0
$preType = Invoke-F46MirrorUploadWithPolicy -HostCfg $capHost -Path (Join-Path $tmp 'nope.exe') -Name 'f50-3gib.exe' -Size ([long]3221225472) -Transport $mockTransport -Sleeper { param($ms) }
Cell 'B2-preflight-type-3gib-network0' 'a 3 GiB .exe on a blocked-type host is refused at phase=type with ZERO network tries' (([string]$preType.phase -eq 'type') -and ($script:networkCalls -eq 0) -and ([int]$preType.attemptsUsed -eq 1) -and ([string]$preType.hostMessage).Contains('preflight (0 network tries)')) ('phase=' + $preType.phase + ' network=' + $script:networkCalls + ' attempts=' + $preType.attemptsUsed + ' msg=' + $preType.hostMessage)

$script:networkCalls = 0
$noCap = Get-F46DefaultHost
$noCap.enabled = $true
$noCap.maxFileBytes = 0
$prePass = Invoke-F46MirrorUploadWithPolicy -HostCfg $noCap -Path (Join-Path $tmp 'nope.bin') -Name 'f50-6gib.bin' -Size ([long]6442450944) -Transport $mockTransport -Sleeper { param($ms) }
Cell 'B3-no-hidden-2gib-cap' 'a 6 GiB file UNDER the host cap passes preflight and reaches the transport (the fix invents no 2 GiB limit of its own)' (([bool]$prePass.ok) -and ($script:networkCalls -eq 1)) ('ok=' + $prePass.ok + ' network=' + $script:networkCalls + ' phase=' + $prePass.phase)

$script:networkCalls = 0
$t413 = Invoke-F46MirrorUploadWithPolicy -HostCfg $capHost -Path (Join-Path $tmp 'nope.bin') -Name 'f50-4gib.bin' -Size ([long]4294967296) -Transport { param($h, $p, $n, $s) $script:networkCalls = $script:networkCalls + 1; return @{ ok = $false; phase = 'size'; httpStatus = 413; hostMessage = 'host said 413' } } -Sleeper { param($ms) }
Cell 'B4-host-413-failfast' 'a host 413 under the cap is ONE attempt (fail-fast), never a retry loop' (($script:networkCalls -eq 1) -and ([int]$t413.attemptsUsed -eq 1) -and ([string]$t413.phase -eq 'size')) ('network=' + $script:networkCalls + ' attempts=' + $t413.attemptsUsed + ' phase=' + $t413.phase)

# ============================================================================
# C. SPARSE MECHANISM + MEMORY BASELINE
# ============================================================================
$size100m = [long]104857600
$spProbe = New-F50SparseFile -Path (Join-Path $tmp 'f50-sparse-probe.bin') -Size $size100m
Cell 'C1-sparse-mechanism' 'a sparse file reports its full logical length while allocating under 32 MiB of a 100 MiB source (fsutil setflag + SetLength; the bound tolerates background runner disk noise)' (($spProbe.logical -eq $size100m) -and ($spProbe.allocated -lt 33554432) -and ($spProbe.sparse -match 'sparse')) ('logical=' + (Fmt-Bytes $spProbe.logical) + ' allocated=' + (Fmt-Bytes $spProbe.allocated) + ' queryflag=' + $spProbe.sparse)
Remove-Item -LiteralPath $spProbe.path -Force -ErrorAction SilentlyContinue

# A baseline job: the peak working set of a process that only dot-sources the
# module. Every size cell is bounded RELATIVE to it, so the assertion measures
# the uploader's buffers and not the runtime's startup footprint.
$baseJob = Start-Job -ScriptBlock {
    param($Mod)
    $ErrorActionPreference = 'Stop'
    . $Mod
    $p = 0
    try { $p = (Get-Process -Id $PID).PeakWorkingSet64 } catch { $p = 0 }
    return @{ baseline = [long]$p }
} -ArgumentList $modPath
$basePeak = 268435456
if (Wait-Job -Job $baseJob -Timeout 180) { $br = Receive-Job -Job $baseJob; if ($br -and [long]$br.baseline -gt 0) { $basePeak = [long]$br.baseline } }
Remove-Job -Job $baseJob -Force -ErrorAction SilentlyContinue
Write-Host ('[F50] uploader baseline peak working set: ' + (Fmt-Bytes $basePeak))
Cell 'C2-baseline-peak-measured' 'a job that only loads the module peaks under 512 MiB (the reference for every memory ceiling below)' (($basePeak -gt 0) -and ($basePeak -lt 536870912)) ('baseline=' + (Fmt-Bytes $basePeak))

# ============================================================================
# D. REAL MULTI-GB UPLOADS OVER LOOPBACK (discarding listener)
# ============================================================================
function Start-F50Listener {
    param([int]$BasePort = 18600)
    for ($i = 0; $i -lt 40; $i++) {
        $tryPort = $BasePort + $i
        $l = New-Object System.Net.HttpListener
        try {
            $l.Prefixes.Add('http://127.0.0.1:' + $tryPort + '/')
            $l.Start()
            return @{ listener = $l; port = $tryPort }
        } catch { try { $l.Close() } catch { } }
    }
    return $null
}

function Get-F50Context {
    # Bounded wait: a client that never connects must fail the cell, not the job.
    param($Listener, [int]$WaitSec = 240)
    $task = $Listener.GetContextAsync()
    if (-not $task.Wait([System.TimeSpan]::FromSeconds($WaitSec))) { return $null }
    return $task.Result
}

function Send-F50Envelope {
    param($Ctx, [int]$Status = 200, [string]$Body = '', [string]$RetryAfter = '')
    if (-not $Body) { $Body = '{"status":"ok","data":{"id":"f50-wire-id","downloadPage":"https://gofile.test/d/f50wire","code":"f50wirecode"}}' }
    $rb = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Ctx.Response.StatusCode = $Status
    $Ctx.Response.ContentType = 'application/json'
    if ($RetryAfter) { $Ctx.Response.AddHeader('Retry-After', $RetryAfter) }
    $Ctx.Response.ContentLength64 = $rb.Length
    $Ctx.Response.OutputStream.Write($rb, 0, $rb.Length)
    $Ctx.Response.Close()
}

function Invoke-F50UploadCell {
    # ONE real upload of a sparse $Size file to the discarding loopback
    # listener. The listener drains the body (counting bytes, keeping the first
    # 8 KiB for the part-header contract) and answers the documented envelope.
    param($Listener, [int]$Port, [long]$Size, [string]$Name, [string]$File, [int]$WaitSec = 900)
    $job = Start-Job -ScriptBlock {
        param($Mod, $HostAddr, $Path, $Name, $Size, $TimeoutSec)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = $HostAddr
        $h.uploadScheme = 'http'
        $r = $null
        $err = ''
        try {
            $r = Invoke-F46MirrorAttempt -HostCfg $h -Path $Path -Name $Name -Size $Size -AttemptNo 1 -TimeoutSec $TimeoutSec
        } catch { $err = [string]$_.Exception.Message }
        $p = 0
        try { $p = (Get-Process -Id $PID).PeakWorkingSet64 } catch { $p = 0 }
        if (-not $r) { return @{ ok = $false; phase = 'threw'; status = $null; msg = $err; link = ''; peak = [long]$p } }
        return @{ ok = [bool]$r.ok; phase = [string]$r.phase; status = $r.httpStatus; msg = [string]$r.hostMessage; link = [string]$r.directUrl; peak = [long]$p }
    } -ArgumentList $modPath, ('127.0.0.1:' + $Port), $File, $Name, $Size, 1800

    $ctx = Get-F50Context -Listener $Listener -WaitSec $WaitSec
    $obs = $null
    if ($ctx) {
        $headBuf = New-Object byte[] 8192
        $headLen = 0
        $total = [long]0
        $buf = New-Object byte[] 262144
        $started = Get-Date
        try {
            $in = $ctx.Request.InputStream
            $read = 0
            while (($read = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                if ($headLen -lt $headBuf.Length) {
                    $take = [Math]::Min($read, $headBuf.Length - $headLen)
                    [Array]::Copy($buf, 0, $headBuf, $headLen, $take)
                    $headLen = $headLen + $take
                }
                $total = $total + $read
            }
        } catch { }
        $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
        $obs = [ordered]@{
            method      = [string]$ctx.Request.HttpMethod
            path        = [string]$ctx.Request.Url.AbsolutePath
            query       = [string]$ctx.Request.Url.Query
            ctype       = [string]$ctx.Request.ContentType
            contentLen  = [long]$ctx.Request.ContentLength64
            transferEnc = [string]$ctx.Request.Headers['Transfer-Encoding']
            expect      = [string]$ctx.Request.Headers['Expect']
            auth        = [string]$ctx.Request.Headers['Authorization']
            cookie      = [string]$ctx.Request.Headers['Cookie']
            hostTokHdr  = [string]$ctx.Request.Headers['X-Gofile-Token']
            received    = [long]$total
            head        = [System.Text.Encoding]::ASCII.GetString($headBuf, 0, $headLen)
            drainMs     = $elapsed
        }
        try { Send-F50Envelope -Ctx $ctx -Status 200 } catch { }
    }
    $client = $null
    if (Wait-Job -Job $job -Timeout $WaitSec) { try { $client = Receive-Job -Job $job } catch { $client = $null } }
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    return @{ wire = $obs; client = $client }
}

function Invoke-F50PolicyCell {
    # A whole policy loop against the real socket: the listener answers each
    # attempt with the given status sequence, the client's Sleeper is injected
    # so the jittered backoff is deterministic (Rand01 = 0.5).
    param($Listener, [int]$Port, [string]$Id, $Statuses, [string]$RetryAfter = '', [string]$Body = '', [int]$WaitSec = 300)
    $file = Join-Path $tmp ('f50-' + $Id + '.bin')
    [System.IO.File]::WriteAllBytes($file, (New-Object byte[] 2048))
    $job = Start-Job -ScriptBlock {
        param($Mod, $HostAddr, $Path)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = $HostAddr
        $h.uploadScheme = 'http'
        $global:slept = New-Object System.Collections.ArrayList
        $r = Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path $Path -Name 'f50-retry.bin' -Size ([long]2048) -Sleeper { param($ms) [void]$global:slept.Add([int]$ms) } -Rand01 0.5
        $retryable = $false
        try { $retryable = [bool]$r.attempts[0].retryable } catch { $retryable = $false }
        return @{ ok = [bool]$r.ok; phase = [string]$r.phase; status = $r.httpStatus; attempts = [int]$r.attemptsUsed; slept = @($global:slept); msg = [string]$r.hostMessage; link = [string]$r.link; retryable = $retryable }
    } -ArgumentList $modPath, ('127.0.0.1:' + $Port), $file
    $served = 0
    foreach ($st in @($Statuses)) {
        $ctx = Get-F50Context -Listener $Listener -WaitSec $WaitSec
        if (-not $ctx) { break }
        try { $ctx.Request.InputStream.CopyTo([System.IO.Stream]::Null) } catch { }
        $served = $served + 1
        if ([int]$st -eq 200) { try { Send-F50Envelope -Ctx $ctx -Status 200 } catch { } }
        else {
            $b = $Body
            if (-not $b) { $b = ('{"status":"error-transient-' + [string]$st + '","message":"mock host transient refusal"}') }
            try { Send-F50Envelope -Ctx $ctx -Status ([int]$st) -Body $b -RetryAfter $RetryAfter } catch { }
        }
    }
    $res = $null
    if (Wait-Job -Job $job -Timeout $WaitSec) { try { $res = Receive-Job -Job $job } catch { $res = $null } }
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    return @{ result = $res; served = $served }
}

$listenerInfo = Start-F50Listener -BasePort 18600
if (-not $listenerInfo) {
    Cell 'D0-listener' 'a loopback listener could be started for the wire cells' $false 'no free port in 18600-18639 / http.sys refused the prefix'
} else {
    $listener = $listenerInfo.listener
    $port = [int]$listenerInfo.port
    Write-Host ('[F50] discarding loopback listener on http://127.0.0.1:' + $port + '/uploadfile (no external host is ever contacted)')
    $defaultHostRef = Get-F46DefaultHost

    $sizes = @(
        @{ id = 'D1-upload-100mb'; size = [long]104857600 },
        @{ id = 'D2-upload-1gb'; size = [long]1073741824 },
        @{ id = 'D3-upload-3gb'; size = [long]3221225472 },
        @{ id = 'D4-upload-6gb'; size = [long]6442450944 }
    )
    foreach ($case in $sizes) {
        $sz = [long]$case.size
        $label = [string]$case.id
        $name = ('f50-' + $label + '.bin')
        $file = Join-Path $tmp $name
        $sp2 = New-F50SparseFile -Path $file -Size $sz
        if ($sp2.logical -ne $sz) {
            Cell $label ('a sparse source of ' + (Fmt-Bytes $sz) + ' exists') $false ('sparse creation failed: logical=' + (Fmt-Bytes $sp2.logical) + ' allocated=' + (Fmt-Bytes $sp2.allocated) + ' queryflag=' + $sp2.sparse)
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            continue
        }
        # The pinned spec for THIS name: the wire bytes must equal the contract
        # the spec assembles, or the contract has drifted from the transport.
        $specCell = New-F46UploadRequestSpec -HostCfg $defaultHostRef -Name $name -Boundary '----ghrdpF50contract'
        # Ceiling: the runtime baseline plus a small buffer budget. A whole-file
        # blob would be at least the file size, so size/8 (floor 128 MiB)
        # discriminates sharply at every scale.
        $ceiling = $basePeak + [Math]::Max(134217728, [long]($sz / 8))
        Write-Host ('[F50] ' + $label + ': streaming ' + (Fmt-Bytes $sz) + ' (peak ceiling ' + (Fmt-Bytes $ceiling) + ')')
        $r = Invoke-F50UploadCell -Listener $listener -Port $port -Size $sz -Name $name -File $file -WaitSec 900
        $w = $r.wire
        $c = $r.client
        if (-not $w) {
            Cell $label ('the listener received the whole ' + (Fmt-Bytes $sz) + ' multipart body') $false 'no request arrived within the bounded wait'
        } else {
            Cell ($label + '-bytes') ('the listener drained the file size plus multipart framing, and Content-Length equals what arrived') (([long]$w.received -ge $sz) -and ([long]$w.received -le ($sz + 4096)) -and ([long]$w.contentLen -eq [long]$w.received)) ('received=' + (Fmt-Bytes ([long]$w.received)) + ' content-length=' + (Fmt-Bytes ([long]$w.contentLen)) + ' transfer-encoding=[' + $w.transferEnc + '] drainMs=' + $w.drainMs)
            Cell ($label + '-length-based') 'the request is length-based (Content-Length set, no chunked encoding) as the pinned guest contract expects' (([long]$w.contentLen -eq [long]$w.received) -and ([string]$w.transferEnc -eq '')) ('content-length=' + $w.contentLen + ' transfer-encoding=[' + $w.transferEnc + '] expect=[' + $w.expect + ']')
            Cell ($label + '-guest-wire') '[F48/F49] zero credential headers on the wire at this size, and no credential in the URL' (([string]$w.auth -eq '') -and ([string]$w.cookie -eq '') -and ([string]$w.hostTokHdr -eq '') -and ([string]$w.path -notmatch 'token=') -and ([string]$w.query -notmatch 'token=')) ('auth=[' + $w.auth + '] cookie=[' + $w.cookie + '] hostTokenHeader=[' + $w.hostTokHdr + '] path=' + $w.path + $w.query)
            Cell ($label + '-part-contract') 'the part headers on the wire are byte-for-byte the pinned spec (form-data name="file" + filename + part Content-Type)' (([string]$w.head).Contains([string]$specCell.partDisposition) -and ([string]$w.head).Contains('Content-Type: ' + [string]$specCell.partContentType)) ('head=' + (([string]$w.head) -replace "`r`n", ' | '))
            Cell ($label + '-result') 'the attempt succeeds and parses id + downloadPage into a link' (([bool]$c.ok) -and ([string]$c.link -eq 'https://gofile.test/d/f50wire')) ('ok=' + $c.ok + ' phase=' + $c.phase + ' status=' + $c.status + ' link=' + $c.link + ' msg=' + $c.msg)
            Cell ($label + '-peak-memory') ('the uploader process peaked under ' + (Fmt-Bytes $ceiling) + ' (baseline ' + (Fmt-Bytes $basePeak) + ' + budget) for a ' + (Fmt-Bytes $sz) + ' file: no whole-file blob') (([long]$c.peak -gt 0) -and ([long]$c.peak -lt $ceiling)) ('peak=' + (Fmt-Bytes ([long]$c.peak)) + ' ceiling=' + (Fmt-Bytes $ceiling) + ' size=' + (Fmt-Bytes $sz))
        }
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }

    # D5 - a real 413 with a LONG plain-text body: phase=size, ONE attempt, and
    # the COMPLETE host message survives (F44: never truncate the reason).
    $long413 = ('host limit exceeded: ' + ('detail '.PadRight(1200, '.')) + ' END-OF-UNTRUNCATED-413')
    $r413 = Invoke-F50PolicyCell -Listener $listener -Port $port -Id 'D5' -Statuses @(413) -Body $long413
    Cell 'D5-host-413-real-socket' 'a real 413 maps to phase=size, is ONE attempt, and carries the complete 1.2 KB host message untruncated' (($r413.result -ne $null) -and ([string]$r413.result.phase -eq 'size') -and ([int]$r413.result.attempts -eq 1) -and ([string]$r413.result.msg).Contains('END-OF-UNTRUNCATED-413') -and (([string]$r413.result.msg).Length -ge 1200)) ('phase=' + $r413.result.phase + ' status=' + $r413.result.status + ' attempts=' + $r413.result.attempts + ' msgLen=' + $(if ($r413.result) { ([string]$r413.result.msg).Length } else { 0 }))

    # D6-D8 - transient retries on the REAL socket with the new transport. The
    # Sleeper is injected, so with Rand01=0.5 the jitter is deterministic:
    # 300, 550, 1050, 2050 ms (base 500, cap 8000, floor 100). A Retry-After of
    # 1s is a FLOOR over that sequence, never a ceiling.
    $r429 = Invoke-F50PolicyCell -Listener $listener -Port $port -Id 'D6' -Statuses @(429, 429, 429, 429, 429) -RetryAfter '1' -Body '{"status":"error-ratelimit","message":"mock host rate limit"}'
    $slept429 = ''
    if ($r429.result) { $slept429 = (@($r429.result.slept) -join ',') }
    Cell 'D6-retry-429-real-socket' 'five 429s = 5 attempts, phase=http, Retry-After(1s) as a FLOOR over the jittered 300/550/1050/2050 sequence' (($r429.result -ne $null) -and ([int]$r429.result.attempts -eq 5) -and ([string]$r429.result.phase -eq 'http') -and ($slept429 -eq '1000,1000,1050,2050') -and ([int]$r429.served -eq 5)) ('attempts=' + $r429.result.attempts + ' phase=' + $r429.result.phase + ' status=' + $r429.result.status + ' slept=' + $slept429 + ' served=' + $r429.served)

    $r500 = Invoke-F50PolicyCell -Listener $listener -Port $port -Id 'D7' -Statuses @(500, 500, 500, 500, 500)
    $slept500 = ''
    if ($r500.result) { $slept500 = (@($r500.result.slept) -join ',') }
    Cell 'D7-retry-500-real-socket' 'five 500s = 5 attempts with the jittered backoff 300,550,1050,2050 and no Retry-After floor' (($r500.result -ne $null) -and ([int]$r500.result.attempts -eq 5) -and ($slept500 -eq '300,550,1050,2050')) ('attempts=' + $r500.result.attempts + ' phase=' + $r500.result.phase + ' status=' + $r500.result.status + ' slept=' + $slept500 + ' served=' + $r500.served)

    $r502 = Invoke-F50PolicyCell -Listener $listener -Port $port -Id 'D8' -Statuses @(502, 200)
    $slept502 = ''
    if ($r502.result) { $slept502 = (@($r502.result.slept) -join ',') }
    Cell 'D8-retry-502-then-success' 'a 502 then a 200 recovers in exactly 2 attempts with ONE backoff and a parsed link' (($r502.result -ne $null) -and ([bool]$r502.result.ok) -and ([int]$r502.result.attempts -eq 2) -and ($slept502 -eq '300') -and ([string]$r502.result.link -eq 'https://gofile.test/d/f50wire')) ('ok=' + $r502.result.ok + ' attempts=' + $r502.result.attempts + ' slept=' + $slept502 + ' link=' + $r502.result.link + ' served=' + $r502.served)

    # D9 - a real 403 is the labeled F48 terminal reason, ONE attempt, and the
    # guest ladder has no credential rung to fall back to.
    $long403 = ('account required: ' + ('detail '.PadRight(600, '.')) + ' END-OF-UNTRUNCATED-403')
    $r403 = Invoke-F50PolicyCell -Listener $listener -Port $port -Id 'D9' -Statuses @(403) -Body $long403
    Cell 'D9-auth-403-real-socket' 'a real 403 = phase=auth, ONE attempt, the labeled token-less reason + operator options, retryable=false' (($r403.result -ne $null) -and ([string]$r403.result.phase -eq 'auth') -and ([int]$r403.result.attempts -eq 1) -and (-not [bool]$r403.result.retryable) -and ([string]$r403.result.msg).StartsWith('host requires account token; token-less mode unsupported') -and ([string]$r403.result.msg).Contains('Operator options:') -and ([string]$r403.result.msg).Contains('END-OF-UNTRUNCATED-403')) ('attempts=' + $r403.result.attempts + ' phase=' + $r403.result.phase + ' retryable=' + $r403.result.retryable + ' msg=' + $r403.result.msg)

    # D10 - a real 415 is phase=type and fail-fast.
    $r415 = Invoke-F50PolicyCell -Listener $listener -Port $port -Id 'D10' -Statuses @(415) -Body 'unsupported media type: this host refuses the part Content-Type (mock refusal, plain text so the HTTP-code mapping is what is exercised)'
    Cell 'D10-host-415-real-socket' 'a real 415 = phase=type, ONE attempt (fail-fast)' (($r415.result -ne $null) -and ([string]$r415.result.phase -eq 'type') -and ([int]$r415.result.attempts -eq 1)) ('phase=' + $r415.result.phase + ' attempts=' + $r415.result.attempts + ' status=' + $r415.result.status)

    try { $listener.Stop(); $listener.Close() } catch { }
}

# ============================================================================
# E. TLS RESET + TCP REFUSAL (transport-level transients on the new client)
# ============================================================================
# E1 - a socket that answers the TLS ClientHello with plain text: the handshake
# fails as a TLS failure, which the policy retries as a transient (5 attempts).
$tlsPort = 0
$tlsListener = $null
for ($i = 0; $i -lt 40; $i++) {
    $tryPort = 18700 + $i
    $tcpTry = $null
    try {
        $tcpTry = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $tryPort)
        $tcpTry.Start()
        $tlsPort = $tryPort
        $tlsListener = $tcpTry
        break
    } catch { try { if ($tcpTry) { $tcpTry.Stop() } } catch { } }
}
$tlsFile = Join-Path $tmp 'f50-tls.bin'
[System.IO.File]::WriteAllBytes($tlsFile, (New-Object byte[] 2048))
if ($tlsPort -eq 0) {
    Cell 'E1-tls-reset' 'a TLS-handshake reset is classified phase=tls and retried 5x as a transient' $false 'no free port for the TLS-reset listener'
} else {
    $tlsJob = Start-Job -ScriptBlock {
        param($Mod, $HostAddr, $Path)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = $HostAddr
        $h.uploadScheme = 'https'
        $global:slept = New-Object System.Collections.ArrayList
        $r = Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path $Path -Name 'f50-tls.bin' -Size ([long]2048) -Sleeper { param($ms) [void]$global:slept.Add([int]$ms) } -Rand01 0.5
        $retryable = $false
        try { $retryable = [bool]$r.attempts[0].retryable } catch { $retryable = $false }
        return @{ ok = [bool]$r.ok; phase = [string]$r.phase; status = $r.httpStatus; attempts = [int]$r.attemptsUsed; slept = @($global:slept); msg = [string]$r.hostMessage; retryable = $retryable }
    } -ArgumentList $modPath, ('127.0.0.1:' + $tlsPort), $tlsFile
    $accepted = 0
    $deadline = (Get-Date).AddSeconds(240)
    try {
        while ((Get-Date) -lt $deadline) {
            if ($tlsJob.State -ne 'Running') { break }
            $ar = $tlsListener.BeginAcceptTcpClient($null, $null)
            # 10s idle => the client finished its attempts; stop accepting.
            if (-not $ar.AsyncWaitHandle.WaitOne([System.TimeSpan]::FromSeconds(10))) { break }
            $sock = $tlsListener.EndAcceptTcpClient($ar)
            $accepted = $accepted + 1
            try {
                $ns = $sock.GetStream()
                $junk = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 400 Bad Request`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
                $ns.Write($junk, 0, $junk.Length)
                $ns.Flush()
            } catch { }
            try { $sock.Close() } catch { }
        }
    } catch { }
    $tlsRes = $null
    if (Wait-Job -Job $tlsJob -Timeout 300) { try { $tlsRes = Receive-Job -Job $tlsJob } catch { $tlsRes = $null } }
    Remove-Job -Job $tlsJob -Force -ErrorAction SilentlyContinue
    try { $tlsListener.Stop() } catch { }
    $sleptTls = ''
    if ($tlsRes) { $sleptTls = (@($tlsRes.slept) -join ',') }
    Cell 'E1-tls-reset' 'a TLS-handshake reset (plain text answered to the ClientHello) is phase=tls, retryable, and retried 5x with the jittered backoff' (($tlsRes -ne $null) -and ([string]$tlsRes.phase -eq 'tls') -and ([bool]$tlsRes.retryable) -and ([int]$tlsRes.attempts -eq 5) -and ($sleptTls -eq '300,550,1050,2050') -and ($accepted -ge 5)) ('phase=' + $tlsRes.phase + ' attempts=' + $tlsRes.attempts + ' retryable=' + $tlsRes.retryable + ' slept=' + $sleptTls + ' accepted=' + $accepted + ' msg=' + $tlsRes.msg)
}
Remove-Item -LiteralPath $tlsFile -Force -ErrorAction SilentlyContinue

# E2 - nothing listening: a refused TCP connect is a transient too (phase=tcp),
# never a silent drop and never an unlabeled "upload failed".
$deadPort = 0
for ($i = 0; $i -lt 40; $i++) {
    $tryPort = 18900 + $i
    $probe = New-Object System.Net.Sockets.TcpClient
    try { $probe.Connect('127.0.0.1', $tryPort); $probe.Close() } catch { try { $probe.Close() } catch { }; $deadPort = $tryPort; break }
}
if ($deadPort -eq 0) {
    Cell 'E2-tcp-refused' 'a refused TCP connect is classified phase=tcp and retried 5x' $false 'no closed port found in 18900-18939'
} else {
    $deadFile = Join-Path $tmp 'f50-dead.bin'
    [System.IO.File]::WriteAllBytes($deadFile, (New-Object byte[] 2048))
    $deadJob = Start-Job -ScriptBlock {
        param($Mod, $HostAddr, $Path)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = $HostAddr
        $h.uploadScheme = 'http'
        $global:slept = New-Object System.Collections.ArrayList
        $r = Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path $Path -Name 'f50-dead.bin' -Size ([long]2048) -Sleeper { param($ms) [void]$global:slept.Add([int]$ms) } -Rand01 0.5
        return @{ ok = [bool]$r.ok; phase = [string]$r.phase; attempts = [int]$r.attemptsUsed; slept = @($global:slept); msg = [string]$r.hostMessage }
    } -ArgumentList $modPath, ('127.0.0.1:' + $deadPort), $deadFile
    $deadRes = $null
    if (Wait-Job -Job $deadJob -Timeout 300) { try { $deadRes = Receive-Job -Job $deadJob } catch { $deadRes = $null } }
    Remove-Job -Job $deadJob -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $deadFile -Force -ErrorAction SilentlyContinue
    $sleptDead = ''
    if ($deadRes) { $sleptDead = (@($deadRes.slept) -join ',') }
    Cell 'E2-tcp-refused' 'a refused TCP connect is phase=tcp and retried 5x with the jittered backoff' (($deadRes -ne $null) -and ([string]$deadRes.phase -eq 'tcp') -and ([int]$deadRes.attempts -eq 5) -and ($sleptDead -eq '300,550,1050,2050')) ('phase=' + $deadRes.phase + ' attempts=' + $deadRes.attempts + ' slept=' + $sleptDead + ' msg=' + $deadRes.msg)
}

# ============================================================================
# F. STREAMED AES-256 ABOVE THE GCM ONE-SHOT CAP
# ============================================================================
$keyF50 = New-F46MirrorKey
$gcmCap = [long]$script:F50GcmOneShotMaxBytes

# F1 - below the cap: the one-shot GCM container when this runner can bind
# AesGcm, otherwise the streamed CBC container. Either way the reported alg and
# mode are the truth (the Mirror card renders encAlg from this).
$smallPlain = Join-Path $tmp 'f50-small-plain.bin'
$smallCt = Join-Path $tmp 'f50-small-plain.bin.ghenc'
$smallSize = [long]8388608
$spSmall = New-F50SparseFile -Path $smallPlain -Size $smallSize
$encSmall = Invoke-F46EncryptFile -Path $smallPlain -OutPath $smallCt -KeyBase64 $keyF50
$expectMode = 'streamed'
$expectAlg = 'AES-256-CBC-PBKDF2'
if ($gcmUsable) { $expectMode = 'one-shot'; $expectAlg = 'AES-256-GCM' }
$ctSmallLen = 0
try { $ctSmallLen = (Get-Item -LiteralPath $smallCt).Length } catch { $ctSmallLen = 0 }
Cell 'F1-encrypt-below-cap' ('below the cap the container is ' + $expectAlg + ' (mode=' + $expectMode + ') and the reported alg/mode are the truth') (([bool]$encSmall.ok) -and ([string]$encSmall.alg -eq $expectAlg) -and ([string]$encSmall.mode -eq $expectMode) -and ($ctSmallLen -gt $smallSize)) ('ok=' + $encSmall.ok + ' alg=' + $encSmall.alg + ' mode=' + $encSmall.mode + ' ct=' + (Fmt-Bytes $ctSmallLen) + ' msg=' + $encSmall.message)
$rtSmall = Join-Path $tmp 'f50-small-roundtrip.bin'
$decSmall = Invoke-F46DecryptFile -Path $smallCt -OutPath $rtSmall -KeyBase64 $keyF50
$hSmallA = ''
$hSmallB = ''
if ([bool]$decSmall.ok) { try { $hSmallA = Get-F50Sha256 -Path $smallPlain; $hSmallB = Get-F50Sha256 -Path $rtSmall } catch { } }
Cell 'F1b-decrypt-below-cap' 'the matching decryptor recovers the identical bytes below the cap (SHA-256 equal)' (([bool]$decSmall.ok) -and ($hSmallA -ne '') -and ($hSmallA -eq $hSmallB)) ('ok=' + $decSmall.ok + ' alg=' + $decSmall.alg + ' mode=' + $decSmall.mode + ' hashEqual=' + ($hSmallA -eq $hSmallB) + ' msg=' + $decSmall.message)
foreach ($f in @($smallPlain, $smallCt, $rtSmall)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }

# F2-F5 - the streamed round trip just above the cap: encrypt, decrypt, prove
# byte equality by streamed SHA-256, and bound both processes' peak working set.
$bigPlain = Join-Path $tmp 'f50-big-plain.bin'
$bigCt = Join-Path $tmp 'f50-big-plain.bin.ghenc'
$bigPt = Join-Path $tmp 'f50-big-roundtrip.bin'
$bigSize = $gcmCap + 4096   # 1 GiB + 4 KiB: above the one-shot cap by construction
$spBig = New-F50SparseFile -Path $bigPlain -Size $bigSize
# The streamed round trip is the only part of the lab that writes REAL bytes:
# ~1 GiB of ciphertext + ~1 GiB of recovered plaintext. The requirement is
# exactly that (2x the source + 256 MiB of slack), measured and reported.
$freeBefore = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($tmp)).AvailableFreeSpace
$freeNeed = ($bigSize * 2) + 268435456
if ($freeBefore -lt $freeNeed) {
    Cell 'F2-streamed-encrypt-above-cap' ('at least ' + (Fmt-Bytes $freeNeed) + ' free on the workspace volume for the streamed round trip (1 GiB ciphertext + 1 GiB recovered plaintext + slack)') $false ('volume free is only ' + (Fmt-Bytes $freeBefore))
} elseif ($spBig.logical -ne $bigSize) {
    Cell 'F2-streamed-encrypt-above-cap' ('a sparse source of ' + (Fmt-Bytes $bigSize)) $false ('sparse creation failed: logical=' + (Fmt-Bytes $spBig.logical) + ' allocated=' + (Fmt-Bytes $spBig.allocated) + ' queryflag=' + $spBig.sparse)
} else {
    $encBig = $null
    $encJob = Start-Job -ScriptBlock {
        param($Mod, $Path, $OutPath, $Key)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $r = Invoke-F46EncryptFile -Path $Path -OutPath $OutPath -KeyBase64 $Key
        $p = 0
        try { $p = (Get-Process -Id $PID).PeakWorkingSet64 } catch { $p = 0 }
        return @{ ok = [bool]$r.ok; alg = [string]$r.alg; mode = [string]$r.mode; bytes = [long]$r.bytes; msg = [string]$r.message; peak = [long]$p }
    } -ArgumentList $modPath, $bigPlain, $bigCt, $keyF50
    if (Wait-Job -Job $encJob -Timeout 1200) { try { $encBig = Receive-Job -Job $encJob } catch { $encBig = $null } }
    Remove-Job -Job $encJob -Force -ErrorAction SilentlyContinue

    $expectedCt = $bigSize + 32 + 16   # salt|iv header + the PKCS7 full padding block
    Cell 'F2-streamed-encrypt-above-cap' ('above the cap the encryptor STREAMS the CBC container: mode=streamed, alg=AES-256-CBC-PBKDF2, exactly ' + (Fmt-Bytes $expectedCt) + ' out') (($encBig -ne $null) -and ([bool]$encBig.ok) -and ([string]$encBig.mode -eq 'streamed') -and ([string]$encBig.alg -eq 'AES-256-CBC-PBKDF2') -and ([long]$encBig.bytes -eq $expectedCt)) ($(if ($encBig) { 'ok=' + $encBig.ok + ' alg=' + $encBig.alg + ' mode=' + $encBig.mode + ' bytes=' + (Fmt-Bytes ([long]$encBig.bytes)) + ' expected=' + (Fmt-Bytes $expectedCt) + ' msg=' + $encBig.msg } else { 'no result' }))
    $encCeiling = $basePeak + [Math]::Max(134217728, [long]($bigSize / 8))
    Cell 'F3-streamed-encrypt-peak' ('the encrypting process peaked under ' + (Fmt-Bytes $encCeiling) + ' for a ' + (Fmt-Bytes $bigSize) + ' file: no whole-file array') (($encBig -ne $null) -and ([long]$encBig.peak -gt 0) -and ([long]$encBig.peak -lt $encCeiling)) ($(if ($encBig) { 'peak=' + (Fmt-Bytes ([long]$encBig.peak)) + ' ceiling=' + (Fmt-Bytes $encCeiling) } else { 'no result' }))

    $decBig = $null
    if ($encBig -and [bool]$encBig.ok) {
        $decJob = Start-Job -ScriptBlock {
            param($Mod, $Path, $OutPath, $Key)
            $ErrorActionPreference = 'Stop'
            . $Mod
            $r = Invoke-F46DecryptFile -Path $Path -OutPath $OutPath -KeyBase64 $Key
            $p = 0
            try { $p = (Get-Process -Id $PID).PeakWorkingSet64 } catch { $p = 0 }
            return @{ ok = [bool]$r.ok; alg = [string]$r.alg; mode = [string]$r.mode; bytes = [long]$r.bytes; msg = [string]$r.message; peak = [long]$p }
        } -ArgumentList $modPath, $bigCt, $bigPt, $keyF50
        if (Wait-Job -Job $decJob -Timeout 1200) { try { $decBig = Receive-Job -Job $decJob } catch { $decBig = $null } }
        Remove-Job -Job $decJob -Force -ErrorAction SilentlyContinue
    }
    $hashPlain = ''
    $hashPt = ''
    if ($decBig -and [bool]$decBig.ok) {
        try { $hashPlain = Get-F50Sha256 -Path $bigPlain; $hashPt = Get-F50Sha256 -Path $bigPt } catch { }
    }
    Cell 'F4-streamed-roundtrip-above-cap' ('the streamed decrypt returns the original bytes (SHA-256 equal, mode=streamed, ' + (Fmt-Bytes $bigSize) + ' recovered)') (($decBig -ne $null) -and ([bool]$decBig.ok) -and ([string]$decBig.mode -eq 'streamed') -and ([long]$decBig.bytes -eq $bigSize) -and ($hashPlain -ne '') -and ($hashPlain -eq $hashPt)) ($(if ($decBig) { 'ok=' + $decBig.ok + ' mode=' + $decBig.mode + ' bytes=' + (Fmt-Bytes ([long]$decBig.bytes)) + ' hashEqual=' + ($hashPlain -eq $hashPt) + ' msg=' + $decBig.msg } else { 'no decrypt result' }))
    $decCeiling = $basePeak + [Math]::Max(134217728, [long]($bigSize / 8))
    Cell 'F5-streamed-decrypt-peak' ('the decrypting process peaked under ' + (Fmt-Bytes $decCeiling)) (($decBig -ne $null) -and ([long]$decBig.peak -gt 0) -and ([long]$decBig.peak -lt $decCeiling)) ($(if ($decBig) { 'peak=' + (Fmt-Bytes ([long]$decBig.peak)) + ' ceiling=' + (Fmt-Bytes $decCeiling) } else { 'no result' }))
}
foreach ($f in @($bigPlain, $bigCt, $bigPt)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }

# F6 - a wrong key never recovers the plaintext and leaves no partial output
# (streaming writes part of the plaintext before the padding check fails).
$wkPlain = Join-Path $tmp 'f50-wrongkey.bin'
$wkCt = Join-Path $tmp 'f50-wrongkey.bin.ghenc'
$wkPt = Join-Path $tmp 'f50-wrongkey-out.bin'
[System.IO.File]::WriteAllText($wkPlain, ('GHRDP-F50-PLAINTEXT-MARKER ' + ('benign mirror payload line. ' * 40)))
$encWk = Invoke-F46EncryptFile -Path $wkPlain -OutPath $wkCt -KeyBase64 $keyF50
$decWk = Invoke-F46DecryptFile -Path $wkCt -OutPath $wkPt -KeyBase64 (New-F46MirrorKey)
$wkPtExists = Test-Path -LiteralPath $wkPt
# The container decides what "wrong key" can even mean: GCM is authenticated (a
# wrong key MUST fail outright and leave nothing behind); the legacy CBC
# container has no MAC, so ~1/256 wrong keys produce plausible padding and the
# decryptor reports success over GARBAGE. Honesty there means "the original
# plaintext is not recovered", which is what is asserted either way.
$wkMagic = ''
try {
    $wkMagicBytes = New-Object byte[] ([int]$script:F46GofileContract.containerMagic.Length)
    $wkFs = [System.IO.File]::Open($wkCt, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try { [void]$wkFs.Read($wkMagicBytes, 0, $wkMagicBytes.Length) } finally { try { $wkFs.Dispose() } catch { } }
    $wkMagic = [System.Text.Encoding]::ASCII.GetString($wkMagicBytes)
} catch { $wkMagic = '' }
$wkAuthenticated = ($wkMagic -eq [string]$script:F46GofileContract.containerMagic)
$wkPlainHash = ''
$wkPtHash = ''
try { $wkPlainHash = Get-F50Sha256 -Path $wkPlain } catch { $wkPlainHash = '' }
if ($wkPtExists) { try { $wkPtHash = Get-F50Sha256 -Path $wkPt } catch { $wkPtHash = '' } }
$wkRecovered = (($wkPtHash -ne '') -and ($wkPtHash -eq $wkPlainHash))
$wkExpect = 'a wrong key never recovers the plaintext' + $(if ($wkAuthenticated) { ' (authenticated GCM container: the attempt fails outright and no output file is left behind)' } else { ' (unauthenticated CBC container: a padding-luck "success" still yields different bytes)' })
$wkAssert = ([bool]$encWk.ok) -and (-not $wkRecovered)
if ($wkAuthenticated) { $wkAssert = $wkAssert -and (-not [bool]$decWk.ok) -and (-not $wkPtExists) }
Cell 'F6-wrong-key-no-plaintext' $wkExpect $wkAssert ('authenticated=' + $wkAuthenticated + ' encOk=' + $encWk.ok + ' decOk=' + $decWk.ok + ' partialOutputExists=' + $wkPtExists + ' plaintextRecovered=' + $wkRecovered + ' msg=' + $decWk.message)
foreach ($f in @($wkPlain, $wkCt, $wkPt)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }

# F7 - the GCM one-shot decrypt cap refuses HONESTLY above 2 GiB instead of
# dying with "Stream was too long.". Built as a sparse file carrying the GCM
# magic, so the refusal costs no disk and no memory.
$gcmBig = Join-Path $tmp 'f50-gcm-too-large.ghenc'
$gcmBigOut = Join-Path $tmp 'f50-gcm-never-written.bin'
$spGcm = New-F50SparseFile -Path $gcmBig -Size ([long]2200000000)
if ($spGcm.logical -eq 2200000000) {
    $magicBytes = [System.Text.Encoding]::ASCII.GetBytes([string]$script:F46GofileContract.containerMagic)
    $gfs = [System.IO.File]::Open($gcmBig, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try { $gfs.Write($magicBytes, 0, $magicBytes.Length) } finally { try { $gfs.Dispose() } catch { } }
    $decCap = Invoke-F46DecryptFile -Path $gcmBig -OutPath $gcmBigOut -KeyBase64 $keyF50
    Cell 'F7-gcm-cap-honest-refusal' 'a GCM container above the one-shot decrypt cap is refused with a labeled reason (no "Stream was too long.", no partial output)' ((-not [bool]$decCap.ok) -and ([string]$decCap.mode -eq 'refused-too-large') -and ([string]$decCap.message).Contains('F50 one-shot decrypt cap') -and (-not ([string]$decCap.message).Contains('Stream was too long')) -and (-not (Test-Path -LiteralPath $gcmBigOut))) ('ok=' + $decCap.ok + ' mode=' + $decCap.mode + ' msg=' + $decCap.message)
} else {
    Cell 'F7-gcm-cap-honest-refusal' 'a sparse 2.2 GB GCM-headed container exists' $false ('sparse creation failed: logical=' + (Fmt-Bytes $spGcm.logical) + ' queryflag=' + $spGcm.sparse)
}
Remove-Item -LiteralPath $gcmBig -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $gcmBigOut -Force -ErrorAction SilentlyContinue

# ============================================================================
# G. SUMMARY
# ============================================================================
Write-Host ('[F50] volume free at end: ' + (Fmt-Bytes ([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($tmp)).AvailableFreeSpace)))
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ('[F50] cells run: ' + $script:cells + ' | failures: ' + $script:failures)
if ($script:failures -gt 0) {
    Write-Host ('::error::[F50] mirror large-file streaming lab failed: ' + $script:failures + ' cell(s) of ' + $script:cells)
    exit 1
}
Write-Host '[F50] mirror large-file streaming lab: ALL CELLS PASS (loopback only, no live host, no credential, sparse files, discarding listener)'
exit 0
