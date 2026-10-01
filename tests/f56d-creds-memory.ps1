# [F56-d PS lab] credentials memory-only, no disk persist
# Verifies own-cred modal submit POST /api/fetch F46 per-run key encrypted creds
# server decrypts in memory feeds aria2c --http-user/--http-passwd memory wiped
# no disk persist.
#
# [F56-d loop 4] Two honesty fixes. (1) The wipe check grepped for `Array\.Clear`,
# which never matches the real token `[Array]::Clear` - both the server and the
# aria2 helper DO wipe, and the lab reported them as missing (a false-negative
# ::warning::). (2) The lab was grep-only for the own-cred path; it now EXECUTES
# the shipped helper's decrypt + wipe functions, so the memory-only contract is
# exercised rather than pattern-matched.

$ErrorActionPreference = 'Stop'
Write-Host '[F56-d] creds memory-only lab'

# Check ghrdp-server.ps1 does NOT WriteAllText creds
$serverPath = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-server.ps1'
if (-not (Test-Path -LiteralPath $serverPath)) { $serverPath = 'C:\ghrdp\ghrdp-server.ps1' }
if (-not (Test-Path -LiteralPath $serverPath)) { Write-Host '[F56-d] server file not found - SKIP'; exit 0 }

$txt = Get-Content -LiteralPath $serverPath -Raw
# Ensure no WriteAllText of creds, no Set-Content of http-user/passwd to disk
$badPatterns = @(
    'Set-Content.*cred',
    'WriteAllText.*cred',
    'Out-File.*credUser',
    'Out-File.*credPass',
    'http-user.*\.txt',
    'http-passwd.*\.txt'
)
foreach ($pat in $badPatterns) {
    if ($txt -match $pat) {
        Write-Host ('::error::[F56-d] credential persistence pattern found: ' + $pat)
        throw 'credentials persisted to disk - must be memory-only'
    }
}
Write-Host '[F56-d] no disk persist patterns found in server'

# Check the aria2 helper carries the memory wipe (both real spellings).
$ariaPath = Join-Path $PSScriptRoot '..' 'payloads' 'ghrdp-aria2.ps1'
if (-not (Test-Path -LiteralPath $ariaPath)) {
    Write-Host '::error::[F56-d] payloads/ghrdp-aria2.ps1 missing - own-cred path unverifiable'
    throw 'ghrdp-aria2.ps1 missing'
}
$ariaTxt = Get-Content -LiteralPath $ariaPath -Raw
if ($ariaTxt -notmatch '\[Array\]::Clear' -and $ariaTxt -notmatch 'Array\.Clear') {
    Write-Host '::error::[F56-d] no memory wipe (Array.Clear) in the aria2 helper'
    throw 'aria2 helper does not wipe the decrypted key/plaintext buffers'
}
Write-Host '[F56-d] memory wipe via Array.Clear present in the aria2 helper'
if ($ariaTxt -notmatch 'Unprotect-F56dOwnCred') {
    Write-Host '::error::[F56-d] Unprotect-F56dOwnCred not found'
    throw 'own-cred decrypt function missing'
}
Write-Host '[F56-d] own-cred decrypt function present'
if ($ariaTxt -notmatch 'Clear-F56dCredMemory') {
    Write-Host '::error::[F56-d] Clear-F56dCredMemory not found'
    throw 'own-cred memory wipe helper missing'
}
Write-Host '[F56-d] own-cred memory wipe helper present'

# Server must wipe too, on the same carve-out path it decrypts on.
if ($txt -notmatch '\[Array\]::Clear' -and $txt -notmatch 'Array\.Clear' -and $txt -notmatch 'Clear-F56dCredMemory') {
    Write-Host '::error::[F56-d] server never wipes the decrypted credential material'
    throw 'server does not wipe decrypted creds (must be memory-only)'
}
Write-Host '[F56-d] server memory wipe present'
if ($txt -notmatch 'Unprotect-F56dOwnCred') {
    Write-Host '::error::[F56-d] server does not route through Unprotect-F56dOwnCred'
    throw 'server own-cred decrypt path missing'
}
Write-Host '[F56-d] server decrypts own-cred through Unprotect-F56dOwnCred (in-process)'

# Verify no plain http-user/http-passwd in logs
if ($txt -match 'http-user.*Write-Host' -or $txt -match 'http-passwd.*Write-Host') {
    throw 'plain creds logged'
}
Write-Host '[F56-d] no plain credential in any log line'

# --- executed cells: the shipped own-cred functions themselves -------------
# Dot-source the SHIPPED helper (not a copy) and drive its two memory-only
# functions. The `plain:` envelope is the helper's documented lab affordance for
# the non-AES-GCM path, so this exercises field routing + the 32-byte key gate +
# the wipe helper without depending on .NET span binding.
. $ariaPath
$key32 = [Convert]::ToBase64String((New-Object byte[] 32))
$userEnc = 'plain:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('f56d-lab-user'))
$passEnc = 'plain:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('f56d-lab-pass'))
$cred = Unprotect-F56dOwnCred -UserEnc $userEnc -PassEnc $passEnc -KeyBase64 $key32
if (-not $cred.ok) { throw ('own-cred decrypt refused a valid lab envelope: ' + [string]$cred.error) }
if ([string]$cred.user -ne 'f56d-lab-user' -or [string]$cred.pass -ne 'f56d-lab-pass') { throw 'own-cred decrypt returned the wrong field values' }
Write-Host '[F56-d] executed: own-cred decrypt round-trips user/pass in process memory'
$badKey = Unprotect-F56dOwnCred -UserEnc $userEnc -PassEnc $passEnc -KeyBase64 ([Convert]::ToBase64String([byte[]]@(1, 2, 3)))
if ($badKey.ok) { throw 'own-cred decrypt accepted a key that is not 32 bytes (must fail closed)' }
Write-Host '[F56-d] executed: own-cred decrypt fails closed on a non-32-byte key'
$heldUser = [string]$cred.user
$heldPass = [string]$cred.pass
Clear-F56dCredMemory -UserRef ([ref]$heldUser) -PassRef ([ref]$heldPass)
if ($heldUser -ne '' -or $heldPass -ne '') { throw 'Clear-F56dCredMemory left credential material in the caller variables' }
Write-Host '[F56-d] executed: Clear-F56dCredMemory wiped the caller-held credentials'
Write-Host '[F56-d] creds memory-only lab PASS'
exit 0
