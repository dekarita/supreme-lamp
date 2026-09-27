# F31: bounded X.224 RDP negotiation followed by Schannel TLS to the local listener.
param(
    [Parameter(Mandatory)][string]$Fqdn,
    [Parameter(Mandatory)][string]$ExpectedThumb,
    [Parameter(Mandatory)][string]$KeyFile
)
$ErrorActionPreference = 'Stop'
$started = Get-Date
$lastError = 'no probe attempted'
$script:served = ''
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $tcp = $null; $ssl = $null; $script:served = ''
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $connect = $tcp.ConnectAsync('127.0.0.1', 3389)
        if (-not $connect.Wait(5000)) { throw 'TCP connect timeout' }
        $tcp.ReceiveTimeout = 7000; $tcp.SendTimeout = 7000
        $stream = $tcp.GetStream()
        # TPKT + X.224 Connection Request + RDP_NEG_REQ: TLS | HYBRID (NLA).
        [byte[]]$request = 0x03,0x00,0x00,0x13,0x0e,0xe0,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x08,0x00,0x03,0x00,0x00,0x00
        $stream.Write($request, 0, $request.Length)
        function Read-Exact([System.IO.Stream]$InputStream, [int]$Length) {
            $buf = [byte[]]::new($Length); $pos = 0
            while ($pos -lt $Length) {
                $n = $InputStream.Read($buf, $pos, $Length - $pos)
                if ($n -le 0) { throw 'X.224 connection reset/EOF' }
                $pos += $n
            }
            return ,$buf
        }
        [byte[]]$header = Read-Exact $stream 4
        if ($header[0] -ne 3 -or $header[1] -ne 0) { throw 'invalid TPKT header' }
        $length = ([int]$header[2] -shl 8) -bor [int]$header[3]
        if ($length -lt 19 -or $length -gt 1024) { throw ('invalid X.224 length ' + $length) }
        [byte[]]$response = Read-Exact $stream ($length - 4)
        if ($response[1] -ne 0xd0) { throw 'X.224 is not a connection confirm' }
        # X.224 confirm is 7 bytes (including TPKT); negotiation response at offset 7.
        if ($response[6] -ne 2 -or $response[8] -ne 8 -or $response[9] -ne 0) { throw 'RDP negotiation did not select TLS' }
        $protocol = [BitConverter]::ToUInt32($response, 10)
        if ($protocol -ne 1 -and $protocol -ne 2 -and $protocol -ne 8) { throw ('RDP selected non-TLS protocol ' + $protocol) }
        $callback = [System.Net.Security.RemoteCertificateValidationCallback]{
            param($sender, $cert, $chain, $errors)
            if (-not $cert) { return $false }
            $script:served = $cert.GetCertHashString().ToUpperInvariant()
            return ($script:served -eq $ExpectedThumb.ToUpperInvariant() -and $errors -eq [System.Net.Security.SslPolicyErrors]::None)
        }
        $ssl = [System.Net.Security.SslStream]::new($stream, $false, $callback)
        $task = $ssl.AuthenticateAsClientAsync($Fqdn)
        if (-not $task.Wait(7000)) { throw 'TLS handshake timeout' }
        if (-not $ssl.IsAuthenticated -or $script:served -ne $ExpectedThumb.ToUpperInvariant()) {
            throw ('served certificate mismatch: served=' + $script:served + ' bound=' + $ExpectedThumb)
        }
        Write-Host ('[F31] X.224 + TLS handshake OK, served==bound=' + $script:served)
        return
    } catch {
        $lastError = $_.Exception.Message
        if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
    } finally {
        if ($ssl) { $ssl.Dispose() }
        if ($tcp) { $tcp.Dispose() }
    }
}
$events = 'none'
try {
    $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = @(36870, 36871, 36888); StartTime = $started } -MaxEvents 8 -ErrorAction Stop)
    $events = (@($raw | ForEach-Object { 'Schannel ' + $_.Id + ' at ' + $_.TimeCreated.ToUniversalTime().ToString('o') }) -join '; ')
} catch { $events = 'Schannel unavailable or no events' }
$acl = try { (Get-Acl -LiteralPath $KeyFile -ErrorAction Stop).AccessToString } catch { 'ACL unreadable' }
throw ('listener handshake failed: ' + $lastError + '; served=' + $script:served + ' bound=' + $ExpectedThumb + '; ' + $events + '; key ACL: ' + $acl)
