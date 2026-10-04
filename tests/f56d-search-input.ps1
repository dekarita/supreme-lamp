# [F56-d/F77 PS lab] SEARCH_INPUT propagation to /diag while visibility stays unconditional
# Validates search_enable input, /diag diagnostics, searchInput echo, and absence of frontend flag writers

$ErrorActionPreference = 'Stop'
Write-Host '[F56-d] SEARCH_INPUT propagation lab'

$mainYml = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'main.yml'
if (-not (Test-Path -LiteralPath $mainYml)) { Write-Host '[F56-d] main.yml not found - SKIP'; exit 0 }

$yml = Get-Content -LiteralPath $mainYml -Raw

# Check search_enable input exists boolean default true (F59)
if ($yml -notmatch 'search_enable:') { throw 'search_enable input missing in main.yml' }
if ($yml -notmatch 'search_enable:') { throw 'search_enable input missing in main.yml' }
$searchBlock = ([regex]::Match($yml, 'search_enable:[\s\S]{0,400}?default:\s*(true|false)')).Groups[1].Value
if ($searchBlock -ne 'true') { throw ('F59: search_enable must be a boolean input defaulting to TRUE, got ' + $searchBlock) }
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

# F77: Search visibility is unconditional; only searchInput is propagated.
$storePath = Join-Path $PSScriptRoot '..' 'src' 'stores' 'sessionStore.ts'
if (Test-Path -LiteralPath $storePath) {
    $store = Get-Content -LiteralPath $storePath -Raw
    if ($store -notmatch '__GHRDP_SEARCH_INPUT') { throw 'searchInput echo missing in sessionStore' }
    if ($store -match '__GHRDP_SEARCH_ENABLED\s*=') { throw 'legacy Search visibility writer remains in sessionStore' }
    Write-Host '[F77] sessionStore preserves searchInput and ignores searchEnabled for visibility'
}

$pollPath = Join-Path $PSScriptRoot '..' 'src' 'hooks' 'useDashboardPolling.ts'
if (Test-Path -LiteralPath $pollPath) {
    $poll = Get-Content -LiteralPath $pollPath -Raw
    if ($poll -notmatch '__GHRDP_SEARCH_INPUT') { throw 'searchInput echo missing in useDashboardPolling' }
    if ($poll -match '__GHRDP_SEARCH_ENABLED\s*=') { throw 'legacy Search visibility writer remains in polling hook' }
    Write-Host '[F77] useDashboardPolling preserves searchInput and ignores searchEnabled for visibility'
}

$lanePath = Join-Path $PSScriptRoot '..' 'src' 'lib' 'search' 'lane.ts'
if (Test-Path -LiteralPath $lanePath) {
    $lane = Get-Content -LiteralPath $lanePath -Raw
    if ($lane -notmatch 'function isSearchLaneEnabled\(\): boolean\s*\{\s*return true;') { throw 'Search lane is not hardcoded enabled' }
    if ($lane -match 'localStorage|sessionStorage|__GHRDP_SEARCH_ENABLED') { throw 'Search lane still reads browser state' }
    Write-Host '[F77] lane helper is hardcoded true with no storage/global read'
}

Write-Host '[F56-d] SEARCH_INPUT propagation lab PASS'
exit 0
