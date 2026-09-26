# Enable-RdpTlsCertificate.ps1
#
# Bind the Tailscale-issued Let's Encrypt certificate for this node's MagicDNS FQDN
# to the RDP-Tcp listener. Result: `mstsc /v:<fqdn>` on the client sees a publicly
# trusted chain and completes CredSSP at auth-level 2 with zero warnings, zero
# suppression flags. NLA stays ON. No client-side trust-store manipulation needed.
#
# Runs on the RDP HOST (VPS / persistent runner), NOT on the client. Requires:
#   - Tailscale installed, node up, HTTPS enabled in the tailnet (admin console).
#   - PowerShell 7+ (uses X509Certificate2::CreateFromPem).
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
$crtText = [System.IO.File]::ReadAllText($crtPath)
$keyText = [System.IO.File]::ReadAllText($keyPath)
$loaded = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($crtText, $keyText)

$dns = $loaded.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
if ($dns -ne $Fqdn -or -not $loaded.HasPrivateKey -or $loaded.NotAfter.ToUniversalTime() -le [datetime]::UtcNow -or
    $loaded.Issuer -notmatch "Let'?s Encrypt") {
    throw 'Certificate is expired, not a Tailscale LE cert, lacks its private key, or does not match the MagicDNS FQDN.'
}
$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
try { if (-not $chain.Build($loaded)) { throw 'Tailscale LE certificate chain is not trusted on this host.' } }
finally { $chain.Dispose() }

# Re-export to pfx in-memory and re-import with flags: MachineKeySet | PersistKeySet | Exportable
$pfxBytes = $loaded.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, [string]::Empty)
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::MachineKeySet -bor `
         [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor `
         [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable

$imported = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, [string]::Empty, $flags)

# Assert HasPrivateKey
if (-not $imported.HasPrivateKey) {
    throw 'cert-imported-without-persisted-key'
}

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
try {
    $store.Open('ReadWrite')
    foreach ($old in @($store.Certificates | Where-Object { $_.Subject -match [regex]::Escape($Fqdn) })) {
        try { $store.Remove($old) } catch { }
    }
    $store.Add($imported)
} finally { $store.Close() }
$thumb = $imported.Thumbprint
Write-Host "Imported thumbprint: $thumb"

# --- 5. Grant NETWORK SERVICE Read + SYSTEM FullControl on the key container file -----
$keyFile = $null
try {
    $privKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($imported)
    if (-not $privKey) { $privKey = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($imported) }
    $cngUniqueName = $null
    $cspUniqueName = $null
    try { if ($privKey -is [System.Security.Cryptography.RSACng] -or $privKey -is [System.Security.Cryptography.ECDsaCng]) { $cngUniqueName = $privKey.Key.UniqueName } } catch { }
    try { if ($privKey -is [System.Security.Cryptography.RSACryptoServiceProvider]) { $cspUniqueName = $privKey.CspKeyContainerInfo.UniqueKeyContainerName } } catch { }
    if (-not $cngUniqueName -and -not $cspUniqueName) {
        try { if ($privKey.Key -and $privKey.Key.UniqueName) { $cngUniqueName = $privKey.Key.UniqueName } } catch { }
        try { if ($privKey.CspKeyContainerInfo -and $privKey.CspKeyContainerInfo.UniqueKeyContainerName) { $cspUniqueName = $privKey.CspKeyContainerInfo.UniqueKeyContainerName } } catch { }
    }
    $cngDir = Join-Path $env:ProgramData 'Microsoft\Crypto\Keys'
    $legacyDir = Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys'
    if ($cngUniqueName -and (Test-Path -LiteralPath (Join-Path $cngDir $cngUniqueName))) { $keyFile = Join-Path $cngDir $cngUniqueName }
    elseif ($cspUniqueName -and (Test-Path -LiteralPath (Join-Path $legacyDir $cspUniqueName))) { $keyFile = Join-Path $legacyDir $cspUniqueName }
    elseif ($cngUniqueName -and (Test-Path -LiteralPath (Join-Path $legacyDir $cngUniqueName))) { $keyFile = Join-Path $legacyDir $cngUniqueName }
    elseif ($cspUniqueName -and (Test-Path -LiteralPath (Join-Path $cngDir $cspUniqueName))) { $keyFile = Join-Path $cngDir $cspUniqueName }
} catch { }

if (-not $keyFile -or -not (Test-Path -LiteralPath $keyFile)) {
    throw 'Persisted machine key not found: checked Crypto\Keys and RSA\MachineKeys'
}

$keyAcl = Get-Acl -LiteralPath $keyFile -ErrorAction Stop
$keyAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20'),
    [System.Security.AccessControl.FileSystemRights]::Read,
    [System.Security.AccessControl.AccessControlType]::Allow))
$keyAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $keyFile -AclObject $keyAcl -ErrorAction Stop

# Assert ACE present after write
$aclAfter = Get-Acl -LiteralPath $keyFile
$hasNs = $false; $hasSys = $false
foreach ($access in $aclAfter.Access) {
    if ($access.IdentityReference.Value -match 'NETWORK SERVICE' -and ($access.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Read)) { $hasNs = $true }
    if ($access.IdentityReference.Value -match 'SYSTEM' -and ($access.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl)) { $hasSys = $true }
}
if (-not $hasNs -or -not $hasSys) {
    throw 'key-container-acl-verification-failed'
}
Write-Host 'NETWORK SERVICE Read and SYSTEM FullControl verified on listener private key'

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

# --- 7. Verify bind + restart TermService + LOCAL TLS SELF-PROBE ------------------
$bound = (Get-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash').SSLCertificateSHA1Hash
$boundHex = ($bound | ForEach-Object { $_.ToString('X2') }) -join ''
if ($boundHex -ne $thumb) { throw "bind verification failed: registry=$boundHex, expected=$thumb" }
$nlaAfter = (Get-ItemProperty -Path $rdpKey -Name 'UserAuthentication').UserAuthentication
if ($nlaAfter -ne 1) { throw "NLA flipped to $nlaAfter during operation; aborting." }

Write-Host "Restarting TermService to activate new bound cert..."
Restart-Service TermService -Force

# Assert listener LISTEN
$listenOk = $false
for ($i = 0; $i -lt 10; $i++) {
    try {
        $tc = [System.Net.Sockets.TcpClient]::new()
        $tc.Connect('127.0.0.1', 3389)
        if ($tc.Connected) { $tc.Close(); $listenOk = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $listenOk) { throw 'TermService listener not active on 127.0.0.1:3389 after restart' }

# Local TLS self-probe
try {
    $probeClient = [System.Net.Sockets.TcpClient]::new()
    $probeClient.Connect('127.0.0.1', 3389)
    $probeStream = $probeClient.GetStream()
    [byte[]]$x224Cr = @(0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00)
    $probeStream.Write($x224Cr, 0, $x224Cr.Length)
    $probeStream.Flush()
    $x224Cc = New-Object byte[] 11
    [void]$probeStream.Read($x224Cc, 0, $x224Cc.Length)

    $sslStream = [System.Net.Security.SslStream]::new(
        $probeStream,
        $false,
        [System.Net.Security.RemoteCertificateValidationCallback]{ $true }
    )
    $sslStream.AuthenticateAsClient('localhost')
    Write-Host 'listener-handshake-ok'
    $sslStream.Dispose()
    $probeClient.Dispose()
} catch {
    $probeErr = $_.Exception.Message
    Write-Host "self-probe failed: $probeErr"
    try {
        $events = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Schannel'; Id = 36870 } -MaxEvents 3 -ErrorAction SilentlyContinue
        foreach ($ev in $events) { Write-Host ("Schannel 36870: " + $ev.TimeCreated.ToString('o') + ' ' + $ev.Message) }
    } catch { }
    if ($keyFile -and (Test-Path -LiteralPath $keyFile)) {
        try {
            $aclDump = (Get-Acl -LiteralPath $keyFile).Access | ForEach-Object { $_.IdentityReference.Value + ':' + $_.FileSystemRights }
            Write-Host ("keyFile ACL: " + ($aclDump -join ', '))
        } catch { }
    }
    throw "rdp-tls-credential-unusable: $probeErr"
}

Write-Host "OK: NLA=1, cert $thumb bound on RDP-Tcp for $Fqdn, self-probe listener-handshake-ok."
