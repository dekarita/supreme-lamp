# Enable-RdpTlsCertificate.ps1
#
# Bind the Tailscale-issued Let's Encrypt certificate for this node's MagicDNS FQDN
# to the RDP-Tcp listener. Result: `mstsc /v:<fqdn>` on the client sees a publicly
# trusted chain and completes CredSSP at auth-level 2 with zero warnings, zero
# suppression flags. NLA stays ON. No client-side trust-store manipulation needed.
#
# Runs on the RDP HOST (VPS / persistent runner), NOT on the client. Requires:
#   - Tailscale installed, node up, HTTPS enabled in the tailnet (admin console).
#   - PowerShell 7+ (uses X509Certificate2::CreateFromPemFile).
#   - Administrator.
#
# Idempotent: safe to re-run when the cert renews (~every 90 days for LE).

#Requires -Version 7.0
#Requires -RunAsAdministrator

param(
    [string]$Fqdn
)
$ErrorActionPreference = 'Stop'

# --- 1. Resolve MagicDNS FQDN (or accept override, still validated) --------------
if (-not $Fqdn) {
    $tsJson = & tailscale status --json 2>$null
    if (-not $tsJson) { throw 'tailscale not installed or not running; install + authenticate first.' }
    $ts = $tsJson | ConvertFrom-Json
    $Fqdn = ([string]$ts.Self.DNSName).TrimEnd('.')
}
if ($Fqdn -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
    throw "not a MagicDNS FQDN (must end in .ts.net): '$Fqdn'"
}
Write-Host "FQDN: $Fqdn"

# --- 2. Verify NLA is ON before touching anything --------------------------------
$rdpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$nla = (Get-ItemProperty -Path $rdpKey -Name 'UserAuthentication' -ErrorAction Stop).UserAuthentication
if ($nla -ne 1) { throw "UserAuthentication is $nla; NLA must be 1 (see STATE.md). Refusing to proceed." }

# --- 3. Fetch cert via `tailscale cert` (writes PEM cert + key) ------------------
$workDir = Join-Path $env:ProgramData 'ghrdp\tls'
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
# Restrict PEM key material BEFORE tailscale writes it, including on renewal.
$dirAcl = Get-Acl -LiteralPath $workDir
$dirAcl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
Set-Acl -LiteralPath $workDir -AclObject $dirAcl -ErrorAction Stop
$crtPath = Join-Path $workDir "$Fqdn.crt"
$keyPath = Join-Path $workDir "$Fqdn.key"
& tailscale cert --cert-file $crtPath --key-file $keyPath $Fqdn
if ($LASTEXITCODE -ne 0) { throw "tailscale cert failed for $Fqdn (exit $LASTEXITCODE). Enable HTTPS in tailnet admin console." }
foreach ($pem in @($crtPath, $keyPath)) {
    $acl = Get-Acl -LiteralPath $pem -ErrorAction Stop
    $acl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;SY)(A;;FA;;;BA)')
    Set-Acl -LiteralPath $pem -AclObject $acl -ErrorAction Stop
}

# --- 4. Load PEM into X509 with private key, import to LocalMachine\My ----------
$loaded = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($crtPath, $keyPath)
$dns = $loaded.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
if ($dns -ne $Fqdn -or -not $loaded.HasPrivateKey -or $loaded.NotAfter.ToUniversalTime() -le [datetime]::UtcNow -or
    $loaded.Issuer -notmatch "Let'?s Encrypt") {
    throw 'Certificate is expired, not a Tailscale LE cert, lacks its private key, or does not match the MagicDNS FQDN.'
}
$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
try { if (-not $chain.Build($loaded)) { throw 'Tailscale LE certificate chain is not trusted on this host.' } }
finally { $chain.Dispose() }
# Re-export/import to persist the key with MachineKeySet + PersistKeySet.
$pfxBytes = $loaded.Export('Pfx', [string]::Empty)
$flags = 'PersistKeySet,MachineKeySet'
$imported = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, [string]::Empty, $flags)

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
try { $store.Open('ReadWrite'); $store.Add($imported) }
finally { $store.Close() }
$thumb = $imported.Thumbprint
Write-Host "Imported thumbprint: $thumb"

# --- 5. Grant NETWORK SERVICE read on the actual persisted key container -----
$privateKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($imported)
if (-not $privateKey) {
    $privateKey = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($imported)
}
if ($privateKey -is [System.Security.Cryptography.RSACng] -or
    $privateKey -is [System.Security.Cryptography.ECDsaCng]) {
    $keyFile = Join-Path (Join-Path $env:ProgramData 'Microsoft\Crypto\Keys') $privateKey.Key.UniqueName
} elseif ($privateKey -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
    $keyFile = Join-Path (Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys') $privateKey.CspKeyContainerInfo.UniqueKeyContainerName
} else { throw 'Imported certificate private key has no supported machine key container.' }
if (-not (Test-Path -LiteralPath $keyFile)) { throw 'Persisted machine key not found; refusing to bind an unreadable RDP certificate.' }
$keyAcl = Get-Acl -LiteralPath $keyFile -ErrorAction Stop
$keyAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20'),
    [System.Security.AccessControl.FileSystemRights]::Read,
    [System.Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $keyFile -AclObject $keyAcl -ErrorAction Stop
Write-Host 'NETWORK SERVICE can read the listener private key'

# --- 6. Bind on RDP-Tcp listener ------------------------------------------------
$tsSetting = Get-CimInstance -Namespace 'root/cimv2/TerminalServices' `
    -ClassName 'Win32_TSGeneralSetting' -Filter "TerminalName='RDP-Tcp'"
$bindResult = Invoke-CimMethod -InputObject $tsSetting -MethodName 'SetSSLCertificateSHA1Hash' `
    -Arguments @{ SSLCertificateSHA1Hash = $thumb }
if ($bindResult.ReturnValue -ne 0) {
    Write-Warning "SetSSLCertificateSHA1Hash returned $($bindResult.ReturnValue); writing registry directly."
    $hashBytes = -split ($thumb -replace '(..)', '$1 ') | ForEach-Object { [byte]("0x$_") }
    New-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash' -PropertyType Binary `
        -Value $hashBytes -Force | Out-Null
}

# --- 7. Verify bind + reassert NLA still 1 -------------------------------------
$bound = (Get-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash').SSLCertificateSHA1Hash
$boundHex = ($bound | ForEach-Object { $_.ToString('X2') }) -join ''
if ($boundHex -ne $thumb) { throw "bind verification failed: registry=$boundHex, expected=$thumb" }
$nlaAfter = (Get-ItemProperty -Path $rdpKey -Name 'UserAuthentication').UserAuthentication
if ($nlaAfter -ne 1) { throw "NLA flipped to $nlaAfter during operation; aborting." }

Write-Host "OK: NLA=1, cert $thumb bound on RDP-Tcp for $Fqdn."
Write-Host "Restart TermService for the new cert to take effect:"
Write-Host "  Restart-Service TermService -Force"
Write-Host "(Kicks any active session; schedule during a maintenance window.)"
