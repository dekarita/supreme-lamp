# verify-ghrdp.ps1 — client-side v3 install + runtime PASS matrix
# Run once by dev (NOT by end user). Asserts A1-A6 acceptance criteria.
# Usage: .\verify-ghrdp.ps1 -RunnerIp <tailnet-ip>
param(
    [Parameter(Mandatory=$true)][string]$RunnerIp,
    [int]$Port = 7331
)
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.ArrayList
function Add-Result { param([string]$Name, [bool]$Pass, [string]$Detail = '')
    $mark = if ($Pass) { 'PASS' } else { 'FAIL' }
    [void]$results.Add([pscustomobject]@{ Test = $Name; Result = $mark; Detail = $detail })
    Write-Host ("[{0}] {1} — {2}" -f $mark, $Name, $Detail)
}

Write-Host "`n=== GHRDP v3 verification against $RunnerIp:$Port ===" -ForegroundColor Cyan

# A0 – handler registry
$cmdKey = 'HKCU:\Software\Classes\ghrdp\shell\open\command'
$hasCmd = Test-Path $cmdKey
$cmdVal = ''
if ($hasCmd) { try { $cmdVal = (Get-ItemProperty $cmdKey).'(default)' } catch { } }
Add-Result 'handler-registered' $hasCmd $cmdVal
Add-Result 'window-style-hidden' ($cmdVal -match '-WindowStyle\s+Hidden') 'reg command must include -WindowStyle Hidden'

# A0 – old handler purged
$oldPath = Join-Path $env:LOCALAPPDATA 'ghrdp\ghrdp-connect.ps1'
Add-Result 'old-handler-purged' (-not (Test-Path $oldPath)) $oldPath

# A0 – new launcher present
$newPath = Join-Path $env:LOCALAPPDATA 'GhrdpLauncher\launch.ps1'
Add-Result 'new-launcher-installed' (Test-Path $newPath) $newPath

# A0 – trust key
$trustPath = 'HKCU:\Software\Microsoft\Terminal Server Client\LocalDevices'
$trustVal = 0
try { $trustVal = (Get-ItemProperty $trustPath -Name $RunnerIp -ErrorAction Stop).$RunnerIp } catch { }
Add-Result 'localdevices-armed' ($trustVal -gt 0) ("LocalDevices\$RunnerIp = 0x{0:X}" -f $trustVal)

# A0 – server /api/rdp-token responsive
$tok = $null
try {
    $tr = Invoke-RestMethod -Uri "http://${RunnerIp}:${Port}/api/rdp-token" -Method POST -TimeoutSec 5
    $tok = $tr.token
} catch { }
Add-Result 'server-token-endpoint' ([bool]$tok) ("token=" + $(if ($tok) { $tok.Substring(0,8) + '...' } else { 'NONE' }))

# A1 – invoke ghrdp:// and time to mstsc
if ($tok) {
    Write-Host "`n-- Invoking ghrdp:// with fresh token --" -ForegroundColor Yellow
    $testUrl = "ghrdp://connect?server=$RunnerIp&port=$Port&token=$tok&clip=1&mic=0&printers=0&drives=1"
    Get-Process mstsc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    $t0 = Get-Date
    Start-Process $testUrl
    $mstsc = $null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 100
        $mstsc = Get-Process mstsc -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($mstsc) { break }
    }
    $elapsedMs = [int]((Get-Date) - $t0).TotalMilliseconds
    Add-Result 'mstsc-spawned' ([bool]$mstsc) ("mstsc PID=$($mstsc.Id) in ${elapsedMs}ms")
    Add-Result 'sub-3s' ($elapsedMs -le 3000) "${elapsedMs}ms ≤ 3000ms budget"

    # A1 – UIAutomation: no warning dialog with "I understand" or blank Computer
    Start-Sleep -Seconds 2
    $badDialog = $false
    try {
        Add-Type -AssemblyName UIAutomationClient
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $condDialog = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)
        $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condDialog)
        foreach ($w in $wins) {
            $nm = $w.Current.Name
            if ($nm -match 'I understand' -or $nm -match 'Publisher .*could not be verified' -or $nm -match 'Windows Security' -or $nm -match 'Remote Desktop Connection' -and $nm -match 'accept') {
                $badDialog = $true
                break
            }
        }
    } catch { }
    Add-Result 'no-warning-dialog' (-not $badDialog) 'UIAutomation scan for I-understand/publisher/security prompts'

    # A2 – cmdkey entry exists
    $ck = & cmdkey /list 2>$null | Select-String "TERMSRV/$RunnerIp"
    Add-Result 'cmdkey-armed' ([bool]$ck) $ck

    # A5 – last.log clean
    $logFile = Join-Path $env:LOCALAPPDATA 'GhrdpLauncher\last.log'
    $logOK = $false
    if (Test-Path $logFile) {
        $log = Get-Content $logFile -Raw
        $logOK = ($log -match 'launch complete' -and -not ($log -match 'FATAL'))
    }
    Add-Result 'last-log-clean' $logOK "log tail: $(if (Test-Path $logFile) { (Get-Content $logFile | Select-Object -Last 1) } else { '<no log>' })"

    # A1 – rdp-status logon ≤30s
    Start-Sleep -Seconds 6
    $rs = $null
    try { $rs = Invoke-RestMethod -Uri "http://${RunnerIp}:${Port}/api/rdp-status" -TimeoutSec 5 } catch { }
    $logonOK = ($rs -and $rs.rdp_age_s -ge 0 -and $rs.rdp_age_s -le 30)
    Add-Result 'rdp-logon-fresh' $logonOK "rdp_age_s=$($rs.rdp_age_s) logon_type=$($rs.logon_type)"
}

# A0 – launcher-status
try {
    $ls = Invoke-RestMethod -Uri "http://${RunnerIp}:${Port}/api/launcher-status" -TimeoutSec 5
    Add-Result 'launcher-hello-seen' ($ls.ver -ge 3 -and $ls.ageSeconds -ge 0 -and $ls.ageSeconds -lt 60) "ver=$($ls.ver) age=$($ls.ageSeconds)s"
} catch { Add-Result 'launcher-hello-seen' $false 'endpoint unreachable' }

Write-Host "`n=== PASS MATRIX ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' })
if ($failed.Count -eq 0) {
    Write-Host "`nALL GREEN — v3 is production ready on this client." -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n$($failed.Count) test(s) failed. Fix before shipping." -ForegroundColor Red
    exit 1
}
