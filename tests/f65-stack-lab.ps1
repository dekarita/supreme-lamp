# [F65 §5] PS LAB - scratch discipline + in-runner concurrency map + rendezvous +
# bundle integrity verifier + telemetry, against the SHIPPED modules (this sandbox
# has no PowerShell interpreter, so the launch-gates windows-native lane runs it).
#
#   A. D:/C: scratch detection: D-probe present -> D path; D-probe missing ->
#      C fallback + ::warning:: (never a silent switch, never a halt)
#   B. Invoke-F65ParallelMap: real concurrency (wall < serial sum), per-leg error
#      isolation, bounded-throttle wave fallback and an empty-input fast path
#   C. Test-F65BundleFiles: every manifest file verified against its sha256; a
#      tampered file is REPORTED (fail-closed), a missing file too
#   D. Get-F65StackState rendezvous: -Wait finds a late state file, a timeout
#      returns $null, Get-F65Component only returns verified components
#   E. telemetry: Add-F65Point writes parseable jsonl lines (>=15 points readable)
#   F. main.yml contract: detached prefetch (no -Wait), consumers rendezvous with
#      a bounded timeout, the report emits the machine-readable count line
$ErrorActionPreference = 'Stop'
$ws = Split-Path -Parent $PSScriptRoot
$fails = 0
$passes = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $verdict = 'FAIL'
    if ($Ok) { $verdict = 'PASS'; $script:passes++ } else {
        $script:fails++
        # a failing cell also becomes a check-run ANNOTATION: the raw job log is not
        # reachable from every loop, the checks API is.
        Write-Host ('::error title=F65 lab::' + $Name + ' :: ' + $Detail)
    }
    $line = '[F65 lab] ' + $verdict + ' ' + $Name
    if ($Detail) { $line = $line + ' :: ' + $Detail }
    Write-Host $line
}
$tmp = Join-Path $env:RUNNER_TEMP ('f65-lab-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# ---- shipped modules under test ---------------------------------------------------
. (Join-Path $ws 'scripts/f65-detect-scratch.ps1')
. (Join-Path $ws 'payloads/f65-telemetry.ps1')
. (Join-Path $ws 'payloads/f65-stack.ps1')

# ---- A. scratch detection ---------------------------------------------------------
$haveD = Join-Path $tmp 'pretend-d'
New-Item -ItemType Directory -Path $haveD -Force | Out-Null
$a1 = Get-F65ScratchRoot -Preferred (Join-Path $haveD 'scratch') -Fallback (Join-Path $tmp 'c-scratch') -DriveProbe $haveD -Quiet
Check 'A1 D-probe present -> preferred root' (($a1.source -eq 'D') -and ($a1.root -like ($haveD + '*'))) ('root=' + $a1.root + ' source=' + $a1.source)
$a2 = Get-F65ScratchRoot -Preferred (Join-Path $haveD 'scratch2') -Fallback (Join-Path $tmp 'c-scratch2') -DriveProbe (Join-Path $tmp 'no-such-drive') -Quiet
Check 'A2 missing D-probe -> C fallback with a warning' (($a2.source -eq 'C-fallback') -and ($a2.warning -like '*not present*')) ('root=' + $a2.root + ' warning=' + $a2.warning)
Check 'A3 fallback root is created on disk' (Test-Path -LiteralPath $a2.root)
Set-F65ScratchEnv -Root $a2.root
Check 'A4 Set-F65ScratchEnv exports GHRDP_F65_SCRATCH' ($env:GHRDP_F65_SCRATCH -eq $a2.root) ('value=' + $env:GHRDP_F65_SCRATCH)

# ---- B. parallel map --------------------------------------------------------------
$env:GHRDP_F65_TIMING = Join-Path $tmp 'f65-telemetry.jsonl'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$res = @(Invoke-F65ParallelMap -Items @(1, 2, 3, 4) -Body { param($item) Start-Sleep -Seconds 3; return @{ item = $item; done = $true } } -ThrottleLimit 4 -Label 'lab-legs' -TimeoutSec 60)
$sw.Stop()
Check 'B1 four legs complete' (($res.Count -eq 4) -and (@($res | Where-Object { $_.ok }).Count -eq 4)) ('ok=' + @($res | Where-Object { $_.ok }).Count + '/' + $res.Count)
Check 'B2 concurrency is real (wall < serial 12s)' ($sw.Elapsed.TotalSeconds -lt 10) ('wall=' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's')
Check 'B3 every leg returned its own result' (@($res | Where-Object { $_.result.done }).Count -eq 4)
$resErr = @(Invoke-F65ParallelMap -Items @('boom', 'fine') -Body { param($item) if ($item -eq 'boom') { throw 'lab-boom' }; return 'ok' } -ThrottleLimit 2 -Label 'lab-errors' -TimeoutSec 30)
Check 'B4 a throwing leg is isolated + reported' ((@($resErr | Where-Object { -not $_.ok }).Count -eq 1) -and (@($resErr | Where-Object { $_.ok }).Count -eq 1)) ('errors=' + @($resErr | Where-Object { -not $_.ok }).Count)
Check 'B5 empty input returns an empty array' ((@(Invoke-F65ParallelMap -Items @() -Body { param($item) $item } -Label 'lab-empty')).Count -eq 0)

# ---- C. bundle integrity verifier -------------------------------------------------
$bd = Join-Path $tmp 'bundle'
New-Item -ItemType Directory -Path (Join-Path $bd 'stack'), (Join-Path $bd 'personalization') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $bd 'stack/a.bin'), 'alpha')
[System.IO.File]::WriteAllText((Join-Path $bd 'stack/b.bin'), 'beta')
[System.IO.File]::WriteAllText((Join-Path $bd 'personalization/p.json'), '{"v":1}')
function Get-Sha([string]$P) { return (Get-FileHash -LiteralPath $P -Algorithm SHA256).Hash.ToLowerInvariant() }
$manifest = @{ schema = 'ghrdp-f65-stack-bundle/1'; files = @{} }
foreach ($rel in @('stack/a.bin', 'stack/b.bin', 'personalization/p.json')) {
    $manifest.files[$rel] = @{ sha256 = (Get-Sha (Join-Path $bd $rel)); size = (Get-Item (Join-Path $bd $rel)).Length }
}
$mp = Join-Path $bd 'manifest.json'
[System.IO.File]::WriteAllText($mp, ($manifest | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
$c1 = Test-F65BundleFiles -ExtractDir $bd -ManifestPath $mp
Check 'C1 every manifest file verifies' ($c1.ok -and $c1.checked -eq 3 -and $c1.bad.Count -eq 0) ('checked=' + $c1.checked)
[System.IO.File]::WriteAllText((Join-Path $bd 'stack/b.bin'), 'BETA-TAMPERED')
$c2 = Test-F65BundleFiles -ExtractDir $bd -ManifestPath $mp
Check 'C2 a tampered file is reported fail-closed' ((-not $c2.ok) -and ($c2.bad -contains 'stack/b.bin')) ('bad=' + ($c2.bad -join ','))
Remove-Item -LiteralPath (Join-Path $bd 'stack/b.bin') -Force
$c3 = Test-F65BundleFiles -ExtractDir $bd -ManifestPath $mp
Check 'C3 a missing file is reported fail-closed' ((-not $c3.ok) -and ($c3.missing -contains 'stack/b.bin')) ('missing=' + ($c3.missing -join ','))

# ---- D. rendezvous ----------------------------------------------------------------
$statePath = Get-F65StateFile -Scratch $tmp   # <scratch>\stack-state.json - exactly what the producer writes
$job = Start-Job -ArgumentList $statePath -ScriptBlock {
    Start-Sleep -Seconds 3
    $s = @{ schema = 'ghrdp-f65-stack-state/1'; status = 'ready'; reason = ''; components = @{ idd_sample_driver = @{ path = 'C:\nope\IddSampleDriver.zip'; sha256 = 'e93b88f31ce3201814cba1fb4e11eb43e6f991f4d2a5e33145728a8dbfdd4eb7'; ok = $true } } }
    [System.IO.File]::WriteAllText($args[0], ($s | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$d1 = Get-F65StackState -Scratch $tmp -Wait -TimeoutSec 30
$sw.Stop()
Check 'D1 -Wait rendezvous picks up a late state file' ($null -ne $d1 -and [string]$d1.status -eq 'ready') ('waited=' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's')
$job | Remove-Job -Force -ErrorAction SilentlyContinue
Check 'D2 Get-F65Component refuses a missing path' ($null -eq (Get-F65Component -State $d1 -Name 'idd_sample_driver'))
$d2 = Get-F65StackState -Scratch (Join-Path $tmp 'empty-scratch') -Wait -TimeoutSec 3
Check 'D3 a timeout returns $null (bounded rendezvous)' ($null -eq $d2)
$readyFile = Join-Path $tmp 'stack-real.bin'
[System.IO.File]::WriteAllText($readyFile, 'real')
$st2 = @{ schema = 'ghrdp-f65-stack-state/1'; status = 'ready'; components = @{ vbcable = @{ path = $readyFile; sha256 = (Get-Sha $readyFile); ok = $true } } }
[System.IO.File]::WriteAllText($statePath, ($st2 | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
$d3 = Get-F65StackState -Scratch $tmp
$comp = Get-F65Component -State $d3 -Name 'vbcable'
Check 'D4 Get-F65Component returns a verified component' ($null -ne $comp -and $comp.path -eq $readyFile)

# ---- E. telemetry -----------------------------------------------------------------
for ($i = 1; $i -le 18; $i++) { Add-F65Point -Name ('lab-point-' + $i) -Seconds $i -Detail 'lab' }
$lines = @(Get-Content -LiteralPath $env:GHRDP_F65_TIMING)
$parsed = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
$points = @(Get-F65Points -Path $env:GHRDP_F65_TIMING)
Check 'E1 telemetry jsonl parses line-by-line' (($lines.Count -ge 18) -and ($parsed.Count -eq $lines.Count)) ('lines=' + $lines.Count)
Check 'E2 Get-F65Points returns >=15 records with point+sec' (($points.Count -ge 15) -and (@($points | Where-Object { $_.point -and ($null -ne $_.sec) }).Count -eq $points.Count)) ('points=' + $points.Count)
$badLine = Join-Path $tmp 'f65-bad.jsonl'
[System.IO.File]::WriteAllText($badLine, '{not-json}' + "`n", (New-Object System.Text.UTF8Encoding($false)))
Check 'E3 a malformed line is skipped, not fatal' ((@(Get-F65Points -Path $badLine)).Count -eq 0)

# ---- F. main.yml contract ---------------------------------------------------------
$wf = Get-Content -LiteralPath (Join-Path $ws '.github/workflows/main.yml') -Raw
$f1 = $wf.Contains('f65-prefetch.ps1')
$f2 = $wf.Contains('Start-Process -FilePath $pwshPath -PassThru -WindowStyle Hidden')
$f3 = $wf.Contains('Get-F65StackState -Scratch $env:GHRDP_F65_SCRATCH -Wait -TimeoutSec')
$f4 = $wf.Contains('[F65-TELEMETRY-COUNT] points=')
$f5 = $wf.Contains('F65 rendezvous + parallel health probes (60s cap, non-fatal)')
$launchIdx = $wf.IndexOf('$preScript = Join-Path')
$launchChunk = ''
if ($launchIdx -ge 0) { $launchChunk = $wf.Substring($launchIdx, [math]::Min(900, $wf.Length - $launchIdx)) }
$f6 = -not $launchChunk.Contains('-Wait')
Check 'F1 main.yml launches the producer script' $f1
Check 'F2 the launch is detached (-PassThru, no -Wait in the block)' ($f2 -and $f6)
Check 'F3 consumers rendezvous with a bounded timeout' $f3
Check 'F4 the report step emits the machine-readable count' $f4
Check 'F5 the parallel probe step ships' $f5

Write-Host ('[F65 lab] ' + $passes + ' PASS / ' + $fails + ' FAIL')
if ($fails -gt 0) { exit 1 }
exit 0
