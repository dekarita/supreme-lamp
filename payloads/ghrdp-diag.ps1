# ghrdp-diag.ps1 v3 — D0 pre-change client diagnostic. Read-only. No mutation.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ghrdp-diag.ps1 -Runner <ip>
# Prints table with rows R1-R6. Copy the whole output back into the maintainer thread.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Runner
)
$ErrorActionPreference = 'Continue'

$agentDir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
$agentPs  = Join-Path $agentDir 'agent.ps1'
$devJson  = Join-Path $agentDir 'device.json'
$enrollLog= Join-Path $agentDir 'enroll.log'
$agentLog = Join-Path $agentDir 'agent.log'
$base     = 'http://' + $Runner + ':7331'
$rows     = New-Object System.Collections.ArrayList

function Add-Row { param($id,$name,$status,$detail)
    [void]$script:rows.Add([pscustomobject]@{ ID=$id; Row=$name; Status=$status; Detail=$detail })
}

Write-Host ('=== GHRDP DIAG v3 against ' + $Runner + ' ===')

# R1 — tokenize local agent.ps1
$r1s = 'MISS'; $r1d = ''
if (Test-Path $agentPs) {
    try {
        $t = Get-Content $agentPs -Raw
        $e = $null
        [void][System.Management.Automation.PSParser]::Tokenize($t, [ref]$e)
        if ($e -and $e.Count) { $r1s = 'FAIL'; $r1d = ($e.Count.ToString() + ' errors; first line ' + $e[0].Token.StartLine + ' ' + $e[0].Message) }
        else { $r1s = 'PASS'; $r1d = ('size=' + $t.Length) }
    } catch { $r1s = 'FAIL'; $r1d = $_.Exception.Message }
} else { $r1d = $agentPs + ' missing' }
Add-Row 'R1' 'local agent.ps1 parses' $r1s $r1d

# R2 — tokenize served /api/agent.ps1
$r2s = 'FAIL'; $r2d = ''
$tmp = Join-Path $env:TEMP 'ghrdp-served.ps1'
try {
    Invoke-WebRequest -Uri ($base + '/api/agent.ps1') -OutFile $tmp -UseBasicParsing -TimeoutSec 10
    $t2 = Get-Content $tmp -Raw
    $e2 = $null
    [void][System.Management.Automation.PSParser]::Tokenize($t2, [ref]$e2)
    if ($e2 -and $e2.Count) { $r2s = 'FAIL'; $r2d = ($e2.Count.ToString() + ' errors; first line ' + $e2[0].Token.StartLine + ' ' + $e2[0].Message) }
    else { $r2s = 'PASS'; $r2d = ('size=' + $t2.Length) }
} catch { $r2d = $_.Exception.Message }
Add-Row 'R2' 'served agent.ps1 parses' $r2s $r2d

# R3 — sha256 local vs /api/agent-hash
$r3s = 'FAIL'; $r3d = ''
try {
    $local = ''
    if (Test-Path $agentPs) { $local = (Get-FileHash -LiteralPath $agentPs -Algorithm SHA256).Hash.ToLower() }
    $srvHash = ''
    try { $h = Invoke-RestMethod -Uri ($base + '/api/agent-hash') -TimeoutSec 5; $srvHash = [string]$h.sha256 } catch { $r3d = 'agent-hash fetch failed: ' + $_.Exception.Message }
    if ($local -and $srvHash) {
        if ($local -eq $srvHash.ToLower()) { $r3s = 'PASS'; $r3d = ('sha=' + $local.Substring(0,16)) }
        else { $r3s = 'DRIFT'; $r3d = ('local=' + $local.Substring(0,12) + ' remote=' + $srvHash.Substring(0,12)) }
    } elseif ($srvHash) { $r3s = 'NO-LOCAL'; $r3d = 'remote=' + $srvHash.Substring(0,16) }
} catch { $r3d = $_.Exception.Message }
Add-Row 'R3' 'sha local vs /api/agent-hash' $r3s $r3d

# R4 — inspect corrupt region if R1 or R2 failed
$r4s = 'SKIP'; $r4d = ''
if ($r1s -eq 'FAIL' -or $r2s -eq 'FAIL') {
    $r4s = 'INFO'
    $src = $agentPs; if ($r1s -eq 'PASS' -and $r2s -eq 'FAIL') { $src = $tmp }
    try {
        $lines = Get-Content -LiteralPath $src
        $errList = @()
        $e = $null
        [void][System.Management.Automation.PSParser]::Tokenize((Get-Content $src -Raw), [ref]$e)
        if ($e -and $e.Count) {
            foreach ($er in $e | Select-Object -First 3) {
                $ln = [int]$er.Token.StartLine
                $start = [Math]::Max(1, $ln - 1); $end = [Math]::Min($lines.Count, $ln + 1)
                for ($i = $start; $i -le $end; $i++) { $errList += ('L' + $i + ': ' + $lines[$i-1]) }
            }
        }
        $r4d = ($errList -join ' | ')
        if ($r4d.Length -gt 400) { $r4d = $r4d.Substring(0,400) + '...' }
    } catch { $r4d = $_.Exception.Message }
}
Add-Row 'R4' 'corrupt-region excerpt' $r4s $r4d

# R5 — reg / task / loop procs / logs
$r5detail = @()
$reg = ''
try { $reg = [string](Get-ItemProperty 'HKCU:\Software\Classes\ghrdp\shell\open\command' -Name '(default)' -ErrorAction Stop).'(default)' } catch { $reg = '(none)' }
$r5detail += ('reg=' + ($(if ($reg.Length -gt 120) { $reg.Substring(0,120) + '...' } else { $reg })))
$taskState = ''
try { $t = Get-ScheduledTask -TaskName 'GhrdpAgent' -ErrorAction Stop; $taskState = $t.State.ToString() } catch { $taskState = 'MISSING' }
$r5detail += ('task=' + $taskState)
$loopCount = 0
try { $loopCount = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match [regex]::Escape('agent.ps1') -and $_.CommandLine -match '-Loop' }).Count } catch {}
$r5detail += ('loop-procs=' + $loopCount)
$enrollAge = -1; $agentAge = -1
if (Test-Path $enrollLog) { $enrollAge = [int]((Get-Date) - (Get-Item $enrollLog).LastWriteTime).TotalSeconds }
if (Test-Path $agentLog)  { $agentAge  = [int]((Get-Date) - (Get-Item $agentLog).LastWriteTime).TotalSeconds }
$r5detail += ('enrollLog-age=' + $enrollAge + 's agentLog-age=' + $agentAge + 's')
Add-Row 'R5' 'reg/task/loops/logs' 'INFO' ($r5detail -join ' | ')

# R6 — runner matrix
$r6detail = @()
foreach ($ep in @('/api/ping','/api/agent-hash','/api/agent.ps1')) {
    try {
        $method = 'GET'
        $r = Invoke-WebRequest -Uri ($base + $ep) -Method $method -UseBasicParsing -TimeoutSec 5
        $r6detail += ($ep + '=' + [int]$r.StatusCode)
    } catch { $r6detail += ($ep + '=' + $_.Exception.Message) }
}
try {
    $probe = Invoke-RestMethod -Uri ($base + '/api/agent-status?probe=1') -TimeoutSec 5
    $r6detail += ('probe.count=' + $probe.count)
} catch { $r6detail += ('probe=' + $_.Exception.Message) }
Add-Row 'R6' 'runner matrix' 'INFO' ($r6detail -join ' | ')

$rows | Format-Table -AutoSize -Wrap

$fails = @($rows | Where-Object { $_.Status -eq 'FAIL' })
if ($fails.Count) {
    Write-Host ''
    Write-Host ('DIAG: ' + $fails.Count + ' FAIL rows — investigate before shipping') -ForegroundColor Red
    exit 1
}
Write-Host ''
Write-Host 'DIAG: no FAIL rows (INFO/DRIFT are advisory)' -ForegroundColor Green
exit 0
