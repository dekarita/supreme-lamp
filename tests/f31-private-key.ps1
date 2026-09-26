# Real Windows/TermService matrix, no client credentials or trust installation.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../payloads/rdp-key-probe.ps1"
$rdp = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$root = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
$original = Get-ItemProperty $rdp
$deny = (Get-ItemProperty $root).fDenyTSConnections
$temp = Join-Path $env:RUNNER_TEMP 'f31-key-lab'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$helper = (Resolve-Path "$PSScriptRoot/../payloads/rdp-key-probe.ps1").Path
# Import and probe run in separate pwsh processes, not in the parent/store session.
@'
param($Pfx, $Mode, $Output, $Helper)
$ErrorActionPreference = 'Stop'
. $Helper
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet
if ($Mode -eq 'persist') {
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::MachineKeySet -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
}
$c = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes($Pfx), '', $flags)
if (-not $c.HasPrivateKey) { throw 'lab-import-has-no-key' }
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'LocalMachine')
$store.Open('ReadWrite'); $store.Add($c); $store.Close()
$keyFile = ''
if ($Mode -eq 'persist') { $keyFile = Get-RdpKeyFile $c; Set-RdpKeyAcl $keyFile }
@{thumb=$c.Thumbprint; keyFile=$keyFile} | ConvertTo-Json | Set-Content $Output
$c.Dispose()
'@ | Set-Content "$temp/import.ps1"
@'
param($Helper, $Thumb, $KeyFile)
$ErrorActionPreference = 'Stop'
. $Helper
Test-RdpListenerTls -Thumbprint $Thumb -KeyFile $KeyFile
'@ | Set-Content "$temp/probe.ps1"
function Invoke-LabProbe($Info, [bool]$ExpectSuccess, [datetime]$Since) {
    & pwsh -NoProfile -File "$temp/probe.ps1" $helper $Info.thumb $Info.keyFile
    $ok = $LASTEXITCODE -eq 0
    if ($ok -ne $ExpectSuccess) { throw 'F31 matrix unexpected probe outcome (default flags do not guarantee reproduction on every provider)' }
    if (-not $ExpectSuccess) {
        $events = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Schannel'; Id=36870; StartTime=$Since} -ErrorAction SilentlyContinue)
        Write-RdpKeyDiagnostic -KeyFile $Info.keyFile -Since $Since
        if (-not $events.Count) { throw 'F31 negative cell lacks observed Schannel 36870; NOT proven' }
    }
}
$thumbs = @(); $keys = @()
try {
    Set-ItemProperty $root fDenyTSConnections 0
    Set-ItemProperty $rdp UserAuthentication 1
    Set-ItemProperty $rdp SecurityLayer 2
    foreach ($algorithm in @('RSA', 'ECDSA')) {
        if ($algorithm -eq 'RSA') {
            $key = [System.Security.Cryptography.RSA]::Create(2048)
            $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        } else {
            $key = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve]::NamedCurves.nistP256)
            $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
        }
        $cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddHours(1))
        # Exercise the same PEM -> PFX conversion as production.
        $pem = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($cert.ExportCertificatePem(), $key.ExportPkcs8PrivateKeyPem())
        [IO.File]::WriteAllBytes("$temp/key.pfx", $pem.Export('Pfx', ''))
        $pem.Dispose(); $cert.Dispose(); $key.Dispose()
        foreach ($mode in @('default', 'persist')) {
            & pwsh -NoProfile -File "$temp/import.ps1" "$temp/key.pfx" $mode "$temp/info.json" $helper
            if ($LASTEXITCODE) { throw 'F31 child import failed' }
            $info = Get-Content "$temp/info.json" -Raw | ConvertFrom-Json
            $thumbs += $info.thumb
            if ($info.keyFile) { $keys += $info.keyFile }
            [byte[]]$hash = [Convert]::FromHexString($info.thumb)
            New-ItemProperty $rdp SSLCertificateSHA1Hash -PropertyType Binary -Value $hash -Force | Out-Null
            $since = Get-Date
            Restart-Service TermService -Force
            (Get-Service TermService).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
            Invoke-LabProbe $info ($mode -eq 'persist') $since
            Write-Host "F31 $algorithm $mode PASS"
        }
        $acl = Get-Acl $info.keyFile
        $saved = $acl.Sddl
        try {
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-20'), 'Read', 'Deny'))
            Set-Acl $info.keyFile $acl
            $since = Get-Date
            Restart-Service TermService -Force
            (Get-Service TermService).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
            Invoke-LabProbe $info $false $since
            Write-Host "F31 $algorithm ACL-denied PASS"
        } finally {
            $acl.SetSecurityDescriptorSddlForm($saved); Set-Acl $info.keyFile $acl
        }
    }
} finally {
    foreach ($name in @('SSLCertificateSHA1Hash','UserAuthentication','SecurityLayer')) {
        if ($original.PSObject.Properties[$name]) { Set-ItemProperty $rdp $name $original.$name }
        else { Remove-ItemProperty $rdp $name -ErrorAction SilentlyContinue }
    }
    Set-ItemProperty $root fDenyTSConnections $deny
    Restart-Service TermService -Force -ErrorAction Continue
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'LocalMachine')
    $store.Open('ReadWrite')
    foreach ($c in $store.Certificates) { if ($c.Thumbprint -in $thumbs) { $store.Remove($c) }; $c.Dispose() }
    $store.Close()
    foreach ($path in $keys) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    Remove-Item $temp -Recurse -Force
}
