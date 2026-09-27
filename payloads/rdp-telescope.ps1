# F37: single-source, secret-free RDP handshake diagnostics.
# Dot-source and call Get-RdpTelescope; each call emits one JSONL record per stage.
# Never reads credential blobs/passwords, installs trust, or changes NLA.
function Get-RdpTelescope {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Target,
        [int]$Port = 3389,
        [string]$TraceId = ([guid]::NewGuid().ToString('N')),
        [string]$OutputPath = ''
    )
    $rows = [System.Collections.Generic.List[object]]::new()
    function Add-TelescopeRow([string]$Stage, [string]$Status, [System.Collections.IDictionary]$Fields) {
        $row = [ordered]@{ schema='rdp-telescope.v1'; ts=[datetime]::UtcNow.ToString('o'); traceId=$TraceId; stage=$Stage; status=$Status }
        foreach ($key in $Fields.Keys) { $row[$key] = $Fields[$key] }
        $obj = [pscustomobject]$row
        $rows.Add($obj)
        $json = $obj | ConvertTo-Json -Depth 6 -Compress
        Write-Output $json
        if ($OutputPath) { [System.IO.File]::AppendAllText($OutputPath, $json + "`n", [System.Text.UTF8Encoding]::new($false)) }
    }
    $addresses = @()
    try {
        $addresses = @([System.Net.Dns]::GetHostAddresses($Target) | ForEach-Object { $_.IPAddressToString } | Select-Object -Unique)
        Add-TelescopeRow 'dns' $(if ($addresses.Count) {'ok'} else {'fail'}) @{ fqdn=$Target; ips=$addresses }
    } catch { Add-TelescopeRow 'dns' 'fail' @{ fqdn=$Target; ips=@(); error='dns-resolution-failed' } }
    $tcp = $null; $stream = $null; $ssl = $null; $served = ''; $chainStatus = @(); $protocol = ''; $cipher = ''; $failure = ''
    $connectIp = if ($addresses.Count) { [string]$addresses[0] } else { $Target }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $ar = $tcp.BeginConnect($connectIp, $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(5000)) { throw [TimeoutException]::new('tcp-timeout') }
        $tcp.EndConnect($ar); $clock.Stop()
        Add-TelescopeRow 'tcp' 'ok' @{ ip=$connectIp; port=$Port; rttMs=[int]$clock.ElapsedMilliseconds }
        $stream = $tcp.GetStream(); $stream.ReadTimeout = 5000; $stream.WriteTimeout = 5000
        # RDP X.224 Connection Request with SSL selected. TLS must start only
        # after the server's X.224 negotiation response on the same socket.
        [byte[]]$request = 0x03,0x00,0x00,0x13,0x0e,0xe0,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x08,0x00,0x01,0x00,0x00,0x00
        $stream.Write($request, 0, $request.Length)
        $head = New-Object byte[] 4; $got = 0
        while ($got -lt 4) { $n = $stream.Read($head, $got, 4 - $got); if ($n -le 0) { throw 'x224-short-header' }; $got += $n }
        $packetLength = [int]$head[2] * 256 + [int]$head[3]
        if ($packetLength -lt 11 -or $packetLength -gt 8192) { throw 'x224-invalid-length' }
        $reply = New-Object byte[] $packetLength; [Array]::Copy($head, $reply, 4); $got = 4
        while ($got -lt $packetLength) { $n = $stream.Read($reply, $got, $packetLength - $got); if ($n -le 0) { throw 'x224-short-response' }; $got += $n }
        $read = $packetLength
        if ($reply[5] -ne 0xd0) { throw 'x224-connection-rejected' }
        $nego = -1
        for ($i=11; $i -le $read-8; $i++) { if ($reply[$i] -eq 2 -and $reply[$i+1] -eq 0 -and $reply[$i+2] -eq 8 -and $reply[$i+3] -eq 0) { $nego=$i; break } }
        if ($nego -lt 0 -or [BitConverter]::ToUInt32($reply, $nego+4) -ne 1) { throw 'x224-tls-not-selected' }
        $callback = [System.Net.Security.RemoteCertificateValidationCallback]{ param($sender,$certificate,$chain,$errors)
            if ($certificate) { $script:F37ServedCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificate).Thumbprint }
            $script:F37ChainStatus = @()
            if ($chain) { $script:F37ChainStatus = @($chain.ChainStatus | ForEach-Object { [string]$_.Status }) }
            if ($errors -band [System.Net.Security.SslPolicyErrors]::RemoteCertificateNameMismatch) { $script:F37ChainStatus += 'RemoteCertificateNameMismatch' }
            if ($errors -band [System.Net.Security.SslPolicyErrors]::RemoteCertificateNotAvailable) { $script:F37ChainStatus += 'RemoteCertificateNotAvailable' }
            if ($errors -band [System.Net.Security.SslPolicyErrors]::RemoteCertificateChainErrors -and $script:F37ChainStatus.Count -eq 0) { $script:F37ChainStatus += 'RemoteCertificateChainErrors' }
            return $true
        }
        $script:F37ServedCert=''; $script:F37ChainStatus=@()
        $ssl = [System.Net.Security.SslStream]::new($stream, $false, $callback)
        try {
            $ssl.AuthenticateAsClient($Target, $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
            $protocol=[string]$ssl.SslProtocol; $cipher=[string]$ssl.CipherAlgorithm
            if ($script:F37ChainStatus -contains 'RemoteCertificateNameMismatch') { $failure='name-mismatch' }
            elseif ($script:F37ChainStatus.Count -gt 0 -and $script:F37ChainStatus -notcontains 'NoError') { $failure='chain=' + ($script:F37ChainStatus -join ',') }
            Add-TelescopeRow 'tls' $(if ($failure) {'fail'} else {'ok'}) @{ servedThumb=$script:F37ServedCert; chainStatus=@($script:F37ChainStatus); protocol=$protocol; cipher=$cipher; failurePoint=$failure }
        } catch {
            if ($script:F37ServedCert) {
                $failure = if ($script:F37ChainStatus -contains 'RemoteCertificateNameMismatch') {'name-mismatch'} else {'chain=' + ($script:F37ChainStatus -join ',')}
                Add-TelescopeRow 'tls' 'fail' @{ servedThumb=$script:F37ServedCert; chainStatus=@($script:F37ChainStatus); protocol=''; cipher=''; failurePoint=$failure }
            } else { Add-TelescopeRow 'tls' 'fail' @{ servedThumb=''; chainStatus=@(); protocol=''; cipher=''; failurePoint='rst-before-cert'; error='tls-handshake-failed' } }
        }
    } catch {
        $clock.Stop()
        if (-not $tcp -or -not $tcp.Connected) { Add-TelescopeRow 'tcp' 'fail' @{ ip=$connectIp; port=$Port; rttMs=[int]$clock.ElapsedMilliseconds; failurePoint='tcp-connect-failed' } }
        else { Add-TelescopeRow 'tls' 'fail' @{ servedThumb=''; chainStatus=@(); protocol=''; cipher=''; failurePoint='rst-before-cert'; error='x224-negotiation-failed' } }
    } finally { if ($ssl) {$ssl.Dispose()}; if ($stream) {$stream.Dispose()}; if ($tcp) {$tcp.Close()} }

    # Credential metadata only: cmdkey output contains target/type/user metadata;
    # no API below opens or returns credential blobs.
    $credExists=$false; $credType=''; $credUser=''
    try {
        $list = (& cmdkey.exe /list 2>$null | Out-String)
        $block = [regex]::Match($list, '(?im)^\s*Target:\s*TERMSRV/' + [regex]::Escape($Target) + '\s*$([\s\S]*?)(?=^\s*Target:|\z)')
        if ($block.Success) { $credExists=$true; if ($block.Value -match '(?im)^\s*Type:\s*(.+)$') {$credType=$Matches[1].Trim()}; if ($block.Value -match '(?im)^\s*User:\s*(.+)$') {$credUser=$Matches[1].Trim()} }
    } catch { }
    Add-TelescopeRow 'cred' 'ok' @{ targetExists=$credExists; type=$credType; user=$credUser }

    $listener = [ordered]@{ boundThumb=''; inStore=$false; hasKey=$false; container=''; aclSids=@(); certutil='unavailable' }
    try {
        $keyPath='HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
        $raw=(Get-ItemProperty -LiteralPath $keyPath -Name SSLCertificateSHA1Hash -ErrorAction Stop).SSLCertificateSHA1Hash
        if ($raw -is [byte[]]) {$listener.boundThumb=($raw|ForEach-Object{$_.ToString('X2')}) -join ''} else {$listener.boundThumb=([string]$raw -replace '\s','').ToUpperInvariant()}
        $keyFile=''
        $cert=Get-Item -LiteralPath ('Cert:\LocalMachine\My\'+$listener.boundThumb) -ErrorAction SilentlyContinue
        if ($cert) {$listener.inStore=$true;$listener.hasKey=[bool]$cert.HasPrivateKey
            $privateKey=[System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
            if ($privateKey -is [System.Security.Cryptography.RSACng]) {$listener.container=[string]$privateKey.Key.UniqueName;$keyFile=Join-Path $env:ProgramData ('Microsoft\Crypto\Keys\'+$listener.container)}
            elseif ($privateKey -is [System.Security.Cryptography.RSACryptoServiceProvider]) {$listener.container=[string]$privateKey.CspKeyContainerInfo.UniqueKeyContainerName;$keyFile=Join-Path $env:ProgramData ('Microsoft\Crypto\RSA\MachineKeys\'+$listener.container)}
            if (-not $listener.container) {$privateKey=[System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($cert);if ($privateKey -is [System.Security.Cryptography.ECDsaCng]) {$listener.container=[string]$privateKey.Key.UniqueName;$keyFile=Join-Path $env:ProgramData ('Microsoft\Crypto\Keys\'+$listener.container)}}
        }
        if ($keyFile -and (Test-Path $keyFile)) {$listener.aclSids=@((Get-Acl -LiteralPath $keyFile).Access|ForEach-Object{try{$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$_.IdentityReference.Value}}|Select-Object -Unique)}
        $cu=(& certutil.exe -key 2>$null | Out-String); if ($listener.container -and $cu -match [regex]::Escape($listener.container)) {$listener.certutil='container-found'}
    } catch { }
    Add-TelescopeRow 'listener' $(if ($listener.boundThumb) {'ok'} else {'unknown'}) $listener

    $events=@(); try {$events=@(Get-WinEvent -FilterHashtable @{LogName='System'; Id=@(36870,36871,36888,12018); StartTime=(Get-Date).AddHours(-1)} -MaxEvents 12 -ErrorAction Stop | ForEach-Object {[ordered]@{id=[int]$_.Id; timeUtc=$_.TimeCreated.ToUniversalTime().ToString('o')}})} catch { }
    Add-TelescopeRow 'schannel' 'ok' @{ events=$events }
    $auth=@(); try {$auth=@(Get-WinEvent -FilterHashtable @{LogName='Security'; Id=@(4624,4625); StartTime=(Get-Date).AddHours(-1)} -MaxEvents 20 -ErrorAction Stop | ForEach-Object {$id=[int]$_.Id; $x=[xml]$_.ToXml();$d=@{};foreach($v in $x.SelectNodes("//*[local-name()='Data']")){$d[[string]$v.GetAttribute('Name')]=[string]$v.InnerText};if($id -eq 4624 -and $d.LogonType -ne '10'){return};[ordered]@{id=$id;timeUtc=$_.TimeCreated.ToUniversalTime().ToString('o');sub=[string]$d.SubStatus}})} catch { }
    Add-TelescopeRow 'logon' 'ok' @{ events=$auth }
    return $rows.ToArray()
}
