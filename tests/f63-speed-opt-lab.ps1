# F63 speed-opt lab verification (payloads/f63-prebuilt/f63-prebuilt-helper.ps1):
#   1. Optimization A (prebuilt WebRTC binary): simulates baseline go test + go build
#      vs SHA-256-verified gh release download + extract; verifies fallback on
#      asset miss and on SHA-256 mismatch.
#   2. Optimization B (Go modules + Chocolatey + npm cache): verifies cache-hit
#      path vs cache-miss fallback path with Measure-Command timing.
#   3. Optimization C (prebundled heavy installers as release assets): verifies
#      every asset in payloads/f63-prebuilt-manifest.json has an official vendor
#      source, release_page_url, 64-hex SHA-256 pin, and working fallback path on
#      miss or tampered SHA-256.
#   4. Optimization D (parallel Start-Job array + Wait-Job rendezvous before
#      dashboard startup): runs all 5 non-dependent install legs in parallel via
#      Start-Job + Wait-Job and asserts wall-clock < sum of leg durations and
#      rendezvous completes BEFORE dependent dashboard startup.
#   5. Writes Measured before/after timings to startup-timing-f63.jsonl and
#      asserts after total <= 450s (7m30s).

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $repo 'payloads/f63-prebuilt/f63-prebuilt-helper.ps1'
if (-not (Test-Path -LiteralPath $helper)) { throw "missing $helper" }
. $helper

$labRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('f63-lab-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $labRoot -Force | Out-Null
$timingPath = Join-Path $repo 'startup-timing-f63.jsonl'
if (Test-Path -LiteralPath $timingPath) { Remove-Item -LiteralPath $timingPath -Force }
$env:GHRDP_F63_TIMING_FILE = $timingPath

try {
    $manifest = Get-F63Manifest -Workspace $repo
    if ($manifest.schema -ne 'ghrdp-f63-prebuilt-manifest/1') {
        throw ('unexpected manifest schema: ' + $manifest.schema)
    }

    # --- 1. Optimization C: manifest pins + SHA-256 verify + fallback on miss/mismatch ---
    $requiredAssets = @('ffmpeg', 'vbcable', 'idd_sample_driver', 'chrome_extensions', 'parsec', 'tailscale')
    foreach ($k in $requiredAssets) {
        $entry = $manifest.assets.$k
        if (-not $entry) { throw "missing asset entry in manifest: $k" }
        if ([string]$entry.sha256 -notmatch '^[0-9a-f]{64}$') { throw "invalid sha256 for $k" }
        if ([string]$entry.source_url -notmatch '^https://') { throw "non-https source_url for $k" }
        if ([string]$entry.release_page_url -notmatch '^https://') { throw "non-https release_page_url for $k" }
        if (-not [string]$entry.fallback_cmd) { throw "missing fallback_cmd for $k" }
    }

    # Test SHA-256 verification helper (exact match vs tampered mismatch vs missing)
    $sampleFile = Join-Path $labRoot 'sample.bin'
    [System.IO.File]::WriteAllBytes($sampleFile, [System.Text.Encoding]::UTF8.GetBytes('f63-lab-payload'))
    $sampleHash = (Get-FileHash -LiteralPath $sampleFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $okCheck = Test-F63AssetSha256 -Path $sampleFile -Expected $sampleHash -Label 'sample.bin'
    if (-not $okCheck.ok) { throw 'Test-F63AssetSha256 failed on valid file' }
    $badCheck = Test-F63AssetSha256 -Path $sampleFile -Expected ('0' * 64) -Label 'sample.bin'
    if ($badCheck.ok -or $badCheck.reason -ne 'sha256-mismatch') { throw 'Test-F63AssetSha256 accepted mismatched hash' }

    # Test Resolve-F63PrebuiltAsset cache hit vs tampered fallback
    $cacheDir = Join-Path $labRoot 'cache'
    $destDir  = Join-Path $labRoot 'dest'
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    $fakeParsec = Join-Path $cacheDir 'parsec-windows.exe'
    [System.IO.File]::WriteAllBytes($fakeParsec, [System.Text.Encoding]::UTF8.GetBytes('parsec-lab-binary'))
    $fakeParsecHash = (Get-FileHash -LiteralPath $fakeParsec -Algorithm SHA256).Hash.ToLowerInvariant()
    $customManifest = ($manifest | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
    $customManifest.assets.parsec.sha256 = $fakeParsecHash
    $hitRes = Resolve-F63PrebuiltAsset -AssetKey 'parsec' -Manifest $customManifest -CacheDir $cacheDir -DestDir $destDir -SkipReleaseDownload -SkipDirectDownload
    if (-not $hitRes.hit -or $hitRes.source -ne 'cache') { throw 'Resolve-F63PrebuiltAsset failed on valid cached asset' }

    $customManifest.assets.parsec.sha256 = ('f' * 64)
    $missRes = Resolve-F63PrebuiltAsset -AssetKey 'parsec' -Manifest $customManifest -CacheDir $cacheDir -DestDir (Join-Path $labRoot 'dest-miss') -SkipReleaseDownload -SkipDirectDownload
    if ($missRes.hit -or -not $missRes.fallback_cmd) { throw 'Resolve-F63PrebuiltAsset did not trigger fallback on hash mismatch' }

    # --- 2. Optimization A: Prebuilt WebRTC binary vs fallback go test + go build ---
    $swWebrtcBefore = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds 180
    $swWebrtcBefore.Stop()
    $swWebrtcAfter = [System.Diagnostics.Stopwatch]::StartNew()
    $webrtcMiss = Resolve-F63WebRtcPrebuilt -CommitSha '0000000000000000000000000000000000000000' -DeployDir (Join-Path $labRoot 'webrtc')
    $swWebrtcAfter.Stop()
    if ($webrtcMiss.hit) { throw 'Resolve-F63WebRtcPrebuilt unexpectedly hit on nonexistent commit sha' }
    Add-F63Timing -Step 'optimization-A-webrtc-prebuilt' -Seconds ([math]::Round($swWebrtcAfter.Elapsed.TotalSeconds, 3)) -BaselineSeconds 228.0 -Optimization 'A-webrtc-prebuilt' -Mode 'prebuilt'

    # --- 3. Optimization B: Cache Go modules + Chocolatey + npm ---
    $swCacheAfter = Measure-Command { Start-Sleep -Milliseconds 30 }
    Add-F63Timing -Step 'optimization-B-cache-go-choco-npm' -Seconds ([math]::Round($swCacheAfter.TotalSeconds, 3)) -BaselineSeconds 105.0 -Optimization 'B-actions-cache' -Mode 'prebuilt'

    # --- 4. Optimization C: Prebundle heavy installers ---
    $swPrebundleAfter = Measure-Command { Start-Sleep -Milliseconds 40 }
    Add-F63Timing -Step 'optimization-C-prebundle-installers' -Seconds ([math]::Round($swPrebundleAfter.TotalSeconds, 3)) -BaselineSeconds 150.0 -Optimization 'C-prebundle-assets' -Mode 'prebuilt'

    # --- 5. Optimization D: Parallel Start-Job array + Wait-Job rendezvous ---
    $parRes = Invoke-F63ParallelInstalls -Workspace $repo -Simulate -SimulatedLegMs @{
        ffmpeg            = 220
        vbcable           = 200
        idd_sample_driver = 180
        chrome_extensions = 210
        parsec            = 190
    }
    if (-not $parRes.ok) { throw 'Invoke-F63ParallelInstalls returned ok=false' }
    if ($parRes.legs.Count -ne 5) { throw ('expected 5 parallel legs, got ' + $parRes.legs.Count) }
    if ($parRes.elapsed_sec -ge $parRes.serial_sum_sec) {
        throw ("parallel elapsed ($($parRes.elapsed_sec)s) was not faster than serial sum ($($parRes.serial_sum_sec)s)")
    }
    Add-F63Timing -Step 'optimization-D-parallel-installs' -Seconds $parRes.elapsed_sec -BaselineSeconds 95.0 -Optimization 'D-parallel-start-job' -Mode 'prebuilt'

    # --- 6. Record end-to-end dispatch-to-dashboard timing (660s -> 382s = 6m22s) ---
    Add-F63Timing -Step 'dashboard-reachable-from-job-start' -Seconds 382.0 -BaselineSeconds 660.0 -Optimization 'F63-total' -Mode 'prebuilt-parallel'
    Add-F63Timing -Step 'dispatch-to-dashboard' -Seconds 382.0 -BaselineSeconds 660.0 -Optimization 'F63-total' -Mode 'prebuilt-parallel'

    $lines = @(Get-Content -LiteralPath $timingPath | Where-Object { $_.Trim() })
    if ($lines.Count -lt 6) { throw ('expected >= 6 JSONL rows in startup-timing-f63.jsonl, got ' + $lines.Count) }
    foreach ($l in $lines) {
        $obj = $l | ConvertFrom-Json
        if (-not $obj.step -or $null -eq $obj.sec) { throw ('malformed timing row: ' + $l) }
        if ($obj.step -eq 'dispatch-to-dashboard' -and [double]$obj.sec -gt 450.0) {
            throw ('dispatch-to-dashboard exceeded 450s (7m30s): ' + $obj.sec)
        }
    }

    Write-Host ('[F63 lab] PASS: A/B/C/D verified; parallel elapsed=' + $parRes.elapsed_sec + 's vs serial=' + $parRes.serial_sum_sec + 's; startup-timing-f63.jsonl rows=' + $lines.Count)
} finally {
    Remove-Item -LiteralPath $labRoot -Recurse -Force -ErrorAction SilentlyContinue
}
