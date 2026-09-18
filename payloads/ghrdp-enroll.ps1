# ghrdp-enroll.ps1 — One-time enrollment for the GHRDP pull-model persistent agent.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ghrdp-enroll.ps1 -RunnerIp <ip> [-PagesUrl <url>]
# No admin required. All state under HKCU + %LOCALAPPDATA%. See HARD TRUTHS T2/#46/#49.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RunnerIp,
    [string]$PagesUrl = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# System32 powershell.exe — NEVER WindowsApps stub (T2/#46).
$PwshSys = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$AgentDir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
$AgentPs1 = Join-Path $AgentDir 'agent.ps1'
$DeviceJson = Join-Path $AgentDir 'device.json'
$LogPath = Join-Path $AgentDir 'enroll.log'
$TaskName = 'GhrdpAgent'
$BaseUrl = "http://${RunnerIp}:7331"

function Log([string]$m) {
    $ln = "{0} {1}" -f (Get-Date -Format o), $m
    try { Add-Content -LiteralPath $LogPath -Value $ln -ErrorAction SilentlyContinue } catch {}
    Write-Host $ln
}

try {
    if (-not (Test-Path $AgentDir)) { New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null }
    Log "== GHRDP enrollment starting, runner=$RunnerIp =="

    # Step 1 — kill old mstsc / handler processes; unregister old ghrdp:// artifacts.
    Get-Process -Name mstsc, ghrdp-launcher, ghrdp-connect -ErrorAction SilentlyContinue |
        ForEach-Object { try { $_ | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
    foreach ($k in 'HKCU:\Software\Classes\ghrdp', 'HKCU:\Software\Classes\ghrdp-old') {
        if (Test-Path $k) { try { Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
    }
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}

    # Step 3+4 — fetch agent.ps1 from runner.
    Log "Fetching agent.ps1 from $BaseUrl/api/agent.ps1"
    Invoke-WebRequest -Uri "$BaseUrl/api/agent.ps1" -OutFile $AgentPs1 -UseBasicParsing -TimeoutSec 20
    try { Unblock-File -LiteralPath $AgentPs1 -ErrorAction SilentlyContinue } catch {}
    if (-not (Test-Path $AgentPs1) -or (Get-Item $AgentPs1).Length -lt 128) {
        throw "agent.ps1 fetch failed or too small"
    }

    # Step 5+6 — deviceId and device-enroll POST.
    $deviceId = [guid]::NewGuid().ToString('N')
    $enrollBody = @{
        deviceId = $deviceId
        name     = $env:COMPUTERNAME
        os       = "$([System.Environment]::OSVersion.Version)"
    } | ConvertTo-Json -Compress
    Log "POST /api/device-enroll deviceId=$deviceId"
    $resp = Invoke-RestMethod -Uri "$BaseUrl/api/device-enroll" -Method Post -Body $enrollBody `
        -ContentType 'application/json' -TimeoutSec 20
    $deviceToken = [string]$resp.deviceToken
    if ([string]::IsNullOrWhiteSpace($deviceToken)) { throw "server returned no deviceToken" }

    # Step 7 — device.json.
    $dev = [ordered]@{
        deviceId     = $deviceId
        deviceToken  = $deviceToken
        lastRunner   = $RunnerIp
        runnersCache = @($RunnerIp)
        pagesUrl     = $PagesUrl
        enrolledAt   = (Get-Date).ToUniversalTime().ToString('o')
    }
    $dev | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $DeviceJson -Encoding UTF8

    # Step 8 — HKCU ghrdp:// protocol handler → System32 powershell + hidden window (T2/#46/#49).
    $cmdKey = 'HKCU:\Software\Classes\ghrdp\shell\open\command'
    New-Item -Path 'HKCU:\Software\Classes\ghrdp' -Force | Out-Null
    New-ItemProperty -Path 'HKCU:\Software\Classes\ghrdp' -Name '(default)' -Value 'URL:GHRDP Protocol' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path 'HKCU:\Software\Classes\ghrdp' -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    New-Item -Path $cmdKey -Force | Out-Null
    $cmdLine = "`"$PwshSys`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentPs1`" -Dispatch `"%1`""
    Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $cmdLine

    # Step 9 — scheduled task AtLogOn + one-shot in 5s (immediate start after enrollment).
    $taskArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentPs1`" -Poll"
    $action = New-ScheduledTaskAction -Execute $PwshSys -Argument $taskArgs
    $trigLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $trigOnce = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(5))
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigLogon, $trigOnce) `
        -Principal $principal -Settings $settings -Force | Out-Null

    # Step 10 — arm HKCU trust keys (silence 25H2 reputation nags where legally possible).
    $termsrv = 'HKCU:\Software\Microsoft\Terminal Server Client\LocalDevices'
    New-Item -Path $termsrv -Force | Out-Null
    New-ItemProperty -Path $termsrv -Name '*' -Value 0xC5 -PropertyType DWord -Force | Out-Null
    $tsc = 'HKCU:\Software\Microsoft\Terminal Server Client'
    New-ItemProperty -Path $tsc -Name 'AuthenticationLevelOverride' -Value 0 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $tsc -Name 'PublisherBypassList' -Value '*' -PropertyType String -Force | Out-Null
    $zone3 = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\3'
    if (-not (Test-Path $zone3)) { New-Item -Path $zone3 -Force | Out-Null }
    New-ItemProperty -Path $zone3 -Name '1806' -Value 0 -PropertyType DWord -Force | Out-Null

    # Step 11 — nuke legacy connector.
    $legacy = Join-Path $env:LOCALAPPDATA 'ghrdp\ghrdp-connect.ps1'
    if (Test-Path $legacy) { try { Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue } catch {} }

    # Step 12 — kick the task now so agent is polling before user clicks the dashboard button.
    try { Start-ScheduledTask -TaskName $TaskName } catch { Log "Start-ScheduledTask warn: $_" }

    Log "OK: deviceId=$deviceId regPath=$cmdKey task=$TaskName"
    Write-Host ''
    Write-Host 'GHRDP AGENT ENROLLED' -ForegroundColor Green
    Write-Host "  deviceId : $deviceId"
    Write-Host "  runner   : $RunnerIp"
    Write-Host "  agent    : $AgentPs1"
    Write-Host "  log      : $LogPath"
    Write-Host ''
    Write-Host 'Click AUTO-LOGIN in the dashboard now — no more prompts.' -ForegroundColor Cyan
    exit 0
}
catch {
    Log "FATAL: $_"
    Write-Host ''
    Write-Host "GHRDP ENROLLMENT FAILED: $_" -ForegroundColor Red
    Write-Host "  log: $LogPath"
    exit 1
}
