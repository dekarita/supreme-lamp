# F31: resolve the persisted machine private-key file and fail closed on ACL readback.
# PowerShell 7+ on the RDP host; never invoke in the constrained terminal account.
param(
    [Parameter(Mandatory)] [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
if (-not $Certificate.HasPrivateKey) { throw 'RDP certificate has no private key' }
# [F37 §1] ONE key-file resolver: payloads/rdp-telescope.ps1 owns the search (the
# GN/CNG name a provider reports is not proof of a path - the lab proved that
# with Schannel 36870 / 0x8009030D while this script said 'file missing'). The
# ACE is applied to the file the provider REALLY wrote, and when nothing matches
# the thrown message carries the search evidence (kind/provider/candidates/hits
# /store listings) instead of a bare path.
$name = ''
$candidates = @()
$found = ''
$evidence = ''
$telMod = Join-Path $PSScriptRoot 'rdp-telescope.ps1'
if ((Test-Path -LiteralPath $telMod -PathType Leaf) -and -not (Get-Command 'Resolve-RdpTelescopeKeyFile' -ErrorAction SilentlyContinue)) {
    try { . $telMod } catch { $evidence = ('module dot-source failed: ' + $_.Exception.Message) }
}
if (Get-Command 'Resolve-RdpTelescopeKeyFile' -ErrorAction SilentlyContinue) {
    $kr = Resolve-RdpTelescopeKeyFile -Certificate $Certificate
    $name = [string]$kr.name
    $candidates = @($kr.candidates)
    $found = [string]$kr.found
    $evidence = ('kind=' + [string]$kr.kind + ' provider=' + [string]$kr.provider + ' candidates=[' + (@($kr.candidates) -join ',') + '] hits=[' + (@($kr.hits) -join ',') + '] stores=[' + (@($kr.dirSample) -join ' | ') + ']')
} else {
    $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
    if (-not $key) { $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($Certificate) }
    if (-not $key) { throw 'RDP certificate key is neither RSA nor ECDSA' }
    try {
        if ($key -is [System.Security.Cryptography.RSACng] -or $key -is [System.Security.Cryptography.ECDsaCng]) {
            $name = $key.Key.UniqueName
            $roots = @((Join-Path $env:ProgramData 'Microsoft\Crypto\Keys'), (Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys'))
        } elseif ($key -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
            $name = $key.CspKeyContainerInfo.UniqueKeyContainerName
            if (-not $key.CspKeyContainerInfo.MachineKeyStore) { throw 'CSP key is not a machine key' }
            $roots = @((Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys'), (Join-Path $env:ProgramData 'Microsoft\Crypto\Keys'))
        } else { throw ('Unsupported persisted key provider: ' + $key.GetType().FullName) }
    } finally { $key.Dispose() }
    if ($name -and $name -notmatch '[\\/]') {
        foreach ($r in $roots) { if (Test-Path -LiteralPath $r -PathType Container) { $candidates += (Join-Path $r $name) } }
        foreach ($c in $candidates) { if ((-not $found) -and (Test-Path -LiteralPath $c -PathType Leaf)) { $found = $c } }
        $evidence = ('candidates=[' + ($candidates -join ',') + ']')
    }
}
if (-not $name -or $name -match '[\\/]') { throw 'Invalid persisted key container name' }
if (-not $found) { $found = [string](@($candidates) | Select-Object -First 1) }
if (-not $found -or -not (Test-Path -LiteralPath $found -PathType Leaf)) {
    throw ('Persisted machine key file missing: ' + $name + ' (tried: ' + (@($candidates) -join ', ') + ') ' + $evidence)
}
$file = $found
$ns = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20')
$sys = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
try {
    $acl = Get-Acl -LiteralPath $file -ErrorAction Stop
    if (-not $VerifyOnly) {
        $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($ns, [System.Security.AccessControl.FileSystemRights]::Read, $allow))
        $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sys, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
        Set-Acl -LiteralPath $file -AclObject $acl -ErrorAction Stop
    }
    $after = Get-Acl -LiteralPath $file -ErrorAction Stop
    $aces = @($after.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($required in @(
        @{ Sid = $ns; Rights = [System.Security.AccessControl.FileSystemRights]::Read },
        @{ Sid = $sys; Rights = [System.Security.AccessControl.FileSystemRights]::FullControl }
    )) {
        $present = @($aces | Where-Object {
            $_.IdentityReference.Value -eq $required.Sid.Value -and $_.AccessControlType -eq $allow -and
            ($_.FileSystemRights -band $required.Rights) -eq $required.Rights
        }).Count -gt 0
        if (-not $present) { throw ('Required ACE absent for ' + $required.Sid.Value) }
    }
} catch {
    $detail = try { (Get-Acl -LiteralPath $file -ErrorAction Stop).AccessToString } catch { 'ACL unreadable' }
    throw ('RDP key ACL verification failed for ' + $file + ': ' + $_.Exception.Message + '; ACL: ' + $detail)
}
# Only the path goes to the pipeline. Never output key material or PFX bytes.
$file
