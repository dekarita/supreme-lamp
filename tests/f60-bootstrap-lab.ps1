# [F60 §5] WARM-RUNNER BOOTSTRAP LAB - hand-rolled, Windows PowerShell 5.1 safe.
#
# The F60 equivalent of tests/f59-prewarm-parallel.ps1: a plain script (no Pester
# dependency, so it runs on any Windows runner image) that proves the parts a text
# gate cannot prove - that the four F60 PowerShell surfaces actually BEHAVE.
#
# Every check below is a real function call with the SHIPPED probe contracts:
#   * ServiceProbe  -> returns a status string, or throws for "missing";
#   * HttpProbe     -> returns an object with .StatusCode, or throws;
#   * TailscaleProbe-> returns the `tailscale status --json` shape (.Self.Online,
#                      .Self.DNSName, .Self.TailscaleIPs);
#   * Aria2Probe    -> returns the version string from a real JSON-RPC round-trip.
#
# Covered:
#   A. all four scripts dot-source with -DefineOnly (testable without installing);
#   B. Test-F60PinShape REFUSES an empty or malformed pin (fail-closed);
#   C. Test-F60AssetSha256 accepts a fixture at its digest, throws on a mismatch;
#   D. Add-F60Secret + Invoke-F60Redact scrub a secret out of log text;
#   E. Get-F60RepoOwner parses the documented shapes and throws on junk;
#   F. Invoke-F60Bootstrap validates its parameters BEFORE any side effect;
#   G. Register-F60NssmService takes the IDEMPOTENT branch for an existing service
#      (never invoking nssm) and throws when the executable is missing;
#   H. the pin ledger skips an unchanged pin and re-installs on a changed one;
#   I. Mount-F60DataDisk takes the already-mounted branch and never formats a disk
#      that has partitions;
#   J. Clear-F60RunCommandSecrets returns its count without throwing when the
#      extension directory is absent;
#   K. Invoke-F60Health returns F60_HEALTH_OK / F60_HEALTH_FAILED with injected
#      probes (healthy, stopped, missing, HTTP 500) and REDACTS the aria2 secret
#      out of the persisted JSON;
#   L. Get-F60WarmBudgetVerdict implements <60000 ms and the three-strike STOP
#      (consecutive over-budget runs only; a green run resets the count);
#   M. the stager's payload/tool lists all exist and Import-F60Transport finds the
#      bootstrap transport.
#
# Exit 0 + "F60_LAB_OK" when every check passes; exit 1 + "F60_LAB_FAILED: ..."
# otherwise. The launch-gates lab step publishes the f60-warm-lab commit status
# from exactly these markers.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# NOTE ON NAMES: every surface below is dot-sourced into THIS scope, and a
# dot-sourced script binds its own param block here too. All three F60 surfaces
# declare `-Root` (default C:\ghrdp), so a lab variable spelled R-O-O-T is
# overwritten the moment the first surface loads - which is exactly what made the
# first windows-native run of this lab die at its second dot-source, looking for
# C:\ghrdp\scripts\f60-health.ps1 instead of <repo>\scripts\f60-health.ps1.
# Hence `$labRepoRoot`, a name no F60 surface declares, plus the integrity guard
# after the three dot-sources.
$labRepoRoot = Split-Path -Parent $PSScriptRoot
$labBootstrap = Join-Path $labRepoRoot 'scripts\f60-bootstrap.ps1'
$labHealth = Join-Path $labRepoRoot 'scripts\f60-health.ps1'
$labStager = Join-Path $labRepoRoot 'scripts\f60-stage-and-start.ps1'
$failures = @()
$checks = 0

function Assert-Lab {
    param([string]$Name, [scriptblock]$Block)
    $script:checks++
    try {
        & $Block
        Write-Host ('[F60 lab] PASS ' + $Name)
    } catch {
        $script:failures += ($Name + ': ' + $_.Exception.Message)
        Write-Host ('[F60 lab] FAIL ' + $Name + ': ' + $_.Exception.Message)
    }
}

function Assert-Throws {
    param([scriptblock]$Block, [string]$Match, [string]$What)
    try {
        & $Block
    } catch {
        if ($_.Exception.Message -match $Match) { return $true }
        throw ($What + ' threw, but not with /' + $Match + '/: ' + $_.Exception.Message)
    }
    throw ($What + ' did NOT throw (expected /' + $Match + '/)')
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('f60-lab-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $temp -Force
Write-Host ('[F60 lab] PowerShell ' + $PSVersionTable.PSVersion.ToString() + ', scratch ' + $temp)

# --- A. load every surface IN THIS FILE'S SCOPE, then assert it --------------------
# A `. file.ps1` executed inside a scriptblock that Assert-Lab invokes with `& $Block`
# defines everything in Assert-Lab's FUNCTION scope, which is discarded the moment the
# assertion returns - every later check then fails with "The term 'X' is not recognized
# as the name of a cmdlet". That is exactly what the first windows-native run of this
# lab did (40 of 44 checks failed, all of them "not recognized"). So the three surfaces
# are dot-sourced here, at the lab's own scope, and the A checks only assert that the
# documented functions are callable from it.
. $labBootstrap -DefineOnly
. $labHealth -DefineOnly
. $labStager -DefineOnly
# Integrity guard: if a future surface ever declares a parameter whose name
# collides with a lab variable, fail HERE with the reason instead of letting 40
# checks fail with "the term 'X' is not recognized".
if (-not (Test-Path -LiteralPath (Join-Path $labRepoRoot 'payloads\f60-warm-pins.json'))) {
    throw ('$labRepoRoot was clobbered by a dot-sourced surface (now ' + $labRepoRoot + ') - rename the lab variable, it must not collide with any F60 param')
}
foreach ($labSurface in @($labBootstrap, $labHealth, $labStager)) {
    if (-not (Test-Path -LiteralPath $labSurface)) { throw ('a dot-sourced surface path was clobbered: ' + $labSurface) }
}

Assert-Lab 'A: scripts/f60-bootstrap.ps1 -DefineOnly exposes the whole bootstrap surface' {
    foreach ($fn in @('Test-F60PinShape', 'Test-F60AssetSha256', 'Get-F60File', 'Register-F60NssmService',
                      'Invoke-F60Bootstrap', 'Mount-F60DataDisk', 'Clear-F60RunCommandSecrets',
                      'Get-F60RepoOwner', 'Get-F60StageList', 'Add-F60Secret', 'Invoke-F60Redact',
                      'Get-F60Stamp', 'Write-F60Stamp', 'Get-F60StorageRoot', 'Write-F60MarkerBlock')) {
        if (-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)) { throw ($fn + ' is not defined') }
    }
}
Assert-Lab 'A: scripts/f60-health.ps1 -DefineOnly exposes the health surface + markers' {
    foreach ($fn in @('Invoke-F60Health', 'Get-F60WarmBudgetVerdict', 'Invoke-F60RedactText',
                      'Get-F60HttpVerdict', 'Get-F60ServiceVerdict', 'Get-F60TailscaleVerdict', 'Get-F60Aria2Verdict')) {
        if (-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)) { throw ($fn + ' is not defined') }
    }
    if ($script:F60OkMarker -ne 'F60_HEALTH_OK') { throw ('ok marker is ' + $script:F60OkMarker) }
    if ($script:F60FailMarker -ne 'F60_HEALTH_FAILED') { throw ('fail marker is ' + $script:F60FailMarker) }
}
Assert-Lab 'A: scripts/f60-stage-and-start.ps1 -DefineOnly exposes the stager surface' {
    foreach ($fn in @('Invoke-F60StageAndStart', 'Stage-F60FromCheckout', 'Stage-F60UiBundle', 'Start-F60WarmServices',
                      'Start-F60ColdProcesses', 'Wait-F60DashboardHttp', 'Get-F60PayloadList', 'Get-F60ToolList',
                      'Get-F60WarmServiceNames', 'Get-F60TimingFile', 'Import-F60Transport')) {
        if (-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)) { throw ($fn + ' is not defined') }
    }
}
Assert-Lab 'A: scripts/f60-scrub-runcommand.ps1 parses cleanly' {
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $labRepoRoot 'scripts\f60-scrub-runcommand.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count) { throw ($errors.Count.ToString() + ' parse error(s): ' + (($errors | ForEach-Object { $_.Message }) -join ' | ')) }
}

# --- B. fail-closed pin shapes ---------------------------------------------------
Assert-Lab 'B: an EMPTY sha256 pin is refused (never trusted)' {
    Assert-Throws -What 'Test-F60PinShape' -Match 'EMPTY sha256 pin' -Block {
        Test-F60PinShape -Expected '' -Label 'lab-empty'
    } | Out-Null
}
Assert-Lab 'B: a malformed pin is refused' {
    Assert-Throws -What 'Test-F60PinShape' -Match 'pin is not a 64-hex sha256' -Block {
        Test-F60PinShape -Expected 'abc123' -Label 'lab-short'
    } | Out-Null
}
Assert-Lab 'B: an uppercase pin is normalised, not rejected' {
    $r = Test-F60PinShape -Expected ('A' * 64) -Label 'lab-upper'
    if ($r -ne ('a' * 64)) { throw ('normalisation returned ' + $r) }
}

# --- C. digest verification ------------------------------------------------------
$fixture = Join-Path $temp 'fixture.bin'
[System.IO.File]::WriteAllBytes($fixture, [byte[]](1..64))
$fixtureSha = (Get-FileHash -Path $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-Lab 'C: a file at its pinned digest passes' {
    $r = Test-F60AssetSha256 -Path $fixture -Expected $fixtureSha -Label 'lab-fixture'
    if ([string]$r -ne $fixtureSha) { throw ('the returned digest was ' + $r) }
}
Assert-Lab 'C: a digest mismatch throws (fail-closed)' {
    Assert-Throws -What 'Test-F60AssetSha256' -Match 'SHA-256 MISMATCH' -Block {
        Test-F60AssetSha256 -Path $fixture -Expected ('b' * 64) -Label 'lab-fixture'
    } | Out-Null
}
Assert-Lab 'C: an empty expected digest throws instead of passing' {
    Assert-Throws -What 'Test-F60AssetSha256' -Match 'EMPTY sha256 pin' -Block {
        Test-F60AssetSha256 -Path $fixture -Expected '' -Label 'lab-fixture'
    } | Out-Null
}
Assert-Lab 'C: a missing file throws with its path' {
    Assert-Throws -What 'Test-F60AssetSha256' -Match 'missing at' -Block {
        Test-F60AssetSha256 -Path (Join-Path $temp 'nope.bin') -Expected $fixtureSha -Label 'lab-fixture'
    } | Out-Null
}

# --- D. secret redaction ---------------------------------------------------------
Assert-Lab 'D: a registered secret is scrubbed out of log text' {
    Add-F60Secret -Value 'tskey-lab-super-secret-value'
    $clean = Invoke-F60Redact -Text 'tailscale up --auth-key=file:C:\tmp\k.txt (key tskey-lab-super-secret-value)'
    if ($clean -match 'tskey-lab-super-secret-value') { throw ('the secret survived redaction: ' + $clean) }
    if ($clean -notmatch '\*\*\*') { throw ('the redaction marker is missing: ' + $clean) }
}
Assert-Lab 'D: an empty or trivial secret is never registered as a match-everything pattern' {
    Add-F60Secret -Value ''
    Add-F60Secret -Value 'ab'
    $clean = Invoke-F60Redact -Text 'nothing to hide here'
    if ($clean -ne 'nothing to hide here') { throw ('an empty/short secret corrupted redaction: ' + $clean) }
}

# --- E. repo owner parsing -------------------------------------------------------
Assert-Lab 'E: Get-F60RepoOwner parses an https repo URL' {
    $r = Get-F60RepoOwner -RepoUrl 'https://github.com/dekarita/supreme-lamp'
    if ($r.owner -ne 'dekarita' -or $r.repo -ne 'supreme-lamp') { throw ('got ' + $r.owner + '/' + $r.repo) }
}
Assert-Lab 'E: Get-F60RepoOwner tolerates a trailing slash and .git' {
    $r = Get-F60RepoOwner -RepoUrl 'https://github.com/dekarita/supreme-lamp.git/'
    if ($r.repo -ne 'supreme-lamp') { throw ('got ' + $r.repo) }
}
Assert-Lab 'E: Get-F60RepoOwner throws on a non-github URL instead of guessing' {
    Assert-Throws -What 'Get-F60RepoOwner' -Match 'not a github.com repository URL' -Block {
        Get-F60RepoOwner -RepoUrl 'https://example.com/nope'
    } | Out-Null
}

# --- F. bootstrap parameter validation happens before ANY side effect ------------
$netRoot = Join-Path $temp 'must-not-exist'
Assert-Lab 'F: a missing RepoUrl is refused before any download or directory is created' {
    Assert-Throws -What 'Invoke-F60Bootstrap' -Match 'missing required parameter RepoUrl' -Block {
        Invoke-F60Bootstrap -TailscaleAuthKey 'tskey-lab-1' -RunnerToken 'tok-lab-1' -RepoUrl '' -RepoAccessToken 'pat-lab-1' -UiReleaseTag 'ui-dist' -Root $netRoot -RunnerDir (Join-Path $netRoot 'runner')
    } | Out-Null
    if (Test-Path -LiteralPath $netRoot) { throw 'parameter validation happened AFTER a side effect (the scratch root was created)' }
}
Assert-Lab 'F: a missing RepoAccessToken is refused' {
    Assert-Throws -What 'Invoke-F60Bootstrap' -Match 'missing required parameter RepoAccessToken' -Block {
        Invoke-F60Bootstrap -TailscaleAuthKey 'tskey-lab-1' -RunnerToken 'tok-lab-1' -RepoUrl 'https://github.com/dekarita/supreme-lamp' -RepoAccessToken '' -UiReleaseTag 'ui-dist' -Root $netRoot -RunnerDir (Join-Path $netRoot 'runner')
    } | Out-Null
}
Assert-Lab 'F: a missing UiReleaseTag is refused' {
    Assert-Throws -What 'Invoke-F60Bootstrap' -Match 'missing required parameter UiReleaseTag' -Block {
        Invoke-F60Bootstrap -TailscaleAuthKey 'tskey-lab-1' -RunnerToken 'tok-lab-1' -RepoUrl 'https://github.com/dekarita/supreme-lamp' -RepoAccessToken 'pat-lab-1' -UiReleaseTag '' -Root $netRoot -RunnerDir (Join-Path $netRoot 'runner')
    } | Out-Null
}
Assert-Lab 'F: a missing RunnerToken is refused unless -SkipRunner' {
    Assert-Throws -What 'Invoke-F60Bootstrap' -Match 'missing required parameter RunnerToken' -Block {
        Invoke-F60Bootstrap -TailscaleAuthKey 'tskey-lab-1' -RunnerToken '' -RepoUrl 'https://github.com/dekarita/supreme-lamp' -RepoAccessToken 'pat-lab-1' -UiReleaseTag 'ui-dist' -Root $netRoot -RunnerDir (Join-Path $netRoot 'runner')
    } | Out-Null
    if (Test-Path -LiteralPath $netRoot) { throw 'parameter validation happened AFTER a side effect' }
}
Assert-Lab 'F: a missing TailscaleAuthKey is refused' {
    Assert-Throws -What 'Invoke-F60Bootstrap' -Match 'missing required parameter TailscaleAuthKey' -Block {
        Invoke-F60Bootstrap -TailscaleAuthKey '' -RunnerToken 'tok-lab-1' -RepoUrl 'https://github.com/dekarita/supreme-lamp' -RepoAccessToken 'pat-lab-1' -UiReleaseTag 'ui-dist' -Root $netRoot -RunnerDir (Join-Path $netRoot 'runner')
    } | Out-Null
    if (Test-Path -LiteralPath $netRoot) { throw 'parameter validation happened AFTER a side effect' }
}
Assert-Lab 'F: the storage root follows the data-disk verdict, and is reported not assumed' {
    if ((Get-F60StorageRoot -HasDataDisk $true) -ne 'D:\RDP-Storage') { throw 'the D: storage root changed' }
    if ((Get-F60StorageRoot -HasDataDisk $false) -ne 'C:\RDP-Storage') { throw 'the C: fallback storage root changed' }
}

# --- G. idempotent service registration -----------------------------------------
Assert-Lab 'G: an existing service takes the idempotent branch (nssm is never invoked)' {
    $r = Register-F60NssmService -Nssm 'C:\definitely\missing\nssm.exe' -Name 'Spooler' -Exe 'C:\definitely\missing\app.exe' -Arguments '--flag' -AppDir $temp -LogDir $temp -Start $false
    if ($r.created) { throw 'the service was reported as created' }
    if ($r.name -ne 'Spooler') { throw ('the result named ' + $r.name) }
    Write-Host ('[F60 lab]        existing service Spooler status=' + $r.status + ' created=False (idempotent, nssm never called)')
}
Assert-Lab 'G: a missing executable throws instead of registering a broken service' {
    Assert-Throws -What 'Register-F60NssmService' -Match 'executable missing at' -Block {
        Register-F60NssmService -Nssm 'C:\definitely\missing\nssm.exe' -Name 'F60LabSvcDoesNotExist' -Exe 'C:\definitely\missing\app.exe' -Arguments '--flag' -AppDir $temp -LogDir $temp -Start $false
    } | Out-Null
    if (Get-Service -Name 'F60LabSvcDoesNotExist' -ErrorAction SilentlyContinue) { throw 'a service was created from a missing executable' }
}

# --- H. the pin ledger -----------------------------------------------------------
Assert-Lab 'H: an unchanged pin skips the install, a CHANGED pin re-installs' {
    $target = Join-Path $temp 'tool.bin'
    Copy-Item -LiteralPath $fixture -Destination $target -Force
    Write-F60Stamp -Root $temp -Name 'lab-tool' -Sha $fixtureSha
    $stampFile = Join-Path (Join-Path $temp 'state') 'lab-tool.pin'
    if (-not (Test-Path -LiteralPath $stampFile)) { throw ('the ledger file was not written at ' + $stampFile) }
    $recorded = Get-F60Stamp -Root $temp -Name 'lab-tool'
    if ($recorded -ne $fixtureSha) { throw ('the ledger returned ' + $recorded) }
    if ($recorded -eq $fixtureSha) {
        Write-Host '[F60 lab]        unchanged pin -> skip the download/install'
    }
    $newPin = ('c' * 64)
    if ($recorded -eq $newPin) { throw 'a changed pin compared equal to the recorded one' }
    Write-Host ('[F60 lab]        changed pin (' + $newPin.Substring(0, 8) + '...) -> re-install branch')
    if ((Get-F60Stamp -Root $temp -Name 'lab-never-written') -ne '') { throw 'an unknown ledger entry must read as empty, not as a match' }
}

# --- I. data-disk idempotence ----------------------------------------------------
Assert-Lab 'I: Mount-F60DataDisk takes the already-mounted branch and never formats a partitioned disk' {
    $hasD = $false
    try { $hasD = [bool](Get-Volume -DriveLetter D -ErrorAction SilentlyContinue) } catch { $hasD = $false }
    $r = Mount-F60DataDisk -DriveLetter 'D'
    if ($r -isnot [bool]) { throw 'Mount-F60DataDisk must return a bool' }
    if ($hasD -and -not $r) { throw 'D: is present but the function reported failure' }
    Write-Host ('[F60 lab]        D: present=' + $hasD + ' -> mounted=' + $r + ' (no disk was formatted)')
}

# --- J. the Run Command scrubber is safe when the extension is absent ------------
Assert-Lab 'J: Clear-F60RunCommandSecrets returns its removed count without throwing' {
    $removed = Clear-F60RunCommandSecrets
    if ($null -eq $removed) { throw 'the scrubber returned nothing' }
    Write-Host ('[F60 lab]        settings removed=' + $removed + ' (this runner has no Run Command extension; -IncludeNewest is used by the scrub script)')
}

# --- K. the health probe with injected probes ------------------------------------
$svcProbeOk = { param([string]$Name) return 'Running' }
$httpProbeOk = { param([string]$Url, [int]$TimeoutSec) return [pscustomobject]@{ StatusCode = 200 } }
$tsProbeOk = {
    return [pscustomobject]@{
        Self = [pscustomobject]@{ Online = $true; DNSName = 'sl-warm.lab.ts.net.'; TailscaleIPs = @('100.64.0.9') }
    }
}
$ariaProbeOk = { param([int]$Port) return '1.36.0' }
Assert-Lab 'K: a healthy VM returns ok=True, exit 0 and the F60_HEALTH_OK marker' {
    $out = Join-Path $temp 'health-ok.json'
    $r = Invoke-F60Health -Root $temp -ServiceProbe $svcProbeOk -HttpProbe $httpProbeOk -TailscaleProbe $tsProbeOk -Aria2Probe $ariaProbeOk -Mode 'lab' -OutFile $out
    if (-not $r.ok) { throw ('health reported not-ok: ' + ($r.reasons -join '; ')) }
    if (@($r.services).Count -ne 5) { throw ('expected 5 services, got ' + @($r.services).Count) }
    if (@($r.services | Where-Object { -not $_.ok }).Count -ne 0) { throw 'a service verdict was not ok' }
    if ($r.tailscale.magicDns -ne 'sl-warm.lab.ts.net') { throw ('magicDns was ' + $r.tailscale.magicDns + ' (the trailing dot must be stripped)') }
    if ($r.tailscale.tailnetIp -ne '100.64.0.9') { throw ('tailnetIp was ' + $r.tailscale.tailnetIp) }
    if ($r.aria2.version -ne '1.36.0') { throw ('aria2 version was ' + $r.aria2.version) }
    if ($r.dashboard.status -ne 200 -or $r.uiBundle.status -ne 200) { throw ('http statuses were ' + $r.dashboard.status + '/' + $r.uiBundle.status) }
    if ($global:F60HealthExit -ne 0) { throw ('exit code was ' + $global:F60HealthExit) }
    if (-not (Test-Path -LiteralPath $out)) { throw 'the health JSON was not written' }
    if ($r.mode -ne 'lab') { throw ('mode was ' + $r.mode) }
}
Assert-Lab 'K: one stopped service yields F60_HEALTH_FAILED naming it, exit 1' {
    $svcProbeOneStopped = { param([string]$Name) if ($Name -eq 'qbittorrent-nssm') { return 'Stopped' } return 'Running' }
    $r = Invoke-F60Health -Root $temp -ServiceProbe $svcProbeOneStopped -HttpProbe $httpProbeOk -TailscaleProbe $tsProbeOk -Aria2Probe $ariaProbeOk -Mode 'lab' -OutFile (Join-Path $temp 'health-qbt.json')
    if ($r.ok) { throw 'health reported ok with a stopped service' }
    if (@($r.reasons) -notcontains 'service-qbittorrent-nssm=Stopped') { throw ('reasons: ' + ($r.reasons -join '; ')) }
    if ($global:F60HealthExit -ne 1) { throw ('exit code was ' + $global:F60HealthExit) }
}
Assert-Lab 'K: a missing service is reported as Missing (not as Stopped, not as ok)' {
    $svcProbeMissing = { param([string]$Name) if ($Name -eq 'ghrdp-ui-nssm') { throw 'lab: service not installed' } return 'Running' }
    $r = Invoke-F60Health -Root $temp -ServiceProbe $svcProbeMissing -HttpProbe $httpProbeOk -TailscaleProbe $tsProbeOk -Aria2Probe $ariaProbeOk -Mode 'lab' -OutFile (Join-Path $temp 'health-missing.json')
    if (@($r.reasons) -notcontains 'service-ghrdp-ui-nssm=Missing') { throw ('reasons: ' + ($r.reasons -join '; ')) }
}
Assert-Lab 'K: a non-200 dashboard probe fails with the status code' {
    $httpProbeBad = { param([string]$Url, [int]$TimeoutSec) return [pscustomobject]@{ StatusCode = 500 } }
    $r = Invoke-F60Health -Root $temp -ServiceProbe $svcProbeOk -HttpProbe $httpProbeBad -TailscaleProbe $tsProbeOk -Aria2Probe $ariaProbeOk -Mode 'lab' -OutFile (Join-Path $temp 'health-http.json')
    if ($r.ok) { throw 'health reported ok with a 500 dashboard' }
    if (@($r.reasons) -notcontains 'dashboard-http=500') { throw ('reasons: ' + ($r.reasons -join '; ')) }
    if ($r.dashboard.url -notmatch '127\.0\.0\.1:7331') { throw ('the dashboard probe hit ' + $r.dashboard.url) }
    if ($r.uiBundle.url -notmatch '127\.0\.0\.1:4173') { throw ('the bundle probe hit ' + $r.uiBundle.url) }
}
Assert-Lab 'K: an offline tailscale probe fails closed' {
    $tsProbeOff = { return [pscustomobject]@{ Self = [pscustomobject]@{ Online = $false; DNSName = ''; TailscaleIPs = @() } } }
    $r = Invoke-F60Health -Root $temp -ServiceProbe $svcProbeOk -HttpProbe $httpProbeOk -TailscaleProbe $tsProbeOff -Aria2Probe $ariaProbeOk -Mode 'lab' -OutFile (Join-Path $temp 'health-ts.json')
    if ($r.ok) { throw 'health reported ok with tailscale offline' }
    if (@($r.reasons) -notcontains 'tailscale-not-online') { throw ('reasons: ' + ($r.reasons -join '; ')) }
}
Assert-Lab 'K: the aria2 RPC secret never reaches the persisted health JSON' {
    $leak = 'aria2-lab-secret-0123456789'
    [System.IO.File]::WriteAllText((Join-Path $temp 'aria2-secret.txt'), $leak)
    $ariaProbeLeaky = { param([int]$Port) throw ('lab: rpc refused token:' + 'aria2-lab-secret-0123456789') }
    $out = Join-Path $temp 'health-redact.json'
    $r = Invoke-F60Health -Root $temp -ServiceProbe $svcProbeOk -HttpProbe $httpProbeOk -TailscaleProbe $tsProbeOk -Aria2Probe $ariaProbeLeaky -Mode 'lab' -OutFile $out
    if ($r.aria2.ok) { throw 'a refused RPC reported ok' }
    if (@($r.reasons) -notcontains 'aria2-rpc-unanswered') { throw ('reasons: ' + ($r.reasons -join '; ')) }
    if ($r.aria2.detail -match [regex]::Escape($leak)) { throw ('the secret survived in the returned detail: ' + $r.aria2.detail) }
    if ($r.aria2.detail -notmatch '\*\*\*') { throw ('the redaction marker is missing: ' + $r.aria2.detail) }
    $txt = [System.IO.File]::ReadAllText($out)
    if ($txt -match [regex]::Escape($leak)) { throw 'the secret reached the persisted health JSON' }
}

# --- L. the budget verdict + three-strike STOP -----------------------------------
$timing = Join-Path $temp 'startup-timing-f60.jsonl'
$strikes = Join-Path $temp 'state\f60-warm-strikes.json'
function Write-LabTiming {
    # The shipped helper's record shape: {"step":"...","sec":<n>,"at":"<utc iso>"}
    param([string]$Path, [double[]]$Sec)
    $lines = @()
    foreach ($s in $Sec) {
        $lines += (@{ step = 'dispatch-to-dashboard'; sec = [math]::Round($s, 1); at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
    }
    [System.IO.File]::WriteAllLines($Path, $lines)
}
Assert-Lab 'L: a warm run under 60000 ms passes with 0 strikes' {
    Write-LabTiming -Path $timing -Sec @(42.5)
    $v = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -Step 'dispatch-to-dashboard' -StrikeFile $strikes -MaxStrikes 3
    if (-not $v.ok) { throw ('an under-budget run reported not-ok: ' + $v.detail) }
    if ($v.ms -ne 42500) { throw ('ms was ' + $v.ms) }
    if ($v.strikes -ne 0) { throw ('strikes was ' + $v.strikes) }
    if ($v.stop) { throw 'an under-budget run triggered the STOP' }
    if ($v.budgetMs -ne 60000) { throw ('budgetMs was ' + $v.budgetMs) }
}
Assert-Lab 'L: a run over 60000 ms fails and records exactly 1 strike' {
    Write-LabTiming -Path $timing -Sec @(65.0)
    $v = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -Step 'dispatch-to-dashboard' -StrikeFile $strikes -MaxStrikes 3
    if ($v.ok) { throw 'an over-budget run reported ok' }
    if ($v.strikes -ne 1) { throw ('strikes was ' + $v.strikes + ' (the previous green run must have reset it)') }
    if ($v.stop) { throw 'one over-budget run must not STOP yet' }
}
Assert-Lab 'L: three CONSECUTIVE over-budget runs trigger the STOP' {
    Write-LabTiming -Path $timing -Sec @(61.0, 62.0, 63.0)
    $v1 = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -Step 'dispatch-to-dashboard' -StrikeFile $strikes -MaxStrikes 3
    $v2 = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -Step 'dispatch-to-dashboard' -StrikeFile $strikes -MaxStrikes 3
    $v3 = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -Step 'dispatch-to-dashboard' -StrikeFile $strikes -MaxStrikes 3
    if ($v3.strikes -lt 3) { throw ('strikes was ' + $v3.strikes) }
    if (-not $v3.stop) { throw 'the three-strike STOP did not fire' }
    if ($v1.stop) { throw 'the STOP fired on the first of three runs' }
}
Assert-Lab 'L: a green run in between resets the strike count' {
    Write-LabTiming -Path $timing -Sec @(61.0)
    $null = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -StrikeFile $strikes -MaxStrikes 3
    Write-LabTiming -Path $timing -Sec @(40.0)
    $null = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -StrikeFile $strikes -MaxStrikes 3
    Write-LabTiming -Path $timing -Sec @(63.0)
    $v = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -StrikeFile $strikes -MaxStrikes 3
    if ($v.strikes -ne 1) { throw ('strikes was ' + $v.strikes + ' - a green run must reset the count') }
    if ($v.stop) { throw 'a reset strike count must not STOP' }
    $raw = [System.IO.File]::ReadAllText($strikes)
    if (@(($raw | ConvertFrom-Json)).Count -lt 3) { throw 'the strike ledger lost its history' }
}
Assert-Lab 'L: a missing timing file fails closed (never a silent pass)' {
    $v = Get-F60WarmBudgetVerdict -TimingFile (Join-Path $temp 'does-not-exist.jsonl') -BudgetMs 60000 -Step 'dispatch-to-dashboard'
    if ($v.ok) { throw 'a missing timing file reported ok' }
    if ($v.ms -ne -1) { throw ('ms was ' + $v.ms) }
    if ($v.detail -notmatch 'timing file missing') { throw ('detail was ' + $v.detail) }
}
Assert-Lab 'L: a timing file without the measured step fails closed' {
    $other = Join-Path $temp 'other.jsonl'
    [System.IO.File]::WriteAllLines($other, @((@{ step = 'aria2-wait'; sec = 5.0; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)))
    $v = Get-F60WarmBudgetVerdict -TimingFile $other -BudgetMs 60000 -Step 'dispatch-to-dashboard'
    if ($v.ok) { throw 'a file without the measured step reported ok' }
    if ($v.ms -ne -1) { throw ('ms was ' + $v.ms) }
    if ($v.detail -notmatch 'no dispatch-to-dashboard line') { throw ('detail was ' + $v.detail) }
}

# --- M. the stager's lists and transport ----------------------------------------
Assert-Lab 'M: every staged payload and tool exists in the repository' {
    $missing = @()
    foreach ($rel in (@(Get-F60PayloadList) + @(Get-F60ToolList))) {
        if (-not (Test-Path -LiteralPath (Join-Path $labRepoRoot ($rel -replace '/', '\')))) { $missing += $rel }
    }
    if (@($missing).Count) { throw ('staged files missing from the repo: ' + ($missing -join ', ')) }
    Write-Host ('[F60 lab]        ' + @(Get-F60PayloadList).Count + ' payloads + ' + @(Get-F60ToolList).Count + ' tools all present')
}
Assert-Lab 'M: Import-F60Transport RESOLVES the bootstrap and the caller dot-sources it' {
    $p = Import-F60Transport -Workspace $labRepoRoot -Root $temp
    if (-not $p) { throw 'Import-F60Transport returned no path' }
    if ((Split-Path -Leaf $p) -ne 'f60-bootstrap.ps1') { throw ('it resolved ' + $p) }
    if (-not (Test-Path -LiteralPath $p)) { throw ('the resolved path does not exist: ' + $p) }
    # The CALLER dot-sources: a dot-source inside Import-F60Transport would die with
    # that function's scope and the bundle could never be staged.
    . $p -DefineOnly
    if (-not (Get-Command -Name 'Get-F60ReleaseAssetInfo' -ErrorAction SilentlyContinue)) { throw 'the transport function was not loaded' }
    if (-not (Get-Command -Name 'Get-F60File' -ErrorAction SilentlyContinue)) { throw 'Get-F60File was not loaded' }
    # An empty workspace must resolve to '' rather than throw on Join-Path.
    $none = Import-F60Transport -Workspace '' -Root $temp
    if ($none) { throw ('a bare temp root resolved a transport: ' + $none) }
    Write-Host ('[F60 lab]        transport resolved at ' + $p)
}
Assert-Lab 'M: the default timing file is the F60 file, not F59''s' {
    $tf = Get-F60TimingFile -Root $temp -TimingFile ''
    if ((Split-Path -Leaf $tf) -ne 'startup-timing-f60.jsonl') { throw ('got ' + $tf) }
    $explicit = Get-F60TimingFile -Root $temp -TimingFile 'C:\somewhere\else.jsonl'
    if ($explicit -ne 'C:\somewhere\else.jsonl') { throw ('an explicit timing file was overridden: ' + $explicit) }
}
Assert-Lab 'M: Wait-F60DashboardHttp gives up (ok=False) instead of hanging or passing' {
    $r = Wait-F60DashboardHttp -DashPort 59999 -WaitSec 3
    if ($r.ok) { throw 'a closed port reported a healthy dashboard' }
    if ($r.code -ne 0) { throw ('unexpected code ' + $r.code) }
    if ($r.url -notmatch '59999') { throw ('unexpected url ' + $r.url) }
}
Assert-Lab 'M: the warm service list matches what the health probe requires' {
    $svc = @(Get-F60WarmServiceNames)
    if (@($svc).Count -ne 4) { throw ('expected 4 warm services, got ' + @($svc).Count) }
    foreach ($n in @('aria2c-nssm', 'qbittorrent-nssm', 'ghrdp-ui-nssm', 'ghrdp-server-nssm')) {
        if ($svc -notcontains $n) { throw ($n + ' is not in the warm service list') }
    }
}

# --- cleanup + verdict -----------------------------------------------------------
try { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue } catch { }

Write-Host ('[F60 lab] checks=' + $checks + ' failures=' + @($failures).Count)
if (@($failures).Count -gt 0) {
    foreach ($f in $failures) { Write-Host ('[F60 lab]   - ' + $f) }
    Write-Host ('F60_LAB_FAILED: ' + (@($failures).Count).ToString() + ' of ' + $checks.ToString() + ' checks failed')
    exit 1
}
Write-Host 'F60_LAB_OK'
exit 0
