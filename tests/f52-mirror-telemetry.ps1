# F52 lab FIRST: shipped socket adapter + real discarding loopback receiver.
# No live upload, no identity changes, no credentials toward a host. Sparse
# cells consume no physical file allocation. Keys never enter any RESULT.
param([switch]$SkipLargeCells)
$ErrorActionPreference = 'Stop'
$script:f52Failures = 0
function Result-F52([string]$Id, [bool]$Ok, [string]$Detail) {
    $verdict = $(if ($Ok) { 'PASS' } else { 'FAIL' })
    $line = ($Id + ' RESULT=' + $verdict + ' ' + $Detail) -replace '[\r\n]+', ' '
    Write-Host $line
    if ($Ok) { Write-Host ('::notice title=F52 cell::' + $line) }
    else { $script:f52Failures++; Write-Host ('::error title=F52 cell::' + $line) }
}
trap {
    Write-Host ('::error title=F52 lab fault::line ' + $_.InvocationInfo.ScriptLineNumber + ' phase=lab ' + $_.Exception.GetBaseException().Message)
    exit 1
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $repo 'payloads/ghrdp-mirror.ps1')
. (Join-Path $repo 'payloads/ghrdp-lib.ps1')
$ErrorActionPreference = 'Stop' # lib's production default must not hide a lab fault
Add-F52ProgressTypes
if ($PSVersionTable.PSVersion.Major -lt 6) {
    Add-Type -Path (Join-Path $PSScriptRoot 'f52-mirror-lab.cs') -ReferencedAssemblies @('System.dll', 'System.Core.dll')
} else { Add-Type -Path (Join-Path $PSScriptRoot 'f52-mirror-lab.cs') }
$tmp = $env:RUNNER_TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath() }
$lab = Join-Path $tmp ('f52-' + [guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($lab)
$watcherAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'payloads/ghrdp-watcher.ps1'), [ref]$null, [ref]$null)
foreach ($name in @('Update-F52MirrorProgress', 'Test-F51DownloadsRoot', 'Get-F51AutoUploadRoots', 'Test-F51AutoUploadPath', 'Split-F51AutoQueue', 'New-F51AutoHost')) {
    $fn = $watcherAst.Find({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name }, $true)
    if (-not $fn) { throw ('F52: missing shipped watcher helper ' + $name) }
    . ([scriptblock]::Create($fn.Extent.Text))
}
function New-F52Sparse([string]$Name, [long]$Size) {
    $path = Join-Path $lab ($Name + '.bin')
    if ($env:OS -eq 'Windows_NT') {
        $out = (& fsutil file createnew $path 0 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw ('fsutil createnew failed: ' + $out.Trim()) }
        $out = (& fsutil sparse setflag $path 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw ('fsutil sparse setflag failed: ' + $out.Trim()) }
    }
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write)
    try { $fs.SetLength($Size) } finally { $fs.Dispose() }
    return $path
}
function New-F52LoopHost($Receiver) {
    $h = Get-F46DefaultHost
    $h.enabled = $true; $h.uploadHost = ('127.0.0.1:' + $Receiver.Port)
    $h.uploadPath = '/uploadfile/'; $h.uploadScheme = 'http'
    return $h
}
try {
    # Flush failure: attempted writes and source reads are NOT socket bytes.
    $state = New-Object Ghrdp.Mirror.ProgressState(60)
    $ms = New-Object System.IO.MemoryStream(,[byte[]](New-Object byte[] 8192))
    $inner = New-Object System.Net.Http.StreamContent($ms)
    $content = New-Object Ghrdp.Mirror.ProgressContent($inner, ([long]8192), $state)
    $fault = New-Object Ghrdp.MirrorLab.FlushFault
    try { $content.CopyToAsync($fault).GetAwaiter().GetResult() } catch { }
    $snapshot = $state.Snapshot()
    Result-F52 'F52-WRITE-FLUSH' ($snapshot.BytesSent -eq 0 -and $snapshot.LastMessage -eq 'lab socket flush fault') 'bytesSent=0; failed flush never counts source reads'
    $content.Dispose(); $fault.Dispose()

    # Real-clock state with an explicit observation clock (no sleeping 180s).
    $zero = New-Object Ghrdp.Mirror.ProgressState(60)
    $at60 = $zero.SnapshotAt(60)
    $view = ConvertTo-F52Progress -Snapshot $at60 -Size 8GB -HostId 'loopback' -WorkerMode 'all'
    Result-F52 'F52-WINDOW60' ($at60.Stalled -and $at60.WindowBytes -eq 0 -and $null -eq $view.etaSeconds -and $view.stallLabel -eq 'stalled (no bytes in 60s)') 'phase=http; stalled at N=60s; etaSeconds=null'
    Result-F52 'F52-WINDOW180' ($zero.SnapshotAt(180).Failed) '3 no-byte windows => failed phase=http; F44 retry policy unchanged'
    $moving = New-Object Ghrdp.Mirror.ProgressState(60)
    $moving.Written(1048576)
    $before = $moving.SnapshotAt(30)
    $after = $moving.SnapshotAt(61)
    Result-F52 'F52-REAL-WINDOW' ($before.WindowBytes -eq 1048576 -and $before.SpeedBps -gt 0 -and $after.WindowBytes -eq 0 -and $after.SpeedBps -eq 0 -and $after.Stalled) 'real positive window decays to ZERO, not ~1 B/s'

    # Exact JSON beyond 2^53; live objects remain Int64, never double.
    $json = (ConvertTo-F52JsonSafe ([ordered]@{ bytesSent = [long]9007199254740993; size = [long]9223372036854775807; small = [long]137438953472; rows = @(@{ bytesSent = [long]9007199254740993 }) })) | ConvertTo-Json -Depth 8
    $back = $json | ConvertFrom-Json
    Result-F52 'F52-JSON64' ($back.bytesSent -is [string] -and $back.bytesSent -eq '9007199254740993' -and $back.size -eq '9223372036854775807' -and $back.small -eq 137438953472 -and $back.rows[0].bytesSent -is [string]) 'large byte counts are decimal strings; 128 GiB stays exact'

    # Cap from the actual GET /servers schema, before ANY upload transport.
    $capHost = Get-F46DefaultHost; $capHost.enabled = $true
    $envCap = '{"status":"ok","data":{"servers":[{"name":"store-test.gofile.io","maxFileBytes":"8589934592"}]}}' | ConvertFrom-Json
    $cap = Get-F52ServersCap -Json $envCap -HostCfg $capHost
    $capHost = Set-F52HostCap -HostCfg $capHost -Rows @(@{ host = 'gofile'; maxFileBytes = $cap })
    $script:capCalls = 0
    $spy = { param($h, $p, $n, $s) $script:capCalls++; throw 'upload spy must never run after cap refusal' }
    $refusal = Invoke-F46MirrorAttempt -HostCfg $capHost -Path 'not-opened.bin' -Name '64GB.bin' -Size 64GB -Transport $spy -WorkerMode 'all'
    Result-F52 'F52-CAP0' ($refusal.phase -eq 'size' -and $script:capCalls -eq 0 -and $refusal.hostMessage.Contains('8589934592') -and $refusal.hostMessage.Contains('network=0') -and $refusal.record.encryptMode -eq 'all') 'cap=8589934592; size=68719476736; network=0; exact cap in hostMessage'
    $envUnknown = '{"status":"ok","data":{"servers":[{"name":"store-test.gofile.io"}]}}' | ConvertFrom-Json
    Result-F52 'F52-CAP-NULL' ($null -eq (Get-F52ServersCap -Json $envUnknown -HostCfg (Get-F46DefaultHost))) 'cap=null means unknown, so streaming is allowed; no unlimited claim'
    $mixed = '{"status":"ok","data":{"servers":[{"name":"a","maxFileBytes":10},{"name":"b"}]}}' | ConvertFrom-Json
    Result-F52 'F52-CAP-MIXED' ($null -eq (Get-F52ServersCap -Json $mixed -HostCfg (Get-F46DefaultHost))) 'mixed/missing automatic-fleet caps cannot prove an automatic-endpoint cap'

    $script:capCalls = 0
    $badLane = Invoke-F46MirrorAttempt -HostCfg $capHost -Path 'not-opened.bin' -Name 'bad-auto.bin' -Size 1 -Transport $spy -WorkerMode 'none' -WorkerLane 'auto'
    Result-F52 'F52-LANE-REFUSAL' ($badLane.phase -eq 'encrypt' -and $script:capCalls -eq 0 -and -not $badLane.record.retryable) 'auto/runtime plaintext defect is refused at network=0; no downgrade or retry'

    # Default / explicit manual plaintext / runtime lane convergence.
    $cfg = '{"mirror":false,"encryptMode":"none","mirrorPlaintextElection":true}' | ConvertFrom-Json
    Result-F52 'F52-MODE-AUTO' ((Get-F52WorkerMode -Cfg $cfg -Auto $true) -eq 'all') 'auto=Downloads; explicit manual plaintext cannot affect this lane'
    Result-F52 'F52-MODE-PLAIN' ((Get-F52WorkerMode -Cfg $cfg) -eq 'none') 'only an explicit dispatch election produces manual encryptMode=none'
    [void](Set-F49RuntimeOptIn -Cfg $cfg)
    Result-F52 'F52-MODE-OPT' ($cfg.encryptMode -eq 'all' -and -not $cfg.mirrorPlaintextElection -and (Get-F52WorkerMode -Cfg $cfg) -eq 'all' -and @(Get-F46MirrorKeyBytes -KeyBase64 $cfg.mirrorKey).Count -eq 32) 'runtime opt-in converges to all with a runner-local 32-byte key'

    $cases = @(@('F52-S8', [long]8GB), @('F52-S64', [long]64GB), @('F52-S128', [long]128GB))
    if ($SkipLargeCells) { $cases = @(@('F52-SMALL', [long]16MB)) } # local quick check only; CI NEVER passes this switch
    foreach ($case in $cases) {
        $id = [string]$case[0]; $size = [long]$case[1]
        $path = New-F52Sparse -Name $id -Size $size
        $receiver = New-Object Ghrdp.MirrorLab.DiscardReceiver($size, $false)
        Initialize-MirrorProgress -Path (Join-Path $lab 'progress.json')
        $global:GhrdpDoneBytes = [long]0
        $global:GhrdpProg.agg.bytesTotal = $size
        Set-ActiveFile -Name $id -Phase 'http' -Total $size
        $entry = [ordered]@{ name = $id; size = $size; bytesSent = [long]0; stallWindows = 0 }
        $script:lastSeen = [long]0; $script:maxLead = [long]0; $script:monotonic = $true; $script:progressSamples = 0
        $observe = { param($v)
            if ([long]$v.bytesSent -lt $script:lastSeen -or [long]$v.bytesSent -gt $size) { $script:monotonic = $false }
            $script:lastSeen = [long]$v.bytesSent
            $lead = [long]$v.bytesSent - $receiver.PayloadBytes
            if ($lead -gt $script:maxLead) { $script:maxLead = $lead }
            $script:progressSamples++
            Update-F52MirrorProgress -Progress $v -Entry $entry
        }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $r = Invoke-F46MirrorAttempt -HostCfg (New-F52LoopHost $receiver) -Path $path -Name ($id + '.bin') -Size $size -ProgressAction $observe -WorkerMode 'none'
            $over = $receiver.BodyBytes - $receiver.PayloadBytes
            Result-F52 $id ($r.ok -and [long]$r.bytesSent -eq $receiver.PayloadBytes -and $receiver.PayloadBytes -eq $size -and $script:monotonic -and $script:progressSamples -gt 1 -and $script:maxLead -le 32MB -and $over -gt 0 -and $over -lt 1024 -and -not $receiver.IdentityHeaders) ('bytesSent=' + [long]$r.bytesSent + ' drained=' + $receiver.PayloadBytes + ' samples=' + $script:progressSamples + ' maxSocketLead=' + $script:maxLead + ' ms=' + $sw.ElapsedMilliseconds + ' multipartOverhead=' + $over)
        } finally { $receiver.Dispose(); Remove-Item -LiteralPath $path -Force }
    }

    # Real Downloads trigger + streaming encryption into the same socket path.
    $downloads = Join-Path $lab 'Downloads'; [void][System.IO.Directory]::CreateDirectory($downloads)
    $download = Join-Path $downloads 'rdp-download.bin'; [System.IO.File]::WriteAllText($download, ('benign-rdp-download' * 65536))
    $roots = @(Get-F51AutoUploadRoots -Roots @($downloads))
    $split = Split-F51AutoQueue -Queue @((Get-Item -LiteralPath $download)) -AutoRoots $roots
    $mode = Get-F52WorkerMode -Cfg $cfg -Auto $true
    $encrypted = Invoke-F46EncryptFile -Path $split.auto[0].FullName -KeyBase64 $cfg.mirrorKey -StreamOnly
    $receiver = New-Object Ghrdp.MirrorLab.DiscardReceiver(([long]$encrypted.bytes), $false)
    try {
        $r = Invoke-F46MirrorAttempt -HostCfg (New-F52LoopHost $receiver) -Path $download -Name 'rdp-download.bin.ghenc' -Size ([long]$encrypted.bytes) -EncryptRequested $true -Encrypted ([bool]$encrypted.ok) -ContentType 'application/x-ghrdp-mirror' -UploadSource $encrypted.stream -WorkerMode $mode -WorkerLane 'auto'
        Result-F52 'F52-ENCRYPT-WIRE' ($split.auto.Count -eq 1 -and $encrypted.ok -and $r.ok -and $receiver.PartType -eq 'encrypted' -and $r.record.encryptMode -eq 'all' -and $r.record.encrypted -and $r.bytesSent -eq $receiver.PayloadBytes -and -not $receiver.IdentityHeaders) 'Downloads auto-queues; AES-256-CBC-PBKDF2 streams on demand; mode=all in actual attempt; guest identity headers=0'
        $recordJson = $r | ConvertTo-Json -Depth 8
        Result-F52 'F52-KEY-LOCAL' (-not $recordJson.Contains([string]$cfg.mirrorKey)) 'no key in progress/attempt/response JSON or URLs'
    } finally { $receiver.Dispose(); $encrypted.stream.Dispose() }

    # Real frozen reader: the socket backpressures, then the actual counter
    # freezes. N=1s is admitted ONLY for this loopback lab, not production.
    $path = New-F52Sparse -Name 'stall' -Size 8GB
    $receiver = New-Object Ghrdp.MirrorLab.DiscardReceiver(([long]8GB), $true)
    $script:sawStall = $false; $script:etaHidden = $true; $script:sawThree = $false
    $observe = { param($v)
        if ($v.stallWindows -ge 1) { $script:sawStall = $true; if ($null -ne $v.etaSeconds) { $script:etaHidden = $false } }
        if ($v.stallWindows -ge 3) { $script:sawThree = $true }
    }
    try {
        $r = Invoke-F46MirrorAttempt -HostCfg (New-F52LoopHost $receiver) -Path $path -Name 'stall.bin' -Size 8GB -ProgressAction $observe -WorkerMode 'none' -StallWindowSec 1
        Result-F52 'F52-HTTP-STALL' (-not $r.ok -and $r.phase -eq 'http' -and $script:sawStall -and $script:etaHidden -and $script:sawThree -and $r.hostMessage.Contains('last socket/host text:') -and $r.record.retryable -and (Get-F46MaxAttempts -Phase $r.phase -Status $r.httpStatus) -eq 5) ('phase=http; after 3 stall windows; bytesSent=' + [long]$r.bytesSent + '; ETA hidden; F44 budget=5')
    } finally { $receiver.Dispose(); Remove-Item -LiteralPath $path -Force }

    # Advertised cap evidence ONLY. A read-only GET cannot prove acceptance of
    # a 100GB upload, and a 128GiB loopback pass is NOT guest-host cap proof.
    $rows = @(Invoke-F46HostProbe -Hosts @((Get-F46DefaultHost)) -TimeoutSec 8)
    foreach ($row in $rows) {
        $capText = $(if ($null -ne $row.maxFileBytes) { [string]$row.maxFileBytes } else { 'unknown' })
        $tooSmall = $null -ne $row.maxFileBytes -and [long]$row.maxFileBytes -lt 100000000000
        Result-F52 'F52-GUEST-CAP' (-not $tooSmall) ('read-only status=' + $row.status + '; advertised-cap-bytes=' + $capText + '; max-proven=unknown; uploads=0' + $(if ($tooSmall) { '; STOP options: self-hosted target for this size class | accept the cap' } else { '' }))
    }
} finally {
    # Includes local config-free plaintext and ciphertext lab files, no key artifact.
    Remove-Item -LiteralPath $lab -Recurse -Force -ErrorAction SilentlyContinue
}
if ($script:f52Failures -gt 0) { Write-Host ('F52 RESULT=FAIL cells=' + $script:f52Failures); exit 1 }
Write-Host 'F52 RESULT=PASS; transport/window/lanes proven in lab; live guest cap and operator verification pending'
exit 0
