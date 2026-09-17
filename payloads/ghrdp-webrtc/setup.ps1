# setup.ps1 — thin manual wrapper around deploy-bootstrap.ps1.
#
# Kept for local/one-off use. All real logic (workspace discovery, exe discovery
# from the task definition, active-user discovery, stamping, session guard) lives
# in deploy-bootstrap.ps1 so there is exactly ONE deploy path to trust.
#
# Usage: .\setup.ps1 [-GitCommit <sha>]
param(
    [string]$GitCommit = ''
)
$ErrorActionPreference = 'Stop'

$srcDir = $PSScriptRoot
$bootstrap = Join-Path $srcDir 'deploy-bootstrap.ps1'
if (-not (Test-Path $bootstrap)) {
    throw ("deploy-bootstrap.ps1 not found next to setup.ps1 ({0})" -f $srcDir)
}

Write-Host '=== ghrdp-webrtc setup (delegating to deploy-bootstrap.ps1) ==='

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw 'Go is not installed. GitHub Actions windows-latest has Go pre-installed.'
}
Write-Host ("  go: {0}" -f (go version))

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host '  installing FFmpeg...'
    choco install ffmpeg -y --no-progress 2>&1 | Out-Null
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        throw 'FFmpeg installation failed'
    }
}
Write-Host ("  ffmpeg: {0}" -f ((ffmpeg -version 2>&1 | Select-Object -First 1) -replace 'ffmpeg version ', ''))

$repoRoot = Split-Path (Split-Path $srcDir -Parent) -Parent
& $bootstrap -RepoRoot $repoRoot -GitCommit $GitCommit
$rc = $LASTEXITCODE

if ($rc -ne 0) {
    Write-Host ("!!! deploy-bootstrap exited {0} - check C:\ghrdp\webrtc\deploy.log" -f $rc)
    Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 10 2>$null |
        Where-Object { $_.Message -match 'GhrdpWebRTC' } |
        ForEach-Object { Write-Host ("  {0}: {1}" -f $_.TimeCreated, $_.Message.Substring(0, [Math]::Min(200, $_.Message.Length))) }
    exit $rc
}

Write-Host '=== WebRTC server deployed (see /version on :8080) ==='
exit 0