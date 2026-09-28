# [F45 S4] Explorer server routes - REAL unit + integration proof.
#
# The Explorer core lives inside payloads/ghrdp-server.ps1 between the
# '# [F45 S4 fx-core-begin]' / '# [F45 S4 fx-core-end]' markers. This script
# extracts that region VERBATIM, parses it with the PowerShell language parser,
# dot-sources it, and then drives the SHIPPED handler (Invoke-ClientRequest)
# through complete HTTP request cycles over in-memory client streams - the same
# harness shape tests/f27-windows.ps1 uses.
#
# Nothing here contacts gofile: the transport seam is a scriptblock fetcher, so
# 502/504/timeout paths are exercised deterministically and offline.
#
# Mechanical proof only: it is not a live-runner, live-gofile or live-browser
# claim, and it does not enable any destructive operation.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$script:FxToken = 'dash-token-' + [guid]::NewGuid().ToString('N')
$script:FxPass = 0
$script:FxFail = 0
$script:FxFailures = @()
$stage = 'initialization'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('f45s4-' + [guid]::NewGuid().ToString('N'))
$queueDir = Join-Path $tempRoot 'queue'
$null = New-Item -ItemType Directory -Path $tempRoot -Force
$null = New-Item -ItemType Directory -Path $queueDir -Force

function Assert-Fx([bool]$Condition, [string]$Label) {
    # An assertion failure is RECORDED and the run continues, so one Windows
    # lane run reports every failed assertion site instead of only the first
    # (a terminating error - a real crash - still aborts through the outer
    # catch below and is reported with its stage). The cap keeps a cascade from
    # turning into a wall of output; the first entry is always the root cause.
    if (-not $Condition) {
        $script:FxFail++
        $script:FxFailures += ($stage + ' :: ' + $Label)
        Write-Host ('::warning::[F45 S4] assertion FAILED at stage "' + $stage + '": ' + $Label)
        if ($script:FxFail -ge 25) { throw ('F45-S4 assertion FAILED: ' + $Label) }
        return
    }
    $script:FxPass++
}

function Write-FxFailures {
    $script:FxFailures | Select-Object -First 20 | ForEach-Object { Write-Host ('::error::[F45 S4] ' + $_) }
    if ($script:FxFailures.Count -gt 20) { Write-Host ('::error::[F45 S4] ... and ' + ($script:FxFailures.Count - 20) + ' more assertion site(s)') }
}

function Import-Functions([string]$Text, [string[]]$Names) {
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
    Assert-Fx ($errors.Count -eq 0) 'the server source parses'
    foreach ($name in $Names) {
        $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        Assert-Fx ($null -ne $fn) ('function exists in ghrdp-server.ps1: ' + $name)
        $definition = $fn.Extent.Text -replace '^function\s+([\w-]+)', 'function script:$1'
        . ([scriptblock]::Create($definition))
    }
}

# Comma splitter that ignores commas inside JSON strings, so a diagnostic can
# name the field that differs between two documents.
function Split-FxTopLevelJson([string]$Json) {
    $out = @()
    $cur = ''
    $inStr = $false
    for ($i = 0; $i -lt $Json.Length; $i++) {
        $ch = $Json[$i]
        if ($ch -eq '"') { $inStr = -not $inStr }
        if ($ch -eq ',' -and -not $inStr) { $out += $cur; $cur = '' } else { $cur = $cur + $ch }
    }
    $out += $cur
    return ,$out
}

# --- the shipped request cycle, over in-memory streams ----------------------
function Request-Fx {
    param([string]$Path, [string]$Method = 'GET', [string]$Source = '203.0.113.9', [string]$Body = '', [hashtable]$Headers = @())
    $extra = ''
    foreach ($k in $Headers.Keys) { $extra = $extra + $k + ': ' + [string]$Headers[$k] + "`r`n" }
    $raw = "$Method $Path HTTP/1.1`r`nHost: fixture.ts.net`r`n" + $extra + "Content-Length: " + [Text.Encoding]::UTF8.GetByteCount($Body) + "`r`n`r`n" + $Body
    $inputBytes = [Text.Encoding]::UTF8.GetBytes($raw)
    $mem = New-Object IO.MemoryStream
    $mem.Write($inputBytes, 0, $inputBytes.Length)
    $mem.Position = 0
    $client = [pscustomobject]@{ Stream = $mem; Client = [pscustomobject]@{ RemoteEndPoint = [pscustomobject]@{ Address = [Net.IPAddress]::Parse($Source) } } }
    $client | Add-Member ScriptMethod GetStream { return $this.Stream }
    $client | Add-Member ScriptMethod Close { return }
    Invoke-ClientRequest -Client $client -Token $script:FxToken
    $all = $mem.ToArray()
    $text = [Text.Encoding]::UTF8.GetString($all, $inputBytes.Length, $all.Length - $inputBytes.Length)
    $split = $text.IndexOf("`r`n`r`n")
    Assert-Fx ($split -gt 0) ('route produced an HTTP response for ' + $Method + ' ' + $Path)
    $head = $text.Substring(0, $split)
    $bodyStart = $inputBytes.Length + [Text.Encoding]::UTF8.GetByteCount($text.Substring(0, $split + 4))
    $bodyBytes = @()
    if ($all.Length -gt $bodyStart) { $bodyBytes = @($all[$bodyStart..($all.Length - 1)]) }
    $match = [regex]::Match($head, '^HTTP/1\.1 (\d+)')
    Assert-Fx $match.Success 'the response starts with a status line'
    $headerMap = @{}
    foreach ($line in ($head -split "`r`n")) {
        $ix = $line.IndexOf(':')
        if ($ix -gt 0) { $headerMap[$line.Substring(0, $ix).Trim().ToLower()] = $line.Substring($ix + 1).Trim() }
    }
    return [pscustomobject]@{
        Code = [int]$match.Groups[1].Value
        Head = $head
        Headers = $headerMap
        Bytes = $bodyBytes
        Body = [Text.Encoding]::UTF8.GetString($bodyBytes)
    }
}

function New-FxJson([hashtable]$Value) { return ($Value | ConvertTo-Json -Depth 8 -Compress) }

function Write-FixtureIndex([string]$Path, [int]$SchemaVersion, [object[]]$Files) {
    $doc = [ordered]@{ schemaVersion = $SchemaVersion; generatedAt = '2026-01-01T00:00:00.000Z'; runnerId = 'fx-lab-runner'; files = $Files }
    [IO.File]::WriteAllText($Path, ($doc | ConvertTo-Json -Depth 10 -Compress), (New-Object Text.UTF8Encoding($false)))
}

try {
    $stage = 'extract the shipped Explorer core'
    $srvText = [IO.File]::ReadAllText((Join-Path $repo 'payloads/ghrdp-server.ps1'))
    $begin = $srvText.IndexOf('# [F45 S4 fx-core-begin]')
    $end = $srvText.IndexOf('# [F45 S4 fx-core-end]', [Math]::Max($begin, 0))
    Assert-Fx ($begin -gt 0 -and $end -gt $begin) 'the fx-core markers are present in ghrdp-server.ps1'
    $core = $srvText.Substring($begin, $end - $begin)
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseInput($core, [ref]$null, [ref]$parseErrors)
    Assert-Fx ($parseErrors.Count -eq 0) ('the extracted core parses (' + $parseErrors.Count + ' error(s))')
    Import-Functions $srvText @('Read-JsonFile', 'Get-RequestParts', 'Test-IsLoopbackAddr', 'Test-ClientAllowed', 'Test-CredsAllowed', 'Read-ClientRequest', 'Send-ClientResponse', 'ConvertTo-JsonBytes', 'Invoke-ClientRequest')
    . ([scriptblock]::Create($core))
    Assert-Fx ($null -ne (Get-Command Invoke-FxRoute -ErrorAction SilentlyContinue)) 'Invoke-FxRoute was defined by the core'
    Assert-Fx ($script:FxSchemaVersion -eq 2) 'the shipped schema version is 2'

    $stage = 'wire the fixture root'
    $rootsDir = Join-Path $tempRoot 'fx-roots'
    foreach ($r in @('Downloads', 'Desktop', 'Documents', 'Temp', 'RDP-Storage')) { $null = New-Item -ItemType Directory -Path (Join-Path $rootsDir $r) -Force }
    $helloBytes = [Text.Encoding]::UTF8.GetBytes('hello explorer world')
    [IO.File]::WriteAllBytes((Join-Path $rootsDir 'Downloads\hello.txt'), $helloBytes)
    [IO.File]::WriteAllBytes((Join-Path $rootsDir 'Downloads\refused.exe'), [Text.Encoding]::UTF8.GetBytes('MZ'))
    [IO.File]::WriteAllBytes((Join-Path $rootsDir 'Downloads\escaped.txt'), [Text.Encoding]::UTF8.GetBytes('outside'))
    $script:FxRoot = $tempRoot
    $script:FxRootsMap = [ordered]@{
        Downloads = (Join-Path $rootsDir 'Downloads')
        Desktop = (Join-Path $rootsDir 'Desktop')
        Documents = (Join-Path $rootsDir 'Documents')
        Temp = (Join-Path $rootsDir 'Temp')
        'RDP-Storage' = (Join-Path $rootsDir 'RDP-Storage')
    }
    $script:FxIndexPath = Join-Path $tempRoot 'fx-index.json'
    $script:FxIndexReadPath = Join-Path $tempRoot 'mirror-index.json'
    $script:FxLogPath = Join-Path $tempRoot 'fx-server.log'
    $script:FxQueuePath = Join-Path $queueDir 'fx-upload-queue.json'
    $script:FxIdempotencyPath = Join-Path $tempRoot 'fx-idempotency.json'
    $script:FxClock = [datetime]'2026-02-01T00:00:00Z'

    # --- U1 route table -----------------------------------------------------
    $stage = 'U1 route table'
    $paths = @($script:FxRouteTable | ForEach-Object { [string]$_.path })
    foreach ($want in @('/api/fx/list', '/api/fx/meta', '/api/fx/gofile/status', '/api/fx/preview', '/api/fx/op', '/api/fx/upload')) {
        Assert-Fx ($paths -contains $want) ('route table declares ' + $want)
    }
    Assert-Fx ($paths.Count -eq 6) 'the route table has exactly the six S4 endpoints'
    $postRoutes = @($script:FxRouteTable | Where-Object { $_.csrf })
    Assert-Fx ($postRoutes.Count -eq 2) 'exactly /op and /upload require CSRF'
    foreach ($r in $postRoutes) { Assert-Fx ([string]$r.method -eq 'POST') ('CSRF route is POST: ' + $r.path) }
    Assert-Fx (@($script:FxOps) -join ',' -eq 'trash,restore,move,tag,pin') 'the op vocabulary matches the S3 client'

    # --- U2 identity parity with S2 stableId.ts -----------------------------
    $stage = 'U2 stable id parity'
    # The expectations are the shared S2/S4 fixture (UTF-8, read as UTF-8 by
    # BOTH runtimes), whose ids src/tests/smoke/fx-server-contract.test.ts
    # recomputes with node:crypto. This script therefore stays pure ASCII: a
    # non-ASCII literal here would be decoded as ANSI by powershell.exe 5.1
    # (the repo ships every .ps1 without a BOM), which is exactly the drift the
    # vector is meant to catch.
    $vectorPath = Join-Path $repo 'src/components/explorer/data/fixtures/stable-id-vectors.json'
    Assert-Fx (Test-Path -LiteralPath $vectorPath) 'the shared stable-id vector fixture exists'
    # NOTE for 5.1: `$json | ConvertFrom-Json` sends a TOP-LEVEL array as ONE
    # object through the pipeline, so the fixture is an object and its array is
    # enumerated explicitly with @($doc.vectors). Never count the pipeline form.
    $vectorDoc = ConvertFrom-Json ([IO.File]::ReadAllText($vectorPath))
    $vectors = @($vectorDoc.vectors)
    Assert-Fx ($vectors.Count -ge 5) ('the fixture carries at least five identity vectors (got ' + [string]@($vectors).Count + ')')
    Assert-Fx ([int]$vectorDoc.schemaVersion -eq 1) 'the fixture declares its own schema version'
    $nonAsciiVectors = 0
    $seenIds = @()
    foreach ($v in $vectors) {
        $want = [string]$v.id
        $got = ConvertTo-FxStableId -RootName ([string]$v.root) -Path ([string]$v.path)
        Assert-Fx ($got -ceq $want) ('the server id matches the shared vector for ' + [string]$v.root + [string]$v.path)
        if ([string]$v.path -match '[^\x00-\x7F]') { $nonAsciiVectors++ }
        $seenIds += $got
    }
    Assert-Fx ($nonAsciiVectors -ge 2) 'the fixture includes non-ASCII vectors (a real UTF-8 check)'
    Assert-Fx (@($seenIds | Select-Object -Unique).Count -eq $vectors.Count) 'no two vectors collide'
    $idA = ConvertTo-FxStableId -RootName 'Downloads' -Path '/notes.txt'
    Assert-Fx ($idA -match '^[0-9a-f]{40}$') 'stable id is lowercase hex'
    Assert-Fx ($idA -eq '8476704194b57691c1c68d7891655553c29fae8d') 'the server id equals the recorded Node sha1("Downloads/notes.txt")'
    Assert-Fx ($idA -ne (ConvertTo-FxStableId -RootName 'Documents' -Path '/notes.txt')) 'root contributes to the identity'

    # --- U3 migration -------------------------------------------------------
    $stage = 'U3 v1 -> v2 migration'
    $legacy = @'
{"schemaVersion":1,"generatedAt":"2026-01-01T00:00:00.000Z","runnerId":"fx-lab","files":[
 {"root":"Documents","path":"reports\\q1.txt"},
 {"id":"legacy-1","root":"Downloads","path":"/notes.txt","size":24,"mtime":"2026-01-01T00:00:00.000Z"},
 {"root":"Downloads","path":"/img.png","gofile":{"status":"processing","directUrl":"https://store1.gofile.io/download/abc"}},
 {"root":"Nowhere","path":"/x.txt","upload":{"status":"failed","retries":2,"bytesSent":10,"lastError":{"phase":"http","httpStatus":502,"hostMessage":"HOST_MESSAGE_MARKER"}}}
]}
'@
    $migrated = Invoke-FxMigrateIndex -Value ($legacy | ConvertFrom-Json)
    Assert-Fx ($migrated.schemaVersion -eq 2) 'migration stamps schemaVersion 2'
    Assert-Fx (@($migrated.gofileHosts).Count -eq 1 -and $migrated.gofileHosts[0].id -eq 'gofile') 'migration adds exactly one gofile host'
    Assert-Fx ($migrated.files[0].path -eq '/reports/q1.txt') 'windows separators normalize to POSIX'
    Assert-Fx ($migrated.files[0].id -eq (ConvertTo-FxStableId -RootName 'Documents' -Path '/reports/q1.txt')) 'a missing id is computed from root + path'
    Assert-Fx ($migrated.files[0].mtime -eq '1970-01-01T00:00:00.000Z') 'a missing mtime falls back to the epoch, never the current clock'
    Assert-Fx ($migrated.generatedAt -eq '2026-01-01T00:00:00.000Z') 'a stored timestamp is preserved verbatim, never re-formatted'
    Assert-Fx ($migrated.files[1].mtime -eq '2026-01-01T00:00:00.000Z') 'a per-file stored timestamp is preserved verbatim too'
    Assert-Fx (@($migrated.roots).Count -eq 0) 'a document with no roots does not gain a fabricated one'
    Assert-Fx ($migrated.files[1].id -eq 'legacy-1') 'an existing id is preserved'
    Assert-Fx ($null -eq $migrated.files[2].gofile.directUrl) 'a directUrl on a non-uploaded file is dropped'
    Assert-Fx ($migrated.files[3].root -eq 'Temp') 'an unknown root falls back to Temp'
    Assert-Fx ($migrated.files[3].upload.lastError.hostMessage -eq 'HOST_MESSAGE_MARKER') 'the F44 host message survives migration intact'
    Assert-Fx ($migrated.files[3].upload.lastError.phase -eq 'http' -and $migrated.files[3].upload.lastError.httpStatus -eq 502) 'the phase + status survive migration'
    $again = Invoke-FxMigrateIndex -Value $migrated
    $jsonAgain = [string]($again | ConvertTo-Json -Depth 10 -Compress)
    $jsonFirst = [string]($migrated | ConvertTo-Json -Depth 10 -Compress)
    if ($jsonAgain -ne $jsonFirst) {
        # self-diagnosing: the two documents differ somewhere, so report the
        # field-level difference instead of only "false"
        $pa = @(Split-FxTopLevelJson $jsonAgain)
        $pb = @(Split-FxTopLevelJson $jsonFirst)
        $diff = @()
        for ($i = 0; $i -lt [Math]::Max($pa.Count, $pb.Count) -and $diff.Count -lt 8; $i++) {
            $xa = '<absent>'; if ($i -lt $pa.Count) { $xa = $pa[$i] }
            $xb = '<absent>'; if ($i -lt $pb.Count) { $xb = $pb[$i] }
            if ($xa -ne $xb) { $diff += ('@' + $i + ' again=' + $xa + ' <> first=' + $xb) }
        }
        Write-Host ('::warning::[F45 S4] idempotency diff: ' + ($diff -join ' ;; '))
        Write-Host ('::warning::[F45 S4] again head: ' + $jsonAgain.Substring(0, [Math]::Min(500, $jsonAgain.Length)))
        Write-Host ('::warning::[F45 S4] first head: ' + $jsonFirst.Substring(0, [Math]::Min(500, $jsonFirst.Length)))
    }
    Assert-Fx ($jsonAgain -eq $jsonFirst) 'migration is idempotent'
    $long = 'Untruncated host error. ' * 500
    $longEntry = (ConvertTo-FxFileEntry -Value ([pscustomobject]@{ root = 'Temp'; path = '/x'; upload = [pscustomobject]@{ status = 'failed'; lastError = [pscustomobject]@{ phase = 'http'; hostMessage = $long } } }))
    Assert-Fx ($longEntry.upload.lastError.hostMessage.Length -eq $long.Length) 'a 12k host message is preserved with no cap'

    # --- U4 redaction -------------------------------------------------------
    $stage = 'U4 credential redaction'
    $secret = 'go_' + [guid]::NewGuid().ToString('N')
    Assert-Fx ((Protect-FxText ('token=' + $script:FxToken)) -eq 'token=***REDACTED***') 'a credential query pair is redacted'
    Assert-Fx ((Protect-FxText ('X-Dash-Token: ' + $script:FxToken)) -eq ('X-Dash-Token: ' + '***REDACTED***')) 'a token header is redacted'
    Assert-Fx ((Protect-FxText ('url=' + $secret + '&x=1')) -notmatch 'go_[0-9a-f]{32}') 'a gofile-shaped key is redacted'
    Assert-Fx ((Protect-FxText $secret -Secrets @($secret)) -eq '***REDACTED***') 'an explicitly supplied secret is redacted'
    $logLine = Write-FxLog ('authorization: Bearer ' + $secret)
    Assert-Fx ($logLine -notmatch [regex]::Escape($secret)) 'Write-FxLog returns a redacted line'
    Assert-Fx ($logLine -match '\*\*\*REDACTED\*\*\*') 'the redaction marker is present'
    [IO.File]::WriteAllText($script:FxLogPath, '') # reset for the end-to-end log assertion
    $null = Write-FxLog ('gofile poll url=https://api.gofile.io/contents/abc?token=' + $secret + ' done')
    $logText = [IO.File]::ReadAllText($script:FxLogPath)
    Assert-Fx (-not $logText.Contains($secret)) 'the token never reaches the log file'
    Assert-Fx ($logText.Contains('***REDACTED***')) 'the log records the redaction'

    # --- U5 CSRF ------------------------------------------------------------
    $stage = 'U5 CSRF derivation'
    $csrf = Get-FxCsrfToken -Token $script:FxToken
    Assert-Fx ($csrf.Length -eq 32 -and $csrf -match '^[0-9a-f]{32}$') 'the CSRF token is 32 lowercase hex chars'
    Assert-Fx ($csrf -eq (Get-FxCsrfToken -Token $script:FxToken)) 'the CSRF token is deterministic for a run'
    Assert-Fx (-not $csrf.Contains($script:FxToken)) 'the CSRF token never embeds the dash token'
    Assert-Fx (Test-FxCsrf -Headers @{ 'x-csrf-token' = $csrf } -Method 'POST' -Token $script:FxToken) 'the derived CSRF token validates'
    Assert-Fx (-not (Test-FxCsrf -Headers @{} -Method 'POST' -Token $script:FxToken)) 'a POST with no CSRF token fails closed'
    Assert-Fx (-not (Test-FxCsrf -Headers @{ 'x-csrf-token' = 'deadbeef' } -Method 'POST' -Token $script:FxToken)) 'a wrong CSRF token fails closed'
    Assert-Fx (Test-FxCsrf -Headers @{} -Method 'GET' -Token $script:FxToken) 'GET never requires CSRF'
    Assert-Fx (-not (Test-FxCsrf -Headers @{ 'x-csrf-token' = $csrf } -Method 'POST' -Token '')) 'an unconfigured token cannot validate CSRF'

    # --- U6 range matrix ----------------------------------------------------
    $stage = 'U6 Range parsing'
    $whole = Get-FxContentRange -RangeHeader '' -TotalLength 100
    Assert-Fx ($whole.ok -and $whole.length -eq 100 -and $whole.start -eq 0) 'no Range header means the whole body'
    $head = Get-FxContentRange -RangeHeader 'bytes=0-3' -TotalLength 100
    Assert-Fx ($head.ok -and $head.start -eq 0 -and $head.end -eq 3 -and $head.length -eq 4 -and $head.header -eq 'bytes 0-3/100') 'bytes=0-3'
    $open = Get-FxContentRange -RangeHeader 'bytes=90-' -TotalLength 100
    Assert-Fx ($open.ok -and $open.length -eq 10 -and $open.header -eq 'bytes 90-99/100') 'an open-ended range runs to EOF'
    $suffix = Get-FxContentRange -RangeHeader 'bytes=-4' -TotalLength 100
    Assert-Fx ($suffix.ok -and $suffix.start -eq 96 -and $suffix.length -eq 4) 'a suffix range counts back from EOF'
    foreach ($bad in @('bytes=100-', 'bytes=0-1,5-6', 'bytes=abc', 'bytes=', 'bytes=-0')) {
        $r = Get-FxContentRange -RangeHeader $bad -TotalLength 100
        Assert-Fx ((-not $r.ok) -and $r.unsatisfiable -and $r.header -eq 'bytes */100') ('unsatisfiable range: ' + $bad)
    }
    $clamped = Get-FxContentRange -RangeHeader 'bytes=0-999' -TotalLength 100
    Assert-Fx ($clamped.ok -and $clamped.end -eq 99) 'an end past EOF is clamped'

    # --- U7 op matrix -------------------------------------------------------
    $stage = 'U7 op semantics'
    $idx = Invoke-FxMigrateIndex -Value (@'
{"files":[{"id":"aaa","root":"Downloads","path":"/a.txt","mime":"text/plain","size":3},{"id":"bbb","root":"Downloads","path":"/b.txt","trashed":true,"tags":["x"],"pinned":true},{"id":"ccc","root":"Temp","path":"/c.txt","tags":["x"]}]}
'@ | ConvertFrom-Json)
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'trash'; ids = @('aaa') } | ConvertTo-Json -Compress | ConvertFrom-Json) -Now '2026-02-01T00:00:00.000Z'
    Assert-Fx ($op.code -eq 200 -and @($op.applied).Count -eq 1 -and $op.applied[0] -eq 'aaa') 'trash applies'
    Assert-Fx ($idx.files[0].trashed -and $idx.files[0].trashedAt -eq '2026-02-01T00:00:00.000Z') 'trash stamps trashedAt'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'trash'; ids = @('aaa') } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx ($op.code -eq 200 -and @($op.applied).Count -eq 0 -and $op.skipped[0].reason -eq 'no-change') 'a repeated trash is skipped, not re-applied'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'restore'; ids = @('aaa') } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx (@($op.applied).Count -eq 1 -and -not $idx.files[0].trashed -and $null -eq $idx.files[0].trashedAt) 'restore clears the flag and the stamp'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'move'; ids = @('aaa'); target = '/moved' } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx (@($op.applied).Count -eq 1 -and $idx.files[0].path -eq '/moved/a.txt') 'move rewrites the path, keeping the file name'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'move'; ids = @('aaa'); target = '/moved/' } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx ($op.skipped[0].reason -eq 'no-change') 'moving into the directory it already lives in is a no-change skip'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'tag'; ids = @('ccc'); tags = @('x', 'y', 'y') } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx (@($op.applied).Count -eq 1 -and ($idx.files[2].tags -join ',') -eq 'x,y') 'tag replaces the list and dedupes'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'pin'; ids = @('ccc'); pin = $true } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx (@($op.applied).Count -eq 1 -and $idx.files[2].pinned) 'pin sets the flag'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'pin'; ids = @('ccc'); pin = $true } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx ($op.skipped[0].reason -eq 'no-change') 're-pinning is a no-change skip'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'move'; ids = @('bbb'); target = '/x.txt' } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx ($op.skipped[0].reason -eq 'trashed') 'a trashed entry refuses move'
    $op = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'trash'; ids = @('nope') } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx ($op.code -eq 200 -and $op.skipped[0].reason -eq 'unknown-id') 'an unknown id is skipped, not an error'
    foreach ($bad in @(
        @{ op = 'trash'; ids = @('aaa'); hard = $true },
        @{ op = 'nuke'; ids = @('aaa') },
        @{ op = 'trash'; ids = @() },
        @{ op = 'move'; ids = @('aaa') },
        @{ op = 'move'; ids = @('aaa'); target = '../escape.txt' },
        @{ op = 'move'; ids = @('aaa'); target = '/moved/../escape' },
        @{ op = 'move'; ids = @('aaa'); target = '/moved|bad' },
        @{ op = 'pin'; ids = @('aaa'); pin = 'yes' },
        @{ op = 'tag'; ids = @('aaa') })) {
        $r = Invoke-FxOpOnIndex -Index $idx -Body ($bad | ConvertTo-Json -Compress -Depth 5 | ConvertFrom-Json)
        Assert-Fx ($r.code -eq 400) ('a bad op is refused with 400: ' + ($bad | ConvertTo-Json -Compress))
    }
    $hard = Invoke-FxOpOnIndex -Index $idx -Body (@{ op = 'trash'; ids = @('aaa'); hard = $true } | ConvertTo-Json -Compress | ConvertFrom-Json)
    Assert-Fx ($hard.message -match 'hard delete') 'the hard-delete refusal is explicit'

    # --- U8 upload queue ----------------------------------------------------
    $stage = 'U8 upload queue'
    $qIdx = Invoke-FxMigrateIndex -Value (@'
{"files":[{"id":"aaa","root":"Downloads","path":"/hello.txt","size":20,"mime":"text/plain"},{"id":"bbb","root":"Downloads","path":"/b.txt"},{"id":"ccc","root":"Downloads","path":"/c.txt","trashed":true}]}
'@ | ConvertFrom-Json)
    $first = Add-FxUploadJobs -Index $qIdx -Ids @('aaa') -HostId 'gofile' -Path $script:FxQueuePath -Now '2026-02-01T00:00:00.000Z'
    Assert-Fx ($first.code -eq 202) 'a valid upload request is accepted with 202'
    Assert-Fx (@($first.jobs).Count -eq 1 -and $first.jobs[0].id -eq 'aaa' -and $first.jobs[0].uploadJobId) 'the accepted job carries id + uploadJobId'
    Assert-Fx (Test-Path -LiteralPath $script:FxQueuePath) 'the queue is persisted'
    Assert-Fx (@(Get-ChildItem -LiteralPath $queueDir -Filter '*.tmp' -ErrorAction SilentlyContinue).Count -eq 0) 'no temp file is left behind by the atomic write'
    $queueOnDisk = [IO.File]::ReadAllText($script:FxQueuePath) | ConvertFrom-Json
    Assert-Fx ($queueOnDisk.schemaVersion -eq 1 -and @($queueOnDisk.jobs).Count -eq 1) 'the queue file has one job and a schema version'
    $second = Add-FxUploadJobs -Index $qIdx -Ids @('aaa') -HostId 'gofile' -Path $script:FxQueuePath -Now '2026-02-01T00:05:00.000Z'
    Assert-Fx ($second.jobs[0].uploadJobId -eq $first.jobs[0].uploadJobId) 'a repeated request reuses the live job (idempotent)'
    $queueOnDisk = [IO.File]::ReadAllText($script:FxQueuePath) | ConvertFrom-Json
    Assert-Fx (@($queueOnDisk.jobs).Count -eq 1) 'the queue did not grow'
    $mixed = Add-FxUploadJobs -Index $qIdx -Ids @('bbb', 'ccc', 'nope') -HostId 'gofile' -Path $script:FxQueuePath
    Assert-Fx (@($mixed.jobs).Count -eq 1 -and $mixed.jobs[0].id -eq 'bbb') 'only the eligible id is queued'
    Assert-Fx ((@($mixed.skipped | ForEach-Object { $_.reason }) -join ',') -eq 'trashed,unknown-id') 'trashed + unknown ids are reported as skipped'
    $badHost = Add-FxUploadJobs -Index $qIdx -Ids @('bbb') -HostId 'mega' -Path $script:FxQueuePath
    Assert-Fx ($badHost.code -eq 400 -and $badHost.message -match 'unknown upload host') 'an unknown host is refused'

    # --- U9 worker state machine -------------------------------------------
    $stage = 'U9 upload worker state machine'
    [IO.File]::WriteAllText($script:FxLogPath, '')
    $okUploader = { param($job, $fullPath) [ordered]@{ ok = $true; phase = 'http'; status = 200; fileId = 'fx-file-1'; code = 'fx-folder-1'; directUrl = 'https://store1.gofile.io/download/fx-file-1'; message = '' } }
    # fresh queue: this scenario must only ever see its own job
    Remove-Item -LiteralPath $script:FxQueuePath -Force -ErrorAction SilentlyContinue
    $qOkJson = @'
{"files":[{"id":"aaa","root":"Downloads","path":"/hello.txt","size":20,"mime":"text/plain"}]}
'@
    $qOk = Invoke-FxMigrateIndex -Value ($qOkJson | ConvertFrom-Json)
    $null = Add-FxUploadJobs -Index $qOk -Ids @('aaa') -HostId 'gofile' -Path $script:FxQueuePath
    $summary = Step-FxUploadQueue -Path $script:FxQueuePath -IndexPath $script:FxIndexPath -Uploader $okUploader -Index $qOk
    Assert-Fx ($summary.succeeded -eq 1 -and $summary.failed -eq 0) 'a successful upload is reported once'
    Assert-Fx ($qOk.files[0].gofile.status -eq 'uploaded' -and $qOk.files[0].gofile.fileId -eq 'fx-file-1') 'the index records the hosted state'
    Assert-Fx ($qOk.files[0].gofile.directUrl -eq 'https://store1.gofile.io/download/fx-file-1') 'a credential-free direct link is stored'
    Assert-Fx ($qOk.files[0].upload.status -eq 'success') 'the upload state is success'
    $qIdx = $qOk
    $queueOnDisk = [IO.File]::ReadAllText($script:FxQueuePath) | ConvertFrom-Json
    Assert-Fx (($queueOnDisk.jobs | Where-Object { $_.id -eq 'aaa' }).state -eq 'success') 'the queue records the terminal state'
    $mm = New-FxMultipartBody -Boundary 'FXB' -FieldName 'file' -FileName 'hello.txt' -FileBytes ([Text.Encoding]::UTF8.GetBytes('PAYLOAD')) -MimeType 'text/plain'
    $mmText = [Text.Encoding]::UTF8.GetString($mm.bytes)
    Assert-Fx ($mm.contentType -eq 'multipart/form-data; boundary=FXB') 'the multipart content type names the boundary'
    Assert-Fx ($mmText.Contains('name="file"') -and $mmText.Contains('filename="hello.txt"') -and $mmText.Contains('PAYLOAD')) 'the multipart body carries the field, filename and payload'
    Assert-Fx ($mmText.EndsWith("--FXB--`r`n")) 'the multipart body is terminated'
    Assert-Fx ($mm.bytes.Length -eq ([Text.Encoding]::UTF8.GetByteCount($mmText))) 'the multipart byte count matches the encoding'
    Assert-Fx ((New-FxMultipartBody -Boundary '' -FieldName 'file' -FileName 'a' -FileBytes ([byte[]]@(1, 2))).boundary -ne '') 'a missing boundary is generated'
    $failUploader = { param($job, $fullPath) [ordered]@{ ok = $false; phase = 'http'; status = 502; message = 'HOST_FAILURE_MESSAGE' } }
    Remove-Item -LiteralPath $script:FxQueuePath -Force -ErrorAction SilentlyContinue
    $qIdx2Json = @'
{"files":[{"id":"ddd","root":"Downloads","path":"/hello.txt","size":20,"mime":"text/plain"}]}
'@
    $qIdx2 = Invoke-FxMigrateIndex -Value ($qIdx2Json | ConvertFrom-Json)
    $null = Add-FxUploadJobs -Index $qIdx2 -Ids @('ddd') -HostId 'gofile' -Path $script:FxQueuePath
    $s = Step-FxUploadQueue -Path $script:FxQueuePath -IndexPath $script:FxIndexPath -Uploader $failUploader -Index $qIdx2
    Assert-Fx ($s.queued -eq 1 -and $s.failed -eq 0) 'a transient 502 is retried (pass 1)'
    # the retry must wait its own backoff: the very next tick may not re-attempt
    $gate = Step-FxUploadQueue -Path $script:FxQueuePath -IndexPath $script:FxIndexPath -Uploader $failUploader -Index $qIdx2
    Assert-Fx ($gate.processed -eq 0 -and $gate.skipped -eq 1) 'a retry is not attempted before its backoff deadline'
    # BOOLEAN condition: a bare string cannot bind to [bool]$Condition, and the
    # terminating error it raises would hide every later stage.
    Assert-Fx (-not [string]::IsNullOrEmpty([string](Get-FxUploadQueue -Path $script:FxQueuePath).jobs[0].retryAt)) 'the queue carries the retry deadline'
    for ($i = 2; $i -le 4; $i++) {
        $script:FxClock = (Get-Date).ToUniversalTime().AddSeconds(60)
        $s = Step-FxUploadQueue -Path $script:FxQueuePath -IndexPath $script:FxIndexPath -Uploader $failUploader -Index $qIdx2
        Assert-Fx ($s.queued -eq 1 -and $s.failed -eq 0) ('a transient 502 is retried (pass ' + $i + ')')
    }
    $script:FxClock = (Get-Date).ToUniversalTime().AddSeconds(120)
    $s = Step-FxUploadQueue -Path $script:FxQueuePath -IndexPath $script:FxIndexPath -Uploader $failUploader -Index $qIdx2
    Assert-Fx ($s.failed -eq 1 -and $s.queued -eq 0) 'the fifth transient failure is terminal (S8.2 attempt budget)'
    $script:FxClock = $null
    Assert-Fx ($qIdx2.files[0].upload.lastError.hostMessage -eq 'HOST_FAILURE_MESSAGE') 'the complete host message is stored on the entry'
    Assert-Fx ($qIdx2.files[0].upload.lastError.phase -eq 'http') 'the F44 phase is stored'
    Assert-Fx ((Get-FxJobMaxAttempts -Phase 'http' -HttpStatus 502) -eq 5) 'a transient failure gets five attempts'
    Assert-Fx ((Get-FxJobMaxAttempts -Phase 'auth' -HttpStatus 401) -eq 1) 'a fail-fast status gets one attempt'
    foreach ($code in @(401, 403, 413, 415)) { Assert-Fx (-not (Test-FxPhaseRetryable -Phase 'auth' -HttpStatus $code)) ('fail-fast status: ' + $code) }
    Assert-Fx ((Get-FxBackoffMs -Attempt 1) -eq 500) 'backoff starts at the 500ms base'
    Assert-Fx ((Get-FxBackoffMs -Attempt 9) -eq 8000) 'backoff is capped at 8s'
    Assert-Fx ((Get-FxBackoffMs -Attempt 1 -RetryAfterMs 30000) -eq 30000) 'Retry-After wins when longer'
    Assert-Fx ((Get-FxBackoffMs -Attempt 1 -RetryAfterMs 600000) -eq 120000) 'Retry-After is clamped to 120s'
    $authUploader = { param($job, $fullPath) [ordered]@{ ok = $false; phase = 'auth'; status = 401; message = 'bad token' } }
    Remove-Item -LiteralPath $script:FxQueuePath -Force -ErrorAction SilentlyContinue
    $qIdx3Json = @'
{"files":[{"id":"eee","root":"Downloads","path":"/hello.txt","size":20,"mime":"text/plain"}]}
'@
    $qIdx3 = Invoke-FxMigrateIndex -Value ($qIdx3Json | ConvertFrom-Json)
    $null = Add-FxUploadJobs -Index $qIdx3 -Ids @('eee') -HostId 'gofile' -Path $script:FxQueuePath
    $s = Step-FxUploadQueue -Path $script:FxQueuePath -IndexPath $script:FxIndexPath -Uploader $authUploader -Index $qIdx3
    Assert-Fx ($s.failed -eq 1 -and $s.queued -eq 0) 'a 401 is terminal at the first attempt'
    $defaultUploader = Invoke-FxGofileUpload -Job $null -FullPath (Join-Path $rootsDir 'Downloads\hello.txt') -Token ''
    Assert-Fx ((-not $defaultUploader.ok) -and $defaultUploader.phase -eq 'auth') 'the shipped uploader fails closed with no token'

    # a host that echoes the credential in its error text must not get it
    # written into the queue, the index or the log - while the rest of the
    # message is still carried COMPLETE (F44)
    Remove-Item -LiteralPath $script:FxQueuePath -Force -ErrorAction SilentlyContinue
    $echoIdx = Invoke-FxMigrateIndex -Value ((@{ files = @(@{ id = 'fff'; root = 'Downloads'; path = '/hello.txt'; size = 20; mime = 'text/plain' }) } | ConvertTo-Json -Depth 6 -Compress) | ConvertFrom-Json)
    $null = Add-FxUploadJobs -Index $echoIdx -Ids @('fff') -HostId 'gofile' -Path $script:FxQueuePath
    $script:FxGofileToken = 'go_echo_token_0123456789abcdef'
    $echoUploader = { param($job, $fullPath) [ordered]@{ ok = $false; phase = 'http'; status = 403; message = ('denied for token=' + $script:FxGofileToken + ' at file stage') } }
    $s = Step-FxUploadQueue -Path $script:FxQueuePath -IndexPath $script:FxIndexPath -Uploader $echoUploader -Index $echoIdx
    Assert-Fx ($s.failed -eq 1 -and $s.queued -eq 0) 'a 403 is terminal at the first attempt'
    $echoStored = [string]$echoIdx.files[0].upload.lastError.hostMessage
    Assert-Fx ($echoStored -notmatch [regex]::Escape($script:FxGofileToken)) 'a host echo of the token is redacted on the index entry'
    Assert-Fx ($echoStored -match 'denied for' -and $echoStored -match 'at file stage') 'the rest of the complete host message is preserved'
    Assert-Fx (-not ([IO.File]::ReadAllText($script:FxQueuePath)).Contains($script:FxGofileToken)) 'the queue file never contains the gofile token'
    Assert-Fx (-not ([IO.File]::ReadAllText($script:FxLogPath)).Contains($script:FxGofileToken)) 'the fx log never contains the gofile token'
    $script:FxGofileToken = ''

    # --- U10 sandbox shell --------------------------------------------------
    $stage = 'U10 sandbox shell'
    $nonce = 'a1b2c3d4e5f60718'
    $sandbox = Get-FxSandboxResponse -Path ('/preview-sandbox/' + $nonce + '/body')
    Assert-Fx ($sandbox.code -eq 200 -and $sandbox.ctype -eq 'text/html; charset=utf-8') 'the sandbox body is explicit HTML'
    $headerNames = @($sandbox.headers | ForEach-Object { ($_ -split ':')[0].Trim().ToLower() })
    foreach ($want in @('content-security-policy', 'origin-agent-cluster', 'cross-origin-resource-policy', 'x-content-type-options', 'referrer-policy', 'set-cookie')) {
        Assert-Fx ($headerNames -contains $want) ('the sandbox shell sets ' + $want)
    }
    $csp = [string](@($sandbox.headers | Where-Object { $_ -like 'Content-Security-Policy:*' })[0])
    Assert-Fx ($csp -match "sandbox allow-scripts") 'the sandbox CSP carries the sandbox directive'
    Assert-Fx ($csp -match ("script-src 'nonce-" + $nonce + "'")) 'the sandbox CSP pins the nonce'
    Assert-Fx ($csp -match "default-src 'none'") 'the sandbox CSP denies by default'
    Assert-Fx ($csp -match "frame-ancestors 'self'") 'the sandbox CSP restricts framing'
    $cookie = [string](@($sandbox.headers | Where-Object { $_ -like 'Set-Cookie:*' })[0])
    Assert-Fx ($cookie -match 'SameSite=Strict') 'the sandbox cookie is SameSite=Strict'
    Assert-Fx ($cookie -match 'Path=/preview-sandbox') 'the sandbox cookie is scoped to /preview-sandbox'
    Assert-Fx ($cookie -match 'HttpOnly') 'the sandbox cookie is HttpOnly'
    Assert-Fx ([string](@($sandbox.headers | Where-Object { $_ -eq 'Origin-Agent-Cluster: ?1' })[0]) -ne '') 'Origin-Agent-Cluster is ?1'
    $shellText = [Text.Encoding]::UTF8.GetString([byte[]]$sandbox.body)
    Assert-Fx ($shellText.StartsWith('<!DOCTYPE html>') -and $shellText.Contains('<meta charset="utf-8">')) 'the shell is MIME-explicit'
    Assert-Fx ((Get-FxSandboxResponse -Path '/preview-sandbox/NOTAHASH').code -eq 404) 'a non-hex sandbox nonce is refused'
    Assert-Fx ((Get-FxSandboxResponse -Path '/preview-sandbox/' + $nonce + '/x/y').code -eq 404) 'an over-deep sandbox path is refused'

    # --- U11 gofile status -------------------------------------------------
    $stage = 'U11 gofile status polling'
    $gIdxJson = @'
{"files":[{"id":"ggg","root":"Downloads","path":"/a","size":1,"gofile":{"code":"FOLDER1","fileId":"FILE1","status":"processing"}}]}
'@
    $gIdx = Invoke-FxMigrateIndex -Value ($gIdxJson | ConvertFrom-Json)
    $stored = Get-FxGofileStatusResponse -Index $gIdx -Id 'ggg' -Token ''
    Assert-Fx ($stored.code -eq 200 -and $stored.json.status -eq 'processing') 'with no token the stored state is served'
    $timeoutFetcher = { param($req) [ordered]@{ ok = $false; phase = 'tcp'; status = 0; message = 'timed out' } }
    $t = Get-FxGofileStatusResponse -Index $gIdx -Id 'ggg' -Token 'go_test_token_123456' -Base 'https://api.gofile.io' -Fetcher $timeoutFetcher
    Assert-Fx ($t.code -eq 504 -and $t.phase -eq 'tcp') 'a transport timeout is 504'
    $dnsFetcher = { param($req) [ordered]@{ ok = $false; phase = 'dns'; status = 0; message = 'no such host' } }
    $d = Get-FxGofileStatusResponse -Index $gIdx -Id 'ggg' -Token 'go_test_token_123456' -Base 'https://api.gofile.io' -Fetcher $dnsFetcher
    Assert-Fx ($d.code -eq 502 -and $d.phase -eq 'dns') 'an unreachable host is 502'
    $httpFailFetcher = { param($req) [ordered]@{ ok = $false; phase = 'http'; status = 503; text = 'maintenance' } }
    $h = Get-FxGofileStatusResponse -Index $gIdx -Id 'ggg' -Token 'go_test_token_123456' -Base 'https://api.gofile.io' -Fetcher $httpFailFetcher
    Assert-Fx ($h.code -eq 502 -and $h.phase -eq 'http') 'a host 503 is reported as 502'
    $badJsonFetcher = { param($req) [ordered]@{ ok = $true; phase = 'http'; status = 200; text = 'not json' } }
    $bj = Get-FxGofileStatusResponse -Index $gIdx -Id 'ggg' -Token 'go_test_token_123456' -Base 'https://api.gofile.io' -Fetcher $badJsonFetcher
    Assert-Fx ($bj.code -eq 502 -and $bj.phase -eq 'parse') 'a non-JSON host reply is 502 (parse)'
    $okFetcher = { param($req) [ordered]@{ ok = $true; phase = 'http'; status = 200; text = '{"data":{"status":"ok","downloadCount":7,"size":1234}}' } }
    $good = Get-FxGofileStatusResponse -Index $gIdx -Id 'ggg' -Token 'go_test_token_123456' -Base 'https://api.gofile.io' -Fetcher $okFetcher
    Assert-Fx ($good.code -eq 200 -and $good.json.status -eq 'uploaded') 'a live ok status maps to uploaded'
    Assert-Fx ($good.json.downloads -eq 7 -and $good.json.remoteSize -eq 1234) 'the host counters are refreshed'
    Assert-Fx ((Get-FxGofileStatusResponse -Index $gIdx -Id 'nope').code -eq 404) 'an unknown id is 404'
    $expiredFetcher = { param($req) [ordered]@{ ok = $true; phase = 'http'; status = 200; text = '{"data":{"status":"expired"}}' } }
    $exp = Get-FxGofileStatusResponse -Index $gIdx -Id 'ggg' -Token 'go_test_token_123456' -Base 'https://api.gofile.io' -Fetcher $expiredFetcher
    Assert-Fx ($exp.json.status -eq 'expired' -and $null -eq $exp.json.directUrl) 'an expired file keeps directUrl null'

    # --- U12 path resolution + preview verdicts ----------------------------
    $stage = 'U12 path resolution'
    $okPath = Resolve-FxLocalPath -RootName 'Downloads' -Path '/hello.txt'
    Assert-Fx ($okPath.ok -and $okPath.fullPath.EndsWith('hello.txt')) 'a safe path resolves'
    foreach ($bad in @('/../secret.txt', '/a/../../b', '/', 'relative.txt')) {
        $r = Resolve-FxLocalPath -RootName 'Downloads' -Path $bad
        Assert-Fx (-not $r.ok) ('an unsafe path is refused: ' + $bad)
    }
    Assert-Fx (-not (Resolve-FxLocalPath -RootName 'Nope' -Path '/a.txt').ok) 'an unknown root is refused'
    Assert-Fx ((Get-FxPreviewResponse -Index $gIdx -Id 'ggg').code -eq 404) 'preview 404s when neither a local file nor a hosted copy exists'

    # ==================== INTEGRATION (real request cycles) =================
    $stage = 'INTEGRATION fixture index'
    Write-FixtureIndex -Path $script:FxIndexPath -SchemaVersion 1 -Files @(
        @{ root = 'Downloads'; path = '/hello.txt'; size = $helloBytes.Length; mime = 'text/plain' },
        @{ id = 'fx-refused'; root = 'Downloads'; path = '/refused.exe'; size = 2; mime = 'application/x-fx-refused' },
        @{ id = 'fx-escaped'; root = 'Downloads'; path = '/../escaped.txt'; size = 8; mime = 'text/plain' },
        @{ id = 'fx-hosted'; root = 'Downloads'; path = '/missing.txt'; size = 5; mime = 'text/plain'; gofile = @{ code = 'FOLDER9'; fileId = 'FILE9'; status = 'uploaded'; directUrl = 'https://store1.gofile.io/download/FILE9' } }
    )
    [IO.File]::WriteAllText($script:FxLogPath, '')

    $stage = 'I1 GET /api/fx/list'
    $list = Request-Fx -Path '/api/fx/list' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($list.Code -eq 200) 'list returns 200 with a header dash token from a public source'
    $listJson = $list.Body | ConvertFrom-Json
    Assert-Fx ($listJson.schemaVersion -eq 2) 'list emits schemaVersion 2 even when the file on disk was v1'
    Assert-Fx (@($listJson.gofileHosts).Count -eq 1 -and $listJson.gofileHosts[0].id -eq 'gofile') 'list emits the gofileHosts array'
    Assert-Fx (@($listJson.files).Count -eq 4) 'list carries every file entry'
    Assert-Fx ($listJson.files[2].path -eq '/../escaped.txt') 'list carries paths verbatim (no silent rewrite)'
    Assert-Fx ($listJson.files[3].gofile.directUrl -eq 'https://store1.gofile.io/download/FILE9') 'a stored credential-free link is preserved'
    Assert-Fx (-not $list.Head.Contains('Access-Control-Allow-Origin')) 'Explorer responses are never CORS-wildcarded'
    Assert-Fx ($list.Headers['content-type'] -eq 'application/json; charset=utf-8') 'list is JSON'
    Assert-Fx ($list.Headers['cache-control'] -eq 'no-store') 'list is never cached'

    $stage = 'I2/I3 authorization'
    $noToken = Request-Fx -Path '/api/fx/list'
    Assert-Fx ($noToken.Code -eq 401) 'a public source with no token is 401'
    $noTokenJson = $noToken.Body | ConvertFrom-Json
    Assert-Fx ($noTokenJson.phase -eq 'auth') 'the 401 body carries the F44 phase'
    $wrongToken = Request-Fx -Path '/api/fx/list' -Headers @{ 'X-Dash-Token' = 'wrong-token-0123456789' }
    Assert-Fx ($wrongToken.Code -eq 401) 'a wrong token is 401'
    $tailnet = Request-Fx -Path '/api/fx/list' -Source '100.64.0.7'
    Assert-Fx ($tailnet.Code -eq 200) 'a tailnet source needs no token (parent trust path)'
    $loopback = Request-Fx -Path '/api/fx/list' -Source '127.0.0.1'
    Assert-Fx ($loopback.Code -eq 200) 'loopback is allowed (self-probe)'

    $stage = 'I4 GET /api/fx/meta'
    $meta = Request-Fx -Path '/api/fx/meta?id=fx-refused' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($meta.Code -eq 200 -and (($meta.Body | ConvertFrom-Json)).id -eq 'fx-refused') 'meta returns the entry'
    Assert-Fx ((Request-Fx -Path '/api/fx/meta?id=nope' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 404) 'meta returns 404 for an unknown id'
    Assert-Fx ((Request-Fx -Path '/api/fx/meta' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 404) 'meta without an id is a 404 (not a wildcard)'

    $stage = 'I5 Range request (206)'
    $helloId = $listJson.files[0].id
    $full = Request-Fx -Path ('/api/fx/preview?id=' + $helloId) -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($full.Code -eq 200) 'a full preview returns 200'
    Assert-Fx ($full.Bytes.Count -eq $helloBytes.Length) 'the full body has the file length'
    Assert-Fx ($full.Headers['accept-ranges'] -eq 'bytes') 'preview advertises Accept-Ranges'
    Assert-Fx ($full.Headers['content-length'] -eq [string]$helloBytes.Length) 'Content-Length matches the file'
    Assert-Fx ($full.Headers['content-type'] -eq 'text/plain') 'the declared MIME type is used'
    Assert-Fx ($full.Headers['x-content-type-options'] -eq 'nosniff') 'preview is nosniff'
    $partial = Request-Fx -Path ('/api/fx/preview?id=' + $helloId) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'Range' = 'bytes=0-4' }
    Assert-Fx ($partial.Code -eq 206) 'a Range request returns 206 Partial Content'
    Assert-Fx ($partial.Headers['content-range'] -eq ('bytes 0-4/' + $helloBytes.Length)) 'Content-Range is exact'
    Assert-Fx ($partial.Headers['content-length'] -eq '5') 'the partial Content-Length is the range length'
    Assert-Fx ($partial.Bytes.Count -eq 5) 'exactly the requested bytes are sent'
    Assert-Fx ($partial.Body -eq 'hello') 'the returned bytes are the head of the file'
    $suffix = Request-Fx -Path ('/api/fx/preview?id=' + $helloId) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'Range' = 'bytes=-5' }
    Assert-Fx ($suffix.Code -eq 206 -and $suffix.Body -eq 'world') 'a suffix range returns the tail'
    $beyond = Request-Fx -Path ('/api/fx/preview?id=' + $helloId) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'Range' = 'bytes=500-' }
    Assert-Fx ($beyond.Code -eq 416) 'a range beyond EOF is 416'
    Assert-Fx ($beyond.Headers['content-range'] -eq ('bytes */' + $helloBytes.Length)) 'the 416 carries bytes */total'

    $stage = 'I6 preview refusals'
    Assert-Fx ((Request-Fx -Path '/api/fx/preview?id=nope' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 404) 'an unknown preview id is 404'
    $refusedMime = Request-Fx -Path '/api/fx/preview?id=fx-refused' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($refusedMime.Code -eq 415 -and (($refusedMime.Body | ConvertFrom-Json)).phase -eq 'type') 'a refused type is 415 with phase=type'
    $savedMax = $script:FxPreviewMaxBytes
    $script:FxPreviewMaxBytes = 4
    $tooBig = Request-Fx -Path ('/api/fx/preview?id=' + $helloId) -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($tooBig.Code -eq 413 -and (($tooBig.Body | ConvertFrom-Json)).phase -eq 'size') 'a file over the ceiling is 413 with phase=size'
    $script:FxPreviewMaxBytes = $savedMax
    $escaping = Request-Fx -Path '/api/fx/preview?id=fx-escaped' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($escaping.Code -eq 404) 'a traversal path has no local file and no proxyable copy'
    $proxyFetcher = { param($req) [ordered]@{ ok = $true; phase = 'http'; status = 206; bytes = [byte[]]@(65, 66); contentRange = 'bytes 0-1/10' } }
    $script:FxFetcher = $proxyFetcher
    $proxied = Request-Fx -Path '/api/fx/preview?id=fx-hosted' -Headers @{ 'X-Dash-Token' = $script:FxToken; 'Range' = 'bytes=0-1' }
    Assert-Fx ($proxied.Code -eq 206 -and $proxied.Body -eq 'AB') 'an uploaded file is proxied from the host when it is not local'
    Assert-Fx ($proxied.Headers['content-range'] -eq 'bytes 0-1/10') 'the host Content-Range is passed through'
    $script:FxFetcher = { param($req) [ordered]@{ ok = $false; phase = 'tcp'; status = 0; message = 'timeout' } }
    Assert-Fx ((Request-Fx -Path '/api/fx/preview?id=fx-hosted' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 504) 'a host transport timeout is 504'
    $script:FxFetcher = { param($req) [ordered]@{ ok = $false; phase = 'dns'; status = 0; message = 'unreachable' } }
    Assert-Fx ((Request-Fx -Path '/api/fx/preview?id=fx-hosted' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 502) 'an unreachable host is 502'
    $script:FxFetcher = $null

    $stage = 'I7 POST /api/fx/op'
    $csrfToken = Get-FxCsrfToken -Token $script:FxToken
    $opBody = New-FxJson @{ op = 'trash'; ids = @('fx-refused') }
    $noCsrf = Request-Fx -Path '/api/fx/op' -Method 'POST' -Body $opBody -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($noCsrf.Code -eq 403) 'a POST without CSRF is 403'
    Assert-Fx ((($noCsrf.Body | ConvertFrom-Json)).phase -eq 'auth') 'the CSRF refusal carries phase=auth'
    $opOk = Request-Fx -Path '/api/fx/op' -Method 'POST' -Body $opBody -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken; 'X-Idempotency-Key' = 'k1' }
    Assert-Fx ($opOk.Code -eq 200) 'a CSRF-authorised op applies'
    $opJson = $opOk.Body | ConvertFrom-Json
    Assert-Fx ((@($opJson.applied) -join ',') -eq 'fx-refused' -and @($opJson.skipped).Count -eq 0) 'the response is { applied, skipped }'
    $afterOp = Request-Fx -Path '/api/fx/meta?id=fx-refused' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ((($afterOp.Body | ConvertFrom-Json)).trashed) 'the op was persisted to the index'
    $onDisk = ([IO.File]::ReadAllText($script:FxIndexPath) | ConvertFrom-Json)
    Assert-Fx ($onDisk.schemaVersion -eq 2) 'the write re-emitted schemaVersion 2'
    Assert-Fx (@($onDisk.gofileHosts).Count -eq 1) 'the write kept the gofileHosts array'
    # S5.1 rule 6: the same key + the same body replays the recorded answer
    $replay = Request-Fx -Path '/api/fx/op' -Method 'POST' -Body $opBody -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken; 'X-Idempotency-Key' = 'k1' }
    Assert-Fx ($replay.Code -eq 200 -and $replay.Headers['x-idempotent-replay'] -eq '1') 'a replayed idempotency key is answered from the record'
    Assert-Fx (((($replay.Body | ConvertFrom-Json)).applied) -join ',' -eq 'fx-refused') 'the replay returns the ORIGINAL applied list'
    $keyReuse = Request-Fx -Path '/api/fx/op' -Method 'POST' -Body (New-FxJson @{ op = 'restore'; ids = @('fx-refused') }) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken; 'X-Idempotency-Key' = 'k1' }
    Assert-Fx ($keyReuse.Code -eq 409) 'reusing a key with a different body is 409'
    Assert-Fx (Test-Path -LiteralPath $script:FxIdempotencyPath) 'the idempotency record is persisted'
    Assert-Fx (([IO.File]::ReadAllText($script:FxIdempotencyPath)) -match 'k1') 'the record holds the key'
    Assert-Fx (-not ([IO.File]::ReadAllText($script:FxIdempotencyPath)).Contains($script:FxToken)) 'the record holds no credential'
    $hardBody = New-FxJson @{ op = 'trash'; ids = @('fx-refused'); hard = $true }
    $hardResp = Request-Fx -Path '/api/fx/op' -Method 'POST' -Body $hardBody -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken }
    Assert-Fx ($hardResp.Code -eq 400) 'a hard delete is refused with 400'
    $badOp = Request-Fx -Path '/api/fx/op' -Method 'POST' -Body (New-FxJson @{ op = 'nuke'; ids = @('fx-refused') }) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken }
    Assert-Fx ($badOp.Code -eq 400) 'an unknown op is 400'
    $getOp = Request-Fx -Path '/api/fx/op' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($getOp.Code -eq 405) 'op is POST only (405 for GET)'
    $restore = Request-Fx -Path '/api/fx/op' -Method 'POST' -Body (New-FxJson @{ op = 'restore'; ids = @('fx-refused') }) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken }
    Assert-Fx ($restore.Code -eq 200) 'restore is accepted'
    Assert-Fx (-not ((Request-Fx -Path '/api/fx/meta?id=fx-refused' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Body | ConvertFrom-Json).trashed) 'restore persisted'

    $stage = 'I8 POST /api/fx/upload'
    Remove-Item -LiteralPath $script:FxQueuePath -Force -ErrorAction SilentlyContinue
    $uploadBody = New-FxJson @{ ids = @('fx-refused', $helloId); host = 'gofile' }
    $noCsrfUpload = Request-Fx -Path '/api/fx/upload' -Method 'POST' -Body $uploadBody -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($noCsrfUpload.Code -eq 403) 'upload without CSRF is 403'
    $upload = Request-Fx -Path '/api/fx/upload' -Method 'POST' -Body $uploadBody -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken }
    Assert-Fx ($upload.Code -eq 202) 'a valid upload request is 202'
    $uploadJson = $upload.Body | ConvertFrom-Json
    Assert-Fx (@($uploadJson.jobs).Count -eq 2) 'both ids are queued'
    foreach ($j in @($uploadJson.jobs)) {
        Assert-Fx ($j.id -and $j.uploadJobId) 'each job carries id + uploadJobId'
    }
    Assert-Fx (Test-Path -LiteralPath $script:FxQueuePath) 'the queue was persisted to the fx queue path'
    $badHostUpload = Request-Fx -Path '/api/fx/upload' -Method 'POST' -Body (New-FxJson @{ ids = @('fx-refused'); host = 'mega' }) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken }
    Assert-Fx ($badHostUpload.Code -eq 400) 'an unknown upload host is 400'
    $hardUpload = Request-Fx -Path '/api/fx/upload' -Method 'POST' -Body (New-FxJson @{ ids = @('fx-refused'); host = 'gofile'; hard = $true }) -Headers @{ 'X-Dash-Token' = $script:FxToken; 'X-CSRF-Token' = $csrfToken }
    Assert-Fx ($hardUpload.Code -eq 400) 'a hard flag on upload is 400'

    $stage = 'I9 sandbox route'
    $sandboxResp = Request-Fx -Path ('/preview-sandbox/' + $nonce + '/body') -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($sandboxResp.Code -eq 200) 'the sandbox shell is served to an authenticated request'
    Assert-Fx ($sandboxResp.Headers['origin-agent-cluster'] -eq '?1') 'Origin-Agent-Cluster reaches the wire'
    Assert-Fx ($sandboxResp.Headers['cross-origin-resource-policy'] -eq 'same-site') 'CORP reaches the wire'
    Assert-Fx ($sandboxResp.Headers['set-cookie'] -match 'SameSite=Strict') 'the sandbox cookie reaches the wire'
    Assert-Fx ($sandboxResp.Headers['content-security-policy'] -match 'sandbox') 'the CSP reaches the wire'
    Assert-Fx ((Request-Fx -Path ('/preview-sandbox/' + $nonce + '/body')).Code -eq 401) 'the sandbox is not anonymous'

    $stage = 'I10 unknown route + method'
    $unknown = Request-Fx -Path '/api/fx/nope' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($unknown.Code -eq 404) 'an unknown Explorer endpoint is 404'
    Assert-Fx ((Request-Fx -Path '/api/fx/list/more' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 404) 'a sub-path is not a wildcard route'
    $options = Request-Fx -Path '/api/fx/list' -Method 'OPTIONS' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($options.Code -eq 204) 'OPTIONS answers 204'

    $stage = 'I11 index parse failure (500)'
    $goodIndex = [IO.File]::ReadAllText($script:FxIndexPath)
    [IO.File]::WriteAllText($script:FxIndexPath, '{ this is not json')
    $broken = Request-Fx -Path '/api/fx/list' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($broken.Code -eq 500) 'an unparsable index is 500'
    $brokenJson = $broken.Body | ConvertFrom-Json
    Assert-Fx ($brokenJson.phase -eq 'parse') 'the 500 body carries the F44 parse phase'
    Assert-Fx (-not [string]::IsNullOrEmpty([string]$brokenJson.error)) 'the 500 body carries a message'
    [IO.File]::WriteAllText($script:FxIndexPath, $goodIndex)
    Assert-Fx ((Request-Fx -Path '/api/fx/list' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 200) 'the index recovers after the bad file is replaced'

    $stage = 'I12 gofile status route'
    $status200 = Request-Fx -Path '/api/fx/gofile/status?id=fx-hosted' -Headers @{ 'X-Dash-Token' = $script:FxToken }
    Assert-Fx ($status200.Code -eq 200 -and (($status200.Body | ConvertFrom-Json)).status -eq 'uploaded') 'status serves the stored state'
    Assert-Fx ((Request-Fx -Path '/api/fx/gofile/status?id=nope' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 404) 'status 404s an unknown id'
    $script:FxGofileToken = 'go_live_token_0123456789abcdef'
    $script:FxFetcher = { param($req) [ordered]@{ ok = $false; phase = 'tcp'; status = 0; message = 'timeout' } }
    Assert-Fx ((Request-Fx -Path '/api/fx/gofile/status?id=fx-hosted' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 504) 'status reports 504 when the host times out'
    $script:FxFetcher = { param($req) [ordered]@{ ok = $false; phase = 'dns'; status = 0; message = 'unreachable' } }
    Assert-Fx ((Request-Fx -Path '/api/fx/gofile/status?id=fx-hosted' -Headers @{ 'X-Dash-Token' = $script:FxToken }).Code -eq 502) 'status reports 502 when the host is unreachable'
    $script:FxFetcher = $null
    $script:FxGofileToken = ''

    $stage = 'I13 credential redaction over the wire and in the log'
    $logNow = [IO.File]::ReadAllText($script:FxLogPath)
    Assert-Fx (-not $logNow.Contains($script:FxToken)) 'the dash token never reaches the fx log'
    Assert-Fx (-not $logNow.Contains('go_live_token_0123456789abcdef')) 'the gofile token never reaches the fx log'
    foreach ($resp in @($list, $meta, $status200, $opOk, $upload)) {
        Assert-Fx (-not $resp.Body.Contains($script:FxToken)) 'no response body echoes the dash token'
    }
    Assert-Fx (-not ([IO.File]::ReadAllText($script:FxIndexPath)).Contains($script:FxToken)) 'the index never contains the dash token'
    Assert-Fx (-not ([IO.File]::ReadAllText($script:FxQueuePath)).Contains($script:FxToken)) 'the queue never contains the dash token'
    Assert-Fx ($script:FxLogRedactionHits -ge 1) 'the redaction counter recorded at least one hit'

    if ($script:FxFail -gt 0) {
        Write-Host ('::error::[F45 S4] fx server routes FAILED: ' + $script:FxFail + ' assertion site(s), ' + $script:FxPass + ' passed')
        Write-FxFailures
        exit 1
    }
    Write-Host ('[F45 S4] fx server routes PASS: ' + $script:FxPass + ' assertions (unit + integration, no live host call)')
    exit 0
} catch {
    Write-Host ('::error::[F45 S4] fx server routes FAILED at stage "' + $stage + '" :: ' + $_.Exception.Message)
    Write-Host ('::error::[F45 S4] passed ' + $script:FxPass + ' assertions, ' + $script:FxFail + ' failed, before the failure')
    Write-FxFailures
    exit 1
} finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
