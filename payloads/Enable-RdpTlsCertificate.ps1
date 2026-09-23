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
$crtPath = Join-Path $workDir "$Fqdn.crt"
$keyPath = Join-Path $workDir "$Fqdn.key"
& tailscale cert --cert-file $crtPath --key-file $keyPath $Fqdn
if ($LASTEXITCODE -ne 0) { throw "tailscale cert failed for $Fqdn (exit $LASTEXITCODE). Enable HTTPS in tailnet admin console." }

# --- 4. Load PEM into X509 with private key, import to LocalMachine\My ----------
$loaded = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($crtPath, $keyPath)
# Re-export/import to persist the key with MachineKeySet + PersistKeySet.
$pfxBytes = $loaded.Export('Pfx', [string]::Empty)
$flags = 'PersistKeySet,MachineKeySet,Exportable'
$imported = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, [string]::Empty, $flags)

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
$store.Open('ReadWrite')
foreach ($old in @($store.Certificates | Where-Object { $_.Subject -match [regex]::Escape($Fqdn) })) {
    $store.Remove($old)
}
$store.Add($imported)
$store.Close()
$thumb = $imported.Thumbprint
Write-Host "Imported thumbprint: $thumb"

# --- 5. Grant NETWORK SERVICE read on the private key file ----------------------
try {
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($imported)
    $keyName = $rsa.Key.UniqueName
    $machineKeys = Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys'
    $keyFile = Join-Path $machineKeys $keyName
    if (Test-Path -LiteralPath $keyFile) {
        $acl = Get-Acl -Path $keyFile
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            'NT AUTHORITY\NETWORK SERVICE', 'Read', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -Path $keyFile -AclObject $acl
        Write-Host "Granted NETWORK SERVICE read on private key ($keyName)"
    }
} catch { Write-Warning "Private-key ACL step skipped: $($_.Exception.Message)" }

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
