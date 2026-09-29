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
        # Surface EVERY failure as a step annotation: the run-log blob host is
        # not reachable from the dev sandbox, and an annotation is how the
        # failing check name+detail survives without log access (F37 pattern).
        $ann = (('::error title=F46 check::' + $Name + ' :: ' + $Detail) -replace '[\r\n]+', ' ')
        Write-Host $ann
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
    param($HostCfg, $Path, $Name, $Size)
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
    return (Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -Transport $transport -EncryptRequested $EncryptRequested -Encrypted $Encrypted -Rand01 $Rand01 -Sleeper { param($ms) $script:sleptMs += @([int]$ms) })
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

$guestCase = Reset-Case @('success')
$resGuest = Invoke-F46MirrorAttempt -HostCfg $hostOn -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -AttemptNo 1 -Transport $transport
Check 'token-less guest attempt runs (no credential needed): ok=1 network=1 authMode=guest' (($resGuest.ok) -and ($script:networkCalls -eq 1) -and ([string]$resGuest.authMode -eq 'guest')) ('ok=' + $resGuest.ok + ' network=' + $script:networkCalls + ' authMode=' + $resGuest.authMode)

# reset the network counter so this cell asserts ITS OWN zero-try guarantee
# (the guest cell above legitimately consumed one mock call).
Reset-Case @('success') | Out-Null
$resEnc = Invoke-F46MirrorAttempt -HostCfg $hostOn -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -AttemptNo 1 -Transport $transport -EncryptRequested $true -Encrypted $false
Check 'encrypt requested but unavailable => phase=encrypt, refused (never claims encrypted)' (($resEnc.phase -eq 'encrypt') -and ($script:networkCalls -eq 0)) ('phase=' + $resEnc.phase)

$resPolicy = Invoke-F46MirrorAttempt -HostCfg $null -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -AttemptNo 1 -Transport $transport
Check 'no enabled host => phase=policy, 1 labeled attempt' ($resPolicy.phase -eq 'policy') ('phase=' + $resPolicy.phase)

Write-Host '[F49] runtime opt-in converge + gate (mock transport)'
$f49CfgA = '{"mirror":false}' | ConvertFrom-Json
Check '[F49] default config selects no host (policy gate holds)' ((Select-F46UploadHost -Hosts @(Get-F46Hosts -Cfg $f49CfgA)) -eq $null) 'a host was selected while disabled'
$f49CfgB = '{"mirror":false}' | ConvertFrom-Json
$f49Set = Set-F49RuntimeOptIn -Cfg $f49CfgB -At '2026-09-28T18:00:00Z'
$f49Sel = Select-F46UploadHost -Hosts @(Get-F46Hosts -Cfg $f49CfgB)
Check '[F49] opt-in flips mirror+host+marker and selects gofile' (([bool]$f49Set.changed) -and [bool]$f49CfgB.mirror -and [bool]$f49Sel -and ($f49Sel.id -eq 'gofile') -and ((Get-F49OptInStatus -Cfg $f49CfgB).source -eq 'runtime')) ('changed=' + $f49Set.changed)
Reset-Case @('success') | Out-Null
$f49Go = Invoke-F46MirrorAttempt -HostCfg $f49Sel -Path $filePath -Name 'f46-mock-payload.bin' -Size ([long]2048) -AttemptNo 1 -Transport $transport
Check '[F49] upload-after-enable reaches the (mock) transport as guest' (($f49Go.ok) -and ($script:networkCalls -eq 1) -and ([string]$f49Go.authMode -eq 'guest')) ('ok=' + $f49Go.ok + ' network=' + $script:networkCalls + ' authMode=' + $f49Go.authMode)
$f49Line = Format-F49OptInLedger -Marker (Get-F49RuntimeOptIn -Cfg $f49CfgB) -HostId 'gofile'
Check '[F49] ledger line carries the §3 needle + marker stamp' (($f49Line -match '^\[mirror\] RUNTIME OPT-IN: enabled=true scope=this-run source=runtime host=gofile at=2026-09-28T18:00:00Z') -and ($f49Line -match 'token-less guest')) ($f49Line)
$f49Clr = Clear-F49RuntimeOptIn -Cfg $f49CfgB
Check '[F49] disable reverts to default-off (no marker, no host)' (([bool]$f49Clr.changed) -and (-not [bool]$f49CfgB.mirror) -and ((Get-F49RuntimeOptIn -Cfg $f49CfgB) -eq $null) -and ((Select-F46UploadHost -Hosts @(Get-F46Hosts -Cfg $f49CfgB)) -eq $null)) 'revert incomplete'

Write-Host '[F46] documented gofile contract (pinned from https://gofile.io/api)'
$c = $script:F46GofileContract
Check 'contract: GET /servers -> probe + upload server' ($c.serversPath -eq '/servers') ('serversPath=' + $c.serversPath)
Check 'contract: multipart field name is file' ($c.multipartField -eq 'file') ('field=' + $c.multipartField)
Check 'contract [F48]: no auth scheme, no accounts rung (guest contract)' ((-not $c.Contains('authScheme')) -and (-not $c.Contains('accountsPath'))) ('keys=' + (@($c.Keys) -join ','))
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

# [F48 §2] the labeled auth reason: exact wording + operator options, appended
# to (never replacing) the host's own message.
$labeled = Format-F48AuthReason -Message 'HTTP 401: host said what it said END-OF-UNTRUNCATED-MESSAGE'
Check 'F48: auth reason is the exact labeled wording' ($labeled.StartsWith('host requires account token; token-less mode unsupported')) ($labeled.Substring(0, [Math]::Min(100, $labeled.Length)))
Check 'F48: auth reason renders the operator options' ($labeled.Contains('Operator options: (1) disable mirror (mirror_enable=false); (2) self-hosted operator target; (3) token mode - a separate future decision, out of scope here.')) ($labeled)
Check 'F48: auth reason keeps the host message untruncated after the label' ($labeled.EndsWith('END-OF-UNTRUNCATED-MESSAGE')) ('len=' + $labeled.Length)

Write-Host '[F46] probe matrix (read-only)'
$probeRows = @(Invoke-F46HostProbe -Hosts @($hostOn) -Transport { param($h, $root) @{ status = 403; note = 'runner egress rejected (403) - policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion)' } })
Check 'probe mock returns one row per host' (@($probeRows).Count -eq 1 -and $probeRows[0].host -eq 'gofile' -and [string]$probeRows[0].status -eq '403') ('rows=' + @($probeRows).Count)
$probeTable = Format-F46ProbeTable -Rows $probeRows
Check 'probe table renders host + status + note' ($probeTable.Contains('gofile') -and $probeTable.Contains('403') -and $probeTable.Contains('policy/endpoint level rejection')) ($probeTable -replace "`n", ' | ')
$realProbe = @(Invoke-F46HostProbe -Hosts @((Get-F46DefaultHost)) -TimeoutSec 8)
Check 'real read-only probe returns a shaped row (no content upload)' (@($realProbe).Count -ge 1 -and $realProbe[0].host -eq 'gofile' -and $null -ne $realProbe[0].status) ('rows=' + @($realProbe).Count)
Write-Host ('  [INFO] real read-only probe: ' + (Format-F46ProbeTable -Rows $realProbe))

Write-Host '[F48 §0/§2] token-less guest mode: config, labeled auth refusal, guest spec'
$cfgF48 = [pscustomobject]@{ mirrorHosts = @([pscustomobject]@{ id = 'gofile'; enabled = $true }) }
$hostsF48 = @(Get-F46Hosts -Cfg $cfgF48)
Check 'config mirrorHosts[].enabled=true is honoured by the selector' ((Select-F46UploadHost -Hosts $hostsF48) -ne $null) 'no host selected'
$hostsOff = @(Get-F46Hosts -Cfg ([pscustomobject]@{ mirrorHosts = @() }))
Check 'no mirrorHosts entry => shipped default stays enabled=false' ((Select-F46UploadHost -Hosts $hostsOff) -eq $null) 'a host was selected from an empty config'
$defHost48 = Get-F46DefaultHost
Check 'default host ships authMode=guest and no credential field' (($defHost48.authMode -eq 'guest') -and (-not $defHost48.Contains('tokenConfigKey'))) ('authMode=' + $defHost48.authMode)

# --- 401/403 => EXACTLY ONE attempt, labeled reason, authMode flip ----------
Reset-Case @('403', 'success') | Out-Null
$rAuth = Invoke-F46MirrorUploadWithPolicy -HostCfg $hostOn -Path $filePath -Name 'f48-auth.txt' -Size ([long]2048) -Transport $transport -Sleeper { param($ms) $script:sleptMs += @([int]$ms) }
Check 'F48 401/403 => exactly 1 attempt (no retry loop on auth)' ((@($rAuth.attempts).Count -eq 1) -and ($script:networkCalls -eq 1) -and ((@($script:sleptMs).Count) -eq 0)) ('attempts=' + @($rAuth.attempts).Count + ' network=' + $script:networkCalls + ' sleeps=' + (@($script:sleptMs).Count))
Check 'F48 401/403 => phase=auth + labeled reason + options' (($rAuth.phase -eq 'auth') -and ([string]$rAuth.hostMessage).StartsWith('host requires account token; token-less mode unsupported') -and ([string]$rAuth.hostMessage).Contains('Operator options:')) ('phase=' + $rAuth.phase + ' msg=' + ([string]$rAuth.hostMessage).Substring(0, [Math]::Min(90, ([string]$rAuth.hostMessage).Length)))
Check 'F48 401/403 => authMode flips to requires-account' ([string]$rAuth.authMode -eq 'requires-account') ('authMode=' + [string]$rAuth.authMode)

# --- request spec: the GUEST multipart contract, asserted without a network --
$specPlain = New-F46UploadRequestSpec -HostCfg $hostOn -Name 'f48-happy.txt' -Boundary '----ghrdpF48spec'
Check 'spec: multipart field name is file' ($specPlain.fieldName -eq 'file') ('field=' + $specPlain.fieldName)
Check 'spec [F48]: NO auth header keys at all (guest contract)' ((@($specPlain.headers.Keys) -notcontains 'Authorization') -and (@($specPlain.headers.Keys) -notcontains 'Cookie') -and (@($specPlain.headers.Keys) -notcontains 'X-Gofile-Token')) ('keys=' + (@($specPlain.headers.Keys) -join ','))
Check 'spec: request Content-Type is multipart/form-data with the boundary' (([string]$specPlain.requestContentType) -eq 'multipart/form-data; boundary=----ghrdpF48spec') ('ctype=' + $specPlain.requestContentType)
Check 'spec: plaintext part is application/octet-stream' ($specPlain.partContentType -eq 'application/octet-stream') ('part=' + $specPlain.partContentType)
Check 'spec: part header carries name="file" + filename' ((([string]$specPlain.partHeader) -match 'name="file"') -and (([string]$specPlain.partHeader) -match 'filename="f48-happy.txt"')) ('hdr=' + ([string]$specPlain.partHeader -replace "`r`n", ' | '))
$specEnc = New-F46UploadRequestSpec -HostCfg $hostOn -Name 'f48.txt.ghenc' -Boundary '----ghrdpF48spec' -ContentType ([string]$script:F46GofileContract.encryptedMime)
Check 'spec: encrypted part is application/x-ghrdp-mirror' ($specEnc.partContentType -eq 'application/x-ghrdp-mirror') ('part=' + $specEnc.partContentType)

# --- redaction: stray token= strings are grepped too ------------------------
$stray = Protect-F46SecretText -Text 'mirror debug: url token=abc123def456 and apikey=zzzz9999 end' -Secrets @()
Check 'redaction greps stray token= strings' ((-not $stray.Contains('abc123def456')) -and ($stray.Contains('***REDACTED***'))) ('out=' + $stray)

# --- AES-256: real ciphertext, 32-byte key, round trip, mime stamp ----------
$keyF47 = New-F46MirrorKey
Check 'per-run key is 32 bytes after base64 decode' (@([Convert]::FromBase64String($keyF47)).Length -eq 32) ('len=' + @([Convert]::FromBase64String($keyF47)).Length)
Check 'short key is refused, never stretched' ($null -eq (Get-F46MirrorKeyBytes -KeyBase64 ([Convert]::ToBase64String((New-Object byte[] 16))))) 'a 16-byte key was accepted'
$plainF47 = Join-Path $tmp 'f47-plain.txt'
[System.IO.File]::WriteAllText($plainF47, ('GHRDP-F47-PLAINTEXT-MARKER ' + ('benign mirror payload line. ' * 40)))
$ctF47 = Join-Path $tmp 'f47-plain.txt.ghenc'
$encF47 = Invoke-F46EncryptFile -Path $plainF47 -OutPath $ctF47 -KeyBase64 $keyF47
Check 'encrypt: ok with a named AES-256 algorithm' ([bool]$encF47.ok -and (([string]$encF47.alg) -match '^AES-256-(GCM|CBC-PBKDF2)$')) ('ok=' + $encF47.ok + ' alg=' + $encF47.alg + ' msg=' + $encF47.message)
$ctBytes = [System.IO.File]::ReadAllBytes($ctF47)
$ctText = [System.Text.Encoding]::ASCII.GetString($ctBytes)
Check 'encrypt: ciphertext differs from the plaintext (marker absent)' ((-not $ctText.Contains('GHRDP-F47-PLAINTEXT-MARKER')) -and ($ctBytes.Length -gt 0)) 'the plaintext marker survived encryption'
$decF47 = Invoke-F46DecryptFile -Path $ctF47 -OutPath (Join-Path $tmp 'f47-roundtrip.txt') -KeyBase64 $keyF47
$rtTxt = ''
try { $rtTxt = [System.IO.File]::ReadAllText((Join-Path $tmp 'f47-roundtrip.txt')) } catch { $rtTxt = '' }
Check 'encrypt: round trip returns the original bytes' ([bool]$decF47.ok -and $rtTxt.StartsWith('GHRDP-F47-PLAINTEXT-MARKER')) ('ok=' + $decF47.ok + ' msg=' + $decF47.message)
$wrongKey = New-F46MirrorKey
$badOut = Join-Path $tmp 'f47-wrongkey.txt'
try { if (Test-Path -LiteralPath $badOut) { Remove-Item -LiteralPath $badOut -Force } } catch { }
$decBad = Invoke-F46DecryptFile -Path $ctF47 -OutPath $badOut -KeyBase64 $wrongKey
$badTxt = ''
try { if (Test-Path -LiteralPath $badOut) { $badTxt = [System.IO.File]::ReadAllText($badOut) } } catch { $badTxt = '' }
# GCM authenticates; the CBC container relies on padding - so the check is that
# a wrong key never yields the ORIGINAL bytes (never a flaky padding verdict).
Check 'encrypt: a different key does not recover the plaintext (authenticated container)' (((-not [bool]$decBad.ok) -or (-not $badTxt.StartsWith('GHRDP-F47-PLAINTEXT-MARKER')))) ('ok=' + $decBad.ok + ' msg=' + $decBad.message)
$redacted = Protect-F46SecretText -Text ('attempt with key ' + $keyF47 + ' inside') -Secrets @($keyF47)
Check 'encrypt: the key is redacted from any log/artifact text' (-not $redacted.Contains($keyF47)) ('leaked: ' + $redacted)

# --- probe: a 403 egress row carries the operator-options wording ----------
$rows403 = @(Invoke-F46HostProbe -Hosts @($hostOn) -Transport { param($h, $root) @{ status = 403; note = 'runner egress rejected (403) - policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion)' } })
$noteTxt = [string]$rows403[0].note
Check 'probe 403 fixture names the operator options (VPS egress / accept)' (($noteTxt -match '403') -and ($noteTxt -match 'VPS egress')) ('note=' + $noteTxt)
Check 'probe 403 fixture offers no evasion' (-not ($noteTxt -match 'Mozilla|proxy|rotat|spoof')) ('note=' + $noteTxt)

# --- happy path over a REAL socket: the wire contract, end to end ----------
$listener = $null
$portF47 = 0
for ($i = 0; $i -lt 25 -and -not $listener; $i++) {
    $tryPort = 18460 + $i
    $l = New-Object System.Net.HttpListener
    try {
        $l.Prefixes.Add('http://127.0.0.1:' + $tryPort + '/')
        $l.Start()
        $listener = $l
        $portF47 = $tryPort
    } catch { try { $l.Close() } catch { } }
}
if (-not $listener) {
    Check 'happy path: a local listener could be started for the wire contract' $false 'no free port / listener refused'
} else {
    Write-Host ('[F47] local listener on http://127.0.0.1:' + $portF47 + '/uploadfile (contract only; no external host)')
    $hostLive = Get-F46DefaultHost
    $hostLive.enabled = $true
    $hostLive.uploadHostMode = 'auto'
    $hostLive.uploadHost = ('127.0.0.1:' + $portF47)
    $hostLive.uploadScheme = 'http'
    $clientJob = Start-Job -ScriptBlock {
        param($Mod, $Path, $Name, $Size, $Enc, $Key, $HostId, $Port, $Scheme)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = ('127.0.0.1:' + $Port)
        $h.uploadScheme = $Scheme
        $up = $Path
        $nm = $Name
        $ct = ''
        if ($Enc) {
            $enc = Invoke-F46EncryptFile -Path $Path -OutPath ($Path + '.ghenc') -KeyBase64 $Key
            if (-not $enc.ok) { return @{ ok = $false; phase = 'encrypt'; hostMessage = $enc.message; alg = '' } }
            $up = $Path + '.ghenc'
            $nm = $Name + '.ghenc'
            $ct = 'application/x-ghrdp-mirror'
        }
        $r = Invoke-F46MirrorAttempt -HostCfg $h -Path $up -Name $nm -Size $Size -AttemptNo 1 -ContentType $ct
        try { if ($Enc -and (Test-Path -LiteralPath ($Path + '.ghenc'))) { Remove-Item -LiteralPath ($Path + '.ghenc') -Force } } catch { }
        return @{ ok = [bool]$r.ok; phase = [string]$r.phase; fileId = [string]$r.fileId; downloadPage = [string]$r.downloadPage; link = [string]$r.directUrl; msg = [string]$r.hostMessage }
    } -ArgumentList $modPath, $plainF47, 'f47-happy.txt', ([long](Get-Item -LiteralPath $plainF47).Length), $false, '', 'gofile', $portF47, 'http'
    $wire = $null
    try {
        $ctx = $listener.GetContext()
        $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream)
        $bodyTxt = $sr.ReadToEnd()
        $sr.Close()
        $wire = [ordered]@{ method = $ctx.Request.HttpMethod; path = $ctx.Request.Url.AbsolutePath; auth = [string]$ctx.Request.Headers['Authorization']; cookie = [string]$ctx.Request.Headers['Cookie']; hostTokHdr = [string]$ctx.Request.Headers['X-Gofile-Token']; ctype = [string]$ctx.Request.ContentType; body = $bodyTxt }
        $respTxt = '{"status":"ok","data":{"id":"f47-wire-id","downloadPage":"https://gofile.test/d/f47wire","code":"f47wirecode"}}'
        $rb = [System.Text.Encoding]::UTF8.GetBytes($respTxt)
        $ctx.Response.StatusCode = 200
        $ctx.Response.ContentType = 'application/json'
        $ctx.Response.ContentLength64 = $rb.Length
        $ctx.Response.OutputStream.Write($rb, 0, $rb.Length)
        $ctx.Response.Close()
    } catch { Write-Host ('[F47] listener context failed: ' + $_.Exception.Message) }
    $client = $null
    try { if (Wait-Job -Job $clientJob -Timeout 60) { $client = Receive-Job -Job $clientJob } } catch { $client = $null }
    try { Remove-Job -Job $clientJob -Force -ErrorAction SilentlyContinue } catch { }
    Check 'happy path: the request is a POST to /uploadfile' ($wire -and $wire.method -eq 'POST' -and $wire.path -eq '/uploadfile') ('req=' + $(if ($wire) { $wire.method + ' ' + $wire.path } else { 'none' }))
    Check 'happy path [F48]: NO Authorization header on the wire (token-less guest)' ($wire -and ([string]$wire.auth -eq '')) ('auth=' + $(if ($wire) { '[' + $wire.auth + ']' } else { 'none' }))
    Check 'happy path [F48]: NO Cookie and NO X-Gofile-Token header on the wire' ($wire -and ([string]$wire.cookie -eq '') -and ([string]$wire.hostTokHdr -eq '')) ('cookie=[' + $(if ($wire) { $wire.cookie } else { '' }) + '] hostTok=[' + $(if ($wire) { $wire.hostTokHdr } else { '' }) + ']')
    Check 'happy path: no credential parameter in the URL' ($wire -and (-not ($wire.path -match 'token='))) ('path=' + $(if ($wire) { $wire.path } else { 'none' }))
    Check 'happy path: multipart body declares the field name file' ($wire -and ($wire.body -match 'name="file"')) 'field name missing'
    Check 'happy path: plaintext part is application/octet-stream' ($wire -and ($wire.body -match 'Content-Type: application/octet-stream')) 'part mime missing'
    Check 'happy path: id + downloadPage parse into a success row with a link' ($client -and [bool]$client.ok -and $client.fileId -eq 'f47-wire-id' -and $client.link -eq 'https://gofile.test/d/f47wire') ('client=' + ($client | ConvertTo-Json -Compress -Depth 3))
    # encrypted pass over the same socket
    $clientJob2 = Start-Job -ScriptBlock {
        param($Mod, $Path, $Name, $Size, $Key, $Port)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = ('127.0.0.1:' + $Port)
        $h.uploadScheme = 'http'
        $enc = Invoke-F46EncryptFile -Path $Path -OutPath ($Path + '.ghenc') -KeyBase64 $Key
        if (-not $enc.ok) { return @{ ok = $false; phase = 'encrypt'; alg = ''; msg = $enc.message } }
        $r = Invoke-F46MirrorAttempt -HostCfg $h -Path ($Path + '.ghenc') -Name ($Name + '.ghenc') -Size ([long]$enc.bytes) -AttemptNo 1 -ContentType 'application/x-ghrdp-mirror'
        try { Remove-Item -LiteralPath ($Path + '.ghenc') -Force -ErrorAction SilentlyContinue } catch { }
        return @{ ok = [bool]$r.ok; alg = [string]$enc.alg; link = [string]$r.directUrl }
    } -ArgumentList $modPath, $plainF47, 'f47-happy.txt', ([long](Get-Item -LiteralPath $plainF47).Length), $keyF47, $portF47
    $wire2 = $null
    try {
        $ctx2 = $listener.GetContext()
        $ms = New-Object System.IO.MemoryStream
        $ctx2.Request.InputStream.CopyTo($ms)
        $bodyBytes = $ms.ToArray()
        $ms.Dispose()
        $wire2 = [ordered]@{ ctype = [string]$ctx2.Request.ContentType; bodyText = [System.Text.Encoding]::ASCII.GetString($bodyBytes); bytes = $bodyBytes }
        $respTxt2 = '{"status":"ok","data":{"id":"f47-enc-id","downloadPage":"https://gofile.test/d/f47enc","code":"f47enccode"}}'
        $rb2 = [System.Text.Encoding]::UTF8.GetBytes($respTxt2)
        $ctx2.Response.StatusCode = 200
        $ctx2.Response.ContentType = 'application/json'
        $ctx2.Response.ContentLength64 = $rb2.Length
        $ctx2.Response.OutputStream.Write($rb2, 0, $rb2.Length)
        $ctx2.Response.Close()
    } catch { Write-Host ('[F47] listener context (encrypted) failed: ' + $_.Exception.Message) }
    $client2 = $null
    try { if (Wait-Job -Job $clientJob2 -Timeout 60) { $client2 = Receive-Job -Job $clientJob2 } } catch { $client2 = $null }
    try { Remove-Job -Job $clientJob2 -Force -ErrorAction SilentlyContinue } catch { }
    Check 'encrypt-on: the uploaded part is stamped application/x-ghrdp-mirror' ($wire2 -and ($wire2.bodyText -match 'Content-Type: application/x-ghrdp-mirror')) ('part=' + $(if ($wire2) { 'missing' } else { 'no request' }))
    Check 'encrypt-on: the uploaded bytes are ciphertext (no plaintext marker on the wire)' ($wire2 -and (-not ($wire2.bodyText.Contains('GHRDP-F47-PLAINTEXT-MARKER')))) 'plaintext reached the host'
    Check 'encrypt-on: the attempt succeeds and reports the algorithm used' ($client2 -and [bool]$client2.ok -and ($client2.alg -match '^AES-256-')) ('client=' + ($client2 | ConvertTo-Json -Compress -Depth 3))
    try { $listener.Stop(); $listener.Close() } catch { }
}
Write-Host ('[F47] AES-256 mode on this runner: ' + $(if (Test-F46AesGcmUsable) { 'AES-256-GCM (System.Security.Cryptography.AesGcm)' } else { 'AES-256-CBC-PBKDF2 (legacy .ghenc container, browser-decryptable)' }))

$policyTxt = ('failFast=' + (@($script:F46FailFastStatuses) -join ',') + ' transient=' + (@($script:F46TransientPhases) -join ',') + ' maxAttempts=' + [int]$script:F46MaxAttempts + ' retryAfterCapMs=' + [int]$script:F46RetryAfterCapMs)
Write-Host ('[F46] policy: ' + $policyTxt)

# ---------------------------------------------------------------------------
# [F50 §1] STREAMING TRANSPORT: the upload path is HttpClient +
# MultipartFormDataContent + StreamContent(FileStream); no whole-file byte
# array and no buffering request stream exist in it (the .NET 2GB in-box
# request buffer was the "Stream was too long" failure).
# ---------------------------------------------------------------------------
Write-Host '[F50 §1] transport rewrite: streamed upload path (no whole-file buffering)'
$moduleText = Get-Content -LiteralPath $modPath -Raw
$fnStart = $moduleText.IndexOf('function Send-F46GofileUpload')
$fnEnd = $moduleText.IndexOf('function ConvertFrom-F46UploadResponse', [Math]::Max($fnStart, 0))
$fnBody = ''
if ($fnStart -ge 0 -and $fnEnd -gt $fnStart) { $fnBody = $moduleText.Substring($fnStart, $fnEnd - $fnStart) }
Check 'F50: the uploader exists to be rewritten' ($fnStart -ge 0 -and $fnEnd -gt $fnStart) 'Send-F46GofileUpload not found'
Check 'F50: transport is HttpClient' ($fnBody -match 'System\.Net\.Http\.HttpClient') 'no HttpClient in the upload path'
Check 'F50: body is a MultipartFormDataContent' ($fnBody -match 'MultipartFormDataContent') 'no MultipartFormDataContent in the upload path'
Check 'F50: the file part is StreamContent over a FileStream' (($fnBody -match 'System\.Net\.Http\.StreamContent') -and ($fnBody -match 'System\.IO\.File\]::Open\(')) 'no StreamContent(FileStream) in the upload path'
Check 'F50: NO whole-file byte array (no ReadAllBytes in the upload path)' ($fnBody -notmatch 'ReadAllBytes') 'ReadAllBytes appeared in the upload path'
Check 'F50: NO MemoryStream in the upload path' ($fnBody -notmatch 'MemoryStream') 'MemoryStream appeared in the upload path'
Check 'F50: F44 fail-fast statuses untouched' ((@($script:F46FailFastStatuses) -join ',') -eq '401,403,413,415') ('failFast=' + (@($script:F46FailFastStatuses) -join ','))
Check 'F50: F44 Retry-After cap stays 120s' ([int]$script:F46RetryAfterCapMs -eq 120000) ('cap=' + [int]$script:F46RetryAfterCapMs)
Check 'F50: F44 attempt budget stays 5' ([int]$script:F46MaxAttempts -eq 5) ('max=' + [int]$script:F46MaxAttempts)

# ---------------------------------------------------------------------------
# [F50 §2] LARGE-FILE STREAMING MATRIX: sparse files (fsutil file createnew)
# of 100MB / 1GB / 3GB / 6GB streamed by the SHIPPED uploader into a
# discarding loopback listener. The listener counts (never stores) the body
# bytes; a pass proves the request completed above the old 2GB ceiling with
# bounded memory on the client side (StreamContent streams the FileStream).
# ---------------------------------------------------------------------------
Write-Host '[F50 §2] sparse-file streaming matrix: 100MB / 1GB / 3GB / 6GB -> discarding loopback listener'
$f50Listener = $null
$f50Port = 0
for ($p50 = 47210; $p50 -le 47290; $p50++) {
    try {
        $l50 = New-Object System.Net.HttpListener
        $l50.Prefixes.Add('http://127.0.0.1:' + $p50 + '/uploadfile/')
        $l50.Start()
        $f50Listener = $l50
        $f50Port = $p50
        break
    } catch { try { if ($l50) { $l50.Close() } } catch { } }
}
if (-not $f50Listener) {
    Check 'F50: a discarding loopback listener could be started' $false 'no free port / listener refused'
} else {
    Write-Host ('[F50] discarding listener on http://127.0.0.1:' + $f50Port + '/uploadfile/ (body bytes counted, never stored)')
    foreach ($case in @(@('100MB', 100MB, 150), @('1GB', 1GB, 240), @('3GB', 3GB, 360), @('6GB', 6GB, 600))) {
        $caseName = [string]$case[0]
        $caseSize = [long]$case[1]
        $caseTmo = [int]$case[2]
        $sparse = Join-Path $tmp ('f50-sparse-' + $caseName + '.bin')
        $fsutilOut = ''
        try { $fsutilOut = (& fsutil file createnew $sparse $caseSize 2>&1 | Out-String).Trim() } catch { $fsutilOut = $_.Exception.Message }
        if (-not (Test-Path -LiteralPath $sparse)) {
            Check ('F50 ' + $caseName + ': the sparse file was created (fsutil)') $false $fsutilOut
            continue
        }
        $onDisk = [long](Get-Item -LiteralPath $sparse).Length
        Check ('F50 ' + $caseName + ': fsutil allocated ' + $caseSize + ' bytes sparse') ($onDisk -eq $caseSize) ('onDisk=' + $onDisk)
        $job50 = Start-Job -ScriptBlock {
            param($Mod, $Sparse, $Size, $Tmo, $Port)
            $ErrorActionPreference = 'Stop'
            . $Mod
            $h = Get-F46DefaultHost
            $h.enabled = $true
            $h.uploadHostMode = 'auto'
            $h.uploadHost = ('127.0.0.1:' + $Port)
            $h.uploadScheme = 'http'
            $h.timeoutSec = $Tmo
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $r = Send-F46GofileUpload -HostCfg $h -Path $Sparse -Name ('f50-' + $Size + '.bin') -TimeoutSec $Tmo
            $sw.Stop()
            return @{ ok = [bool]$r.ok; phase = [string]$r.phase; httpStatus = $r.httpStatus; msg = [string]$r.hostMessage; fileId = [string]$r.fileId; ms = [int]$sw.ElapsedMilliseconds }
        } -ArgumentList $modPath, $sparse, $caseSize, $caseTmo, $f50Port
        $got = [long]0
        $resp50 = $null
        try {
            $ctx50 = $f50Listener.GetContext()
            $in50 = $ctx50.Request.InputStream
            $buf50 = New-Object byte[] 1048576
            $n50 = 0
            while (($n50 = $in50.Read($buf50, 0, $buf50.Length)) -gt 0) { $got = $got + [long]$n50 }
            $in50.Close()
            $rb50 = [System.Text.Encoding]::UTF8.GetBytes('{"status":"ok","data":{"id":"f50-' + $caseName + '-id","downloadPage":"https://gofile.test/d/f50' + $caseName + '","code":"f50' + $caseName + '"}}')
            $resp50 = $ctx50.Response
            $resp50.StatusCode = 200
            $resp50.ContentType = 'application/json'
            $resp50.ContentLength64 = $rb50.Length
            $resp50.OutputStream.Write($rb50, 0, $rb50.Length)
            $resp50.Close()
        } catch { Write-Host ('[F50] listener context failed (' + $caseName + '): ' + $_.Exception.Message) }
        $client50 = $null
        try { if (Wait-Job -Job $job50 -Timeout $caseTmo) { $client50 = Receive-Job -Job $job50 } } catch { $client50 = $null }
        try { Remove-Job -Job $job50 -Force -ErrorAction SilentlyContinue } catch { }
        $over = $got - $caseSize
        Check ('F50 ' + $caseName + ': the full body reached the wire (' + $caseSize + ' bytes streamed, multipart overhead < 1KB)') (($got -ge $caseSize) -and ($over -ge 0) -and ($over -lt 1024)) ('got=' + $got + ' overhead=' + $over)
        Check ('F50 ' + $caseName + ': the shipped uploader streamed it end-to-end (ok, id parsed)') ($client50 -and [bool]$client50.ok -and ($client50.fileId -eq ('f50-' + $caseName + '-id'))) ('r=' + $(if ($client50) { ($client50 | ConvertTo-Json -Compress -Depth 3) } else { 'no result' }))
        $mbps = 0
        if ($client50 -and [int]$client50.ms -gt 0) { $mbps = [int][math]::Round(($caseSize / 1MB) / ([int]$client50.ms / 1000.0)) }
        Write-Host ('  [F50] ' + $caseName + ': ' + $got + ' bytes on the wire in ' + $(if ($client50) { [int]$client50.ms } else { -1 }) + ' ms (~' + $mbps + ' MB/s), memory bounded by the 1MB client chunk loop + StreamContent')
        try { Remove-Item -LiteralPath $sparse -Force -ErrorAction SilentlyContinue } catch { }
    }
    try { $f50Listener.Stop(); $f50Listener.Close() } catch { }
}

# ---------------------------------------------------------------------------
# [F50 §3] RETRY PATHS ON THE REAL TRANSPORT: the F44 policy still governs the
# HttpClient path - 429 (Retry-After floor), 500, 502 retry to the budget,
# a refused connection is a labeled transient, and preflight refusals still
# cost ZERO network tries. TLS reset stays covered by the mock scenario above
# (a loopback runner cannot fabricate a live TLS reset).
# ---------------------------------------------------------------------------
Write-Host '[F50 §3] real-transport retry paths: 429 (Retry-After), 500, 502, refused-tcp, preflight network=0'
# [F50 §3] each scenario gets its OWN listener + port so a timed-out job from a
# previous scenario cannot desync the scripted responses; the 200 step answers
# with a real status=ok envelope so the policy loop terminates exactly at the
# scripted attempt count.
function New-ScriptedListener {
    for ($p53 = 47310; $p53 -le 47390; $p53++) {
        try {
            $l53 = New-Object System.Net.HttpListener
            $l53.Prefixes.Add('http://127.0.0.1:' + $p53 + '/uploadfile/')
            $l53.Start()
            return @{ listener = $l53; port = $p53 }
        } catch { try { if ($l53) { $l53.Close() } } catch { } }
    }
    return $null
}
function Serve-Scripted {
    # Serves ONE scripted response: @('<httpCode>', '<retryAfterSeconds>').
    param($Listener, $Step)
    $ctx53 = $Listener.GetContext()
    try {
        $in53 = $ctx53.Request.InputStream
        $buf53 = New-Object byte[] 65536
        while (($in53.Read($buf53, 0, $buf53.Length)) -gt 0) { }
        $in53.Close()
        $code53 = [int]$Step[0]
        if ($code53 -eq 200) { $body53 = '{"status":"ok","data":{"id":"f50-scripted-id","downloadPage":"https://gofile.test/d/f50scripted","code":"f50scripted"}}' }
        else { $body53 = '{"status":"error-cannot-store-' + $code53 + '"}' }
        $rb53 = [System.Text.Encoding]::UTF8.GetBytes($body53)
        $r53 = $ctx53.Response
        $r53.StatusCode = $code53
        $r53.ContentType = 'application/json'
        $r53.ContentLength64 = $rb53.Length
        if ([string]$Step[1]) { try { $r53.AddHeader('Retry-After', [string]$Step[1]) } catch { } }
        $r53.OutputStream.Write($rb53, 0, $rb53.Length)
        $r53.Close()
        return $true
    } catch { return $false }
}
foreach ($rcase in @(
    @('429-then-success', @(@('429', '1'), @('200', '')), 2, $true, 1000),
    @('500-500-then-success', @(@('500', ''), @('500', ''), @('200', '')), 3, $true, 0),
    @('502-budget', @(@('502', ''), @('502', ''), @('502', ''), @('502', ''), @('502', '')), 5, $false, 0)
)) {
    $rname = [string]$rcase[0]
    $script50 = @($rcase[1])
    $wantTries = [int]$rcase[2]
    $wantOk = [bool]$rcase[3]
    $minFirstSleep = [int]$rcase[4]
    $pair53 = New-ScriptedListener
    if (-not $pair53) {
        Check ('F50 ' + $rname + ': a scripted listener could be started') $false 'no free port / listener refused'
        continue
    }
    $job54 = Start-Job -ScriptBlock {
        param($Mod, $Payload, $Port, $Name)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = ('127.0.0.1:' + $Port)
        $h.uploadScheme = 'http'
        $h.timeoutSec = 15
        $slept = New-Object System.Collections.ArrayList
        $r = Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path $Payload -Name $Name -Size ([long](Get-Item -LiteralPath $Payload).Length) -Sleeper { param($ms) [void]$slept.Add([int]$ms); Start-Sleep -Milliseconds ([Math]::Min([int]$ms, 1200)) } -Rand01 0
        return @{ ok = [bool]$r.ok; phase = [string]$r.phase; tries = @($r.attempts).Count; httpStatuses = @(@($r.attempts) | ForEach-Object { [string]$_.status }); slept = @($slept) }
    } -ArgumentList $modPath, $filePath, $pair53.port, ('f50-' + $rname + '.bin')
    $served = 0
    foreach ($step53 in $script50) {
        if (Serve-Scripted -Listener $pair53.listener -Step $step53) { $served = $served + 1 } else { break }
    }
    $client54 = $null
    try { if (Wait-Job -Job $job54 -Timeout 120) { $client54 = Receive-Job -Job $job54 } } catch { $client54 = $null }
    try { Remove-Job -Job $job54 -Force -ErrorAction SilentlyContinue } catch { }
    try { $pair53.listener.Stop(); $pair53.listener.Close() } catch { }
    Check ('F50 ' + $rname + ': ' + $wantTries + ' attempt(s) under the policy, ok=' + $wantOk) ($client54 -and ([int]$client54.tries -eq $wantTries) -and ([bool]$client54.ok -eq $wantOk)) ('r=' + $(if ($client54) { ($client54 | ConvertTo-Json -Compress -Depth 3) } else { 'no result' }))
    if ($minFirstSleep -gt 0 -and $client54) {
        $firstSleep = 0
        if (@($client54.slept).Count -gt 0) { $firstSleep = [int]@($client54.slept)[0] }
        Check ('F50 ' + $rname + ': the Retry-After hint stayed a FLOOR for the first backoff') ($firstSleep -ge $minFirstSleep) ('firstSleepMs=' + $firstSleep)
    }
}
# refused connection: a REAL transport failure classified by the new
# HttpClient catch ladder (tcp) and retried to the transient budget.
$refusedPort = 0
for ($rp = 47410; $rp -le 47490; $rp++) {
    $inUse = $false
    try { $t = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $rp); $t.Start(); $t.Stop() } catch { $inUse = $true }
    if (-not $inUse) { $refusedPort = $rp; break }
}
if ($refusedPort -le 0) {
    Check 'F50 refused-tcp: a free port could be found' $false 'no free port'
} else {
    $job55 = Start-Job -ScriptBlock {
        param($Mod, $Payload, $Port)
        $ErrorActionPreference = 'Stop'
        . $Mod
        $h = Get-F46DefaultHost
        $h.enabled = $true
        $h.uploadHostMode = 'auto'
        $h.uploadHost = ('127.0.0.1:' + $Port)
        $h.uploadScheme = 'http'
        $h.timeoutSec = 10
        $r = Invoke-F46MirrorUploadWithPolicy -HostCfg $h -Path $Payload -Name 'f50-refused.bin' -Size ([long](Get-Item -LiteralPath $Payload).Length) -Sleeper { param($ms) } -Rand01 0
        return @{ ok = [bool]$r.ok; phase = [string]$r.phase; tries = @($r.attempts).Count; firstPhase = [string](@($r.attempts)[0].phase) }
    } -ArgumentList $modPath, $filePath, $refusedPort
    $client55 = $null
    try { if (Wait-Job -Job $job55 -Timeout 120) { $client55 = Receive-Job -Job $job55 } } catch { $client55 = $null }
    try { Remove-Job -Job $job55 -Force -ErrorAction SilentlyContinue } catch { }
    Check 'F50 refused-tcp: labeled transient phase (tcp|http) retried to the 5-attempt budget' ($client55 -and (-not [bool]$client55.ok) -and ([int]$client55.tries -eq 5) -and (@('tcp', 'http') -contains [string]$client55.firstPhase)) ('r=' + $(if ($client55) { ($client55 | ConvertTo-Json -Compress -Depth 3) } else { 'no result' }))
}
# preflight refusals keep ZERO network tries even on the real transport: the
# spy transport would fail the cell the moment a single byte left the machine.
Write-Host '[F50 §4] preflight refusal cells (size/type) with network=0'
$script:spyCalls = 0
$spy = { param($HostCfg, $Path, $Name, $Size) $script:spyCalls = $script:spyCalls + 1; return @{ ok = $false; phase = 'http'; httpStatus = 599; hostMessage = 'SPY MUST NEVER RUN FOR A PREFLIGHT REFUSAL' } }
$hostPre = Get-F46DefaultHost
$hostPre.enabled = $true
$hostPre.maxFileBytes = 1024
$preSize = Invoke-F46MirrorAttempt -HostCfg $hostPre -Path $filePath -Name 'f50-preflight.bin' -Size ([long]2048) -AttemptNo 1 -Transport $spy
Check 'F50 preflight size refusal: phase=size with ZERO network tries' (($preSize.phase -eq 'size') -and ($script:spyCalls -eq 0)) ('phase=' + $preSize.phase + ' spyCalls=' + $script:spyCalls)
$hostPre2 = Get-F46DefaultHost
$hostPre2.enabled = $true
$hostPre2.blockedExtensions = @('.bin')
$preType = Invoke-F46MirrorAttempt -HostCfg $hostPre2 -Path $filePath -Name 'f50-preflight.bin' -Size ([long]2048) -AttemptNo 1 -Transport $spy
Check 'F50 preflight type refusal: phase=type with ZERO network tries' (($preType.phase -eq 'type') -and ($script:spyCalls -eq 0)) ('phase=' + $preType.phase + ' spyCalls=' + $script:spyCalls)

# ---------------------------------------------------------------------------
# [F51] ALWAYS-ON DOWNLOADS AUTO-UPLOAD: the real watcher helpers are
# extracted from the shipped source and executed - a file that lands in the
# Downloads root is queued WITHOUT any opt-in, while Desktop / Documents /
# Temp / RDP-Storage stay gated; the in-memory host override never touches
# config.json and the F49 modal contract for other roots is untouched.
# ---------------------------------------------------------------------------
Write-Host '[F51 §1] real watcher helpers: Downloads auto-classification (extracted, then executed)'
$watcherPath = Join-Path $root 'payloads\ghrdp-watcher.ps1'
if (-not (Test-Path -LiteralPath $watcherPath)) { $watcherPath = Join-Path $root 'payloads/ghrdp-watcher.ps1' }
$wAst = $null
$wParseErr = $null
$wAst = [System.Management.Automation.Language.Parser]::ParseFile($watcherPath, [ref]$null, [ref]$wParseErr)
Check 'F51: the watcher parses clean before extraction' ($null -eq $wParseErr -or @($wParseErr).Count -eq 0) (($wParseErr | ForEach-Object { $_.Message }) -join ' | ')
function Get-WatcherFn([string]$Name51) {
    $fn = $wAst.Find({ param($a) ($a -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($a.Name -eq $Name51) }, $true)
    if (-not $fn) { throw ('watcher function missing: ' + $Name51) }
    return $fn.Extent.Text
}
foreach ($fn51 in @('Test-F51DownloadsRoot', 'Get-F51AutoUploadRoots', 'Test-F51AutoUploadPath', 'Split-F51AutoQueue', 'New-F51AutoHost')) {
    . ([scriptblock]::Create((Get-WatcherFn $fn51)))
}
$f51tmp = Join-Path $tmp ('f51-lab-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
foreach ($d51 in @('profile\Downloads', 'profile\Downloads\qBittorrent', 'profile\Desktop', 'profile\Documents', 'profile\AppData\Local\Temp', 'storage\RDP-Storage')) {
    try { New-Item -ItemType Directory -Path (Join-Path $f51tmp $d51) -Force -ErrorAction Stop | Out-Null } catch { }
}
foreach ($n51 in @('profile\Downloads\invoice.pdf', 'profile\Downloads\qBittorrent\ubuntu.iso', 'profile\Desktop\note.txt', 'profile\Documents\report.docx', 'profile\AppData\Local\Temp\junk.tmp', 'storage\RDP-Storage\archive.zip')) {
    try { [System.IO.File]::WriteAllText((Join-Path $f51tmp $n51), 'f51-lab') } catch { }
}
$f51roots = @((Join-Path $f51tmp 'profile\Downloads'), (Join-Path $f51tmp 'profile\Desktop'), (Join-Path $f51tmp 'profile\Documents'), (Join-Path $f51tmp 'profile\AppData\Local\Temp'), (Join-Path $f51tmp 'storage\RDP-Storage'))
$f51autos = @(Get-F51AutoUploadRoots -Roots ([string[]]$f51roots))
Check 'F51: exactly the Downloads root is auto-upload' ((@($f51autos).Count -eq 1) -and ($f51autos[0] -like '*Downloads')) ('autos=' + (@($f51autos) -join ' | '))
Check 'F51: Desktop/Documents/Temp/RDP-Storage are NOT auto-upload roots' ((Test-F51DownloadsRoot -RootPath (Join-Path $f51tmp 'profile\Desktop')) -eq $false -and (Test-F51DownloadsRoot -RootPath (Join-Path $f51tmp 'profile\Documents')) -eq $false -and (Test-F51DownloadsRoot -RootPath (Join-Path $f51tmp 'profile\AppData\Local\Temp')) -eq $false -and (Test-F51DownloadsRoot -RootPath (Join-Path $f51tmp 'storage\RDP-Storage')) -eq $false) 'a gated root was classified as Downloads'
$f51queue = New-Object System.Collections.ArrayList
foreach ($n51 in @('profile\Downloads\invoice.pdf', 'profile\Downloads\qBittorrent\ubuntu.iso', 'profile\Desktop\note.txt', 'profile\Documents\report.docx', 'profile\AppData\Local\Temp\junk.tmp', 'storage\RDP-Storage\archive.zip')) {
    [void]$f51queue.Add((Get-Item -LiteralPath (Join-Path $f51tmp $n51)))
}
$f51split = Split-F51AutoQueue -Queue $f51queue -AutoRoots $f51autos
Check 'F51: Downloads files (incl. Downloads\qBittorrent) partition to AUTO without opt-in' ((@($f51split.auto).Count -eq 2) -and (@($f51split.auto | ForEach-Object { $_.Name }) -contains 'invoice.pdf') -and (@($f51split.auto | ForEach-Object { $_.Name }) -contains 'ubuntu.iso')) ('auto=' + (@($f51split.auto | ForEach-Object { $_.Name }) -join ','))
Check 'F51: Desktop/Documents/Temp/RDP-Storage files stay GATED behind opt-in' ((@($f51split.gated).Count -eq 4) -and (@($f51split.gated | ForEach-Object { $_.Name }) -contains 'note.txt') -and (@($f51split.gated | ForEach-Object { $_.Name }) -contains 'archive.zip')) ('gated=' + (@($f51split.gated | ForEach-Object { $_.Name }) -join ','))
$fn51Host = Get-WatcherFn 'New-F51AutoHost'
Check 'F51: the override host is in-memory only (no flag file, no config write inside the helper)' ((Get-WatcherFn 'New-F51AutoHost') -notmatch 'mirror-enable\.flag|mirror-disable\.flag|Save-MirrorCfg') 'the helper touches flags or config.json'
$autoHost51 = New-F51AutoHost
Check 'F51: the override host is the gofile GUEST contract, enabled for this run' (($autoHost51.id -eq 'gofile') -and ([bool]$autoHost51.enabled) -and ([string]$autoHost51.authMode -eq 'guest')) ('id=' + $autoHost51.id + ' enabled=' + $autoHost51.enabled + ' authMode=' + $autoHost51.authMode)
Check 'F51: the override host carries no credential field (F48)' (-not ($autoHost51.Contains('tokenConfigKey')) -and -not ($autoHost51.Contains('gofileToken'))) 'a credential field appeared'
Write-Host '[F51 §2] trigger simulation: a new download into Downloads auto-queues (mirror stays false, no opt-in state)'
$cfgF51 = '{"mirror":false}' | ConvertFrom-Json
Check 'F51: precondition - NO opt-in exists (mirror=false, no host enabled)' ((Select-F46UploadHost -Hosts @(Get-F46Hosts -Cfg $cfgF51)) -eq $null) 'a host was enabled without opt-in'
$dlFile51 = Get-Item -LiteralPath (Join-Path $f51tmp 'profile\Downloads\invoice.pdf')
$sim51 = Split-F51AutoQueue -Queue (New-Object System.Collections.ArrayList @(, $dlFile51)) -AutoRoots $f51autos
Check 'F51: the new download lands in the AUTO queue by itself' ((@($sim51.auto).Count -eq 1) -and (@($sim51.gated).Count -eq 0)) ('auto=' + @($sim51.auto).Count + ' gated=' + @($sim51.gated).Count)
Reset-Case @('success') | Out-Null
$go51 = Invoke-F46MirrorAttempt -HostCfg (New-F51AutoHost) -Path $dlFile51.FullName -Name $dlFile51.Name -Size ([long]$dlFile51.Length) -AttemptNo 1 -Transport $transport
Check 'F51: the auto queue attempts WITHOUT opt-in and succeeds as guest' (($go51.ok) -and ($script:networkCalls -eq 1) -and ([string]$go51.authMode -eq 'guest')) ('ok=' + $go51.ok + ' network=' + $script:networkCalls + ' authMode=' + $go51.authMode)
$no51 = Invoke-F46MirrorAttempt -HostCfg (Select-F46UploadHost -Hosts @(Get-F46Hosts -Cfg $cfgF51)) -Path $dlFile51.FullName -Name $dlFile51.Name -Size ([long]$dlFile51.Length) -AttemptNo 1 -Transport $transport
Check 'F51: WITHOUT the override the same file is a labeled policy refusal (proves the trigger is F51)' ($no51.phase -eq 'policy') ('phase=' + $no51.phase)
$autoCap51 = New-F51AutoHost
$autoCap51.maxFileBytes = 1024
$autoPre51 = Invoke-F46MirrorAttempt -HostCfg $autoCap51 -Path $filePath -Name 'f50-preflight.bin' -Size ([long]2048) -AttemptNo 1 -Transport $spy
Check 'F51: the override does NOT bypass per-host preflight (size cap => phase=size, network=0)' (($autoPre51.phase -eq 'size') -and ($script:spyCalls -eq 0)) ('phase=' + $autoPre51.phase + ' spyCalls=' + $script:spyCalls)
$gated51 = Get-Item -LiteralPath (Join-Path $f51tmp 'profile\Desktop\note.txt')
$sim52 = Split-F51AutoQueue -Queue (New-Object System.Collections.ArrayList @(, $gated51)) -AutoRoots $f51autos
Check 'F51: a Desktop file does NOT auto-queue (F49 opt-in modal still governs it)' ((@($sim52.auto).Count -eq 0) -and (@($sim52.gated).Count -eq 1)) ('auto=' + @($sim52.auto).Count + ' gated=' + @($sim52.gated).Count)
try { Remove-Item -LiteralPath $f51tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
Write-Host '[F51 §3] watcher wiring: the scan loop consumes the split, the override and the ledger lines'
$watcherText = Get-Content -LiteralPath $watcherPath -Raw
Check 'F51: the upload loop gates on the partitioned upload queue' ($watcherText -match '\$uploadQueue = @\(\$queue\)') 'no $uploadQueue wiring'
Check 'F51: mirror=false keeps ONLY the auto (Downloads) slice' ($watcherText -match 'if \(\$f51AutoMode\) \{ \$uploadQueue = @\(\$f51Split\.auto\) \}') 'the auto slice is not consumed'
Check 'F51: the worker loop iterates the partitioned queue' ($watcherText -match 'foreach \(\$f in @\(\$uploadQueue\)\)') 'the loop still iterates the unsplit queue'
Check 'F51: the override host is wired for the auto path' ($watcherText -match 'New-F51AutoHost') 'no New-F51AutoHost wiring'
Check 'F51: the per-file AUTO-UPLOAD ledger line exists (F49-style logging)' ($watcherText -match '\[mirror\] AUTO-UPLOAD: \{0\} \(Downloads root; F51 always-on, opt-in not required\)') 'no AUTO-UPLOAD ledger line'
Check 'F51: the override ledger line is emitted once per run' ($watcherText -match 'F51AutoHostLedgered') 'no once-per-run override ledger guard'
Check 'F51: mirrorDiag carries the auto-upload state' ($watcherText -match 'autoUpload = \$\(if \(\$f51AutoMode\)') 'mirrorDiag has no autoUpload field'
Check 'F51: the F49 opt-in flags still govern (modal contract intact for other roots)' (($watcherText -match 'mirror-enable\.flag') -and ($watcherText -match 'mirror-disable\.flag')) 'the F49 flag consumption was disturbed'
$ui49 = Get-Content -LiteralPath (Join-Path $root 'payloads\ui.html') -Raw
Check 'F51: the F49 ConfirmModal stays in the v1 UI (untouched by F51)' (($ui49 -match 'id="mirrorOptInModal"') -and ($ui49 -match 'openMirrorOptIn\(btn\)')) 'the F49 modal needles vanished'

if ($script:failures -gt 0) {
    Write-Host ('::error::[F46] mirror policy lab failed: ' + $script:failures + ' check(s)')
    exit 1
}
Write-Host '[F46] mirror policy lab: ALL CHECKS PASS (mock transport, no content uploaded, probe read-only)'
exit 0
