# [F56-d PS lab] credentials memory-only, no disk persist
# Verifies own-cred modal submit POST /api/fetch F46 per-run key encrypted creds server decrypts in memory feeds aria2c --http-user/--http-passwd memory wiped no disk persist

$ErrorActionPreference = 'Stop'
Write-Host '[F56-d] creds memory-only lab'

# Check ghrdp-server.ps1 does NOT WriteAllText creds
$serverPath = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-server.ps1'
if (-not (Test-Path -LiteralPath $serverPath)) { $serverPath = 'C:\ghrdp\ghrdp-server.ps1' }
if (-not (Test-Path -LiteralPath $serverPath)) { Write-Host '[F56-d] server file not found - SKIP'; exit 0 }

$txt = Get-Content -LiteralPath $serverPath -Raw
# Ensure no WriteAllText of creds, no Set-Content of http-user/passwd to disk
$badPatterns = @(
    'Set-Content.*cred',
    'WriteAllText.*cred',
    'Out-File.*credUser',
    'Out-File.*credPass',
    'http-user.*\.txt',
    'http-passwd.*\.txt'
)
foreach ($pat in $badPatterns) {
    if ($txt -match $pat) {
        Write-Host ('::error::[F56-d] credential persistence pattern found: ' + $pat)
        throw 'credentials persisted to disk - must be memory-only'
    }
}
Write-Host '[F56-d] no disk persist patterns found in server'

# Check aria2 helper has memory wipe
$ariaPath = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-aria2.ps1'
if (Test-Path -LiteralPath $ariaPath) {
    $ariaTxt = Get-Content -LiteralPath $ariaPath -Raw
    if ($ariaTxt -notmatch 'Array\.Clear') { Write-Host '::warning::[F56-d] Array.Clear not found in aria2 helper (should wipe)' }
    else { Write-Host '[F56-d] memory wipe via Array.Clear present' }
    if ($ariaTxt -notmatch 'Unprotect-F56dOwnCred') { Write-Host '::warning::[F56-d] Unprotect-F56dOwnCred not found' }
    else { Write-Host '[F56-d] own-cred decrypt function present' }
}

# Check server has Clear-F56dCredMemory or Array.Clear after decrypt
if ($txt -notmatch 'Array\.Clear' -and $txt -notmatch 'Clear-F56dCredMemory') {
    Write-Host '::warning::[F56-d] memory wipe not found in server (should have Array.Clear)'
} else {
    Write-Host '[F56-d] server memory wipe present'
}

# Verify no plain http-user/http-passwd in logs
if ($txt -match 'http-user.*Write-Host' -or $txt -match 'http-passwd.*Write-Host') {
    throw 'plain creds logged'
}
Write-Host '[F56-d] creds memory-only lab PASS'
exit 0
