# [M8 behavioral harness] Mocked contents-API runtime for the REAL M8
# finalizer script, extracted verbatim from .github/workflows/main.yml by
# tests/m8-finalizer-behavior.test.js (which spawns this file under pwsh).
#
# Command-precedence seam (documented, not a reimplementation): PowerShell
# resolves functions before cmdlets, so the Invoke-RestMethod FUNCTION defined
# below shadows the network cmdlet for the dot-sourced body. There is NO real
# network access from this process: any non-GET/PUT call or any unexpected
# shape is refused loudly, and all traffic is recorded to requests.jsonl with
# credential VALUES REDACTED (only a boolean hasAuth + the timeout the script
# actually requested are logged).
#
# The mock enforces the REAL semantics the finalizer depends on:
#   * GET  .../contents/docs/status.json?ref=main -> { sha, content(b64) } or 404
#   * PUT  (same uri) -> optimistic-concurrency 409 when the sha is stale or
#     missing for an existing file; 401/403 for bad credentials; scripted
#     5xx/timeout/hang behaviors from the scenario.
#   * -TimeoutSec is OBSERVED: a scripted hang longer than the requested
#     timeout throws the way the real cmdlet would, and a scripted timeout
#     with NO -TimeoutSec passed is FLAGGED in the log (so "bounded" cannot be
#     claimed without the script actually passing a bound).
# State transitions between calls (a concurrent run's heartbeat landing
# between GET and PUT, progress moving between attempts, ...) are scripted via
# before/after mutations on the virtual server state.
param([Parameter(Mandatory = $true)][string]$ScenarioPath)
$ErrorActionPreference = 'Continue'

$dir = Split-Path -Parent $ScenarioPath
$scenario = Get-Content -Raw -LiteralPath $ScenarioPath | ConvertFrom-Json
$statePath = Join-Path $dir 'state.json'
$reqLogPath = Join-Path $dir 'requests.jsonl'
if (Test-Path -LiteralPath $reqLogPath) { Remove-Item -LiteralPath $reqLogPath -Force }

# Live virtual-server state (mutated by scripted effects and successful PUTs).
$state = $scenario.state
$script:getCalls = 0
$script:putCalls = 0

function Save-State {
    ($state | ConvertTo-Json -Depth 40 -Compress) | Set-Content -LiteralPath $statePath -Encoding utf8
}
Save-State  # persist the pristine state even when the body sends zero requests
function Write-Req { param($Rec)
    (($Rec | ConvertTo-Json -Depth 30 -Compress) + "`n") | Add-Content -LiteralPath $reqLogPath -Encoding utf8
}
function Get-Effect { param([string]$Method, [int]$Call)
    if (-not ($state.PSObject.Properties['behaviors'] -and $state.behaviors)) { return $null }
    if (-not $state.behaviors.PSObject.Properties[$Method]) { return $null }
    foreach ($e in @($state.behaviors.$Method)) {
        if ($e.PSObject.Properties['call'] -and [int]$e.call -eq $Call) { return $e }
    }
    return $null
}
function Invoke-Mutate { param($Mut)
    if ($null -eq $Mut) { return }
    # A concurrent writer replaces the tracked snapshot between calls.
    if ($Mut.PSObject.Properties['statusJson']) { $state.statusJson = $Mut.statusJson }
    if ($Mut.PSObject.Properties['rawContent']) { $state.rawContent = $Mut.rawContent }
    if ($Mut.PSObject.Properties['bumpSha'] -and $Mut.bumpSha) { $state.shaCounter = [int]$state.shaCounter + 1 }
}
function Test-M8Auth { param($Headers)
    $expected = 'Bearer ' + [string]$scenario.token
    if ([string]$scenario.token -eq '') { $expected = '__no_token_configured__' }
    $auth = ''
    try { $auth = [string]$Headers['Authorization'] } catch { }
    return ($auth -eq $expected)
}
function Deny-RealApi { param([string]$Why)
    # Any attempt to reach something the mock does not model is a hard failure,
    # never a silent pass.
    throw ("M8-HARNESS REFUSAL: " + $Why)
}

function Invoke-RestMethod {
    param(
        [string]$Uri, [string]$Method = 'Get', $Headers = $null, [string]$Body = $null,
        [string]$ContentType = $null, [int]$TimeoutSec = 0, [string]$StatusCodeVariable = $null,
        [switch]$SkipHttpErrorCheck, $ErrorAction = $null, $OutFile = $null
    )
    $m = ([string]$Method).ToLower()
    if ($m -notin @('get', 'put')) { Deny-RealApi "unmocked method $Method for $Uri" }
    if ($Uri -notmatch '^https://api\.github\.com/repos/[^/]+/[^/]+/contents/docs/status\.json(\?ref=main)?$') { Deny-RealApi "unexpected uri $Uri" }
    if ($m -eq 'put') { $script:putCalls += 1; $call = $script:putCalls } else { $script:getCalls += 1; $call = $script:getCalls }
    $eff = Get-Effect -Method $m -Call $call
    if ($eff -and $eff.PSObject.Properties['before']) { Invoke-Mutate $eff.before }

    $rec = [ordered]@{ method = $m; call = $call; uri = $Uri; hasAuth = (Test-M8Auth $Headers); timeoutSec = $TimeoutSec; status = 0; note = '' }
    if ($m -eq 'put' -and $Body) {
        try {
            $bj = $Body | ConvertFrom-Json
            $rec.bodyMessage = [string]$bj.message
            if ($bj.PSObject.Properties['sha']) { $rec.bodySha = [string]$bj.sha }
            $plain = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$bj.content))
            $rec.payload = ($plain | ConvertFrom-Json)
        } catch { $rec.note = 'put body decode failed' }
    }

    $status = 200
    $respObj = $null
    $done = $false
    if (-not (Test-M8Auth $Headers)) { $status = 401; $rec.note = 'auth rejected'; $done = $true }

    if (-not $done -and $eff -and $eff.PSObject.Properties['respond']) {
        $rsp = [string]$eff.respond
        if ($rsp -eq 'hang') {
            $ms = 5000; if ($eff.PSObject.Properties['ms']) { $ms = [int]$eff.ms }
            if ($TimeoutSec -gt 0 -and ($ms / 1000.0) -gt $TimeoutSec) {
                # The SCRIPT's own per-request bound fired - exactly what the
                # real HttpClient timeout does.
                $rec.note = ('timeout-enforced(req=' + $TimeoutSec + 's,hang=' + $ms + 'ms)')
                $rec.status = 0
                Write-Req $rec
                if ($StatusCodeVariable) { Set-Variable -Scope 1 -Name $StatusCodeVariable -Value 0 }
                throw [System.Net.Http.HttpRequestException]::new("The HTTP request timed out after $TimeoutSec seconds (mock-enforced)")
            }
            $rec.note = ('shorter-than-timeout(req=' + $TimeoutSec + '); slept-for-real')
            Start-Sleep -Milliseconds ([Math]::Min($ms, 8000))
        } elseif ($rsp -eq 'timeout') {
            $rec.note = $(if ($TimeoutSec -gt 0) { 'forced-timeout(req-bound=' + $TimeoutSec + 's)' } else { 'forced-timeout-UNBOUNDED(no -TimeoutSec passed)' })
            $rec.status = 0
            Write-Req $rec
            if ($StatusCodeVariable) { Set-Variable -Scope 1 -Name $StatusCodeVariable -Value 0 }
            throw [System.Net.Http.HttpRequestException]::new('The HTTP request timed out (mock)')
        } elseif ($rsp -in @('invalid-base64', 'invalid-json', 'missing-runid', 'missing-runstatus')) {
            # content-corruption variants (GET only)
            $status = 200
            $content = ''
            switch ($rsp) {
                'invalid-base64' { $content = '!!!not-valid-base64!!!' }
                'invalid-json' { $content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('{ this is not json')) }
                'missing-runid' { $content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('{"runStatus":"in_progress","overallPct":5}')) }
                'missing-runstatus' { $content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('{"runId":"1234"}')) }
            }
            $respObj = [ordered]@{ sha = ('sha' + [int]$state.shaCounter); content = $content }
            $done = $true
        } elseif ($rsp -eq 'ok') {
            # fall through to state semantics
        } else {
            $status = [int]$rsp
            $rec.note = ('scripted http ' + $status)
            $done = $true
        }
    }

    if (-not $done) {
        if ($m -eq 'get') {
            if ($null -eq $state.statusJson -and -not ($state.PSObject.Properties['rawContent'] -and $state.rawContent)) {
                $status = 404; $rec.note = 'file absent'
            } else {
                $status = 200
                $raw = ''
                if ($state.PSObject.Properties['rawContent'] -and $state.rawContent) { $raw = [string]$state.rawContent }
                else { $raw = ($state.statusJson | ConvertTo-Json -Depth 30 -Compress) }
                $respObj = [ordered]@{ sha = ('sha' + [int]$state.shaCounter); content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($raw)) }
            }
        } else {
            if ($status -eq 200) {
                $curSha = ('sha' + [int]$state.shaCounter)
                $hasFile = ($null -ne $state.statusJson) -or ($state.PSObject.Properties['rawContent'] -and $state.rawContent)
                if ($hasFile -and -not $rec.Contains('bodySha')) { $status = 409; $rec.note = '409: existing file, no sha' }
                elseif ($hasFile -and $rec.bodySha -ne $curSha) { $status = 409; $rec.note = ('409: sha mismatch (remote has ' + $curSha + ')') }
                else {
                    $state.statusJson = $rec.payload
                    if ($state.PSObject.Properties['rawContent']) { $state.rawContent = $null }
                    $state.shaCounter = [int]$state.shaCounter + 1
                    $rec.note = 'committed'
                }
            } else { $rec.note = ('scripted http ' + $status) }
        }
    }

    $rec.status = $status
    if ($eff -and $eff.PSObject.Properties['after']) { Invoke-Mutate $eff.after }
    Write-Req $rec
    Save-State
    if ($StatusCodeVariable) { Set-Variable -Scope 1 -Name $StatusCodeVariable -Value $status }
    if ($status -ge 400 -and -not $SkipHttpErrorCheck) {
        throw [System.Net.Http.HttpRequestException]::new("Response status code does not indicate success: $status (mock)")
    }
    return $respObj
}

# Wall-clock seam: retry backoff stays real (small seconds), so the harness
# never fabricates timing.
$bodyPath = Join-Path $dir 'm8-body.ps1'
Write-Host ('[m8-harness] executing extracted body from ' + $bodyPath + ' (pwsh ' + $PSVersionTable.PSVersion.ToString() + ')')
. $bodyPath
Write-Host '[m8-harness] WARNING: body returned WITHOUT exit (unexpected)'
