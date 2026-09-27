# [F44 §2 §4] Lab driver for the autologin-lab mirror cell. Runs the REAL
# payloads/ghrdp-mirror-diag.ps1 classifier + retry policy against the mock
# server (tests/mirror-mock-server.js) and asserts phase + attempt counts.
# Prints an F44MATRIX line per case and a markdown table for the step summary.
param([string]$MockBase = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'payloads/ghrdp-lib.ps1')
. (Join-Path $repo 'payloads/ghrdp-mirror-diag.ps1')
if (-not $MockBase) { $MockBase = [string]$env:MIRROR_MOCK_BASE }
if (-not $MockBase) { throw 'MIRROR_MOCK_BASE not set (mock upload server URL)' }

$tmp = Join-Path $env:TEMP ('f44-lab-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$sample = Join-Path $tmp 'sample.bin'
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$buf = New-Object byte[] 8192
$rng.GetBytes($buf)
[System.IO.File]::WriteAllBytes($sample, $buf)

function Get-MockHit([string]$PathKey) {
    $c = Invoke-RestMethod -Uri ($MockBase + '/counts') -UseBasicParsing
    $hit = [int]($c.counts.$PathKey)
    return $hit
}

$rows = New-Object System.Collections.ArrayList
$fails = 0
function Add-Case {
    param([string]$Name, [scriptblock]$Run)
    try {
        $r = & $Run
        [void]$rows.Add(@{ case = $Name; detail = [string]$r; status = 'PASS' })
        Write-Host ('F44MATRIX | ' + $Name + ' | PASS | ' + $r)
    } catch {
        $script:fails = $script:fails + 1
        $msg = ($_.Exception.Message -replace '\s+', ' ').Trim()
        [void]$rows.Add(@{ case = $Name; detail = $msg; status = 'FAIL' })
        Write-Host ('F44MATRIX | ' + $Name + ' | FAIL | ' + $msg)
    }
}
function Cap([string]$Route) { return @{ name = ('mock' + $Route); url = ($MockBase + $Route); apiRoot = ($MockBase + $Route); formField = 'file'; extraFields = @(); parseKind = 'plain-url'; maxBytes = [long]268435456; deniedExt = @() } }
function CapJson([string]$Route) { $c = Cap $Route; $c.parseKind = 'json-data-url'; return $c }

Add-Case 'success (plain-url)' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/success-plain') -MaxAttemptsPerHost 3
    if (-not $u.ok -or $u.link -notmatch '^https://mock\.local/') { throw ('expected success+link, got ok=' + $u.ok + ' ' + $u.errorText) }
    if (@($u.attempts).Count -ne 1 -or [string]$u.attempts[0].phase -ne 'http' -or [int]$u.attempts[0].httpStatus -ne 200) { throw 'expected exactly 1 http/200 attempt' }
    'phase=' + $u.phase + ' attempts=1 link=ok'
}
Add-Case 'success (json-data-url)' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(CapJson '/success-json') -MaxAttemptsPerHost 3
    if (-not $u.ok -or $u.link -notmatch '^https://mock\.tmpfiles\.local/') { throw ('bad json parse: ' + $u.errorText) }
    'phase=' + $u.phase + ' attempts=' + @($u.attempts).Count
}
Add-Case '413 => phase=size, 1 attempt, fail-fast' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/e413') -MaxAttemptsPerHost 3
    if ($u.ok) { throw 'must not succeed' }
    if (@($u.attempts).Count -ne 1 -or [string]$u.phase -ne 'size' -or $u.retryable) { throw ('bad classify: phase=' + $u.phase + ' attempts=' + @($u.attempts).Count + ' retryable=' + $u.retryable) }
    'phase=size attempts=1 retryable=False'
}
Add-Case '403 content-policy => phase=type, 1 attempt, fail-fast' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/e403') -MaxAttemptsPerHost 3
    if (@($u.attempts).Count -ne 1 -or [string]$u.phase -ne 'type' -or $u.retryable -or $u.ok) { throw ('bad classify: ' + $u.errorText) }
    'phase=type attempts=1 retryable=False'
}
Add-Case '401 => phase=auth, 1 attempt, fail-fast + token redacted' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/e401') -MaxAttemptsPerHost 3
    if (@($u.attempts).Count -ne 1 -or [string]$u.phase -ne 'auth' -or $u.retryable -or $u.ok) { throw ('bad classify: ' + $u.errorText) }
    if ($u.errorText -match 'sekrit12345') { throw 'host token leaked into errorText (redaction failed)' }
    'phase=auth attempts=1 redaction=verified'
}
Add-Case '451 => phase=type, 1 attempt, fail-fast' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/e451') -MaxAttemptsPerHost 3
    if (@($u.attempts).Count -ne 1 -or [string]$u.phase -ne 'type' -or $u.ok) { throw ('bad classify: ' + $u.errorText) }
    'phase=type attempts=1'
}
Add-Case '429 x2 then 200 => transient retries, success on attempt 3' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/e429x2') -MaxAttemptsPerHost 3
    if (-not $u.ok -or @($u.attempts).Count -ne 3) { throw ('expected ok after 3 attempts: ok=' + $u.ok + ' attempts=' + @($u.attempts).Count + ' ' + $u.errorText) }
    if ([string]$u.attempts[0].phase -ne 'http' -or [int]$u.attempts[0].httpStatus -ne 429) { throw 'first attempts must be http/429' }
    'phase=http(429,429,200) attempts=3 ok=True'
}
Add-Case '500 x1 then 200 => transient retry, success on attempt 2' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/e500x1') -MaxAttemptsPerHost 3
    if (-not $u.ok -or @($u.attempts).Count -ne 2) { throw ('expected ok after 2 attempts: ' + $u.errorText) }
    'phase=http(500,200) attempts=2 ok=True'
}
Add-Case 'malformed-json => phase=parse, 1 attempt (success-as-failure direction)' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(CapJson '/malformed-json') -MaxAttemptsPerHost 3
    if ($u.ok) { throw 'malformed body must never be success' }
    if (@($u.attempts).Count -ne 1 -or [string]$u.phase -ne 'parse' -or $u.retryable) { throw ('bad classify: ' + $u.errorText) }
    'phase=parse attempts=1'
}
Add-Case 'ok-nolink 200 => phase=parse (no link), failure-as-failure direction' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(CapJson '/ok-nolink') -MaxAttemptsPerHost 3
    if ($u.ok) { throw 'json without data.url must never be success' }
    if (@($u.attempts).Count -ne 1 -or [string]$u.phase -ne 'parse') { throw ('bad classify: ' + $u.errorText) }
    'phase=parse attempts=1'
}
Add-Case 'err-json 200 => classified failure, never success' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(CapJson '/err-json') -MaxAttemptsPerHost 3
    if ($u.ok) { throw 'explicit error json must never be success' }
    'phase=' + $u.phase + ' attempts=' + @($u.attempts).Count
}
Add-Case 'tls-reset => transport phase, retried to budget (3), retryable' {
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @(Cap '/tls-reset') -MaxAttemptsPerHost 3
    $ph = [string]$u.phase
    if ($u.ok) { throw 'reset must not succeed' }
    if (@($u.attempts).Count -ne 3) { throw ('expected 3 attempts, got ' + @($u.attempts).Count) }
    if ($ph -ne 'tcp' -and $ph -ne 'tls') { throw ('expected transport phase tcp|tls, got ' + $ph) }
    if (-not $u.retryable) { throw 'transport class must stay retryable (watcher re-queues visibly)' }
    'phase=' + $ph + ' attempts=3 retryable=True'
}
Add-Case 'over global cap => phase=size at attempt 0, ZERO network tries' {
    $before = Get-MockHit '/success-plain'
    $fat = Join-Path $tmp 'fat.iso'
    $fs = [System.IO.File]::Create($fat); $fs.SetLength(4096); $fs.Dispose()
    $u = Invoke-MirrorUpload -Path $fat -DispName 'fat.iso' -CapsOverride @(Cap '/success-plain') -GlobalMaxBytes 2048 -MaxAttemptsPerHost 3
    $after = Get-MockHit '/success-plain'
    if ($u.ok -or [string]$u.phase -ne 'size' -or @($u.attempts).Count -ne 1) { throw ('bad classify: ' + $u.errorText) }
    if ([string]$u.attempts[0].host -ne '*') { throw 'global preflight record must be host=*' }
    if ($after -ne $before) { throw ('network was used for a preflight rejection: ' + $before + ' -> ' + $after) }
    'phase=size attempts=1 networkTries=0'
}
Add-Case 'over per-host cap => phase=size per host, ZERO network tries' {
    $before = Get-MockHit '/success-plain'
    $c = Cap '/success-plain'; $c.maxBytes = [long]1024
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @($c) -MaxAttemptsPerHost 3
    $after = Get-MockHit '/success-plain'
    if ($u.ok -or [string]$u.phase -ne 'size' -or @($u.attempts).Count -ne 1) { throw ('bad classify: ' + $u.errorText) }
    if ($after -ne $before) { throw 'network was used for a host-cap rejection' }
    'phase=size attempts=1 networkTries=0'
}
Add-Case 'denied extension => phase=type per host, ZERO network tries' {
    $before = Get-MockHit '/success-plain'
    $c = Cap '/success-plain'; $c.deniedExt = @('.bin')
    $u = Invoke-MirrorUpload -Path $sample -DispName 'sample.bin' -CapsOverride @($c) -MaxAttemptsPerHost 3
    $after = Get-MockHit '/success-plain'
    if ($u.ok -or [string]$u.phase -ne 'type' -or @($u.attempts).Count -ne 1) { throw ('bad classify: ' + $u.errorText) }
    if ($after -ne $before) { throw 'network was used for a type rejection' }
    'phase=type attempts=1 networkTries=0'
}
Add-Case '8.3 short path (C:\...\RDP8B3~1-style) uploads with bytes counted' {
    $longDir = Join-Path $tmp 'Long Directory Name For EightDotThree Testing'
    New-Item -ItemType Directory -Path $longDir -Force | Out-Null
    $p83 = Join-Path $longDir 'eight-dot-three-sample.bin'
    [System.IO.File]::WriteAllBytes($p83, $buf)
    $fso = New-Object -ComObject Scripting.FileSystemObject
    $short = [string]$fso.GetFile($p83).ShortPath
    Write-Host ('  8.3 path: ' + $short)
    $u = Invoke-MirrorUpload -Path $short -DispName 'eight-dot-three-sample.bin' -CapsOverride @(Cap '/success-plain') -MaxAttemptsPerHost 3
    if (-not $u.ok) { throw ('8.3 path upload failed: ' + $u.errorText) }
    if ([long]$u.attempts[0].bytesSent -le 0) { throw 'bytesSent must be > 0 for the 8.3 path' }
    '8.3=' + $short + ' bytes=' + [long]$u.attempts[0].bytesSent
}
Add-Case 'encrypt verify: real AES output passes Test-MirrorEncryptOutput' {
    $enc = Join-Path $tmp 'sample.ghenc'
    Invoke-AesEncryptFile -InPath $sample -OutPath $enc -Password ('f44-lab-' + [guid]::NewGuid().ToString('N'))
    $len = Test-MirrorEncryptOutput -Path $enc
    if ([long]$len -le 0) { throw 'empty ciphertext' }
    'ciphertext=' + $len + ' B verified'
}
Add-Case 'encrypt verify: 0-byte ciphertext is phase=encrypt (no silent pass)' {
    $empty = Join-Path $tmp 'empty.ghenc'
    New-Item -ItemType File -Path $empty -Force | Out-Null
    $threw = $false
    try { Test-MirrorEncryptOutput -Path $empty } catch { $threw = ($_.Exception.Message -match 'phase=encrypt') }
    if (-not $threw) { throw 'Test-MirrorEncryptOutput must throw phase=encrypt on empty ciphertext' }
    'phase=encrypt thrown on 0 bytes'
}

$passed = @($rows | Where-Object { $_.status -eq 'PASS' }).Count
$total = @($rows).Count
Write-Host ('F44MATRIX SUMMARY: ' + $passed + '/' + $total + ' pass')
if ($env:GITHUB_STEP_SUMMARY) {
    '### F44 mirror-cell matrix (mock cases => phase => attempts)' | Add-Content -Path $env:GITHUB_STEP_SUMMARY
    '| case | result | detail |' | Add-Content -Path $env:GITHUB_STEP_SUMMARY
    '| --- | --- | --- |' | Add-Content -Path $env:GITHUB_STEP_SUMMARY
    foreach ($r in @($rows)) { ('| ' + $r.case + ' | **' + $r.status + ' (lab)** | ' + ($r.detail -replace '\|', '/') + ' |') | Add-Content -Path $env:GITHUB_STEP_SUMMARY }
}
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($fails -gt 0) { exit 1 }
exit 0
