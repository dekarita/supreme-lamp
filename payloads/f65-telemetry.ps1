# [F65 §4] PER-STEP TELEMETRY.
#
# One JSON line per timing point -> <scratch>\f65-telemetry.jsonl (default
# C:\scratch\f65-telemetry.jsonl, overridable with GHRDP_F65_TIMING) AND a
# readable line in $GITHUB_STEP_SUMMARY. The jsonl is uploaded as the
# `f65-telemetry` artifact by the F65 report step; tests/f65-telemetry-parse.test.js
# parses exactly that file.
#
# Non-throwing by construction: instrumentation must never be the reason a
# dispatch dies (a missing point is REPORTED as missing, never silently invented).
function Get-F65TimingFile {
    if ($env:GHRDP_F65_TIMING) { return [string]$env:GHRDP_F65_TIMING }
    if ($env:GHRDP_F65_SCRATCH) { return (Join-Path ([string]$env:GHRDP_F65_SCRATCH) 'f65-telemetry.jsonl') }
    return 'C:\scratch\f65-telemetry.jsonl'
}

function Add-F65Point {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [double]$Seconds = -1,
        [string]$Detail = ''
    )
    if (-not $Name) { return }
    $rec = @{ point = [string]$Name; sec = [math]::Round([double]$Seconds, 2); at = (Get-Date).ToUniversalTime().ToString('o'); detail = [string]$Detail }
    try {
        $file = Get-F65TimingFile
        $dir = Split-Path -Parent $file
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -LiteralPath $file -Value (($rec | ConvertTo-Json -Compress)) -Encoding utf8
    } catch { }
    $line = '[F65-TELEMETRY] ' + $rec.point + '=' + $rec.sec + 's'
    if ($rec.detail) { $line = $line + ' :: ' + $rec.detail }
    Write-Host $line
    if ($env:GITHUB_STEP_SUMMARY) {
        try { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ('* ' + $line) -Encoding utf8 } catch { }
    }
}

function Start-F65Point {
    $sw = New-Object System.Diagnostics.Stopwatch
    $sw.Start()
    return $sw
}

function Stop-F65Point {
    param([Parameter(Mandatory)] [string]$Name, $Sw, [string]$Detail = '')
    $sec = -1
    try { if ($Sw) { $Sw.Stop(); $sec = $Sw.Elapsed.TotalSeconds } } catch { }
    Add-F65Point -Name $Name -Seconds $sec -Detail $Detail
    return $sec
}

function Get-F65SecondsSinceJobStart {
    try {
        if (-not $env:JOB_STARTED_AT) { return -1 }
        $start = [datetime]::Parse([string]$env:JOB_STARTED_AT).ToUniversalTime()
        return [math]::Round(((Get-Date).ToUniversalTime() - $start).TotalSeconds, 2)
    } catch { return -1 }
}

function Get-F65Points {
    param([string]$Path)
    if (-not $Path) { $Path = Get-F65TimingFile }
    $acc = @()
    if (-not (Test-Path -LiteralPath $Path)) { return $acc }
    foreach ($l in (Get-Content -LiteralPath $Path)) {
        if (-not $l.Trim()) { continue }
        try { $acc += ($l | ConvertFrom-Json) } catch { }
    }
    return $acc
}

function Write-F65Summary {
    param($Points, [string]$Title = 'F65 telemetry')
    if (-not $env:GITHUB_STEP_SUMMARY) { return }
    $rows = @($Points | Sort-Object { [double]$_.sec })
    try {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ('## ' + $Title + ' (' + $rows.Count + ' points)') -Encoding utf8
        foreach ($r in $rows) {
            $d = ''
            if ($r.detail) { $d = ' - ' + [string]$r.detail }
            Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ('* ' + [string]$r.point + ': ' + [string]$r.sec + 's' + $d) -Encoding utf8
        }
    } catch { }
}
