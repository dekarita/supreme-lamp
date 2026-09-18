# deploy-bootstrap.ps1 — P1/P3/P6 identity-proof deploy of the WebRTC server.
#
# Every input is DISCOVERED, never assumed:
#   workspace -> recursive search for payloads\ghrdp-webrtc\go.mod under D:\a
#   exe       -> (Get-ScheduledTask GhrdpWebRTC).Actions[0].Execute
#   user      -> quser.exe Active session
# Nothing here relies on $env:GITHUB_WORKSPACE or any other runner env var,
# because terminal-exec/SYSTEM sessions do not inherit them (graveyard #28).
#
# Usage: .\deploy-bootstrap.ps1 [-RepoRoot <path>] [-GitCommit <sha>] [-NoStart]
param(
    [string]$RepoRoot = '',
    [string]$GitCommit = '',
    [switch]$NoStart
)
$ErrorActionPreference = 'Continue'

$DeployDir = 'C:\ghrdp\webrtc'
$DefaultExe = Join-Path $DeployDir 'webrtc-server.exe'
$TaskName = 'GhrdpWebRTC'
$LogFile = Join-Path $DeployDir 'deploy.log'

function Write-Log {
    param([string]$Msg)
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Msg)
    Write-Host $line
    try {
        New-Item -ItemType Directory -Path $DeployDir -Force -ErrorAction SilentlyContinue | Out-Null
        Add-Content -LiteralPath $LogFile -Value $line -ErrorAction SilentlyContinue
    } catch { }
}

function Resolve-GoExe {
    foreach ($cand in @('go', 'C:\hostedtoolcache\windows\go\*\x64\bin\go.exe', 'C:\Program Files\Go\bin\go.exe')) {
        try {
            $c = Get-Command $cand -ErrorAction Stop
            if ($c) { return $c.Source }
        } catch { }
    }
    try {
        $found = Get-ChildItem 'C:\hostedtoolcache\windows\go' -Recurse -Filter 'go.exe' -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($found) { return $found.FullName }
    } catch { }
    return $null
}

# ---- P1a: discover the workspace ------------------------------------------
function Resolve-Workspace {
    if ($RepoRoot -and (Test-Path (Join-Path $RepoRoot 'payloads\ghrdp-webrtc\go.mod'))) {
        return (Resolve-Path $RepoRoot).Path
    }
    foreach ($root in @('D:\a', 'C:\a')) {
        if (-not (Test-Path $root)) { continue }
        Write-Log ("searching {0} for payloads\ghrdp-webrtc\go.mod" -f $root)
        try {
            $hit = Get-ChildItem -Path $root -Recurse -Filter 'go.mod' -Depth 8 -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -like '*payloads\ghrdp-webrtc\go.mod' } |
                Select-Object -First 1
            if ($hit) {
                $repo = $hit.FullName.Substring(0, $hit.FullName.Length - '\payloads\ghrdp-webrtc\go.mod'.Length)
                Write-Log ("workspace discovered: {0}" -f $repo)
                return $repo
            }
        } catch { }
    }
    if ($env:GITHUB_WORKSPACE -and (Test-Path (Join-Path $env:GITHUB_WORKSPACE 'payloads\ghrdp-webrtc\go.mod'))) {
        Write-Log 'workspace from GITHUB_WORKSPACE (fallback)'
        return $env:GITHUB_WORKSPACE
    }
    return ''
}

# ---- P1b: discover the exe from the task definition ------------------------
function Resolve-ExeFromTask {
    try {
        $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $exe = [string]$t.Actions[0].Execute
        if ($exe) {
            $leaf = Split-Path -Leaf $exe.Trim('"')
            if ($leaf -eq 'cmd.exe' -or $leaf -eq 'powershell.exe') {
                Write-Log ("task {0} runs supervisor ({1}); using default exe" -f $TaskName, $leaf)
                return $DefaultExe
            }
            Write-Log ("exe from task definition ({0}): {1}" -f $TaskName, $exe)
            return $exe.Trim('"')
        }
    } catch {
        Write-Log ("task {0} not present; using default exe path" -f $TaskName)
    }
    return $DefaultExe
}

# ---- P1c: discover the active interactive user -----------------------------
function Resolve-ActiveUser {
    $u = ''
    try {
        foreach ($line in @(& quser.exe 2>$null)) {
            if ($line -match '^\s*>?\s*(\S+)\s+\S+\s+(\d+)\s+Active') { $u = $Matches[1] }
        }
    } catch { }
    if (-not $u) { $u = [string]$env:RDP_USER }
    if (-not $u) { $u = [string]$env:USERNAME }
    Write-Log ("active user: {0}" -f $u)
    return $u
}

Write-Log '=== GHRDP WebRTC identity-proof bootstrap ==='

$repo = Resolve-Workspace
if (-not $repo) {
    Write-Log 'FATAL: workspace not found (no payloads\ghrdp-webrtc\go.mod under D:\a)'
    exit 3
}
$srcDir = Join-Path $repo 'payloads\ghrdp-webrtc'

$exePath = Resolve-ExeFromTask
$exeName = [System.IO.Path]::GetFileName($exePath)

# ---- P6: record the sha we are about to build ------------------------------
if (-not $GitCommit) {
    try {
        Push-Location $repo
        $GitCommit = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
        Pop-Location
    } catch { }
}
if (-not $GitCommit -or $GitCommit.Length -lt 7) {
    Write-Log 'FATAL: could not determine git commit to stamp (need GITHUB_SHA or a working git)'
    exit 4
}
$GitCommit = $GitCommit.Trim()
$BuildTime = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Write-Log ("stamping commit={0} build_time={1}" -f $GitCommit, $BuildTime)

# ---- P4: kill anything stale, by the DISCOVERED name -----------------------
function Stop-StaleServer {
    $killed = 0
    foreach ($n in @($exeName, 'ffmpeg.exe')) {
        try {
            Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $n) -ErrorAction SilentlyContinue | ForEach-Object {
                try {
                    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
                    $killed++
                    Write-Log ("killed stale {0} pid={1}" -f $n, $_.ProcessId)
                } catch { }
            }
        } catch { }
    }
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
    # A previous server that never released the port would make the new one die on
    # ListenAndServe. The server also does this internally, but clearing it here
    # means the failure mode is visible in the deploy log with the pid.
    try {
        Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Where-Object { $_ -and $_ -ne $PID } |
            ForEach-Object {
                try {
                    Stop-Process -Id $_ -Force -ErrorAction Stop
                    $killed++
                    Write-Log ("killed stale :8080 listener pid={0}" -f $_)
                } catch { }
            }
    } catch { }
    return $killed
}
Write-Log ("stale process sweep: killed {0}" -f (Stop-StaleServer))

# ---- P1d: synchronous build to the discovered exe path ---------------------
$goExe = Resolve-GoExe
if (-not $goExe) {
    Write-Log 'FATAL: Go toolchain not found on this runner'
    exit 5
}
Write-Log ("go: {0}" -f (& $goExe version 2>&1 | Select-Object -First 1))

New-Item -ItemType Directory -Path $DeployDir -Force -ErrorAction SilentlyContinue | Out-Null
$buildOut = Join-Path $DeployDir ($exeName + '.new')
Push-Location $srcDir
try {
    $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
    $ldflags = ('-s -w -X main.gitCommit={0} -X main.buildTime={1}' -f $GitCommit, $BuildTime)
    Write-Log ("go build -mod=readonly -ldflags `"{0}`"" -f $ldflags)
    # -mod=readonly: go.mod/go.sum are committed, so the build must not silently
    # rewrite them. A missing requirement is a build failure here, not a quiet
    # `go mod tidy` that makes this runner's binary differ from the committed sha.
    & $goExe build -mod=readonly -ldflags $ldflags -o $buildOut . 2>&1 | ForEach-Object { Write-Log ("  go: {0}" -f $_) }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $buildOut)) {
        Write-Log ("FATAL: go build failed (exit {0})" -f $LASTEXITCODE)
        Pop-Location
        exit 6
    }
    # also build the probe next to the server, used by acceptance (P5)
    $probeOut = Join-Path $DeployDir 'probe.exe'
    & $goExe build -mod=readonly -ldflags '-s -w' -o $probeOut ./cmd/probe 2>&1 | ForEach-Object { Write-Log ("  probe: {0}" -f $_) }
    if ($LASTEXITCODE -ne 0) { Write-Log 'WARN: probe build failed; acceptance will report FAIL' }
} finally {
    Pop-Location
}

# swap in the new binary only after a successful build
Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $exeName) -ErrorAction SilentlyContinue |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
Start-Sleep -Milliseconds 500
try {
    Move-Item -LiteralPath $buildOut -Destination $exePath -Force -ErrorAction Stop
    Write-Log ("installed: {0} ({1:F1} MB)" -f $exePath, ((Get-Item $exePath).Length / 1MB))
} catch {
    Write-Log ("FATAL: could not install binary: {0}" -f $_.Exception.Message)
    exit 7
}

# ---- static assets ---------------------------------------------------------
$staticDst = Join-Path $DeployDir 'static'
New-Item -ItemType Directory -Path $staticDst -Force -ErrorAction SilentlyContinue | Out-Null
Copy-Item -Path (Join-Path $srcDir 'static\*') -Destination $staticDst -Recurse -Force
Write-Log ("static deployed to {0}" -f $staticDst)

# Stage the heal/acceptance scripts next to the binary so later steps and any
# out-of-band terminal-exec run can reach them by a fixed path.
foreach ($script in @('deploy-bootstrap.ps1', 'accept-webrtc.ps1', 'setup.ps1', 'run-server.cmd')) {
    $from = Join-Path $srcDir $script
    if (Test-Path $from) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $DeployDir $script) -Force -ErrorAction SilentlyContinue
    }
}
Write-Log 'heal scripts staged in deploy dir'

[System.IO.File]::WriteAllText((Join-Path $DeployDir 'deploy-sha.txt'), ($GitCommit + "`n"), (New-Object System.Text.UTF8Encoding($false)))

# ---- P2: WER crash dumps for the server binary -----------------------------
$dumpsDir = Join-Path $DeployDir 'dumps'
New-Item -ItemType Directory -Path $dumpsDir -Force -ErrorAction SilentlyContinue | Out-Null
$werKey = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\webrtc-server.exe'
try {
    New-Item -Path $werKey -Force -ErrorAction SilentlyContinue | Out-Null
    Set-ItemProperty -Path $werKey -Name 'DumpType' -Value 2 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $werKey -Name 'DumpFolder' -Value $dumpsDir -Type ExpandString -ErrorAction SilentlyContinue
    Write-Log ("WER LocalDumps -> {0}" -f $dumpsDir)
} catch { Write-Log ('WER registry setup skipped: ' + $_.Exception.Message) }

if ($NoStart) { Write-Log 'NoStart set; deploy complete without starting the task'; exit 0 }

# booleans: exit 0 = success, exit 10 = needs restart (session mismatch)
# ---- P3: register interactive task and verify session ----------------------
function Start-RebuildTask {
    param([string]$User)
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
    $cmdPath = Join-Path $DeployDir 'run-server.cmd'
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $cmdPath + '"') -WorkingDirectory $DeployDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 6) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Log ("task {0} registered (Interactive principal: {1}) and started" -f $TaskName, $User)
}

function Get-VersionInfo {
    param([int]$TimeoutSec = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $v = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/version' -TimeoutSec 3 -ErrorAction Stop
            if ($v) { return $v }
        } catch { }
        Start-Sleep -Milliseconds 750
    }
    return $null
}

$activeUser = Resolve-ActiveUser
$needsRestart = $false
try {
    Start-RebuildTask -User $activeUser
} catch {
    Write-Log ("FATAL: task registration failed: {0}" -f $_.Exception.Message)
    exit 8
}

$ver = Get-VersionInfo
if (-not $ver) {
    Write-Log 'server did not answer /version within 20s'
    $needsRestart = $true
} else {
    Write-Log ("/version: commit={0} session_id={1} capture={2} encoder={3} mode={4} exe={5}" -f `
        $ver.git_commit, $ver.session_id, $ver.capture, $ver.encoder, $ver.mode, $ver.exe_path)
    if ([int]$ver.session_id -ne 2) {
        Write-Log ("session_id {0} != 2 - server is in the wrong session, restarting once" -f $ver.session_id)
        $needsRestart = $true
    }
    if ([string]$ver.git_commit -ne $GitCommit) {
        Write-Log ("FATAL: stale deploy - /version serves commit {0} but we built {1}" -f $ver.git_commit, $GitCommit)
        exit 11
    }
}

if ($needsRestart) {
    Write-Log 'restarting once after session/health failure'
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
    Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $exeName) -ErrorAction SilentlyContinue |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
    Start-Sleep -Seconds 2
    try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
    $ver = Get-VersionInfo -TimeoutSec 25
    if (-not $ver) {
        Write-Log 'FATAL: server still not answering after restart'
        exit 9
    }
    Write-Log ("post-restart /version: session_id={0} commit={1}" -f $ver.session_id, $ver.git_commit)
    if ([int]$ver.session_id -ne 2) {
        Write-Log ("FATAL: session_id still {0}; an interactive session (SessionId 2) is required" -f $ver.session_id)
        exit 10
    }
}

Write-Log 'bootstrap complete: server healthy in session 2'
exit 0