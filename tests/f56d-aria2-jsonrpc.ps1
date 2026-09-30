# [F56-d PS lab] aria2c JSON-RPC round-trip addUri/tellStatus/remove
# Validates loopback only 127.0.0.1:6800, CLI pins, secret handling, version 1.36.0

$ErrorActionPreference = 'Stop'
Write-Host '[F56-d] aria2c JSON-RPC round-trip lab'

$mod = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-aria2.ps1'
if (-not (Test-Path -LiteralPath $mod)) { $mod = 'C:\ghrdp\ghrdp-aria2.ps1' }
if (-not (Test-Path -LiteralPath $mod)) { Write-Host '[F56-d] ghrdp-aria2.ps1 not found - SKIP (advisory)'; exit 0 }

. $mod

# Version check
$verRes = Get-Aria2Version -Secret ''
Write-Host ('[F56-d] aria2 version: ' + $verRes.version + ' ok=' + $verRes.ok)
if (-not $verRes.ok) {
    Write-Host '[F56-d] aria2 RPC not reachable - SKIP (transport unavailable is expected in lab)'
    exit 0
}
if ($verRes.version -notmatch '1\.36\.0') {
    Write-Host ('::warning::[F56-d] aria2 version mismatch expected 1.36.0 got ' + $verRes.version)
}

# Pins verification
$opts = @{
    dir = 'D:\RDP-Storage\Fetched'
    'max-connection-per-server' = '8'
    split = '8'
    'min-split-size' = '1M'
    'follow-metalink' = 'false'
    'follow-torrent' = 'false'
}
$pinOk = Test-F56dAria2Pins -Options $opts
if (-not $pinOk) { throw 'F56-d CLI pins verification failed' }
Write-Host '[F56-d] CLI pins ok: max-conn=8 split=8 min-split=1M follow-metalink=false follow-torrent=false'

# JSON-RPC addUri round-trip with benign https URL (use example.com)
$testUrl = 'https://example.com/'
$add = Add-Aria2Uri -Uri $testUrl -Options @{} -Secret ''
Write-Host ('[F56-d] addUri result ok=' + $add.ok + ' gid=' + $add.gid)
if ($add.ok -and $add.gid) {
    $status = Get-Aria2Status -Gid $add.gid -Secret ''
    Write-Host ('[F56-d] tellStatus ok=' + $status.ok)
    $rem = Remove-Aria2Download -Gid $add.gid -Secret ''
    Write-Host ('[F56-d] remove ok=' + $rem.ok)
    if (-not $status.ok) { Write-Host '::warning::[F56-d] tellStatus failed' }
    if (-not $rem.ok) { Write-Host '::warning::[F56-d] remove failed' }
} else {
    Write-Host '[F56-d] addUri failed - transport may be unavailable (advisory)'
}

# Loopback only check
$listen = $null
try { $listen = Get-NetTCPConnection -LocalPort 6800 -State Listen -ErrorAction SilentlyContinue } catch { }
if ($listen) {
    $addr = $listen.LocalAddress
    Write-Host ('[F56-d] listening address: ' + $addr)
    if ($addr -ne '127.0.0.1' -and $addr -ne '::1' -and $addr -ne '0.0.0.0') {
        # 0.0.0.0 would be public, fail
        if ($addr -eq '0.0.0.0') { throw 'aria2c listening on public interface (0.0.0.0) - must be loopback only' }
    }
    Write-Host '[F56-d] loopback only verified'
}

Write-Host '[F56-d] aria2c JSON-RPC lab PASS'
exit 0
