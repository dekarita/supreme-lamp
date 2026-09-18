# ghrdp-acceptance.ps1 v3 — D2 client acceptance validator (E1-E8).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ghrdp-acceptance.ps1 -DashKey <k> [-Runner <ip>]
# Runner auto-discovered from device.json if -Runner not passed.
# On any FAIL: auto-dumps enroll/agent tails + HTTP matrix + reg + task.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DashKey,
    [string]$Runner = ''
)
$ErrorActionPreference = 'Continue'

$agentDir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
$agentPs  = Join-Path $agentDir 'agent.ps1'
$devJson  = Join-Path $agentDir 'device.json'
$enrollLog= Join-Path $agentDir 'enroll.log'
$agentLog = Join-Path $agentDir 'agent.log'

$dev = $null
if (Test-Path $devJson) { try { $dev = Get-Content $devJson -Raw | ConvertFrom-Json } catch {} }
if (-not $Runner -and $dev -and $dev.lastRunner) { $Runner = [string]$dev.lastRunner }
if (-not $Runner) { Write-Host 'ERROR: pass -Runner <ip> (no device.json/lastRunner available)' -ForegroundColor Red; exit 2 }
$base = 'http://' + $Runner + ':7331'

$results = New-Object System.Collections.ArrayList
$anyFail = $false
function Add-R { param([string]$id,[string]$desc,[bool]$pass,[string]$evidence)
    $mark = 'FAIL'; if ($pass) { $mark = 'PASS' }
    if (-not $pass) { $script:anyFail = $true }
    [void]$script:results.Add([pscustomobject]@{ ID=$id; Test=$desc; Result=$mark; Evidence=$evidence })
    $color = 'Red'; if ($pass) { $color = 'Green' }
    Write-Host ('[' + $mark + '] ' + $id + ' - ' + $desc) -ForegroundColor $color
    if ($evidence) { Write-Host ('       ' + $evidence) -ForegroundColor DarkGray }
}

Write-Host ''
Write-Host ('=== GHRDP acceptance v3 against ' + $Runner + ' ===') -ForegroundColor Cyan
Write-Host ''

# E1 - agent.ps1 parses (PSParser)
$e1p = $false; $e1ev = ''
if (Test-Path $agentPs) {
    try {
        $t = Get-Content $agentPs -Raw
        $e = $null
        [void][System.Management.Automation.PSParser]::Tokenize($t, [ref]$e)
        if ($e -and $e.Count) { $e1ev = 'parse errors: ' + $e.Count + ' first-line=' + $e[0].Token.StartLine + ' msg=' + $e[0].Message }
        else { $e1p = $true; $e1ev = 'size=' + $t.Length + ' bytes' }
    } catch { $e1ev = $_.Exception.Message }
} else { $e1ev = 'agent.ps1 missing' }
Add-R 'E1' 'agent.ps1 PSParser parses' $e1p $e1ev

# E2 - sha256 local == /api/agent-hash
$e2p = $false; $e2ev = ''
if (Test-Path $agentPs) {
    $local = (Get-FileHash -LiteralPath $agentPs -Algorithm SHA256).Hash.ToLower()
    try {
        $h = Invoke-RestMethod -Uri ($base + '/api/agent-hash') -TimeoutSec 5
        $rem = [string]$h.sha256
        $e2p = ($rem -and ($local -eq $rem.ToLower()))
        $e2ev = 'local=' + $local.Substring(0,16) + ' remote=' + $rem.Substring(0,[Math]::Min(16,$rem.Length))
    } catch { $e2ev = 'hash fetch fail: ' + $_.Exception.Message }
} else { $e2ev = 'no local agent' }
Add-R 'E2' 'sha256 local == /api/agent-hash' $e2p $e2ev

# E3 - loop procs count
$e3p = $false; $e3ev = ''
$loops = @()
try { $loops = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match [regex]::Escape('agent.ps1') -and $_.CommandLine -match '-Loop' }) } catch {}
$e3p = ($loops.Count -ge 1)
$e3ev = 'loop procs=' + $loops.Count
if ($loops.Count) { $e3ev = $e3ev + ' pid=' + $loops[0].ProcessId }
Add-R 'E3' 'agent -Loop process alive' $e3p $e3ev

# E4 - GhrdpAgent task exists
$e4p = $false; $e4ev = ''
try {
    $tk = Get-ScheduledTask -TaskName 'GhrdpAgent' -ErrorAction Stop
    $trigNames = ($tk.Triggers | ForEach-Object { $_.GetType().Name }) -join ','
    $e4p = $true
    $e4ev = 'state=' + $tk.State + ' triggers=' + $trigNames
} catch { $e4ev = 'GhrdpAgent task missing: ' + $_.Exception.Message }
Add-R 'E4' 'scheduled task GhrdpAgent exists' $e4p $e4ev

# E5 - reg command uses System32 powershell + agent.ps1
$e5p = $false; $e5ev = ''
try {
    $c = [string](Get-ItemProperty 'HKCU:\Software\Classes\ghrdp\shell\open\command' -Name '(default)' -ErrorAction Stop).'(default)'
    $sysPat = [regex]::Escape((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $agentPat = [regex]::Escape('agent.ps1')
    $e5p = (($c -match $sysPat) -and ($c -match $agentPat))
    $e5ev = 'reg=' + ($(if ($c.Length -gt 150) { $c.Substring(0,150) + '...' } else { $c }))
} catch { $e5ev = 'reg read fail: ' + $_.Exception.Message }
Add-R 'E5' 'reg command = System32 powershell + agent.ps1' $e5p $e5ev

# E6 - runner sees deviceId (probe)
$e6p = $false; $e6ev = ''
if ($dev -and $dev.deviceId) {
    try {
        $pr = Invoke-RestMethod -Uri ($base + '/api/agent-status?device=' + [uri]::EscapeDataString($dev.deviceId) + '&probe=1') -TimeoutSec 5
        $e6p = [bool]$pr.seen
        $e6ev = 'seen=' + $pr.seen + ' stage=' + $pr.stage + ' ageSeconds=' + $pr.ageSeconds
    } catch { $e6ev = 'probe fail: ' + $_.Exception.Message }
} else { $e6ev = 'no device.json/deviceId' }
Add-R 'E6' 'runner sees this deviceId (probe)' $e6p $e6ev

# E7 - synthetic /api/client-cmd -> stage=connected <=10s
$e7p = $false; $e7ev = ''
if ($dev -and $dev.deviceId) {
    try {
        $body = @{ deviceId = $dev.deviceId; action = 'rdp'; clip = 1; mic = 0; print = 0; drives = 0 } | ConvertTo-Json -Compress
        $q = Invoke-RestMethod -Uri ($base + '/api/client-cmd?key=' + [uri]::EscapeDataString($DashKey)) -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 8
        $cmdId = [string]$q.cmdId
        $connected = $false
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Seconds 1
            try {
                $st = Invoke-RestMethod -Uri ($base + '/api/agent-status?device=' + [uri]::EscapeDataString($dev.deviceId)) -TimeoutSec 3
                if ($st.stage -eq 'connected') { $connected = $true; break }
            } catch {}
        }
        $mstscN = @(Get-Process mstsc -ErrorAction SilentlyContinue).Count
        $e7p = ($connected -and $mstscN -ge 1)
        $e7ev = 'cmdId=' + $cmdId + ' connected=' + $connected + ' mstscCount=' + $mstscN
    } catch { $e7ev = 'synthetic cmd fail: ' + $_.Exception.Message }
} else { $e7ev = 'no deviceId' }
Add-R 'E7' 'synthetic /api/client-cmd -> stage=connected <=10s' $e7p $e7ev

# E8 - repeat click within 30s
$e8p = $false; $e8ev = ''
if ($dev -and $dev.deviceId -and $e7p) {
    Start-Sleep -Seconds 3
    try {
        $body2 = @{ deviceId = $dev.deviceId; action = 'rdp'; clip = 1 } | ConvertTo-Json -Compress
        $q2 = Invoke-RestMethod -Uri ($base + '/api/client-cmd?key=' + [uri]::EscapeDataString($DashKey)) -Method POST -Body $body2 -ContentType 'application/json' -TimeoutSec 8
        $connected2 = $false
        for ($i = 0; $i -lt 8; $i++) {
            Start-Sleep -Seconds 1
            try {
                $st2 = Invoke-RestMethod -Uri ($base + '/api/agent-status?device=' + [uri]::EscapeDataString($dev.deviceId)) -TimeoutSec 3
                if ($st2.stage -eq 'connected') { $connected2 = $true; break }
            } catch {}
        }
        $mstscN2 = @(Get-Process mstsc -ErrorAction SilentlyContinue).Count
        $e8p = ($connected2 -and $mstscN2 -le 1)
        $e8ev = 'second cmdId=' + $q2.cmdId + ' connected=' + $connected2 + ' mstscCount=' + $mstscN2 + ' (should be <=1: A3 no stacking)'
    } catch { $e8ev = 'repeat cmd fail: ' + $_.Exception.Message }
} else { $e8ev = 'skipped (E7 must pass)' }
Add-R 'E8' 'repeat click within 30s (no stacking)' $e8p $e8ev

Write-Host ''
Write-Host '=== PASS MATRIX ===' -ForegroundColor Cyan
$results | Format-Table -AutoSize -Wrap

if ($anyFail) {
    Write-Host ''
    Write-Host '=== FAIL DUMP ===' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '--- enroll.log (last 40) ---' -ForegroundColor Yellow
    if (Test-Path $enrollLog) { Get-Content $enrollLog -Tail 40 } else { Write-Host '(missing)' }
    Write-Host ''
    Write-Host '--- agent.log (last 40) ---' -ForegroundColor Yellow
    if (Test-Path $agentLog) { Get-Content $agentLog -Tail 40 } else { Write-Host '(missing)' }
    Write-Host ''
    Write-Host '--- HTTP matrix ---' -ForegroundColor Yellow
    foreach ($ep in @('/api/ping','/api/agent.ps1','/api/agent-hash','/api/device-enroll','/api/agent-status?probe=1')) {
        try {
            $r = Invoke-WebRequest -Uri ($base + $ep) -Method Head -UseBasicParsing -TimeoutSec 5
            Write-Host ($ep + ' => ' + [int]$r.StatusCode) -ForegroundColor Green
        } catch { Write-Host ($ep + ' => ' + $_.Exception.Message) -ForegroundColor Red }
    }
    Write-Host ''
    Write-Host '--- reg query ---' -ForegroundColor Yellow
    try { & reg.exe query 'HKCU\Software\Classes\ghrdp\shell\open\command' /ve } catch { Write-Host '(fail)' }
    Write-Host ''
    Write-Host '--- task ---' -ForegroundColor Yellow
    try { Get-ScheduledTask -TaskName 'GhrdpAgent' | Format-List State,Triggers,Actions } catch { Write-Host '(no task)' }
    Write-Host ''
    Write-Host '--- device.json ---' -ForegroundColor Yellow
    if (Test-Path $devJson) { Get-Content $devJson } else { Write-Host '(missing)' }
    Write-Host ''
    Write-Host 'RESULT: FAIL' -ForegroundColor Red
    exit 1
} else {
    Write-Host ''
    Write-Host 'RESULT: ALL PASS' -ForegroundColor Green
    exit 0
}
