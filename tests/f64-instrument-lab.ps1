# [F64] PS lab - instrumentation helpers + ThreadJob fallback.
# Runs on the windows-native lane (this sandbox has no PowerShell interpreter).
$ErrorActionPreference = 'Stop'
$ws = Split-Path -Parent $PSScriptRoot
$fails = 0
$passes = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $verdict = 'FAIL'
    if ($Ok) { $verdict = 'PASS'; $script:passes++ } else { $script:fails++ }
    $line = '[F64 lab] ' + $verdict + ' ' + $Name
    if ($Detail) { $line = $line + ' :: ' + $Detail }
    Write-Host $line
}

$mod = Join-Path $ws 'payloads\f64-instrument.ps1'
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($mod, [ref]$null, [ref]$errs)
Check 'parse payloads/f64-instrument.ps1' (-not $errs) ($(if ($errs) { $errs[0].Message } else { 'ok' }))
. $mod
Check 'Write-F64Stamp exists' ($null -ne (Get-Command Write-F64Stamp -ErrorAction SilentlyContinue))
Check 'Get-F64HostFacts exists' ($null -ne (Get-Command Get-F64HostFacts -ErrorAction SilentlyContinue))
Check 'Start-F64BgJob exists' ($null -ne (Get-Command Start-F64BgJob -ErrorAction SilentlyContinue))
Check 'Resolve-F64InstallRoot exists' ($null -ne (Get-Command Resolve-F64InstallRoot -ErrorAction SilentlyContinue))

$facts = Get-F64HostFacts
Check 'host facts return a hashtable' ($facts -is [hashtable] -or $facts -is [System.Collections.Hashtable]) ('defender=' + [string]$facts.defender)
$root = Resolve-F64InstallRoot
Check 'install root is D:\ghrdp-install or C:\ghrdp' ($root -eq 'D:\ghrdp-install' -or $root -eq 'C:\ghrdp') ('root=' + $root)

# ThreadJob (when present) vs Start-Job: we only assert the helper returns a job
# that Wait-Job can join. Wall-time 8x is NOT claimed as production.
$job = Start-F64BgJob -ScriptBlock { 'f64-lab-ok' }
$null = Wait-Job -Job $job -Timeout 30
$r = Receive-Job -Job $job -Wait
Check 'Start-F64BgJob + Wait-Job returns the payload' ([string]$r -eq 'f64-lab-ok') ('state=' + $job.State + ' result=' + $r)
Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

$main = Get-Content -LiteralPath (Join-Path $ws '.github/workflows\main.yml') -Raw
Check 'main.yml loads f64-instrument.ps1' ($main -match 'f64-instrument\.ps1')
Check 'main.yml uses Start-F64BgJob on the pre-warm legs' (([regex]::Matches($main, 'Start-F64BgJob')).Count -ge 4)
$dash = $main.IndexOf('Start Mission Control dashboard EARLY')
$qbt = $main.IndexOf('Install qBittorrent 4.6.5 (F59 prebuilt, SHA-256 verified)')
Check 'qBittorrent transport install is AFTER dashboard-reachable' ($dash -ge 0 -and $qbt -gt $dash) ('dash=' + $dash + ' qbt=' + $qbt)
Check 'no guaranteed-6-min claim in F64 docs' (-not ((Get-Content -LiteralPath (Join-Path $ws 'docs\F64-BASELINE.md') -Raw) -match 'guaranteed 6'))

Write-Host ('[F64 lab] ' + $passes + ' PASS, ' + $fails + ' FAIL')
if ($fails -gt 0) { exit 1 }
Write-Host 'F64 instrument lab PASS'
exit 0
