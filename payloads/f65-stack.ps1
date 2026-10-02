# [F65 §2/§5] PRE-STAGED STACK helpers: the in-runner concurrency map, the
# background-prefetch rendezvous, and the bundle integrity verifier.
#
# Dot-sourced by scripts/f65-prefetch.ps1 (the background producer) and by the
# main.yml consumer steps (rendezvous). Nothing here throws on the happy path;
# fail-closed behaviour (a sha256 disagreement REFUSES the bundle) lives in the
# producer + verifier, and every consumer treats a missing/mismatched bundle as
# "fall back to the individual download path".

function Get-F65StateFile {
    param([string]$Scratch)
    if (-not $Scratch) { $Scratch = [string]$env:GHRDP_F65_SCRATCH }
    if (-not $Scratch) { $Scratch = 'C:\scratch' }
    return (Join-Path $Scratch 'stack-state.json')
}

function Get-F65StackState {
    # Rendezvous: returns the parsed state object, or $null when the producer has
    # not finished yet (status 'pending') / never wrote one. -Wait polls.
    param(
        [string]$Scratch,
        [switch]$Wait,
        [int]$TimeoutSec = 60
    )
    $file = Get-F65StateFile -Scratch $Scratch
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        if (Test-Path -LiteralPath $file) {
            try {
                $st = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
                if ($st -and [string]$st.status -ne 'pending') { return $st }
            } catch { }
        }
        if (-not $Wait) { return $null }
        if ((Get-Date) -ge $deadline) { return $null }
        Start-Sleep -Seconds 2
    }
}

function Get-F65Component {
    param($State, [Parameter(Mandatory)] [string]$Name)
    if (-not $State) { return $null }
    try {
        $c = $State.components.$Name
        if (-not $c) { return $null }
        if (-not $c.ok) { return $null }
        if (-not (Test-Path -LiteralPath ([string]$c.path))) { return $null }
        return $c
    } catch { return $null }
}

function Expand-F65BundleZip {
    param([Parameter(Mandatory)] [string]$Zip, [Parameter(Mandatory)] [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue | Out-Null
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination, $true)
    return $Destination
}

function Test-F65BundleFile {
    param([Parameter(Mandatory)] [string]$Path, [Parameter(Mandatory)] [string]$Expected)
    try {
        $got = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        return [pscustomobject]@{ path = $Path; expected = $Expected; observed = $got; ok = ($got -eq $Expected) }
    } catch {
        return [pscustomobject]@{ path = $Path; expected = $Expected; observed = ''; ok = $false }
    }
}

function Test-F65BundleFiles {
    # Verifies EVERY file recorded in the bundle manifest against its sha256.
    param([Parameter(Mandatory)] [string]$ExtractDir, [Parameter(Mandatory)] [string]$ManifestPath)
    $res = [ordered]@{ ok = $false; checked = 0; bad = @(); missing = @(); manifest = $null }
    if (-not (Test-Path -LiteralPath $ManifestPath)) { return [pscustomobject]$res }
    $m = $null
    try { $m = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json } catch { return [pscustomobject]$res }
    $res.manifest = $m
    foreach ($p in @($m.files.PSObject.Properties)) {
        $rel = [string]$p.Name
        $want = [string]$p.Value.sha256
        $full = Join-Path $ExtractDir ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full)) { $res.missing += $rel; continue }
        $v = Test-F65BundleFile -Path $full -Expected $want
        $res.checked++
        if (-not $v.ok) { $res.bad += $rel }
    }
    $res.ok = (($res.bad.Count -eq 0) -and ($res.missing.Count -eq 0) -and ($res.checked -gt 0))
    return [pscustomobject]$res
}

function Invoke-F65ParallelMap {
    # In-runner concurrency map (F65 §2): Start-ThreadJob when the module exists
    # (PowerShell 7 bundles it), ForEach-Object -Parallel on PS7 without it, and a
    # bounded Start-Job wave fallback on Windows PowerShell 5.1. $Body receives the
    # item as its FIRST positional parameter (param($item)).
    param(
        # AllowEmptyCollection: PowerShell refuses to bind an empty array to a
        # Mandatory parameter otherwise, and "no items" is a legitimate input
        # (the function returns @() immediately - the lab pins that behaviour).
        [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]]$Items,
        [Parameter(Mandatory)] [scriptblock]$Body,
        [int]$ThrottleLimit = 4,
        [int]$TimeoutSec = 900,
        [string]$Label = 'f65-parallel'
    )
    if (-not $Items -or $Items.Count -eq 0) { return @() }
    if ($ThrottleLimit -lt 1) { $ThrottleLimit = 1 }
    $mode = 'start-job-wave'
    if (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue) { $mode = 'threadjob' }
    elseif ($PSVersionTable.PSVersion.Major -ge 7) { $mode = 'foreach-parallel' }
    Write-Host ('[F65 parallel] ' + $Label + ' mode=' + $mode + ' items=' + $Items.Count + ' throttle=' + $ThrottleLimit)

    if ($mode -eq 'foreach-parallel') {
        $parallelBody = {
            $item = $_
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $res = $null
            $err = ''
            try { $res = & $using:Body $item } catch { $err = $_.Exception.Message }
            $sw.Stop()
            [pscustomobject]@{ item = $item; ok = [string]::IsNullOrEmpty($err); result = $res; error = $err; sec = [math]::Round($sw.Elapsed.TotalSeconds, 2) }
        }
        return @($Items | ForEach-Object -Parallel $parallelBody -ThrottleLimit $ThrottleLimit)
    }

    $results = New-Object System.Collections.ArrayList
    $waves = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $Items.Count; $i += $ThrottleLimit) {
        $wave = @()
        for ($j = $i; $j -lt [math]::Min($i + $ThrottleLimit, $Items.Count); $j++) { $wave += $Items[$j] }
        $null = $waves.Add($wave)
    }
    foreach ($wave in $waves) {
        $jobs = @()
        foreach ($it in $wave) {
            if ($mode -eq 'threadjob') { $jobs += Start-ThreadJob -ScriptBlock $Body -ArgumentList $it -ThrottleLimit $ThrottleLimit }
            else { $jobs += Start-Job -ScriptBlock $Body -ArgumentList $it }
        }
        if (-not (Wait-Job -Job $jobs -Timeout $TimeoutSec)) { Write-Host ('::warning::[F65 parallel] ' + $Label + ' wave timed out at ' + $TimeoutSec + 's') }
        foreach ($j in $jobs) {
            $sec = 0.0
            try { $sec = ($j.PSEndTime - $j.PSBeginTime).TotalSeconds } catch { }
            $err = ''
            $res = $null
            try { $res = Receive-Job -Job $j -Wait -ErrorAction Stop } catch { $err = $_.Exception.Message }
            if ($j.State -ne 'Completed') { $err = ('state=' + $j.State) }
            $null = $results.Add([pscustomobject]@{ item = @($wave)[$jobs.IndexOf($j)]; ok = [string]::IsNullOrEmpty($err); result = $res; error = $err; sec = [math]::Round($sec, 2) })
        }
        $jobs | Stop-Job -ErrorAction SilentlyContinue
        $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    }
    return @($results)
}
