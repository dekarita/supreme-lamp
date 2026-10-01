# [F59 §3] STARTUP TIMING HELPER - dot-sourced by the instrumented main.yml steps.
# One JSON line per step: {"step":"<name>","sec":<n>,"at":"<utc iso>"} appended to
# the timing file (C:\ghrdp\startup-timing.jsonl by default). The file is uploaded
# as the `startup-timing` artifact by the F59 report step, which also prints the
# before/after total. Every function is non-throwing: instrumentation must never
# be the reason a dispatch dies (a missing timing line is reported as missing).
function Get-F59TimingFile {
    if ($env:GHRDP_F59_TIMING) { return [string]$env:GHRDP_F59_TIMING }
    return 'C:\ghrdp\startup-timing.jsonl'
}

function Add-F59Timing {
    param([string]$Step, [double]$Seconds)
    if (-not $Step) { return }
    try {
        $file = Get-F59TimingFile
        $dir = Split-Path -Parent $file
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $rec = @{ step = [string]$Step; sec = [math]::Round([double]$Seconds, 1); at = (Get-Date).ToUniversalTime().ToString('o') }
        Add-Content -LiteralPath $file -Value (($rec | ConvertTo-Json -Compress)) -Encoding utf8
    } catch { }
}

function Start-F59Step {
    # Returns a stopwatch; pass it to Stop-F59Step. Never throws.
    $sw = New-Object System.Diagnostics.Stopwatch
    $sw.Start()
    return $sw
}

function Stop-F59Step {
    param([string]$Step, $Sw)
    $sec = 0.0
    try { if ($Sw) { $Sw.Stop(); $sec = $Sw.Elapsed.TotalSeconds } } catch { }
    Add-F59Timing -Step $Step -Seconds $sec
    Write-Host ('[F59 timing] ' + $Step + ' = ' + ([math]::Round($sec, 1)) + 's')
    return $sec
}

function Invoke-F59Measured {
    # [F59 §3] Measure-Command wrapper: run a scriptblock, record its wall time to
    # the same jsonl, return its result. Used where a step wants a real
    # Measure-Command measurement instead of an explicit stopwatch.
    param([string]$Step, [scriptblock]$Body)
    $result = $null
    $sec = (Measure-Command { $result = & $Body }).TotalSeconds
    Add-F59Timing -Step $Step -Seconds $sec
    Write-Host ('[F59 timing] ' + $Step + ' = ' + ([math]::Round($sec, 1)) + 's (Measure-Command)')
    return $result
}

function Get-F59SecondsSinceJobStart {
    # Seconds from the runner-local JOB_STARTED_AT stamp (F11-6) to now; -1 when unknown.
    try {
        if (-not $env:JOB_STARTED_AT) { return -1 }
        $start = [datetime]::Parse([string]$env:JOB_STARTED_AT).ToUniversalTime()
        return [int]((Get-Date).ToUniversalTime() - $start).TotalSeconds
    } catch { return -1 }
}
