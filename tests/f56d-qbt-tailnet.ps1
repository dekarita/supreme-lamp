# [F56-d §2 PS lab] qBittorrent-nox torrent lane: Tailnet-only WebUI (public refused),
# legal-torrent allowlist, magnet refusal, SHA pin ladder, password never logged.
# The lane module is the SHIPPED payloads/ghrdp-qbt.ps1 (dot-sourced, policy file
# loaded from payloads/ghrdp-qbt-policy.json) - nothing is re-implemented here.
# Cells that need a live tailnet daemon report a labeled SKIP instead of a vacuous
# PASS: a CI runner is not on the operator's tailnet.

$ErrorActionPreference = 'Stop'
Write-Host '[F56-d] qBittorrent-nox Tailnet-only torrent lane lab'
$cells = @()
# Safety net: an UNEXPECTED terminating error must still name itself (and its
# position) instead of dying silently behind an unreachable job log.
trap {
    # Both the message and the POSITION travel as workflow commands: the raw job log
    # is unreachable from every environment, so anything printed plainly is lost.
    Write-Host ('::error title=F56-d qbt lab::' + $_.Exception.Message)
    Write-Host ('::error title=F56-d qbt at::' + (([string]$_.InvocationInfo.PositionMessage) -replace "`r?`n", ' | '))
    Write-Host ('::notice::F56-d qbt lane cells: ' + (@($script:cells) -join ' | '))
    exit 1
}
function Pass-Lab([string]$name) { $script:cells += ('PASS ' + $name); Write-Host ('[F56-d] PASS ' + $name) }
function Skip-Lab([string]$name, [string]$why) { $script:cells += ('SKIP ' + $name + ' (' + $why + ')'); Write-Host ('[F56-d] SKIP ' + $name + ' - ' + $why) }
function Fail-Lab([string]$name, [string]$why) { Write-Host ('::error title=F56-d qbt::' + $name + ' :: ' + $why); throw ('F56-d qbt lab: ' + $name + ' - ' + $why) }
function Note-Lab([string]$name) { $script:cells += ('NOTE ' + $name); Write-Host ('[F56-d] NOTE ' + $name) }

$mod = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-qbt.ps1'
if (-not (Test-Path -LiteralPath $mod)) { $mod = 'C:\ghrdp\ghrdp-qbt.ps1' }
if (-not (Test-Path -LiteralPath $mod)) { Fail-Lab 'lane-module' 'ghrdp-qbt.ps1 not found' }
$polPath = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-qbt-policy.json'
if (-not (Test-Path -LiteralPath $polPath)) { $polPath = 'C:\ghrdp\ghrdp-qbt-policy.json' }
if (-not (Test-Path -LiteralPath $polPath)) { Fail-Lab 'lane-policy' 'ghrdp-qbt-policy.json not found' }
$env:GHRDP_QBT_POLICY = $polPath
. $mod
if (-not $script:QbtPolicyOk) { Fail-Lab 'policy-loaded' ('the lane did not load the policy: ' + $script:QbtPolicyReason) }
if ($script:QbtWebUiPort -ne 8080) { Fail-Lab 'policy-port' ('expected 8080, got ' + $script:QbtWebUiPort) }
if ($script:QbtCategory -ne 'ghrdp-fetched') { Fail-Lab 'policy-category' ('expected ghrdp-fetched, got ' + $script:QbtCategory) }
if ($script:QbtSavePath -notmatch 'RDP-Storage') { Fail-Lab 'policy-savepath' ('unexpected save path ' + $script:QbtSavePath) }
Pass-Lab 'policy-single-source (port/category/save path from ghrdp-qbt-policy.json)'

# Z: tailnet predicate matrix (the shipped regex, values pulled from the policy file).
$accept = @('100.64.0.1', '100.80.12.34', '100.127.255.254')
$reject = @('100.63.255.255', '100.128.0.1', '10.0.0.1', '192.168.0.10', '8.8.8.8', '100.64.0.1evil', '100.64.0.256', '*', '0.0.0.0', '::1')
foreach ($ip in $accept) { if (-not (Test-GhrdpQbtTailnetAddress -Ip $ip)) { Fail-Lab 'tailnet-matrix' ($ip + ' was rejected') } }
foreach ($ip in $reject) { if (Test-GhrdpQbtTailnetAddress -Ip $ip) { Fail-Lab 'tailnet-matrix' ($ip + ' was accepted as a tailnet bind') } }
Pass-Lab 'tailnet-predicate-matrix (3 accept / 10 reject)'

# A: the hard guard refuses every public/any bind and accepts only a tailnet literal.
$guardRejects = @('*', '0.0.0.0', '::', '8.8.8.8', '', '10.0.0.5')
foreach ($bad in $guardRejects) {
    $threw = $false
    try { $null = Assert-GhrdpQbtTailnetOnly -Address $bad -Port 8080 } catch { $threw = $true }
    if (-not $threw) { Fail-Lab 'tailnet-guard' ('the guard accepted ' + $bad) }
}
$threwPort = $false
try { $null = Assert-GhrdpQbtTailnetOnly -Address '100.64.0.7' -Port 9090 } catch { $threwPort = $true }
if (-not $threwPort) { Fail-Lab 'tailnet-guard' 'a non-8080 WebUI port was accepted' }
if (-not (Assert-GhrdpQbtTailnetOnly -Address '100.64.0.7' -Port 8080)) { Fail-Lab 'tailnet-guard' 'a tailnet literal was refused' }
Pass-Lab 'tailnet-only-guard (public/*/wrong-port refused, tailnet accepted)'

# B: the config writer persists the tailnet literal and refuses a public one.
$tmpDir = Join-Path $env:TEMP ('ghrdp-qbt-lab-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$tmpConf = Join-Path $tmpDir 'qBittorrent.conf'
$wrote = Set-GhrdpQbtWebUiConfig -Address '100.64.0.7' -Port 8080 -ConfPath $tmpConf
if (-not $wrote.ok) { Fail-Lab 'webui-config' 'the writer refused a tailnet literal' }
$confTxt = Get-Content -LiteralPath $tmpConf -Raw
foreach ($want in @('WebUI\Address=100.64.0.7', 'WebUI\Port=8080', 'WebUI\CSRFProtection=true', 'WebUI\HostHeaderValidation=true', 'WebUI\ClickjackingProtection=true', 'WebUI\Username=ghrdp')) {
    if ($confTxt -notmatch [regex]::Escape($want)) { Fail-Lab 'webui-config' ('missing ' + $want) }
}
if ($confTxt -match 'WebUI\\Address=(0\.0\.0\.0|\*)') { Fail-Lab 'webui-config' 'a public bind was written' }
$threwWrite = $false
try { $null = Set-GhrdpQbtWebUiConfig -Address '0.0.0.0' -Port 8080 -ConfPath $tmpConf } catch { $threwWrite = $true }
if (-not $threwWrite) { Fail-Lab 'webui-config' 'the writer accepted 0.0.0.0' }
Pass-Lab 'webui-config (tailnet literal written, 0.0.0.0 refused, auth hardening on)'

# C: legal-torrent allowlist + magnet/non-HTTPS refusal + operator own URL.
$okUbuntu = Test-GhrdpQbtTorrentAllowed -Url 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso.torrent'
if (-not $okUbuntu.ok -or $okUbuntu.preset -ne 'linux-distros') { Fail-Lab 'allowlist' 'ubuntu release artifact was not allowed' }
$okBlender = Test-GhrdpQbtTorrentAllowed -Url 'https://download.blender.org/demo/movies/ToS/ToS-4k-1920.mov.torrent'
if (-not $okBlender.ok) { Fail-Lab 'allowlist' 'blender open-movie artifact was not allowed' }
$okIa = Test-GhrdpQbtTorrentAllowed -Url 'https://archive.org/download/nasa_apollo11/archive.torrent'
if (-not $okIa.ok -or $okIa.preset -ne 'ia-torrents') { Fail-Lab 'allowlist' 'Internet Archive artifact was not allowed' }
$magnet = Test-GhrdpQbtTorrentAllowed -Url 'magnet:?xt=urn:btih:deadbeef'
if ($magnet.ok -or $magnet.reason -ne 'magnet-refused') { Fail-Lab 'allowlist' 'a magnet-only flow was not refused' }
$http = Test-GhrdpQbtTorrentAllowed -Url 'http://archive.org/download/x/y.torrent'
if ($http.ok -or $http.reason -ne 'https-only') { Fail-Lab 'allowlist' 'an http artifact was not refused' }
$spoof = Test-GhrdpQbtTorrentAllowed -Url 'https://ubuntu.com.evil.example/x.torrent'
if ($spoof.ok) { Fail-Lab 'allowlist' 'a suffix-spoof host was allowed' }
$indexer = Test-GhrdpQbtTorrentAllowed -Url 'https://1337x.to/torrent/1234/x/'
if ($indexer.ok) { Fail-Lab 'allowlist' 'a torrent-indexer host was allowed' }
$own = Test-GhrdpQbtTorrentAllowed -Url 'https://mirror.example.net/big.torrent' -OwnUrls @('https://mirror.example.net/big.torrent')
if (-not $own.ok -or $own.preset -ne 'operator-own-url') { Fail-Lab 'allowlist' 'an operator own URL was not honoured' }
$ownSpoof = Test-GhrdpQbtTorrentAllowed -Url 'https://evil.example.com/big.torrent' -OwnUrls @('https://mirror.example.net/big.torrent')
if ($ownSpoof.ok) { Fail-Lab 'allowlist' 'an own URL leaked to another host' }
Pass-Lab 'legal-torrent-allowlist (distros/blender/IA + own URL, magnet/http/spoof/indexer refused)'

# D: SHA pin ladder - no fabricated digest, mismatch fails closed, TOFU records once.
$bin = Join-Path $tmpDir 'qbittorrent-nox.exe'
[System.IO.File]::WriteAllBytes($bin, [byte[]](1..64))
$pinFile = Join-Path $tmpDir 'qbt-sha256.pin'
$first = Test-GhrdpQbtShaPin -Path $bin -PinPath $pinFile
if (-not $first.ok -or $first.mode -ne 'recorded') { Fail-Lab 'sha-pin' ('first run mode=' + $first.mode) }
$second = Test-GhrdpQbtShaPin -Path $bin -PinPath $pinFile
if (-not $second.ok -or $second.mode -ne 'verified' -or $second.sha256 -ne $first.sha256) { Fail-Lab 'sha-pin' 'the recorded digest was not compared on the next run' }
$mismatch = Test-GhrdpQbtShaPin -Path $bin -PinPath $pinFile -Expected ('0' * 64)
if ($mismatch.ok -or $mismatch.reason -ne 'qbt-sha-pin-mismatch') { Fail-Lab 'sha-pin' 'a digest mismatch did not fail closed' }
[System.IO.File]::WriteAllBytes($bin, [byte[]](9..200))
$changed = Test-GhrdpQbtShaPin -Path $bin -PinPath $pinFile
if ($changed.ok) { Fail-Lab 'sha-pin' 'a CHANGED binary passed the recorded pin' }
Pass-Lab 'sha-pin-ladder (recorded -> verified -> mismatch fails closed)'

# E: the password never reaches a log line, and there is no auth-disabling path.
$laneTxt = Get-Content -LiteralPath $mod -Raw
foreach ($pat in @('Write-Host.*\$pw\b', 'Write-Output.*QbtPassword', 'LocalHostAuth=false', 'WebUI\\Address=\*')) {
    if ($laneTxt -match $pat) { Fail-Lab 'secret-hygiene' ('payload matches ' + $pat) }
}
if ($laneTxt -notmatch 'Array\]::Clear|\.Dispose\(\)') { Fail-Lab 'secret-hygiene' 'no memory wipe path in the lane' }
$env:GHRDP_QBT_PASSWORD = 'lab-only-password'
$readBack = Get-GhrdpQbtPassword
if ($readBack -ne 'lab-only-password') { Fail-Lab 'secret-hygiene' 'the operator password was not read from the environment' }
$env:GHRDP_QBT_PASSWORD = ''
Pass-Lab 'secret-hygiene (no log path, env-sourced, memory wiped)'

# F: reachability failures are LABELED, never a silent pass and never an
# unauthenticated fallback. 127.0.0.1:1 has nothing listening.
try { $dead = Connect-GhrdpQbt -Address '127.0.0.1' -Port 1 } catch { Fail-Lab 'fail-closed-connect' $_.Exception.Message }
if ($dead.ok) { Fail-Lab 'fail-closed' 'a dead WebUI reported a successful session' }
if (-not $dead.reason) { Fail-Lab 'fail-closed' 'the failure carried no labeled reason' }
try { $ready = Get-GhrdpQbtTransportReady -Address '127.0.0.1' -Port 1 } catch { Fail-Lab 'fail-closed-ready' $_.Exception.Message }
if ($ready.ready) { Fail-Lab 'fail-closed' 'a dead WebUI reported transport ready' }
Pass-Lab ('fail-closed (labeled reason: ' + $dead.reason + ')')

# G: live lane cell - only meaningful on a tailnet host with the daemon running.
$bind = Resolve-GhrdpQbtBindAddress
if (-not $bind.ok) {
    Skip-Lab 'live-tailnet-daemon' ('no tailnet bind on this host: ' + $bind.reason)
} else {
    $live = Get-GhrdpQbtTransportReady -Address $bind.address -Port 8080
    if (-not $live.ready) {
        Skip-Lab 'live-tailnet-daemon' ('WebUI not answering on ' + $bind.address + ':8080 (' + $live.reason + ')')
    } else {
        if ($live.version -notmatch '^4\.6') { Note-Lab ('live daemon version ' + $live.version + ' (plan pins 4.6.x)') }
        $cat = Set-GhrdpQbtCategory -Address $bind.address -Port 8080 -Session $live.session
        if (-not $cat.ok) { Fail-Lab 'live-tailnet-daemon' 'category could not be ensured' }
        Pass-Lab ('live-tailnet-daemon (bind ' + $bind.address + ' source ' + $bind.source + ' version ' + $live.version + ' category ok)')
    }
}

# H: behavioural public refusal - the WebUI must refuse a non-tailnet address. When
# this host has no non-tailnet IPv4 (or no daemon) the cell is a labeled SKIP.
$probe = Test-GhrdpQbtPublicRefusal -Address ($(if ($bind.ok) { $bind.address } else { '127.0.0.1' })) -Port 8080
if ($probe.refused -eq $false) { Fail-Lab 'public-refusal' ('the WebUI answered on non-tailnet ' + $probe.candidate) }
if ($probe.refused -eq $null) { Skip-Lab 'public-refusal' $probe.reason }
else { Pass-Lab ('public-refusal (non-tailnet ' + $probe.candidate + ':8080 refused)') }

# I: wiring - the labs and the install step cannot be orphaned.
$gatesPath = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'launch-gates.yml'
$mainPath = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'main.yml'
$gatesTxt = Get-Content -LiteralPath $gatesPath -Raw
$mainTxt = Get-Content -LiteralPath $mainPath -Raw
if ($gatesTxt -notmatch 'tests\\f56d-qbt-tailnet\.ps1') { Fail-Lab 'wiring' 'this lab is not executed in CI' }
if ($mainTxt -notmatch 'Install qBittorrent-nox 4\.6\.x') { Fail-Lab 'wiring' 'the qBittorrent-nox install step is missing' }
if ($mainTxt -notmatch '--require-checksums') { Fail-Lab 'wiring' 'the chocolatey install is not checksum-enforced' }
if ($mainTxt -match '0\.0\.0\.0:8080') { Fail-Lab 'wiring' 'a public WebUI literal is deployed' }
if ($mainTxt -notmatch "GhrdpQbt") { Fail-Lab 'wiring' 'the daemon SYSTEM task is missing' }
Pass-Lab 'wiring (install step + checksum enforcement + this lab in CI)'

Write-Host ('::notice::F56-d qbt lane cells: ' + ($cells -join ' | '))
Write-Host '[F56-d] qBittorrent-nox torrent lane lab PASS'
exit 0
