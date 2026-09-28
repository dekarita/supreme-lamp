# ghrdp-fx.ps1  [F45 S4 §1] EXPLORER FILE-API SERVER ROUTES (single source of truth).
#
# Dot-sourced by payloads/ghrdp-server.ps1 (the server resolves it as
# <Root>\ghrdp-fx.ps1, then next to the server script) and dot-sourced DIRECTLY
# by tests/f45-fx-server.ps1, which is why every route below is a pure function
# of a request context hashtable and never touches $stream, $Client or $Root
# globals. The server translates its parsed request into that context; the tests
# translate a synthetic one. There is exactly ONE implementation of each route.
#
# Contract implemented here (Explorer §5 endpoint table; the table itself is not
# in this checkout, so the de facto contract is the S2 schema
# src/components/explorer/data/schema.ts + the S3 clients api/endpoints.ts and
# api/errors.ts, both of which this module is written against):
#
#   GET  /api/fx/list           200 IndexJson(schemaVersion=2)  401 400 500
#   GET  /api/fx/meta           200 FileEntry                    401 400 404
#   GET  /api/fx/gofile/status  200 GofileState                  401 400 404 502
#   GET  /api/fx/preview        200|206 bytes                    401 400 404 413 415 416 502 504
#   POST /api/fx/op             200 {applied,skipped}            400 401 403
#   POST /api/fx/upload         202 {jobs:[{id,uploadJobId}]}    400 401 403 500
#   GET  /preview-sandbox/<id>  200 text/html (CSP + isolation headers)
#
# Authorization model (no new secret channel):
#   * The dash token travels in X-Dash-Token (S3 fxClient) or Authorization:
#     Bearer <token>. A credential in the QUERY STRING is refused with 401 -
#     S3 refuses to build such a URL at all (§5.1 rule 1/8).
#   * A request that PRESENTS a token must present the right one, even from
#     loopback (fail closed). A request that presents nothing is allowed only
#     when the server's existing connection gate already authorized the peer
#     (loopback or tailnet CGNAT source) - that is the "existing gate" of §1.1.
#   * POSTs additionally require X-CSRF-Token to equal the per-process CSRF
#     token minted at server start and delivered as the JS-readable
#     SameSite=Strict cookie ghrdp_fx_csrf (+ X-CSRF-Token response header).
#
# Error bodies are JSON with the F44 phase vocabulary, and the host message is
# COMPLETE (never truncated) - the S3 client surfaces it verbatim.
#
# Nothing here calls a live host by itself: the gofile token is read only when
# configured, and every network call goes through an injectable scriptblock
# (Invoke-FxHttpBytes / Invoke-FxHttpJson) so tests never leave the machine.

$script:FxSchemaVersion = 2
$script:FxRedacted = '***REDACTED***'
$script:FxIndexFileName = 'fx-index.json'
$script:FxQueueFileName = 'fx-upload-queue.json'
$script:FxNoBom = New-Object System.Text.UTF8Encoding($false)
# §1.4: preview is a bounded stream. 64 MiB is the S4 cap; the operator can
# raise it per host through config.json fxPreviewMaxBytes (or the lab env var).
$script:FxPreviewMaxBytes = 67108864
$script:FxGofileApiBase = 'https://api.gofile.io'
$script:FxRoots = @('Downloads', 'Desktop', 'Documents', 'Temp', 'RDP-Storage')
$script:FxUploadHosts = @('gofile')
$script:FxUploadStatuses = @('idle', 'queued', 'uploading', 'success', 'failed', 'canceled')
$script:FxUploadPhases = @('dns', 'tcp', 'tls', 'encrypt', 'size', 'type', 'auth', 'http', 'parse')
$script:FxGofileStatuses = @('none', 'uploaded', 'processing', 'expired', 'failed')
# Transient phases are retryable (S3 api/retryPolicy.ts); everything else is
# terminal. Retries are recorded in the queue, never in the response contract.
$script:FxTransientPhases = @('dns', 'tcp', 'tls', 'http')
$script:FxUploadMaxRetries = 5
# §1.4 preview allowlist - EXACTLY the 41 MIME values of the S2 fixture
# src/components/explorer/data/fixtures/preview-mime-map.json (renderer set).
# tests/f45-fx-server.test.js compares this list to that fixture, so the two can
# never drift silently. Anything else is 415 (type).
$script:FxPreviewMime = @(
    'application/javascript',
    'application/json',
    'application/octet-stream',
    'application/pdf',
    'application/typescript',
    'application/x-7z-compressed',
    'application/x-ghrdp-mirror',
    'application/x-python-code',
    'application/x-shellscript',
    'application/x-unknown',
    'application/zip',
    'audio/flac',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/tiff',
    'image/webp',
    'text/css',
    'text/csv',
    'text/html',
    'text/markdown',
    'text/plain',
    'text/tab-separated-values',
    'text/x-c',
    'text/x-c++src',
    'text/x-go',
    'text/x-java-source',
    'text/x-markdown',
    'text/x-python',
    'text/x-rust',
    'text/x-shellscript',
    'text/x-typescript',
    'video/mp4',
    'video/quicktime',
    'video/webm'
)
$script:FxRendererByMime = @{
    'image/png' = 'image'; 'image/jpeg' = 'image'; 'image/gif' = 'image'
    'image/webp' = 'image'; 'image/avif' = 'image'; 'image/svg+xml' = 'image'
    'image/bmp' = 'image'; 'image/tiff' = 'image'
    'video/mp4' = 'video'; 'video/webm' = 'video'; 'video/quicktime' = 'video'
    'audio/mpeg' = 'audio'; 'audio/wav' = 'audio'; 'audio/ogg' = 'audio'; 'audio/flac' = 'audio'
    'application/pdf' = 'pdf'; 'text/markdown' = 'md'; 'text/x-markdown' = 'md'
}

# ---------------------------------------------------------------------------
# §1.8 CREDENTIAL REDACTION - every log line this module writes goes through
# Protect-FxText first. The marker is exactly ***REDACTED*** (the same literal
# S3 api/errors.ts redactSecrets uses) and the pattern list mirrors it:
#   <name>=<value> for token/key/secret/password-ish names, Bearer <token>,
#   plus every live secret handed in by the caller.
# ---------------------------------------------------------------------------
function Protect-FxText {
    param([string]$Text, [string[]]$Secrets = @())
    if ($null -eq $Text) { return '' }
    $out = [string]$Text
    foreach ($s in @($Secrets)) {
        if ($s -and ([string]$s).Length -ge 8) { $out = $out.Replace([string]$s, $script:FxRedacted) }
    }
    $out = [regex]::Replace($out, '(?i)\b(dash[-_]?token|account[-_]?token|access[-_]?token|refresh[-_]?token|token|key|authorization|password|passwd|pwd|secret)\b\s*[:=]\s*[^&\s"'']+', ('$1=' + $script:FxRedacted))
    $out = [regex]::Replace($out, '(?i)\bBearer\s+[A-Za-z0-9._\-]{6,}', ('Bearer ' + $script:FxRedacted))
    return $out
}
function Get-FxSecretList {
    # Only the secrets THIS process actually holds; an empty list stays empty so
    # no pattern is invented for a host that was never configured.
    param($Ctx)
    $list = @()
    try { if ($Ctx -and $Ctx.dashToken) { $list += [string]$Ctx.dashToken } } catch { }
    try { if ($Ctx -and $Ctx.csrfToken) { $list += [string]$Ctx.csrfToken } } catch { }
    try {
        if ($Ctx -and $Ctx.options -and $Ctx.options.ContainsKey('GofileToken') -and $Ctx.options['GofileToken']) { $list += [string]$Ctx.options['GofileToken'] }
    } catch { }
    return $list
}
function Write-FxAudit {
    # Redacted append-only audit trail (fx-audit.log next to the index). Returns
    # the exact line written so a test can assert the token never reaches it.
    param($Ctx, [string]$Message)
    $path = ''
    try { $path = [string]$Ctx.options['AuditPath'] } catch { }
    if (-not $path) { try { $path = Join-Path ([string]$Ctx.root) 'fx-audit.log' } catch { $path = '' } }
    if (-not $path) { return '' }
    $secrets = Get-FxSecretList $Ctx
    $line = (Get-Date).ToUniversalTime().ToString('o') + ' ' + (Protect-FxText -Text $Message -Secrets $secrets)
    try {
        $dir = [System.IO.Path]::GetDirectoryName($path)
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
        [System.IO.File]::AppendAllText($path, ($line + "`n"), $script:FxNoBom)
    } catch { }
    return $line
}

# ---------------------------------------------------------------------------
# Small JSON helpers (PS 5.1 safe: no -AsHashtable, no ternary, no ??).
# ---------------------------------------------------------------------------
function ConvertTo-FxJsonBytes {
    param($Obj, [int]$Depth = 12)
    return [System.Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth $Depth -Compress))
}
function Read-FxJsonFile {
    # Read-only, share-friendly read (the writer replaces the file atomically).
    # Returns @{ ok; text; value; error } and never throws.
    param([string]$Path)
    $res = @{ ok = $false; text = ''; value = $null; error = '' }
    if (-not $Path) { $res.error = 'no path'; return $res }
    for ($a = 1; $a -le 3; $a++) {
        try {
            if (-not (Test-Path -LiteralPath $Path)) { $res.error = 'index file missing: ' + $Path; return $res }
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $ms = New-Object System.IO.MemoryStream
            try { $fs.CopyTo($ms) } finally { $fs.Dispose() }
            $b = $ms.ToArray()
            $ms.Dispose()
            if ($b.Length -eq 0) { $res.error = 'index file is empty: ' + $Path; return $res }
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
            $text = [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
            $res.text = $text
            $res.value = ($text | ConvertFrom-Json)
            $res.ok = $true
            return $res
        } catch {
            $res.error = 'index parse error: ' + $_.Exception.Message
            Start-Sleep -Milliseconds 40
        }
    }
    return $res
}
function Save-FxJsonAtomic {
    # §1.5/§1.9 ATOMIC index write: temp file in the SAME directory + rename, so
    # a reader never observes a half-written index and a failed write leaves the
    # previous index intact.
    param([string]$Path, $Value, [int]$Depth = 12)
    $dir = [System.IO.Path]::GetDirectoryName($Path)
    if (-not $dir) { throw ('no directory for ' + $Path) }
    if (-not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    $tmp = Join-Path $dir ('fx-write-' + [string]$PID + '-' + [guid]::NewGuid().ToString('n').Substring(0, 8) + '.tmp')
    $json = ($Value | ConvertTo-Json -Depth $Depth -Compress)
    [System.IO.File]::WriteAllText($tmp, $json, $script:FxNoBom)
    try {
        if ([System.IO.File]::Exists($Path)) {
            $backup = Join-Path $dir ('fx-prev-' + [guid]::NewGuid().ToString('n').Substring(0, 8) + '.bak')
            [System.IO.File]::Replace($tmp, $Path, $backup)
            try { [System.IO.File]::Delete($backup) } catch { }
        } else {
            [System.IO.File]::Move($tmp, $Path)
        }
    } catch {
        # Same-volume Replace can be refused (locked reader / unusual FS): fall
        # back to a best-effort replace and report the failure loudly.
        try { [System.IO.File]::Delete($Path) } catch { }
        [System.IO.File]::Move($tmp, $Path)
    }
    return $json
}

# ---------------------------------------------------------------------------
# Paths and identity
# ---------------------------------------------------------------------------
function Get-FxIndexPath {
    param([string]$Root, [hashtable]$Options = @{})
    if ($Options -and $Options.ContainsKey('IndexPath') -and $Options['IndexPath']) { return [string]$Options['IndexPath'] }
    if ($env:GHRDP_FX_INDEX_PATH) { return [string]$env:GHRDP_FX_INDEX_PATH }
    return (Join-Path $Root $script:FxIndexFileName)
}
function Get-FxQueuePath {
    # §1.6 the queue is %TEMP%\ghrdp\fx-upload-queue.json; the lab env var and
    # the Options override exist so a test never writes into the real TEMP.
    param([string]$Root, [hashtable]$Options = @{})
    if ($Options -and $Options.ContainsKey('QueuePath') -and $Options['QueuePath']) { return [string]$Options['QueuePath'] }
    if ($env:GHRDP_FX_QUEUE_PATH) { return [string]$env:GHRDP_FX_QUEUE_PATH }
    $temp = ''
    try { $temp = [System.IO.Path]::GetTempPath() } catch { $temp = '' }
    if (-not $temp) { $temp = [string]$env:TEMP }
    if (-not $temp) { $temp = $Root }
    return (Join-Path (Join-Path $temp 'ghrdp') $script:FxQueueFileName)
}
function Get-FxStableId {
    # SHA-1(root + path), UTF-8, lowercase hex - IDENTICAL to the S2 client
    # computeId (src/components/explorer/data/migrations/stableId.ts). Identity
    # only, never authentication.
    param([string]$RootName, [string]$Path)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(([string]$RootName + [string]$Path)))
    } finally { $sha.Dispose() }
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($b.ToString('x2')) }
    return $sb.ToString()
}
function Get-FxProp {
    # [F45 S4 CI fix] TWO object shapes reach this helper: PSCustomObjects (every
    # index/body/token JSON read from disk) and the Hashtable/OrderedDictionary
    # values this module BUILDS itself (the migrated index entries, queue jobs).
    # PowerShell's PSObject member view does not expose a dictionary's keys, so
    # a dictionary must be checked with Contains() FIRST - otherwise every
    # migrated entry lost its id/root/mime and every lookup answered 404.
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $null }
    try {
        if ($Obj -is [System.Collections.IDictionary]) {
            $d = [System.Collections.IDictionary]$Obj
            if ($d.Contains($Name)) { return $d[$Name] }
            return $null
        }
        $p = $Obj.PSObject.Properties[$Name]
        if ($p) { return $p.Value }
    } catch { }
    return $null
}
function Test-FxHasProp {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $false }
    try {
        if ($Obj -is [System.Collections.IDictionary]) { return ([System.Collections.IDictionary]$Obj).Contains($Name) }
        return [bool]($Obj.PSObject.Properties[$Name])
    } catch { return $false }
}
function Get-FxString {
    param($Obj, [string]$Name, [string]$Default = '')
    $v = Get-FxProp $Obj $Name
    if ($null -eq $v) { return $Default }
    if ($v -is [string]) { if ($v) { return $v } else { return $Default } }
    return [string]$v
}
function Get-FxNullableString {
    param($Obj, [string]$Name)
    $v = Get-FxProp $Obj $Name
    if ($null -eq $v) { return $null }
    if ($v -is [string]) { return $v }
    return [string]$v
}
function Get-FxNumber {
    param($Obj, [string]$Name, $Default = 0)
    $v = Get-FxProp $Obj $Name
    if ($null -eq $v) { return $Default }
    $ok = ($v -is [int]) -or ($v -is [long]) -or ($v -is [double]) -or ($v -is [decimal]) -or ($v -is [int16]) -or ($v -is [int64])
    if (-not $ok) { return $Default }
    $n = [double]$v
    if ([double]::IsNaN($n) -or [double]::IsInfinity($n) -or $n -lt 0) { return $Default }
    if ($n -eq [math]::Floor($n) -and [math]::Abs($n) -lt 9.007199254740992E15) { return [long]$n }
    return $n
}
function Get-FxNullableNumber {
    param($Obj, [string]$Name)
    $v = Get-FxProp $Obj $Name
    if ($null -eq $v) { return $null }
    $ok = ($v -is [int]) -or ($v -is [long]) -or ($v -is [double]) -or ($v -is [decimal])
    if (-not $ok) { return $null }
    $n = [double]$v
    if ([double]::IsNaN($n) -or [double]::IsInfinity($n) -or $n -lt 0) { return $null }
    if ($n -eq [math]::Floor($n) -and [math]::Abs($n) -lt 9.007199254740992E15) { return [long]$n }
    return $n
}
function Get-FxMember {
    param($Value, [string[]]$Allowed, [string]$Default)
    if ($null -eq $Value) { return $Default }
    $s = ''
    if ($Value -is [string]) { $s = $Value }
    if ($Allowed -contains $s) { return $s }
    return $Default
}
function Test-FxIsoString {
    param([string]$Value)
    if (-not $Value) { return $false }
    $dt = [datetime]::MinValue
    try {
        return [datetime]::TryParse($Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$dt)
    } catch { return $false }
}
function Get-FxIsoString {
    # Mirrors v1_to_v2.ts iso(): the value is kept when it parses, else EPOCH.
    param($Obj, [string]$Name, [string]$Default = '1970-01-01T00:00:00.000Z')
    $v = Get-FxProp $Obj $Name
    if ($v -is [string] -and $v -and (Test-FxIsoString $v)) { return $v }
    return $Default
}
function Get-FxSafeDirectUrl {
    # §4 invariant: a stored link is https, carries NO userinfo, query or
    # fragment (the S2 client enforces the same rule). Anything else is dropped
    # here so a credential-bearing URL can never be proxied or echoed.
    param($Value)
    if (-not ($Value -is [string])) { return $null }
    if (-not $Value) { return $null }
    $uri = $null
    try {
        if (-not [uri]::TryCreate([string]$Value, [System.UriKind]::Absolute, [ref]$uri)) { return $null }
    } catch { return $null }
    if ($uri.Scheme -ne 'https') { return $null }
    if ($uri.UserInfo) { return $null }
    if ($uri.Query) { return $null }
    if ($uri.Fragment) { return $null }
    return [string]$Value
}
function New-FxGofileHosts {
    # §1.9 every index write carries the gofileHosts config array. One host, the
    # configured one: no fallback/rotation channel is invented here.
    param($Raw)
    $configured = $null
    try {
        foreach ($h in @(Get-FxProp $Raw 'gofileHosts')) {
            if ((Get-FxString $h 'id') -eq 'gofile') { $configured = $h; break }
        }
    } catch { }
    if ($null -eq $configured) { $configured = $Raw }
    $prefixes = $null
    try {
        $ap = Get-FxProp $configured 'allowedMimePrefixes'
        if ($null -ne $ap) {
            $prefixes = @()
            foreach ($p in @($ap)) { if ($p -is [string]) { $prefixes += [string]$p } }
        }
    } catch { $prefixes = $null }
    return @(
        [ordered]@{
            id = 'gofile'
            displayName = (Get-FxString $configured 'displayName' 'gofile.io')
            maxFileBytes = (Get-FxNullableNumber $configured 'maxFileBytes')
            allowedMimePrefixes = $prefixes
            ttlSeconds = (Get-FxNullableNumber $configured 'ttlSeconds')
            notes = (Get-FxString $configured 'notes' '')
        }
    )
}
function ConvertTo-FxIndexV2 {
    # §1.1 MIGRATION: a v1 (or partial) index is normalised into the canonical
    # schemaVersion 2 shape server-side, mirroring data/migrations/v1_to_v2.ts
    # field for field (defaults, no mutation of the input, credential URLs
    # discarded). Returns the canonical index; never throws.
    param($Raw)
    $epoch = '1970-01-01T00:00:00.000Z'
    $roots = @()
    foreach ($r in @(Get-FxProp $Raw 'roots')) {
        $roots += [ordered]@{
            root = (Get-FxMember (Get-FxProp $r 'root') $script:FxRoots 'Temp')
            scannedAt = (Get-FxIsoString $r 'scannedAt')
            totalBytes = (Get-FxNumber $r 'totalBytes' 0)
            fileCount = (Get-FxNumber $r 'fileCount' 0)
            quotaBytes = (Get-FxNullableNumber $r 'quotaBytes')
        }
    }
    $files = @()
    foreach ($f in @(Get-FxProp $Raw 'files')) {
        $rootName = (Get-FxMember (Get-FxProp $f 'root') $script:FxRoots 'Temp')
        $rawPath = [string](Get-FxProp $f 'path')
        $path = '/' + (($rawPath -replace '\\', '/') -replace '^/+', '')
        $id = (Get-FxString $f 'id')
        if (-not $id) { $id = (Get-FxStableId $rootName $path) }
        $upload = Get-FxProp $f 'upload'
        $gofile = Get-FxProp $f 'gofile'
        $gStatus = (Get-FxMember (Get-FxProp $gofile 'status') $script:FxGofileStatuses 'none')
        $lastError = $null
        $le = Get-FxProp $upload 'lastError'
        if ($null -ne $le) {
            $lastError = [ordered]@{
                phase = (Get-FxMember (Get-FxProp $le 'phase') $script:FxUploadPhases 'parse')
                httpStatus = (Get-FxNullableNumber $le 'httpStatus')
                hostMessage = (Get-FxNullableString $le 'hostMessage')
                at = (Get-FxNullableString $le 'at')
            }
        }
        $uploadPhase = $null
        if ($null -ne (Get-FxProp $upload 'phase')) { $uploadPhase = (Get-FxMember (Get-FxProp $upload 'phase') $script:FxUploadPhases 'parse') }
        $direct = $null
        if ($gStatus -eq 'uploaded') { $direct = (Get-FxSafeDirectUrl (Get-FxProp $gofile 'directUrl')) }
        $files += [ordered]@{
            id = $id
            root = $rootName
            path = $path
            size = (Get-FxNumber $f 'size' 0)
            mtime = (Get-FxIsoString $f 'mtime')
            mime = (Get-FxString $f 'mime' 'application/octet-stream')
            checksum = (Get-FxNullableString $f 'checksum')
            tags = @(@(Get-FxProp $f 'tags') | Where-Object { $_ -is [string] })
            pinned = ((Get-FxProp $f 'pinned') -eq $true)
            trashed = ((Get-FxProp $f 'trashed') -eq $true)
            trashedAt = (Get-FxNullableString $f 'trashedAt')
            recentsTs = (Get-FxNullableString $f 'recentsTs')
            upload = [ordered]@{
                phase = $uploadPhase
                status = (Get-FxMember (Get-FxProp $upload 'status') $script:FxUploadStatuses 'idle')
                retries = (Get-FxNumber $upload 'retries' 0)
                lastError = $lastError
                bytesSent = (Get-FxNumber $upload 'bytesSent' 0)
            }
            gofile = [ordered]@{
                code = (Get-FxNullableString $gofile 'code')
                fileId = (Get-FxNullableString $gofile 'fileId')
                directUrl = $direct
                status = $gStatus
                uploadedAt = (Get-FxNullableString $gofile 'uploadedAt')
                expiryTs = (Get-FxNullableString $gofile 'expiryTs')
                downloads = (Get-FxNumber $gofile 'downloads' 0)
                remoteSize = (Get-FxNullableNumber $gofile 'remoteSize')
            }
        }
    }
    $generatedAt = (Get-FxIsoString $Raw 'generatedAt')
    if (-not (Test-FxIsoString $generatedAt)) { $generatedAt = $epoch }
    return [ordered]@{
        schemaVersion = $script:FxSchemaVersion
        generatedAt = $generatedAt
        runnerId = (Get-FxString $Raw 'runnerId' 'unknown')
        roots = $roots
        files = $files
        gofileHosts = (New-FxGofileHosts $Raw)
    }
}
function Get-FxFileEntry {
    param($Index, [string]$Id)
    if (-not $Index -or -not $Id) { return $null }
    foreach ($f in @($Index.files)) {
        if ((Get-FxString $f 'id') -eq $Id) { return $f }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Request context helpers
# ---------------------------------------------------------------------------
function New-FxResponse {
    param([int]$Code, [string]$CType, [byte[]]$Body, [string[]]$Headers = @())
    if ($null -eq $Body) { $Body = [byte[]]@() }
    if (-not $CType) { $CType = 'application/json; charset=utf-8' }
    return @{ Code = $Code; CType = $CType; Body = $Body; Headers = @($Headers) }
}
function New-FxErrorResponse {
    # F44: the body carries the phase AND the complete host message.
    # [F45 S4 CI fix] the default MUST be @{}: a [hashtable] parameter whose
    # default is @() throws ParameterBindingArgumentTransformationException on
    # every call that omits -Extra ("Cannot convert System.Object[] to
    # Hashtable"), which turned every error route into a 500.
    param([int]$Code, [string]$Phase, [string]$Message, [hashtable]$Extra = @{}, [string[]]$Headers = @())
    $body = [ordered]@{ phase = $Phase; error = $Message; at = (Get-Date).ToUniversalTime().ToString('o') }
    foreach ($k in @($Extra.Keys)) { $body[$k] = $Extra[$k] }
    return (New-FxResponse -Code $Code -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes $body) -Headers $Headers)
}
function Get-FxQueryValue {
    param($Ctx, [string]$Name)
    if (-not $Ctx -or -not $Ctx.query) { return '' }
    try {
        if ($Ctx.query.ContainsKey($Name)) { return [string]$Ctx.query[$Name] }
        if ($Ctx.query.ContainsKey($Name.ToLower())) { return [string]$Ctx.query[$Name.ToLower()] }
    } catch { }
    return ''
}
function Get-FxHeaderValue {
    param($Ctx, [string]$Name)
    if (-not $Ctx -or -not $Ctx.headers) { return '' }
    $k = $Name.ToLower()
    try { if ($Ctx.headers.ContainsKey($k)) { return [string]$Ctx.headers[$k] } } catch { }
    return ''
}
function Test-FxConstantEqual {
    param([string]$A, [string]$B)
    if ($null -eq $A -or $null -eq $B) { return $false }
    $ba = [System.Text.Encoding]::UTF8.GetBytes([string]$A)
    $bb = [System.Text.Encoding]::UTF8.GetBytes([string]$B)
    if ($ba.Length -eq 0 -or $ba.Length -ne $bb.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $ba.Length; $i++) { $diff = $diff -bor ($ba[$i] -bxor $bb[$i]) }
    return ($diff -eq 0)
}
function Test-FxQueryCredential {
    # §5.1 rule 1/8: a credential may never travel in the URL. A key=/token=/
    # dash-token=/password= parameter on an fx route is refused, not ignored.
    param($Ctx)
    if (-not $Ctx -or -not $Ctx.query) { return $false }
    foreach ($k in @('key', 'token', 'dash-token', 'dash_token', 'dashtoken', 'access-token', 'access_token', 'password')) {
        try { if ($Ctx.query.ContainsKey($k)) { return $true } } catch { }
    }
    return $false
}
function Test-FxTokenOk {
    param($Ctx)
    $configured = ''
    try { $configured = [string]$Ctx.dashToken } catch { }
    $presented = Get-FxHeaderValue $Ctx 'x-dash-token'
    if (-not $presented) {
        $auth = Get-FxHeaderValue $Ctx 'authorization'
        if ($auth -and ($auth -match '^(?i)Bearer\s+(.+)$')) { $presented = $Matches[1].Trim() }
    }
    if ($presented) {
        if (-not $configured) { return $false }
        return (Test-FxConstantEqual $presented $configured)
    }
    $class = ''
    try { $class = [string]$Ctx.clientClass } catch { }
    return ($class -eq 'loopback' -or $class -eq 'tailnet')
}
function Test-FxCsrf {
    # §1.5/§1.6 POST guard. The value must equal the per-process CSRF token AND
    # (when the browser sent one) the SameSite=Strict cookie's value.
    param($Ctx)
    $expected = ''
    try { $expected = [string]$Ctx.csrfToken } catch { }
    if (-not $expected) { return $false }
    $presented = Get-FxHeaderValue $Ctx 'x-csrf-token'
    if (-not $presented) { return $false }
    if (-not (Test-FxConstantEqual $presented $expected)) { return $false }
    return $true
}
function Get-FxCsrfCookieLine {
    param($Ctx)
    $tok = ''
    try { $tok = [string]$Ctx.csrfToken } catch { }
    if (-not $tok) { return @() }
    return @('Set-Cookie: ghrdp_fx_csrf=' + $tok + '; Path=/; SameSite=Strict')
}
function Get-FxPreviewCapBytes {
    param($Ctx)
    $cap = $script:FxPreviewMaxBytes
    try {
        if ($Ctx.options -and $Ctx.options.ContainsKey('PreviewMaxBytes') -and $Ctx.options['PreviewMaxBytes']) { $cap = [int64]$Ctx.options['PreviewMaxBytes'] }
    } catch { }
    try {
        $cfg = $Ctx.options['Config']
        if ($cfg) {
            $v = Get-FxNullableNumber $cfg 'fxPreviewMaxBytes'
            if ($null -ne $v -and [int64]$v -gt 0) { $cap = [int64]$v }
        }
    } catch { }
    return [int64]$cap
}
function Read-FxIndexForRoute {
    # Shared /list /meta /gofile/status /preview /op /upload read path. Returns
    # @{ ok; index; path; response } where response is set on failure.
    param($Ctx)
    $path = Get-FxIndexPath -Root ([string]$Ctx.root) -Options $Ctx.options
    $read = Read-FxJsonFile -Path $path
    if (-not $read.ok) {
        # §1.1 500 with the F44 phase for a parse error; the COMPLETE reader
        # message goes out (never a summary).
        $missing = (-not (Test-Path -LiteralPath $path))
        $code = 500
        $phase = 'parse'
        if ($missing) { $code = 404; $phase = 'parse' }
        return @{ ok = $false; index = $null; path = $path; response = (New-FxErrorResponse -Code $code -Phase $phase -Message ([string]$read.error) -Extra @{ index = $path }) }
    }
    $index = ConvertTo-FxIndexV2 $read.value
    return @{ ok = $true; index = $index; path = $path; response = $null }
}

# ---------------------------------------------------------------------------
# §1.1 GET /api/fx/list
# ---------------------------------------------------------------------------
function Invoke-FxListRoute {
    param($Ctx)
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) { return $read.response }
    $index = $read.index
    $rootFilter = Get-FxQueryValue $Ctx 'root'
    if ($rootFilter) {
        if ($script:FxRoots -notcontains $rootFilter) {
            return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message ('unknown root filter: ' + $rootFilter))
        }
        $files = @()
        foreach ($f in @($index.files)) { if ((Get-FxString $f 'root') -eq $rootFilter) { $files += $f } }
        $roots = @()
        foreach ($r in @($index.roots)) { if ((Get-FxString $r 'root') -eq $rootFilter) { $roots += $r } }
        $filtered = [ordered]@{
            schemaVersion = $script:FxSchemaVersion
            generatedAt = $index.generatedAt
            runnerId = $index.runnerId
            roots = $roots
            files = $files
            gofileHosts = $index.gofileHosts
        }
        $index = $filtered
    }
    $headers = @()
    try { $headers += (Get-FxCsrfCookieLine $Ctx) } catch { }
    try { if ($Ctx.csrfToken) { $headers += ('X-CSRF-Token: ' + [string]$Ctx.csrfToken) } } catch { }
    [void](Write-FxAudit $Ctx ('fx list ok files=' + @($index.files).Count + ' root=' + $(if ($rootFilter) { $rootFilter } else { 'all' })))
    return (New-FxResponse -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes $index) -Headers $headers)
}

# ---------------------------------------------------------------------------
# §1.2 GET /api/fx/meta?id=
# ---------------------------------------------------------------------------
function Invoke-FxMetaRoute {
    param($Ctx)
    $id = Get-FxQueryValue $Ctx 'id'
    if (-not $id) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'id query parameter is required') }
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) { return $read.response }
    $entry = Get-FxFileEntry $read.index $id
    if (-not $entry) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message ('unknown id: ' + $id)) }
    [void](Write-FxAudit $Ctx ('fx meta ok id=' + $id))
    return (New-FxResponse -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes $entry) -Headers (Get-FxCsrfCookieLine $Ctx))
}

# ---------------------------------------------------------------------------
# §1.3 GET /api/fx/gofile/status?id=
# ---------------------------------------------------------------------------
function Get-FxGofileToken {
    # Operator-configured host credential. Read from config.json (gofileToken)
    # or gofile-token.txt in Root; the lab env var is the test seam. Absent means
    # "do not poll" - never "poll anonymously".
    param($Ctx)
    try {
        if ($Ctx.options -and $Ctx.options.ContainsKey('GofileToken') -and $Ctx.options['GofileToken']) { return [string]$Ctx.options['GofileToken'] }
    } catch { }
    if ($env:GHRDP_FX_GOFILE_TOKEN) { return [string]$env:GHRDP_FX_GOFILE_TOKEN }
    try {
        $cfg = $Ctx.options['Config']
        if ($cfg) {
            $t = Get-FxNullableString $cfg 'gofileToken'
            if ($t) { return $t }
        }
    } catch { }
    try {
        $p = Join-Path ([string]$Ctx.root) 'gofile-token.txt'
        if (Test-Path -LiteralPath $p) { return ([System.IO.File]::ReadAllText($p)).Trim() }
    } catch { }
    return ''
}
function Invoke-FxHttpBytes {
    # The ONE network seam. $Ctx.options.Fetch (a scriptblock) replaces it in
    # tests: param($Uri, $Headers) -> @{ ok; status; contentType; bytes; error;
    # kind } where kind is 'transport' | 'timeout' | 'protocol' | 'ok'.
    param($Ctx, [string]$Uri, [hashtable]$Headers = @{}, [string]$RangeHeader = '')
    try {
        if ($Ctx.options -and $Ctx.options.ContainsKey('Fetch') -and $Ctx.options['Fetch']) {
            return (& $Ctx.options['Fetch'] $Uri $Headers $RangeHeader)
        }
    } catch {
        return @{ ok = $false; status = 0; contentType = ''; bytes = [byte[]]@(); error = ('injected fetch failed: ' + $_.Exception.Message); kind = 'transport' }
    }
    $req = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create($Uri)
        $req.Method = 'GET'
        $req.Timeout = 20000
        $req.ReadWriteTimeout = 30000
        $req.UserAgent = 'ghrdp-fx/1.0'
        foreach ($k in @($Headers.Keys)) { $req.Headers[$k] = [string]$Headers[$k] }
        if ($RangeHeader) { $req.Headers['Range'] = $RangeHeader }
        $resp = $req.GetResponse()
        try {
            $ms = New-Object System.IO.MemoryStream
            $resp.GetResponseStream().CopyTo($ms)
            $bytes = $ms.ToArray()
            $ms.Dispose()
            return @{ ok = $true; status = [int]$resp.StatusCode; contentType = [string]$resp.ContentType; bytes = $bytes; error = ''; kind = 'ok' }
        } finally { $resp.Close() }
    } catch [System.Net.WebException] {
        $we = $_.Exception
        $status = 0
        try { if ($we.Response) { $status = [int]$we.Response.StatusCode } } catch { }
        $kind = 'transport'
        if ($we.Status -eq [System.Net.WebExceptionStatus]::Timeout) { $kind = 'timeout' }
        elseif ($we.Status -eq [System.Net.WebExceptionStatus]::ProtocolError) { $kind = 'protocol' }
        return @{ ok = $false; status = $status; contentType = ''; bytes = [byte[]]@(); error = ('host transport error: ' + $we.Message); kind = $kind }
    } catch {
        return @{ ok = $false; status = 0; contentType = ''; bytes = [byte[]]@(); error = ('host transport error: ' + $_.Exception.Message); kind = 'transport' }
    }
}
function Invoke-FxHttpJson {
    param($Ctx, [string]$Uri, [hashtable]$Headers = @{})
    $raw = Invoke-FxHttpBytes -Ctx $Ctx -Uri $Uri -Headers $Headers
    if (-not $raw.ok) { return $raw }
    $parsed = $null
    try { $parsed = ([System.Text.Encoding]::UTF8.GetString([byte[]]$raw.bytes) | ConvertFrom-Json) } catch {
        return @{ ok = $false; status = [int]$raw.status; json = $null; error = ('host response was not valid JSON: ' + $_.Exception.Message); kind = 'parse' }
    }
    return @{ ok = $true; status = [int]$raw.status; json = $parsed; error = ''; kind = 'ok' }
}
function Invoke-FxGofileStatusRoute {
    param($Ctx)
    $id = Get-FxQueryValue $Ctx 'id'
    if (-not $id) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'id query parameter is required') }
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) { return $read.response }
    $entry = Get-FxFileEntry $read.index $id
    if (-not $entry) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message ('unknown id: ' + $id)) }
    $state = $entry.gofile
    $token = Get-FxGofileToken $Ctx
    if (-not $token) {
        [void](Write-FxAudit $Ctx ('fx gofile status cached id=' + $id + ' (no host token configured: no poll)'))
        return (New-FxResponse -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes $state) -Headers (Get-FxCsrfCookieLine $Ctx))
    }
    $fileId = Get-FxString $state 'fileId'
    if (-not $fileId) {
        [void](Write-FxAudit $Ctx ('fx gofile status cached id=' + $id + ' (no fileId recorded: no poll)'))
        return (New-FxResponse -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes $state) -Headers (Get-FxCsrfCookieLine $Ctx))
    }
    # §1.3 optional live poll. The token travels in the Authorization header
    # only; it is never part of the URL, never echoed and never logged.
    $uri = $script:FxGofileApiBase + '/contents/' + [uri]::EscapeDataString($fileId)
    $hdrs = @{ 'Authorization' = 'Bearer ' + $token; 'Accept' = 'application/json' }
    $result = Invoke-FxHttpJson -Ctx $Ctx -Uri $uri -Headers $hdrs
    if (-not $result.ok) {
        $secrets = Get-FxSecretList $Ctx
        $msg = Protect-FxText -Text ([string]$result.error) -Secrets $secrets
        [void](Write-FxAudit $Ctx ('fx gofile status host-poll failed id=' + $id + ' kind=' + [string]$result.kind + ' :: ' + $msg))
        $code = 502
        $phase = 'http'
        if ($result.kind -eq 'timeout') { $code = 504; $phase = 'tcp' }
        return (New-FxErrorResponse -Code $code -Phase $phase -Message $msg -Extra @{ id = $id; hostStatus = [int]$result.status } -Headers @('Retry-After: 5'))
    }
    $data = $null
    try { $data = Get-FxProp $result.json 'data' } catch { $data = $null }
    if ($null -eq $data) {
        $msg = Protect-FxText -Text ('host response carried no data block') -Secrets (Get-FxSecretList $Ctx)
        [void](Write-FxAudit $Ctx ('fx gofile status host-poll unreadable id=' + $id + ' :: ' + $msg))
        return (New-FxErrorResponse -Code 502 -Phase 'http' -Message $msg -Extra @{ id = $id; hostStatus = [int]$result.status } -Headers @('Retry-After: 5'))
    }
    $fresh = [ordered]@{
        code = (Get-FxNullableString $state 'code')
        fileId = (Get-FxNullableString $state 'fileId')
        directUrl = $null
        status = (Get-FxMember (Get-FxProp $data 'status') $script:FxGofileStatuses 'failed')
        uploadedAt = (Get-FxNullableString $state 'uploadedAt')
        expiryTs = (Get-FxNullableString $state 'expiryTs')
        downloads = (Get-FxNumber $data 'downloads' (Get-FxNumber $state 'downloads' 0))
        remoteSize = (Get-FxNullableNumber $data 'size')
    }
    if ($fresh.status -eq 'uploaded') {
        $direct = (Get-FxSafeDirectUrl (Get-FxProp $state 'directUrl'))
        $fresh.directUrl = $direct
    }
    [void](Write-FxAudit $Ctx ('fx gofile status live id=' + $id + ' status=' + [string]$fresh.status))
    return (New-FxResponse -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes $fresh) -Headers (Get-FxCsrfCookieLine $Ctx))
}

# ---------------------------------------------------------------------------
# §1.4 GET /api/fx/preview?id=  (Range-aware byte stream)
# ---------------------------------------------------------------------------
function Resolve-FxLocalPath {
    # Root name -> base directory, then a containment check on the FULL path.
    # The index is data, never a filesystem authority: a path that escapes its
    # root base is refused here even if the index claims it exists.
    param([string]$Root, $Entry)
    $rootName = Get-FxString $Entry 'root'
    $rel = Get-FxString $Entry 'path'
    if (-not $rel) { return '' }
    $base = ''
    switch ($rootName) {
        'Downloads' {
            $profile = ''
            try { $profile = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile) } catch { $profile = '' }
            if (-not $profile) { $profile = [string]$env:USERPROFILE }
            if ($profile) { $base = Join-Path $profile 'Downloads' }
        }
        'Desktop' {
            $profile = ''
            try { $profile = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile) } catch { $profile = '' }
            if (-not $profile) { $profile = [string]$env:USERPROFILE }
            if ($profile) { $base = Join-Path $profile 'Desktop' }
        }
        'Documents' {
            $docs = ''
            try { $docs = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments) } catch { $docs = '' }
            if (-not $docs) {
                $profile = [string]$env:USERPROFILE
                if ($profile) { $docs = Join-Path $profile 'Documents' }
            }
            $base = $docs
        }
        'Temp' {
            $t = ''
            try { $t = [System.IO.Path]::GetTempPath() } catch { $t = '' }
            if (-not $t) { $t = [string]$env:TEMP }
            $base = $t
        }
        'RDP-Storage' { $base = Join-Path $Root 'storage' }
        default { $base = '' }
    }
    if (-not $base) { return '' }
    $candidate = ''
    try {
        $norm = ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar).TrimStart([System.IO.Path]::DirectorySeparatorChar)
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $base $norm))
    } catch { return '' }
    $baseFull = ''
    try { $baseFull = [System.IO.Path]::GetFullPath($base) } catch { return '' }
    $sep = [System.IO.Path]::DirectorySeparatorChar
    if (-not $baseFull.EndsWith([string]$sep)) { $baseFull = $baseFull + [string]$sep }
    $cmp = [System.StringComparison]::Ordinal
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) { $cmp = [System.StringComparison]::OrdinalIgnoreCase }
    if (-not $candidate.StartsWith($baseFull, $cmp)) { return '' }
    return $candidate
}
function Get-FxRangeSpec {
    # Single-range only (bytes=a-b | bytes=a- | bytes=-n). Returns
    # @{ present; satisfiable; start; end; length } with inclusive indices.
    param([string]$HeaderValue, [int64]$Total)
    $res = @{ present = $false; satisfiable = $true; start = [int64]0; end = [int64]0; length = [int64]$Total }
    if (-not $HeaderValue) { return $res }
    $res.present = $true
    $spec = $HeaderValue.Trim()
    if ($spec -notmatch '^(?i)bytes=(.+)$') { $res.satisfiable = $false; return $res }
    $inner = $Matches[1].Trim()
    if ($inner.Contains(',')) { $res.satisfiable = $false; return $res }
    if ($inner -match '^(\d*)-(\d*)$') {
        $a = $Matches[1]
        $b = $Matches[2]
        if ($a -eq '' -and $b -eq '') { $res.satisfiable = $false; return $res }
        if ($a -eq '') {
            $suffix = [int64]$b
            if ($suffix -le 0) { $res.satisfiable = $false; return $res }
            if ($suffix -ge $Total) { $res.start = 0 } else { $res.start = $Total - $suffix }
            $res.end = $Total - 1
        } else {
            $res.start = [int64]$a
            if ($b -eq '') { $res.end = $Total - 1 } else { $res.end = [int64]$b }
            if ($res.end -gt ($Total - 1)) { $res.end = $Total - 1 }
        }
        if ($Total -le 0 -or $res.start -ge $Total -or $res.end -lt $res.start) { $res.satisfiable = $false; return $res }
        $res.length = $res.end - $res.start + 1
        return $res
    }
    $res.satisfiable = $false
    return $res
}
function Invoke-FxPreviewRoute {
    param($Ctx)
    $id = Get-FxQueryValue $Ctx 'id'
    if (-not $id) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'id query parameter is required') }
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) { return $read.response }
    $entry = Get-FxFileEntry $read.index $id
    if (-not $entry) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message ('unknown id: ' + $id)) }
    $mime = (Get-FxString $entry 'mime' 'application/octet-stream').ToLowerInvariant()
    if ($script:FxPreviewMime -notcontains $mime) {
        # §1.4 415: the index knows the type, and the type has no renderer.
        return (New-FxErrorResponse -Code 415 -Phase 'type' -Message ('preview is not available for ' + $mime) -Extra @{ id = $id; mime = $mime })
    }
    $cap = Get-FxPreviewCapBytes $Ctx
    $rangeHeader = Get-FxHeaderValue $Ctx 'range'
    $localPath = Resolve-FxLocalPath -Root ([string]$Ctx.root) -Entry $entry
    $isLocal = $false
    if ($localPath) { $isLocal = (Test-Path -LiteralPath $localPath -PathType Leaf) }
    $source = 'gofile'
    if ($isLocal) { $source = 'local' }
    $bytes = $null
    $fullTotal = [int64](Get-FxNumber $entry 'size' 0)
    $spec = $null
    if ($isLocal) {
        try { $fullTotal = [int64](Get-Item -LiteralPath $localPath).Length } catch { }
        if ($fullTotal -gt $cap) { return (New-FxErrorResponse -Code 413 -Phase 'size' -Message ('file is ' + $fullTotal + ' bytes; the preview cap is ' + $cap) -Extra @{ id = $id; size = $fullTotal; cap = $cap }) }
        $spec = Get-FxRangeSpec -HeaderValue $rangeHeader -Total $fullTotal
        if (-not $spec.satisfiable) {
            return (New-FxResponse -Code 416 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes ([ordered]@{ phase = 'size'; error = ('range ' + $rangeHeader + ' is not satisfiable for ' + $fullTotal + ' bytes'); id = $id; size = $fullTotal })) -Headers @('Content-Range: bytes */' + $fullTotal))
        }
        try {
            $fs = [System.IO.File]::Open($localPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            try {
                [void]$fs.Seek([int64]$spec.start, [System.IO.SeekOrigin]::Begin)
                $length = [int64]$spec.length
                $buffer = New-Object byte[] ([int]$length)
                $readTotal = 0
                while ($readTotal -lt $length) {
                    $n = $fs.Read($buffer, $readTotal, [int]($length - $readTotal))
                    if ($n -le 0) { break }
                    $readTotal = $readTotal + $n
                }
                if ($readTotal -le 0) { $buffer = [byte[]]@() }
                elseif ($readTotal -lt $length) { $buffer = $buffer[0..([int]($readTotal - 1))] }
                $bytes = $buffer
            } finally { $fs.Dispose() }
        } catch {
            $msg = Protect-FxText -Text ('local read failed: ' + $_.Exception.Message) -Secrets (Get-FxSecretList $Ctx)
            return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message $msg -Extra @{ id = $id })
        }
    } else {
        # Remote path: only a stored, credential-free https direct link is ever
        # proxied (§4 invariant). No link -> 404, never a fabricated host call.
        $direct = Get-FxSafeDirectUrl (Get-PropOrNull $entry 'gofile' 'directUrl')
        if (-not $direct) {
            return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message ('no local file and no host copy for id ' + $id) -Extra @{ id = $id })
        }
        if ($fullTotal -gt $cap) { return (New-FxErrorResponse -Code 413 -Phase 'size' -Message ('file is ' + $fullTotal + ' bytes; the preview cap is ' + $cap) -Extra @{ id = $id; size = $fullTotal; cap = $cap }) }
        $token = Get-FxGofileToken $Ctx
        $hdrs = @{ 'Accept' = '*/*' }
        if ($token) { $hdrs['Authorization'] = 'Bearer ' + $token }
        $raw = Invoke-FxHttpBytes -Ctx $Ctx -Uri $direct -Headers $hdrs
        if (-not $raw.ok) {
            $secrets = Get-FxSecretList $Ctx
            $msg = Protect-FxText -Text ([string]$raw.error) -Secrets $secrets
            $code = 502
            $phase = 'http'
            if ([string]$raw.kind -eq 'timeout') { $code = 504; $phase = 'tcp' }
            elseif ([int]$raw.status -eq 404) { $code = 404; $phase = 'parse' }
            [void](Write-FxAudit $Ctx ('fx preview host fetch failed id=' + $id + ' code=' + $code + ' :: ' + $msg))
            return (New-FxErrorResponse -Code $code -Phase $phase -Message $msg -Extra @{ id = $id; hostStatus = [int]$raw.status } -Headers @('Retry-After: 5'))
        }
        $bytes = [byte[]]$raw.bytes
        $fullTotal = [int64]$bytes.Length
        if ($fullTotal -gt $cap) { return (New-FxErrorResponse -Code 413 -Phase 'size' -Message ('host object is ' + $fullTotal + ' bytes; the preview cap is ' + $cap) -Extra @{ id = $id; size = $fullTotal; cap = $cap }) }
        $remoteMime = ''
        if ($raw.contentType) { $remoteMime = ([string]$raw.contentType).Split(';')[0].Trim().ToLowerInvariant() }
        if ($remoteMime -and $remoteMime -ne $mime -and ($script:FxPreviewMime -contains $remoteMime)) { $mime = $remoteMime }
        $spec = Get-FxRangeSpec -HeaderValue $rangeHeader -Total $fullTotal
        if (-not $spec.satisfiable) {
            return (New-FxResponse -Code 416 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes ([ordered]@{ phase = 'size'; error = ('range ' + $rangeHeader + ' is not satisfiable for ' + $fullTotal + ' bytes'); id = $id; size = $fullTotal })) -Headers @('Content-Range: bytes */' + $fullTotal))
        }
        if ($spec.present) {
            $sliced = New-Object byte[] ([int]$spec.length)
            [Array]::Copy($bytes, [int]$spec.start, $sliced, 0, [int]$spec.length)
            $bytes = $sliced
        }
    }
    if ($null -eq $bytes) { $bytes = [byte[]]@() }
    $fileName = 'file'
    try { $fileName = [System.IO.Path]::GetFileName((Get-FxString $entry 'path' 'file')) } catch { }
    if (-not $fileName) { $fileName = 'file' }
    $headers = @(
        'Accept-Ranges: bytes',
        'X-Content-Type-Options: nosniff',
        ('Content-Disposition: inline; filename="' + ($fileName -replace '"', '') + '"')
    )
    $code = 200
    if ($spec.present) {
        $code = 206
        $headers += ('Content-Range: bytes ' + $spec.start + '-' + $spec.end + '/' + $fullTotal)
    }
    [void](Write-FxAudit $Ctx ('fx preview id=' + $id + ' source=' + $source + ' code=' + $code + ' bytes=' + @($bytes).Count))
    return (New-FxResponse -Code $code -CType $mime -Body $bytes -Headers $headers)
}
function Get-PropOrNull {
    # Nested property read used by the preview remote path (gofile.directUrl).
    param($Obj, [string]$Name, [string]$Field = '')
    if (-not $Field) { return (Get-FxProp $Obj $Name) }
    return (Get-FxProp (Get-FxProp $Obj $Name) $Field)
}

# ---------------------------------------------------------------------------
# §1.5 POST /api/fx/op
# ---------------------------------------------------------------------------
function Invoke-FxOpBody {
    # Pure index mutation. Returns @{ applied; skipped; changed }.
    param($Index, $Body, [string]$NowIso)
    $op = Get-FxString $Body 'op'
    $ids = @()
    foreach ($v in @(Get-FxProp $Body 'ids')) { if ($v -is [string] -and $v) { $ids += $v } }
    $applied = @()
    $skipped = @()
    $changed = $false
    $target = Get-FxString $Body 'target'
    $tags = @()
    foreach ($t in @(Get-FxProp $Body 'tags')) { if ($t -is [string] -and $t) { $tags += $t } }
    $pin = (Get-FxProp $Body 'pin') -eq $true
    foreach ($id in $ids) {
        $entry = Get-FxFileEntry $Index $id
        if (-not $entry) { $skipped += [ordered]@{ id = $id; reason = 'unknown id' }; continue }
        $skipReason = ''
        $trashed = ((Get-FxProp $entry 'trashed') -eq $true)
        switch ($op) {
            'trash' {
                if ($trashed) { $skipReason = 'already trashed' }
                else {
                    $entry['trashed'] = $true
                    $entry['trashedAt'] = $NowIso
                    $changed = $true
                }
            }
            'restore' {
                if (-not $trashed) { $skipReason = 'not trashed' }
                else {
                    $entry['trashed'] = $false
                    $entry['trashedAt'] = $null
                    $changed = $true
                }
            }
            'move' {
                if (-not $target) { $skipReason = 'move requires a target path' }
                elseif ($target -notmatch '^/') { $skipReason = 'target must be a POSIX path with a leading slash' }
                else {
                    $norm = '/' + (($target -replace '\\', '/') -replace '^/+', '')
                    if ($norm -eq (Get-FxString $entry 'path')) { $skipReason = 'already at the target path' }
                    else {
                        $clash = $null
                        foreach ($other in @($Index.files)) {
                            if ((Get-FxString $other 'path') -eq $norm -and (Get-FxString $other 'root') -eq (Get-FxString $entry 'root')) { $clash = $other; break }
                        }
                        if ($clash) { $skipReason = 'a file already exists at the target path' }
                        else {
                            $entry['path'] = $norm
                            # Identity is SHA-1(root+path): a move produces a NEW
                            # id, and the response reports the id that was asked
                            # for (the caller re-reads /list for the new one).
                            $entry['id'] = (Get-FxStableId (Get-FxString $entry 'root') $norm)
                            $changed = $true
                        }
                    }
                }
            }
            'tag' {
                if ($tags.Count -eq 0) { $skipReason = 'tag requires at least one tag' }
                else {
                    $current = @(@(Get-FxProp $entry 'tags') | Where-Object { $_ -is [string] })
                    $merged = @($current)
                    foreach ($t in $tags) { if ($merged -notcontains $t) { $merged += $t } }
                    $entry['tags'] = $merged
                    $changed = $true
                }
            }
            'pin' {
                $want = $true
                if (Test-FxHasProp $Body 'pin') { $want = $pin }
                if (((Get-FxProp $entry 'pinned') -eq $true) -eq $want) { $skipReason = 'already in the requested pin state' }
                else {
                    $entry['pinned'] = $want
                    $changed = $true
                }
            }
            default { $skipReason = 'unknown op: ' + $op }
        }
        if ($skipReason) { $skipped += [ordered]@{ id = $id; reason = $skipReason } } else { $applied += $id }
    }
    return @{ applied = $applied; skipped = $skipped; changed = $changed }
}
function Invoke-FxOpRoute {
    param($Ctx)
    if (-not (Test-FxCsrf $Ctx)) {
        [void](Write-FxAudit $Ctx ('fx op refused: CSRF token missing or wrong path=' + [string]$Ctx.path))
        return (New-FxErrorResponse -Code 403 -Phase 'auth' -Message 'CSRF token missing or invalid')
    }
    $body = $null
    try {
        $text = [System.Text.Encoding]::UTF8.GetString([byte[]]$Ctx.body)
        if (-not $text) { throw 'empty body' }
        $body = ($text | ConvertFrom-Json)
    } catch {
        return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message ('request body is not valid JSON: ' + $_.Exception.Message))
    }
    # §5.1(3): hard delete exists nowhere. The flag is refused with 400 for any
    # value, because a `hard:false` still means the caller believes it exists.
    if (Test-FxHasProp $body 'hard') {
        [void](Write-FxAudit $Ctx 'fx op refused: hard flag is not an Explorer operation')
        return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'hard delete is not an Explorer operation')
    }
    $op = Get-FxString $body 'op'
    if (@('trash', 'restore', 'move', 'tag', 'pin') -notcontains $op) {
        return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message ('unknown op: ' + $(if ($op) { $op } else { '(missing)' })))
    }
    $ids = @()
    foreach ($v in @(Get-FxProp $body 'ids')) { if ($v -is [string] -and $v) { $ids += $v } }
    if ($ids.Count -eq 0) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'op requires at least one id') }
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) { return $read.response }
    $index = $read.index
    $nowIso = (Get-Date).ToUniversalTime().ToString('o')
    $result = Invoke-FxOpBody -Index $index -Body $body -NowIso $nowIso
    if ($result.changed) {
        try {
            [void](Save-FxJsonAtomic -Path $read.path -Value $index)
        } catch {
            $msg = Protect-FxText -Text ('index write failed: ' + $_.Exception.Message) -Secrets (Get-FxSecretList $Ctx)
            [void](Write-FxAudit $Ctx ('fx op write failed :: ' + $msg))
            return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message $msg)
        }
    }
    [void](Write-FxAudit $Ctx ('fx op=' + $op + ' applied=' + $result.applied.Count + ' skipped=' + $result.skipped.Count))
    return (New-FxResponse -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes ([ordered]@{ applied = $result.applied; skipped = $result.skipped })) -Headers (Get-FxCsrfCookieLine $Ctx))
}

# ---------------------------------------------------------------------------
# §1.6 POST /api/fx/upload + the queue/worker state machine
# ---------------------------------------------------------------------------
function Read-FxUploadQueue {
    param([string]$Path)
    $read = Read-FxJsonFile -Path $Path
    if (-not $read.ok) { return @{ jobs = @(); path = $Path; loaded = $false; error = [string]$read.error } }
    $jobs = @()
    foreach ($j in @(Get-FxProp $read.value 'jobs')) {
        # Normalise every job into an ordered hashtable: the state machine
        # mutates jobs by key, and a PSCustomObject read from JSON refuses a key
        # that is not already in the file.
        $jobs += [ordered]@{
            uploadJobId = (Get-FxString $j 'uploadJobId')
            id = (Get-FxString $j 'id')
            host = (Get-FxString $j 'host' 'gofile')
            root = (Get-FxString $j 'root')
            path = (Get-FxString $j 'path')
            size = (Get-FxNumber $j 'size' 0)
            status = (Get-FxMember (Get-FxString $j 'status') $script:FxUploadStatuses 'queued')
            phase = (Get-FxNullableString $j 'phase')
            retries = (Get-FxNumber $j 'retries' 0)
            bytesSent = (Get-FxNumber $j 'bytesSent' 0)
            lastError = (Get-FxProp $j 'lastError')
            nextAttemptTs = (Get-FxString $j 'nextAttemptTs')
        }
    }
    return @{ jobs = $jobs; path = $Path; loaded = $true; error = '' }
}
function Save-FxUploadQueue {
    param([string]$Path, $Jobs)
    $doc = [ordered]@{
        schemaVersion = $script:FxSchemaVersion
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        jobs = @($Jobs)
    }
    [void](Save-FxJsonAtomic -Path $Path -Value $doc)
    return $doc
}
function New-FxUploadJob {
    param([string]$Id, [string]$HostId, $Entry)
    $jobId = 'fxj-' + [guid]::NewGuid().ToString('n').Substring(0, 12)
    return [ordered]@{
        uploadJobId = $jobId
        id = $Id
        host = $HostId
        root = (Get-FxString $Entry 'root')
        path = (Get-FxString $Entry 'path')
        size = (Get-FxNumber $Entry 'size' 0)
        status = 'queued'
        phase = $null
        retries = 0
        bytesSent = 0
        lastError = $null
        queuedAt = (Get-Date).ToUniversalTime().ToString('o')
        nextAttemptTs = (Get-Date).ToUniversalTime().ToString('o')
    }
}
function Invoke-FxUploadRoute {
    param($Ctx)
    if (-not (Test-FxCsrf $Ctx)) {
        [void](Write-FxAudit $Ctx 'fx upload refused: CSRF token missing or wrong')
        return (New-FxErrorResponse -Code 403 -Phase 'auth' -Message 'CSRF token missing or invalid')
    }
    $body = $null
    try {
        $text = [System.Text.Encoding]::UTF8.GetString([byte[]]$Ctx.body)
        if (-not $text) { throw 'empty body' }
        $body = ($text | ConvertFrom-Json)
    } catch {
        return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message ('request body is not valid JSON: ' + $_.Exception.Message))
    }
    $hostId = Get-FxString $body 'host' 'gofile'
    if ($script:FxUploadHosts -notcontains $hostId) {
        return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message ('unknown upload host: ' + $hostId))
    }
    $ids = @()
    foreach ($v in @(Get-FxProp $body 'ids')) { if ($v -is [string] -and $v) { $ids += $v } }
    if ($ids.Count -eq 0) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'upload requires at least one id') }
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) { return $read.response }
    $index = $read.index
    $queuePath = Get-FxQueuePath -Root ([string]$Ctx.root) -Options $Ctx.options
    $queue = Read-FxUploadQueue -Path $queuePath
    $jobs = @($queue.jobs)
    $created = @()
    $skipped = @()
    foreach ($id in $ids) {
        $entry = Get-FxFileEntry $index $id
        if (-not $entry) { $skipped += [ordered]@{ id = $id; reason = 'unknown id' }; continue }
        $job = New-FxUploadJob -Id $id -HostId $hostId -Entry $entry
        $jobs += $job
        $created += [ordered]@{ id = $id; uploadJobId = [string]$job.uploadJobId }
    }
    if ($created.Count -eq 0) {
        return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'no requested id exists in the index' -Extra @{ skipped = $skipped })
    }
    try {
        [void](Save-FxUploadQueue -Path $queuePath -Jobs $jobs)
    } catch {
        $msg = Protect-FxText -Text ('upload queue write failed: ' + $_.Exception.Message) -Secrets (Get-FxSecretList $Ctx)
        [void](Write-FxAudit $Ctx ('fx upload queue failed :: ' + $msg))
        return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message $msg)
    }
    [void](Write-FxAudit $Ctx ('fx upload queued jobs=' + $created.Count + ' host=' + $hostId))
    $payload = [ordered]@{ jobs = $created }
    if ($skipped.Count -gt 0) { $payload['skipped'] = $skipped }
    return (New-FxResponse -Code 202 -CType 'application/json; charset=utf-8' -Body (ConvertTo-FxJsonBytes $payload) -Headers (Get-FxCsrfCookieLine $Ctx))
}
function Invoke-FxUploadStep {
    # §1.6/§8 ONE worker step: advances a single due job through the phase state
    # machine and persists the queue. The uploader is injectable
    # ($Options.Uploader: param($Job, $Path) -> @{ ok; phase; httpStatus;
    # hostMessage; fileId; code; directUrl; bytesSent }), so the machine is
    # exercised without a live host and the production path is the default.
    param($Ctx, [hashtable]$Options = @{})
    $queuePath = Get-FxQueuePath -Root ([string]$Ctx.root) -Options $Ctx.options
    $queue = Read-FxUploadQueue -Path $queuePath
    $jobs = @($queue.jobs)
    if ($jobs.Count -eq 0) { return @{ processed = $false; reason = 'queue empty'; jobId = '' } }
    $now = (Get-Date).ToUniversalTime()
    $index = $null
    $target = -1
    for ($i = 0; $i -lt $jobs.Count; $i++) {
        $j = $jobs[$i]
        $status = Get-FxString $j 'status'
        if ($status -ne 'queued' -and $status -ne 'uploading') { continue }
        $due = $true
        $ts = Get-FxString $j 'nextAttemptTs'
        if ($ts) {
            $dt = [datetime]::MinValue
            try { if ([datetime]::TryParse($ts, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$dt)) { $due = ($now - $dt.ToUniversalTime()).TotalSeconds -ge 0 } } catch { $due = $true }
        }
        if ($due) { $target = $i; break }
    }
    if ($target -lt 0) { return @{ processed = $false; reason = 'no due job'; jobId = '' } }
    $job = $jobs[$target]
    $id = Get-FxString $job 'id'
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) {
        $job['status'] = 'failed'
        $job['phase'] = 'parse'
        $job['lastError'] = [ordered]@{ phase = 'parse'; httpStatus = $null; hostMessage = [string]$read.response.Code + ' index unreadable'; at = $now.ToString('o') }
        $jobs[$target] = $job
        [void](Save-FxUploadQueue -Path $queuePath -Jobs $jobs)
        return @{ processed = $true; reason = 'index unreadable'; jobId = $id }
    }
    $index = $read.index
    $entry = Get-FxFileEntry $index $id
    if (-not $entry) {
        $job['status'] = 'failed'
        $job['phase'] = 'parse'
        $job['lastError'] = [ordered]@{ phase = 'parse'; httpStatus = $null; hostMessage = 'unknown id at upload time'; at = $now.ToString('o') }
        $jobs[$target] = $job
        [void](Save-FxUploadQueue -Path $queuePath -Jobs $jobs)
        return @{ processed = $true; reason = 'unknown id'; jobId = $id }
    }
    $job['status'] = 'uploading'
    $localPath = Resolve-FxLocalPath -Root ([string]$Ctx.root) -Entry $entry
    $uploader = $null
    try { if ($Options.ContainsKey('Uploader') -and $Options['Uploader']) { $uploader = $Options['Uploader'] } } catch { $uploader = $null }
    if (-not $uploader) {
        try { if ($Ctx.options.ContainsKey('Uploader') -and $Ctx.options['Uploader']) { $uploader = $Ctx.options['Uploader'] } } catch { $uploader = $null }
    }
    if (-not $localPath -or -not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
        $job['status'] = 'failed'
        $job['phase'] = 'parse'
        $job['lastError'] = [ordered]@{ phase = 'parse'; httpStatus = $null; hostMessage = 'upload source is not readable on this host'; at = $now.ToString('o') }
        $jobs[$target] = $job
        [void](Save-FxUploadQueue -Path $queuePath -Jobs $jobs)
        return @{ processed = $true; reason = 'source missing'; jobId = $id }
    }
    $token = Get-FxGofileToken $Ctx
    if (-not $uploader -and -not $token) {
        # No host credential: the job is NOT silently dropped and is NOT sent
        # anonymously - it stays queued with the reason recorded.
        $job['status'] = 'queued'
        $job['phase'] = 'auth'
        $job['lastError'] = [ordered]@{ phase = 'auth'; httpStatus = $null; hostMessage = 'no gofile token configured on this runner; upload not attempted'; at = $now.ToString('o') }
        $job['nextAttemptTs'] = $now.AddSeconds(60).ToString('o')
        $jobs[$target] = $job
        [void](Save-FxUploadQueue -Path $queuePath -Jobs $jobs)
        [void](Write-FxAudit $Ctx ('fx upload job=' + [string]$job.uploadJobId + ' held: no host token configured'))
        return @{ processed = $true; reason = 'no host token'; jobId = $id }
    }
    $result = $null
    if ($uploader) {
        try { $result = (& $uploader $job $localPath) } catch { $result = @{ ok = $false; phase = 'transport'; httpStatus = $null; hostMessage = ('uploader threw: ' + $_.Exception.Message) } }
    } else {
        $result = (Send-FxGofileUpload -Ctx $Ctx -Job $job -Path $localPath -Token $token)
    }
    if ($null -eq $result) { $result = @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = 'uploader returned no result' } }
    $phase = (Get-FxMember (Get-PropOrNull $result 'phase') $script:FxUploadPhases 'http')
    if ($result.ok) {
        $job['status'] = 'success'
        $job['phase'] = $null
        $job['bytesSent'] = (Get-FxNumber $result 'bytesSent' (Get-FxNumber $job 'size' 0))
        $job['lastError'] = $null
        # §1.9 index emission: the uploaded state is written back as schemaVersion
        # 2 with the gofileHosts array, through the same atomic writer.
        try {
            $entry['upload']['status'] = 'success'
            $entry['upload']['phase'] = $null
            $entry['upload']['lastError'] = $null
            $entry['upload']['bytesSent'] = $job['bytesSent']
            $entry['upload']['retries'] = (Get-FxNumber $job 'retries' 0)
            $entry['gofile']['status'] = 'uploaded'
            $entry['gofile']['fileId'] = (Get-FxNullableString $result 'fileId')
            $entry['gofile']['code'] = (Get-FxNullableString $result 'code')
            $entry['gofile']['directUrl'] = (Get-FxSafeDirectUrl (Get-PropOrNull $result 'directUrl'))
            $entry['gofile']['uploadedAt'] = $now.ToString('o')
            [void](Save-FxJsonAtomic -Path $read.path -Value $index)
        } catch {
            [void](Write-FxAudit $Ctx ('fx upload index write failed :: ' + (Protect-FxText -Text $_.Exception.Message -Secrets (Get-FxSecretList $Ctx))))
        }
    } else {
        $hostMessage = Protect-FxText -Text ([string](Get-PropOrNull $result 'hostMessage')) -Secrets (Get-FxSecretList $Ctx)
        $retries = (Get-FxNumber $job 'retries' 0) + 1
        $job['retries'] = $retries
        $job['phase'] = $phase
        $job['lastError'] = [ordered]@{ phase = $phase; httpStatus = (Get-FxNullableNumber $result 'httpStatus'); hostMessage = $hostMessage; at = $now.ToString('o') }
        $transient = ($script:FxTransientPhases -contains $phase)
        if ($transient -and $retries -lt $script:FxUploadMaxRetries) {
            $job['status'] = 'queued'
            $delay = [math]::Min(60, [math]::Pow(2, $retries) * 1)
            $job['nextAttemptTs'] = $now.AddSeconds($delay).ToString('o')
        } else {
            $job['status'] = 'failed'
            $job['nextAttemptTs'] = ''
        }
        try {
            $entry['upload']['status'] = [string]$job['status']
            $entry['upload']['phase'] = $phase
            $entry['upload']['retries'] = $retries
            $entry['upload']['lastError'] = $job['lastError']
            [void](Save-FxJsonAtomic -Path $read.path -Value $index)
        } catch { }
        [void](Write-FxAudit $Ctx ('fx upload job=' + [string]$job.uploadJobId + ' phase=' + $phase + ' retries=' + $retries + ' :: ' + $hostMessage))
    }
    $jobs[$target] = $job
    try { [void](Save-FxUploadQueue -Path $queuePath -Jobs $jobs) } catch { }
    return @{ processed = $true; reason = [string]$job['status']; jobId = $id }
}
function Send-FxGofileUpload {
    # Production uploader: multipart POST to https://<store>.gofile.io/contents/uploadfile
    # with the account token in the Authorization header ONLY. Never called in
    # tests (the injectable Uploader is used) and never called when no token is
    # configured (Invoke-FxUploadStep holds the job instead).
    param($Ctx, $Job, [string]$Path, [string]$Token)
    $server = ''
    try {
        $servers = Invoke-FxHttpJson -Ctx $Ctx -Uri ($script:FxGofileApiBase + '/servers') -Headers @{ 'Accept' = 'application/json' }
        if ($servers.ok) {
            $list = Get-FxProp $servers.json 'data'
            try { if ($list.PSObject.Properties['servers']) { $list = $list.servers } } catch { }
            foreach ($s in @($list)) {
                $nm = Get-FxString $s 'name'
                if ($nm) { $server = $nm; break }
            }
        }
    } catch { $server = '' }
    if (-not $server) { return @{ ok = $false; phase = 'dns'; httpStatus = $null; hostMessage = 'gofile servers endpoint returned no usable store host' } }
    $uri = 'https://' + $server + '.gofile.io/contents/uploadfile'
    try {
        Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
    } catch {
        return @{ ok = $false; phase = 'http'; httpStatus = $null; hostMessage = ('System.Net.Http unavailable: ' + $_.Exception.Message) }
    }
    $client = $null
    $fs = $null
    try {
        $client = New-Object System.Net.Http.HttpClient
        $client.Timeout = [timespan]::FromSeconds(120)
        $client.DefaultRequestHeaders.Add('Authorization', 'Bearer ' + $Token)
        $content = New-Object System.Net.Http.MultipartFormDataContent
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $streamContent = New-Object System.Net.Http.StreamContent($fs)
        $content.Add($streamContent, 'file', [System.IO.Path]::GetFileName($Path))
        $resp = $client.PostAsync($uri, $content).Result
        $text = $resp.Content.ReadAsStringAsync().Result
        $json = $null
        try { $json = ($text | ConvertFrom-Json) } catch { $json = $null }
        if (-not $resp.IsSuccessStatusCode) {
            $msg = 'gofile upload rejected with HTTP ' + [int]$resp.StatusCode + ': ' + $text
            $phase = 'http'
            if ([int]$resp.StatusCode -eq 401 -or [int]$resp.StatusCode -eq 403) { $phase = 'auth' }
            return @{ ok = $false; phase = $phase; httpStatus = [int]$resp.StatusCode; hostMessage = $msg }
        }
        $data = Get-FxProp $json 'data'
        $fileId = Get-FxNullableString $data 'fileId'
        $code = Get-FxNullableString $data 'code'
        $direct = ''
        $dl = Get-FxProp $data 'directLink'
        if ($dl) { $direct = [string]$dl }
        $size = 0
        try { $size = (Get-Item -LiteralPath $Path).Length } catch { $size = 0 }
        return @{ ok = $true; phase = $null; httpStatus = [int]$resp.StatusCode; hostMessage = ''; fileId = $fileId; code = $code; directUrl = $direct; bytesSent = $size }
    } catch [System.AggregateException] {
        $inner = $_.Exception
        try { if ($inner.InnerException) { $inner = $inner.InnerException } } catch { }
        $phase = 'transport'
        if ($inner -is [System.Threading.Tasks.TaskCanceledException]) { $phase = 'timeout' }
        return @{ ok = $false; phase = $phase; httpStatus = $null; hostMessage = ('gofile upload transport failed: ' + $inner.Message) }
    } catch {
        return @{ ok = $false; phase = 'transport'; httpStatus = $null; hostMessage = ('gofile upload failed: ' + $_.Exception.Message) }
    } finally {
        try { if ($fs) { $fs.Dispose() } } catch { }
        try { if ($client) { $client.Dispose() } } catch { }
    }
}
function Get-FxUploadWorkerScript {
    # Detached worker: one process per Root owns the queue (same singleton
    # discipline as the wire-probe / rdp-ping / rdp-usage loops).
    param([string]$Root, [string]$QueuePath, [string]$ModulePath)
    return @'
$ErrorActionPreference = 'Continue'
$root = '__ROOT__'
$queue = '__QUEUE__'
$module = '__MODULE__'
try { . $module } catch { exit 1 }
$ctx = @{
    root = $root
    path = '/api/fx/upload'
    method = 'POST'
    query = @{}
    headers = @{}
    body = [byte[]]@()
    clientClass = 'loopback'
    dashToken = ''
    csrfToken = ''
    options = @{ QueuePath = $queue }
}
while ($true) {
    try { [void](Invoke-FxUploadStep -Ctx $ctx -Options @{}) } catch { }
    Start-Sleep -Seconds 5
}
'@
}
function Start-FxUploadWorker {
    # §1.6 background worker. Windows only: the production runner is Windows and
    # the lab harness must stay deterministic, so a non-Windows host logs the
    # condition instead of spawning a process that cannot exist.
    param([string]$Root, [string]$QueuePath, [string]$ModulePath)
    $result = @{ started = $false; reason = ''; pidFile = ''; scriptPath = '' }
    $isWindows = $false
    try { $isWindows = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) } catch { $isWindows = $false }
    if (-not $isWindows) { $result.reason = 'not a Windows host: worker not started'; return $result }
    if ($env:GHRDP_FX_UPLOAD_WORKER -eq '0') { $result.reason = 'disabled by GHRDP_FX_UPLOAD_WORKER=0'; return $result }
    if (-not $ModulePath -or -not (Test-Path -LiteralPath $ModulePath)) { $result.reason = 'fx module path missing'; return $result }
    $scriptPath = Join-Path $Root 'fx-upload-worker.ps1'
    $pidFile = Join-Path $Root 'fx-upload-worker.pid'
    $text = (Get-FxUploadWorkerScript -Root $Root -QueuePath $QueuePath -ModulePath $ModulePath)
    $text = $text.Replace('__ROOT__', $Root).Replace('__QUEUE__', $QueuePath).Replace('__MODULE__', $ModulePath)
    $result.scriptPath = $scriptPath
    $result.pidFile = $pidFile
    try {
        [System.IO.File]::WriteAllText($scriptPath, $text, $script:FxNoBom)
        $alive = $false
        if (Test-Path -LiteralPath $pidFile) {
            $old = 0
            if ([int]::TryParse(([System.IO.File]::ReadAllText($pidFile)).Trim(), [ref]$old)) {
                try { $p = Get-Process -Id $old -ErrorAction Stop; if ($p) { $alive = $true } } catch { $alive = $false }
            }
        }
        if ($alive) { $result.reason = 'a worker for this Root is already running'; return $result }
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $scriptPath -WindowStyle Hidden -PassThru
        if ($proc) { [System.IO.File]::WriteAllText($pidFile, [string]$proc.Id, $script:FxNoBom) }
        $result.started = $true
        return $result
    } catch {
        $result.reason = 'worker start failed: ' + $_.Exception.Message
        return $result
    }
}

# ---------------------------------------------------------------------------
# §1.7 GET /preview-sandbox/<id>
# ---------------------------------------------------------------------------
function Get-FxSandboxHtml {
    # MIME-explicit shell: the renderer is chosen SERVER-side from the MIME map
    # and rendered as a static element pointing at /api/fx/preview. No inline
    # script, no eval, no host content inlined into the document - S5 owns the
    # interactive renderer and its message bridge.
    param([string]$Id, [string]$Mime, [string]$RootName, [string]$Path, [int64]$Size)
    $renderer = 'hex'
    if ($script:FxRendererByMime.ContainsKey($Mime)) { $renderer = [string]$script:FxRendererByMime[$Mime] }
    else { $renderer = 'code' }
    $src = '/api/fx/preview?id=' + [uri]::EscapeDataString($Id)
    $element = '<pre class="fx-shell-note">no renderer for ' + [System.Net.WebUtility]::HtmlEncode($Mime) + '</pre>'
    if ($renderer -eq 'image') { $element = '<img alt="" src="' + $src + '">' }
    elseif ($renderer -eq 'video') { $element = '<video controls src="' + $src + '"></video>' }
    elseif ($renderer -eq 'audio') { $element = '<audio controls src="' + $src + '"></audio>' }
    elseif ($renderer -eq 'pdf' -or $renderer -eq 'text' -or $renderer -eq 'code' -or $renderer -eq 'hex' -or $renderer -eq 'crypto' -or $renderer -eq 'md') { $element = '<iframe title="preview" src="' + $src + '"></iframe>' }
    $head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    $head = $head + '<meta http-equiv="Content-Security-Policy" content="default-src ''none''; img-src ''self'' data:; media-src ''self''; frame-src ''self''; style-src ''unsafe-inline''; base-uri ''none''; form-action ''none''; object-src ''none''; script-src ''none''">'
    $head = $head + '<title>preview ' + [System.Net.WebUtility]::HtmlEncode($Id) + '</title>'
    $head = $head + '<style>html,body{margin:0;height:100%;background:#101418;color:#cfd8e3;font:13px/1.5 system-ui,sans-serif}img,video{max-width:100%;max-height:100%;display:block;margin:auto}audio{width:100%}iframe{width:100%;height:100%;border:0;background:#0b0f13}.meta{padding:6px 10px;color:#8aa0ad}.fx-shell-note{padding:10px}</style>'
    $head = $head + '</head><body>'
    $meta = '<div class="meta" id="fx-shell-meta">' + [System.Net.WebUtility]::HtmlEncode($RootName + $Path + ' - ' + $Mime + ' - ' + [string]$Size + ' bytes') + '</div>'
    return ($head + $meta + $element + '</body></html>')
}
function Invoke-FxSandboxRoute {
    param($Ctx)
    $p = [string]$Ctx.path
    $prefix = '/preview-sandbox'
    $rest = ''
    if ($p.Length -gt $prefix.Length) { $rest = $p.Substring($prefix.Length) }
    $id = $rest.Trim('/')
    if (-not $id) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'preview-sandbox requires a file id') }
    $read = Read-FxIndexForRoute $Ctx
    if (-not $read.ok) { return $read.response }
    $entry = Get-FxFileEntry $read.index $id
    if (-not $entry) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message ('unknown id: ' + $id)) }
    $mime = (Get-FxString $entry 'mime' 'application/octet-stream').ToLowerInvariant()
    if ($script:FxPreviewMime -notcontains $mime) {
        return (New-FxErrorResponse -Code 415 -Phase 'type' -Message ('preview is not available for ' + $mime) -Extra @{ id = $id; mime = $mime })
    }
    $html = Get-FxSandboxHtml -Id $id -Mime $mime -RootName (Get-FxString $entry 'root') -Path (Get-FxString $entry 'path') -Size (Get-FxNumber $entry 'size' 0)
    $headers = @(
        'Content-Security-Policy: default-src ''none''; img-src ''self'' data:; media-src ''self''; frame-src ''self''; style-src ''unsafe-inline''; base-uri ''none''; form-action ''none''; object-src ''none''; script-src ''none''',
        'X-Content-Type-Options: nosniff',
        'Referrer-Policy: no-referrer',
        'Origin-Agent-Cluster: ?1',
        'Cross-Origin-Resource-Policy: same-site',
        'Cross-Origin-Opener-Policy: same-origin',
        'X-Frame-Options: SAMEORIGIN'
    )
    $headers += (Get-FxCsrfCookieLine $Ctx)
    [void](Write-FxAudit $Ctx ('fx sandbox shell id=' + $id + ' mime=' + $mime))
    return (New-FxResponse -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html)) -Headers $headers)
}

# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------
function Invoke-FxRoute {
    # Returns a response hashtable for an fx/sandbox path, or $null when the
    # path belongs to another handler (the server falls through unchanged).
    param($Ctx)
    if (-not $Ctx -or -not $Ctx.path) { return $null }
    $p = [string]$Ctx.path
    $isFx = ($p -eq '/api/fx' -or $p.StartsWith('/api/fx/'))
    $isSandbox = ($p -eq '/preview-sandbox' -or $p.StartsWith('/preview-sandbox/'))
    if (-not ($isFx -or $isSandbox)) { return $null }
    if (Test-FxQueryCredential $Ctx) {
        [void](Write-FxAudit $Ctx ('fx 401: credential presented in the query string path=' + $p))
        return (New-FxErrorResponse -Code 401 -Phase 'auth' -Message 'credentials are not accepted in the query string; send X-Dash-Token')
    }
    if (-not (Test-FxTokenOk $Ctx)) {
        [void](Write-FxAudit $Ctx ('fx 401: dash token missing or wrong path=' + $p))
        return (New-FxErrorResponse -Code 401 -Phase 'auth' -Message 'dashboard authorization required')
    }
    if ($isSandbox) {
        if ([string]$Ctx.method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'GET required') }
        return (Invoke-FxSandboxRoute $Ctx)
    }
    $method = [string]$Ctx.method
    switch ($p) {
        '/api/fx/list' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'GET required') }
            return (Invoke-FxListRoute $Ctx)
        }
        '/api/fx/meta' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'GET required') }
            return (Invoke-FxMetaRoute $Ctx)
        }
        '/api/fx/gofile/status' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'GET required') }
            return (Invoke-FxGofileStatusRoute $Ctx)
        }
        '/api/fx/preview' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'GET required') }
            return (Invoke-FxPreviewRoute $Ctx)
        }
        '/api/fx/op' {
            if ($method -ne 'POST') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'POST required') }
            return (Invoke-FxOpRoute $Ctx)
        }
        '/api/fx/upload' {
            if ($method -ne 'POST') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'POST required') }
            return (Invoke-FxUploadRoute $Ctx)
        }
        default { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message ('unknown fx endpoint: ' + $p)) }
    }
}
