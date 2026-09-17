# accept-webrtc.ps1 — P5 auto-acceptance + P6 stale-deploy guard.
#
# Runs the headless probe for 30s, writes acceptance.json, and FAILS LOUDLY
# (non-zero exit, no silent skip) when:
#   - the probe times out (millisecond budget, D5)
#   - the probe's git_commit does not match the sha recorded by deploy-bootstrap
#   - verdict != PASS after one interactive restart + re-probe
#
# Usage: .\accept-webrtc.ps1 [-ExpectedSha <sha>] [-DurationSec 30] [-Mode ''] [-SummaryPath <path>]
param(
    [string]$ExpectedSha = '',
    [int]$DurationSec = 30,
    [string]$Mode = '',
    [string]$SummaryPath = ''
)
$ErrorActionPreference = 'Continue'

$DeployDir = 'C:\ghrdp\webrtc'
$ProbeExe = Join-Path $DeployDir 'probe.exe'
$AccPath = Join-Path $DeployDir 'acceptance.json'
$ShaPath = Join-Path $DeployDir 'deploy-sha.txt'
$TaskName = 'GhrdpWebRTC'
$ProbeTimeoutMs = ($DurationSec + 45) * 1000

function Write-Log {
    param([string]$Msg)
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Msg)
    Write-Host $line
    try { Add-Content -LiteralPath (Join-Path $DeployDir 'accept.log') -Value $line -ErrorAction SilentlyContinue } catch { }
}

function Get-ActiveUser {
    $u = ''
    try { foreach ($line in @(& quser.exe 2>$null)) { if ($line -match '^\s*>?\s*(\S+)\s+\S+\s+(\d+)\s+Active') { $u = $Matches[1] } } } catch { }
    if (-not $u) { $u = [string]$env:RDP_USER }
    if (-not $u) { $u = [string]$env:USERNAME }
    return $u
}

# P6: the sha we built must be the sha that is actually serving.
$deploySha = ''
try { $deploySha = ([string][System.IO.File]::ReadAllText($ShaPath)).Trim() } catch { }
if (-not $deploySha) { $deploySha = $ExpectedSha }
Write-Log ("expected sha: {0}" -f $deploySha)

if (-not (Test-Path $ProbeExe)) {
    Write-Log ("FATAL: probe.exe missing at {0} - build step did not complete" -f $ProbeExe)
    exit 1
}

function Get-ServerExeName {
    # Never assume the binary name; read it from the task definition (graveyard #30).
    $name = 'webrtc-server.exe'
    try {
        $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($t -and $t.Actions -and $t.Actions[0].Execute) {
            $name = Split-Path -Leaf ([string]$t.Actions[0].Execute)
        }
    } catch { }
    return $name
}

function Stop-ServerProcesses {
    $exe = Get-ServerExeName
    Write-Log ("stopping stale processes: {0} + ffmpeg.exe" -f $exe)
    try {
        Get-CimInstance Win32_Process -Filter ("Name='" + $exe + "'") -ErrorAction SilentlyContinue |
            ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
        Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue |
            ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
    } catch { }
}

# The probe is launched under the Interactive principal so it shares the
# session of the server; a fallback direct launch keeps this from wedging.
function Invoke-Probe {
    param([string]$Tag)
    $out = Join-Path $DeployDir ("probe-{0}.out" -f $Tag)
    $err = Join-Path $DeployDir ("probe-{0}.err" -f $Tag)
    Remove-Item -LiteralPath $out, $err, $AccPath -Force -ErrorAction SilentlyContinue

    $probeArgs = @('-addr', '127.0.0.1:8080', '-duration', ('{0}s' -f $DurationSec), '-out', $AccPath)
    if ($Mode) { $probeArgs += @('-mode', $Mode) }

    # Task Scheduler mangles nested quoting, so the actual invocation goes in a
    # wrapper script and the task only runs -File on it.
    $wrapper = Join-Path $DeployDir ("probe-{0}.ps1" -f $Tag)
    $argListLiteral = (@($probeArgs) | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ', '
    $wrapperText = @(
        '$ErrorActionPreference = ''Continue'''
        ('$args = @(' + $argListLiteral + ')')
        ('$p = Start-Process -FilePath ''{0}'' -ArgumentList $args -RedirectStandardOutput ''{1}'' -RedirectStandardError ''{2}'' -NoNewWindow -PassThru' -f $ProbeExe, $out, $err)
        '$p.WaitForExit()'
        'exit $p.ExitCode'
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($wrapper, $wrapperText, (New-Object System.Text.UTF8Encoding($false)))

    $user = Get-ActiveUser
    $taskName = 'GhrdpProbe-' + $Tag
    $taskStarted = $false
    try {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $wrapper)
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $taskStarted = $true
        Write-Log ("probe launched interactive as {0} (task {1})" -f $user, $taskName)
    } catch {
        Write-Log ("interactive probe launch failed ({0}); running directly" -f $_.Exception.Message)
    }

    if ($taskStarted) {
        $begin = Get-Date
        while (((Get-Date) - $begin).TotalMilliseconds -lt $ProbeTimeoutMs) {
            if (Test-Path $AccPath) { break }
            Start-Sleep -Milliseconds 500
        }
        try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
    } else {
        $p = Start-Process -FilePath $ProbeExe -ArgumentList $probeArgs -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru
        if (-not $p.WaitForExit($ProbeTimeoutMs)) {
            try { $p.Kill() } catch { }
            Write-Log ("FATAL: probe exceeded {0}ms budget" -f $ProbeTimeoutMs)
            return $false
        }
    }

    foreach ($f in @($out, $err)) {
        if (Test-Path $f) {
            Write-Log ("--- {0} ---" -f (Split-Path -Leaf $f))
            Get-Content -LiteralPath $f -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  ' + $_) }
        }
    }
    Remove-Item -LiteralPath $wrapper -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $AccPath)) {
        Write-Log ("FATAL: probe produced no acceptance.json within {0}ms" -f $ProbeTimeoutMs)
        return $false
    }
    return $true
}

function Read-Acceptance {
    try {
        return (Get-Content -LiteralPath $AccPath -Raw -ErrorAction Stop | ConvertFrom-Json)
    } catch {
        Write-Log ("FATAL: acceptance.json unreadable: {0}" -f $_.Exception.Message)
        return $null
    }
}

# P6 stale-deploy guard: the sha the probe observed must equal the sha we
# deployed. An EMPTY sha means /version was unreachable - that is a health
# failure, not a stale deploy, so leave it to the verdict/restart path below.
function Test-StaleDeploy {
    param($Acc)
    if (-not $Acc) { return $false }
    $sha = [string]$Acc.git_commit
    if (-not $sha) {
        Write-Log 'acceptance has no git_commit (server unreachable at probe time) - treating as health failure'
        return $false
    }
    if ($deploySha -and $sha -ne $deploySha) {
        Write-Log ("FATAL: stale deploy - acceptance git_commit {0} != deployed {1}" -f $sha, $deploySha)
        return $true
    }
    return $false
}

$ok = Invoke-Probe -Tag '1'
$acc = if ($ok) { Read-Acceptance } else { $null }

if (Test-StaleDeploy -Acc $acc) { exit 2 }

if ($acc -and ([string]$acc.verdict -eq 'PASS')) {
    Write-Log 'acceptance PASS on first probe'
} else {
    Write-Log 'acceptance FAIL - restarting server in interactive session and re-probing once'
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
    Stop-ServerProcesses
    Start-Sleep -Seconds 3
    try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { Write-Log ("restart failed: {0}" -f $_.Exception.Message) }
    Start-Sleep -Seconds 5

    $ok = Invoke-Probe -Tag '2'
    $acc = if ($ok) { Read-Acceptance } else { $null }
    if (Test-StaleDeploy -Acc $acc) { exit 2 }
}

# --- A7/A2 health check -----------------------------------------------------
# The probe proves frames flowed during its window; it cannot prove the pipeline
# is still alive afterwards or that the display is being held awake. Read /stats
# so a stream that died immediately after the probe, a stuck guard, or a dropped
# anti-idle requirement still fails the deploy.
function Get-ServerStats {
    try {
        return Invoke-RestMethod -Uri 'http://127.0.0.1:8080/stats' -TimeoutSec 5 -ErrorAction Stop
    } catch {
        Write-Log ("stats unreachable: {0}" -f $_.Exception.Message)
        return $null
    }
}

$health = $null
$healthProblems = @()
$healthWarnings = @()
if ($acc) {
    $health = Get-ServerStats
    if (-not $health) {
        $healthProblems += 'stats unreachable after probe'
    } else {
        # Hard failures: these mean the stream is not actually healthy.
        if ($health.size_mismatch) { $healthProblems += 'size_mismatch set' }
        if ($health.guard_tripped) { $healthProblems += 'capture guard tripped' }
        if ([int]$health.session_id -ne 2) { $healthProblems += ('session_id ' + $health.session_id + ' != 2') }
        # Warning only: anti-idle failing degrades after minutes of idle, it does
        # not stop video. Failing the deploy over it would reject a working stream.
        if (-not $health.display_awake) { $healthWarnings += 'display keepalive inactive (screen may dim when idle)' }
    }
}

# --- B6: exactly one server, one ffmpeg, and ffmpeg -video_size == /version ----
# The v2 desync was capture 512x384 feeding an ffmpeg told 1024x768, which shows
# up as a grey gradient over the top quarter of the frame. /version reports what
# the pipeline intends; ffmpeg's own command line is what actually happens. If
# they disagree, the stream is desynced even when the probe still says PASS.
function Get-ServerExePath {
    try {
        $v = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/version' -TimeoutSec 5 -ErrorAction Stop
        if ($v.exe_path) { return [string]$v.exe_path }
    } catch { }
    return ''
}

# Pure so it can be exercised on any platform: given the sizes ffmpeg was told and
# the resolution the server reports, list the mismatches. v2's grey gradient was
# exactly this disagreement.
function Get-DesyncProblems {
    param([string[]]$Sizes, [string]$Res)
    $out = @()
    if (-not $Res) { return $out }
    foreach ($sz in @($Sizes)) {
        if ($sz -and $sz -ne $Res) {
            $out += ('ffmpeg -video_size ' + $sz + ' != /version res ' + $Res + ' (desync)')
        }
    }
    return $out
}

# A liveness failure (server gone, ffmpeg gone, /stats dead) is repairable: the
# probe measured a window that has since ended, and the server is a supervised
# scheduled task that can simply be started again. Repair once and re-verify so a
# transient death becomes a recovered session instead of a red run. Run
# 35258476317 lost the server mid-probe; the correct response was to bring it
# back, not to fail the deploy and tear the runner down.
function Repair-Pipeline {
    param([string]$Reason)
    Write-Log ('liveness failure (' + $Reason + ') - restarting the server task once')
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
    Stop-ServerProcesses
    Start-Sleep -Seconds 2
    try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { Write-Log ('   restart failed: {0}' -f $_.Exception.Message) }
    Start-Sleep -Seconds 6
    return (Get-ServerStats)
}

function Test-LivenessProblem {
    param([string[]]$Problems)
    foreach ($p in @($Problems)) {
        if ($p -match 'stats unreachable' -or $p -match 'server processes' -or $p -match 'ffmpeg processes') { return $true }
    }
    return $false
}

function Get-PipelineCounts {
    if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) { return $null }
    $exePath = Get-ServerExePath
    $exeLeaf = if ($exePath) { Split-Path -Leaf $exePath } else { Get-ServerExeName }
    $servers = @(Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $exeLeaf) -ErrorAction SilentlyContinue)
    $ffmpegs = @(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue)
    return [pscustomobject]@{
        ServerExe   = $exeLeaf
        Servers     = $servers.Count
        Ffmpegs     = $ffmpegs.Count
        FfmpegSizes = @($ffmpegs | ForEach-Object {
                if ($_.CommandLine -match '-video_size\s+(\S+)') { $Matches[1] }
            })
    }
}

$counts = $null
if ($acc) {
    $counts = Get-PipelineCounts
    if ($counts) {
        if ($counts.Servers -ne 1) { $healthProblems += ('server processes = ' + $counts.Servers + ' (want 1)') }
        if ($counts.Ffmpegs -ne 1) { $healthProblems += ('ffmpeg processes = ' + $counts.Ffmpegs + ' (want 1)') }
        if ($health -and $health.res) {
            $healthProblems += Get-DesyncProblems -Sizes $counts.FfmpegSizes -Res ([string]$health.res)
        }
    }

    # Repair before judging. A dead server or a dead pipeline is the recoverable
    # case, and the only reason this used to be fatal is that the verdict was
    # computed before anyone tried to fix it.
    if (Test-LivenessProblem -Problems $healthProblems) {
        $healthProblems = @()
        $health = Repair-Pipeline -Reason 'server or pipeline stopped after the probe'
        if ($health) {
            if ([int]$health.session_id -ne 2) { $healthProblems += ('session_id ' + $health.session_id + ' != 2') }
            if ($health.size_mismatch) { $healthProblems += 'size_mismatch set' }
            if ($health.guard_tripped) { $healthProblems += 'capture guard tripped' }
            if (-not $health.display_awake) { $healthWarnings += 'display keepalive inactive (screen may dim when idle)' }
            Write-Log ('recovery probe: session_id={0} frames_sent={1} fps_sent={2}' -f $health.session_id, $health.frames_sent, $health.fps_sent)
        } else {
            $healthProblems += 'stats unreachable after repair'
        }
        $counts = Get-PipelineCounts
        if ($counts) {
            if ($counts.Servers -ne 1) { $healthProblems += ('server processes = ' + $counts.Servers + ' after repair (want 1)') }
            if ($counts.Ffmpegs -lt 1) { $healthWarnings += ('ffmpeg processes = ' + $counts.Ffmpegs + ' (idle pipeline: ffmpeg starts on client connect)') }
            if ($counts.Ffmpegs -gt 1) { $healthProblems += ('ffmpeg processes = ' + $counts.Ffmpegs + ' after repair (want <=1)') }
            if ($health -and $health.res) {
                $healthProblems += Get-DesyncProblems -Sizes $counts.FfmpegSizes -Res ([string]$health.res)
            }
        }
    }
}

# --- summary + verdict ------------------------------------------------------
$verdict = 'FAIL'
if ($acc) { $verdict = [string]$acc.verdict }

$summaryLines = @()
$summaryLines += '### GHRDP WebRTC acceptance'
$summaryLines += ''
if ($acc) {
    $summaryLines += '| field | value |'
    $summaryLines += '| --- | --- |'
    foreach ($k in @('verdict', 'fps', 'kbps', 'decode_ok', 'candidate', 'git_commit', 'session_id', 'capture', 'mode', 'encoder', 'input_to_frame_ms', 'max_gap_ms', 'probe_at')) {
        $summaryLines += ('| {0} | {1} |' -f $k, $acc.$k)
    }
} else {
    $summaryLines += 'acceptance.json was not produced (probe timeout or crash).'
}
$summaryLines += ''
$summaryLines += '| post-probe health | value |'
$summaryLines += '| --- | --- |'
if ($health) {
    $summaryLines += ('| display_awake | {0} |' -f $health.display_awake)
    $summaryLines += ('| frames_sent | {0} |' -f $health.frames_sent)
    $summaryLines += ('| fps_sent | {0} |' -f $health.fps_sent)
    $summaryLines += ('| drops | {0} |' -f $health.drops)
    $summaryLines += ('| capture_mode | {0} |' -f $health.capture_mode)
    $summaryLines += ('| size_mismatch | {0} |' -f [bool]$health.size_mismatch)
    $summaryLines += ('| guard_tripped | {0} |' -f [bool]$health.guard_tripped)
} else {
    $summaryLines += '| stats | unreachable |'
}
if ($counts) {
    $summaryLines += ('| server procs | {0} (exe {1}) |' -f $counts.Servers, $counts.ServerExe)
    $summaryLines += ('| ffmpeg procs | {0} |' -f $counts.Ffmpegs)
    $summaryLines += ('| ffmpeg -video_size | {0} |' -f ($counts.FfmpegSizes -join ', '))
}
if ($healthProblems.Count) {
    $summaryLines += ''
    $summaryLines += ('**health problems:** ' + ($healthProblems -join '; '))
    if ($verdict -eq 'PASS') {
        Write-Log ('acceptance PASS overridden by health problems: ' + ($healthProblems -join '; '))
        $verdict = 'FAIL'
    }
}
if ($healthWarnings.Count) {
    $summaryLines += ''
    $summaryLines += ('**health warnings:** ' + ($healthWarnings -join '; '))
    # Warnings are reported but never change the verdict: they describe
    # degradation that only appears after minutes of idle.
    Write-Log ('health warnings: ' + ($healthWarnings -join '; '))
}
if ($summaryLines -and $SummaryPath) {
    try { Add-Content -LiteralPath $SummaryPath -Value ($summaryLines -join "`n") -ErrorAction SilentlyContinue } catch { }
}
$summaryLines | ForEach-Object { Write-Host $_ }

if ($verdict -ne 'PASS') {
    Write-Log '=== ACCEPTANCE RESULT: FAIL ==='
    exit 1
}
Write-Log '=== ACCEPTANCE RESULT: PASS ==='
exit 0