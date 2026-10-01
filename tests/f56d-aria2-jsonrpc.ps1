# [F56-d PS lab] aria2c JSON-RPC round-trip addUri/tellStatus/pauseAll/remove
# Validates loopback only 127.0.0.1:6800, CLI pins, secret handling, version 1.36.0.
#
# [F56-d loop 3] HONESTY: this lab used to self-SKIP whenever the RPC was not
# reachable, so on an ordinary runner it PASSed without exercising anything.
# GHRDP_F56D_ARIA2_REQUIRED=1 (set by the launch-gates fixture step that really
# installs + starts aria2c 1.36.0 on 127.0.0.1:6800) turns every skip into a hard
# FAIL, and the round-trip now covers all four verbs of the helper surface plus
# wrong-secret rejection, a real HTTPS byte arrival into the download dir, and
# remove-is-effective. Hosts without the fixture keep the advisory skip.

$ErrorActionPreference = 'Stop'
$required = ($env:GHRDP_F56D_ARIA2_REQUIRED -eq '1')
function Fail-Lab([string]$Msg) {
    Write-Host ('::error title=F56-d aria2 lab::' + $Msg)
    throw ('F56-d aria2 lab: ' + $Msg)
}
Write-Host ('[F56-d] aria2c JSON-RPC round-trip lab (required=' + $required + ')')

$mod = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-aria2.ps1'
if (-not (Test-Path -LiteralPath $mod)) { $mod = 'C:\ghrdp\ghrdp-aria2.ps1' }
if (-not (Test-Path -LiteralPath $mod)) {
    if ($required) { Fail-Lab 'ghrdp-aria2.ps1 not found while REQUIRED=1' }
    Write-Host '[F56-d] ghrdp-aria2.ps1 not found - SKIP (advisory)'
    exit 0
}
. $mod

# --- version + transport reachability -------------------------------------
$verRes = Get-Aria2Version -Secret ''
Write-Host ('[F56-d] aria2 version: ' + $verRes.version + ' ok=' + $verRes.ok)
if (-not $verRes.ok) {
    if ($required) { Fail-Lab 'aria2 RPC not reachable on 127.0.0.1:6800 while REQUIRED=1' }
    Write-Host '[F56-d] aria2 RPC not reachable - SKIP (advisory; transport unavailable)'
    exit 0
}
if ($verRes.version -notmatch '1\.36\.0') { Fail-Lab ('version mismatch: expected 1.36.0 got ' + $verRes.version) }
Write-Host '[F56-d] version pin ok: 1.36.0'

# --- loopback-only listener (before any RPC traffic) ----------------------
$listeners = @()
try { $listeners = @(Get-NetTCPConnection -LocalPort 6800 -State Listen -ErrorAction SilentlyContinue) } catch { }
if (-not $listeners -or @($listeners).Count -eq 0) {
    if ($required) { Fail-Lab 'no listener on TCP 6800 while REQUIRED=1 (loopback assertion impossible)' }
    Write-Host '[F56-d] no listener row visible - advisory'
} else {
    foreach ($l in @($listeners)) {
        $addr = [string]$l.LocalAddress
        Write-Host ('[F56-d] listening address: ' + $addr)
        # 0.0.0.0 is public and the old check tested it after excluding it (dead code).
        if ($addr -ne '127.0.0.1' -and $addr -ne '::1') { Fail-Lab ('aria2c bound ' + $addr + ' - loopback only (127.0.0.1/::1) is mandatory') }
    }
    Write-Host '[F56-d] loopback only verified (no 0.0.0.0 / public bind)'
}

# --- secret enforcement ----------------------------------------------------
if ([bool]$env:GHRDP_ARIA2_RPC_SECRET) {
    $wrong = Invoke-Aria2Rpc -Method 'aria2.getVersion' -Params @() -Secret 'f56d-wrong-secret-must-be-rejected'
    if ($wrong.ok) { Fail-Lab 'RPC accepted a WRONG rpc-secret (secret enforcement missing)' }
    Write-Host '[F56-d] wrong-secret rejected as required'
} else {
    Write-Host '[F56-d] no GHRDP_ARIA2_RPC_SECRET on this host - secret-rejection cell advisory'
}

# --- CLI pins --------------------------------------------------------------
$opts = @{
    dir = 'D:\RDP-Storage\Fetched'
    'max-connection-per-server' = '8'
    split = '8'
    'min-split-size' = '1M'
    'follow-metalink' = 'false'
    'follow-torrent' = 'false'
}
$pinOk = Test-F56dAria2Pins -Options $opts
if (-not $pinOk) { Fail-Lab 'CLI pins verification failed' }
Write-Host '[F56-d] CLI pins ok: max-conn=8 split=8 min-split=1M follow-metalink=false follow-torrent=false'

# Effective download dir: the pinned Fetched root, or the fixture's writable dir.
$downloadDir = [string]$env:GHRDP_F56D_ARIA2_DIR
if (-not $downloadDir) {
    if (Test-Path -LiteralPath 'D:\') { $downloadDir = 'D:\RDP-Storage\Fetched' } else { $downloadDir = Join-Path $env:TEMP 'f56d-fetched' }
}
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
Write-Host ('[F56-d] effective download dir: ' + $downloadDir)

# --- addUri + tellStatus fields (gid1) ------------------------------------
$testUrl = 'https://example.com/'
$add = Add-Aria2Uri -Uri $testUrl -Options @{ dir = $downloadDir; 'allow-overwrite' = 'true'; 'auto-file-renaming' = 'false'; 'file-allocation' = 'none' } -Secret ''
Write-Host ('[F56-d] addUri result ok=' + $add.ok + ' gid=' + $add.gid)
if (-not $add.ok -or -not $add.gid) { Fail-Lab ('aria2.addUri failed: ' + ([string]$add.error)) }

$status = Get-Aria2Status -Gid $add.gid -Secret ''
Write-Host ('[F56-d] tellStatus ok=' + $status.ok)
if (-not $status.ok) { Fail-Lab 'aria2.tellStatus failed for a live gid' }
foreach ($field in @('gid', 'status', 'totalLength', 'dir')) {
    if (-not $status.status.PSObject.Properties[$field]) { Fail-Lab ('tellStatus payload lacks ' + $field) }
}
Write-Host ('[F56-d] tellStatus fields ok status=' + $status.status.status + ' totalLength=' + $status.status.totalLength + ' dir=' + $status.status.dir)

# Real byte arrival (advisory: needs https egress from the runner; never red on its own).
$arrived = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $s = Get-Aria2Status -Gid $add.gid -Secret ''
    if (-not $s.ok) { break }
    if ($s.status.status -eq 'complete') { $arrived = $true; break }
    if ($s.status.status -eq 'error') { Write-Host ('::warning::[F56-d] download errored: ' + ([string]$s.status.errorMessage)); break }
}
if ($arrived) {
    $landed = @(Get-ChildItem -LiteralPath $downloadDir -File -ErrorAction SilentlyContinue).Count
    Write-Host ('[F56-d] download complete; files in dir = ' + $landed)
    if ($landed -lt 1) { Fail-Lab 'aria2 reported complete but no file landed in the download dir' }
} else {
    Write-Host '::warning::[F56-d] download did not reach complete within 90s (egress-dependent) - RPC surface still proven'
}

# --- pauseAll (4th verb) ---------------------------------------------------
$pause = Pause-Aria2All -Secret ''
Write-Host ('[F56-d] pauseAll ok=' + $pause.ok)
if (-not $pause.ok) { Fail-Lab 'aria2.pauseAll failed' }

# --- remove is effective (gid2 is throttled to 1B/s so it cannot finish) ---
$add2 = Add-Aria2Uri -Uri $testUrl -Options @{ dir = $downloadDir; 'max-download-limit' = '1'; 'allow-overwrite' = 'true'; 'auto-file-renaming' = 'false'; 'file-allocation' = 'none' } -Secret ''
if (-not $add2.ok -or -not $add2.gid) { Fail-Lab ('second aria2.addUri failed: ' + ([string]$add2.error)) }
$live = Get-Aria2Status -Gid $add2.gid -Secret ''
Write-Host ('[F56-d] gid2 tellStatus ok=' + $live.ok)
if (-not $live.ok) { Fail-Lab 'tellStatus failed for the throttled gid before remove' }
$rem = Remove-Aria2Download -Gid $add2.gid -Secret ''
Write-Host ('[F56-d] remove ok=' + $rem.ok + ' gid=' + $add2.gid)
$gone = Get-Aria2Status -Gid $add2.gid -Secret ''
Write-Host ('[F56-d] tellStatus after remove ok=' + $gone.ok + ' (false expected: gid is gone)')
if ($gone.ok) { Fail-Lab 'tellStatus still resolves a removed gid - remove was not effective' }
if (-not $rem.ok) { Write-Host ('::warning::[F56-d] aria2.remove refused (' + ([string]$rem.error) + ') but the gid is gone - effect proven') }

Write-Host '[F56-d] aria2c JSON-RPC lab PASS (addUri/tellStatus/pauseAll/remove + loopback + secret)'
exit 0
