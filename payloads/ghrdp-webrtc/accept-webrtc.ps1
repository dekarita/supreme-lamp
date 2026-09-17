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

# --- summary + verdict ------------------------------------------------------
$verdict = 'FAIL'
if ($acc) { $verdict = [string]$acc.verdict }

$summaryLines = @()
$summaryLines += '### GHRDP WebRTC acceptance'
$summaryLines += ''
if ($acc) {
    $summaryLines += '| field | value |'
    $summaryLines += '| --- | --- |'
    foreach ($k in @('verdict', 'fps', 'kbps', 'decode_ok', 'candidate', 'git_commit', 'session_id', 'capture', 'mode', 'encoder', 'input_to_frame_ms', 'probe_at')) {
        $summaryLines += ('| {0} | {1} |' -f $k, $acc.$k)
    }
} else {
    $summaryLines += 'acceptance.json was not produced (probe timeout or crash).'
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