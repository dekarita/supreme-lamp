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
# [F37 §1] the SAME compiled callback shim the telescope uses: a PowerShell
# scriptblock cannot run on the threadpool thread that completes the handshake
# ("no Runspace available to run scripts in this thread"), which made this probe
# report served=<empty> while the listener was healthy. One implementation, one
# behaviour, no second parser.
$tlsMod = Join-Path $PSScriptRoot 'rdp-telescope.ps1'
if ((Test-Path -LiteralPath $tlsMod -PathType Leaf) -and -not (Get-Command 'Add-RdpTelescopeTlsShim' -ErrorAction SilentlyContinue)) {
    try { . $tlsMod } catch { }
}
if (Get-Command 'Add-RdpTelescopeTlsShim' -ErrorAction SilentlyContinue) { Add-RdpTelescopeTlsShim }
else { throw 'the compiled TLS callback shim is unavailable (payloads/rdp-telescope.ps1 must sit next to this probe)' }
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
        # [F37 §1] the response layout has ONE implementation, in the module:
        # X.224 confirm (7 bytes) + RDP_NEG_RSP (type 0x02, flags, length 0x0008
        # LITTLE-ENDIAN, selectedProtocol at offset 11). Reading it here with
        # hand-rolled offsets is how a working listener got called broken.
        $protocol = Test-RdpTelescopeX224Confirm -Response $response
        [GhrdpTelTls]::Reset()
        $callback = [GhrdpTelTls]::Callback()
        $ssl = [System.Net.Security.SslStream]::new($stream, $false, $callback)
        $task = $ssl.AuthenticateAsClientAsync($Fqdn)
        if (-not $task.Wait(7000)) { throw 'TLS handshake timeout' }
        $script:served = [string][GhrdpTelTls]::ServedThumb
        if (-not $ssl.IsAuthenticated) { throw 'TLS stream did not authenticate' }
        if ($script:served -ne $ExpectedThumb.ToUpperInvariant()) {
            throw ('served certificate mismatch: served=' + $script:served + ' bound=' + $ExpectedThumb)
        }
        $errs = [System.Net.Security.SslPolicyErrors]([int][GhrdpTelTls]::Errors)
        if ($errs -ne [System.Net.Security.SslPolicyErrors]::None) {
            throw ('served certificate did not validate: ' + $errs + ' [' + [string][GhrdpTelTls]::ChainStatus + ']')
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
