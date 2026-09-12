$ErrorActionPreference = 'Continue'
$lines = New-Object System.Collections.ArrayList
function Add-DbgLine { param([string]$Text) [void]$lines.Add([string]$Text) }
$root = 'C:\ghrdp'
Add-DbgLine ('GHRDP DEBUG REPORT - ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
foreach ($pn in @(7331, 7332)) {
    $listen = $null
    try { $listen = Get-NetTCPConnection -LocalPort $pn -State Listen -ErrorAction SilentlyContinue } catch { }
    if ($listen) { Add-DbgLine ('port ' + $pn + ': LISTENING (pid ' + (@($listen)[0]).OwningProcess + ')') } else { Add-DbgLine ('port ' + $pn + ': NOT LISTENING') }
}
foreach ($tn in @('GhrdpServer', 'GhrdpRustDash', 'GhrdpWatcher')) {
    $st = 'not found'
    try { $t = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue; if ($t) { $st = [string]$t.State } } catch { }
    Add-DbgLine ('task ' + $tn + ': ' + $st)
}
$lines | ForEach-Object { Write-Host $_ }
