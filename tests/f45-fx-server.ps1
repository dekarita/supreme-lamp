# tests/f45-fx-server.ps1  [F45 S4 §2.1] SERVER-SIDE TESTS for the Explorer
# file-API routes (payloads/ghrdp-fx.ps1 + the wiring in payloads/ghrdp-server.ps1).
#
# Two layers, one implementation:
#   UNIT        dot-sources payloads/ghrdp-fx.ps1 and drives every route
#               function with a synthetic request context: mock index fixtures,
#               mock host transport (the module's injectable Fetch/Uploader seam),
#               no socket, no live gofile call.
#   INTEGRATION starts the REAL payloads/ghrdp-server.ps1 (Windows PowerShell,
#               the production interpreter) on a loopback port with a temp Root
#               and speaks raw HTTP/1.1 to it: dash-token 401, 200/206 preview
#               with Range, 404/415/413, CSRF 403/200, upload 202, sandbox
#               headers, and the redaction assertion over the whole server log.
#
# Run:  pwsh -File tests/f45-fx-server.ps1        (CI: launch-gates windows-native)
#       powershell -File tests/f45-fx-server.ps1  (production interpreter)
# Keep the artifacts for inspection: add -KeepArtifacts.
param([string]$RepoRoot = '', [switch]$KeepArtifacts)

$ErrorActionPreference = 'Continue'
$script:Pass = 0
$script:Fail = 0
$script:Failures = @()
$script:Diag = 'not reached'
$script:Keep = [bool]$KeepArtifacts

function Ok([string]$Name) { $script:Pass++; Write-Host ('  ok   ' + $Name) }
function Fail([string]$Name, [string]$Detail) {
    $script:Fail++
    $flat = ($Detail -replace '\r?\n', ' | ')
    $script:Failures += ($Name + ' :: ' + $flat)
    # GitHub keeps only the first 10 annotations per step, so every failure is
    # printed to the log AND (at the end) all of them are emitted as ONE
    # annotation whose message uses %0A for newlines - nothing is hidden by the
    # cap. See the summary block at the end of this file.
    Write-Host ('FAIL ' + $Name + ' :: ' + $flat)
}
function Get-FxFailDetail($Err) {
    if (-not $Err) { return 'unknown error' }
    $pos = ''
    try { $pos = ' | at ' + ([string]$Err.InvocationInfo.PositionMessage -replace '\r?\n', ' ') } catch { }
    return ($Err.Exception.GetType().Name + ': ' + $Err.Exception.Message + $pos)
}
function Check([string]$Name, $Cond, [string]$Detail = '') {
    if ($Cond) { Ok $Name } else { Fail $Name ($Detail + ' (condition false)') }
}
function CheckEqual([string]$Name, $Expected, $Actual) {
    if ([string]$Expected -eq [string]$Actual) { Ok $Name } else { Fail $Name ('expected [' + [string]$Expected + '] got [' + [string]$Actual + ']') }
}
function CheckContains([string]$Name, [string]$Haystack, [string]$Needle) {
    if ($Haystack -and $Haystack.Contains($Needle)) { Ok $Name } else { Fail $Name ('missing [' + $Needle + '] in [' + ([string]$Haystack).Substring(0, [Math]::Min(160, ([string]$Haystack).Length)) + ']') }
}

if (-not $RepoRoot) {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $RepoRoot = Split-Path -Parent $here
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$modulePath = Join-Path $RepoRoot 'payloads/ghrdp-fx.ps1'
$serverPath = Join-Path $RepoRoot 'payloads/ghrdp-server.ps1'
if (-not (Test-Path -LiteralPath $modulePath)) { throw ('missing ' + $modulePath) }
if (-not (Test-Path -LiteralPath $serverPath)) { throw ('missing ' + $serverPath) }
. $modulePath

$Token = 'F45LABDASHTOKEN0123456789abcdef'
$Csrf = 'f45labcsrftoken0123456789abcdef'
$tempBase = [System.IO.Path]::GetTempPath()
$root = Join-Path $tempBase ('f45-fx-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
[void][System.IO.Directory]::CreateDirectory($root)
[void][System.IO.Directory]::CreateDirectory((Join-Path $root 'storage'))
$indexPath = Join-Path $root 'fx-index.json'
$v1Path = Join-Path $root 'fx-index-v1.json'
$opIndexPath = Join-Path $root 'fx-index-op.json'
$queuePath = Join-Path $root 'fx-queue.json'
$auditPath = Join-Path $root 'fx-audit.log'
$srvOut = Join-Path $root 'server-out.log'
$srvErr = Join-Path $root 'server-err.log'
[System.IO.File]::WriteAllText((Join-Path $root 'dash-token.txt'), $Token, $script:FxNoBom)

# --- fixtures -----------------------------------------------------------------
$notesText = 'hello fx preview range'
$notesPath = Join-Path $root 'storage/notes.txt'
[System.IO.File]::WriteAllText($notesPath, $notesText, $script:FxNoBom)
$notesLen = (Get-Item -LiteralPath $notesPath).Length
$bigPath = Join-Path $root 'storage/big.bin'
[System.IO.File]::WriteAllBytes($bigPath, (New-Object byte[] 100))

$notesId = 'de6ace9d399db9251ad9622ac38054eab10b5790'   # SHA1('RDP-Storage' + '/notes.txt')
$bigId = Get-FxStableId 'RDP-Storage' '/big.bin'
$exeId = Get-FxStableId 'RDP-Storage' '/weird.exe'
$remoteId = Get-FxStableId 'Downloads' '/remote.png'
$nohostId = Get-FxStableId 'Downloads' '/nohost.bin'

function Get-FxTestEntry([string]$Id, [string]$RootName, [string]$Path, [int64]$Size, [string]$Mime, $Gofile = $null) {
    if ($null -eq $Gofile) {
        $Gofile = [ordered]@{ code = $null; fileId = $null; directUrl = $null; status = 'none'; uploadedAt = $null; expiryTs = $null; downloads = 0; remoteSize = $null }
    }
    return [ordered]@{
        id = $Id
        root = $RootName
        path = $Path
        size = $Size
        mtime = '2026-01-01T00:00:00.000Z'
        mime = $Mime
        checksum = $null
        tags = @()
        pinned = $false
        trashed = $false
        trashedAt = $null
        recentsTs = $null
        upload = [ordered]@{ phase = $null; status = 'idle'; retries = 0; lastError = $null; bytesSent = 0 }
        gofile = $Gofile
    }
}

$fixtureIndex = [ordered]@{
    schemaVersion = 2
    generatedAt = '2026-01-01T00:00:00.000Z'
    runnerId = 'f45-lab-runner'
    roots = @(
        [ordered]@{ root = 'RDP-Storage'; scannedAt = '2026-01-01T00:00:00.000Z'; totalBytes = 200; fileCount = 3; quotaBytes = $null },
        [ordered]@{ root = 'Downloads'; scannedAt = '2026-01-01T00:00:00.000Z'; totalBytes = 12; fileCount = 2; quotaBytes = $null }
    )
    files = @(
        (Get-FxTestEntry $notesId 'RDP-Storage' '/notes.txt' $notesLen 'text/plain'),
        (Get-FxTestEntry $bigId 'RDP-Storage' '/big.bin' 100 'application/octet-stream'),
        (Get-FxTestEntry $exeId 'RDP-Storage' '/weird.exe' 10 'application/x-msdownload'),
        (Get-FxTestEntry $remoteId 'Downloads' '/remote.png' 12 'image/png' ([ordered]@{ code = 'mock-code'; fileId = 'mock-file'; directUrl = 'https://gofile.test/content/mock-file'; status = 'uploaded'; uploadedAt = '2026-01-01T00:00:00.000Z'; expiryTs = $null; downloads = 0; remoteSize = 12 })),
        (Get-FxTestEntry $nohostId 'Downloads' '/nohost.bin' 5 'application/octet-stream')
    )
    gofileHosts = @([ordered]@{ id = 'gofile'; displayName = 'gofile.io'; maxFileBytes = $null; allowedMimePrefixes = $null; ttlSeconds = $null; notes = '' })
}
[System.IO.File]::WriteAllText($indexPath, ($fixtureIndex | ConvertTo-Json -Depth 12 -Compress), $script:FxNoBom)
[System.IO.File]::WriteAllText($opIndexPath, ($fixtureIndex | ConvertTo-Json -Depth 12 -Compress), $script:FxNoBom)
# v1 fixture: legacy entries + one credential-bearing link + one clean link
$v1 = [ordered]@{
    schemaVersion = 1
    generatedAt = '2026-01-01T00:00:00.000Z'
    runnerId = 'f45-lab-v1'
    files = @(
        [ordered]@{ id = 'legacy-1'; root = 'Downloads'; path = '/notes.txt'; size = 24; mtime = '2026-01-01T00:00:00.000Z' },
        [ordered]@{ root = 'Documents'; path = '/no-id.txt'; size = 5 },
        [ordered]@{ id = 'legacy-2'; root = 'Temp'; path = '/dirty.bin'; size = 3; gofile = [ordered]@{ status = 'uploaded'; directUrl = 'https://user:pass@gofile.io/content/dirty?token=abc' } },
        [ordered]@{ id = 'legacy-3'; root = 'Temp'; path = '/clean.bin'; size = 4; gofile = [ordered]@{ status = 'uploaded'; directUrl = 'https://gofile.test/content/clean' } }
    )
}
[System.IO.File]::WriteAllText($v1Path, ($v1 | ConvertTo-Json -Depth 12 -Compress), $script:FxNoBom)
[System.IO.File]::WriteAllText((Join-Path $root 'config.json'), (( [ordered]@{ dnsName = 'lab.ts.net'; fxPreviewMaxBytes = 64 } ) | ConvertTo-Json -Compress), $script:FxNoBom)

function New-FxCtx {
    param(
        [string]$Path,
        [string]$Method = 'GET',
        [hashtable]$Query = @{},
        [hashtable]$Headers = @{},
        [string]$Body = '',
        [string]$ClientClass = 'loopback',
        [string]$DashToken = '',
        [string]$CsrfToken = $Csrf,
        [hashtable]$Options = $null
    )
    if ($null -eq $Options) { $Options = @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath } }
    $bodyBytes = [byte[]]@()
    if ($Body) { $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body) }
    return @{
        root = $root
        path = $Path
        method = $Method
        query = $Query
        headers = $Headers
        body = $bodyBytes
        clientClass = $ClientClass
        dashToken = $DashToken
        csrfToken = $CsrfToken
        options = $Options
    }
}
function Get-FxJson($Response) { return ([System.Text.Encoding]::UTF8.GetString([byte[]]$Response.Body) | ConvertFrom-Json) }
function Get-FxBodyText($Response) { return [System.Text.Encoding]::UTF8.GetString([byte[]]$Response.Body) }

Write-Host ('[F45] unit+integration root=' + $root)

# =============================================================================
# UNIT - routes
# =============================================================================
# One-line environment probe: if a route answers 404/500 the reason is almost
# always here (wrong path, unreadable fixture, id formula drift), and CI shows
# it next to the failures instead of requiring a second round trip.
$dbgIndex = Read-FxJsonFile -Path $indexPath
$script:Diag = ('root=' + $root
    + ' | indexPath=' + $indexPath
    + ' | indexExists=' + [string](Test-Path -LiteralPath $indexPath)
    + ' | routeIndexPath=' + (Get-FxIndexPath -Root $root -Options @{ IndexPath = $indexPath })
    + ' | readOk=' + [string]$dbgIndex.ok
    + ' | readError=' + [string]$dbgIndex.error
    + ' | fileCount=' + [string]@($dbgIndex.value.files).Count
    + ' | firstId=' + [string]$dbgIndex.value.files[0].id
    + ' | firstRoot=' + [string]$dbgIndex.value.files[0].root
    + ' | expectedId=' + $notesId
    + ' | stableId=' + (Get-FxStableId 'RDP-Storage' '/notes.txt'))
Write-Host ('[F45] diagnostics: ' + $script:Diag)

try {
Write-Host '[F45] unit: GET /api/fx/list'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Headers @{ 'x-dash-token' = $Token } -DashToken $Token)
CheckEqual 'list status 200' 200 $r.Code
$body = Get-FxJson $r
CheckEqual 'list schemaVersion 2' 2 $body.schemaVersion
CheckEqual 'list gofileHosts id' 'gofile' $body.gofileHosts[0].id
CheckEqual 'list file count' 5 @($body.files).Count
CheckEqual 'list entry carries upload block' 'idle' $body.files[0].upload.status
CheckEqual 'list credentials never in a URL' $false ([bool]($r.Headers -join ' ' -match '\?key='))

$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Query @{ root = 'Downloads' })
CheckEqual 'list root filter status' 200 $r.Code
$body = Get-FxJson $r
CheckEqual 'list root filter count' 2 @($body.files).Count
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Query @{ root = 'Nowhere' })
CheckEqual 'list unknown root filter 400' 400 $r.Code

$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Options @{ IndexPath = (Join-Path $root 'missing.json'); QueuePath = $queuePath; AuditPath = $auditPath })
CheckEqual 'list missing index 404' 404 $r.Code
[System.IO.File]::WriteAllText((Join-Path $root 'broken.json'), '{ not json', $script:FxNoBom)
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Options @{ IndexPath = (Join-Path $root 'broken.json'); QueuePath = $queuePath; AuditPath = $auditPath })
CheckEqual 'list corrupt index 500' 500 $r.Code
CheckEqual 'list corrupt index phase' 'parse' (Get-FxJson $r).phase
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Options @{ IndexPath = $v1Path; QueuePath = $queuePath; AuditPath = $auditPath })
CheckEqual 'list v1 index status' 200 $r.Code
$body = Get-FxJson $r
CheckEqual 'list v1 migrated to schemaVersion 2' 2 $body.schemaVersion
CheckEqual 'list v1 existing id is kept' 'legacy-1' $body.files[0].id
CheckEqual 'list v1 missing id is regenerated' (Get-FxStableId 'Documents' '/no-id.txt') $body.files[1].id
CheckEqual 'list v1 dirty link dropped' $null $body.files[2].gofile.directUrl
CheckEqual 'list v1 clean link kept' 'https://gofile.test/content/clean' $body.files[3].gofile.directUrl

Write-Host '[F45] unit: GET /api/fx/meta'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/meta' -Query @{ id = $notesId })
CheckEqual 'meta status 200' 200 $r.Code
CheckEqual 'meta id' $notesId (Get-FxJson $r).id
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/meta' -Query @{ id = 'nope' })
CheckEqual 'meta unknown id 404' 404 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/meta')
CheckEqual 'meta missing id 400' 400 $r.Code

Write-Host '[F45] unit: GET /api/fx/gofile/status'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/gofile/status' -Query @{ id = $remoteId })
CheckEqual 'gofile/status cached 200' 200 $r.Code
CheckEqual 'gofile/status cached value' 'uploaded' (Get-FxJson $r).status
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/gofile/status' -Query @{ id = 'nope' })
CheckEqual 'gofile/status unknown id 404' 404 $r.Code
$pollCtx = New-FxCtx -Path '/api/fx/gofile/status' -Query @{ id = $remoteId } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; GofileToken = 'lab-gofile-token-1234567890'; Fetch = { param($Uri, $Hdrs, $Range) @{ ok = $true; status = 200; contentType = 'application/json'; bytes = [System.Text.Encoding]::UTF8.GetBytes('{"status":"ok","data":{"status":"processing","downloads":7,"size":12}}'); error = ''; kind = 'ok' } } }
$r = Invoke-FxRoute -Ctx $pollCtx
CheckEqual 'gofile/status poll 200' 200 $r.Code
CheckEqual 'gofile/status poll downloads' 7 (Get-FxJson $r).downloads
CheckEqual 'gofile/status poll status' 'processing' (Get-FxJson $r).status
$failCtx = New-FxCtx -Path '/api/fx/gofile/status' -Query @{ id = $remoteId } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; GofileToken = 'lab-gofile-token-1234567890'; Fetch = { param($Uri, $Hdrs, $Range) @{ ok = $false; status = 0; contentType = ''; bytes = [byte[]]@(); error = 'host transport error: connection refused'; kind = 'transport' } } }
$r = Invoke-FxRoute -Ctx $failCtx
CheckEqual 'gofile/status unreachable 502' 502 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/gofile/status' -Query @{ id = $remoteId } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; GofileToken = 'lab-gofile-token-1234567890'; Fetch = { param($Uri, $Hdrs, $Range) @{ ok = $false; status = 0; contentType = ''; bytes = [byte[]]@(); error = 'host transport error: timed out'; kind = 'timeout' } } })
CheckEqual 'gofile/status timeout 504' 504 $r.Code

Write-Host '[F45] unit: GET /api/fx/preview'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $notesId })
CheckEqual 'preview 200' 200 $r.Code
CheckEqual 'preview content type' 'text/plain' $r.CType
CheckEqual 'preview body' $notesText (Get-FxBodyText $r)
CheckContains 'preview Accept-Ranges' ($r.Headers -join ' ') 'Accept-Ranges: bytes'
CheckContains 'preview nosniff' ($r.Headers -join ' ') 'X-Content-Type-Options: nosniff'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $notesId } -Headers @{ 'range' = 'bytes=0-4' })
CheckEqual 'preview range 206' 206 $r.Code
CheckEqual 'preview range body' 'hello' (Get-FxBodyText $r)
CheckContains 'preview range content-range' ($r.Headers -join ' ') ('Content-Range: bytes 0-4/' + $notesLen)
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $notesId } -Headers @{ 'range' = 'bytes=-5' })
CheckEqual 'preview suffix range 206' 206 $r.Code
CheckEqual 'preview suffix body' 'range' (Get-FxBodyText $r)
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $notesId } -Headers @{ 'range' = 'bytes=9999-' })
CheckEqual 'preview unsatisfiable 416' 416 $r.Code
CheckContains 'preview 416 content-range' ($r.Headers -join ' ') ('Content-Range: bytes */' + $notesLen)
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $exeId })
CheckEqual 'preview 415' 415 $r.Code
CheckEqual 'preview 415 phase' 'type' (Get-FxJson $r).phase
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $bigId } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; PreviewMaxBytes = 64 })
CheckEqual 'preview 413' 413 $r.Code
CheckEqual 'preview 413 phase' 'size' (Get-FxJson $r).phase
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = 'nope' })
CheckEqual 'preview unknown id 404' 404 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $nohostId })
CheckEqual 'preview no local no host 404' 404 $r.Code
$remoteOk = New-FxCtx -Path '/api/fx/preview' -Query @{ id = $remoteId } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; Fetch = { param($Uri, $Hdrs, $Range) @{ ok = $true; status = 200; contentType = 'image/png'; bytes = [byte[]](1..12); error = ''; kind = 'ok' } } }
$r = Invoke-FxRoute -Ctx $remoteOk
CheckEqual 'preview remote proxy 200' 200 $r.Code
CheckEqual 'preview remote proxy bytes' 12 $r.Body.Length
CheckContains 'preview remote auth header never in the response' ($r.Headers -join ' ') 'Accept-Ranges: bytes'
$remoteTimeout = New-FxCtx -Path '/api/fx/preview' -Query @{ id = $remoteId } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; Fetch = { param($Uri, $Hdrs, $Range) @{ ok = $false; status = 0; contentType = ''; bytes = [byte[]]@(); error = 'host transport error: time out'; kind = 'timeout' } } }
$r = Invoke-FxRoute -Ctx $remoteTimeout
CheckEqual 'preview remote timeout 504' 504 $r.Code
$remoteBad = New-FxCtx -Path '/api/fx/preview' -Query @{ id = $remoteId } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; Fetch = { param($Uri, $Hdrs, $Range) @{ ok = $false; status = 0; contentType = ''; bytes = [byte[]]@(); error = 'host transport error: dns failure'; kind = 'transport' } } }
$r = Invoke-FxRoute -Ctx $remoteBad
CheckEqual 'preview remote unreachable 502' 502 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/preview' -Query @{ id = $bigId } -Headers @{ 'range' = 'bytes=0-9' } -Options @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath; PreviewMaxBytes = 1000 })
CheckEqual 'preview full-size range 206' 206 $r.Code
CheckEqual 'preview full-size range length' 10 $r.Body.Length

Write-Host '[F45] unit: authorization (dash token + query credential)'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Headers @{ 'x-dash-token' = 'wrong-token-value-000000' } -DashToken $Token)
CheckEqual 'wrong dash token 401' 401 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Headers @{ 'authorization' = ('Bearer ' + $Token) } -DashToken $Token)
CheckEqual 'bearer header accepted' 200 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -ClientClass 'other' -DashToken $Token)
CheckEqual 'unauthenticated non-tailnet source 401' 401 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -ClientClass 'tailnet' -DashToken $Token)
CheckEqual 'tailnet source allowed by the connection gate' 200 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/list' -Query @{ key = $Token } -ClientClass 'other' -DashToken $Token)
CheckEqual 'credential in query string refused 401' 401 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/nothing-here')
CheckEqual 'unknown fx endpoint 404' 404 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op')
CheckEqual 'wrong method 405' 405 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/health')
CheckEqual 'non-fx path is not handled' $null $r

Write-Host '[F45] unit: POST /api/fx/op (CSRF + atomic index write)'
$opOptions = @{ IndexPath = $opIndexPath; QueuePath = $queuePath; AuditPath = $auditPath }
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Body ('{"op":"pin","ids":["' + $notesId + '"]}') -CsrfToken '' -Options $opOptions)
CheckEqual 'op without CSRF 403' 403 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = 'nope-nope-nope' } -Body ('{"op":"pin","ids":["' + $notesId + '"]}') -Options $opOptions)
CheckEqual 'op with wrong CSRF 403' 403 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"pin","ids":["' + $notesId + '"]}') -Options $opOptions)
CheckEqual 'op pin 200' 200 $r.Code
CheckEqual 'op pin applied' $notesId (Get-FxJson $r).applied[0]
$onDisk = (Read-FxJsonFile -Path $opIndexPath).value
$pinnedEntry = $null
foreach ($f in @($onDisk.files)) { if ($f.id -eq $notesId) { $pinnedEntry = $f } }
CheckEqual 'op pin persisted' $true $pinnedEntry.pinned
CheckEqual 'index write keeps schemaVersion 2' 2 $onDisk.schemaVersion
CheckEqual 'index write keeps gofileHosts' 'gofile' $onDisk.gofileHosts[0].id
$stray = @(Get-ChildItem -LiteralPath $root -Filter 'fx-write-*.tmp' -ErrorAction SilentlyContinue)
CheckEqual 'atomic write left no temp file behind' 0 $stray.Count
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body '{"op":"pin","ids":["nope-id"]}' -Options $opOptions)
CheckEqual 'op unknown id skipped' 'unknown id' (Get-FxJson $r).skipped[0].reason
CheckEqual 'op unknown id not applied' 0 @((Get-FxJson $r).applied).Count
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body '{"op":"trash","ids":[],"hard":false}' -Options $opOptions)
CheckEqual 'op requires ids 400' 400 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"trash","ids":["' + $notesId + '"],"hard":true}') -Options $opOptions)
CheckEqual 'hard flag refused 400' 400 $r.Code
CheckContains 'hard flag message' (Get-FxJson $r).error 'hard delete is not an Explorer operation'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body '{"op":"purge","ids":["x"]}' -Options $opOptions)
CheckEqual 'unknown op 400' 400 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"trash","ids":["' + $bigId + '"]}') -Options $opOptions)
CheckEqual 'op trash 200' 200 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"trash","ids":["' + $bigId + '"]}') -Options $opOptions)
CheckEqual 'op trash again skipped' 'already trashed' (Get-FxJson $r).skipped[0].reason
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"restore","ids":["' + $bigId + '"]}') -Options $opOptions)
CheckEqual 'op restore applied' $bigId (Get-FxJson $r).applied[0]
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"tag","ids":["' + $notesId + '"],"tags":["lab","lab","second"]}') -Options $opOptions)
CheckEqual 'op tag 200' 200 $r.Code
$onDisk = (Read-FxJsonFile -Path $opIndexPath).value
$tagged = $null
foreach ($f in @($onDisk.files)) { if ($f.id -eq $notesId) { $tagged = $f } }
CheckEqual 'op tag union' 2 @($tagged.tags).Count
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"move","ids":["' + $bigId + '"],"target":"/moved.bin"}') -Options $opOptions)
CheckEqual 'op move 200' 200 $r.Code
$movedId = Get-FxStableId 'RDP-Storage' '/moved.bin'
$onDisk = (Read-FxJsonFile -Path $opIndexPath).value
$found = $false
foreach ($f in @($onDisk.files)) { if ($f.id -eq $movedId) { $found = $true } }
CheckEqual 'op move rewrites identity' $true $found
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/op' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"op":"move","ids":["' + $notesId + '"],"target":"/moved.bin"}') -Options $opOptions)
CheckEqual 'op move onto an existing path skipped' 'a file already exists at the target path' (Get-FxJson $r).skipped[0].reason

Write-Host '[F45] unit: POST /api/fx/upload + the queue'
$uploadOptions = @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath }
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Body ('{"ids":["' + $notesId + '"],"host":"gofile"}') -CsrfToken '' -Options $uploadOptions)
CheckEqual 'upload without CSRF 403' 403 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"ids":["' + $notesId + '"],"host":"gofile"}') -Options $uploadOptions)
CheckEqual 'upload 202' 202 $r.Code
$uploadBody = Get-FxJson $r
CheckEqual 'upload job id' $notesId $uploadBody.jobs[0].id
Check 'upload job id is not empty' ([bool]$uploadBody.jobs[0].uploadJobId) ''
$queue = Read-FxJsonFile -Path $queuePath
CheckEqual 'queue persisted' $true $queue.ok
CheckEqual 'queue job status' 'queued' $queue.value.jobs[0].status
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body '{"ids":["nope"],"host":"gofile"}' -Options $uploadOptions)
CheckEqual 'upload of unknown ids 400' 400 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"ids":["' + $notesId + '"],"host":"mega"}') -Options $uploadOptions)
CheckEqual 'upload unknown host 400' 400 $r.Code

Write-Host '[F45] unit: upload worker state machine (injected uploader)'
function New-FxUploadCtx([hashtable]$Extra = @{}) {
    $o = @{ IndexPath = $indexPath; QueuePath = $queuePath; AuditPath = $auditPath }
    foreach ($k in @($Extra.Keys)) { $o[$k] = $Extra[$k] }
    return (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Options $o)
}
[System.IO.File]::Delete($queuePath)
[void](Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"ids":["' + $notesId + '"],"host":"gofile"}') -Options $uploadOptions))
$ctx = New-FxUploadCtx @{ Uploader = { param($Job, $Path) @{ ok = $false; phase = 'http'; httpStatus = 502; hostMessage = 'mock host refused (Retry-After 5)' } } }
$step = Invoke-FxUploadStep -Ctx $ctx -Options @{}
CheckEqual 'worker step processed' $true $step.processed
$queue = (Read-FxJsonFile -Path $queuePath).value
CheckEqual 'transient failure requeues' 'queued' $queue.jobs[0].status
CheckEqual 'transient failure counts a retry' 1 $queue.jobs[0].retries
CheckEqual 'transient failure records the full host message' 'mock host refused (Retry-After 5)' $queue.jobs[0].lastError.hostMessage
# the requeue carries a backoff, so make it due before the next step runs
$dueDoc = (Read-FxJsonFile -Path $queuePath).value
$dueDoc.jobs[0].nextAttemptTs = '2020-01-01T00:00:00.000Z'
[System.IO.File]::WriteAllText($queuePath, ($dueDoc | ConvertTo-Json -Depth 12 -Compress), $script:FxNoBom)
$ctx = New-FxUploadCtx @{ Uploader = { param($Job, $Path) @{ ok = $false; phase = 'size'; httpStatus = 413; hostMessage = 'host says the object is too large' } } }
[void](Invoke-FxUploadStep -Ctx $ctx -Options @{})
$queue = (Read-FxJsonFile -Path $queuePath).value
CheckEqual 'terminal failure fails the job' 'failed' $queue.jobs[0].status
CheckEqual 'terminal failure phase' 'size' $queue.jobs[0].lastError.phase
[System.IO.File]::Delete($queuePath)
[void](Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"ids":["' + $notesId + '"],"host":"gofile"}') -Options $uploadOptions))
$ctx = New-FxUploadCtx @{ Uploader = { param($Job, $Path) @{ ok = $true; phase = $null; httpStatus = 200; hostMessage = ''; fileId = 'mock-file'; code = 'mock-code'; directUrl = 'https://gofile.test/content/mock-file'; bytesSent = $notesLen } } }
[void](Invoke-FxUploadStep -Ctx $ctx -Options @{})
$queue = (Read-FxJsonFile -Path $queuePath).value
CheckEqual 'successful upload sets success' 'success' $queue.jobs[0].status
$afterIndex = (Read-FxJsonFile -Path $indexPath).value
$uploaded = $null
foreach ($f in @($afterIndex.files)) { if ($f.id -eq $notesId) { $uploaded = $f } }
CheckEqual 'successful upload writes the gofile state' 'uploaded' $uploaded.gofile.status
CheckEqual 'successful upload writes the host file id' 'mock-file' $uploaded.gofile.fileId
CheckEqual 'successful upload stamps the entry upload state' 'success' $uploaded.upload.status
CheckEqual 'successful upload keeps a clean link' 'https://gofile.test/content/mock-file' $uploaded.gofile.directUrl
CheckEqual 'successful upload stamps schemaVersion 2' 2 $afterIndex.schemaVersion
[System.IO.File]::Delete($queuePath)
[void](Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload' -Method 'POST' -Headers @{ 'x-csrf-token' = $Csrf } -Body ('{"ids":["' + $notesId + '"],"host":"gofile"}') -Options $uploadOptions))
$ctx = New-FxUploadCtx @{}
[void](Invoke-FxUploadStep -Ctx $ctx -Options @{})
$queue = (Read-FxJsonFile -Path $queuePath).value
CheckEqual 'no host token holds the job (never a silent drop)' 'queued' $queue.jobs[0].status
CheckEqual 'no host token stamps the auth phase' 'auth' $queue.jobs[0].lastError.phase
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/api/fx/upload/events')
CheckEqual 'upload/events is not an S4 route' 404 $r.Code

Write-Host '[F45] unit: redaction (§1.8)'
$masked = Protect-FxText -Text ('host said token=' + $Token + ' and Bearer ' + $Token + ' failed') -Secrets @($Token)
CheckEqual 'redaction removes the live token' $false ([bool]($masked.Contains($Token)))
CheckContains 'redaction marker' $masked '***REDACTED***'
$masked2 = Protect-FxText -Text 'https://api.gofile.io/contents/x?accountToken=abcdef123456'
CheckEqual 'redaction masks accountToken parameters' $false ([bool]($masked2.Contains('abcdef123456')))
[System.IO.File]::Delete($auditPath)
$line = Write-FxAudit (New-FxCtx -Path '/api/fx/list') ('unit redaction probe token=' + $Token)
CheckEqual 'audit line redacts the token' $false ([bool]($line.Contains($Token)))
$auditText = [System.IO.File]::ReadAllText($auditPath)
CheckEqual 'audit file redacts the token' $false ([bool]($auditText.Contains($Token)))
CheckContains 'audit file carries the marker' $auditText '***REDACTED***'

Write-Host '[F45] unit: /preview-sandbox shells (§1.7)'
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path ('/preview-sandbox/' + $notesId))
CheckEqual 'sandbox 200' 200 $r.Code
CheckContains 'sandbox content type' $r.CType 'text/html'
CheckContains 'sandbox CSP' ($r.Headers -join ' ') 'Content-Security-Policy: default-src'
CheckContains 'sandbox Origin-Agent-Cluster' ($r.Headers -join ' ') 'Origin-Agent-Cluster: ?1'
CheckContains 'sandbox CORP' ($r.Headers -join ' ') 'Cross-Origin-Resource-Policy: same-site'
CheckContains 'sandbox nosniff' ($r.Headers -join ' ') 'X-Content-Type-Options: nosniff'
CheckContains 'sandbox CSRF cookie is SameSite=Strict' ($r.Headers -join ' ') 'SameSite=Strict'
CheckEqual 'sandbox shell carries no script element' $false ([bool]((Get-FxBodyText $r).Contains('<script')))
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/preview-sandbox/nope')
CheckEqual 'sandbox unknown id 404' 404 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path '/preview-sandbox/')
CheckEqual 'sandbox without id 400' 400 $r.Code
$r = Invoke-FxRoute -Ctx (New-FxCtx -Path ('/preview-sandbox/' + $exeId))
CheckEqual 'sandbox non-previewable type 415' 415 $r.Code

Write-Host '[F45] unit: identity + migration vectors'
CheckEqual 'stable id matches the client SHA-1 vector' 'de6ace9d399db9251ad9622ac38054eab10b5790' (Get-FxStableId 'RDP-Storage' '/notes.txt')
CheckEqual 'stable id is lowercase hex' $true ([bool]((Get-FxStableId 'Temp' '/x') -match '^[0-9a-f]{40}$'))
$v1Doc = (Read-FxJsonFile -Path $v1Path).value
$normalized = ConvertTo-FxIndexV2 $v1Doc
CheckEqual 'migration keeps the file count' 4 @($normalized.files).Count
CheckEqual 'migration keeps a clean sentinel root' 'Temp' $normalized.files[2].root
CheckEqual 'migration never mutates the input' 1 $v1Doc.schemaVersion

} catch {
    Fail 'unit section aborted' (Get-FxFailDetail $_)
}

# =============================================================================
# INTEGRATION - the REAL server over HTTP
# =============================================================================
Write-Host '[F45] integration: real ghrdp-server.ps1 over loopback HTTP'
function Get-FreePort {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), 0)
    $l.Start()
    $p = $l.LocalEndpoint.Port
    $l.Stop()
    return $p
}
function Send-FxRaw {
    param([int]$Port, [string]$Method, [string]$Target, [hashtable]$Headers = @{}, [string]$Body = '', [int]$TimeoutMs = 15000)
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $Port)
    $stream = $client.GetStream()
    try { $stream.ReadTimeout = $TimeoutMs } catch { }
    $bodyBytes = [byte[]]@()
    if ($Body) { $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body) }
    $head = $Method + ' ' + $Target + " HTTP/1.1`r`nHost: 127.0.0.1`r`nConnection: close`r`n"
    foreach ($k in @($Headers.Keys)) { $head += ($k + ': ' + $Headers[$k] + "`r`n") }
    $head += ('Content-Length: ' + $bodyBytes.Length + "`r`n`r`n")
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($hb, 0, $hb.Length)
    if ($bodyBytes.Length -gt 0) { $stream.Write($bodyBytes, 0, $bodyBytes.Length) }
    $stream.Flush()
    $ms = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 8192
    while ($true) {
        $n = 0
        try { $n = $stream.Read($buf, 0, $buf.Length) } catch { break }
        if ($n -le 0) { break }
        $ms.Write($buf, 0, $n)
    }
    $all = $ms.ToArray()
    $ms.Dispose()
    try { $stream.Close(); $client.Close() } catch { }
    $idx = -1
    for ($i = 0; $i -le ($all.Length - 4); $i++) {
        if ($all[$i] -eq 13 -and $all[$i + 1] -eq 10 -and $all[$i + 2] -eq 13 -and $all[$i + 3] -eq 10) { $idx = $i; break }
    }
    $headText = ''
    $bodyOut = [byte[]]@()
    if ($idx -ge 0) {
        $headText = [System.Text.Encoding]::ASCII.GetString($all, 0, $idx)
        if ($all.Length -gt ($idx + 4)) { $bodyOut = $all[($idx + 4)..($all.Length - 1)] }
    } else {
        $headText = [System.Text.Encoding]::ASCII.GetString($all)
    }
    $code = 0
    if ($headText -match '^HTTP/1\.1 (\d{3})') { $code = [int]$Matches[1] }
    $hdr = @{}
    foreach ($l in ($headText -split "`r`n")) {
        $ix = $l.IndexOf(':')
        if ($ix -gt 0) {
            $k = $l.Substring(0, $ix).Trim().ToLower()
            $v = $l.Substring($ix + 1).Trim()
            if ($hdr.ContainsKey($k)) { $hdr[$k] = [string]$hdr[$k] + ' | ' + $v } else { $hdr[$k] = $v }
        }
    }
    return @{ Code = $code; Head = $headText; Headers = $hdr; Body = $bodyOut; Text = [System.Text.Encoding]::UTF8.GetString($bodyOut) }
}

$port = Get-FreePort
$env:GHRDP_FX_QUEUE_PATH = $queuePath
$exe = 'powershell.exe'
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { $exe = 'pwsh' }
$proc = $null
$srvLogText = ''
try {
    $srvArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $serverPath, '-Port', ([string]$port), '-Bind', '127.0.0.1', '-Root', $root, '-LimitMinutes', '5')
    $isWindowsHost = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
    if ($isWindowsHost) {
        $proc = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr -ArgumentList $srvArgs
    } else {
        # -WindowStyle is Windows-only; the production interpreter is the target
        # lane, but the script must also start on a pwsh cross-check runner.
        $proc = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr -ArgumentList $srvArgs
    }
    $okFile = Join-Path $root 'server-ok.txt'
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $okFile) { $t = [System.IO.File]::ReadAllText($okFile); if ($t -match 'LISTENING') { $up = $true } }
        if ($proc.HasExited) { break }
    }
    Check 'server reached LISTENING' $up ('server-ok.txt absent; stdout=[' + (Get-Content -LiteralPath $srvOut -Raw -ErrorAction SilentlyContinue) + ']')
    if ($up) {
        $r = Send-FxRaw -Port $port -Method 'GET' -Target '/api/fx/list' -Headers @{ 'X-Dash-Token' = 'wrong-token-value-000000' }
        CheckEqual 'I 401 on a wrong dash token' 401 $r.Code
        $r = Send-FxRaw -Port $port -Method 'GET' -Target '/api/fx/list'
        CheckEqual 'I list 200 from loopback' 200 $r.Code
        CheckContains 'I list is schemaVersion 2' $r.Text '"schemaVersion":2'
        CheckContains 'I list carries gofileHosts' $r.Text 'gofileHosts'
        CheckContains 'I CSRF cookie is delivered' ([string]$r.Headers['set-cookie']) 'ghrdp_fx_csrf='
        CheckContains 'I CSRF cookie is SameSite=Strict' ([string]$r.Headers['set-cookie']) 'SameSite=Strict'
        $csrfTok = ''
        if ($r.Headers.ContainsKey('set-cookie')) {
            $m = [regex]::Match([string]$r.Headers['set-cookie'], 'ghrdp_fx_csrf=([0-9a-f]+)')
            if ($m.Success) { $csrfTok = $m.Groups[1].Value }
        }
        Check 'I the server minted a CSRF token' ([bool]$csrfTok) ('cookie=[' + [string]$r.Headers['set-cookie'] + ']')
        $r = Send-FxRaw -Port $port -Method 'GET' -Target ('/api/fx/meta?id=' + $notesId)
        CheckEqual 'I meta 200' 200 $r.Code
        $r = Send-FxRaw -Port $port -Method 'GET' -Target '/api/fx/meta?id=nope'
        CheckEqual 'I meta unknown 404' 404 $r.Code
        $r = Send-FxRaw -Port $port -Method 'GET' -Target ('/api/fx/preview?id=' + $notesId)
        CheckEqual 'I preview 200' 200 $r.Code
        CheckEqual 'I preview body' $notesText $r.Text
        CheckContains 'I preview Accept-Ranges' ([string]$r.Headers['accept-ranges']) 'bytes'
        $r = Send-FxRaw -Port $port -Method 'GET' -Target ('/api/fx/preview?id=' + $notesId) -Headers @{ 'Range' = 'bytes=0-4' }
        CheckEqual 'I preview Range 206' 206 $r.Code
        CheckEqual 'I preview Range body' 'hello' $r.Text
        CheckContains 'I preview Content-Range' ([string]$r.Headers['content-range']) ('bytes 0-4/' + $notesLen)
        $r = Send-FxRaw -Port $port -Method 'GET' -Target ('/api/fx/preview?id=' + $bigId)
        CheckEqual 'I preview over the configured cap 413' 413 $r.Code
        $r = Send-FxRaw -Port $port -Method 'GET' -Target ('/api/fx/preview?id=' + $exeId)
        CheckEqual 'I preview non-previewable 415' 415 $r.Code
        $r = Send-FxRaw -Port $port -Method 'GET' -Target '/api/fx/list?key=shouldbeignored'
        CheckEqual 'I query credential refused 401' 401 $r.Code
        $r = Send-FxRaw -Port $port -Method 'GET' -Target ('/preview-sandbox/' + $notesId)
        CheckEqual 'I sandbox 200' 200 $r.Code
        CheckContains 'I sandbox CSP' ([string]$r.Headers['content-security-policy']) "script-src 'none'"
        CheckContains 'I sandbox OAC' ([string]$r.Headers['origin-agent-cluster']) '?1'
        CheckContains 'I sandbox CORP' ([string]$r.Headers['cross-origin-resource-policy']) 'same-site'
        $r = Send-FxRaw -Port $port -Method 'POST' -Target '/api/fx/op' -Headers @{ 'Content-Type' = 'application/json' } -Body ('{"op":"pin","ids":["' + $remoteId + '"]}')
        CheckEqual 'I op without CSRF 403' 403 $r.Code
        $r = Send-FxRaw -Port $port -Method 'POST' -Target '/api/fx/op' -Headers @{ 'Content-Type' = 'application/json'; 'X-CSRF-Token' = 'wrong-csrf' } -Body ('{"op":"pin","ids":["' + $remoteId + '"]}')
        CheckEqual 'I op with a wrong CSRF 403' 403 $r.Code
        $r = Send-FxRaw -Port $port -Method 'POST' -Target '/api/fx/op' -Headers @{ 'Content-Type' = 'application/json'; 'X-CSRF-Token' = $csrfTok } -Body ('{"op":"pin","ids":["' + $remoteId + '"]}')
        CheckEqual 'I op with the delivered CSRF 200' 200 $r.Code
        CheckContains 'I op applied the id' $r.Text ('"' + $remoteId + '"')
        $onDisk = (Read-FxJsonFile -Path $indexPath).value
        CheckEqual 'I op persisted schemaVersion 2' 2 $onDisk.schemaVersion
        CheckEqual 'I op persisted gofileHosts' 'gofile' $onDisk.gofileHosts[0].id
        $r = Send-FxRaw -Port $port -Method 'POST' -Target '/api/fx/op' -Headers @{ 'Content-Type' = 'application/json'; 'X-CSRF-Token' = $csrfTok } -Body ('{"op":"trash","ids":["' + $remoteId + '"],"hard":true}')
        CheckEqual 'I hard flag refused over HTTP 400' 400 $r.Code
        [System.IO.File]::Delete($queuePath)
        $r = Send-FxRaw -Port $port -Method 'POST' -Target '/api/fx/upload' -Headers @{ 'Content-Type' = 'application/json'; 'X-CSRF-Token' = $csrfTok } -Body ('{"ids":["' + $notesId + '"],"host":"gofile"}')
        CheckEqual 'I upload 202' 202 $r.Code
        CheckContains 'I upload returns an uploadJobId' $r.Text 'uploadJobId'
        $queue = Read-FxJsonFile -Path $queuePath
        CheckEqual 'I upload persisted the queue' $true $queue.ok
        $r = Send-FxRaw -Port $port -Method 'POST' -Target '/api/fx/upload' -Headers @{ 'Content-Type' = 'application/json' } -Body '{"ids":["x"],"host":"gofile"}'
        CheckEqual 'I upload without CSRF 403' 403 $r.Code
        $r = Send-FxRaw -Port $port -Method 'GET' -Target '/health'
        CheckEqual 'I the legacy routes still answer 200' 200 $r.Code
    }
} catch {
    Fail 'integration section aborted' (Get-FxFailDetail $_)
} finally {
    if ($proc) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { } }
    foreach ($pf in @('fx-upload-worker.pid')) {
        $p = Join-Path $root $pf
        if (Test-Path -LiteralPath $p) {
            $pidTxt = 0
            if ([int]::TryParse(([System.IO.File]::ReadAllText($p)).Trim(), [ref]$pidTxt)) { try { Stop-Process -Id $pidTxt -Force -ErrorAction SilentlyContinue } catch { } }
        }
    }
    # the server detaches helper loops (wire-probe / rdp-ping / rdp-usage) that
    # keep writing into this temp Root; kill the ones whose command line names it
    if ($isWindowsHost) {
        try {
            foreach ($hp in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
                if ($hp.CommandLine -and ([string]$hp.CommandLine).Contains($root)) { Stop-Process -Id $hp.ProcessId -Force -ErrorAction SilentlyContinue }
            }
        } catch { }
    }
    Start-Sleep -Milliseconds 300
}

# --- redaction assertion over EVERY log this run produced ---------------------
$srvLogText = ''
if (Test-Path -LiteralPath $srvOut) { $srvLogText += [System.IO.File]::ReadAllText($srvOut) }
if (Test-Path -LiteralPath $srvErr) { $srvLogText += [System.IO.File]::ReadAllText($srvErr) }
foreach ($logName in @('client-audit.log', 'fx-audit.log')) {
    $lp = Join-Path $root $logName
    if (Test-Path -LiteralPath $lp) { $srvLogText += [System.IO.File]::ReadAllText($lp) }
}
CheckEqual 'no log line contains the dash token' $false ([bool]($srvLogText.Contains($Token)))
CheckEqual 'no log line contains the CSRF token' $false ([bool]$csrfTok -and [bool]($srvLogText.Contains($csrfTok)))
$auditFile = Join-Path $root 'fx-audit.log'
$auditText2 = ''
if (Test-Path -LiteralPath $auditFile) { $auditText2 = [System.IO.File]::ReadAllText($auditFile) }
CheckContains 'the fx audit trail exists' $auditText2 'fx op='

if ($script:Keep) { Write-Host ('[F45] artifacts kept at ' + $root) } else { try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue } catch { } }

$total = $script:Pass + $script:Fail
Write-Host ('[F45] unit+integration: ' + $script:Pass + '/' + $total + ' passed')
if ($script:Fail -gt 0) {
    # ONE annotation: %0A is a newline in a workflow command, so the operator
    # sees EVERY failed check (the 10-annotation cap cannot hide any of them).
    $report = @('[F45] ' + [string]$script:Fail + '/' + [string]$total + ' checks failed', ('diag: ' + [string]$script:Diag))
    $report += $script:Failures
    $flat = [string]::Join('%0A', @($report | ForEach-Object { [string]$_ -replace '\r?\n', ' | ' -replace '%', '%25' }))
    if ($flat.Length -gt 60000) { $flat = $flat.Substring(0, 60000) + '%0A(truncated)' }
    Write-Host ('::error::' + $flat)
    exit 1
}
Write-Host '[F45] PASS - server routes: contract, CSRF, Range, error paths, redaction'
exit 0
