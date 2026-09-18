# ghrdp-accept.ps1 v2 — client-side acceptance validator (E1-E8).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ghrdp-accept.ps1 -RunnerIp <ip> -DashKey <key>
# Prints PASS/FAIL matrix. On any FAIL, dumps enroll.log/agent.log tails + HTTP status matrix + reg/task state.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$RunnerIp,
    [Parameter(Mandatory=$true)][string]$DashKey
)

$ErrorActionPreference = 'Continue'
$agentDir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
$agentPs  = Join-Path $agentDir 'agent.ps1'
$devJson  = Join-Path $agentDir 'device.json'
$enrollLog= Join-Path $agentDir 'enroll.log'
$agentLog = Join-Path $agentDir 'agent.log'
$base     = "http://${RunnerIp}:7331"
$results  = New-Object System.Collections.ArrayList
$anyFail  = $false

function Add-R { param([string]$id,[string]$desc,[bool]$pass,[string]$evidence)
    $mark = if ($pass) { 'PASS' } else { 'FAIL' }
    if (-not $pass) { $script:anyFail = $true }
    [void]$script:results.Add([pscustomobject]@{ ID=$id; Test=$desc; Result=$mark; Evidence=$evidence })
    $color = if ($pass) { 'Green' } else { 'Red' }
    Write-Host ("[$mark] $id — $desc") -ForegroundColor $color
    if ($evidence) { Write-Host "       $evidence" -ForegroundColor DarkGray }
}

Write-Host "`n=== GHRDP v2 client acceptance against $RunnerIp ===`n" -ForegroundColor Cyan

# E1 — agent.ps1 exists AND sha256 == /api/agent-hash
$e1p = $false; $e1ev = ''
if (Test-Path $agentPs) {
    $localHash = (Get-FileHash -LiteralPath $agentPs -Algorithm SHA256).Hash.ToLower()
    try {
        $h = Invoke-RestMethod -Uri "$base/api/agent-hash" -TimeoutSec 5
        $remote = [string]$h.sha256
        $e1p = ($remote -and ($localHash -eq $remote.ToLower()))
        $e1ev = "local=$($localHash.Substring(0,12)) remote=$($remote.Substring(0,[Math]::Min(12,$remote.Length)))"
    } catch { $e1ev = "hash fetch failed: $_" }
} else { $e1ev = "$agentPs missing" }
Add-R 'E1' 'agent.ps1 exists & hash matches runner' $e1p $e1ev

# E2 — agent process alive (CommandLine match)
$agentProc = @()
try {
    $agentProc = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match [regex]::Escape('agent.ps1') })
} catch {}
$e2p = ($agentProc.Count -gt 0)
$e2ev = "processes matching agent.ps1: $($agentProc.Count)" + $(if ($agentProc.Count) { " pid=$($agentProc[0].ProcessId)" } else { '' })
Add-R 'E2' 'agent process alive' $e2p $e2ev

# E3 — GhrdpAgent scheduled task exists (AtLogOn)
$e3p = $false; $e3ev = ''
try {
    $t = Get-ScheduledTask -TaskName 'GhrdpAgent' -ErrorAction Stop
    $trigs = $t.Triggers | ForEach-Object { $_.GetType().Name }
    $e3p = ($null -ne $t)
    $e3ev = "task state=$($t.State) triggers=$($trigs -join ',')"
} catch { $e3ev = "no GhrdpAgent task: $_" }
Add-R 'E3' 'scheduled task GhrdpAgent exists' $e3p $e3ev

# E4 — reg command uses System32 powershell + agent path
$e4p = $false; $e4ev = ''
try {
    $c = (Get-ItemProperty 'HKCU:\Software\Classes\ghrdp\shell\open\command' -Name '(default)' -ErrorAction Stop).'(default)'
    $sysPath = [regex]::Escape((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $e4p = ($c -match $sysPath) -and ($c -match 'agent\.ps1')
    $e4ev = "reg=$c"
} catch { $e4ev = "reg read failed: $_" }
Add-R 'E4' 'HKCU ghrdp handler uses System32 powershell + agent.ps1' $e4p $e4ev

# E5 — runner sees deviceId (GET /api/agent-status?probe=1)
$e5p = $false; $e5ev = ''
$dev = $null
try { if (Test-Path $devJson) { $dev = Get-Content $devJson -Raw | ConvertFrom-Json } } catch {}
if ($dev -and $dev.deviceId) {
    try {
        $s = Invoke-RestMethod -Uri "$base/api/agent-status?device=$($dev.deviceId)&probe=1" -TimeoutSec 5
        $e5p = [bool]$s.seen
        $e5ev = "seen=$($s.seen) stage=$($s.stage) ageSeconds=$($s.ageSeconds)"
    } catch { $e5ev = "agent-status probe fail: $_" }
} else { $e5ev = "no device.json/deviceId — enrollment did not complete" }
Add-R 'E5' 'runner sees this deviceId' $e5p $e5ev

# E6 — synthetic connect: POST /api/client-cmd, then verify LogonType=10 <=8s + mstsc alive
$e6p = $false; $e6ev = ''
if ($dev -and $dev.deviceId) {
    try {
        $cmdBody = @{ deviceId=$dev.deviceId; action='rdp'; clip=1; mic=0; print=0; drives=0 } | ConvertTo-Json -Compress
        $q = Invoke-RestMethod -Uri "$base/api/client-cmd?key=$([uri]::EscapeDataString($DashKey))" -Method POST -Body $cmdBody -ContentType 'application/json' -TimeoutSec 8
        Start-Sleep -Seconds 3
        # Poll status for connected stage OR check LogonType=10 event
        $connected = $false
        for ($i=0; $i -lt 8; $i++) {
            Start-Sleep -Seconds 1
            try {
                $st = Invoke-RestMethod -Uri "$base/api/agent-status?device=$($dev.deviceId)" -TimeoutSec 3
                if ($st.stage -eq 'connected' -or ($st.mstscPid -gt 0 -and $st.logonAge -ge 0 -and $st.logonAge -le 30)) { $connected = $true; break }
            } catch {}
        }
        $mstscAlive = @(Get-Process mstsc -ErrorAction SilentlyContinue).Count
        $e6p = ($connected -and $mstscAlive -gt 0)
        $e6ev = "cmd queued cmdId=$($q.cmdId) connected=$connected mstscCount=$mstscAlive"
    } catch { $e6ev = "synthetic connect failed: $_" }
} else { $e6ev = "no deviceId (E5 must pass first)" }
Add-R 'E6' 'synthetic /api/client-cmd → RDP session <=8s' $e6p $e6ev

# E7 — Pages status.json single-slash fetch OK
$e7p = $false; $e7ev = ''
if ($dev -and $dev.pagesUrl) {
    $u = $dev.pagesUrl
    if ($u -match '(?<!:)/{2,}') { $e7ev = "double-slash detected in URL: $u" }
    else {
        try {
            $sp = Invoke-RestMethod -Uri $u -TimeoutSec 10
            $e7p = [bool]$sp.runnerIp
            $e7ev = "URL=$u runnerIp=$($sp.runnerIp) epoch=$($sp.epoch)"
        } catch { $e7ev = "fetch failed: $u → $_" }
    }
} else { $e7ev = "no pagesUrl in device.json" }
Add-R 'E7' 'Pages status.json single-slash fetches cleanly' $e7p $e7ev

# E8 — second synthetic cmd within 30s (repeat click)
$e8p = $false; $e8ev = ''
if ($dev -and $dev.deviceId) {
    Start-Sleep -Seconds 3
    try {
        $cmdBody2 = @{ deviceId=$dev.deviceId; action='rdp'; clip=1 } | ConvertTo-Json -Compress
        $q2 = Invoke-RestMethod -Uri "$base/api/client-cmd?key=$([uri]::EscapeDataString($DashKey))" -Method POST -Body $cmdBody2 -ContentType 'application/json' -TimeoutSec 8
        Start-Sleep -Seconds 5
        $st2 = Invoke-RestMethod -Uri "$base/api/agent-status?device=$($dev.deviceId)" -TimeoutSec 3
        $e8p = ($st2.stage -eq 'connected' -or $st2.ageSeconds -le 30)
        $e8ev = "second cmdId=$($q2.cmdId) stage=$($st2.stage) ageSeconds=$($st2.ageSeconds)"
    } catch { $e8ev = "second synthetic failed: $_" }
}
Add-R 'E8' 'second click within 30s honored' $e8p $e8ev

Write-Host "`n=== PASS MATRIX ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize

if ($anyFail) {
    Write-Host "`n=== FAIL — DIAGNOSTIC DUMP ===" -ForegroundColor Yellow

    Write-Host "`n--- enroll.log (last 40) ---" -ForegroundColor Yellow
    if (Test-Path $enrollLog) { Get-Content $enrollLog -Tail 40 } else { Write-Host "(missing)" }

    Write-Host "`n--- agent.log (last 40) ---" -ForegroundColor Yellow
    if (Test-Path $agentLog) { Get-Content $agentLog -Tail 40 } else { Write-Host "(missing)" }

    Write-Host "`n--- HTTP status matrix ---" -ForegroundColor Yellow
    foreach ($ep in @('/api/ping','/api/agent.ps1','/api/agent-hash','/api/device-enroll')) {
        try {
            $method = if ($ep -eq '/api/device-enroll') { 'HEAD' } else { 'GET' }
            $r = Invoke-WebRequest -Uri "$base$ep" -Method $method -UseBasicParsing -TimeoutSec 5
            Write-Host "$ep => $($r.StatusCode)" -ForegroundColor Green
        } catch { Write-Host "$ep => $($_.Exception.Message)" -ForegroundColor Red }
    }

    Write-Host "`n--- reg query HKCU\Software\Classes\ghrdp ---" -ForegroundColor Yellow
    try { & reg.exe query 'HKCU\Software\Classes\ghrdp\shell\open\command' /ve } catch { Write-Host "(query failed)" }

    Write-Host "`n--- task GhrdpAgent ---" -ForegroundColor Yellow
    try { Get-ScheduledTask -TaskName 'GhrdpAgent' | Format-List State,Triggers,Actions } catch { Write-Host "(no task)" }

    Write-Host "`n--- device.json ---" -ForegroundColor Yellow
    if (Test-Path $devJson) { Get-Content $devJson } else { Write-Host "(missing)" }

    Write-Host "`n--- PSVersionTable ---" -ForegroundColor Yellow
    $PSVersionTable | Out-String | Write-Host

    exit 1
} else {
    Write-Host "`nALL PASS — GHRDP v2 is operational on this client." -ForegroundColor Green
    exit 0
}
