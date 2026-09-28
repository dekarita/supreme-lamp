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

if ($script:failures -gt 0) {
    Write-Host ('::error::[F46] mirror policy lab failed: ' + $script:failures + ' check(s)')
    exit 1
}
Write-Host '[F46] mirror policy lab: ALL CHECKS PASS (mock transport, no content uploaded, probe read-only)'
exit 0
