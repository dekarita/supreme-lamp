# F92 §2.1: register the user-session scheduled task that owns ghrdp-server.
# Called from main.yml BEFORE the Tailscale/sign-in bootstrap (and long before
# any RDP logon fires). Because the task runs as runneradmin with LogonType
# Interactive and an ONLOGON trigger, the dashboard server starts INSIDE the
# user's session (Session 1) - which is what retires the cross-session launch
# ladder as the primary path (see Invoke-F86LaunchUrl, F92 fast path).
param(
    [string]$ServerPath = 'C:\ProgramData\ghrdp\ghrdp-server.ps1',
    [string]$TaskUser   = 'runneradmin'
)
$ErrorActionPreference = 'Stop'
$TaskName = 'GHRDP-Server'

if (-not (Test-Path -LiteralPath $ServerPath)) {
    # Never register a task pointing at a missing file: AtLogOn would start a
    # ghost powershell every sign-in and the failure only surfaces in the
    # /#/health launcher row. Fail LOUD at registration time instead.
    Write-Host ("[f92] register-ghrdp-task: MISSING script " + $ServerPath)
    Write-Host '[f92] main.yml stages payloads/ghrdp-server.ps1 there before this step; run via the workflow or copy the file manually.'
    exit 1
}

$Action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ServerPath`""
$Trigger   = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
$Principal = New-ScheduledTaskPrincipal -UserId $TaskUser `
             -LogonType Interactive -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries `
             -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
             -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName `
             -Action $Action -Trigger $Trigger `
             -Principal $Principal -Settings $Settings -Force | Out-Null

Write-Host "F92 ScheduledTask $TaskName registered for $TaskUser."
