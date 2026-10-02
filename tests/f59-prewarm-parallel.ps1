# [F59 §4] PS LAB - parallel pre-warm readiness + fail-closed prebuilt verification.
#
# Runs in the launch-gates windows-native lane (this sandbox has no PowerShell
# interpreter). It exercises the SHIPPED modules - payloads/f59-timing.ps1 and
# payloads/f59-prebuilt-verify.ps1 - not copies:
#   A. parallel Wait-Job readiness (3 concurrent legs; wall time < the serial sum)
#   B. SHA-256 fail-closed cells: correct pin, wrong pin, empty pin, checksums.txt
#      disagreement, missing file (every failure MUST throw)
#   C. startup-timing.jsonl lines parse (step + sec) and stay append-only
#   D. the main.yml structural contract for the prebuilt lane (no Chocolatey,
#      Start-Job/Wait-Job, the timing artifact, the flipped defaults)
$ErrorActionPreference = 'Stop'
$ws = Split-Path -Parent $PSScriptRoot
$fails = 0
$passes = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $verdict = 'FAIL'
    if ($Ok) { $verdict = 'PASS'; $script:passes++ } else { $script:fails++ }
    $line = '[F59 lab] ' + $verdict + ' ' + $Name
    if ($Detail) { $line = $line + ' :: ' + $Detail }
    Write-Host $line
}
$tmp = Join-Path $env:RUNNER_TEMP ('f59-lab-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# ---- shipped modules under test -------------------------------------------------
. (Join-Path $ws 'payloads/f59-prebuilt-verify.ps1')
. (Join-Path $ws 'payloads/f59-timing.ps1')
$env:GHRDP_F59_TIMING = Join-Path $tmp 'startup-timing.jsonl'

# ---- A. parallel pre-warm readiness (Wait-Job before the gate) ------------------
$swWall = [System.Diagnostics.Stopwatch]::StartNew()
$jobs = @()
foreach ($leg in @('tailscale-msi', 'prebuilt-binaries', 'ps-parse')) {
    $jobs += Start-Job -ArgumentList $leg -ScriptBlock {
        Start-Sleep -Seconds 3
        return @{ leg = $args[0]; ready = $true }
    }
}
$null = Wait-Job -Job $jobs -Timeout 60
$states = @($jobs | ForEach-Object { $_.State })
$results = @($jobs | Receive-Job -Wait)
$swWall.Stop()
$allReady = (@($results | Where-Object { $_.ready }).Count -eq 3)
Check 'A1 three legs complete before the gate' (($states | Where-Object { $_ -ne 'Completed' }).Count -eq 0) ('states=' + ($states -join ','))
Check 'A2 every leg reports ready' $allReady ('ready=' + @($results | Where-Object { $_.ready }).Count)
Check 'A3 concurrency is real (wall < serial sum 9s)' ($swWall.Elapsed.TotalSeconds -lt 9) ('wall=' + [math]::Round($swWall.Elapsed.TotalSeconds, 1) + 's')
$jobs | Remove-Job -Force -ErrorAction SilentlyContinue

# ---- B. fail-closed asset verification -----------------------------------------
$asset = Join-Path $tmp 'aria2c-1.36.0-win-x64.exe'
[System.IO.File]::WriteAllBytes($asset, [byte[]](1..64))
$good = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
$ck = Join-Path $tmp 'checksums.txt'
[System.IO.File]::WriteAllText($ck, ($good + '  aria2c-1.36.0-win-x64.exe' + "`n"), (New-Object System.Text.UTF8Encoding($false)))

$b1 = $false
try { $null = Test-F59AssetSha256 -Path $asset -Expected $good -Label 'fixture'; $b1 = $true } catch { }
Check 'B1 correct pin verifies' $b1 ('sha256=' + $good)

$b2 = $false
try { $null = Test-F59AssetSha256 -Path $asset -Expected ('0' * 64) -Label 'fixture'; } catch { $b2 = ($_.Exception.Message -match 'SHA-256 MISMATCH') }
Check 'B2 wrong pin THROWS (fail-closed)' $b2

$b3 = $false
try { $null = Test-F59AssetSha256 -Path $asset -Expected '' -Label 'fixture'; } catch { $b3 = ($_.Exception.Message -match 'EMPTY sha256 pin') }
Check 'B3 empty pin THROWS (bootstrap incomplete)' $b3

$b4 = $false
try { $null = Test-F59AssetSha256 -Path (Join-Path $tmp 'absent.exe') -Expected $good -Label 'absent'; } catch { $b4 = ($_.Exception.Message -match 'missing at') }
Check 'B4 missing asset THROWS' $b4

$b5a = $true
try { $null = Test-F59ChecksumsLine -ChecksumsPath $ck -AssetName 'aria2c-1.36.0-win-x64.exe' -Expected $good } catch { $b5a = $false }
$b5b = $false
try { $null = Test-F59ChecksumsLine -ChecksumsPath $ck -AssetName 'other.exe' -Expected $good } catch { $b5b = ($_.Exception.Message -match 'no line for') }
Check 'B5 checksums.txt good line accepted, missing line THROWS' ($b5a -and $b5b)

$b6 = $false
try { $null = Test-F59ChecksumsLine -ChecksumsPath $ck -AssetName 'aria2c-1.36.0-win-x64.exe' -Expected ('0' * 64); } catch { $b6 = ($_.Exception.Message -match 'disagrees with the committed pin') }
Check 'B6 checksums.txt vs pin disagreement THROWS' $b6

# ---- C. startup-timing.jsonl ---------------------------------------------------
Add-F59Timing -Step 'lab-leg' -Seconds 1.25
$sw = Start-F59Step
Start-Sleep -Milliseconds 50
$null = Stop-F59Step -Step 'lab-stopwatch' -Sw $sw
if (-not (Test-Path -LiteralPath $env:GHRDP_F59_TIMING)) { Check 'C1 timing file written' $false $env:GHRDP_F59_TIMING }
else {
    $lines = @(Get-Content -LiteralPath $env:GHRDP_F59_TIMING | Where-Object { $_.Trim() })
    Check 'C1 timing file written (one JSON line per step)' ($lines.Count -eq 2) ('lines=' + $lines.Count)
    $ok = $true
    foreach ($l in $lines) {
        try { $o = $l | ConvertFrom-Json; if (-not $o.step -or $null -eq $o.sec) { $ok = $false } } catch { $ok = $false }
    }
    Check 'C2 every line parses with step+sec' $ok ('lines=' + ($lines -join ' | '))
    $m = Invoke-F59Measured -Step 'lab-measured' -Body { 40 + 2 }
    Check 'C3 Measure-Command wrapper records + returns' ($m -eq 42 -and (@(Get-Content -LiteralPath $env:GHRDP_F59_TIMING).Count -eq 3)) ('result=' + $m)
}

# ---- D. main.yml structural contract -------------------------------------------
$mainPath = Join-Path $ws '.github/workflows/main.yml'
$main = Get-Content -LiteralPath $mainPath -Raw
Check 'D1 mirror_enable default true' ([regex]::Match($main, 'mirror_enable:[\s\S]{0,600}?default:\s*true').Success)
Check 'D2 mirror_encrypt default false' ([regex]::Match($main, 'mirror_encrypt:[\s\S]{0,600}?default:\s*false').Success)
Check 'D3 search_enable default true' ([regex]::Match($main, 'search_enable:[\s\S]{0,600}?default:\s*true').Success)
Check 'D4 no Chocolatey on the transport lane' (-not ($main -match 'choco install (aria2|qbittorrent)'))
Check 'D5 prebuilt release + pins + fail-closed verify' (($main -match 'prebuilt-binaries') -and ($main -match 'Test-F59AssetSha256') -and ($main -match 'f59-prebuilt-pins\.json'))
Check 'D6 four background legs + Wait-Job' ((([regex]::Matches($main, 'Start-F64BgJob')).Count -ge 4) -and ($main -match 'Wait-Job -Job \$all'))
Check 'D7 startup-timing.jsonl + artifact' (($main -match 'startup-timing\.jsonl') -and ($main -match 'name: startup-timing'))
Check 'D8 dashboard-reachable marker after the prewarm gate' ($main.IndexOf('GHRDP_F59_PREWARM=ready') -lt $main.IndexOf('dashboard-reachable-from-job-start'))
Check 'D9 auto-path encryption floor untouched' (($main -match "if \(\`$Auto\) \{ return 'all' \}") -or ((Get-Content -LiteralPath (Join-Path $ws 'payloads/ghrdp-mirror.ps1') -Raw) -match "if \(\`$Auto\) \{ return 'all' \}"))

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ('[F59 lab] parallel pre-warm + fail-closed verify: ' + $passes + ' PASS, ' + $fails + ' FAIL')
if ($fails -gt 0) { exit 1 }
Write-Host 'F59 prewarm/verify lab PASS'
exit 0
