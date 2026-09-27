# F31: resolve the persisted machine private-key file and fail closed on ACL readback.
# PowerShell 7+ on the RDP host; never invoke in the constrained terminal account.
param(
    [Parameter(Mandatory)] [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
if (-not $Certificate.HasPrivateKey) { throw 'RDP certificate has no private key' }
$key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
if (-not $key) { $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($Certificate) }
if (-not $key) { throw 'RDP certificate key is neither RSA nor ECDSA' }
try {
    if ($key -is [System.Security.Cryptography.RSACng] -or $key -is [System.Security.Cryptography.ECDsaCng]) {
        $name = $key.Key.UniqueName
        $root = Join-Path $env:ProgramData 'Microsoft\Crypto\Keys'
    } elseif ($key -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
        $name = $key.CspKeyContainerInfo.UniqueKeyContainerName
        if (-not $key.CspKeyContainerInfo.MachineKeyStore) { throw 'CSP key is not a machine key' }
        $root = Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys'
    } else { throw ('Unsupported persisted key provider: ' + $key.GetType().FullName) }
} finally { $key.Dispose() }
if (-not $name -or $name -match '[\\/]') { throw 'Invalid persisted key container name' }
$file = Join-Path $root $name
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Persisted machine key file missing: ' + $file) }
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
