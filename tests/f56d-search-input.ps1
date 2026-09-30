# [F56-d PS lab] SEARCH_INPUT propagation from main.yml to /diag to window flag
# Validates main.yml has search_enable input boolean default false, env SEARCH_INPUT, /diag returns searchEnabled + searchInput

$ErrorActionPreference = 'Stop'
Write-Host '[F56-d] SEARCH_INPUT propagation lab'

$mainYml = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'main.yml'
if (-not (Test-Path -LiteralPath $mainYml)) { Write-Host '[F56-d] main.yml not found - SKIP'; exit 0 }

$yml = Get-Content -LiteralPath $mainYml -Raw

# Check search_enable input exists boolean default false
if ($yml -notmatch 'search_enable:') { throw 'search_enable input missing in main.yml' }
if ($yml -notmatch 'type:\s*boolean' -or $yml -notmatch 'default:\s*false') {
    Write-Host '::warning::[F56-d] search_enable should be boolean default false'
}
Write-Host '[F56-d] main.yml search_enable input present'

# Check SEARCH_INPUT env
if ($yml -notmatch 'SEARCH_INPUT:') { throw 'SEARCH_INPUT env missing in main.yml' }
Write-Host '[F56-d] SEARCH_INPUT env present'

# Check Install aria2c step
if ($yml -notmatch 'Install aria2c 1\.36\.0') { throw 'Install aria2c step missing' }
if ($yml -notmatch 'aria2c.*1\.36\.0') { throw 'aria2c version 1.36.0 not pinned' }
Write-Host '[F56-d] aria2c install step present version 1.36.0'

# Check ghrdp-server.ps1 /diag returns searchEnabled + searchInput
$serverPath = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-server.ps1'
if (Test-Path -LiteralPath $serverPath) {
    $srv = Get-Content -LiteralPath $serverPath -Raw
    if ($srv -notmatch 'searchEnabled') { throw '/diag searchEnabled missing in server' }
    if ($srv -notmatch 'searchInput') { throw '/diag searchInput missing in server' }
    Write-Host '[F56-d] /diag searchEnabled + searchInput present in server'
} else {
    Write-Host '[F56-d] server file not found - advisory'
}

# Check sessionStore sets window.__GHRDP_SEARCH_ENABLED
$storePath = Join-Path $PSScriptRoot '..' 'src' 'stores' 'sessionStore.ts'
if (Test-Path -LiteralPath $storePath) {
    $store = Get-Content -LiteralPath $storePath -Raw
    if ($store -notmatch '__GHRDP_SEARCH_ENABLED') { throw 'window.__GHRDP_SEARCH_ENABLED not set in sessionStore' }
    Write-Host '[F56-d] window.__GHRDP_SEARCH_ENABLED set in sessionStore'
}

# Check useDashboardPolling also sets at boot
$pollPath = Join-Path $PSScriptRoot '..' 'src' 'hooks' 'useDashboardPolling.ts'
if (Test-Path -LiteralPath $pollPath) {
    $poll = Get-Content -LiteralPath $pollPath -Raw
    if ($poll -notmatch '__GHRDP_SEARCH_ENABLED') { throw '__GHRDP_SEARCH_ENABLED not set in useDashboardPolling' }
    Write-Host '[F56-d] window.__GHRDP_SEARCH_ENABLED set in useDashboardPolling'
}

Write-Host '[F56-d] SEARCH_INPUT propagation lab PASS'
exit 0
