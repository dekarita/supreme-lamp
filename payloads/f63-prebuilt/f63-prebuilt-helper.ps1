# [F63] SPEED-OPT helper module: prebuilt WebRTC (A), caches (B), prebundled
# heavy installers with SHA-256 verification + fallback (C), parallel Start-Job /
# Wait-Job rendezvous before dashboard startup (D), and Measure-Command timing to
# startup-timing-f63.jsonl (§2/§3).
#
# Dependency order preserved and documented:
#   - Independent installs (parallelized in Invoke-F63ParallelInstalls via Start-Job
#     + Wait-Job BEFORE dashboard startup):
#       [1] FFmpeg (ffmpeg-release-full.zip -> C:\ghrdp\bin\ffmpeg.exe)
#       [2] VB-CABLE driver (VBCABLE_Driver_Pack43.zip -> C:\ghrdp\vbcable)
#       [3] Virtual display driver (IddSampleDriver.zip -> C:\ghrdp\idd + pnputil)
#       [4] Chrome extensions (.crx bundle -> C:\ghrdp\extensions)
#       [5] Parsec installer extract (parsec-windows.exe -> C:\ghrdp\parsec)
#   - Dependent chains (strictly sequential after Wait-Job rendezvous):
#       * Tailscale MSI -> Tailscale up -> MagicDNS FQDN -> LE cert bind -> CredSSP/TLS
#       * RDP user creation -> config.json stage -> F17 listener probe -> F24 SAM proof -> webdesk
#       * Wait-Job(parallel installs) -> Start Mission Control dashboard EARLY (7331) -> Rust WS (7332)
#       * FFmpeg + WebRTC binary ready -> deploy-bootstrap.ps1 -> Stamp guard -> 30s acceptance probe

function Get-F63TimingFile {
    if ($env:GHRDP_F63_TIMING_FILE) { return [string]$env:GHRDP_F63_TIMING_FILE }
    if ($env:GHRDP_F63_TIMING) { return [string]$env:GHRDP_F63_TIMING }
    return 'C:\ghrdp\startup-timing-f63.jsonl'
}

function Add-F63Timing {
    param(
        [string]$Step,
        [double]$Seconds,
        [double]$BaselineSeconds = 0.0,
        [string]$Optimization = 'F63',
        [string]$Mode = 'prebuilt'
    )
    if (-not $Step) { return }
    try {
        $file = Get-F63TimingFile
        $dir = Split-Path -Parent $file
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $rec = [ordered]@{
            step         = [string]$Step
            sec          = [math]::Round([double]$Seconds, 2)
            baseline_sec = [math]::Round([double]$BaselineSeconds, 2)
            optimization = [string]$Optimization
            mode         = [string]$Mode
            at           = (Get-Date).ToUniversalTime().ToString('o')
        }
        Add-Content -LiteralPath $file -Value (($rec | ConvertTo-Json -Compress)) -Encoding utf8
    } catch { }
    try {
        if (Get-Command Add-F59Timing -ErrorAction SilentlyContinue) {
            Add-F59Timing -Step $Step -Seconds $Seconds
        }
    } catch { }
}

function Invoke-F63Measured {
    param(
        [string]$Step,
        [string]$Optimization = 'F63',
        [string]$Mode = 'prebuilt',
        [scriptblock]$ScriptBlock
    )
    $result = $null
    $sec = (Measure-Command { $result = & $ScriptBlock }).TotalSeconds
    Add-F63Timing -Step $Step -Seconds $sec -Optimization $Optimization -Mode $Mode
    Write-Host ('[F63 timing] ' + $Step + ' (' + $Optimization + '/' + $Mode + ') = ' + ([math]::Round($sec, 2)) + 's (Measure-Command)')
    return $result
}

function Get-F63Manifest {
    param([string]$Workspace = '')
    $ws = $Workspace
    if (-not $ws) { $ws = [string]$env:GITHUB_WORKSPACE }
    if (-not $ws) { $ws = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }
    foreach ($rel in @('payloads/f63-prebuilt-manifest.json', 'payloads/f63-prebuilt/manifest.json')) {
        $cand = Join-Path $ws $rel
        if (Test-Path -LiteralPath $cand) {
            return (Get-Content -LiteralPath $cand -Raw | ConvertFrom-Json)
        }
    }
    throw ('[F63] manifest missing under ' + $ws)
}

function Test-F63AssetSha256 {
    # Verifies $Path against $Expected 64-hex SHA-256 pin.
    # Per §4: on asset miss or sha256 mismatch, emits ::warning:: annotation and
    # returns ok=$false, fallback=$true so the caller executes its fallback path.
    param(
        [string]$Path,
        [string]$Expected,
        [string]$Label = 'asset'
    )
    $pin = ''
    if ($Expected) { $pin = $Expected.Trim().ToLowerInvariant() }
    if ($pin -notmatch '^[0-9a-f]{64}$') {
        Write-Host ('::warning title=F63 prebuilt fallback::' + $Label + ' has invalid/empty sha256 pin (' + $pin + ') - falling back to original install path')
        return @{ ok = $false; sha256 = ''; expected = $pin; reason = 'invalid-pin'; fallback = $true }
    }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
        Write-Host ('::warning title=F63 prebuilt fallback::' + $Label + ' missing at ' + $Path + ' - falling back to original install path')
        return @{ ok = $false; sha256 = ''; expected = $pin; reason = 'asset-miss'; fallback = $true }
    }
    $obs = ''
    try {
        $obs = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
        Write-Host ('::warning title=F63 prebuilt fallback::' + $Label + ' hash error (' + $_.Exception.Message + ') - falling back to original install path')
        return @{ ok = $false; sha256 = ''; expected = $pin; reason = 'hash-error'; fallback = $true }
    }
    if ($obs -ne $pin) {
        Write-Host ('::warning title=F63 prebuilt fallback::' + $Label + ' sha256 mismatch (observed=' + $obs + ' expected=' + $pin + ') - falling back to original install path')
        return @{ ok = $false; sha256 = $obs; expected = $pin; reason = 'sha256-mismatch'; fallback = $true }
    }
    Write-Host ('[F63 prebuilt] verified ' + $Label + ' sha256=' + $obs)
    return @{ ok = $true; sha256 = $obs; expected = $pin; reason = 'verified'; fallback = $false }
}

function Resolve-F63PrebuiltAsset {
    # Resolves an asset from payloads/f63-prebuilt-manifest.json:
    #   1) Local prebuilt cache ($CacheDir\<name>)
    #   2) Repo release asset ($manifest.release_tag via gh release download)
    #   3) Pinned official vendor source_url (curl.exe)
    # Verifies SHA-256 at every stage. On miss or sha256 mismatch, returns
    # hit=$false, fallback=$true, fallback_cmd=<cmd> so the caller runs its fallback.
    param(
        [string]$AssetKey,
        [object]$Manifest = $null,
        [string]$Workspace = '',
        [string]$CacheDir = 'C:\ghrdp\prebuilt\f63',
        [string]$DestDir = '',
        [switch]$SkipReleaseDownload,
        [switch]$SkipDirectDownload
    )
    $manifest = $Manifest
    if (-not $manifest) { $manifest = Get-F63Manifest -Workspace $Workspace }
    $entry = $manifest.assets.$AssetKey
    if (-not $entry) {
        Write-Host ('::warning title=F63 prebuilt fallback::unknown asset key ' + $AssetKey + ' - falling back')
        return @{ hit = $false; path = ''; reason = 'unknown-asset'; fallback = $true; fallback_cmd = '' }
    }
    $name = [string]$entry.name
    $pin  = [string]$entry.sha256
    $url  = [string]$entry.source_url
    $fb   = [string]$(if ($entry.fallback_cmd) { $entry.fallback_cmd } else { $entry.fallback })
    $tag  = [string]$manifest.release_tag
    New-Item -ItemType Directory -Path $CacheDir -Force -ErrorAction SilentlyContinue | Out-Null
    if ($DestDir) { New-Item -ItemType Directory -Path $DestDir -Force -ErrorAction SilentlyContinue | Out-Null }
    $cachedPath = Join-Path $CacheDir $name

    # Stage 1: Check actions/cache restored file
    if (Test-Path -LiteralPath $cachedPath) {
        $chk1 = Test-F63AssetSha256 -Path $cachedPath -Expected $pin -Label ($AssetKey + '/' + $name + ' (cache)')
        if ($chk1.ok) {
            return @{ hit = $true; path = $cachedPath; source = 'cache'; reason = 'cache-verified'; fallback = $false; fallback_cmd = $fb; entry = $entry }
        }
        Remove-Item -LiteralPath $cachedPath -Force -ErrorAction SilentlyContinue
    }

    # Stage 2: Check GitHub release asset (f63-prebuilt tag)
    if (-not $SkipReleaseDownload -and (Get-Command gh -ErrorAction SilentlyContinue)) {
        try {
            & gh release download $tag --pattern $name --dir $CacheDir --clobber 2>$null | Out-Null
            $LASTEXITCODE = 0
        } catch { }
        if (Test-Path -LiteralPath $cachedPath) {
            $chk2 = Test-F63AssetSha256 -Path $cachedPath -Expected $pin -Label ($AssetKey + '/' + $name + ' (release)')
            if ($chk2.ok) {
                return @{ hit = $true; path = $cachedPath; source = 'release'; reason = 'release-verified'; fallback = $false; fallback_cmd = $fb; entry = $entry }
            }
            Remove-Item -LiteralPath $cachedPath -Force -ErrorAction SilentlyContinue
        }
    }

    # Stage 3: Pinned official vendor URL (with SHA-256 verification)
    if (-not $SkipDirectDownload -and $url -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        try {
            & curl.exe -fL --retry 2 --retry-delay 2 --connect-timeout 20 --max-time 180 -o $cachedPath $url 2>$null
            $LASTEXITCODE = 0
        } catch { }
        if (Test-Path -LiteralPath $cachedPath) {
            $chk3 = Test-F63AssetSha256 -Path $cachedPath -Expected $pin -Label ($AssetKey + '/' + $name + ' (vendor)')
            if ($chk3.ok) {
                return @{ hit = $true; path = $cachedPath; source = 'vendor'; reason = 'vendor-verified'; fallback = $false; fallback_cmd = $fb; entry = $entry }
            }
            Remove-Item -LiteralPath $cachedPath -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host ('::warning title=F63 prebuilt fallback::' + $AssetKey + ' (' + $name + ') unavailable or failed sha256 check - using fallback path')
    return @{ hit = $false; path = ''; source = 'none'; reason = 'fallback-triggered'; fallback = $true; fallback_cmd = $fb; entry = $entry }
}

function Resolve-F63WebRtcPrebuilt {
    # Optimization A: Downloads ghrdp-webrtc-<sha>.zip + ghrdp-webrtc-<sha>.zip.sha256
    # from the `webrtc-dist` release (built by .github/workflows/build-webrtc.yml),
    # verifies SHA-256, and extracts webrtc-server.exe + probe.exe + static/* into
    # $DeployDir. On asset miss or SHA-256 mismatch, logs ::warning:: and returns
    # hit=$false so main.yml falls back to `go test` + `go build`.
    param(
        [string]$CommitSha,
        [string]$ReleaseTag = 'webrtc-dist',
        [string]$DeployDir = 'C:\ghrdp\webrtc',
        [string]$TempDir = '',
        [switch]$ForceMiss
    )
    if ($ForceMiss -or -not $CommitSha) {
        Write-Host '::warning title=F63 webrtc fallback::ghrdp-webrtc prebuilt skipped or empty commit sha - falling back to go build'
        return @{ hit = $false; reason = 'forced-miss-or-empty-sha'; fallback = $true }
    }
    $tmp = $TempDir
    if (-not $tmp) { $tmp = $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }) }
    $assetName = ('ghrdp-webrtc-' + $CommitSha + '.zip')
    $shaName   = ($assetName + '.sha256')
    $zipPath   = Join-Path $tmp $assetName
    $shaPath   = Join-Path $tmp $shaName
    Remove-Item -LiteralPath $zipPath, $shaPath -Force -ErrorAction SilentlyContinue

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host '::warning title=F63 webrtc fallback::gh CLI unavailable - falling back to go build'
        return @{ hit = $false; reason = 'gh-unavailable'; fallback = $true }
    }

    try {
        & gh release download $ReleaseTag --pattern $assetName --pattern $shaName --dir $tmp --clobber 2>$null | Out-Null
        $LASTEXITCODE = 0
    } catch { }

    if (-not (Test-Path -LiteralPath $zipPath) -or -not (Test-Path -LiteralPath $shaPath)) {
        Write-Host ('::warning title=F63 webrtc fallback::release asset ' + $assetName + ' not found on ' + $ReleaseTag + ' - falling back to go build')
        return @{ hit = $false; reason = 'asset-miss'; fallback = $true }
    }

    $expectedPin = ''
    try {
        $rawSha = [System.IO.File]::ReadAllText($shaPath).Trim()
        if ($rawSha -match '([0-9a-fA-F]{64})') { $expectedPin = $Matches[1].ToLowerInvariant() }
    } catch { }

    $verify = Test-F63AssetSha256 -Path $zipPath -Expected $expectedPin -Label $assetName
    if (-not $verify.ok) {
        Remove-Item -LiteralPath $zipPath, $shaPath -Force -ErrorAction SilentlyContinue
        return @{ hit = $false; reason = $verify.reason; fallback = $true }
    }

    try {
        New-Item -ItemType Directory -Path $DeployDir -Force -ErrorAction SilentlyContinue | Out-Null
        Expand-Archive -LiteralPath $zipPath -DestinationPath $DeployDir -Force
        $srvExe   = Join-Path $DeployDir 'webrtc-server.exe'
        $probeExe = Join-Path $DeployDir 'probe.exe'
        if (-not (Test-Path -LiteralPath $srvExe) -or -not (Test-Path -LiteralPath $probeExe)) {
            Write-Host '::warning title=F63 webrtc fallback::extracted archive missing webrtc-server.exe or probe.exe - falling back to go build'
            return @{ hit = $false; reason = 'missing-binaries-in-zip'; fallback = $true }
        }
        [System.IO.File]::WriteAllText((Join-Path $DeployDir 'deploy-sha.txt'), ($CommitSha + "`n"), (New-Object System.Text.UTF8Encoding($false)))
        # Optional prebuilt Rust dashboard binary if bundled in zip
        $rustPrebuilt = Join-Path $DeployDir 'ghrdp-dash.exe'
        if ((Test-Path -LiteralPath $rustPrebuilt) -and $env:RUNNER_TEMP) {
            $rustTarget = Join-Path $env:RUNNER_TEMP 'ghrdp-rust\target\release'
            New-Item -ItemType Directory -Path $rustTarget -Force -ErrorAction SilentlyContinue | Out-Null
            Copy-Item -LiteralPath $rustPrebuilt -Destination (Join-Path $rustTarget 'ghrdp-dash.exe') -Force -ErrorAction SilentlyContinue
        }
        Write-Host ('[F63 webrtc] extracted prebuilt webrtc-server.exe + probe.exe to ' + $DeployDir + ' (sha256=' + $verify.sha256 + ')')
        return @{ hit = $true; reason = 'verified-extracted'; sha256 = $verify.sha256; deployDir = $DeployDir; fallback = $false }
    } catch {
        Write-Host ('::warning title=F63 webrtc fallback::extract failed (' + $_.Exception.Message + ') - falling back to go build')
        return @{ hit = $false; reason = 'extract-failed'; fallback = $true }
    }
}

function Invoke-F63ParallelInstalls {
    # Optimization D: Runs the 5 non-dependent heavy install/extract tasks in a
    # parallel PowerShell Start-Job array:
    #   [FFmpeg, VB-CABLE, virtual display driver, Chrome extensions, Parsec installer extract]
    # and Wait-Job's all 5 before dashboard startup.
    # Each job uses Resolve-F63PrebuiltAsset (SHA-256 verified) with automatic
    # fallback to the original install path on asset miss or hash mismatch.
    param(
        [string]$Workspace = '',
        [string]$CacheDir = 'C:\ghrdp\prebuilt\f63',
        [switch]$SimulateOnly,
        [switch]$Simulate,
        [int]$SimulateDelayMs = 250,
        [hashtable]$SimulatedLegMs = @{}
    )
    $ws = $Workspace
    if (-not $ws) { $ws = [string]$env:GITHUB_WORKSPACE }
    if (-not $ws) { $ws = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }
    $helperPath = Join-Path $ws 'payloads/f63-prebuilt/f63-prebuilt-helper.ps1'
    $isSim = ([bool]$SimulateOnly -or [bool]$Simulate)
    $swWall = [System.Diagnostics.Stopwatch]::StartNew()
    $jobs = @()

    $dFfmpeg  = $(if ($SimulatedLegMs.ContainsKey('ffmpeg'))            { [int]$SimulatedLegMs['ffmpeg'] }            else { $SimulateDelayMs })
    $dVbcable = $(if ($SimulatedLegMs.ContainsKey('vbcable'))           { [int]$SimulatedLegMs['vbcable'] }           else { $SimulateDelayMs })
    $dIdd     = $(if ($SimulatedLegMs.ContainsKey('idd_sample_driver')) { [int]$SimulatedLegMs['idd_sample_driver'] } else { $SimulateDelayMs })
    $dExt     = $(if ($SimulatedLegMs.ContainsKey('chrome_extensions')) { [int]$SimulatedLegMs['chrome_extensions'] } else { $SimulateDelayMs })
    $dParsec  = $(if ($SimulatedLegMs.ContainsKey('parsec'))            { [int]$SimulatedLegMs['parsec'] }            else { $SimulateDelayMs })

    # Leg 1: FFmpeg (prebuilt zip -> C:\ghrdp\bin\ffmpeg.exe; fallback -> choco install ffmpeg)
    $jobs += Start-Job -Name ('f63-' + 'ffmpeg') -ArgumentList @($ws, $CacheDir, $isSim, $dFfmpeg, $helperPath) -ScriptBlock {
        $wsArg = $args[0]; $cacheArg = $args[1]; $sim = [bool]$args[2]; $delay = [int]$args[3]; $hlp = $args[4]
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        if ($sim) {
            Start-Sleep -Milliseconds $delay
            $sw.Stop()
            return @{ leg = 'ffmpeg'; ready = $true; mode = 'simulated-prebuilt'; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
        }
        . $hlp
        $binDir = 'C:\ghrdp\bin'
        New-Item -ItemType Directory -Path $binDir -Force -ErrorAction SilentlyContinue | Out-Null
        $ffExe = Join-Path $binDir 'ffmpeg.exe'
        $mode = 'prebuilt'
        $ready = $false
        if ((Test-Path -LiteralPath $ffExe) -or (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) {
            $ready = $true
        } else {
            $res = Resolve-F63PrebuiltAsset -AssetKey 'ffmpeg' -Workspace $wsArg -CacheDir $cacheArg
            if ($res.hit -and $res.path) {
                $extTmp = Join-Path $env:RUNNER_TEMP 'f63-ffmpeg-extract'
                Remove-Item -LiteralPath $extTmp -Force -Recurse -ErrorAction SilentlyContinue
                Expand-Archive -LiteralPath $res.path -DestinationPath $extTmp -Force
                $found = Get-ChildItem -Path $extTmp -Recurse -Filter 'ffmpeg.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($found) {
                    Copy-Item -LiteralPath $found.FullName -Destination $ffExe -Force
                    $ready = $true
                }
                Remove-Item -LiteralPath $extTmp -Force -Recurse -ErrorAction SilentlyContinue
            }
            if (-not $ready) {
                $mode = 'fallback'
                Write-Host '::warning title=F63 ffmpeg fallback::installing ffmpeg via choco install ffmpeg -y --no-progress'
                if (Get-Command choco.exe -ErrorAction SilentlyContinue) {
                    & choco.exe install ffmpeg -y --no-progress 2>&1 | Out-Null
                    $LASTEXITCODE = 0
                    if (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) { $ready = $true }
                }
            }
        }
        $sw.Stop()
        return @{ leg = 'ffmpeg'; ready = $ready; mode = $mode; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
    }

    # Leg 2: VB-CABLE driver (prebuilt VBCABLE_Driver_Pack43.zip; fallback -> direct curl VBCABLE_Setup_x64.exe)
    $jobs += Start-Job -Name ('f63-' + 'vbcable') -ArgumentList @($ws, $CacheDir, $isSim, $dVbcable, $helperPath) -ScriptBlock {
        $wsArg = $args[0]; $cacheArg = $args[1]; $sim = [bool]$args[2]; $delay = [int]$args[3]; $hlp = $args[4]
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        if ($sim) {
            Start-Sleep -Milliseconds $delay
            $sw.Stop()
            return @{ leg = 'vbcable'; ready = $true; mode = 'simulated-prebuilt'; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
        }
        . $hlp
        $vbDir = 'C:\ghrdp\vbcable'
        New-Item -ItemType Directory -Path $vbDir -Force -ErrorAction SilentlyContinue | Out-Null
        $res = Resolve-F63PrebuiltAsset -AssetKey 'vbcable' -Workspace $wsArg -CacheDir $cacheArg
        $mode = 'prebuilt'
        $ready = $false
        if ($res.hit -and $res.path) {
            try {
                Expand-Archive -LiteralPath $res.path -DestinationPath $vbDir -Force
                $setup = Get-ChildItem -Path $vbDir -Recurse -Filter 'VBCABLE_Setup_x64.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($setup) {
                    Start-Process -FilePath $setup.FullName -ArgumentList '/S', '/D' -WindowStyle Hidden
                    $ready = $true
                }
            } catch { }
        }
        if (-not $ready) {
            $mode = 'fallback'
            Write-Host '::warning title=F63 vbcable fallback::downloading VBCABLE_Setup_x64.exe from official VB-Audio fallback URL'
            try {
                $vcPath = Join-Path $vbDir 'VBCABLE_Setup_x64.exe'
                & curl.exe -fL --retry 2 --connect-timeout 15 --max-time 120 -o $vcPath 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Setup_x64.exe' 2>$null
                $LASTEXITCODE = 0
                if ((Test-Path -LiteralPath $vcPath) -and ((Get-Item -LiteralPath $vcPath).Length -gt 500000)) {
                    Start-Process -FilePath $vcPath -ArgumentList '/S', '/D' -WindowStyle Hidden
                    $ready = $true
                }
            } catch { }
        }
        $sw.Stop()
        return @{ leg = 'vbcable'; ready = $ready; mode = $mode; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
    }

    # Leg 3: Virtual display driver (prebuilt IddSampleDriver.zip; fallback -> direct curl + pnputil)
    $jobs += Start-Job -Name ('f63-' + 'idd_sample_driver') -ArgumentList @($ws, $CacheDir, $isSim, $dIdd, $helperPath) -ScriptBlock {
        $wsArg = $args[0]; $cacheArg = $args[1]; $sim = [bool]$args[2]; $delay = [int]$args[3]; $hlp = $args[4]
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        if ($sim) {
            Start-Sleep -Milliseconds $delay
            $sw.Stop()
            return @{ leg = 'idd_sample_driver'; ready = $true; mode = 'simulated-prebuilt'; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
        }
        . $hlp
        $dst = 'C:\ghrdp\idd'
        New-Item -ItemType Directory -Path $dst -Force -ErrorAction SilentlyContinue | Out-Null
        $res = Resolve-F63PrebuiltAsset -AssetKey 'idd_sample_driver' -Workspace $wsArg -CacheDir $cacheArg
        $mode = 'prebuilt'
        $ready = $false
        $zipToUse = ''
        if ($res.hit -and $res.path) {
            $zipToUse = $res.path
        } else {
            $mode = 'fallback'
            Write-Host '::warning title=F63 idd fallback::downloading IddSampleDriver.zip via fallback URL'
            $dlZip = Join-Path $env:RUNNER_TEMP 'idd-fallback.zip'
            & curl.exe -fL --retry 2 --connect-timeout 15 --max-time 120 -o $dlZip 'https://github.com/ge9/IddSampleDriver/releases/download/0.0.1.4/IddSampleDriver.zip' 2>$null
            $LASTEXITCODE = 0
            if (Test-Path -LiteralPath $dlZip) {
                $chk = Test-F63AssetSha256 -Path $dlZip -Expected 'e93b88f31ce3201814cba1fb4e11eb43e6f991f4d2a5e33145728a8dbfdd4eb7' -Label 'IddSampleDriver.zip'
                if ($chk.ok) { $zipToUse = $dlZip }
            }
        }
        if ($zipToUse -and (Test-Path -LiteralPath $zipToUse)) {
            try {
                Expand-Archive -LiteralPath $zipToUse -DestinationPath $dst -Force
                $inf = Get-ChildItem -Path $dst -Recurse -Filter '*.inf' -File -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($inf) {
                    & pnputil.exe /add-driver $inf.FullName /install 2>$null | Out-Null
                    $LASTEXITCODE = 0
                    $ready = $true
                }
            } catch { }
        }
        $sw.Stop()
        return @{ leg = 'idd_sample_driver'; ready = $ready; mode = $mode; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
    }

    # Leg 4: Chrome extensions (.crx bundle + parallel store ID pre-resolution)
    $jobs += Start-Job -Name ('f63-' + 'chrome_extensions') -ArgumentList @($ws, $CacheDir, $isSim, $dExt, $helperPath) -ScriptBlock {
        $wsArg = $args[0]; $cacheArg = $args[1]; $sim = [bool]$args[2]; $delay = [int]$args[3]; $hlp = $args[4]
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        if ($sim) {
            Start-Sleep -Milliseconds $delay
            $sw.Stop()
            return @{ leg = 'chrome_extensions'; ready = $true; mode = 'simulated-prebuilt'; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
        }
        . $hlp
        $res = Resolve-F63PrebuiltAsset -AssetKey 'chrome_extensions' -Workspace $wsArg -CacheDir $cacheArg
        $extDir = 'C:\ghrdp\extensions'
        New-Item -ItemType Directory -Path $extDir -Force -ErrorAction SilentlyContinue | Out-Null
        $mode = 'fallback'
        $ready = $false
        if ($res.hit -and $res.path) {
            Copy-Item -LiteralPath $res.path -Destination (Join-Path $extDir 'chrome-extensions-bundle.crx') -Force -ErrorAction SilentlyContinue
            $ready = $true
            $mode = 'prebuilt'
        }
        # Pre-warm live extension resolution in parallel so Machine personalization
        # does not block sequentially on 6 store HTTP round-trips.
        try {
            $resolverPath = Join-Path $wsArg 'payloads\edge-ext-resolve.ps1'
            if (Test-Path -LiteralPath $resolverPath) {
                . $resolverPath
                $uboEdge = Resolve-StoreExtId -Query 'uBlock Origin' -Slug 'ublock-origin' -Markers @('gorhill', 'uBlock Origin') -VendorPages @('https://raw.githubusercontent.com/gorhill/uBlock/master/README.md')
                $drEdge  = Resolve-StoreExtId -Query 'Dark Reader' -Slug 'dark-reader' -Markers @('darkreader.org', 'Dark Reader') -VendorPages @('https://raw.githubusercontent.com/darkreader/darkreader/main/README.md')
                $uboCws  = Resolve-StoreExtId -Store 'cws' -Query 'uBlock Origin' -Slug 'ublock-origin' -Markers @('uBlock Origin', 'gorhill')
                $drCws   = Resolve-StoreExtId -Store 'cws' -Query 'Dark Reader' -Slug 'dark-reader' -Markers @('Dark Reader', 'darkreader.org')
                $uboAmo  = Resolve-AmoAddon -Slug 'ublock-origin' -Markers @('uBlock Origin', 'gorhill', 'Raymond Hill')
                $drAmo   = Resolve-AmoAddon -Slug 'darkreader' -Markers @('Dark Reader', 'darkreader')
                $cacheObj = @{
                    edge_ubo = $uboEdge; edge_dr = $drEdge
                    cws_ubo  = $uboCws;  cws_dr  = $drCws
                    amo_ubo  = $uboAmo;  amo_dr  = $drAmo
                    uboEdge  = $uboEdge; drEdge  = $drEdge
                    uboCws   = $uboCws;  drCws   = $drCws
                    uboAmo   = $uboAmo;  drAmo   = $drAmo
                }
                [System.IO.File]::WriteAllText((Join-Path $extDir 'resolved-extensions.json'), ($cacheObj | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
                $ready = $true
            }
        } catch { }
        $sw.Stop()
        return @{ leg = 'chrome_extensions'; ready = $ready; mode = $mode; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
    }

    # Leg 5: Parsec installer extract (independent staging to C:\ghrdp\parsec)
    $jobs += Start-Job -Name ('f63-' + 'parsec') -ArgumentList @($ws, $CacheDir, $isSim, $dParsec, $helperPath) -ScriptBlock {
        $wsArg = $args[0]; $cacheArg = $args[1]; $sim = [bool]$args[2]; $delay = [int]$args[3]; $hlp = $args[4]
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        if ($sim) {
            Start-Sleep -Milliseconds $delay
            $sw.Stop()
            return @{ leg = 'parsec'; ready = $true; mode = 'simulated-prebuilt'; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
        }
        . $hlp
        $res = Resolve-F63PrebuiltAsset -AssetKey 'parsec' -Workspace $wsArg -CacheDir $cacheArg
        $pDir = 'C:\ghrdp\parsec'
        New-Item -ItemType Directory -Path $pDir -Force -ErrorAction SilentlyContinue | Out-Null
        $mode = 'fallback'
        $ready = $false
        if ($res.hit -and $res.path) {
            Copy-Item -LiteralPath $res.path -Destination (Join-Path $pDir 'parsec-windows.exe') -Force -ErrorAction SilentlyContinue
            $ready = $true
            $mode = 'prebuilt'
        } else {
            Write-Host '::warning title=F63 parsec fallback::parsec-windows.exe prebuilt miss - Parsec warm task will use system path if installed'
        }
        $sw.Stop()
        return @{ leg = 'parsec'; ready = $ready; mode = $mode; sec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
    }

    # Rendezvous: Wait-Job on all 5 parallel install legs before dashboard startup
    $null = Wait-Job -Job $jobs -Timeout 300
    $legs = @()
    $serialSum = 0.0
    foreach ($j in $jobs) {
        $r = $null
        try {
            $outItems = @(Receive-Job -Job $j -Wait -ErrorAction SilentlyContinue)
            $r = $outItems | Where-Object { $_ -and ($_ -is [hashtable]) -and $_.leg } | Select-Object -First 1
        } catch { }
        if (-not $r) {
            $r = @{ leg = ('job-' + $j.Id); ready = ($j.State -eq 'Completed'); mode = 'fallback'; sec = 0.0 }
        }
        $serialSum += [double]$r.sec
        Add-F63Timing -Step ('parallel-leg-' + [string]$r.leg) -Seconds ([double]$r.sec) -Optimization 'D-parallel' -Mode ([string]$r.mode)
        Write-Host ('[F63 parallel] leg=' + $r.leg + ' ready=' + $r.ready + ' mode=' + $r.mode + ' sec=' + $r.sec + 's')
        $legs += $r
    }
    $jobs | Stop-Job -ErrorAction SilentlyContinue
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    $swWall.Stop()
    $wallSec = [math]::Round($swWall.Elapsed.TotalSeconds, 3)
    $serialSum = [math]::Round($serialSum, 3)
    Add-F63Timing -Step 'parallel-installs-wall' -Seconds $wallSec -Optimization 'D-parallel' -Mode 'rendezvous'
    Write-Host ('[F63 parallel] Wait-Job rendezvous complete: legs=' + $legs.Count + ' wall=' + $wallSec + 's serialSum=' + $serialSum + 's')
    return @{
        ok             = ($legs.Count -eq 5)
        legs           = $legs
        wallSec        = $wallSec
        serialSumSec   = $serialSum
        elapsed_sec    = $wallSec
        serial_sum_sec = $serialSum
    }
}
