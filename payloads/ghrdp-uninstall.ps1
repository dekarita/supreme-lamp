# GHRDP client uninstall - idempotent, safe to run multiple times.
# Removes the agent scheduled task, startup/Run persistence, ghrdp:// protocol handler,
# agent logs/state, and any TERMSRV credential-manager entries created for RDP.
param()
$ErrorActionPreference = 'Continue'
Write-Host '[uninstall] GHRDP client uninstall starting'

# Remove scheduled task
try {
    $t = Get-ScheduledTask -TaskName 'GhrdpAgent' -ErrorAction SilentlyContinue
    if ($t) { Unregister-ScheduledTask -TaskName 'GhrdpAgent' -Confirm:$false -ErrorAction Stop; Write-Host '[uninstall] task GhrdpAgent removed' }
} catch { Write-Host '[uninstall] task removal skipped (not present or already removed)' }

# Remove startup folder shortcut
$startupLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\GhrdpAgent.lnk'
if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force; Write-Host '[uninstall] startup shortcut removed' }

# Remove HKCU Run value
try {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $val = Get-ItemProperty -Path $runKey -Name 'GhrdpAgent' -ErrorAction SilentlyContinue
    if ($val) { Remove-ItemProperty -Path $runKey -Name 'GhrdpAgent' -Force; Write-Host '[uninstall] HKCU Run value removed' }
} catch { Write-Host '[uninstall] HKCU Run value skipped (not present)' }

# Remove HKCU protocol handler
try {
    $protoKey = 'HKCU:\Software\Classes\ghrdp'
    if (Test-Path $protoKey) { Remove-Item $protoKey -Recurse -Force; Write-Host '[uninstall] ghrdp:// protocol handler removed' }
} catch { Write-Host '[uninstall] protocol handler skipped' }

# Remove agent logs and state
$agentDir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
if (Test-Path $agentDir) {
    Remove-Item $agentDir -Recurse -Force
    Write-Host '[uninstall] agent directory removed'
}

# Remove TERMSRV credential-manager entries (cleanup only; the agent no longer stashes these)
try {
    $list = & cmdkey /list 2>$null
    foreach ($line in $list) {
        if ($line -match 'Target:\s+TERMSRV/(.+)') {
            $thost = $Matches[1].Trim()
            & cmdkey /delete:"TERMSRV/$thost" 2>$null | Out-Null
            Write-Host "[uninstall] credential entry removed for $thost"
        }
    }
} catch { Write-Host '[uninstall] credential cleanup skipped' }

Write-Host '[uninstall] complete (idempotent, safe to run again)'
exit 0
