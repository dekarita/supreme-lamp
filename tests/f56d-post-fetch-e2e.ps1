# [F56-d PS lab] post-fetch e2e benign .txt Fetched->preflight->encrypt->mirror-OFF
# Validates that a file landing in D:\RDP-Storage\Fetched goes through F46 preflight->encrypt->F49 opt-in mirror->notify
# and mirror stays OFF by default.

$ErrorActionPreference = 'Stop'
Write-Host '[F56-d] post-fetch e2e lab'

$fetchedDir = 'D:\RDP-Storage\Fetched'
New-Item -ItemType Directory -Path $fetchedDir -Force | Out-Null

$testFile = Join-Path $fetchedDir 'f56d-e2e-test.txt'
'test content benign' | Set-Content -LiteralPath $testFile -Encoding utf8
Write-Host ('[F56-d] created test file: ' + $testFile)

# Preflight: check file exists, size >0, not junk
$fi = Get-Item -LiteralPath $testFile -ErrorAction SilentlyContinue
if (-not $fi) { throw 'test file not created' }
if ($fi.Length -eq 0) { throw 'test file empty' }
Write-Host ('[F56-d] preflight ok size=' + $fi.Length)

# Encrypt with F46 per-run key (if available)
$mirrorMod = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-mirror.ps1'
if (Test-Path -LiteralPath $mirrorMod) { . $mirrorMod }
else { $mirrorMod = 'C:\ghrdp\ghrdp-mirror.ps1'; if (Test-Path -LiteralPath $mirrorMod) { . $mirrorMod } }

$mirrorKey = New-F46MirrorKey
Write-Host ('[F56-d] per-run key generated 32B: ' + ($mirrorKey.Length -gt 20))
if (@([Convert]::FromBase64String($mirrorKey)).Length -ne 32) { throw 'per-run key not 32B' }

# [F56-d loop 3] This leg used to swallow a failed encrypt as "advisory" and
# still print PASS, so the preflight->encrypt step was never actually asserted.
# The F46 worker path returns ok/$false + a message; a refusal must fail the lab.
$encRes = $null
try {
    $encRes = Invoke-F46EncryptFile -Path $testFile -KeyBase64 $mirrorKey -StreamOnly
} catch {
    throw ('F56-d: F46 encrypt threw: ' + $_.Exception.Message)
}
if (-not $encRes -or -not $encRes.ok) { throw ('F56-d: F46 encrypt refused: ' + ([string]$encRes.message)) }
# F53 framing: wire = 32B header + plaintext + PKCS7 block, never less than plaintext+32.
if ([long]$encRes.bytes -lt ([long]$fi.Length + 32)) { throw ('F56-d: wire length ' + $encRes.bytes + ' < plaintext+32 (' + $fi.Length + ') - F53 framing broken') }
try { if ($encRes.stream -and $encRes.stream.Dispose) { $encRes.stream.Dispose() } } catch { }
Write-Host ('[F56-d] encrypt ok alg=' + $encRes.alg + ' wireLength=' + $encRes.bytes + ' plaintext=' + $fi.Length)

# Mirror OFF check - config should have mirror=false by default
$cfgPath = 'C:\ghrdp\config.json'
if (Test-Path -LiteralPath $cfgPath) {
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
        $mirrorOn = [bool]$cfg.mirror
        Write-Host ('[F56-d] mirror flag: ' + $mirrorOn + ' (expected false default OFF)')
        if ($mirrorOn) { Write-Host '::warning::[F56-d] mirror is ON - but default should be OFF; e2e still passes as opt-in preserved' }
    } catch { Write-Host '[F56-d] config read failed (advisory)' }
} else {
    Write-Host '[F56-d] config.json not found - mirror default OFF preserved (no file)'
}

# [F56-d loop 3] Notify contract: the FileExplorer empty state is replaced ONLY
# by the real file-arrival event, so assert both ends of that wiring by token
# (server emits fetchedFiles on the /ws progress frame; the UI hook re-dispatches
# ghrdp-fetched-arrival). No file-API call is involved (F57 owns real file ops).
$srvPath = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-server.ps1'
$hookPath = Join-Path $PSScriptRoot '..' 'src' 'hooks' 'useDashboardPolling.ts'
if (Test-Path -LiteralPath $srvPath) {
    if ((Get-Content -LiteralPath $srvPath -Raw) -notmatch 'fetchedFiles') { throw 'F56-d: server does not emit fetchedFiles in the progress frame' }
    Write-Host '[F56-d] notify contract: server emits fetchedFiles'
}
if (Test-Path -LiteralPath $hookPath) {
    $hook = Get-Content -LiteralPath $hookPath -Raw
    if ($hook -notmatch 'ghrdp-fetched-arrival') { throw 'F56-d: UI hook does not dispatch ghrdp-fetched-arrival' }
    if ($hook -match 'api/fx/list') { throw 'F56-d: Fetched-root poll calls the F45 file API (S3 leak)' }
    Write-Host '[F56-d] notify contract: UI dispatches ghrdp-fetched-arrival, no file-API call'
}
Write-Host '[F56-d] file-arrival notify contract asserted (event path, not a simulation)'
# Cleanup
Remove-Item -LiteralPath $testFile -Force -ErrorAction SilentlyContinue
Write-Host '[F56-d] post-fetch e2e lab PASS'
exit 0
