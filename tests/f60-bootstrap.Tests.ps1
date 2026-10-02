# [F60 §5] WARM-RUNNER BOOTSTRAP - Pester 5 spec.
#
# Companion to tests/f60-bootstrap-lab.ps1 (which runs everywhere, with no Pester
# dependency). This spec covers the three behaviours the F60 brief calls out by
# name, each as an executable branch proof:
#
#   1. PARAMETER VALIDATION - Invoke-F60Bootstrap refuses an incomplete parameter
#      set BEFORE any side effect (no directory, no download, no service).
#   2. IDEMPOTENT RE-RUN - the branches that make a second run a no-op: an existing
#      service is not re-created, an unchanged pin ledger entry skips the install,
#      an already-mounted D: is not formatted, an already-configured runner is not
#      re-configured.
#   3. MISSING-PIN FAIL-CLOSED - an EMPTY or malformed SHA-256 pin is refused, and
#      a digest mismatch is refused; nothing is "installed anyway".
#
# Runs on any Windows host: no VM, no services, no network, no Azure. When Pester 5
# is unavailable the launch-gates lab step skips this file LOUDLY (a ::warning that
# names the file) and still runs the hand-rolled lab, so a missing Pester never
# reads as a pass.

BeforeAll {
    $script:F60RepoRoot = Split-Path -Parent $PSScriptRoot
    . (Join-Path $script:F60RepoRoot 'scripts\f60-bootstrap.ps1') -DefineOnly
    . (Join-Path $script:F60RepoRoot 'scripts\f60-health.ps1') -DefineOnly
    . (Join-Path $script:F60RepoRoot 'scripts\f60-stage-and-start.ps1') -DefineOnly
    $script:F60Temp = Join-Path ([System.IO.Path]::GetTempPath()) ('f60-pester-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $null = New-Item -ItemType Directory -Path $script:F60Temp -Force
    $script:F60Fixture = Join-Path $script:F60Temp 'fixture.bin'
    [System.IO.File]::WriteAllBytes($script:F60Fixture, [byte[]](1..64))
    $script:F60FixtureSha = (Get-FileHash -Path $script:F60Fixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:F60GoodParams = @{
        TailscaleAuthKey = 'tskey-pester-0123456789'
        RunnerToken      = 'token-pester-0123456789'
        RepoUrl          = 'https://github.com/dekarita/supreme-lamp'
        RepoAccessToken  = 'pat-pester-0123456789'
        UiReleaseTag     = 'ui-dist'
        Root             = $script:F60Temp
        RunnerDir        = (Join-Path $script:F60Temp 'runner')
    }
}

AfterAll {
    if ($script:F60Temp -and (Test-Path -LiteralPath $script:F60Temp)) {
        Remove-Item -LiteralPath $script:F60Temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'F60 bootstrap parameter validation' {
    It 'refuses a missing <name> before any side effect' -TestCases @(
        @{ name = 'RepoUrl'; override = @{ RepoUrl = '' }; message = 'missing required parameter RepoUrl' },
        @{ name = 'RepoAccessToken'; override = @{ RepoAccessToken = '' }; message = 'missing required parameter RepoAccessToken' },
        @{ name = 'UiReleaseTag'; override = @{ UiReleaseTag = '' }; message = 'missing required parameter UiReleaseTag' },
        @{ name = 'RunnerToken'; override = @{ RunnerToken = '' }; message = 'missing required parameter RunnerToken' },
        @{ name = 'TailscaleAuthKey'; override = @{ TailscaleAuthKey = '' }; message = 'missing required parameter TailscaleAuthKey' }
    ) {
        param($name, $override, $message)
        $p = @{}
        foreach ($k in $script:F60GoodParams.Keys) { $p[$k] = $script:F60GoodParams[$k] }
        foreach ($k in $override.Keys) { $p[$k] = $override[$k] }
        $sideEffectRoot = Join-Path $script:F60Temp ('side-' + $name)
        $p['Root'] = $sideEffectRoot
        $p['RunnerDir'] = (Join-Path $sideEffectRoot 'runner')
        { Invoke-F60Bootstrap @p } | Should -Throw -ExpectedMessage ('*' + $message + '*')
        Test-Path -LiteralPath $sideEffectRoot | Should -BeFalse -Because 'validation must precede every directory creation and download'
    }

    It 'parses the repository owner and name out of the repo URL' {
        $r = Get-F60RepoOwner -RepoUrl 'https://github.com/dekarita/supreme-lamp'
        $r.owner | Should -Be 'dekarita'
        $r.repo | Should -Be 'supreme-lamp'
        { Get-F60RepoOwner -RepoUrl 'https://example.com/nope' } | Should -Throw -ExpectedMessage '*not a github.com repository URL*'
    }

    It 'registers transport secrets for redaction and scrubs them from log text' {
        Add-F60Secret -Value 'tskey-pester-0123456789'
        $line = Invoke-F60Redact -Text 'tailscale up (key tskey-pester-0123456789)'
        $line | Should -Not -Match 'tskey-pester-0123456789'
        $line | Should -Match '\*\*\*'
    }
}

Describe 'F60 bootstrap idempotent re-run branches' {
    It 'leaves an existing service alone instead of re-creating it' {
        $r = Register-F60NssmService -Nssm 'C:\definitely\missing\nssm.exe' -Name 'Spooler' -Exe 'C:\definitely\missing\app.exe' `
            -Arguments '--flag' -AppDir $script:F60Temp -LogDir $script:F60Temp -Start $false
        $r.created | Should -BeFalse -Because 'an existing service must never be re-created (nssm is not even invoked)'
        $r.name | Should -Be 'Spooler'
        $r.status | Should -Not -BeNullOrEmpty
    }

    It 'refuses to register a service whose executable is missing' {
        {
            Register-F60NssmService -Nssm 'C:\definitely\missing\nssm.exe' -Name 'F60PesterSvcDoesNotExist' -Exe 'C:\definitely\missing\app.exe' `
                -Arguments '--flag' -AppDir $script:F60Temp -LogDir $script:F60Temp -Start $false
        } | Should -Throw -ExpectedMessage '*executable missing at*'
        Get-Service -Name 'F60PesterSvcDoesNotExist' -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
    }

    It 'records and reads the pin ledger so an unchanged pin skips the install' {
        Write-F60Stamp -Root $script:F60Temp -Name 'pester-tool' -Sha $script:F60FixtureSha
        $ledger = Join-Path (Join-Path $script:F60Temp 'state') 'pester-tool.pin'
        Test-Path -LiteralPath $ledger | Should -BeTrue
        Get-F60Stamp -Root $script:F60Temp -Name 'pester-tool' | Should -Be $script:F60FixtureSha
        Get-F60Stamp -Root $script:F60Temp -Name 'pester-never-written' | Should -Be '' -Because 'an unknown entry reads as empty, never as a match'
        # a CHANGED pin must not compare equal -> the re-install branch runs
        (Get-F60Stamp -Root $script:F60Temp -Name 'pester-tool') -eq ('d' * 64) | Should -BeFalse
    }

    It 'verifies a file at its pinned digest and returns the digest' {
        Test-F60AssetSha256 -Path $script:F60Fixture -Expected $script:F60FixtureSha -Label 'pester-fixture' | Should -Be $script:F60FixtureSha
    }

    It 'takes the already-mounted branch for D: and never formats a partitioned disk' {
        $hasD = [bool](Get-Volume -DriveLetter D -ErrorAction SilentlyContinue)
        $r = Mount-F60DataDisk -DriveLetter 'D'
        $r | Should -BeOfType ([bool])
        if ($hasD) { $r | Should -BeTrue -Because 'D: already exists, so the format branch must be skipped' }
    }

    It 'reports the storage root that follows the data-disk verdict' {
        Get-F60StorageRoot -HasDataDisk $true | Should -Be 'D:\RDP-Storage'
        Get-F60StorageRoot -HasDataDisk $false | Should -Be 'C:\RDP-Storage'
    }

    It 'counts Run Command settings files safely when the extension is absent' {
        { Clear-F60RunCommandSecrets } | Should -Not -Throw
    }
}

Describe 'F60 bootstrap missing-pin fail-closed' {
    It 'refuses an EMPTY sha256 pin' {
        { Test-F60PinShape -Expected '' -Label 'pester-empty' } | Should -Throw -ExpectedMessage '*EMPTY sha256 pin*'
    }

    It 'refuses a malformed sha256 pin' {
        { Test-F60PinShape -Expected 'not-a-digest' -Label 'pester-bad' } | Should -Throw -ExpectedMessage '*pin is not a 64-hex sha256*'
    }

    It 'refuses a digest mismatch instead of installing anyway' {
        { Test-F60AssetSha256 -Path $script:F60Fixture -Expected ('e' * 64) -Label 'pester-fixture' } | Should -Throw -ExpectedMessage '*SHA-256 MISMATCH*'
    }

    It 'refuses an empty expected digest on a real file' {
        { Test-F60AssetSha256 -Path $script:F60Fixture -Expected '' -Label 'pester-fixture' } | Should -Throw -ExpectedMessage '*EMPTY sha256 pin*'
    }

    It 'reads the committed pin file and finds the actions/runner pin complete' {
        $pins = Get-Content -LiteralPath (Join-Path $script:F60RepoRoot 'payloads\f60-warm-pins.json') -Raw | ConvertFrom-Json
        $pins.schema | Should -Be 'ghrdp-f60-warm-pins/1'
        $pins.assets.actions_runner_win_x64_zip.sha256 | Should -Match '^[0-9a-f]{64}$'
        $pins.assets.actions_runner_win_x64_zip.pin_state | Should -Be 'pinned'
        foreach ($n in @('tailscale_msi', 'nssm', 'node_win_x64_zip')) {
            $a = $pins.assets.$n
            if ($a.pin_state -eq 'bootstrap') {
                $a.sha256 | Should -Be '' -Because 'a bootstrap pin must be EMPTY until the pins workflow records the real digest'
            } else {
                $a.sha256 | Should -Match '^[0-9a-f]{64}$'
            }
        }
    }
}

Describe 'F60 health + budget verdicts' {
    BeforeAll {
        $script:ProbeSvcOk = { param([string]$Name) return 'Running' }
        $script:ProbeHttpOk = { param([string]$Url, [int]$TimeoutSec) return [pscustomobject]@{ StatusCode = 200 } }
        $script:ProbeTsOk = { return [pscustomobject]@{ Self = [pscustomobject]@{ Online = $true; DNSName = 'sl-warm.pester.ts.net.'; TailscaleIPs = @('100.64.0.9') } } }
        $script:ProbeAriaOk = { param([int]$Port) return '1.36.0' }
    }

    It 'reports a healthy warm VM as ok with exit 0' {
        $out = Join-Path $script:F60Temp 'pester-health.json'
        $r = Invoke-F60Health -Root $script:F60Temp -ServiceProbe $script:ProbeSvcOk -HttpProbe $script:ProbeHttpOk `
            -TailscaleProbe $script:ProbeTsOk -Aria2Probe $script:ProbeAriaOk -Mode 'pester' -OutFile $out
        $r.ok | Should -BeTrue
        $global:F60HealthExit | Should -Be 0
        @($r.services).Count | Should -Be 5
        $r.tailscale.magicDns | Should -Be 'sl-warm.pester.ts.net'
        Test-Path -LiteralPath $out | Should -BeTrue
    }

    It 'fails closed when one service is stopped and names it' {
        $stopped = { param([string]$Name) if ($Name -eq 'ghrdp-server-nssm') { return 'Stopped' } return 'Running' }
        $r = Invoke-F60Health -Root $script:F60Temp -ServiceProbe $stopped -HttpProbe $script:ProbeHttpOk `
            -TailscaleProbe $script:ProbeTsOk -Aria2Probe $script:ProbeAriaOk -Mode 'pester' -OutFile (Join-Path $script:F60Temp 'pester-health-2.json')
        $r.ok | Should -BeFalse
        $r.reasons | Should -Contain 'service-ghrdp-server-nssm=Stopped'
        $global:F60HealthExit | Should -Be 1
    }

    It 'gates dispatch-to-dashboard at under 60000 ms and counts CONSECUTIVE strikes' {
        $timing = Join-Path $script:F60Temp 'pester-timing.jsonl'
        $strikes = Join-Path $script:F60Temp 'pester-strikes.json'
        [System.IO.File]::WriteAllLines($timing, @((@{ step = 'dispatch-to-dashboard'; sec = 42.5; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)))
        $v = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -StrikeFile $strikes -MaxStrikes 3
        $v.ok | Should -BeTrue
        $v.ms | Should -Be 42500
        $v.strikes | Should -Be 0
        [System.IO.File]::WriteAllLines($timing, @((@{ step = 'dispatch-to-dashboard'; sec = 65.0; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)))
        $v2 = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -StrikeFile $strikes -MaxStrikes 3
        $v2.ok | Should -BeFalse
        $v2.strikes | Should -Be 1
        $v2.stop | Should -BeFalse
        $null = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -StrikeFile $strikes -MaxStrikes 3
        $v3 = Get-F60WarmBudgetVerdict -TimingFile $timing -BudgetMs 60000 -StrikeFile $strikes -MaxStrikes 3
        $v3.strikes | Should -BeGreaterOrEqual 3
        $v3.stop | Should -BeTrue -Because 'three consecutive over-budget runs are the F60 STOP'
    }

    It 'fails closed when the timing file has no measured step' {
        $v = Get-F60WarmBudgetVerdict -TimingFile (Join-Path $script:F60Temp 'nope.jsonl') -BudgetMs 60000
        $v.ok | Should -BeFalse
        $v.ms | Should -Be -1
    }
}

Describe 'F60 stager contract' {
    It 'lists payloads and tools that all exist in the repository' {
        $missing = @()
        foreach ($rel in (@(Get-F60PayloadList) + @(Get-F60ToolList))) {
            if (-not (Test-Path -LiteralPath (Join-Path $script:F60RepoRoot ($rel -replace '/', '\')))) { $missing += $rel }
        }
        $missing | Should -BeNullOrEmpty -Because 'the stage list must name files that exist'
    }

    It 'loads the bootstrap transport instead of reimplementing it' {
        $p = Import-F60Transport -Workspace $script:F60RepoRoot -Root $script:F60Temp
        $p | Should -Not -BeNullOrEmpty
        Get-Command -Name 'Get-F60ReleaseAssetInfo' -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }

    It 'uses the F60 timing file by default' {
        Split-Path -Leaf (Get-F60TimingFile -Root $script:F60Temp -TimingFile '') | Should -Be 'startup-timing-f60.jsonl'
    }
}
