# [F60 §4] WARM-RUNNER HEALTH PROBE - single source of truth for "is the warm VM
# actually warm?".
#
# Used by:
#   * .github/workflows/warm-dispatch.yml (the warm job, before the dashboard
#     budget is measured, and the fallback job's post-mortem line),
#   * scripts/f60-bootstrap.ps1 (final probe at the end of provisioning),
#   * tests/f60-bootstrap-lab.ps1 + tests/f60-bootstrap.Tests.ps1 (branch proof
#     with injected probes - no VM, no services, no network needed).
#
# Design rules:
#   * FAIL-CLOSED and FAIL-VISIBLE: every check produces a named verdict; the
#     aggregate prints exactly one marker line - `F60_HEALTH_OK` or
#     `F60_HEALTH_FAILED: <reason[,reason]>` - and the script exits non-zero on
#     failure. A missing service is never reported as healthy.
#   * NO SECRET EVER LEAVES THIS SCRIPT: the aria2c RPC secret and the qBittorrent
#     password are read from their files and used in a request body only; neither
#     is printed, logged or written into f60-health.json.
#   * Loopback-only probes: the dashboard (7331), the prebuilt-bundle server
#     (4173) and the aria2c JSON-RPC (6800) are probed on 127.0.0.1. The port the
#     F60 brief called 5173 is the Vite DEV server; a warm VM serves the PREBUILT
#     bundle through the shipped zero-dependency static server
#     (scripts/serve-dist.mjs, PORT=4173), so 4173 is the honest probe. 7331 is
#     the real dashboard and the number the budget gate measures.
#   * Injectable probes: every live call goes through a scriptblock parameter so
#     the labs can exercise the healthy/unhealthy branches on any host.
#
# Runs under Windows PowerShell 5.1 (Run Command) AND pwsh 7 (Actions runner).

[CmdletBinding()]
param(
    [string]$Root = 'C:\ghrdp',
    [int]$DashPort = 7331,
    [int]$UiPort = 4173,
    [int]$Aria2Port = 6800,
    [int]$TimeoutSec = 90,
    [string]$OutFile = '',
    # SINGLE SOURCE for the warm service set. scripts/f60-bootstrap.ps1 asserts
    # this exact list when it registers the NSSM services, and the F60 node gate
    # pins the list in both files (a service added in one and not the other is a
    # red gate, not a silent drift).
    [string[]]$Services = @('Tailscale', 'aria2c-nssm', 'qbittorrent-nssm', 'ghrdp-ui-nssm', 'ghrdp-server-nssm'),
    # Lab switch: no tailscale CLI call (verdict comes from the injected probe or
    # is reported as tailscale-probe-skipped).
    [switch]$SkipTailscaleProbe,
    # Dot-source for functions only (used by the Pester spec + the PS lab).
    [switch]$DefineOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:F60HealthSchema = 'ghrdp-f60-health/1'
$script:F60OkMarker = 'F60_HEALTH_OK'
$script:F60FailMarker = 'F60_HEALTH_FAILED'

function Get-F60HealthOutFile {
    param([string]$Root, [string]$OutFile)
    if ($OutFile) { return $OutFile }
    return (Join-Path $Root 'f60-health.json')
}

function Invoke-F60RedactText {
    # Defence in depth: any value registered as sensitive is replaced before it
    # can reach a log line, the health JSON or the marker text.
    param([string]$Text, [string[]]$Sensitive)
    $out = [string]$Text
    foreach ($s in @($Sensitive)) {
        if ($s -and $s.Length -ge 6 -and $out.Contains($s)) { $out = $out.Replace($s, '***') }
    }
    return $out
}

function Get-F60ServiceVerdict {
    # One service -> one verdict. $Probe defaults to Get-Service; the labs inject
    # a stub so the unhealthy branch is provable on any host.
    param(
        [string]$Name,
        [scriptblock]$Probe = $null,
        [string[]]$AcceptStatus = @('Running')
    )
    $status = ''
    $detail = ''
    try {
        if ($Probe) {
            $status = [string](& $Probe $Name)
        } else {
            $svc = Get-Service -Name $Name -ErrorAction Stop
            $status = [string]$svc.Status
        }
    } catch {
        $status = 'Missing'
        $detail = $_.Exception.Message
    }
    $ok = (@($AcceptStatus) -contains $status)
    return [pscustomobject]@{
        name   = $Name
        status = $status
        ok     = [bool]$ok
        detail = $detail
    }
}

function Get-F60HttpVerdict {
    # Loopback HTTP probe. $Fetch defaults to Invoke-WebRequest; it must return an
    # object with a StatusCode property (the labs inject a stub). Retries stop at
    # $DeadlineUtc so a dead service can never eat the whole budget silently.
    param(
        [string]$Label,
        [string]$Url,
        [int]$TimeoutSec = 20,
        [scriptblock]$Fetch = $null,
        [int]$Retry = 3,
        [datetime]$DeadlineUtc = [datetime]::MinValue
    )
    $code = 0
    $detail = ''
    for ($a = 1; $a -le $Retry; $a++) {
        try {
            if ($Fetch) {
                $resp = & $Fetch $Url $TimeoutSec
            } else {
                $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
            }
            $code = [int]$resp.StatusCode
            if ($code -eq 200) { break }
            $detail = ('http ' + $code)
        } catch {
            $detail = $_.Exception.Message
        }
        if ($DeadlineUtc -ne [datetime]::MinValue -and [datetime]::UtcNow -ge $DeadlineUtc) {
            if (-not $detail) { $detail = 'deadline reached' }
            break
        }
        Start-Sleep -Milliseconds (500 * $a)
    }
    return [pscustomobject]@{
        label  = $Label
        url    = $Url
        status = $code
        ok     = ($code -eq 200)
        detail = $detail
    }
}

function Get-F60TailscaleVerdict {
    # `tailscale status --json` -> Self.Online + Self.DNSName (MagicDNS) + the CGNAT
    # address. Never calls `tailscale ip` (the F9n/F25 lesson: the post-connect
    # LocalAPI call 401s when the node is owned by another account).
    param(
        [string]$Exe = '',
        [scriptblock]$Probe = $null
    )
    $json = $null
    $detail = ''
    try {
        if ($Probe) {
            $json = & $Probe
        } else {
            if (-not $Exe) {
                foreach ($c in @((Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'), 'C:\Program Files (x86)\Tailscale\tailscale.exe')) {
                    if (Test-Path -LiteralPath $c) { $Exe = $c; break }
                }
            }
            if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { throw 'tailscale.exe not found' }
            $raw = (& $Exe status --json 2>$null | Out-String)
            if (-not $raw) { throw 'tailscale status returned no output' }
            $json = $raw | ConvertFrom-Json
        }
    } catch {
        $detail = $_.Exception.Message
    }
    $online = $false
    $dns = ''
    $ip = ''
    if ($json -and $json.Self) {
        $online = [bool]$json.Self.Online
        $dns = [string]$json.Self.DNSName
        if ($dns.EndsWith('.')) { $dns = $dns.Substring(0, $dns.Length - 1) }
        try { $ip = [string]@($json.Self.TailscaleIPs)[0] } catch { $ip = '' }
    } elseif (-not $detail) {
        $detail = 'tailscale status had no Self block'
    }
    return [pscustomobject]@{
        ok        = ($online -and $dns -ne '')
        online    = $online
        magicDns  = $dns
        tailnetIp = $ip
        detail    = $detail
    }
}

function Get-F60Aria2Verdict {
    # A real aria2.getVersion JSON-RPC round-trip on loopback (the same surface
    # /api/fetch uses) - not "is something bound to 6800".
    param(
        [int]$Port = 6800,
        [string]$SecretFile = '',
        [scriptblock]$Probe = $null
    )
    $version = ''
    $detail = ''
    try {
        if ($Probe) {
            $version = [string](& $Probe $Port)
        } else {
            $secret = ''
            if ($SecretFile -and (Test-Path -LiteralPath $SecretFile)) {
                try { $secret = ([System.IO.File]::ReadAllText($SecretFile)).Trim() } catch { $secret = '' }
            }
            $body = @{ jsonrpc = '2.0'; id = 'f60-health'; method = 'aria2.getVersion'; params = @('token:' + $secret) } | ConvertTo-Json -Compress -Depth 4
            $resp = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/jsonrpc') -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 -ErrorAction Stop
            if ($resp.result -and $resp.result.version) { $version = [string]$resp.result.version } else { $detail = 'aria2.getVersion returned no version' }
        }
    } catch {
        $detail = $_.Exception.Message
    }
    return [pscustomobject]@{
        ok      = ($version -ne '')
        version = $version
        detail  = $detail
    }
}

function Invoke-F60Health {
    # Aggregate probe. Returns a pscustomobject AND writes it as JSON. Never
    # throws for an unhealthy host: the verdict is data, the marker is the
    # contract, and the caller decides what to do with it.
    param(
        [string]$Root = 'C:\ghrdp',
        [int]$DashPort = 7331,
        [int]$UiPort = 4173,
        [int]$Aria2Port = 6800,
        [int]$TimeoutSec = 90,
        [string]$OutFile = '',
        [string[]]$Services = @('Tailscale', 'aria2c-nssm', 'qbittorrent-nssm', 'ghrdp-ui-nssm', 'ghrdp-server-nssm'),
        [scriptblock]$ServiceProbe = $null,
        [scriptblock]$HttpProbe = $null,
        [scriptblock]$TailscaleProbe = $null,
        [scriptblock]$Aria2Probe = $null,
        [switch]$SkipTailscaleProbe,
        [string[]]$AcceptStopped = @(),
        [string]$Mode = 'warm'
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $deadline = [datetime]::UtcNow.AddSeconds([math]::Max(5, $TimeoutSec))
    $svc = @()
    foreach ($name in @($Services)) {
        $accept = @('Running')
        if (@($AcceptStopped) -contains $name) { $accept = @('Running', 'Stopped') }
        $svc += (Get-F60ServiceVerdict -Name $name -Probe $ServiceProbe -AcceptStatus $accept)
    }
    $dash = Get-F60HttpVerdict -Label 'dashboard' -Url ('http://127.0.0.1:' + $DashPort + '/') -TimeoutSec 20 -Fetch $HttpProbe -DeadlineUtc $deadline
    $ui = Get-F60HttpVerdict -Label 'ui-bundle' -Url ('http://127.0.0.1:' + $UiPort + '/') -TimeoutSec 20 -Fetch $HttpProbe -DeadlineUtc $deadline
    $ariaSecretFile = Join-Path $Root 'aria2-secret.txt'
    $ariaSecret = ''
    try { if (Test-Path -LiteralPath $ariaSecretFile) { $ariaSecret = ([System.IO.File]::ReadAllText($ariaSecretFile)).Trim() } } catch { $ariaSecret = '' }
    $aria = Get-F60Aria2Verdict -Port $Aria2Port -SecretFile $ariaSecretFile -Probe $Aria2Probe
    if ($SkipTailscaleProbe) {
        $ts = [pscustomobject]@{ ok = $false; online = $false; magicDns = ''; tailnetIp = ''; detail = 'tailscale-probe-skipped' }
    } else {
        $ts = Get-F60TailscaleVerdict -Probe $TailscaleProbe
    }
    $sw.Stop()

    $reasons = @()
    foreach ($s in @($svc)) { if (-not $s.ok) { $reasons += ('service-' + $s.name + '=' + $s.status) } }
    if (-not $dash.ok) { $reasons += ('dashboard-http=' + $dash.status) }
    if (-not $ui.ok) { $reasons += ('ui-bundle-http=' + $ui.status) }
    if (-not $aria.ok) { $reasons += 'aria2-rpc-unanswered' }
    if (-not $SkipTailscaleProbe -and -not $ts.ok) { $reasons += 'tailscale-not-online' }

    $ok = (@($reasons).Count -eq 0)
    $result = [pscustomobject]@{
        schema      = $script:F60HealthSchema
        mode        = $Mode
        ok          = $ok
        reasons     = @($reasons)
        probeMs     = [int]$sw.ElapsedMilliseconds
        at          = (Get-Date).ToUniversalTime().ToString('o')
        host        = [string]$env:COMPUTERNAME
        services    = @($svc)
        dashboard   = $dash
        uiBundle    = $ui
        # the aria2 RPC secret is redacted before any detail text is persisted
        aria2       = [pscustomobject]@{ ok = $aria.ok; version = $aria.version; detail = (Invoke-F60RedactText -Text $aria.detail -Sensitive @($ariaSecret)) }
        tailscale   = [pscustomobject]@{ ok = $ts.ok; online = $ts.online; magicDns = $ts.magicDns; tailnetIp = $ts.tailnetIp; detail = $ts.detail }
    }

    $path = Get-F60HealthOutFile -Root $Root -OutFile $OutFile
    try {
        $dir = Split-Path -Parent $path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $json = ($result | ConvertTo-Json -Depth 6 -Compress)
        [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Host ('[F60 health] could not write ' + $path + ': ' + $_.Exception.Message)
    }

    $running = @($svc | Where-Object { $_.status -eq 'Running' }).Count
    $line = ('[F60 health] mode=' + $Mode + ' services=' + $running + '/' + @($svc).Count + ' dash=' + $dash.status + ' ui=' + $ui.status + ' aria2=' + $(if ($aria.ok) { $aria.version } else { 'down' }) + ' tailscale=' + $(if ($ts.online) { 'online' } else { 'offline' }) + ' magicdns=' + $(if ($ts.magicDns) { $ts.magicDns } else { 'unknown' }) + ' probeMs=' + [int]$sw.ElapsedMilliseconds)
    Write-Host $line
    if ($ok) {
        Write-Host ($script:F60OkMarker + ' ' + $line)
    } else {
        Write-Host ($script:F60FailMarker + ': ' + ($reasons -join ','))
    }
    $global:F60HealthExit = $(if ($ok) { 0 } else { 1 })
    return $result
}

function Get-F60WarmBudgetVerdict {
    # [F60 §5] the <60000 ms budget gate. Reads the F60 timing file (the shipped
    # F59 helper writes it - same JSONL shape, different file so the warm lane and
    # the GitHub-hosted lane never overwrite each other) and returns the verdict +
    # the strike count used by the "warm >60s x3" STOP.
    param(
        [string]$TimingFile,
        [int]$BudgetMs = 60000,
        [string]$Step = 'dispatch-to-dashboard',
        [string]$StrikeFile = '',
        [int]$MaxStrikes = 3
    )
    $ms = -1
    $detail = ''
    try {
        if (-not $TimingFile -or -not (Test-Path -LiteralPath $TimingFile)) { throw ('timing file missing: ' + $TimingFile) }
        $lines = @(Get-Content -LiteralPath $TimingFile | Where-Object { $_.Trim() -ne '' })
        $found = $null
        foreach ($l in $lines) {
            try {
                $rec = $l | ConvertFrom-Json
                if ([string]$rec.step -eq $Step) { $found = $rec }
            } catch { }
        }
        if (-not $found) { throw ('no ' + $Step + ' line in ' + $TimingFile) }
        $ms = [int][math]::Round(([double]$found.sec) * 1000)
    } catch {
        $detail = $_.Exception.Message
    }
    $over = ($ms -lt 0 -or $ms -gt $BudgetMs)
    $strikes = 0
    $history = @()
    if ($StrikeFile) {
        try {
            if (Test-Path -LiteralPath $StrikeFile) {
                $raw = [System.IO.File]::ReadAllText($StrikeFile)
                if ($raw.Trim()) { $history = @(($raw | ConvertFrom-Json)) }
            }
        } catch { $history = @() }
        $history += [pscustomobject]@{ ms = $ms; over = [bool]$over; at = (Get-Date).ToUniversalTime().ToString('o') }
        if ($history.Count -gt 20) { $history = @($history | Select-Object -Last 20) }
        try {
            $dir = Split-Path -Parent $StrikeFile
            if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [System.IO.File]::WriteAllText($StrikeFile, (@($history) | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
        $strikes = 0
        for ($i = $history.Count - 1; $i -ge 0; $i--) {
            if ($history[$i].over) { $strikes++ } else { break }
        }
    }
    return [pscustomobject]@{
        ms         = $ms
        budgetMs   = $BudgetMs
        ok         = (-not $over)
        strikes    = $strikes
        maxStrikes = $MaxStrikes
        stop       = ($strikes -ge $MaxStrikes)
        detail     = $detail
    }
}

if (-not $DefineOnly) {
    $r = Invoke-F60Health -Root $Root -DashPort $DashPort -UiPort $UiPort -Aria2Port $Aria2Port -TimeoutSec $TimeoutSec -OutFile $OutFile -Services $Services -SkipTailscaleProbe:$SkipTailscaleProbe -Mode 'dispatch'
    $code = 0
    try { $code = [int]$global:F60HealthExit } catch { $code = 1 }
    exit $code
}
