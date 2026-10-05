# [F60 §3] WARM-RUNNER BOOTSTRAP - executed ON the Azure VM by
# `az vm run-command invoke --command-id RunPowerShellScript --scripts @scripts/f60-bootstrap.ps1`.
#
# CONTRACT (asserted by tests/f60-provision-contract.test.js,
# tests/f60-bootstrap-lab.ps1 and tests/f60-bootstrap.Tests.ps1):
#   * IDEMPOTENT: every stage checks what is already there (service exists? binary
#     already at the pinned sha? runner already configured?) and skips instead of
#     re-installing. Re-running it on a healthy VM is a no-op that ends in
#     BOOTSTRAP_OK.
#   * FAIL-CLOSED ON PINS: nothing is installed unless its SHA-256 pin is a
#     non-empty 64-hex value AND the downloaded bytes match it. The check is the
#     SHIPPED F59 verifier (payloads/f59-prebuilt-verify.ps1, staged from the repo
#     at run time - one implementation, no copy here) with a byte-identical local
#     fallback for the case where staging has not happened yet.
#   * NO SECRET IN ANY OUTPUT: the Tailscale auth key, the runner registration
#     token, the repo access token and the VM admin password are never printed.
#     Every log line passes through Invoke-F60Redact, the auth key is handed to
#     `tailscale up` as `file:<path>` (the repo's Provision-GhrdpVps.ps1 pattern)
#     and the temp key file is deleted in a finally block. As a last line of
#     defence the Run Command runtime-settings files - which Azure writes with the
#     parameter values in them - are deleted at the end of a successful run.
#   * COMPACT OUTPUT: Azure Run Command returns at most the last ~4096 bytes of
#     stdout, so the marker block is emitted LAST and everything verbose goes to
#     C:\ghrdp\logs\f60-bootstrap-<ts>.log on the VM.
#   * MARKERS: `BOOTSTRAP_OK` on success, `BOOTSTRAP_FAILED: <reason>` on any
#     failure. The provisioning workflow fails closed unless it sees BOOTSTRAP_OK
#     and fails closed if it sees BOOTSTRAP_FAILED.
#
# Runs under Windows PowerShell 5.1 (Run Command uses powershell.exe) - no PS7-only
# syntax anywhere in this file.

[CmdletBinding()]
param(
    [string]$TailscaleAuthKey = '',
    [string]$RunnerToken = '',
    [string]$RepoUrl = '',
    [string]$UiReleaseTag = 'ui-dist',
    # [F60 deviation, documented in docs/F60-OPERATOR-SETUP.md] the repository is
    # PRIVATE, so the VM cannot fetch repo files or release assets anonymously and
    # it has no GITHUB_TOKEN outside a job. RepoAccessToken is a fine-grained PAT
    # (Contents: read-only, this repository only) supplied as the repo secret
    # GHRDP_RELEASE_READONLY_TOKEN. It is used ONLY for the staging downloads.
    [string]$RepoAccessToken = '',
    [string]$RepoRef = '',
    [string]$UiBundleSha = '',
    [string]$Root = 'C:\ghrdp',
    [string]$RunnerDir = 'C:\actions-runner',
    [string]$RunnerName = 'sl-warm',
    [string]$RunnerLabels = 'self-hosted,windows,sl-warm',
    [string]$Hostname = 'sl-warm',
    [string]$TailscaleTag = 'tag:ghrdp-warm',
    # Inline pins override (lab + air-gapped re-runs). Empty = use the staged repo
    # copy of payloads/f60-warm-pins.json, which is the single source of truth.
    [string]$PinsJson = '',
    # Lab / re-run switches.
    [switch]$DefineOnly,
    [switch]$SkipRunner,
    [switch]$SkipDownloads
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:F60Secrets = New-Object System.Collections.ArrayList
$script:F60LogPath = ''
$script:F60Verifier = ''
$script:F60HealthModule = ''

# ---------------------------------------------------------------------------
# logging + redaction
# ---------------------------------------------------------------------------
function Add-F60Secret {
    param([string]$Value)
    if ($Value -and $Value.Length -ge 6) {
        if (-not $script:F60Secrets.Contains($Value)) { $null = $script:F60Secrets.Add($Value) }
    }
}

function Invoke-F60Redact {
    param([string]$Text)
    $out = [string]$Text
    foreach ($s in @($script:F60Secrets)) {
        if ($s -and $out.Contains($s)) { $out = $out.Replace($s, '***') }
    }
    return $out
}

function Write-F60Log {
    # One compact line to stdout (the Run Command output is capped) + the full
    # detail to the VM-side log file. Every string is redacted first.
    param([string]$Msg, [string]$Detail = '')
    $line = Invoke-F60Redact -Text $Msg
    $full = $line
    if ($Detail) { $full = $line + ' :: ' + (Invoke-F60Redact -Text $Detail) }
    Write-Host $line
    if ($script:F60LogPath) {
        try {
            $stamp = (Get-Date).ToUniversalTime().ToString('o')
            Add-Content -LiteralPath $script:F60LogPath -Value ($stamp + ' ' + $full) -Encoding utf8
        } catch { }
    }
}

function New-F60Dir {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
    return $Path
}

function Get-F60Sha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-F60PinShape {
    # The pin contract, identical to payloads/f59-prebuilt-verify.ps1: an EMPTY or
    # malformed pin is refused (never "trust it"), a mismatch is refused.
    param([string]$Expected, [string]$Label)
    $pin = ''
    if ($Expected) { $pin = $Expected.Trim().ToLowerInvariant() }
    if ([string]::IsNullOrWhiteSpace($pin)) {
        throw ('[F60 bootstrap] ' + $Label + ' has an EMPTY sha256 pin - refusing an unpinned download (run .github/workflows/f60-warm-pins-bootstrap.yml once and commit the observed digests into payloads/f60-warm-pins.json)')
    }
    if ($pin -notmatch '^[0-9a-f]{64}$') {
        throw ('[F60 bootstrap] ' + $Label + ' pin is not a 64-hex sha256: ' + $pin)
    }
    return $pin
}

function Test-F60AssetSha256 {
    # Prefers the SHIPPED F59 verifier (staged from the repo); falls back to the
    # byte-identical local implementation before staging has happened.
    param([string]$Path, [string]$Expected, [string]$Label)
    $pin = Test-F60PinShape -Expected $Expected -Label $Label
    if (-not (Test-Path -LiteralPath $Path)) { throw ('[F60 bootstrap] ' + $Label + ' missing at ' + $Path) }
    if ($script:F60Verifier -and (Get-Command -Name 'Test-F59AssetSha256' -ErrorAction SilentlyContinue)) {
        return (Test-F59AssetSha256 -Path $Path -Expected $pin -Label $Label)
    }
    $sha = Get-F60Sha256 -Path $Path
    if ($sha -ne $pin) {
        throw ('[F60 bootstrap] SHA-256 MISMATCH for ' + $Label + ': pin=' + $pin + ' observed=' + $sha + ' - refusing to install')
    }
    return $sha
}

# ---------------------------------------------------------------------------
# transport helpers
# ---------------------------------------------------------------------------
function Get-F60File {
    # Download + pin-verify. curl.exe first (it drops the Authorization header on a
    # cross-host redirect, which is exactly what the GitHub asset redirect needs),
    # Invoke-WebRequest as the fallback. Idempotent: an existing file at the pinned
    # sha is NOT re-downloaded.
    param(
        [string]$Url,
        [string]$Out,
        [string]$Label,
        [string]$ExpectedSha,
        [string]$AuthToken = '',
        [string]$Accept = '',
        [long]$MinBytes = 1024,
        # ONLY for the .sha256 sidecar of a commit-built asset: its CONTENT is the
        # pin, so there is nothing to compare it against. Everything else must pass
        # a non-empty 64-hex pin (fail-closed).
        [switch]$NoPin
    )
    if ((Test-Path -LiteralPath $Out) -and ((Get-Item -LiteralPath $Out).Length -ge $MinBytes)) {
        if ($NoPin) {
            Write-F60Log ('[F60 fetch] ' + $Label + ' already present (sidecar/pin-source file, no pin to compare) - reusing')
            return $Out
        }
        try {
            $null = Test-F60AssetSha256 -Path $Out -Expected $ExpectedSha -Label ($Label + ' (cached)')
            Write-F60Log ('[F60 fetch] ' + $Label + ' already present at the pinned sha256 - skipping the download')
            return $Out
        } catch {
            Write-F60Log ('[F60 fetch] ' + $Label + ' present but NOT at the pinned sha256 - re-downloading')
            Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
        }
    }
    $dir = Split-Path -Parent $Out
    if ($dir) { $null = New-F60Dir -Path $dir }
    $headers = @()
    if ($AuthToken) { $headers += @('-H', ('Authorization: Bearer ' + $AuthToken)) }
    if ($Accept) { $headers += @('-H', ('Accept: ' + $Accept)) }
    $ok = $false
    for ($a = 1; $a -le 3 -and -not $ok; $a++) {
        Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
        try {
            $curlArgs = @('-fsSL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '30', '--max-time', '1800', '-o', $Out) + $headers + @($Url)
            & curl.exe @curlArgs 2>$null
            $LASTEXITCODE = 0
            if ((Test-Path -LiteralPath $Out) -and ((Get-Item -LiteralPath $Out).Length -ge $MinBytes)) { $ok = $true }
        } catch { }
        if (-not $ok) {
            try {
                $wh = @{}
                if ($AuthToken) { $wh['Authorization'] = ('Bearer ' + $AuthToken) }
                if ($Accept) { $wh['Accept'] = $Accept }
                Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing -TimeoutSec 1800 -Headers $wh -ErrorAction Stop
                if ((Test-Path -LiteralPath $Out) -and ((Get-Item -LiteralPath $Out).Length -ge $MinBytes)) { $ok = $true }
            } catch {
                Write-F60Log ('[F60 fetch] ' + $Label + ' attempt ' + $a + ' failed', $_.Exception.Message)
            }
        }
        if (-not $ok) { Start-Sleep -Seconds (3 * $a) }
    }
    if (-not $ok) { throw ('[F60 fetch] could not download ' + $Label + ' from its official source (attempts exhausted)') }
    if ($NoPin) {
        Write-F60Log ('[F60 fetch] ' + $Label + ' downloaded (' + (Get-Item -LiteralPath $Out).Length + ' bytes) - pin-source file, content authenticated by the repository release over TLS')
        return $Out
    }
    $null = Test-F60AssetSha256 -Path $Out -Expected $ExpectedSha -Label $Label
    Write-F60Log ('[F60 fetch] ' + $Label + ' verified sha256=' + (Get-F60Sha256 -Path $Out) + ' (' + (Get-Item -LiteralPath $Out).Length + ' bytes)')
    return $Out
}

function Get-F60RepoOwner {
    param([string]$RepoUrl)
    $m = [regex]::Match([string]$RepoUrl, 'github\.com[/:]([^/\s]+)/([^/\s#?]+?)(\.git)?/?$')
    if (-not $m.Success) { throw ('[F60 bootstrap] RepoUrl is not a github.com repository URL: ' + $RepoUrl) }
    return @{ owner = $m.Groups[1].Value; repo = $m.Groups[2].Value }
}

function Get-F60RepoFile {
    # GitHub Contents API with the raw accept header: the bytes come back in the
    # response body (no redirect, so the token never leaves api.github.com).
    param([string]$RelPath, [string]$Out, [string]$Owner, [string]$Repo, [string]$Ref, [string]$Token)
    $url = ('https://api.github.com/repos/' + $Owner + '/' + $Repo + '/contents/' + ($RelPath -replace '\\', '/') + '?ref=' + $Ref)
    $dir = Split-Path -Parent $Out
    if ($dir) { $null = New-F60Dir -Path $dir }
    & curl.exe -fsSL --retry 3 --retry-delay 2 --connect-timeout 30 --max-time 600 -H ('Authorization: Bearer ' + $Token) -H 'Accept: application/vnd.github.raw' -o $Out $url 2>$null
    $LASTEXITCODE = 0
    if (-not (Test-Path -LiteralPath $Out) -or ((Get-Item -LiteralPath $Out).Length -eq 0)) {
        throw ('[F60 stage] could not fetch ' + $RelPath + ' from the repository (Contents API)')
    }
    return $Out
}

function Get-F60ReleaseAssetInfo {
    # releases/tags -> the asset entry (id/name/size). One API call per release.
    param([string]$Tag, [string]$Owner, [string]$Repo, [string]$Token)
    $tmp = Join-Path $env:TEMP ('f60-rel-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        & curl.exe -fsSL --retry 3 --connect-timeout 30 --max-time 120 -H ('Authorization: Bearer ' + $Token) -H 'Accept: application/vnd.github+json' -o $tmp ('https://api.github.com/repos/' + $Owner + '/' + $Repo + '/releases/tags/' + $Tag) 2>$null
        $LASTEXITCODE = 0
        if (-not (Test-Path -LiteralPath $tmp)) { throw ('[F60 stage] release ' + $Tag + ' not readable') }
        return ([System.IO.File]::ReadAllText($tmp) | ConvertFrom-Json)
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Get-F60ReleaseAsset {
    # Download one release asset by exact name (or by pattern -> newest match) and
    # verify it against a pin / a sidecar checksum.
    param(
        [string]$Tag,
        [string]$Name,
        [string]$Pattern,
        [string]$Out,
        [string]$Label,
        [string]$ExpectedSha,
        [string]$Owner,
        [string]$Repo,
        [string]$Token,
        [long]$MinBytes = 1024
    )
    $rel = Get-F60ReleaseAssetInfo -Tag $Tag -Owner $Owner -Repo $Repo -Token $Token
    $assets = @($rel.assets)
    $pick = $null
    if ($Name) {
        $pick = @($assets | Where-Object { [string]$_.name -eq $Name } | Select-Object -First 1)
        if (-not $pick) { throw ('[F60 stage] release ' + $Tag + ' has no asset named ' + $Name) }
    } else {
        $cands = @($assets | Where-Object { ([string]$_.name) -like $Pattern })
        if (@($cands).Count -eq 0) { throw ('[F60 stage] release ' + $Tag + ' has no asset matching ' + $Pattern) }
        $pick = @($cands | Sort-Object -Property name -Descending | Select-Object -First 1)
    }
    Write-F60Log ('[F60 stage] ' + $Label + ' = release ' + $Tag + ' asset ' + [string]$pick.name + ' (' + [string]$pick.size + ' bytes)')
    return (Get-F60File -Url ([string]$pick.url) -Out $Out -Label $Label -ExpectedSha $ExpectedSha -AuthToken $Token -Accept 'application/octet-stream' -MinBytes $MinBytes)
}

# ---------------------------------------------------------------------------
# installs
# ---------------------------------------------------------------------------
function Install-F60Tailscale {
    param([object]$Pin, [string]$Downloads, [string]$AuthKey, [string]$Tag, [string]$Hostname)
    $exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    $msi = Join-Path $Downloads ([string]$Pin.name)
    $needInstall = $true
    if (Test-Path -LiteralPath $exe) {
        $installed = ''
        try { $installed = (& $exe version 2>$null | Select-Object -First 1 | Out-String).Trim() } catch { }
        if ($installed -match [regex]::Escape([string]$Pin.version)) {
            Write-F60Log ('[F60 tailscale] already installed at the pinned version ' + [string]$Pin.version + ' - skipping the MSI')
            $needInstall = $false
        }
    }
    if ($needInstall) {
        $null = Get-F60File -Url ([string]$Pin.url) -Out $msi -Label 'Tailscale MSI' -ExpectedSha ([string]$Pin.sha256)
        Write-F60Log '[F60 tailscale] installing the pinned MSI silently'
        $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/quiet', '/norestart') -Wait -PassThru
        if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw ('[F60 tailscale] msiexec exited ' + $p.ExitCode) }
    }
    if (-not (Test-Path -LiteralPath $exe)) { throw '[F60 tailscale] tailscale.exe not present after the MSI install' }
    # The auth key is handed over as file:<path> (the repo's
    # Provision-GhrdpVps.ps1 pattern) so it never appears in a process command
    # line, and the temp file is deleted in the finally block.
    $keyFile = Join-Path $env:TEMP ('f60-tskey-' + [guid]::NewGuid().ToString('N') + '.key')
    try {
        [System.IO.File]::WriteAllText($keyFile, $AuthKey, (New-Object System.Text.UTF8Encoding($false)))
        try { icacls.exe $keyFile /inheritance:r 2>&1 | Out-Null; icacls.exe $keyFile /grant:r 'SYSTEM:(F)' 2>&1 | Out-Null; $LASTEXITCODE = 0 } catch { }
        $upArgs = @('up', ('--auth-key=file:' + $keyFile), ('--advertise-tags=' + $Tag), ('--hostname=' + $Hostname), '--unattended', '--accept-routes=false')
        & $exe @upArgs 2>&1 | ForEach-Object { Write-F60Log '[F60 tailscale up]' ([string]$_) }
        $LASTEXITCODE = 0
    } finally {
        Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
    }
    return $exe
}

function Get-F60TailscaleFacts {
    param([string]$Exe)
    $raw = ''
    try { $raw = (& $Exe status --json 2>$null | Out-String) } catch { $raw = '' }
    if (-not $raw) { return @{ ok = $false; magicDns = ''; tailnetIp = ''; online = $false; reason = 'tailscale-status-empty' } }
    $j = $null
    try { $j = $raw | ConvertFrom-Json } catch { return @{ ok = $false; magicDns = ''; tailnetIp = ''; online = $false; reason = 'tailscale-status-unparsed' } }
    $dns = ''
    $ip = ''
    $online = $false
    if ($j -and $j.Self) {
        $online = [bool]$j.Self.Online
        $dns = [string]$j.Self.DNSName
        if ($dns.EndsWith('.')) { $dns = $dns.Substring(0, $dns.Length - 1) }
        try { $ip = [string]@($j.Self.TailscaleIPs)[0] } catch { $ip = '' }
    }
    if (-not $dns) { return @{ ok = $false; magicDns = ''; tailnetIp = $ip; online = $online; reason = 'magicdns-name-unavailable' } }
    return @{ ok = $true; magicDns = $dns; tailnetIp = $ip; online = $online; reason = '' }
}

function Get-F60Stamp {
    # Idempotency ledger: <state>\<name>.pin holds the sha256 the artifact was
    # installed from. A pin CHANGE re-installs; an unchanged pin skips.
    param([string]$Root, [string]$Name)
    $p = Join-Path (Join-Path $Root 'state') ($Name + '.pin')
    if (Test-Path -LiteralPath $p) {
        try { return ([System.IO.File]::ReadAllText($p)).Trim().ToLowerInvariant() } catch { return '' }
    }
    return ''
}

function Write-F60Stamp {
    param([string]$Root, [string]$Name, [string]$Sha)
    $dir = Join-Path $Root 'state'
    $null = New-F60Dir -Path $dir
    try {
        [System.IO.File]::WriteAllText((Join-Path $dir ($Name + '.pin')), ([string]$Sha).Trim().ToLowerInvariant(), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Install-F60Nssm {
    param([object]$Pin, [string]$Downloads, [string]$Tools, [string]$Root)
    $exe = Join-Path $Tools 'nssm.exe'
    $want = ([string]$Pin.sha256).Trim().ToLowerInvariant()
    if ((Test-Path -LiteralPath $exe) -and ((Get-F60Stamp -Root $Root -Name 'nssm') -eq $want)) {
        Write-F60Log '[F60 nssm] already staged at the pinned sha256 - skipping (idempotent)'
        return $exe
    }
    $zip = Join-Path $Downloads ([string]$Pin.name)
    $null = Get-F60File -Url ([string]$Pin.url) -Out $zip -Label 'NSSM' -ExpectedSha ([string]$Pin.sha256)
    $tmpX = Join-Path $Downloads ('nssm-x-' + [guid]::NewGuid().ToString('N'))
    $null = New-F60Dir -Path $tmpX
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmpX)
    $found = Get-ChildItem -Path $tmpX -Recurse -Filter 'nssm.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1
    if (-not $found) { $found = Get-ChildItem -Path $tmpX -Recurse -Filter 'nssm.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $found) { throw '[F60 nssm] win64\nssm.exe not found in the pinned zip' }
    Copy-Item -LiteralPath $found.FullName -Destination $exe -Force
    Remove-Item -LiteralPath $tmpX -Recurse -Force -ErrorAction SilentlyContinue
    Write-F60Stamp -Root $Root -Name 'nssm' -Sha $want
    Write-F60Log ('[F60 nssm] staged ' + $exe)
    return $exe
}

function Install-F60Node {
    param([object]$Pin, [string]$Downloads, [string]$Tools)
    $nodeExe = Join-Path $Tools 'node\node.exe'
    if ((Test-Path -LiteralPath $nodeExe) -and ([string]$Pin.version)) {
        $v = ''
        try { $v = (& $nodeExe --version 2>$null | Out-String).Trim() } catch { $v = '' }
        if ($v -eq ('v' + [string]$Pin.version)) {
            Write-F60Log ('[F60 node] already installed at the pinned version ' + $v + ' - skipping')
            return $nodeExe
        }
    }
    $zip = Join-Path $Downloads ([string]$Pin.name)
    $null = Get-F60File -Url ([string]$Pin.url) -Out $zip -Label ('Node ' + [string]$Pin.version) -ExpectedSha ([string]$Pin.sha256)
    $tmpX = Join-Path $Downloads ('node-x-' + [guid]::NewGuid().ToString('N'))
    $null = New-F60Dir -Path $tmpX
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmpX)
    $inner = Get-ChildItem -Path $tmpX -Directory | Select-Object -First 1
    if (-not $inner) { throw '[F60 node] the pinned zip did not contain a distribution directory' }
    $dest = Join-Path $Tools 'node'
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue }
    Copy-Item -LiteralPath $inner.FullName -Destination $dest -Recurse -Force
    Remove-Item -LiteralPath $tmpX -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw '[F60 node] node.exe missing after extraction' }
    Write-F60Log ('[F60 node] installed ' + $nodeExe + ' (' + ((& $nodeExe --version 2>$null | Out-String).Trim()) + ')')
    return $nodeExe
}

function Install-F60ActionsRunner {
    param([object]$Pin, [string]$Downloads, [string]$RunnerDir, [string]$RepoUrl, [string]$Token, [string]$Name, [string]$Labels, [string]$Root)
    $null = New-F60Dir -Path $RunnerDir
    $dotRunner = Join-Path $RunnerDir '.runner'
    $already = $false
    if (Test-Path -LiteralPath $dotRunner) {
        $svc = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'actions.runner.*' } | Select-Object -First 1)
        if ($svc) {
            Write-F60Log ('[F60 runner] already configured (' + $svc[0].Name + '=' + $svc[0].Status + ') - skipping config.cmd (idempotent re-run)')
            $already = $true
        }
    }
    $zip = Join-Path $Downloads ([string]$Pin.name)
    if (-not $already) {
        $stamp = Get-F60Stamp -Root $Root -Name 'actions-runner'
        $want = ([string]$Pin.sha256).Trim().ToLowerInvariant()
        if ($stamp -and ($stamp -ne $want)) {
            Write-F60Log ('[F60 runner] the pinned runner version changed (' + $stamp.Substring(0, 12) + ' -> ' + $want.Substring(0, 12) + ') - re-extracting; config.cmd is re-run with --replace')
        }
        $null = Get-F60File -Url ([string]$Pin.url) -Out $zip -Label ('actions/runner ' + [string]$Pin.version) -ExpectedSha ([string]$Pin.sha256)
        if (-not (Test-Path -LiteralPath (Join-Path $RunnerDir 'config.cmd'))) {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $RunnerDir)
            Write-F60Log '[F60 runner] extracted into C:\actions-runner'
        }
        if (-not $Token) { throw '[F60 runner] no registration token supplied - cannot configure the runner' }
        $cfg = Join-Path $RunnerDir 'config.cmd'
        if (-not (Test-Path -LiteralPath $cfg)) { throw '[F60 runner] config.cmd missing after extraction' }
        $cfgArgs = @('--url', $RepoUrl, '--token', $Token, '--labels', $Labels, '--name', $Name, '--runasservice', '--unattended', '--replace')
        Push-Location $RunnerDir
        try {
            & cmd.exe /c 'config.cmd' @cfgArgs 2>&1 | ForEach-Object { Write-F60Log '[F60 runner config]' ([string]$_) }
            $LASTEXITCODE = 0
        } finally {
            Pop-Location
        }
        if (-not (Test-Path -LiteralPath $dotRunner)) { throw '[F60 runner] config.cmd did not produce .runner - registration failed' }
        Write-F60Stamp -Root $Root -Name 'actions-runner' -Sha ([string]$Pin.sha256)
    }
    $svc2 = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'actions.runner.*' } | Select-Object -First 1)
    if ($svc2) {
        try {
            if ($svc2[0].Status -ne 'Running') { Start-Service -Name $svc2[0].Name -ErrorAction Stop }
            Write-F60Log ('[F60 runner] service ' + $svc2[0].Name + '=' + (Get-Service -Name $svc2[0].Name).Status)
        } catch {
            Write-F60Log -Msg '[F60 runner] service start failed' -Detail $_.Exception.Message
        }
    } else {
        Write-F60Log '[F60 runner] WARNING no actions.runner.* service found after config'
    }
    return @{ dir = $RunnerDir; configured = $true; service = $(if ($svc2) { $svc2[0].Name } else { '' }) }
}

# ---------------------------------------------------------------------------
# NSSM services
# ---------------------------------------------------------------------------
function Register-F60NssmService {
    # Idempotent: an existing service is left alone (or restarted when asked);
    # nothing is re-created on a re-run. Automatic start + LocalSystem + logs under
    # C:\ghrdp\logs (OUTSIDE the runner job tree, so a job cleanup can never delete
    # a service's evidence).
    param(
        [string]$Nssm,
        [string]$Name,
        [string]$Exe,
        [string]$Arguments = '',
        [string]$AppDir = '',
        [string]$LogDir = 'C:\ghrdp\logs',
        [string[]]$Environment = @(),
        [bool]$Start = $true
    )
    $null = New-F60Dir -Path $LogDir
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($svc) {
        Write-F60Log ('[F60 svc] ' + $Name + ' already exists (' + $svc.Status + ') - not re-created (idempotent)')
        if ($Start -and $svc.Status -ne 'Running') {
            try { Start-Service -Name $Name -ErrorAction Stop; Write-F60Log ('[F60 svc] ' + $Name + ' started') } catch { Write-F60Log ('[F60 svc] ' + $Name + ' start failed', $_.Exception.Message) }
        }
        return @{ name = $Name; created = $false; status = [string](Get-Service -Name $Name -ErrorAction SilentlyContinue).Status }
    }
    if (-not (Test-Path -LiteralPath $Exe)) { throw ('[F60 svc] ' + $Name + ': executable missing at ' + $Exe) }
    $installArgs = @('install', $Name, $Exe)
    if ($Arguments) { $installArgs += $Arguments }
    & $Nssm @installArgs 2>&1 | Out-Null
    $LASTEXITCODE = 0
    & $Nssm set $Name Start 'SERVICE_AUTO_START' 2>&1 | Out-Null
    & $Nssm set $Name ObjectName 'LocalSystem' 2>&1 | Out-Null
    & $Nssm set $Name AppStdout (Join-Path $LogDir ($Name + '.out.log')) 2>&1 | Out-Null
    & $Nssm set $Name AppStderr (Join-Path $LogDir ($Name + '.err.log')) 2>&1 | Out-Null
    & $Nssm set $Name AppRotateFiles 1 2>&1 | Out-Null
    & $Nssm set $Name AppRotateBytes 10485760 2>&1 | Out-Null
    if ($AppDir) { & $Nssm set $Name AppDirectory $AppDir 2>&1 | Out-Null }
    if (@($Environment).Count -gt 0) { & $Nssm set $Name AppEnvironmentExtra @Environment 2>&1 | Out-Null }
    $LASTEXITCODE = 0
    $status = 'Stopped'
    if ($Start) {
        try { & $Nssm start $Name 2>&1 | Out-Null; Start-Sleep -Seconds 2; $status = [string](Get-Service -Name $Name -ErrorAction SilentlyContinue).Status } catch { }
    }
    Write-F60Log ('[F60 svc] ' + $Name + ' created (Automatic, LocalSystem, logs in ' + $LogDir + ') status=' + $status)
    return @{ name = $Name; created = $true; status = $status }
}

function New-F60RandomSecret {
    param([int]$Length = 32)
    $chars = @()
    $chars += (48..57)
    $chars += (65..90)
    $chars += (97..122)
    return (-join ((1..$Length) | ForEach-Object { [char]($chars | Get-Random) }))
}

function Write-F60SecretFile {
    # SYSTEM/Administrators only, same shape as main.yml's aria2/qbt secret files.
    param([string]$Path, [string]$Value)
    $dir = Split-Path -Parent $Path
    if ($dir) { $null = New-F60Dir -Path $dir }
    [System.IO.File]::WriteAllText($Path, $Value, (New-Object System.Text.UTF8Encoding($false)))
    try { icacls.exe $Path /inheritance:r 2>&1 | Out-Null; icacls.exe $Path /grant:r 'SYSTEM:(F)' 'Administrators:(F)' 2>&1 | Out-Null; $LASTEXITCODE = 0 } catch { }
    return $Path
}

# ---------------------------------------------------------------------------
# repo staging (the dashboard-critical subset main.yml also stages)
# ---------------------------------------------------------------------------
function Get-F60StageList {
    # ONE list, asserted by the node gate against main.yml's own staging step: if
    # main.yml starts dot-sourcing a new module, this list must grow with it or the
    # gate goes red. ghrdp-install.ps1 and the handler kit keep main.yml's
    # substitution rules (__BUILD_SHA__, __HELPER_B64__, exactly 2 kit entries).
    return @(
        'payloads/ghrdp-lib.ps1',
        'payloads/ghrdp-server.ps1',
        'payloads/ghrdp-fx.ps1',
        'payloads/ghrdp-mirror.ps1',
        'payloads/ghrdp-mirror-progress.cs',
        'payloads/ghrdp-aria2.ps1',
        'payloads/ghrdp-qbt.ps1',
        'payloads/ghrdp-qbt-policy.json',
        'payloads/rdp-telescope.ps1',
        'payloads/ghrdp-watcher.ps1',
        'payloads/ghrdp-pub2.ps1',
        'payloads/ghrdp-bootstrap-session.ps1',
        'payloads/ghrdp-launcher.ps1',
        'payloads/ghrdp-client-install.ps1',
        'payloads/ghrdp-rdp-launcher.cs',
        'payloads/ghrdp-rdp-launcher.ps1',
        'payloads/install.cmd',
        'payloads/DEBUG-GHRDP.ps1',
        'payloads/DEBUG-GHRDP.bat',
        'payloads/explorer.html',
        'payloads/web-index-template.html',
        'payloads/webdesk-ui.html',
        'payloads/ui.html',
        'payloads/fonts/noto-sans-sinhala-400-latin-free.woff2',
        'payloads/fonts/noto-sans-sinhala-600-latin-free.woff2',
        'payloads/f59-prebuilt-pins.json',
        'payloads/f59-prebuilt-verify.ps1',
        'payloads/f59-timing.ps1',
        'payloads/f60-warm-pins.json',
        'payloads/ghrdp-install.template.ps1',
        'payloads/helper-ghrdp-connect.ps1',
        'scripts/serve-dist.mjs',
        'scripts/f59-verify-sha256.mjs',
        'scripts/f60-health.ps1',
        'scripts/f60-bootstrap.ps1',
        'scripts/f60-stage-and-start.ps1',
        'scripts/f60-scrub-runcommand.ps1'
    )
}

function Stage-F60RepoFiles {
    param([string]$Root, [string]$Owner, [string]$Repo, [string]$Ref, [string]$Token, [string]$BuildSha)
    $src = New-F60Dir -Path (Join-Path $Root 'stage-src')
    $staged = 0
    $missing = @()
    foreach ($rel in (Get-F60StageList)) {
        $out = Join-Path $src ($rel -replace '/', '\')
        try {
            $null = Get-F60RepoFile -RelPath $rel -Out $out -Owner $Owner -Repo $Repo -Ref $Ref -Token $Token
            $staged++
        } catch {
            $missing += $rel
            Write-F60Log -Msg ('[F60 stage] MISSING ' + $rel) -Detail $_.Exception.Message
        }
    }
    if ($staged -lt 20) { throw ('[F60 stage] only ' + $staged + ' repo files staged (expected >=20) - refusing to register services against a half-staged tree') }
    # copy into C:\ghrdp: payloads land FLAT next to ghrdp-server.ps1 (where it
    # dot-sources them), scripts/ land in tools\, fonts keep their subdirectory.
    foreach ($rel in (Get-F60StageList)) {
        $from = Join-Path $src ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $from)) { continue }
        $leaf = Split-Path -Leaf $from
        $to = Join-Path $Root $leaf
        if ($rel -like 'scripts/*') { $to = Join-Path (New-F60Dir -Path (Join-Path $Root 'tools')) $leaf }
        if ($rel -like 'payloads/fonts/*') { $to = Join-Path (New-F60Dir -Path (Join-Path $Root 'fonts')) $leaf }
        Copy-Item -LiteralPath $from -Destination $to -Force
    }
    # main.yml's two substitutions, mirrored exactly.
    $ui = Join-Path $Root 'ui.html'
    if (Test-Path -LiteralPath $ui) {
        $txt = [System.IO.File]::ReadAllText($ui)
        $txt = $txt.Replace('__BUILD_SHA__', [string]$BuildSha)
        [System.IO.File]::WriteAllText($ui, $txt, (New-Object System.Text.UTF8Encoding($false)))
    }
    $helper = Join-Path $src 'payloads\helper-ghrdp-connect.ps1'
    $tmpl = Join-Path $src 'payloads\ghrdp-install.template.ps1'
    if ((Test-Path -LiteralPath $helper) -and (Test-Path -LiteralPath $tmpl)) {
        $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($helper))
        $inst = ([System.IO.File]::ReadAllText($tmpl)).Replace('__HELPER_B64__', $b64)
        [System.IO.File]::WriteAllText((Join-Path $Root 'ghrdp-install.ps1'), $inst, (New-Object System.Text.UTF8Encoding($false)))
    }
    # F14 kit: EXACTLY install.cmd + ghrdp-rdp-launcher.cs.
    $cmd = Join-Path $Root 'install.cmd'
    $lcs = Join-Path $Root 'ghrdp-rdp-launcher.cs'
    if ((Test-Path -LiteralPath $cmd) -and (Test-Path -LiteralPath $lcs)) {
        $kit = Join-Path $Root 'ghrdp-handler-kit.zip'
        Remove-Item -LiteralPath $kit -Force -ErrorAction SilentlyContinue
        Compress-Archive -Path $cmd, $lcs -DestinationPath $kit -Force
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $z = [System.IO.Compression.ZipFile]::OpenRead($kit)
        $count = @($z.Entries).Count
        $z.Dispose()
        if ($count -ne 2) { throw ('[F60 stage] ghrdp-handler-kit.zip must hold EXACTLY 2 files, got ' + $count) }
    }
    Write-F60Log ('[F60 stage] repo files staged=' + $staged + '/' + @(Get-F60StageList).Count + ' missing=' + $(if (@($missing).Count) { ($missing -join ',') } else { 'none' }))
    return @{ staged = $staged; missing = @($missing) }
}

function Stage-F60Binaries {
    param([string]$Root, [object]$F59Pins, [string]$Owner, [string]$Repo, [string]$Token)
    $tag = [string]$F59Pins.release_tag
    $dl = New-F60Dir -Path (Join-Path $Root 'downloads')
    $binDir = New-F60Dir -Path (Join-Path $Root 'bin')
    # aria2c
    $ariaOut = Join-Path $binDir 'aria2c.exe'
    $null = Get-F60ReleaseAsset -Tag $tag -Name ([string]$F59Pins.assets.aria2c.name) -Out $ariaOut -Label 'aria2c' -ExpectedSha ([string]$F59Pins.assets.aria2c.sha256) -Owner $Owner -Repo $Repo -Token $Token
    # qBittorrent (zip -> %ProgramFiles%\qBittorrent, the root the shipped resolver searches)
    $qbtZip = Join-Path $dl ([string]$F59Pins.assets.qbittorrent.name)
    $null = Get-F60ReleaseAsset -Tag $tag -Name ([string]$F59Pins.assets.qbittorrent.name) -Out $qbtZip -Label 'qBittorrent' -ExpectedSha ([string]$F59Pins.assets.qbittorrent.sha256) -Owner $Owner -Repo $Repo -Token $Token
    $qbtDir = Join-Path $env:ProgramFiles 'qBittorrent'
    $qbtExe = Get-ChildItem -LiteralPath $qbtDir -Recurse -Include 'qbittorrent-nox.exe', 'qbittorrent.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $qbtExe) {
        $null = New-F60Dir -Path $qbtDir
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($qbtZip, $qbtDir)
        Write-F60Log ('[F60 stage] qBittorrent expanded into ' + $qbtDir)
    } else {
        Write-F60Log ('[F60 stage] qBittorrent already present at ' + $qbtExe.FullName + ' - not re-expanded (idempotent)')
    }
    return @{ aria2c = $ariaOut; qbittorrentDir = $qbtDir }
}

function Stage-F60UiBundle {
    param([string]$Root, [string]$Tag, [string]$BundleSha, [string]$Owner, [string]$Repo, [string]$Token, [string]$NodeExe)
    $dl = New-F60Dir -Path (Join-Path $Root 'downloads')
    $rel = Get-F60ReleaseAssetInfo -Tag $Tag -Owner $Owner -Repo $Repo -Token $Token
    $assets = @($rel.assets)
    $want = ''
    if ($BundleSha) { $want = ('ui-dist-' + $BundleSha + '.zip') }
    $pick = $null
    if ($want) { $pick = @($assets | Where-Object { [string]$_.name -eq $want } | Select-Object -First 1) }
    if (-not $pick) {
        # [F77 §2.5] the cross-sha "newest asset" pick is only allowed when NO
        # commit was pinned. With -UiBundleSha set, a miss throws instead of
        # silently staging another commit's dashboard (the stale-bundle class).
        if ($want) { throw ('[F77 ui] release ' + $Tag + ' has no ' + $want + ' - the bundle for this commit was never published (build-ui.yml still running or skipped by its paths filter); refusing to stage a bundle from another commit. Dispatch build-ui.yml for this sha and re-run.') }
        $cands = @($assets | Where-Object { ([string]$_.name) -like 'ui-dist-*.zip' -and ([string]$_.name) -notlike '*.sha256' })
        if (@($cands).Count -eq 0) { throw ('[F60 ui] release ' + $Tag + ' has no ui-dist-*.zip asset') }
        $pick = @($cands | Sort-Object -Property name -Descending | Select-Object -First 1)
    }
    $zipName = [string]$pick.name
    $zipOut = Join-Path $dl $zipName
    $sideName = ($zipName + '.sha256')
    $sideAsset = @($assets | Where-Object { [string]$_.name -eq $sideName } | Select-Object -First 1)
    if (-not $sideAsset) { throw ('[F60 ui] the ui-dist release has no sidecar ' + $sideName + ' - refusing an unverifiable bundle') }
    $sideOut = Join-Path $dl $sideName
    $null = Get-F60File -Url ([string]$sideAsset.url) -Out $sideOut -Label 'ui-dist sidecar' -AuthToken $Token -Accept 'application/octet-stream' -MinBytes 8 -NoPin
    # the sidecar IS the pin for a commit-built bundle; the shipped node verifier
    # (scripts/f59-verify-sha256.mjs) is fail-closed exactly as in main.yml.
    $expected = ([System.IO.File]::ReadAllText($sideOut)).Trim()
    $null = Test-F60PinShape -Expected $expected -Label 'ui-dist sidecar digest'
    $null = Get-F60File -Url ([string]$pick.url) -Out $zipOut -Label ('ui bundle ' + $zipName) -ExpectedSha $expected -AuthToken $Token -Accept 'application/octet-stream' -MinBytes 51200
    if ($NodeExe -and (Test-Path -LiteralPath $NodeExe)) {
        $verifier = Join-Path $Root 'tools\f59-verify-sha256.mjs'
        if (Test-Path -LiteralPath $verifier) {
            & $NodeExe $verifier $zipOut $expected --label $zipName 2>&1 | ForEach-Object { Write-F60Log '[F60 ui verify]' ([string]$_) }
            if ($LASTEXITCODE -ne 0) { throw ('[F60 ui] the shipped fail-closed verifier rejected ' + $zipName) }
            $LASTEXITCODE = 0
        }
    }
    $uiDir = New-F60Dir -Path (Join-Path $Root 'ui')
    $idx = Join-Path $uiDir 'index.html'
    Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [System.IO.Compression.ZipFile]::OpenRead($zipOut)
    $entry = @($z.Entries | Where-Object { $_.Name -eq 'index.html' } | Select-Object -First 1)
    if (-not $entry) { $z.Dispose(); throw '[F60 ui] the bundle has no index.html entry' }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $idx, $true)
    $z.Dispose()
    $bytes = (Get-Item -LiteralPath $idx).Length
    if ($bytes -le 51200) { throw ('[F60 ui] ui-v2.html staging failed - bundle too small (' + $bytes + ' bytes)') }
    Copy-Item -LiteralPath $idx -Destination (Join-Path $Root 'ui-v2.html') -Force
    Write-F60Log ('[F60 ui] staged ' + $zipName + ' -> ui\index.html + ui-v2.html (' + $bytes + ' bytes, sidecar-verified)')
    return @{ asset = $zipName; bytes = $bytes }
}

function Clear-F60RunCommandSecrets {
    # Azure writes the run-command PARAMETERS (Tailscale auth key, runner
    # registration token, repo access token) into the extension's RuntimeSettings
    # files on the VM. They are used once. This deletes them so a later disk read
    # cannot recover them.
    #
    # The NEWEST settings file is deliberately KEPT: it belongs to the invocation
    # that is running right now, and deleting it mid-run can stop the extension
    # from reporting its status back to Azure (which would read as a failed
    # provision even though the script succeeded). The provisioning workflow
    # therefore runs scripts/f60-scrub-runcommand.ps1 AFTER this script returns:
    # that second, parameter-free invocation becomes the newest file and removes
    # the secret-bearing one.
    param([switch]$IncludeNewest)
    $removed = 0
    $kept = 0
    foreach ($plugin in @('Microsoft.Compute.RunCommandExtension', 'Microsoft.Compute.CustomScriptExtension')) {
        $base = Join-Path 'C:\Packages\Plugins' $plugin
        if (-not (Test-Path -LiteralPath $base)) { continue }
        $files = @(Get-ChildItem -Path $base -Recurse -Filter '*.settings' -File -ErrorAction SilentlyContinue | Sort-Object -Property LastWriteTimeUtc -Descending)
        $i = 0
        foreach ($f in $files) {
            $i++
            if (($i -eq 1) -and (-not $IncludeNewest)) { $kept++; continue }
            try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $removed++ } catch { }
        }
    }
    Write-F60Log ('[F60 hygiene] removed ' + $removed + ' Run Command runtime-settings file(s); kept ' + $kept + ' (the current invocation - scrubbed by the post-run step)')
    return $removed
}

function Mount-F60DataDisk {
    # The shipped lane's storage roots are on D: (policy savePath
    # D:\RDP-Storage\Fetched, the .trash tree, aria2's session dir). A fresh Azure
    # VM only has C:, so the data disk the provisioning workflow attaches
    # (--data-disk-sizes-gb) is initialized and mounted as D: here - idempotent,
    # and it never touches a disk that already has partitions.
    param([string]$DriveLetter = 'D')
    if (Test-Path -LiteralPath ($DriveLetter + ':\')) {
        Write-F60Log ('[F60 disk] ' + $DriveLetter + ': already present - skipping the format')
        return $true
    }
    try {
        $raw = @(Get-Disk -ErrorAction Stop | Where-Object { $_.PartitionStyle -eq 'RAW' -and $_.OperationalState -ne 'offline' })
        if (@($raw).Count -eq 0) {
            Write-F60Log ('[F60 disk] WARNING no RAW data disk to mount as ' + $DriveLetter + ': - the storage roots stay on C:\RDP-Storage')
            return $false
        }
        $d = $raw[0]
        $null = Initialize-Disk -Number $d.Number -PartitionStyle GPT -PassThru
        $part = New-Partition -DiskNumber $d.Number -DriveLetter $DriveLetter -UseMaximumSize
        $null = Format-Volume -Partition $part -FileSystem NTFS -NewFileSystemLabel 'RDP-Storage' -Confirm:$false
        Write-F60Log ('[F60 disk] data disk ' + $d.Number + ' formatted NTFS and mounted as ' + $DriveLetter + ':')
        return $true
    } catch {
        Write-F60Log -Msg ('[F60 disk] WARNING could not mount a data disk as ' + $DriveLetter + ':') -Detail $_.Exception.Message
        return $false
    }
}

function Get-F60StorageRoot {
    # D:\RDP-Storage when the data disk mounted, C:\RDP-Storage otherwise. The
    # value is reported (never silently assumed) so a run without a D: is visible.
    param([bool]$HasDataDisk)
    if ($HasDataDisk) { return 'D:\RDP-Storage' }
    return 'C:\RDP-Storage'
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
function Invoke-F60Bootstrap {
    param(
        [string]$TailscaleAuthKey,
        [string]$RunnerToken,
        [string]$RepoUrl,
        [string]$UiReleaseTag,
        [string]$RepoAccessToken,
        [string]$RepoRef,
        [string]$UiBundleSha,
        [string]$Root,
        [string]$RunnerDir,
        [string]$RunnerName,
        [string]$RunnerLabels,
        [string]$Hostname,
        [string]$TailscaleTag,
        [string]$PinsJson,
        [bool]$SkipRunner,
        [bool]$SkipDownloads
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # --- 1. parameter validation (fail-closed, before anything is touched) ---
    foreach ($p in @(@('RepoUrl', $RepoUrl), @('RepoAccessToken', $RepoAccessToken), @('UiReleaseTag', $UiReleaseTag))) {
        if ([string]::IsNullOrWhiteSpace([string]$p[1])) { throw ('[F60 bootstrap] missing required parameter ' + [string]$p[0]) }
    }
    if (-not $SkipRunner -and [string]::IsNullOrWhiteSpace($RunnerToken)) { throw '[F60 bootstrap] missing required parameter RunnerToken' }
    if ([string]::IsNullOrWhiteSpace($TailscaleAuthKey)) { throw '[F60 bootstrap] missing required parameter TailscaleAuthKey' }
    foreach ($s in @($TailscaleAuthKey, $RunnerToken, $RepoAccessToken)) { Add-F60Secret -Value $s }

    $ownerRepo = Get-F60RepoOwner -RepoUrl $RepoUrl
    if (-not $RepoRef) { $RepoRef = 'main' }

    # --- 2. data disk + directories ---
    $hasDataDisk = Mount-F60DataDisk -DriveLetter 'D'
    $storageRoot = Get-F60StorageRoot -HasDataDisk $hasDataDisk
    $ariaHome = $(if ($hasDataDisk) { 'D:\ghrdp\aria2' } else { (Join-Path $Root 'aria2') })
    if (-not $hasDataDisk) {
        Write-F60Log ('[F60 disk] WARNING no D: volume - the storage roots move to ' + $storageRoot + ' while the shipped qBittorrent policy still names D:\RDP-Storage\Fetched; the torrent lane stays unavailable until a data disk exists')
    }
    $dl = New-F60Dir -Path (Join-Path $Root 'downloads')
    $null = New-F60Dir -Path (Join-Path $Root 'state')
    $tools = New-F60Dir -Path (Join-Path $Root 'tools')
    $null = New-F60Dir -Path (Join-Path $Root 'ui')
    $logs = New-F60Dir -Path (Join-Path $Root 'logs')
    $null = New-F60Dir -Path (Join-Path $Root 'bin')
    $null = New-F60Dir -Path $ariaHome
    $null = New-F60Dir -Path (Join-Path $storageRoot 'Fetched')
    $null = New-F60Dir -Path $RunnerDir
    $script:F60LogPath = Join-Path $logs ('f60-bootstrap-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') + '.log')
    Write-F60Log ('[F60 bootstrap] start root=' + $Root + ' runner=' + $RunnerDir + ' ref=' + $RepoRef + ' storage=' + $storageRoot + ' log=' + $script:F60LogPath)

    # --- 3. stage the repo (authoritative pins + shipped modules) ---
    $stageInfo = @{ staged = 0; missing = @() }
    if (-not $SkipDownloads) {
        $stageInfo = Stage-F60RepoFiles -Root $Root -Owner $ownerRepo.owner -Repo $ownerRepo.repo -Ref $RepoRef -Token $RepoAccessToken -BuildSha $(if ($UiBundleSha) { $UiBundleSha } else { $RepoRef })
    }
    $verifierPath = Join-Path $Root 'f59-prebuilt-verify.ps1'
    if (Test-Path -LiteralPath $verifierPath) {
        . $verifierPath
        $script:F60Verifier = $verifierPath
        Write-F60Log '[F60 bootstrap] the SHIPPED F59 fail-closed verifier is loaded (payloads/f59-prebuilt-verify.ps1)'
    } else {
        Write-F60Log '[F60 bootstrap] WARNING the shipped F59 verifier is not staged - using the byte-identical local fail-closed check'
    }

    # --- 4. pins (fail-closed on shape BEFORE any download) ---
    $pins = $null
    if ($PinsJson) {
        try { $pins = $PinsJson | ConvertFrom-Json } catch { throw ('[F60 bootstrap] PinsJson is not parseable JSON: ' + $_.Exception.Message) }
    } else {
        $pinsFile = Join-Path $Root 'f60-warm-pins.json'
        if (-not (Test-Path -LiteralPath $pinsFile)) { throw '[F60 bootstrap] payloads/f60-warm-pins.json was not staged - refusing to install anything unpinned' }
        $pins = ([System.IO.File]::ReadAllText($pinsFile)) | ConvertFrom-Json
    }
    foreach ($k in @('tailscale_msi', 'nssm', 'node_win_x64_zip', 'actions_runner_win_x64_zip')) {
        $a = $pins.assets.$k
        if (-not $a) { throw ('[F60 bootstrap] the pins file has no entry for ' + $k) }
        $null = Test-F60PinShape -Expected ([string]$a.sha256) -Label ('pin:' + $k)
        if (-not ([string]$a.url).StartsWith('https://')) { throw ('[F60 bootstrap] pin:' + $k + ' has a non-https URL') }
    }
    $f59File = Join-Path $Root 'f59-prebuilt-pins.json'
    if (-not (Test-Path -LiteralPath $f59File)) { throw '[F60 bootstrap] payloads/f59-prebuilt-pins.json was not staged - refusing (the F59 pins are the aria2c/qBittorrent contract)' }
    $f59 = ([System.IO.File]::ReadAllText($f59File)) | ConvertFrom-Json
    foreach ($k in @('aria2c', 'qbittorrent')) {
        $null = Test-F60PinShape -Expected ([string]$f59.assets.$k.sha256) -Label ('f59-pin:' + $k)
    }
    Write-F60Log ('[F60 bootstrap] pins OK: tailscale=' + [string]$pins.assets.tailscale_msi.version + ' nssm=' + [string]$pins.assets.nssm.version + ' node=' + [string]$pins.assets.node_win_x64_zip.version + ' runner=' + [string]$pins.assets.actions_runner_win_x64_zip.version)

    # --- 5. Tailscale (pinned MSI, auth key by file:) ---
    $magicDns = ''
    $tailnetIp = ''
    $tsExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (-not $SkipDownloads) {
        $tsExe = Install-F60Tailscale -Pin $pins.assets.tailscale_msi -Downloads $dl -AuthKey $TailscaleAuthKey -Tag $TailscaleTag -Hostname $Hostname
    }
    $facts = Get-F60TailscaleFacts -Exe $tsExe
    if ($facts.ok) {
        $magicDns = [string]$facts.magicDns
        $tailnetIp = [string]$facts.tailnetIp
        Write-F60Log ('[F60 tailscale] online=' + $facts.online + ' magicdns=' + $magicDns + ' cgnat=' + $tailnetIp)
    } else {
        Write-F60Log ('[F60 tailscale] WARNING ' + [string]$facts.reason + ' - the warm VM is not reachable by MagicDNS yet')
    }

    # --- 6. NSSM + Node ---
    $nssm = Join-Path $tools 'nssm.exe'
    $nodeExe = Join-Path $tools 'node\node.exe'
    if (-not $SkipDownloads) {
        $nssm = Install-F60Nssm -Pin $pins.assets.nssm -Downloads $dl -Tools $tools -Root $Root
        $nodeExe = Install-F60Node -Pin $pins.assets.node_win_x64_zip -Downloads $dl -Tools $tools
    }

    # --- 7. aria2c + qBittorrent + the UI bundle (F59 release assets, pinned) ---
    if (-not $SkipDownloads) {
        $null = Stage-F60Binaries -Root $Root -F59Pins $f59 -Owner $ownerRepo.owner -Repo $ownerRepo.repo -Token $RepoAccessToken
        $null = Stage-F60UiBundle -Root $Root -Tag $UiReleaseTag -BundleSha $UiBundleSha -Owner $ownerRepo.owner -Repo $ownerRepo.repo -Token $RepoAccessToken -NodeExe $nodeExe
    }

    # --- 8. per-host secrets (aria2c RPC + qBittorrent WebUI) ---
    # Both are generated ONCE, stored SYSTEM/Administrators-only, reused on every
    # re-run (idempotent) and registered for redaction so they can never reach a
    # log line, the health JSON or the marker block.
    $ariaSecretFile = Join-Path $Root 'aria2-secret.txt'
    if (-not (Test-Path -LiteralPath $ariaSecretFile)) {
        $null = Write-F60SecretFile -Path $ariaSecretFile -Value (New-F60RandomSecret -Length 32)
        Write-F60Log '[F60 secret] aria2 RPC secret generated (SYSTEM-only ACL, never logged)'
    } else {
        Write-F60Log '[F60 secret] aria2 RPC secret already present - reused (idempotent)'
    }
    $ariaSecret = ([System.IO.File]::ReadAllText($ariaSecretFile)).Trim()
    Add-F60Secret -Value $ariaSecret
    $qbtSecretFile = Join-Path $Root 'qbt-secret.txt'
    if (-not (Test-Path -LiteralPath $qbtSecretFile)) {
        $null = Write-F60SecretFile -Path $qbtSecretFile -Value (New-F60RandomSecret -Length 32)
        Write-F60Log '[F60 secret] qBittorrent WebUI password generated (SYSTEM-only ACL, never logged)'
    } else {
        Write-F60Log '[F60 secret] qBittorrent WebUI password already present - reused (idempotent)'
    }
    $qbtSecret = ([System.IO.File]::ReadAllText($qbtSecretFile)).Trim()
    Add-F60Secret -Value $qbtSecret

    # --- 9. services (4 NSSM services; Tailscale is the 5th, MSI-installed) ---
    $svcResults = @()
    $qbtBound = ''
    $qbtReason = ''
    $qbtMod = Join-Path $Root 'ghrdp-qbt.ps1'
    if ((Test-Path -LiteralPath $qbtMod) -and (Test-Path -LiteralPath (Join-Path $Root 'ghrdp-qbt-policy.json'))) {
        try {
            . $qbtMod
            $env:GHRDP_QBT_PASSWORD = $qbtSecret
            $init = Initialize-GhrdpQbt -ConfigPath (Join-Path $Root 'config.json') -ConfPath (Join-Path $Root 'qbt\qBittorrent.conf')
            if ($init.ok) {
                $qbtBound = [string]$init.address
                Write-F60Log ('[F60 qbt] WebUI bind=' + $qbtBound + ' (' + $init.bindSource + ') port=' + $init.port + ' nox=' + $init.nox)
            } else {
                $qbtReason = [string]$init.reason
                Write-F60Log ('[F60 qbt] init refused with labeled reason ' + $qbtReason + ' - qbittorrent-nssm stays unstarted (Tailnet-only floor: never 0.0.0.0, never loopback)')
            }
        } catch {
            $qbtReason = $_.Exception.Message
            Write-F60Log '[F60 qbt] init threw' $qbtReason
        }
    } else {
        $qbtReason = 'qbt-module-not-staged'
    }

    # The CLI pins are main.yml's aria2c step, value for value (loopback RPC only,
    # 16 connections, 20M split, integrity on, metalink/torrent following OFF).
    $ariaSession = Join-Path $ariaHome 'session.gz'
    $ariaArgs = ('--enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 --rpc-secret=' + $ariaSecret + ' --dir=' + (Join-Path $storageRoot 'Fetched') + ' --max-connection-per-server=16 --split=16 --min-split-size=20M --continue=true --follow-metalink=false --follow-torrent=false --check-integrity=true --save-session=' + $ariaSession + ' --input-file=' + $ariaSession + ' --save-session-interval=60 --log=' + (Join-Path $logs 'aria2.log') + ' --log-level=notice')
    $ariaExe = Join-Path $Root 'bin\aria2c.exe'
    if (Test-Path -LiteralPath $ariaExe) {
        $svcResults += (Register-F60NssmService -Nssm $nssm -Name 'aria2c-nssm' -Exe $ariaExe -Arguments $ariaArgs -AppDir (Join-Path $Root 'bin') -LogDir $logs)
    } else {
        Write-F60Log '[F60 svc] aria2c-nssm NOT registered: C:\ghrdp\bin\aria2c.exe missing (download skipped or failed)'
    }

    $qbtExePath = ''
    $qbtDir = Join-Path $env:ProgramFiles 'qBittorrent'
    if (Test-Path -LiteralPath $qbtDir) {
        $hit = Get-ChildItem -LiteralPath $qbtDir -Recurse -Include 'qbittorrent-nox.exe', 'qbittorrent.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { $qbtExePath = $hit.FullName }
    }
    if ($qbtExePath) {
        $qbtArgs = '--webui-port=8080 --no-splash --profile=' + (Join-Path $Root 'qbt')
        $null = New-F60Dir -Path (Join-Path $Root 'qbt')
        $svcResults += (Register-F60NssmService -Nssm $nssm -Name 'qbittorrent-nssm' -Exe $qbtExePath -Arguments $qbtArgs -AppDir (Join-Path $Root 'qbt') -LogDir $logs -Start ([bool]$qbtBound))
    } else {
        Write-F60Log '[F60 svc] qbittorrent-nssm NOT registered: no qBittorrent executable under %ProgramFiles%\qBittorrent'
    }

    $uiServer = Join-Path $tools 'serve-dist.mjs'
    if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $uiServer)) {
        # PORT=4173 is scripts/serve-dist.mjs's own default (the repo's
        # zero-dependency static server). It binds 0.0.0.0, which on this VM means
        # tailnet-only: the NSG denies every inbound Internet rule (3389 and
        # all-ports), so nothing outside the tailnet can reach it.
        $svcResults += (Register-F60NssmService -Nssm $nssm -Name 'ghrdp-ui-nssm' -Exe $nodeExe -Arguments ($uiServer + ' ' + (Join-Path $Root 'ui')) -AppDir (Join-Path $Root 'ui') -LogDir $logs -Environment @('PORT=4173'))
    } else {
        Write-F60Log '[F60 svc] ghrdp-ui-nssm NOT registered: node.exe or scripts/serve-dist.mjs missing'
    }

    $serverPs1 = Join-Path $Root 'ghrdp-server.ps1'
    $pwshExe = 'powershell.exe'
    try { $c = Get-Command pwsh.exe -ErrorAction Stop; if ($c) { $pwshExe = $c.Source } } catch { }
    if (Test-Path -LiteralPath $serverPs1) {
        $svcResults += (Register-F60NssmService -Nssm $nssm -Name 'ghrdp-server-nssm' -Exe $pwshExe -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + $serverPs1 + '"') -AppDir $Root -LogDir $logs)
    } else {
        Write-F60Log '[F60 svc] ghrdp-server-nssm NOT registered: C:\ghrdp\ghrdp-server.ps1 missing'
    }

    # --- 10. the self-hosted runner ---
    $runnerInfo = @{ dir = $RunnerDir; configured = $false; service = '' }
    if ($SkipRunner) {
        Write-F60Log '[F60 runner] skipped (SkipRunner) - verify/teardown re-run'
    } elseif (-not $SkipDownloads) {
        $runnerInfo = Install-F60ActionsRunner -Pin $pins.assets.actions_runner_win_x64_zip -Downloads $dl -RunnerDir $RunnerDir -RepoUrl $RepoUrl -Token $RunnerToken -Name $RunnerName -Labels $RunnerLabels -Root $Root
    }

    # --- 11. health probe (the SHIPPED script, staged from the repo) ---
    $healthOk = $false
    $healthReasons = @()
    $healthPath = Join-Path $tools 'f60-health.ps1'
    if (Test-Path -LiteralPath $healthPath) {
        $script:F60HealthModule = $healthPath
        try {
            $out = (& $pwshExe -NoProfile -ExecutionPolicy Bypass -File $healthPath -Root $Root -TimeoutSec 90 -OutFile (Join-Path $Root 'f60-health.json') 2>&1 | Out-String)
            foreach ($l in @($out -split "`r?`n")) { if ($l.Trim()) { Write-F60Log '[F60 health]' $l.Trim() } }
            if ($out -match 'F60_HEALTH_OK') { $healthOk = $true }
            if ($out -match 'F60_HEALTH_FAILED:\s*([^\r\n]+)') { $healthReasons = @(($Matches[1] -split ',')) }
        } catch {
            $healthReasons = @('health-probe-threw')
            Write-F60Log '[F60 health] probe threw' $_.Exception.Message
        }
    } else {
        $healthReasons = @('health-script-not-staged')
        Write-F60Log '[F60 health] scripts/f60-health.ps1 not staged - probe skipped'
    }

    # --- 12. secret hygiene: drop the Run Command parameter files ---
    $null = Clear-F60RunCommandSecrets

    $sw.Stop()
    $running = @($svcResults | Where-Object { $_.status -eq 'Running' }).Count
    $result = [pscustomobject]@{
        schema          = 'ghrdp-f60-bootstrap-result/1'
        ok              = [bool]$healthOk
        magicDns        = $magicDns
        tailnetIp       = $tailnetIp
        hostname        = $Hostname
        runnerName      = $RunnerName
        runnerLabels    = $RunnerLabels
        runnerService   = [string]$runnerInfo.service
        servicesCreated = @($svcResults).Count
        servicesRunning = $running
        qbtBind         = $qbtBound
        qbtReason       = $qbtReason
        healthReasons   = @($healthReasons)
        stagedFiles     = [int]$stageInfo.staged
        missingFiles    = @($stageInfo.missing)
        elapsedSec      = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        at              = (Get-Date).ToUniversalTime().ToString('o')
    }
    try {
        [System.IO.File]::WriteAllText((Join-Path $Root 'state\f60-bootstrap-result.json'), ($result | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
    return $result
}

function Write-F60MarkerBlock {
    # LAST thing on stdout: Azure Run Command keeps only the tail of the output, so
    # the marker block must be compact and final.
    param($Result, [string]$FailReason = '')
    if ($FailReason) {
        Write-Host ('MAGICDNS=' + $(if ($Result -and $Result.magicDns) { $Result.magicDns } else { 'unknown' }))
        Write-Host ('BOOTSTRAP_FAILED: ' + (Invoke-F60Redact -Text $FailReason))
        return
    }
    Write-Host ('MAGICDNS=' + $Result.magicDns)
    Write-Host ('TAILNET_IP=' + $Result.tailnetIp)
    Write-Host ('RUNNER=' + $Result.runnerName + ' service=' + $Result.runnerService + ' labels=' + $Result.runnerLabels)
    Write-Host ('SERVICES=' + $Result.servicesRunning + '/' + $Result.servicesCreated + ' staged-files=' + $Result.stagedFiles + ' elapsedSec=' + $Result.elapsedSec)
    if ($Result.qbtReason) { Write-Host ('QBT=' + $Result.qbtReason) }
    Write-Host 'BOOTSTRAP_OK'
}

if (-not $DefineOnly) {
    $f60Result = $null
    $f60Failure = ''
    try {
        $f60Result = Invoke-F60Bootstrap -TailscaleAuthKey $TailscaleAuthKey -RunnerToken $RunnerToken -RepoUrl $RepoUrl -UiReleaseTag $UiReleaseTag -RepoAccessToken $RepoAccessToken -RepoRef $RepoRef -UiBundleSha $UiBundleSha -Root $Root -RunnerDir $RunnerDir -RunnerName $RunnerName -RunnerLabels $RunnerLabels -Hostname $Hostname -TailscaleTag $TailscaleTag -PinsJson $PinsJson -SkipRunner $SkipRunner -SkipDownloads $SkipDownloads
        if (-not $f60Result.ok) {
            $f60Failure = ('warm health probe not green: ' + (@($f60Result.healthReasons) -join ','))
        }
    } catch {
        $f60Failure = $_.Exception.Message
        try { Write-F60Log '[F60 bootstrap] FAILED' $f60Failure } catch { }
    }
    if ($f60Failure) {
        Write-F60MarkerBlock -Result $f60Result -FailReason $f60Failure
        exit 1
    }
    Write-F60MarkerBlock -Result $f60Result
    exit 0
}
