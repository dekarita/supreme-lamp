# setup.ps1 — Build and deploy ghrdp-webrtc on the runner
# Usage: .\setup.ps1 [-User <rdp_username>]
# Must run from the ghrdp-webrtc source directory
param(
    [string]$User = ''
)
$ErrorActionPreference = 'Stop'

$srcDir    = $PSScriptRoot
$deployDir = 'C:\ghrdp\webrtc'
$binPath   = Join-Path $deployDir 'webrtc-server.exe'
$staticDst = Join-Path $deployDir 'static'

Write-Host '=== ghrdp-webrtc setup ==='

# Resolve active interactive user for the scheduled task
if (-not $User) {
    try {
        $qu = & quser.exe 2>$null; $LASTEXITCODE = 0
        foreach ($line in @($qu)) {
            if ($line -match '^\s*(>?)\s*(\S+)\s+\S+\s+(\d+)\s+Active') { $User = $Matches[2] }
        }
    } catch { }
}
if (-not $User) { $User = $env:RDP_USER }
if (-not $User) { $User = $env:USERNAME }
Write-Host "  user: $User"

# 1. Install FFmpeg
Write-Host '[1/5] Installing FFmpeg...'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    choco install ffmpeg -y --no-progress 2>&1 | Out-Null
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        throw 'FFmpeg installation failed'
    }
}
Write-Host "  ffmpeg: $(ffmpeg -version 2>&1 | Select-Object -First 1)"

# 2. Verify Go
Write-Host '[2/5] Checking Go...'
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw 'Go is not installed. GitHub Actions windows-latest has Go pre-installed.'
}
Write-Host "  go: $(go version)"

# 3. Build
Write-Host '[3/5] Building...'
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null
Push-Location $srcDir
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    go get github.com/pion/webrtc/v3@latest 2>&1
    go get github.com/gorilla/websocket@latest 2>&1
    go mod tidy 2>&1
    go build -ldflags='-s -w' -o $binPath .
    if ($LASTEXITCODE -ne 0) { throw "go build failed (exit $LASTEXITCODE)" }
    Write-Host "  built: $binPath ($(((Get-Item $binPath).Length / 1MB).ToString('F1')) MB)"
} finally {
    Pop-Location
}

# 4. Deploy static files
Write-Host '[4/5] Deploying static files...'
New-Item -ItemType Directory -Path $staticDst -Force | Out-Null
Copy-Item -Path (Join-Path $srcDir 'static\*') -Destination $staticDst -Recurse -Force
Write-Host "  static: $staticDst"

# 5. Register scheduled task with Interactive principal (same pattern as GhrdpWebDesk)
Write-Host '[5/5] Registering scheduled task...'
$taskName = 'GhrdpWebRTC'

try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }

$action   = New-ScheduledTaskAction -Execute $binPath -WorkingDirectory $deployDir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null

Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# Verify
$resp = try { Invoke-WebRequest -Uri 'http://localhost:8080/health' -TimeoutSec 5 -UseBasicParsing } catch { $null }
if ($resp -and $resp.StatusCode -eq 200) {
    Write-Host '=== WebRTC server is running on :8080 ==='
} else {
    Write-Host '!!! Server did not respond on :8080 — check task logs'
    Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 5 2>$null |
        Where-Object { $_.Message -match 'GhrdpWebRTC' } |
        ForEach-Object { Write-Host "  $($_.TimeCreated): $($_.Message.Substring(0, [Math]::Min(200, $_.Message.Length)))" }
}
