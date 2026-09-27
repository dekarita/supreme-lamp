# F37: RDP TELESCOPE - single source of truth for handshake observability.
# Structured, secret-free diagnosis of the real client<->runner RDP path:
#   dns(fqdn)->ip | tcp(ip,3389)+rtt | x224+tls (servedThumb, chainStatus,
#   protocol, cipher OR failurePoint) | cred (target exists+type+user, NEVER a
#   secret) | logon (last 4624/4625 + sub) | schannel (36870/36871/36888/12018
#   tail) | listener (boundThumb, inStore, hasKey, container, aclSids).
# SECRET-FREE CONTRACT: this module NEVER reads password bytes. It runs
# cmdkey /list (which never prints secrets) and reads handshake METADATA only.
# No Get-Credential, no CredRead value, no SecureString unwrap, no cred-UI
# automation, no NLA/CredSSP weakening, no trust installs. Any secret-shaped
# token in this file is a gate failure.
# Shared format tokens (the F37 launch-gate greps these in lab+server+launcher
# +dashboard to prove ONE format): traceId servedThumb chainStatus
# failurePoint rst-before-cert aclSids deathPoint boundThumb.
param(
    [Parameter(Mandatory)][string]$Fqdn,
    [string]$ExpectedThumb = '',
    [string]$KeyFile = '',
    [string]$Target = '',
    [string]$TraceId = '',
    [ValidateSet('client','server')][string]$Scope = 'server',
    [switch]$Summary
)
# NOTE: no $ErrorActionPreference assignment at import time: dot-sourcing this
# module must NEVER flip the caller's preference (lab cell + keep-alive loop).
# Fail-closed behavior comes from explicit -ErrorAction Stop on every probe.
$script:TlsServed = ''
$script:TlsChainStatus = @()
$script:TlsPolicyErrors = ''

function Get-RdpTelescopeDns {
    param([string]$Name)
    $t0 = Get-Date
    try {
        $addrs = @([System.Net.Dns]::GetHostAddresses($Name) | Where-Object { $_.AddressFamily -eq 'InterNetwork' })
        $ms = [int]((Get-Date) - $t0).TotalMilliseconds
        if ($addrs.Count -lt 1) { return [pscustomobject]@{ ok = $false; ip = ''; ms = $ms; why = 'dns-no-ipv4-answer' } }
        return [pscustomobject]@{ ok = $true; ip = [string]$addrs[0].IPAddressToString; ms = $ms; why = '' }
    } catch {
        $ms = [int]((Get-Date) - $t0).TotalMilliseconds
        return [pscustomobject]@{ ok = $false; ip = ''; ms = $ms; why = ('dns-failed:' + $_.Exception.GetType().Name) }
    }
}

function Read-TelescopeExact {
    param([System.IO.Stream]$Stream, [int]$Length)
    $buf = [byte[]]::new($Length); $pos = 0
    while ($pos -lt $Length) {
        $n = $Stream.Read($buf, $pos, $Length - $pos)
        if ($n -le 0) { throw 'X.224 connection reset/EOF' }
        $pos += $n
    }
    return ,$buf
}

function Get-RdpTelescopeTls {
    param([string]$TargetHost, [int]$Port, [string]$Sni, [int]$TimeoutMs = 7000)
    $tcp = $null; $ssl = $null
    $tcpRes = [pscustomobject]@{ ok = $false; rttMs = -1; why = 'tcp-not-attempted' }
    $tlsRes = [pscustomobject]@{ ok = $false; servedThumb = ''; protocol = ''; cipher = ''; chainStatus = @(); policyErrors = ''; failurePoint = 'tcp-failed'; why = 'tcp-not-attempted' }
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $t0 = Get-Date
        $conn = $tcp.ConnectAsync($TargetHost, $Port)
        if (-not $conn.Wait(5000)) { $tcpRes.why = 'tcp-connect-timeout'; $tlsRes.why = 'tcp-connect-timeout'; return @($tcpRes, $tlsRes) }
        $tcpRes.ok = $true; $tcpRes.rttMs = [int]((Get-Date) - $t0).TotalMilliseconds; $tcpRes.why = ''
        $tcp.ReceiveTimeout = $TimeoutMs; $tcp.SendTimeout = $TimeoutMs
        $stream = $tcp.GetStream()
        # TPKT + X.224 Connection Request + RDP_NEG_REQ: TLS | HYBRID (NLA).
        [byte[]]$request = 0x03,0x00,0x00,0x13,0x0e,0xe0,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x08,0x00,0x03,0x00,0x00,0x00
        try { $stream.Write($request, 0, $request.Length) }
        catch { $tlsRes.failurePoint = 'rst-before-cert'; $tlsRes.why = 'x224-write-reset'; return @($tcpRes, $tlsRes) }
        try {
            [byte[]]$header = Read-TelescopeExact $stream 4
            if ($header[0] -ne 3 -or $header[1] -ne 0) { throw 'invalid TPKT header' }
            $length = ([int]$header[2] -shl 8) -bor [int]$header[3]
            if ($length -lt 19 -or $length -gt 1024) { throw ('invalid X.224 length ' + $length) }
            [byte[]]$response = Read-TelescopeExact $stream ($length - 4)
            if ($response[1] -ne 0xd0) { throw 'X.224 is not a connection confirm' }
            if ($response[6] -ne 2 -or $response[8] -ne 8 -or $response[9] -ne 0) { throw 'RDP negotiation did not select TLS' }
            $protocol = [BitConverter]::ToUInt32($response, 10)
            if ($protocol -ne 1 -and $protocol -ne 2 -and $protocol -ne 8) { throw ('RDP selected non-TLS protocol ' + $protocol) }
        } catch {
            $msg = $_.Exception.Message
            if ($msg -match 'reset/EOF') { $tlsRes.failurePoint = 'rst-before-cert' } else { $tlsRes.failurePoint = 'x224-rejected' }
            $tlsRes.why = $msg
            return @($tcpRes, $tlsRes)
        }
        # Permissive callback: ALWAYS read RemoteCertificate (even on chain
        # failure) so rst-before-cert and chain rejects are distinguishable.
        $script:TlsServed = ''; $script:TlsChainStatus = @(); $script:TlsPolicyErrors = ''
        $callback = [System.Net.Security.RemoteCertificateValidationCallback]{
            param($sender, $cert, $chain, $errors)
            try { $script:TlsPolicyErrors = [string]$errors } catch { }
            try {
                if ($chain -and $chain.ChainStatus) {
                    $script:TlsChainStatus = @($chain.ChainStatus | ForEach-Object { [string]$_.Status })
                }
            } catch { }
            try { if ($cert) { $script:TlsServed = $cert.GetCertHashString().ToUpperInvariant() } } catch { }
            return $true
        }
        $ssl = [System.Net.Security.SslStream]::new($stream, $false, $callback)
        try {
            $task = $ssl.AuthenticateAsClientAsync($Sni)
            if (-not $task.Wait($TimeoutMs)) { throw 'TLS handshake timeout' }
            $task.GetAwaiter().GetResult() | Out-Null
        } catch {
            if (-not $script:TlsServed) {
                # The server RST the connection before serving any certificate
                # (the Schannel-without-ServerAuth-EKU class): no cert to compare.
                $tlsRes.failurePoint = 'rst-before-cert'
            } else {
                $tlsRes.failurePoint = 'tls-alert'
            }
            $tlsRes.servedThumb = $script:TlsServed
            $tlsRes.chainStatus = @($script:TlsChainStatus)
            $tlsRes.policyErrors = $script:TlsPolicyErrors
            $tlsRes.why = $_.Exception.Message
            return @($tcpRes, $tlsRes)
        }
        $tlsRes.servedThumb = $script:TlsServed
        $tlsRes.chainStatus = @($script:TlsChainStatus)
        $tlsRes.policyErrors = $script:TlsPolicyErrors
        try { $tlsRes.protocol = [string]$ssl.SslProtocol } catch { }
        try { $tlsRes.cipher = ([string]$ssl.CipherAlgorithm + '/' + [string]$ssl.CipherStrength) } catch { }
        if (-not $tlsRes.servedThumb) {
            $tlsRes.failurePoint = 'rst-before-cert'; $tlsRes.why = 'handshake completed with no served certificate'
            return @($tcpRes, $tlsRes)
        }
        # Name check against SNI (metadata only: thumb + chain already captured).
        $nameOk = $true
        try {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
            $store.Open('ReadOnly')
            $match = @($store.Certificates | Where-Object { $_.Thumbprint -ieq $tlsRes.servedThumb })
            $store.Close()
            if ($match.Count -gt 0) {
                $c = $match[0]
                $san = ''
                try {
                    $ext = @($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }) | Select-Object -First 1
                    if ($ext) { $san = $ext.Format($false) }
                } catch { }
                $blob = ([string]$c.Subject + ' ' + $san).ToLowerInvariant()
                $nameOk = $blob.Contains($Sni.ToLowerInvariant())
            }
        } catch { $nameOk = $true }
        if (-not $nameOk) {
            $tlsRes.failurePoint = 'name-mismatch'; $tlsRes.why = 'served certificate name does not match ' + $Sni
            return @($tcpRes, $tlsRes)
        }
        if ($tlsRes.chainStatus.Count -gt 0) {
            $tlsRes.failurePoint = 'chain=' + ($tlsRes.chainStatus -join ',')
            $tlsRes.why = 'chain statuses: ' + ($tlsRes.chainStatus -join ',')
            return @($tcpRes, $tlsRes)
        }
        $tlsRes.ok = $true; $tlsRes.failurePoint = 'none'; $tlsRes.why = ''
        return @($tcpRes, $tlsRes)
    } finally {
        if ($ssl) { try { $ssl.Dispose() } catch { } }
        if ($tcp) { try { $tcp.Dispose() } catch { } }
    }
}

function Get-RdpTelescopeCred {
    # cmdkey /list NEVER prints a secret: target exists + type + user only.
    param([string]$Name)
    $target = 'TERMSRV/' + $Name
    $res = [pscustomobject]@{ target = $target; exists = $false; type = ''; user = '' }
    try {
        $out = @(& cmdkey.exe /list:$target 2>&1 | Out-String)
        $txt = [string]$out
        if ($txt -match [regex]::Escape($target)) { $res.exists = $true }
        $m = [regex]::Match($txt, '(?m)^\s*Type:\s*(.+?)\s*$'); if ($m.Success) { $res.type = $m.Groups[1].Value.Trim() }
        $m = [regex]::Match($txt, '(?m)^\s*User:\s*(.+?)\s*$'); if ($m.Success) { $res.user = $m.Groups[1].Value.Trim() }
    } catch { }
    return $res
}

function Get-RdpTelescopeLogon {
    $res = [pscustomobject]@{ last4624 = ''; last4625 = ''; sub = ''; subMeaning = ''; probeError = '' }
    try {
        $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(4624, 4625) } -MaxEvents 60 -ErrorAction Stop)
        foreach ($e in $raw) {
            try {
                $xml = [xml]$e.ToXml()
                $vals = @{}
                foreach ($d in @($xml.SelectNodes("//*[local-name()='Data']"))) {
                    $n = [string]$d.GetAttribute('Name'); if ($n) { $vals[$n] = [string]$d.InnerText }
                }
                $ts = $e.TimeCreated.ToUniversalTime().ToString('o')
                if ([string]$e.Id -eq '4624' -and [string]$vals['LogonType'] -eq '10' -and -not $res.last4624) { $res.last4624 = $ts }
                if ([string]$e.Id -eq '4625' -and -not $res.last4625) {
                    $res.last4625 = $ts; $res.sub = ([string]$vals['SubStatus']).ToUpperInvariant()
                }
            } catch { }
            if ($res.last4624 -and $res.last4625) { break }
        }
    } catch { $res.probeError = 'security-log-unreadable' }
    switch ($res.sub) {
        '0XC000006A' { $res.subMeaning = 'wrong-password' }
        '0XC000006D' { $res.subMeaning = 'bad-user-or-password' }
        '0XC0000064' { $res.subMeaning = 'no-such-user' }
        '0XC000015B' { $res.subMeaning = 'logon-type-denied' }
        default { if ($res.sub) { $res.subMeaning = 'other' } }
    }
    return $res
}

function Get-RdpTelescopeSchannel {
    $res = [pscustomobject]@{ tail = @(); probeError = '' }
    try {
        $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = @(36870, 36871, 36888, 12018) } -MaxEvents 5 -ErrorAction Stop)
        $items = @()
        foreach ($e in $raw) {
            $items += [pscustomobject]@{ id = [int]$e.Id; ts = $e.TimeCreated.ToUniversalTime().ToString('o') }
        }
        $res.tail = @($items)
    } catch { $res.probeError = 'system-log-unreadable' }
    return $res
}

function Get-RdpTelescopeListener {
    param([string]$KnownKeyFile)
    $bound = ''
    try {
        $raw = (Get-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name 'SSLCertificateSHA1Hash' -ErrorAction Stop).SSLCertificateSHA1Hash
        $bound = (@($raw | ForEach-Object { $_.ToString('X2') }) -join '')
    } catch { }
    $inStore = $false; $hasKey = $false; $container = ''; $certutilContainer = ''; $aclSids = @()
    $cert = $null
    try {
        if ($bound) {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
            $store.Open('ReadOnly')
            $found = @($store.Certificates | Where-Object { $_.Thumbprint -ieq $bound })
            $store.Close()
            if ($found.Count -gt 0) {
                $cert = $found[0]; $inStore = $true; $hasKey = [bool]$cert.HasPrivateKey
            }
        }
    } catch { }
    if ($cert -and $cert.HasPrivateKey) {
        try {
            $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
            if (-not $key) { $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($cert) }
            if ($key) {
                try {
                    if ($key -is [System.Security.Cryptography.RSACng] -or $key -is [System.Security.Cryptography.ECDsaCng]) {
                        $container = Join-Path (Join-Path $env:ProgramData 'Microsoft\Crypto\Keys') $key.Key.UniqueName
                    } elseif ($key -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
                        $container = Join-Path (Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys') $key.CspKeyContainerInfo.UniqueKeyContainerName
                    }
                } finally { $key.Dispose() }
            }
        } catch { }
        if (-not $container -and $KnownKeyFile) { $container = $KnownKeyFile }
        if ($container -and (Test-Path -LiteralPath $container -PathType Leaf)) {
            try {
                $aces = @((Get-Acl -LiteralPath $container -ErrorAction Stop).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
                $aclSids = @($aces | Select-Object -First 12 | ForEach-Object { [string]$_.IdentityReference.Value + ':' + [string]$_.FileSystemRights + ':' + [string]$_.AccessControlType })
            } catch { $aclSids = @('ACL unreadable') }
        } elseif ($container) { $aclSids = @('key-file-missing') }
        # certutil cross-check (best effort, metadata only).
        try {
            $cu = @(& certutil.exe -store my $bound 2>&1 | Out-String)
            $m = [regex]::Match([string]$cu, '(?m)Key Container\s*=\s*(.+?)\s*$')
            if ($m.Success) { $certutilContainer = $m.Groups[1].Value.Trim() }
        } catch { }
    }
    return [pscustomobject]@{
        boundThumb = $bound; inStore = $inStore; hasKey = $hasKey
        container = $container; certutilContainer = $certutilContainer; aclSids = @($aclSids)
    }
}

function Get-RdpTelescopeDeathPoint {
    # FIRST red segment wins: dns|tcp|tls-cert|tls-chain|credssp|logon|acl.
    param($Dns, $Tls, $Cred, $Logon, $Listener, [string]$ScopeName)
    if (-not $Dns.ok) { return 'dns' }
    if ($Tls.failurePoint -eq 'tcp-failed' -or $Tls.failurePoint -eq 'tcp-connect-timeout') { return 'tcp' }
    if ($Tls.failurePoint -eq 'rst-before-cert' -or $Tls.failurePoint -eq 'name-mismatch' -or $Tls.failurePoint -eq 'x224-rejected' -or $Tls.failurePoint -eq 'tls-alert' -or $Tls.failurePoint -eq 'tls-timeout') { return 'tls-cert' }
    if ($Tls.failurePoint -like 'chain=*') { return 'tls-chain' }
    if (-not $Tls.ok) { return 'tls-cert' }
    $aclTxt = (@($Listener.aclSids) -join ' ')
    if ($aclTxt -notmatch 'S-1-5-20' -and $ScopeName -eq 'server') { return 'acl' }
    if ($ScopeName -eq 'client' -and -not $Cred.exists) { return 'credssp' }
    try {
        if ($Logon.last4625) {
            $t5 = [datetime]$Logon.last4625
            $t4 = $null; try { if ($Logon.last4624) { $t4 = [datetime]$Logon.last4624 } } catch { }
            $fresh = ((Get-Date).ToUniversalTime() - $t5.ToUniversalTime()).TotalMinutes -le 10
            if ($fresh -and ($null -eq $t4 -or $t5 -gt $t4)) { return 'logon' }
        }
    } catch { }
    return 'none'
}

function Invoke-RdpTelescope {
    param([string]$Name, [string]$TargetHost = '', [string]$Trace = '', [string]$ScopeName = 'server', [string]$KnownKey = '')
    $dns = Get-RdpTelescopeDns -Name $Name
    $tcpHost = if ($TargetHost) { $TargetHost } elseif ($dns.ok) { $dns.ip } else { '' }
    if ($tcpHost) { $pair = Get-RdpTelescopeTls -TargetHost $tcpHost -Port 3389 -Sni $Name } else {
        $pair = @(
            [pscustomobject]@{ ok = $false; rttMs = -1; why = 'tcp-skipped-no-target' },
            [pscustomobject]@{ ok = $false; servedThumb = ''; protocol = ''; cipher = ''; chainStatus = @(); policyErrors = ''; failurePoint = 'tcp-failed'; why = 'tcp-skipped-no-target' }
        )
    }
    $cred = Get-RdpTelescopeCred -Name $Name
    $cred | Add-Member -NotePropertyName scope -NotePropertyValue $ScopeName -Force
    $logon = Get-RdpTelescopeLogon
    $sch = Get-RdpTelescopeSchannel
    $listener = Get-RdpTelescopeListener -KnownKeyFile $KnownKey
    $death = Get-RdpTelescopeDeathPoint -Dns $dns -Tls $pair[1] -Cred $cred -Logon $logon -Listener $listener -ScopeName $ScopeName
    return [pscustomobject]@{
        v = 1; traceId = $Trace; ts = (Get-Date).ToUniversalTime().ToString('o'); fqdn = $Name
        dns = $dns; tcp = $pair[0]; tls = $pair[1]; cred = $cred
        logon = $logon; schannel = $sch; listener = $listener; deathPoint = $death
    }
}

function Format-RdpTelescopeSummary {
    # Prints EVERY field: on any fail this text IS the diagnosis.
    param($T)
    $lines = @()
    $lines += ('telescope v=' + $T.v + ' trace=' + $T.traceId + ' ts=' + $T.ts + ' fqdn=' + $T.fqdn)
    $lines += ('dns ok=' + $T.dns.ok + ' ip=' + $T.dns.ip + ' ms=' + $T.dns.ms + ' why=' + $T.dns.why)
    $lines += ('tcp ok=' + $T.tcp.ok + ' rttMs=' + $T.tcp.rttMs + ' why=' + $T.tcp.why)
    $lines += ('tls ok=' + $T.tls.ok + ' servedThumb=' + $T.tls.servedThumb + ' protocol=' + $T.tls.protocol + ' cipher=' + $T.tls.cipher + ' policyErrors=' + $T.tls.policyErrors + ' failurePoint=' + $T.tls.failurePoint + ' why=' + $T.tls.why)
    $lines += ('tls chainStatus=[' + ((@($T.tls.chainStatus) | ForEach-Object { [string]$_ }) -join ',') + ']')
    $lines += ('cred target=' + $T.cred.target + ' exists=' + $T.cred.exists + ' type=' + $T.cred.type + ' user=' + $T.cred.user + ' scope=' + $T.cred.scope)
    $lines += ('logon last4624=' + $T.logon.last4624 + ' last4625=' + $T.logon.last4625 + ' sub=' + $T.logon.sub + ' subMeaning=' + $T.logon.subMeaning + ' probeError=' + $T.logon.probeError)
    $lines += ('schannel tail=[' + ((@($T.schannel.tail) | ForEach-Object { '#' + $_.id + '@' + $_.ts }) -join ' ') + '] probeError=' + $T.schannel.probeError)
    $lines += ('listener boundThumb=' + $T.listener.boundThumb + ' inStore=' + $T.listener.inStore + ' hasKey=' + $T.listener.hasKey)
    $lines += ('listener container=' + $T.listener.container + ' certutilContainer=' + $T.listener.certutilContainer)
    $lines += ('listener aclSids=[' + ((@($T.listener.aclSids) | ForEach-Object { [string]$_ }) -join ' | ') + ']')
    $lines += ('served==bound: ' + ([string]$T.tls.servedThumb -ieq [string]$T.listener.boundThumb) + ' deathPoint=' + $T.deathPoint)
    return ($lines -join "`n")
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    if (-not $Fqdn) { throw 'Fqdn is required' }
    $trace = if ($TraceId) { $TraceId } else { ('t-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')) }
    $tele = Invoke-RdpTelescope -Name $Fqdn -TargetHost $Target -Trace $trace -ScopeName $Scope -KnownKey $KeyFile
    if ($ExpectedThumb -and $tele.tls.servedThumb -and ($tele.tls.servedThumb -ine $ExpectedThumb)) {
        $tele.tls.failurePoint = 'served-ne-bound'
        $tele.tls.why = ('served=' + $tele.tls.servedThumb + ' expected=' + $ExpectedThumb)
        $tele.deathPoint = Get-RdpTelescopeDeathPoint -Dns $tele.dns -Tls $tele.tls -Cred $tele.cred -Logon $tele.logon -Listener $tele.listener -ScopeName $Scope
        if ($tele.deathPoint -eq 'none') { $tele.deathPoint = 'tls-cert' }
    }
    if ($Summary) { Write-Host (Format-RdpTelescopeSummary -T $tele) }
    $tele | ConvertTo-Json -Compress -Depth 8
}
