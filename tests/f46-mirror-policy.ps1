# [F46 §6] Mirror policy + contract lab (Windows lane).
#
# Drives the SHIPPED payloads/ghrdp-mirror.ps1 with a mock transport: attempt
# counts per policy, the untruncated reason, preflight with zero network tries,
# the documented gofile contract parsing and the read-only probe matrix. No
# content is uploaded and no live host is called by the mock cases; the single
# real probe at the end is a read-only GET (its result is recorded, not
# asserted, so an egress policy cannot make this lane lie).
#
# Exit 0 only when every check passes. Starts no msc, no watcher, writes nothing
# outside $env:RUNNER_TEMP.
$ErrorActionPreference = 'Stop'
$script:failures = 0
$script:networkCalls = 0
$script:scenarioIdx = 0
$script:scenarios = @()
$script:sleptMs = @()
$script:longMsg = ('mock host refusal: ' + ('detail '.PadRight(1500, '.') + ' END-OF-UNTRUNCATED-MESSAGE'))

function Check([string]$Name, [bool]$Cond, [string]$Detail) {
    if ($Cond) {
        Write-Host ('  [PASS] ' + $Name)
    } else {
        $script:failures = $script:failures + 1
        Write-Host ('  [FAIL] ' + $Name + ' :: ' + $Detail)
    }
}

$root = $env:GITHUB_WORKSPACE
if (-not $root) { $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$modPath = Join-Path $root 'payloads\ghrdp-mirror.ps1'
if (-not (Test-Path -LiteralPath $modPath)) { $modPath = Join-Path $root 'payloads/ghrdp-mirror.ps1' }
if (-not (Test-Path -LiteralPath $modPath)) { throw ('F46: the mirror module is missing at ' + $modPath) }
. $modPath
Write-Host ('[F46] module loaded: ' + $modPath)

$tmp = $env:RUNNER_TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath() }
$filePath = Join-Path $tmp 'f46-mock-payload.bin'
[System.IO.File]::WriteAllBytes($filePath, (New-Object byte[] 2048))

$transport = {
    param($HostCfg, $Path, $Name, $Size, $Token)
    $script:networkCalls = $script:networkCalls + 1
    $sc = 'success'
    if ($script:scenarioIdx -lt @($script:scenarios).Count) { $sc = [string]$script:scenarios[$script:scenarioIdx] }
    $script:scenarioIdx = $script:scenarioIdx + 1
    switch -Regex ($sc) {
        '^success$' { return @{ ok = $true; phase = $null; httpStatus = 200; hostMessage = ''; fileId = 'mock-id'; code = 'mock-code'; downloadPage = 'https://gofile.test/d/mockcode' } }
        '^403$' { return @{ ok = $false; phase = 'auth'; httpStatus = 403; hostMessage = $script:longMsg } }
        '^413$' { return @{ ok = $false; phase = 'size'; httpStatus = 413; hostMessage = $script:longMsg } }
        '^415$' { return @{ ok = $false; phase = 'type'; httpStatus = 415; hostMessage = $script:longMsg } }
        '^429$' { return @{ ok = $false; phase = 'http'; httpStatus = 429; hostMessage = $script:longMsg; retryAfterMs = 5000 } }
        '^500$' { return @{ ok = $false; phase = 'http'; httpStatus = 500; hostMessage = $script:longMsg } }
        '^502$' { return @{ ok = $false; phase = 'http'; httpStatus = 502; hostMessage = $script:longMsg } }
        '^tls-reset$' { return @{ ok = $false; phase = 'tls'; httpStatus = $null; hostMessage = 'TLS connection reset by peer (mock)' } }
        default { return @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = ('unknown mock scenario ' + $sc) } }
    }
}

function Reset-Case {
    param($Scenarios)
    $script:scenarios = @($Scenarios)
    $script:scenarioIdx = 0
    $script:networkCalls = 0
    $script:sleptMs = @()
}

function Run-Case {
    param($Scenarios, $HostCfg, [bool]$EncryptRequested = $false, [bool]$Encrypted = $false, $Rand01 = 0)
    Reset-Case $Scenarios
    $h = $HostCfg
    return (Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -Token 'mock-token' -Transport $transport -EncryptRequested $EncryptRequested -Encrypted $Encrypted -Rand01 $Rand01 -Sleeper { param($ms) $script:sleptMs += @([int]$ms) })
}

$hostOn = Get-F46DefaultHost
$hostOn.enabled = $true

Write-Host '[F46] policy matrix (mock transport, no live host)'
$r403 = Run-Case @('403') $hostOn
Check '403 => exactly 1 attempt (fail-fast)' (@($r403.attempts).Count -eq 1) ('attempts=' + @($r403.attempts).Count)
Check '403 => zero retries scheduled' (@($script:sleptMs).Count -eq 0) ('sleeps=' + (@($script:sleptMs) -join ','))
Check '403 => phase=auth recorded' ($r403.phase -eq 'auth') ('phase=' + $r403.phase)

$r413 = Run-Case @('413') $hostOn
Check '413 => exactly 1 attempt (fail-fast)' (@($r413.attempts).Count -eq 1) ('attempts=' + @($r413.attempts).Count)
Check '413 => phase=size recorded' ($r413.phase -eq 'size') ('phase=' + $r413.phase)

$r415 = Run-Case @('415') $hostOn
Check '415 => exactly 1 attempt (fail-fast)' (@($r415.attempts).Count -eq 1) ('attempts=' + @($r415.attempts).Count)
Check '415 => phase=type recorded' ($r415.phase -eq 'type') ('phase=' + $r415.phase)

$r429 = Run-Case @('429', '429', '429', '429', '429') $hostOn
Check '429 => retries up to 5 attempts' (@($r429.attempts).Count -eq 5 -and $script:networkCalls -eq 5) ('attempts=' + @($r429.attempts).Count + ' network=' + $script:networkCalls)
Check '429 => Retry-After 5000ms is a FLOOR for the first delay' ((@($script:sleptMs).Count -eq 4) -and ([int]$script:sleptMs[0] -ge 5000)) ('delays=' + (@($script:sleptMs) -join ','))

$r500 = Run-Case @('500', '500', 'success') $hostOn
Check '500 => transient retries (3rd attempt succeeds)' (@($r500.attempts).Count -eq 3 -and $r500.ok) ('attempts=' + @($r500.attempts).Count + ' ok=' + $r500.ok)
Check '500 => link comes from downloadPage' ($r500.link -eq 'https://gofile.test/d/mockcode') ('link=' + $r500.link)

$r502 = Run-Case @('502', '502', '502', '502', '502') $hostOn
Check '502 => retries to the 5-attempt budget' (@($r502.attempts).Count -eq 5) ('attempts=' + @($r502.attempts).Count)

$rTls = Run-Case @('tls-reset', 'tls-reset', 'success') $hostOn
Check 'tls-reset => retried (transient tls phase)' (@($rTls.attempts).Count -eq 3 -and $rTls.ok) ('attempts=' + @($rTls.attempts).Count + ' ok=' + $rTls.ok)
Check 'tls-reset => phase=tls recorded on the failing attempts' ((@($rTls.attempts)[0].phase -eq 'tls')) ('phase=' + @($rTls.attempts)[0].phase)

Write-Host '[F46] preflight (zero network tries)'
$hostSmall = Get-F46DefaultHost
$hostSmall.enabled = $true
$hostSmall.maxFileBytes = 1024
$rSize = Run-Case @('success') $hostSmall
Check 'size cap => 1 labeled attempt, 0 network tries' ((@($rSize.attempts).Count -eq 1) -and ($script:networkCalls -eq 0) -and ($rSize.phase -eq 'size')) ('attempts=' + @($rSize.attempts).Count + ' network=' + $script:networkCalls + ' phase=' + $rSize.phase)

$hostTyped = Get-F46DefaultHost
$hostTyped.enabled = $true
$hostTyped.blockedExtensions = @('.bin', '.exe')
$rType = Run-Case @('success') $hostTyped
Check 'blocked type => 1 labeled attempt, 0 network tries' ((@($rType.attempts).Count -eq 1) -and ($script:networkCalls -eq 0) -and ($rType.phase -eq 'type')) ('attempts=' + @($rType.attempts).Count + ' network=' + $script:networkCalls + ' phase=' + $rType.phase)

Write-Host '[F46] reason visibility + honesty'
$reason = $r403.hostMessage
Check 'reason is the COMPLETE host message (no ellipsis, no cap)' ($reason.Length -ge 1500 -and $reason.EndsWith('END-OF-UNTRUNCATED-MESSAGE')) ('len=' + $reason.Length)
$line = Format-F46AttemptLine -Attempt @($r403.attempts)[0]
Check 'attempt line carries host/phase/status/msg/ms' ($line -match '^\[mirror\] attempt 1 host=gofile phase=auth status=403 msg=.* ms=\d+$') ($line.Substring(0, [Math]::Min(120, $line.Length)))
Check 'attempt line truncates ITS copy to 200 chars' ($line.Contains('status=403') -and ($line.Length -lt 320)) ('lineLen=' + $line.Length)
Check 'no bare "upload failed" string is produced' (-not ((Format-F46FailureSummary -HostId 'gofile' -Phase 'auth' -Status '403' -Attempts 1 -Message $reason).StartsWith('[mirror] upload failed'))) 'summary must name host/phase/status'
$reasonText = Format-F46Reason -Phase 'auth' -Status 403 -Message $reason
Check 'UI reason string starts with phase/status and keeps the full msg' ($reasonText.StartsWith('phase=auth status=403 msg=') -and $reasonText.EndsWith('END-OF-UNTRUNCATED-MESSAGE')) ('len=' + $reasonText.Length)

$noToken = Reset-Case @('success')
$resNoTok = Invoke-F46MirrorAttempt -HostCfg $hostOn -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -Token '' -AttemptNo 1 -Transport $transport
Check 'no token + autoAccount=false => phase=auth, 0 network, 1 attempt' (($resNoTok.phase -eq 'auth') -and ($script:networkCalls -eq 0)) ('phase=' + $resNoTok.phase + ' network=' + $script:networkCalls)

$resEnc = Invoke-F46MirrorAttempt -HostCfg $hostOn -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -Token 'mock-token' -AttemptNo 1 -Transport $transport -EncryptRequested $true -Encrypted $false
Check 'encrypt requested but unavailable => phase=encrypt, refused (never claims encrypted)' (($resEnc.phase -eq 'encrypt') -and ($script:networkCalls -eq 0)) ('phase=' + $resEnc.phase)

$resPolicy = Invoke-F46MirrorAttempt -HostCfg $null -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -Token 'mock-token' -AttemptNo 1 -Transport $transport
Check 'no enabled host => phase=policy, 1 labeled attempt' ($resPolicy.phase -eq 'policy') ('phase=' + $resPolicy.phase)

Write-Host '[F46] documented gofile contract (pinned from https://gofile.io/api)'
$c = $script:F46GofileContract
Check 'contract: POST /accounts -> token' ($c.accountsPath -eq '/accounts') ('accountsPath=' + $c.accountsPath)
Check 'contract: GET /servers -> upload server' ($c.serversPath -eq '/servers') ('serversPath=' + $c.serversPath)
Check 'contract: multipart field name is file' ($c.multipartField -eq 'file') ('field=' + $c.multipartField)
Check 'contract: Bearer authorization header' ($c.authScheme -eq 'Bearer') ('auth=' + $c.authScheme)
Check 'contract: current response id field accepted' (@($c.idFields) -contains 'id') ('idFields=' + (@($c.idFields) -join ','))
Check 'contract: current downloadPage field accepted' (@($c.pageFields) -contains 'downloadPage') ('pageFields=' + (@($c.pageFields) -join ','))

$currentBody = '{"status":"ok","data":{"id":"d4c5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f","type":"file","name":"report.pdf","parentFolder":"x","parentFolderCode":"x7k2p9Qm","downloadPage":"https://gofile.io/d/x7k2p9Qm","code":"Qp9w8eR7","size":2481621}}'
$legacyBody = '{"status":"ok","data":{"fileId":"legacy-id","downloadPage":"https://gofile.io/d/legacy","code":"legacy-code"}}'
$errorBody = '{"status":"error-token"}'
$okCurrent = ConvertFrom-F46UploadResponse -Text $currentBody -HttpStatus 200 -RetryAfterMs $null
Check 'current reference response parses (id + downloadPage + code)' ($okCurrent.ok -and $okCurrent.fileId -eq 'd4c5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f' -and $okCurrent.downloadPage -eq 'https://gofile.io/d/x7k2p9Qm' -and $okCurrent.code -eq 'Qp9w8eR7') ('fileId=' + $okCurrent.fileId + ' page=' + $okCurrent.downloadPage)
$okLegacy = ConvertFrom-F46UploadResponse -Text $legacyBody -HttpStatus 200 -RetryAfterMs $null
Check 'legacy response parses (fileId + directLink family)' ($okLegacy.ok -and $okLegacy.fileId -eq 'legacy-id') ('fileId=' + $okLegacy.fileId)
$badEnv = ConvertFrom-F46UploadResponse -Text $errorBody -HttpStatus 200 -RetryAfterMs $null
Check 'HTTP 200 + status=error-token => fail-fast auth (envelope wins)' ((-not $badEnv.ok) -and $badEnv.phase -eq 'auth') ('phase=' + $badEnv.phase)
$noFields = ConvertFrom-F46UploadResponse -Text '{"status":"ok","data":{}}' -HttpStatus 200 -RetryAfterMs $null
Check 'status=ok with no id/code/downloadPage => parse failure (never a silent success)' ((-not $noFields.ok) -and $noFields.phase -eq 'parse') ('phase=' + $noFields.phase)
$rej = ConvertFrom-F46UploadResponse -Text '{"status":"ok","data":{}}' -HttpStatus 403 -RetryAfterMs $null -TransportMessage ''
Check '403 body => phase=auth, status kept' ((-not $rej.ok) -and $rej.phase -eq 'auth' -and [int]$rej.httpStatus -eq 403) ('phase=' + $rej.phase)

$tok = $null
try { $tok = New-F46GofileAccount -ApiRoot 'https://127.0.0.1:9' -TimeoutSec 1 } catch { $tok = @{ ok = $false; token = ''; message = ('transport failure surfaced: ' + $_.Exception.Message) } }
Check 'account creation fails closed with a reason (no token invented)' ((-not $tok.ok) -and ($tok.token -eq '')) ('ok=' + $tok.ok)

Write-Host '[F46] probe matrix (read-only)'
$probeRows = @(Invoke-F46HostProbe -Hosts @($hostOn) -Transport { param($h, $root) @{ status = 403; note = 'runner egress rejected (403) - policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion)' } })
Check 'probe mock returns one row per host' (@($probeRows).Count -eq 1 -and $probeRows[0].host -eq 'gofile' -and [string]$probeRows[0].status -eq '403') ('rows=' + @($probeRows).Count)
$probeTable = Format-F46ProbeTable -Rows $probeRows
Check 'probe table renders host + status + note' ($probeTable.Contains('gofile') -and $probeTable.Contains('403') -and $probeTable.Contains('policy/endpoint level rejection')) ($probeTable -replace "`n", ' | ')
$realProbe = @(Invoke-F46HostProbe -Hosts @((Get-F46DefaultHost)) -TimeoutSec 8)
Check 'real read-only probe returns a shaped row (no content upload)' (@($realProbe).Count -ge 1 -and $realProbe[0].host -eq 'gofile' -and $null -ne $realProbe[0].status) ('rows=' + @($realProbe).Count)
Write-Host ('  [INFO] real read-only probe: ' + (Format-F46ProbeTable -Rows $realProbe))

$policyTxt = ('failFast=' + (@($script:F46FailFastStatuses) -join ',') + ' transient=' + (@($script:F46TransientPhases) -join ',') + ' maxAttempts=' + [int]$script:F46MaxAttempts + ' retryAfterCapMs=' + [int]$script:F46RetryAfterCapMs)
Write-Host ('[F46] policy: ' + $policyTxt)

if ($script:failures -gt 0) {
    Write-Host ('::error::[F46] mirror policy lab failed: ' + $script:failures + ' check(s)')
    exit 1
}
Write-Host '[F46] mirror policy lab: ALL CHECKS PASS (mock transport, no content uploaded, probe read-only)'
exit 0
