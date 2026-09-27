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
function Write-F31Evidence([string]$Line) {
    Write-Host $Line
    # Also reachable via Checks REST when the Actions blob log download fails.
    $annotation = $Line.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::notice::$annotation"
    if ($env:GITHUB_STEP_SUMMARY) { $Line | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY }
}
function Write-RdpKeyDiagnostic([string]$KeyFile, [datetime]$Since, [string]$Thumbprint = '') {
    # Public metadata only: no cert export, key bytes, identities or event messages.
    $store = $null; $cert = $null; $key = $null; $name = ''
    try {
        $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'LocalMachine')
        $store.Open('ReadOnly')
        $cert = $store.Certificates | Where-Object Thumbprint -EQ $Thumbprint | Select-Object -First 1
        Write-F31Evidence ('HasPrivateKey=' + $(if ($cert) { $cert.HasPrivateKey } else { 'certificate-not-found' }))
        if ($cert) {
            $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
            if (-not $key) { $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($cert) }
            if ($key -is [System.Security.Cryptography.RSACryptoServiceProvider]) { $name = $key.CspKeyContainerInfo.UniqueKeyContainerName }
            elseif ($key) { $name = $key.Key.UniqueName }
        }
    } catch { Write-F31Evidence ('key-open-error=' + $_.Exception.GetType().Name + ' HRESULT=' + $_.Exception.HResult) }
    finally {
        if ($key) { $key.Dispose() }; if ($cert) { $cert.Dispose() }; if ($store) { $store.Close() }
    }
    if (-not $name -and $KeyFile) { $name = Split-Path $KeyFile -Leaf }
    foreach ($dir in @('Microsoft\Crypto\Keys', 'Microsoft\Crypto\RSA\MachineKeys')) {
        $path = Join-Path $env:ProgramData $dir
        if ($name) { $path = Join-Path $path $name }
        Write-F31Evidence ('key-path=' + $path + ' containerKnown=' + [bool]$name + ' exists=' + (Test-Path -LiteralPath $path))
        if ($name -and (Test-Path -LiteralPath $path)) {
            try {
                $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
                Write-F31Evidence ('ACL=' + $acl.Sddl)
                foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                    Write-F31Evidence ('ACL SID=' + $rule.IdentityReference.Value + ' type=' + $rule.AccessControlType + ' rights=' + $rule.FileSystemRights)
                }
            } catch { Write-F31Evidence 'ACL=unreadable' }
        } else { Write-F31Evidence 'ACL=unavailable' }
    }
    try {
        $events = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Schannel'; StartTime=$Since} -MaxEvents 3 -ErrorAction Stop)
        foreach ($event in $events) { Write-F31Evidence ('Schannel ID=' + $event.Id + ' time=' + $event.TimeCreated.ToUniversalTime().ToString('o')) }
    } catch {
        Write-F31Evidence ('Schannel IDs=' + $(if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'none-observed (not proof of usable credentials)' } else { 'log-unreadable' }))
    }
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
        $failure = $_.Exception.Message
        if ($failure -in @('rdp-connect-timeout','rdp-negotiation-forcibly-closed','rdp-negotiation-invalid-tpkt','rdp-negotiation-rejected','rdp-probe-thumbprint-mismatch')) {
            Write-F31Evidence ('probe reason=' + $failure)
        }
        $exception = $_.Exception
        while ($exception) {
            # Exception type/HRESULT survives wrappers without exposing arbitrary messages.
            Write-F31Evidence ('probe inner exception=' + $exception.GetType().FullName + ' HRESULT=' + $exception.HResult)
            if ($exception -is [System.Net.Sockets.SocketException]) { Write-F31Evidence ('probe socket=' + $exception.SocketErrorCode) }
            $exception = $exception.InnerException
        }
        Write-RdpKeyDiagnostic -KeyFile $KeyFile -Since $since -Thumbprint $Thumbprint
        throw 'rdp-tls-credential-unusable'
    } finally {
        if ($ssl) { $ssl.Dispose() }
        $tcp.Dispose()
    }
}
