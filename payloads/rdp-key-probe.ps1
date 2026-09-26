# F31: shared by production and the Windows lab. Never exports private key material.
function Get-RdpKeyFile($Certificate) {
    $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
    if (-not $key) { $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($Certificate) }
    if (-not $key) { throw 'cert-imported-without-persisted-key' }
    try {
        if ($key -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
            $dir = 'Microsoft\Crypto\RSA\MachineKeys'
            $name = $key.CspKeyContainerInfo.UniqueKeyContainerName
        } else {
            $dir = 'Microsoft\Crypto\Keys'
            $name = $key.Key.UniqueName
        }
        if (-not $name) { throw 'key-container-name-missing' }
        $path = Join-Path (Join-Path $env:ProgramData $dir) $name
        if (-not (Test-Path -LiteralPath $path)) { throw 'persisted-machine-key-file-missing' }
        return $path
    } finally { $key.Dispose() }
}
function Set-RdpKeyAcl([string]$KeyFile) {
    $acl = Get-Acl -LiteralPath $KeyFile -ErrorAction Stop
    foreach ($entry in @(@('S-1-5-20', 'Read'), @('S-1-5-18', 'FullControl'))) {
        $sid = [System.Security.Principal.SecurityIdentifier]::new($entry[0])
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $entry[1], 'Allow'))
    }
    Set-Acl -LiteralPath $KeyFile -AclObject $acl -ErrorAction Stop
    $rules = (Get-Acl -LiteralPath $KeyFile -ErrorAction Stop).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($entry in @(@('S-1-5-20', 'Read'), @('S-1-5-18', 'FullControl'))) {
        $rights = [System.Security.AccessControl.FileSystemRights]$entry[1]
        if (-not @($rules | Where-Object { $_.IdentityReference.Value -eq $entry[0] -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $rights) -eq $rights }).Count) { throw 'key-acl-assert-failed' }
        if (@($rules | Where-Object { $_.IdentityReference.Value -in @($entry[0], 'S-1-1-0', 'S-1-5-11') -and $_.AccessControlType -eq 'Deny' -and ($_.FileSystemRights -band $rights) }).Count) { throw 'key-acl-denied' }
    }
    Write-Host '[cert] acl-ok'
}
function Write-RdpKeyDiagnostic([string]$KeyFile, [datetime]$Since) {
    # Do not print raw Schannel messages (may contain identities).
    $events = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Schannel'; Id=36870,36871,12017,12018; StartTime=$Since} -MaxEvents 5 -ErrorAction SilentlyContinue)
    foreach ($event in $events) { Write-Host ('[cert] Schannel ID=' + $event.Id + ' time=' + $event.TimeCreated.ToUniversalTime().ToString('o')) }
    if (-not $events.Count) { Write-Host '[cert] Schannel ID=none-observed (not proof of usable credentials)' }
    if ($KeyFile -and (Test-Path -LiteralPath $KeyFile)) {
        $acl = Get-Acl -LiteralPath $KeyFile -ErrorAction Stop
        Write-Host ('[cert] key-file=' + $KeyFile + ' ACL=' + $acl.Sddl)
    } else { Write-Host '[cert] key-file ACL=unavailable' }
}
function Test-RdpListenerTls([string]$Thumbprint, [string]$KeyFile) {
    $since = Get-Date
    $tcp = [System.Net.Sockets.TcpClient]::new()
    $ssl = $null
    try {
        if (-not $tcp.ConnectAsync('127.0.0.1', 3389).Wait(10000)) { throw 'rdp-connect-timeout' }
        $stream = $tcp.GetStream()
        $stream.ReadTimeout = 10000; $stream.WriteTimeout = 10000
        # TPKT + X.224 CR + RDP_NEG_REQ: SSL | HYBRID | HYBRID_EX. No NLA downgrade.
        [byte[]]$request = 3,0,0,19,14,224,0,0,0,0,0,1,0,8,0,11,0,0,0
        $stream.Write($request, 0, $request.Length)
        function Read-RdpExact($Stream, [int]$Count) {
            $bytes = [byte[]]::new($Count); $offset = 0
            while ($offset -lt $Count) {
                $n = $Stream.Read($bytes, $offset, $Count - $offset)
                if ($n -eq 0) { throw 'rdp-negotiation-forcibly-closed' }
                $offset += $n
            }
            return ,$bytes
        }
        $header = Read-RdpExact $stream 4
        $length = [int]$header[2] * 256 + $header[3]
        if ($header[0] -ne 3 -or $length -ne 19) { throw 'rdp-negotiation-invalid-tpkt' }
        $reply = Read-RdpExact $stream ($length - 4)
        if ($reply[1] -ne 208 -or $reply[7] -ne 2 -or [BitConverter]::ToUInt32($reply, 11) -notin @(1,2,8)) { throw 'rdp-negotiation-rejected' }
        $ssl = [System.Net.Security.SslStream]::new($stream, $false, [System.Net.Security.RemoteCertificateValidationCallback]{ param($sender,$cert,$chain,$errors) return $true })
        $ssl.ReadTimeout = 10000; $ssl.WriteTimeout = 10000
        $ssl.AuthenticateAsClient('localhost')
        if ($ssl.RemoteCertificate.GetCertHashString() -ine $Thumbprint) { throw 'rdp-probe-thumbprint-mismatch' }
        Write-Host 'listener-handshake-ok'
    } catch {
        Write-RdpKeyDiagnostic -KeyFile $KeyFile -Since $since
        throw 'rdp-tls-credential-unusable'
    } finally {
        if ($ssl) { $ssl.Dispose() }
        $tcp.Dispose()
    }
}
