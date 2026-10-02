# [F65 §1/§2] BACKGROUND PRE-STAGED STACK PREFETCH (the "off critical path" producer).
#
# Launched DETACHED (Start-Process -PassThru, no -Wait) by main.yml right after
# the F59 pre-warm step, so the ~300 MB bundle download overlaps every other
# setup step instead of sitting on the dashboard-reachable path. It resolves the
# stack-bundle release pointer, downloads + SHA-256-verifies the bundle, extracts
# it to <scratch>\stack, verifies EVERY file against the bundle manifest (through
# the F65 parallel map) and writes <scratch>\stack-state.json for the consumer
# rendezvous (Get-F65StackState in payloads/f65-stack.ps1).
#
# FAIL-OPEN FOR THE JOB / FAIL-CLOSED FOR THE BUNDLE: any miss or mismatch marks
# the state `failed` (consumers then take their individual download path, logged
# + counted) - the background process itself never fails the dispatch.
param(
    [string]$Workspace = $env:GITHUB_WORKSPACE,
    [string]$Scratch = '',
    [string]$ReleaseTag = 'stack-bundle',
    [string]$PointerAsset = 'ghrdp-stack-latest.json',
    [int]$TimeoutSec = 1200,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'
# The producer runs DETACHED, after the launching step has already finished: its
# summary lines would land in a closed step's file, so points go to the jsonl
# (read back by the F65 report step) and not to $GITHUB_STEP_SUMMARY.
$env:GITHUB_STEP_SUMMARY = ''
$swAll = [System.Diagnostics.Stopwatch]::StartNew()
. (Join-Path $Workspace 'scripts/f65-detect-scratch.ps1')
. (Join-Path $Workspace 'payloads/f65-telemetry.ps1')
. (Join-Path $Workspace 'payloads/f65-stack.ps1')

if (-not $Scratch) {
    $det = Get-F65ScratchRoot -Quiet
    $Scratch = $det.root
    Set-F65ScratchEnv -Root $Scratch
}
$env:GHRDP_F65_SCRATCH = $Scratch
$stackDir = Join-Path $Scratch 'stack'
$stateFile = Get-F65StateFile -Scratch $Scratch
$tmpDir = Join-Path $Scratch 'stack-download'
New-Item -ItemType Directory -Path $Scratch, $stackDir, $tmpDir -Force -ErrorAction SilentlyContinue | Out-Null
Add-F65Point -Name 'f65-prefetch-start' -Seconds (Get-F65SecondsSinceJobStart) -Detail ('scratch=' + $Scratch + ' mode=background')

function Write-F65State {
    param([string]$Status, [string]$Reason = '', $Components = $null, $Pointer = $null)
    $state = [ordered]@{
        schema      = 'ghrdp-f65-stack-state/1'
        status      = $Status
        reason      = $Reason
        scratch     = $Scratch
        stack_dir   = $stackDir
        mode        = 'bundle'
        fallback    = ($Status -ne 'ready')
        written_at  = (Get-Date).ToUniversalTime().ToString('o')
        elapsed_sec = [math]::Round($swAll.Elapsed.TotalSeconds, 2)
        bundle      = $null
        components  = @{}
    }
    if ($Pointer) {
        $state.bundle = [ordered]@{ asset = [string]$Pointer.asset; sha256 = [string]$Pointer.sha256; size = [int]$Pointer.size; commit = [string]$Pointer.commit }
    }
    if ($Components) { $state.components = $Components }
    try {
        $json = ($state | ConvertTo-Json -Depth 8 -Compress)
        $tmp = $stateFile + '.tmp'
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $stateFile -Force
    } catch { Write-Host ('::warning::[F65 prefetch] could not write state file: ' + $_.Exception.Message) }
}

function Exit-F65Prefetch {
    param([string]$Status, [string]$Reason = '')
    Write-F65State -Status $Status -Reason $Reason
    if ($Status -ne 'ready') {
        Write-Host ('::warning title=F65 bundle fallback::' + $Reason + ' - consumers fall back to individual downloads')
        Add-F65Point -Name 'f65-prefetch-fallback' -Seconds ([math]::Round($swAll.Elapsed.TotalSeconds, 2)) -Detail $Reason
    }
    Add-F65Point -Name ('f65-prefetch-' + $Status) -Seconds ([math]::Round($swAll.Elapsed.TotalSeconds, 2)) -Detail $Reason
    exit 0
}

if ($SelfTest) {
    Write-Host ('[F65 prefetch] self-test: workspace=' + $Workspace + ' scratch=' + $Scratch + ' state=' + $stateFile)
    Write-F65State -Status 'self-test' -Reason 'no download attempted'
    exit 0
}

# ---- 1. pointer asset ------------------------------------------------------------
$sw = Start-F65Point
$pointerPath = Join-Path $tmpDir $PointerAsset
& gh release download $ReleaseTag --repo $env:GITHUB_REPOSITORY --pattern $PointerAsset --dir $tmpDir --clobber 2>$null | Out-Null
$ghCode = $LASTEXITCODE
$LASTEXITCODE = 0
Stop-F65Point -Name 'f65-pointer-fetch' -Sw $sw -Detail ('exit=' + $ghCode + ' file=' + $PointerAsset) | Out-Null
if (-not (Test-Path -LiteralPath $pointerPath)) { Exit-F65Prefetch -Status 'failed' -Reason ('pointer asset ' + $PointerAsset + ' missing from release ' + $ReleaseTag) }
$pointer = $null
try { $pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json } catch { }
if (-not $pointer -or -not $pointer.asset) { Exit-F65Prefetch -Status 'failed' -Reason 'pointer asset unparsable' }
if ([string]$pointer.sha256 -notmatch '^[0-9a-f]{64}$') { Exit-F65Prefetch -Status 'failed' -Reason 'pointer carries no 64-hex sha256 pin (fail-closed)' }

# ---- 2. bundle download ----------------------------------------------------------
$sw = Start-F65Point
$asset = [string]$pointer.asset
$zipPath = Join-Path $tmpDir $asset
& gh release download $ReleaseTag --repo $env:GITHUB_REPOSITORY --pattern $asset --pattern ($asset + '.sha256') --dir $tmpDir --clobber 2>$null | Out-Null
$LASTEXITCODE = 0
$bytes = 0
if (Test-Path -LiteralPath $zipPath) { $bytes = (Get-Item -LiteralPath $zipPath).Length }
Stop-F65Point -Name 'f65-bundle-download' -Sw $sw -Detail ('asset=' + $asset + ' bytes=' + $bytes) | Out-Null
if (-not (Test-Path -LiteralPath $zipPath)) { Exit-F65Prefetch -Status 'failed' -Reason ('bundle asset ' + $asset + ' missing') }
if ($swAll.Elapsed.TotalSeconds -gt $TimeoutSec) { Exit-F65Prefetch -Status 'failed' -Reason ('prefetch exceeded ' + $TimeoutSec + 's') }

# ---- 3. fail-closed sha256 verification (sidecar + pointer must agree) -----------
$sw = Start-F65Point
$observed = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecarOk = $false
$sidecarPath = $zipPath + '.sha256'
if (Test-Path -LiteralPath $sidecarPath) {
    $sidecarText = (Get-Content -LiteralPath $sidecarPath -Raw).Trim()
    $sidecarOk = ($sidecarText -match ('^' + [regex]::Escape($observed) + '\b'))
}
$pointerOk = ($observed -eq ([string]$pointer.sha256).ToLowerInvariant())
Stop-F65Point -Name 'f65-bundle-sha256-verify' -Sw $sw -Detail ('observed=' + $observed.Substring(0, 12) + ' pointerMatch=' + $pointerOk + ' sidecarMatch=' + $sidecarOk) | Out-Null
if (-not $pointerOk) { Exit-F65Prefetch -Status 'failed' -Reason ('bundle sha256 ' + $observed + ' != pointer ' + $pointer.sha256) }
if (-not $sidecarOk) { Exit-F65Prefetch -Status 'failed' -Reason 'bundle .sha256 sidecar missing or disagreeing (refused)' }

# ---- 4. extract ------------------------------------------------------------------
$sw = Start-F65Point
if (Test-Path -LiteralPath $stackDir) { Remove-Item -LiteralPath $stackDir -Recurse -Force -ErrorAction SilentlyContinue }
try { Expand-F65BundleZip -Zip $zipPath -Destination $stackDir | Out-Null } catch { Exit-F65Prefetch -Status 'failed' -Reason ('extract failed: ' + $_.Exception.Message) }
Stop-F65Point -Name 'f65-bundle-extract' -Sw $sw -Detail ('dest=' + $stackDir) | Out-Null

$manifestPath = Join-Path $stackDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Exit-F65Prefetch -Status 'failed' -Reason 'bundle manifest.json missing' }

# ---- 5. verify EVERY file through the parallel map (in-runner concurrency) -------
$sw = Start-F65Point
$manifest = $null
try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { }
if (-not $manifest -or -not $manifest.files) { Exit-F65Prefetch -Status 'failed' -Reason 'bundle manifest unparsable' }
$members = @($manifest.files.PSObject.Properties | ForEach-Object { [string]$_.Name })
$legBody = {
    param($item)
    $rel = [string]$item.member
    $full = Join-Path $item.root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) { return @{ member = $rel; ok = $false; reason = 'missing' } }
    $got = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    $ok = ($got -eq ([string]$item.want).ToLowerInvariant())
    return @{ member = $rel; ok = $ok; reason = $(if ($ok) { 'verified' } else { 'sha256-mismatch' }) }
}
$legs = @()
foreach ($p in @($manifest.files.PSObject.Properties)) { $legs += @{ member = [string]$p.Name; want = [string]$p.Value.sha256; root = $stackDir } }
$verify = Invoke-F65ParallelMap -Items $legs -Body $legBody -ThrottleLimit 4 -Label 'f65-manifest-verify' -TimeoutSec 300
$verified = @($verify | Where-Object { $_.ok -and $_.result.ok }).Count
$badLegs = @($verify | Where-Object { -not ($_.ok -and $_.result.ok) })
Stop-F65Point -Name 'f65-manifest-verify' -Sw $sw -Detail ('files=' + $members.Count + ' verified=' + $verified + ' bad=' + $badLegs.Count + ' map=' + ($verify | Measure-Object).Count) | Out-Null
Add-F65Point -Name 'f65-parallel-legs' -Seconds ([math]::Round($swAll.Elapsed.TotalSeconds, 2)) -Detail ('map=manifest-verify legs=' + $members.Count)
if ($badLegs.Count -gt 0) {
    $who = ($badLegs | ForEach-Object { [string]$_.result.member } | Select-Object -First 5) -join ','
    Exit-F65Prefetch -Status 'failed' -Reason ('bundle file verification failed for: ' + $who)
}

# ---- 6. consumer-visible staging (no final install paths are touched here) -------
$components = [ordered]@{}
foreach ($p in @($manifest.components.PSObject.Properties)) {
    $key = [string]$p.Name
    $member = [string]$p.Value.member
    $full = Join-Path $stackDir ($member -replace '/', '\')
    $ok = Test-Path -LiteralPath $full
    $components[$key] = [ordered]@{
        path    = $full
        member  = $member
        sha256  = [string]$p.Value.sha256
        size    = [int]$p.Value.size
        version = [string]$p.Value.version
        ok      = $ok
    }
}
# extensions staged for the user-facing manual install (policies keep live ids)
try {
    $extDir = 'C:\ghrdp\extensions'
    New-Item -ItemType Directory -Path $extDir -Force -ErrorAction SilentlyContinue | Out-Null
    foreach ($extName in @('ublock_crx', 'ublock_xpi')) {
        $c = Get-F65Component -State ([pscustomobject]@{ components = $components }) -Name $extName
        if ($c) { Copy-Item -LiteralPath $c.path -Destination (Join-Path $extDir ([string]$c.member).Split('/')[-1]) -Force -ErrorAction SilentlyContinue }
    }
    Add-F65Point -Name 'f65-stack-extensions-staged' -Seconds ([math]::Round($swAll.Elapsed.TotalSeconds, 2)) -Detail ('dest=' + $extDir)
} catch { }
# prebuilt WebRTC staged (consumer swap is DEFERRED in this loop - see docs/F65-STACK-BUNDLE.md)
try {
    $wr = Get-F65Component -State ([pscustomobject]@{ components = $components }) -Name 'webrtc'
    if ($wr) {
        $webrtcDir = 'C:\ghrdp\webrtc-prebuilt'
        New-Item -ItemType Directory -Path $webrtcDir -Force -ErrorAction SilentlyContinue | Out-Null
        Copy-Item -LiteralPath $wr.path -Destination (Join-Path $webrtcDir ([string]$wr.member).Split('/')[-1]) -Force -ErrorAction SilentlyContinue
        Add-F65Point -Name 'f65-stack-webrtc-staged' -Seconds ([math]::Round($swAll.Elapsed.TotalSeconds, 2)) -Detail ('dest=' + $webrtcDir + ' (consumer swap deferred)')
    }
} catch { }

Write-F65State -Status 'ready' -Components $components -Pointer $pointer
Add-F65Point -Name 'f65-stack-ready' -Seconds (Get-F65SecondsSinceJobStart) -Detail ('asset=' + $asset + ' bytes=' + $bytes + ' files=' + $members.Count)
Write-Host ('[F65 prefetch] READY ' + $asset + ' -> ' + $stackDir + ' (components=' + $components.Count + ')')
exit 0
