# [F60 §4] WARM/COLD STAGE-AND-START - the runtime half of the warm lane.
#
# One shipped script, two modes, used by BOTH jobs of .github/workflows/warm-dispatch.yml:
#
#   -Mode warm  the sl-warm VM. The four NSSM services already exist (created by
#               scripts/f60-bootstrap.ps1). This mode refreshes the payloads + the
#               COMMIT-MATCHED UI bundle from the job's checkout/release, restarts
#               the two UI-facing services so the running code is the code under
#               test, heals the qBittorrent Tailnet-only bind when the provision
#               run could not resolve a CGNAT address, and leaves aria2c/qBittorrent
#               running unless -RestartServices is passed. Nothing is re-installed.
#   -Mode cold  windows-latest (the fallback lane, labeled `f59-windows-latest`).
#               There are no services and no NSSM, so the payloads are staged from
#               the checkout and the dashboard + bundle servers are started as
#               processes. This PROVES the fallback reaches the dashboard with the
#               same prebuilt bundle; it is NOT main.yml's full F59 lane and it
#               never dispatches main.yml.
#
# Contract:
#   * the payload list is ONE list (Get-F60PayloadList); the node gate asserts it
#     against scripts/f60-bootstrap.ps1's Get-F60StageList and against main.yml's
#     own staging step, so the three cannot drift apart silently;
#   * every downloaded byte is verified with the SHIPPED fail-closed verifiers
#     (scripts/f59-verify-sha256.mjs for the bundle) - a mismatch throws;
#   * the release download reuses the bootstrap's transport functions
#     (dot-sourced with -DefineOnly) instead of a second implementation, and works
#     with the job's GITHUB_TOKEN on a VM that has no `gh` CLI;
#   * timings go to the F60 timing file through the shipped F59 helper
#     (payloads/f59-timing.ps1) with $env:GHRDP_F59_TIMING redirected, so the warm
#     lane and the GitHub-hosted lane never overwrite each other's JSONL;
#   * no secret is ever printed (the aria2c/qBittorrent secrets stay in their
#     SYSTEM-only files).
#
# Windows PowerShell 5.1 + pwsh 7 compatible.

[CmdletBinding()]
param(
    [ValidateSet('warm', 'cold')]
    [string]$Mode = 'warm',
    [string]$Root = 'C:\ghrdp',
    [string]$Workspace = '',
    [string]$TimingFile = '',
    [int]$DashPort = 7331,
    [int]$UiPort = 4173,
    [string]$UiReleaseTag = 'ui-dist',
    [string]$UiBundleSha = '',
    [int]$WaitSec = 120,
    [switch]$RestartServices,
    [switch]$DefineOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:F60PayloadList = @(
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
    'payloads/ghrdp-rdp-first-login.ps1'
)
$script:F60ToolList = @(
    'scripts/serve-dist.mjs',
    'scripts/f59-verify-sha256.mjs',
    'scripts/f60-health.ps1',
    'scripts/f60-stage-and-start.ps1',
    'scripts/f60-bootstrap.ps1'
)
# The two services that must be restarted after a payload refresh so the running
# code is the code under test; aria2c/qBittorrent keep running (they are daemons
# with no per-commit contract).
$script:F60UiFacingServices = @('ghrdp-server-nssm', 'ghrdp-ui-nssm')
$script:F60WarmServices = @('ghrdp-server-nssm', 'ghrdp-ui-nssm', 'aria2c-nssm', 'qbittorrent-nssm')

function Get-F60PayloadList { return $script:F60PayloadList }
function Get-F60ToolList { return $script:F60ToolList }
function Get-F60WarmServiceNames { return $script:F60WarmServices }

function Get-F60TimingFile {
    param([string]$Root, [string]$TimingFile)
    if ($TimingFile) { return $TimingFile }
    return (Join-Path $Root 'startup-timing-f60.jsonl')
}

function New-F60Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
    return $Path
}

function Import-F60Transport {
    # RESOLVE (never load) the bootstrap that carries the release-asset transport, so
    # the download path stays ONE implementation (Get-F60ReleaseAssetInfo /
    # Get-F60File). Returns the path, or '' when it is unavailable.
    #
    # WHY THE CALLER DOT-SOURCES: PowerShell scopes definitions to the scope that
    # made them. A `. $cand -DefineOnly` inside THIS function would be discarded the
    # moment the function returned, and Stage-F60UiBundle would then die with "the
    # term 'Get-F60ReleaseAssetInfo' is not recognized" - the release bundle could
    # never be staged in either lane. So this function only resolves the path and
    # every caller dot-sources it in its OWN scope (Invoke-F60StageAndStart below,
    # tests/f60-bootstrap-lab.ps1 check M).
    param([string]$Workspace, [string]$Root)
    $cands = @()
    if ($Workspace) { $cands += (Join-Path $Workspace 'scripts\f60-bootstrap.ps1') }
    if ($Root) { $cands += (Join-Path $Root 'tools\f60-bootstrap.ps1') }
    foreach ($cand in $cands) {
        if (Test-Path -LiteralPath $cand) { return $cand }
    }
    return ''
}

function Stage-F60FromCheckout {
    # Copy the dashboard-critical payloads out of the job's checkout into C:\ghrdp,
    # mirroring main.yml's "Write deploy payloads" step (flat layout, fonts in
    # fonts\, tools in tools\, the __BUILD_SHA__ substitution).
    param([string]$Root, [string]$Workspace, [string]$BuildSha)
    if (-not $Workspace -or -not (Test-Path -LiteralPath (Join-Path $Workspace 'payloads'))) {
        throw ('[F60 stage] no checkout at ' + $Workspace + ' - cannot stage the payloads')
    }
    $null = New-F60Directory -Path $Root
    $null = New-F60Directory -Path (Join-Path $Root 'fonts')
    $null = New-F60Directory -Path (Join-Path $Root 'tools')
    $staged = 0
    $missing = @()
    foreach ($rel in ($script:F60PayloadList + $script:F60ToolList)) {
        $from = Join-Path $Workspace ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $from)) { $missing += $rel; continue }
        $leaf = Split-Path -Leaf $from
        $to = Join-Path $Root $leaf
        if ($rel -like 'scripts/*') { $to = Join-Path $Root (Join-Path 'tools' $leaf) }
        if ($rel -like 'payloads/fonts/*') { $to = Join-Path $Root (Join-Path 'fonts' $leaf) }
        Copy-Item -LiteralPath $from -Destination $to -Force
        $staged++
    }
    $ui = Join-Path $Root 'ui.html'
    if (Test-Path -LiteralPath $ui) {
        $txt = [System.IO.File]::ReadAllText($ui).Replace('__BUILD_SHA__', [string]$BuildSha)
        [System.IO.File]::WriteAllText($ui, $txt, (New-Object System.Text.UTF8Encoding($false)))
    }
    # main.yml's second substitution: the client-install script carries the connect
    # helper as base64. Same rule here, so a warm and a cold host serve the same
    # bytes.
    $helper = Join-Path $Root 'helper-ghrdp-connect.ps1'
    $tmpl = Join-Path $Root 'ghrdp-install.template.ps1'
    if ((Test-Path -LiteralPath $helper) -and (Test-Path -LiteralPath $tmpl)) {
        $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($helper))
        $inst = ([System.IO.File]::ReadAllText($tmpl)).Replace('__HELPER_B64__', $b64)
        [System.IO.File]::WriteAllText((Join-Path $Root 'ghrdp-install.ps1'), $inst, (New-Object System.Text.UTF8Encoding($false)))
        Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue
    }
    Write-Host ('[F60 stage] from-checkout staged=' + $staged + ' missing=' + $(if (@($missing).Count) { ($missing -join ',') } else { 'none' }))
    if ($staged -lt 20) { throw ('[F60 stage] only ' + $staged + ' payload files staged - refusing to start a half-staged dashboard') }
    return @{ staged = $staged; missing = @($missing) }
}

function Stage-F60UiBundle {
    # The commit-matched prebuilt bundle from the ui-dist release, verified with the
    # SHIPPED fail-closed node verifier before it is staged (same rule as main.yml).
    param([string]$Root, [string]$Workspace, [string]$Tag, [string]$BundleSha, [string]$Repo, [string]$Token)
    $dl = New-F60Directory -Path (Join-Path $Root 'downloads')
    if (-not (Get-Command -Name 'Get-F60ReleaseAssetInfo' -ErrorAction SilentlyContinue)) {
        throw '[F60 ui] the bootstrap transport functions are not loaded - cannot fetch the release asset'
    }
    $rel = Get-F60ReleaseAssetInfo -Tag $Tag -Owner ($Repo -split '/')[0] -Repo ($Repo -split '/')[1] -Token $Token
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
    $sideName = ($zipName + '.sha256')
    $sideAsset = @($assets | Where-Object { [string]$_.name -eq $sideName } | Select-Object -First 1)
    if (-not $sideAsset) { throw ('[F60 ui] the ui-dist release has no sidecar ' + $sideName + ' - refusing an unverifiable bundle') }
    $sideOut = Join-Path $dl $sideName
    $null = Get-F60File -Url ([string]$sideAsset.url) -Out $sideOut -Label 'ui-dist sidecar' -AuthToken $Token -Accept 'application/octet-stream' -MinBytes 8 -NoPin
    $expected = ([System.IO.File]::ReadAllText($sideOut)).Trim()
    $zipOut = Join-Path $dl $zipName
    $null = Get-F60File -Url ([string]$pick.url) -Out $zipOut -Label ('ui bundle ' + $zipName) -ExpectedSha $expected -AuthToken $Token -Accept 'application/octet-stream' -MinBytes 51200
    $node = 'node'
    $localNode = Join-Path $Root 'tools\node\node.exe'
    if (Test-Path -LiteralPath $localNode) { $node = $localNode }
    $verifier = Join-Path $Root 'tools\f59-verify-sha256.mjs'
    if (-not (Test-Path -LiteralPath $verifier) -and $Workspace) { $verifier = Join-Path $Workspace 'scripts\f59-verify-sha256.mjs' }
    & $node $verifier $zipOut $expected --label $zipName 2>&1 | ForEach-Object { Write-Host ('[F60 ui verify] ' + $_) }
    if ($LASTEXITCODE -ne 0) { throw ('[F60 ui] the shipped fail-closed verifier rejected ' + $zipName) }
    $LASTEXITCODE = 0
    $uiDir = New-F60Directory -Path (Join-Path $Root 'ui')
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
    Write-Host ('[F60 ui] staged ' + $zipName + ' (' + $bytes + ' bytes) -> ui\index.html + ui-v2.html')
    return @{ asset = $zipName; bytes = $bytes }
}

function Start-F60WarmServices {
    # Warm lane: the two UI-facing services are ALWAYS restarted after a payload
    # refresh (so the running code is the code under test); aria2c/qBittorrent are
    # only started, unless -RestartAll. The qBittorrent Tailnet-only bind is healed
    # through the SHIPPED policy module, so the floor is the shipped one and is
    # never relaxed here: never 0.0.0.0, never '*', never loopback.
    param([string]$Root, [bool]$RestartAll)
    $nssm = Join-Path $Root 'tools\nssm.exe'
    $report = @()
    $qbtBound = ''
    $qbtReason = ''
    $qbtMod = Join-Path $Root 'ghrdp-qbt.ps1'
    $qbtSvc = Get-Service -Name 'qbittorrent-nssm' -ErrorAction SilentlyContinue
    if ((-not $qbtSvc) -or ($qbtSvc.Status -ne 'Running')) {
        if ((Test-Path -LiteralPath $qbtMod) -and (Test-Path -LiteralPath (Join-Path $Root 'ghrdp-qbt-policy.json'))) {
            try {
                $secFile = Join-Path $Root 'qbt-secret.txt'
                if (Test-Path -LiteralPath $secFile) { $env:GHRDP_QBT_PASSWORD = ([System.IO.File]::ReadAllText($secFile)).Trim() }
                . $qbtMod
                $init = Initialize-GhrdpQbt -ConfigPath (Join-Path $Root 'config.json') -ConfPath (Join-Path $Root 'qbt\qBittorrent.conf')
                if ($init.ok) {
                    $qbtBound = [string]$init.address
                    Write-Host ('[F60 qbt] WebUI bind=' + $qbtBound + ' (' + $init.bindSource + ') port=' + $init.port + ' - healing the service')
                    $exe = [string]$init.exe
                    if ($qbtSvc) {
                        try { Start-Service -Name 'qbittorrent-nssm' -ErrorAction Stop } catch { Write-Host ('[F60 qbt] start failed: ' + $_.Exception.Message) }
                    } elseif ((Test-Path -LiteralPath $nssm) -and $exe) {
                        $null = New-F60Directory -Path (Join-Path $Root 'qbt')
                        $null = New-F60Directory -Path (Join-Path $Root 'logs')
                        & $nssm install 'qbittorrent-nssm' $exe ('--webui-port=' + $init.port + ' --no-splash --profile=' + (Join-Path $Root 'qbt')) 2>&1 | Out-Null
                        & $nssm set 'qbittorrent-nssm' Start 'SERVICE_AUTO_START' 2>&1 | Out-Null
                        & $nssm set 'qbittorrent-nssm' ObjectName 'LocalSystem' 2>&1 | Out-Null
                        & $nssm set 'qbittorrent-nssm' AppStdout (Join-Path $Root 'logs\qbittorrent-nssm.out.log') 2>&1 | Out-Null
                        & $nssm set 'qbittorrent-nssm' AppStderr (Join-Path $Root 'logs\qbittorrent-nssm.err.log') 2>&1 | Out-Null
                        $LASTEXITCODE = 0
                        try { & $nssm start 'qbittorrent-nssm' 2>&1 | Out-Null } catch { }
                    }
                } else {
                    $qbtReason = [string]$init.reason
                    Write-Host ('[F60 qbt] init still refused (' + $qbtReason + ') - the torrent lane stays unavailable; the Tailnet-only floor is never relaxed')
                }
            } catch {
                $qbtReason = $_.Exception.Message
                Write-Host ('[F60 qbt] heal threw: ' + $qbtReason)
            }
        } else {
            $qbtReason = 'qbt-module-not-staged'
        }
    } else {
        $qbtBound = 'already-running'
    }
    foreach ($n in $script:F60WarmServices) {
        $svc = Get-Service -Name $n -ErrorAction SilentlyContinue
        if (-not $svc) { $report += ($n + '=missing'); continue }
        $doRestart = $RestartAll
        if ((-not $doRestart) -and (@($script:F60UiFacingServices) -contains $n) -and ($svc.Status -eq 'Running')) { $doRestart = $true }
        if ($doRestart -and $svc.Status -eq 'Running') {
            try { Restart-Service -Name $n -Force -ErrorAction Stop } catch { Write-Host ('[F60 svc] restart ' + $n + ' failed: ' + $_.Exception.Message) }
        }
        $now = Get-Service -Name $n -ErrorAction SilentlyContinue
        if ($now.Status -ne 'Running') {
            try { Start-Service -Name $n -ErrorAction Stop } catch { Write-Host ('[F60 svc] start ' + $n + ' failed: ' + $_.Exception.Message) }
        }
        $after = Get-Service -Name $n -ErrorAction SilentlyContinue
        $report += ($n + '=' + [string]$after.Status)
    }
    Write-Host ('[F60 svc] ' + ($report -join ' '))
    return @{ services = $report; qbtBind = $qbtBound; qbtReason = $qbtReason }
}

function Start-F60ColdProcesses {
    # Fallback lane: no services exist on a GitHub-hosted runner, so start the
    # dashboard server and the bundle server as processes and wait for LISTENING.
    param([string]$Root, [int]$DashPort, [int]$UiPort, [int]$WaitSec)
    $pwsh = 'powershell.exe'
    try { $c = Get-Command pwsh.exe -ErrorAction Stop; if ($c) { $pwsh = $c.Source } } catch { }
    $server = Join-Path $Root 'ghrdp-server.ps1'
    if (-not (Test-Path -LiteralPath $server)) { throw '[F60 cold] ghrdp-server.ps1 was not staged' }
    $okFile = Join-Path $Root 'server-ok.txt'
    Remove-Item -LiteralPath $okFile -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $server) -WindowStyle Hidden
    Write-Host '[F60 cold] dashboard server process started'
    $node = 'node'
    $localNode = Join-Path $Root 'tools\node\node.exe'
    if (Test-Path -LiteralPath $localNode) { $node = $localNode }
    $serve = Join-Path $Root 'tools\serve-dist.mjs'
    if (Test-Path -LiteralPath $serve) {
        $env:PORT = [string]$UiPort
        Start-Process -FilePath $node -ArgumentList @($serve, (Join-Path $Root 'ui')) -WindowStyle Hidden
        Write-Host ('[F60 cold] bundle server process started on port ' + $UiPort)
    }
    $listening = $false
    $deadline = (Get-Date).AddSeconds($WaitSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $okFile) {
            $txt = ''
            try { $txt = [System.IO.File]::ReadAllText($okFile) } catch { $txt = '' }
            if ($txt.StartsWith('LISTENING')) { $listening = $true; break }
            if ($txt.StartsWith('LISTEN_FAIL')) { break }
        }
        try {
            $tcp = Get-NetTCPConnection -LocalPort $DashPort -State Listen -ErrorAction SilentlyContinue
            if ($tcp) { $listening = $true; break }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $listening) { throw ('[F60 cold] the dashboard never reported LISTENING on ' + $DashPort + ' within ' + $WaitSec + 's') }
    Write-Host ('[F60 cold] CONFIRMED dashboard listening on 0.0.0.0:' + $DashPort)
    return @{ listening = $true }
}

function Wait-F60DashboardHttp {
    # The budget metric ends at a REAL HTTP 200 from the dashboard's v2 route, not
    # at a bound socket.
    param([int]$DashPort, [int]$WaitSec)
    $url = ('http://127.0.0.1:' + $DashPort + '/?ui=v2')
    $deadline = (Get-Date).AddSeconds($WaitSec)
    $code = 0
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
            $code = [int]$r.StatusCode
            if ($code -eq 200) { return @{ ok = $true; code = 200; url = $url } }
        } catch {
            $code = 0
        }
        Start-Sleep -Seconds 2
    }
    return @{ ok = $false; code = $code; url = $url }
}

function Invoke-F60StageAndStart {
    param(
        [string]$Mode,
        [string]$Root,
        [string]$Workspace,
        [string]$TimingFile,
        [int]$DashPort,
        [int]$UiPort,
        [string]$UiReleaseTag,
        [string]$UiBundleSha,
        [string]$Repo,
        [string]$Token,
        [int]$WaitSec,
        [bool]$Restart
    )
    $tf = Get-F60TimingFile -Root $Root -TimingFile $TimingFile
    $env:GHRDP_F59_TIMING = $tf
    # Dot-sourced HERE, in this function's own scope: definitions made inside
    # Import-F60Transport would vanish when it returned (see that function's note).
    #
    # A dot-source also BINDS THE LOADED SCRIPT'S PARAM BLOCK IN THIS SCOPE, and
    # scripts/f60-bootstrap.ps1 declares -Root (default C:\ghrdp), -UiReleaseTag
    # (default ui-dist) and -UiBundleSha (default '') - three of this function's own
    # parameters. Without the snapshot/restore below, the bootstrap's defaults would
    # silently replace the values this lane was called with, and an empty
    # $UiBundleSha would downgrade "the commit-matched bundle" to "the newest
    # ui-dist-*.zip" - a quiet correctness loss, not a crash. Same collision class
    # that made tests/f60-bootstrap-lab.ps1 lose its repo root on the runner.
    $saKeep = @{
        Mode = $Mode; Root = $Root; Workspace = $Workspace; TimingFile = $TimingFile
        DashPort = $DashPort; UiPort = $UiPort; UiReleaseTag = $UiReleaseTag
        UiBundleSha = $UiBundleSha; Repo = $Repo; Token = $Token; WaitSec = $WaitSec
        Restart = $Restart
    }
    $transport = Import-F60Transport -Workspace $Workspace -Root $Root
    if ($transport) {
        . $transport -DefineOnly
        $Mode = $saKeep.Mode; $Root = $saKeep.Root; $Workspace = $saKeep.Workspace
        $TimingFile = $saKeep.TimingFile; $DashPort = $saKeep.DashPort; $UiPort = $saKeep.UiPort
        $UiReleaseTag = $saKeep.UiReleaseTag; $UiBundleSha = $saKeep.UiBundleSha
        $Repo = $saKeep.Repo; $Token = $saKeep.Token; $WaitSec = $saKeep.WaitSec
        $Restart = $saKeep.Restart
        $bundleNote = if ($UiBundleSha) { $UiBundleSha.Substring(0, [Math]::Min(12, $UiBundleSha.Length)) } else { 'newest' }
        Write-Host ('[F60 transport] release transport loaded from ' + $transport + ' (root=' + $Root + ' uiReleaseTag=' + $UiReleaseTag + ' bundle=' + $bundleNote + ')')
        if (-not (Get-Command -Name 'Get-F60ReleaseAssetInfo' -ErrorAction SilentlyContinue)) {
            throw ('[F60 transport] ' + $transport + ' loaded but Get-F60ReleaseAssetInfo is not defined - refusing to stage an unverifiable bundle')
        }
    } elseif ($Mode -eq 'cold') {
        throw '[F60 cold] no scripts\f60-bootstrap.ps1 to load the release transport from - the checkout is incomplete'
    } else {
        Write-Host '[F60 transport] WARNING no bootstrap transport found; the provision-time bundle stays in place'
    }
    $timingModule = Join-Path $Root 'f59-timing.ps1'
    if (-not (Test-Path -LiteralPath $timingModule) -and $Workspace) { $timingModule = Join-Path $Workspace 'payloads\f59-timing.ps1' }
    if (Test-Path -LiteralPath $timingModule) { . $timingModule }
    $swAll = $null
    if (Get-Command -Name 'Start-F59Step' -ErrorAction SilentlyContinue) { $swAll = Start-F59Step }

    # Both lanes refresh the payloads from the checkout: the running code must be
    # the code under test, not whatever the provision run happened to stage.
    $null = Stage-F60FromCheckout -Root $Root -Workspace $Workspace -BuildSha $UiBundleSha
    $bundle = $null
    try {
        $bundle = Stage-F60UiBundle -Root $Root -Workspace $Workspace -Tag $UiReleaseTag -BundleSha $UiBundleSha -Repo $Repo -Token $Token
    } catch {
        if ($Mode -eq 'cold') { throw }
        Write-Host ('[F60 ui] WARNING the commit-matched bundle could not be staged (' + $_.Exception.Message + ') - the provision-time bundle stays in place')
    }
    if ($Mode -eq 'warm') {
        $svc = Start-F60WarmServices -Root $Root -RestartAll $Restart
    } else {
        $svc = @{ services = @('cold-processes'); qbtBind = ''; qbtReason = 'cold-lane-no-torrent-service' }
        $null = Start-F60ColdProcesses -Root $Root -DashPort $DashPort -UiPort $UiPort -WaitSec $WaitSec
    }
    $http = Wait-F60DashboardHttp -DashPort $DashPort -WaitSec $WaitSec
    if (-not $http.ok) { throw ('[F60 ' + $Mode + '] the dashboard did not answer 200 on ' + $http.url) }
    $sec = -1.0
    if ($swAll -and (Get-Command -Name 'Stop-F59Step' -ErrorAction SilentlyContinue)) {
        $sec = Stop-F59Step -Step 'dispatch-to-dashboard' -Sw $swAll
    }
    if ($sec -lt 0 -and (Get-Command -Name 'Get-F59SecondsSinceJobStart' -ErrorAction SilentlyContinue)) {
        $sec = Get-F59SecondsSinceJobStart
        if (Get-Command -Name 'Add-F59Timing' -ErrorAction SilentlyContinue) { Add-F59Timing -Step 'dispatch-to-dashboard' -Seconds $sec }
    }
    Write-Host ('[F60 ' + $Mode + '] dashboard-reachable in ' + [math]::Round($sec, 1) + 's (' + [int][math]::Round($sec * 1000) + ' ms) timing=' + $tf)
    return [pscustomobject]@{
        mode       = $Mode
        seconds    = [math]::Round($sec, 2)
        ms         = [int][math]::Round($sec * 1000)
        timingFile = $tf
        bundle     = $(if ($bundle) { $bundle.asset } else { 'provision-time' })
        services   = @($svc.services)
        qbtBind    = [string]$svc.qbtBind
        qbtReason  = [string]$svc.qbtReason
        httpUrl    = $http.url
    }
}

if (-not $DefineOnly) {
    $ws = $Workspace
    if (-not $ws) { $ws = [string]$env:GITHUB_WORKSPACE }
    $sha = $UiBundleSha
    if (-not $sha) { $sha = [string]$env:GITHUB_SHA }
    $repo = [string]$env:GITHUB_REPOSITORY
    $tok = [string]$env:GH_TOKEN
    $r = Invoke-F60StageAndStart -Mode $Mode -Root $Root -Workspace $ws -TimingFile $TimingFile -DashPort $DashPort -UiPort $UiPort -UiReleaseTag $UiReleaseTag -UiBundleSha $sha -Repo $repo -Token $tok -WaitSec $WaitSec -Restart ([bool]$RestartServices)
    $json = ($r | ConvertTo-Json -Depth 5 -Compress)
    Write-Host ('F60_STAGE_RESULT ' + $json)
    if ($env:GITHUB_OUTPUT) {
        Add-Content -Path $env:GITHUB_OUTPUT -Value ('f60_ms=' + $r.ms)
        Add-Content -Path $env:GITHUB_OUTPUT -Value ('f60_result=' + $json)
    }
    exit 0
}
