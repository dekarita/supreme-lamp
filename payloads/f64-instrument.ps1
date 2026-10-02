# [F64] INSTRUMENTATION + HONEST SPEED HELPERS
# Dot-sourced by instrumented main.yml steps. Non-throwing: a stamp must never
# be the reason a dispatch dies.
#
# Write-F64Stamp        - intra-step UTC timestamp (Tailscale/DNS/Parsec/drivers/probes)
# Get-F64HostFacts      - windows image, D: presence, Defender status, prebuilt cache
# Start-F64BgJob        - Start-ThreadJob when present (MS Learn: ~8x faster STARTUP
#                         than Start-Job), else Start-Job. Wait-Job still joins.
# Resolve-F64InstallRoot - D:\ghrdp-install when D: exists, else C:\ghrdp (log only
#                         unless the caller opts in; C:\ghrdp remains the server root)

function Write-F64Stamp {
    param([string]$Phase)
    if (-not $Phase) { return }
    try {
        $ts = (Get-Date).ToUniversalTime().ToString('o')
        Write-Host ('[F64] ' + $ts + ' ' + $Phase)
    } catch { }
}

function Get-F64HostFacts {
    $image = [string]$env:ImageOS
    $runner = [string]$env:RUNNER_OS
    $winver = ''
    try {
        $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        $winver = ([string]$cv.ProductName + ' ' + [string]$cv.DisplayVersion + ' build=' + [string]$cv.CurrentBuild)
    } catch { $winver = [string][System.Environment]::OSVersion.VersionString }
    $dExists = $false
    try { $dExists = [bool](Test-Path -LiteralPath 'D:\') } catch { $dExists = $false }
    $defender = 'unreadable'
    try {
        $mp = Get-MpComputerStatus -ErrorAction Stop
        if ([bool]$mp.RealTimeProtectionEnabled) { $defender = 'realtime-on' } else { $defender = 'realtime-off' }
        Write-Host ('[F64] defender RealTimeProtectionEnabled=' + [bool]$mp.RealTimeProtectionEnabled + ' (F64 does NOT disable Defender; skip duplicate work if already off)')
    } catch {
        $defender = 'unreadable'
        Write-Host ('[F64] defender status unreadable: ' + $_.Exception.Message)
    }
    $prebuilt = $false
    $prebuiltN = 0
    try {
        $prebuilt = [bool](Test-Path -LiteralPath 'C:\ghrdp\prebuilt')
        if ($prebuilt) { $prebuiltN = @(Get-ChildItem -LiteralPath 'C:\ghrdp\prebuilt' -File -ErrorAction SilentlyContinue).Count }
    } catch { }
    $root = 'C:\ghrdp'
    if ($dExists) { $root = 'D:\ghrdp-install' }
    Write-Host ('[F64] host runnerOS=' + $runner + ' imageOS=' + $image + ' win=' + $winver)
    Write-Host ('[F64] D_DRIVE exists=' + $dExists + ' (GitHub-hosted IOPS are NOT the research 83k figure; logged for measurement)')
    Write-Host ('[F64] prebuilt_cache exists=' + $prebuilt + ' files=' + $prebuiltN)
    Write-Host ('[F64] preferred_install_root=' + $root + ' (server root stays C:\ghrdp - F9k/F25 pins)')
    return @{
        imageOS = $image
        runnerOS = $runner
        winver = $winver
        dDrive = $dExists
        defender = $defender
        prebuiltCache = $prebuilt
        installRoot = $root
    }
}

function Resolve-F64InstallRoot {
    try {
        if (Test-Path -LiteralPath 'D:\') {
            $p = 'D:\ghrdp-install'
            New-Item -ItemType Directory -Path $p -Force -ErrorAction SilentlyContinue | Out-Null
            return $p
        }
    } catch { }
    return 'C:\ghrdp'
}

function Start-F64BgJob {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock,
        [object[]]$ArgumentList
    )
    $useThread = $false
    try { if (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue) { $useThread = $true } } catch { $useThread = $false }
    if ($useThread) {
        Write-Host '[F64] Start-F64BgJob engine=Start-ThreadJob'
        try {
            if ($null -ne $ArgumentList) { return Start-ThreadJob -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList }
            return Start-ThreadJob -ScriptBlock $ScriptBlock
        } catch {
            Write-Host ('[F64] Start-ThreadJob threw; falling back to Start-Job: ' + $_.Exception.Message)
        }
    } else {
        Write-Host '[F64] Start-F64BgJob engine=Start-Job (ThreadJob module missing)'
    }
    if ($null -ne $ArgumentList) { return Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList }
    return Start-Job -ScriptBlock $ScriptBlock
}
