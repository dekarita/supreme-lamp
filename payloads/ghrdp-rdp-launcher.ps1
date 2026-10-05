# ============================================================================
# [F91 §A.1] GHRDP RDP Launcher Service - the persistent queue reader that
# makes MIRROR MODE work on the runner side.
#
# WHY: every previous launch path (F81 scheduled task, F86 tier ladder, F90
# viewing-mode) had to answer the dashboard within one HTTP request, so a
# transient failure surfaced as a dead end. Mirror mode decouples the two
# halves: the dashboard opens the link locally AND drops a JSON job into
# C:\ProgramData\ghrdp\launcher-queue; THIS loop picks jobs up within ~500 ms
# and executes them in the interactive session. If this service is down, the
# dashboard still opened the link locally and says so - the user never sees a
# "could not open" dead end again.
#
# CONTRACT (payloads/ghrdp-server.ps1 /api/launcher/queue writes these files):
#   <queue>\<guid>.job  =  {"id","url","mode","name","timestamp"}
#   mode                 =  navigate | download | explorer | noop
#     navigate -> Start-Process the browser with the URL (https-validated HERE
#                 too - this is defense in depth, the route already fenced)
#     explorer -> Start-Process explorer.exe with the folder (toast click
#                 "Open in RDP" after a download landed in RDP-Downloads)
#     download -> notification only (the bytes were written by the server;
#                 msg.exe if present, else the log line is the record)
#     noop     -> SELFTEST ONLY: log + consume. Proves the whole pipeline
#                 (route -> file -> this loop -> log) without touching a
#                 browser or the desktop.
#
# HEALTH: heartbeat line (ISO-8601 UTC) rewritten to
# C:\ProgramData\ghrdp\launcher-heartbeat.txt every 10 s; the server's
# /api/launcher/health treats < 30 s as "serviceRunning".
#
# SAFETY posture (unchanged repo locks): no keyboard injection, no UI
# automation of any kind, no credential handling, URL allow-nothing beyond
# https/http-to-localhost is NOT accepted - anything else is logged refused
# and dropped. Log lines carry host/path only for navigate (never query
# strings), same redaction rule as the F88 launch log.
# ============================================================================
$ErrorActionPreference = 'Continue'

$QueueDir     = 'C:\ProgramData\ghrdp\launcher-queue'
$LogPath      = 'C:\ProgramData\ghrdp\launcher.log'
$Heartbeat    = 'C:\ProgramData\ghrdp\launcher-heartbeat.txt'
$PollMs       = 500
$HeartbeatSec = 10

function Write-F91Log {
    param([string]$Line)
    try {
        $dir = Split-Path -Parent $LogPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -LiteralPath $LogPath -Value ('{0} {1}' -f (Get-Date -Format 'o'), $Line) -Encoding UTF8
        # keep the log bounded (1 MB, truncate to the tail) - never grows forever
        if ((Test-Path -LiteralPath $LogPath) -and ((Get-Item -LiteralPath $LogPath).Length -gt 1MB)) {
            $tail = @(Get-Content -LiteralPath $LogPath -Tail 200 -ErrorAction SilentlyContinue)
            [System.IO.File]::WriteAllLines($LogPath, $tail)
        }
    } catch { }
}

function Write-F91Heartbeat {
    try {
        $dir = Split-Path -Parent $Heartbeat
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($Heartbeat, (Get-Date).ToUniversalTime().ToString('o'))
    } catch { }
}

function Test-F91LaunchUrl {
    param([string]$Url, [string]$Mode)
    if ($Mode -eq 'explorer') {
        # explorer takes a LOCAL folder path, and only a folder path: an
        # absolute Windows path under a drive letter, no URL schemes at all.
        return ($Url -match '^[A-Za-z]:\\[^<>:"|?*]*$')
    }
    if ($Mode -eq 'download' -or $Mode -eq 'noop') { return $true }
    if (-not $Url -or $Url.Length -gt 2048) { return $false }
    if ($Url -notmatch '^(?i)https://') { return $false }
    $u = $null
    try { $u = [System.Uri]$Url } catch { return $false }
    if (-not $u -or $u.Scheme -ne 'https' -or $u.UserInfo) { return $false }
    return $true
}

function Get-F91RedactedUrl {
    param([string]$Url)
    # same rule as the F88 launch log: host + path only, never the query.
    try {
        $u = [System.Uri]$Url
        if ($u -and $u.Host) { $s = $u.Host + $u.PathAndQuery.Split('?')[0]; return $s }
    } catch { }
    return '<unparseable>'
}

function Invoke-F91Job {
    param($Job)
    $mode = [string]$Job.mode
    $url  = [string]$Job.url
    $name = [string]$Job.name
    if (-not (Test-F91LaunchUrl -Url $url -Mode $mode)) {
        Write-F91Log ('REFUSED ' + $mode + ' ' + $url)
        return
    }
    switch ($mode) {
        'navigate' {
            $target = 'msedge.exe'
            try { if (-not (Get-Command msedge.exe -ErrorAction SilentlyContinue)) { $target = 'chrome.exe' } } catch { }
            Start-Process $target -ArgumentList $url
            Write-F91Log ('OK navigate ' + (Get-F91RedactedUrl -Url $url))
        }
        'explorer' {
            Start-Process explorer.exe -ArgumentList $url
            Write-F91Log ('OK explorer ' + $url)
        }
        'download' {
            # the file was already written + verified by /api/fetch; this only
            # notifies. msg.exe is absent on Home SKU runners - the log line is
            # the durable record either way.
            try { & msg.exe * ('Downloaded: ' + $name) 2>$null; $LASTEXITCODE = 0 } catch { }
            Write-F91Log ('OK download ' + $name)
        }
        'noop' {
            Write-F91Log ('OK noop ' + $name)
        }
        default { Write-F91Log ('REFUSED unknown-mode ' + $mode) }
    }
}

Write-F91Log 'startup launcher-service'
$lastBeat = [datetime]::MinValue
while ($true) {
    try {
        if (-not (Test-Path -LiteralPath $QueueDir)) { New-Item -ItemType Directory -Path $QueueDir -Force | Out-Null }
        $items = @(Get-ChildItem -LiteralPath $QueueDir -Filter '*.job' -ErrorAction SilentlyContinue | Sort-Object CreationTime)
        foreach ($item in $items) {
            $jobName = ''
            try {
                $job = Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                $jobName = [string]$job.name
                Invoke-F91Job -Job $job
            } catch {
                Write-F91Log ('ERR ' + $item.Name + ' ' + $_.Exception.Message)
            } finally {
                try { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue } catch { }
            }
        }
        if (((Get-Date) - $lastBeat).TotalSeconds -ge $HeartbeatSec) {
            Write-F91Heartbeat
            $lastBeat = Get-Date
        }
    } catch {
        try { Write-F91Log ('ERR loop ' + $_.Exception.Message) } catch { }
    }
    Start-Sleep -Milliseconds $PollMs
}
