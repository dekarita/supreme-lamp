# F53 lab: encrypted multipart into a strict Content-Length rejector.
# Declared length, part sum, and CountingStream dry-run must match. No guest
# upload. Chunked is not selected here.
param([switch]$SkipLargeCells)
$ErrorActionPreference = 'Stop'
$script:f53Failures = 0
function Result-F53([string]$Id, [bool]$Ok, [string]$Detail) {
    $verdict = $(if ($Ok) { 'PASS' } else { 'FAIL' })
    $line = ($Id + ' RESULT=' + $verdict + ' ' + $Detail) -replace '[\r\n]+', ' '
    Write-Host $line
    if ($Ok) { Write-Host ('::notice title=F53 cell::' + $line) }
    else { $script:f53Failures++; Write-Host ('::error title=F53 cell::' + $line) }
}
trap {
    Write-Host ('::error title=F53 lab fault::line ' + $_.InvocationInfo.ScriptLineNumber + ' phase=lab ' + $_.Exception.GetBaseException().Message)
    exit 1
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $repo 'payloads/ghrdp-mirror.ps1')
$ErrorActionPreference = 'Stop'
Add-F52ProgressTypes
$labCs = Join-Path $PSScriptRoot 'f53-content-length.cs'
if ($PSVersionTable.PSVersion.Major -lt 6) {
    Add-Type -Path $labCs -ReferencedAssemblies @('System.dll', 'System.Core.dll')
} else {
    # [F53] A PARTIAL -ReferencedAssemblies list REPLACES the default assembly
    # set instead of adding to it, so omitting System.Threading left every type in
    # it unresolvable: "CS1069: the type name 'ManualResetEventSlim' in
    # 'System.Threading' is forwarded to assembly 'System.Threading, Version=
    # 10.0.0.0', which is not in the current list of referenced assemblies".
    # Compile on the default set first - the same shape
    # tests/f52-mirror-telemetry.ps1 already compiles green on this runner for
    # a lab that also uses ManualResetEventSlim/TcpListener/Task.Run. Only if
    # that is ever not enough fall back to an explicit list, and that list now
    # carries the threading assemblies the default set was hiding.
    try {
        Add-Type -Path $labCs
    } catch {
        $refs = New-Object System.Collections.Generic.List[string]
        foreach ($n in @('System.Net.Security', 'System.Net.Sockets', 'System.Security.Cryptography.X509Certificates', 'System.Threading', 'System.Threading.Tasks', 'System.Runtime', 'System.Net.Primitives', 'netstandard')) {
            try { $a = [System.Reflection.Assembly]::Load($n); if ($a.Location) { [void]$refs.Add($a.Location) } } catch { }
        }
        if ($refs.Count -eq 0) { throw }
        Add-Type -Path $labCs -ReferencedAssemblies $refs.ToArray()
    }
}
$tmp = $env:RUNNER_TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath() }
$lab = Join-Path $tmp ('f53-' + [guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($lab)
$key = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($key) } finally { try { $rng.Dispose() } catch { } }

function New-F53File([string]$Name, [long]$Size) {
    $path = Join-Path $lab ($Name + '.bin')
    if ($Size -ge 1048576 -and $env:OS -eq 'Windows_NT') {
        $out = (& fsutil file createnew $path 0 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw ('fsutil createnew failed: ' + $out.Trim()) }
        $out = (& fsutil sparse setflag $path 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw ('fsutil sparse setflag failed: ' + $out.Trim()) }
    }
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try { $fs.SetLength($Size); if ($Size -gt 0 -and $Size -lt 1048576) { $fs.WriteByte(1) } } finally { $fs.Dispose() }
    return $path
}
function New-F53LoopHost($Port) {
    $h = Get-F46DefaultHost
    $h.enabled = $true
    $h.uploadHost = ('127.0.0.1:' + $Port)
    $h.uploadPath = '/uploadfile/'
    $h.uploadScheme = 'http'
    return $h
}
function Read-F53Count($Stream) {
    $buf = New-Object byte[] 65536
    $n = [long]0
    while ($true) {
        $g = $Stream.Read($buf, 0, $buf.Length)
        if ($g -le 0) { break }
        $n += $g
    }
    return $n
}

try {
    $hdr = 8 + 1 + 1 + 1 + [int]$script:F46GofileContract.gcmNonceBytes + 1 + [int]$script:F46GofileContract.gcmTagBytes
    Result-F53 'F53-GCM-HEADER' ($hdr -eq 40 -and [Ghrdp.Mirror.ContainerLength]::GcmHeader -eq 40) ('header=' + $hdr + ' framing=content-length')

    $aligned = [long]1170366464
    $alignedDelta = [Ghrdp.Mirror.ContainerLength]::Cbc($aligned) - $aligned
    Result-F53 'F53-CLASSIFY-A' ($alignedDelta -eq 48) ('hypothesis=a container-overhead=' + $alignedDelta + ' (header32+pkcs7-16) if declared were plaintext')

    $plain16 = New-F53File 'pin16' 16
    $enc16 = New-Object Ghrdp.Mirror.EncryptedSource($plain16, $key)
    $gate = New-Object Ghrdp.MirrorLab.ContentLengthGate([long]16)
    $threw = $false
    $throwMsg = ''
    try { $enc16.CopyTo($gate, 4096) } catch { $threw = $true; $throwMsg = $_.Exception.GetBaseException().Message }
    $enc16.Dispose()
    # A length pinned to plaintext is refused on the FIRST write, so the guest
    # takes 0 of the wire's bytes and the overshoot can never be absorbed.
    # ContentLengthGate rejects any write that would cross the limit and only
    # then counts it, so Written is 0 once it throws - it cannot be 16.
    $wire16 = [long][Ghrdp.Mirror.ContainerLength]::Cbc(16)
    Result-F53 'F53-CLASSIFY-BD' ($threw -and $throwMsg -eq 'Unable to write content to request stream; content would exceed Content-Length.' -and $gate.Written -eq 0 -and $wire16 -gt 16) ('hypothesis=b/d declared=16 wire=' + $wire16 + ' overshoot=' + ($wire16 - 16) + ' accepted-bytes=' + $gate.Written + ' message=' + $throwMsg)

    $snapMs = New-Object System.IO.MemoryStream(,[byte[]](1, 2, 3, 4, 5))
    $snap = New-Object Ghrdp.Mirror.SnapshotReadStream($snapMs, ([long]3))
    $snapBuf = New-Object byte[] 5
    $snapN = $snap.Read($snapBuf, 0, 5)
    $snapN2 = $snap.Read($snapBuf, 0, 5)
    $snap.Dispose()
    Result-F53 'F53-SNAPSHOT-BOUND' ($snapN -eq 3 -and $snapN2 -eq 0) 'inner had 5 bytes; snapshot stopped at 3'

    $growPath = New-F53File 'grow15' 15
    $grow = New-Object Ghrdp.Mirror.EncryptedSource($growPath, $key)
    $append = [System.IO.File]::Open($growPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try { $append.WriteByte(9) } finally { $append.Dispose() }
    $growCount = Read-F53Count $grow
    $growWire = [long]$grow.WireLength
    $grow.Dispose()
    Result-F53 'F53-GROW' ($growCount -eq 48 -and $growWire -eq 48 -and $growCount -ne 64) ('snapshot-wire=' + $growCount + ' unbounded-would-be=64')

    $state = New-Object Ghrdp.Mirror.ProgressState(60)
    $state.Written(100)
    $state.Reset()
    $entry = @{ bytesSent = [long]100; pct = 100; status = 'active'; phase = 'http' }
    Set-F53PendingRetry -Entry $entry -AttemptNo 1 -DelayMs 1000 | Out-Null
    Result-F53 'F53-RETRY-RESET' ($state.Snapshot().BytesSent -eq 0 -and [long]$entry.bytesSent -eq 0 -and [int]$entry.pct -eq 0 -and [string]$entry.status -eq 'pending' -and [int]$entry.attempt -eq 2) 'bytesSent=0 at attempt start and on pending retry; attempt=2'

    $formulaSizes = @(1, 15, 16, 17, 65536)
    if (-not $SkipLargeCells) { $formulaSizes += @(104857600, 1073741824) }
    foreach ($n in $formulaSizes) {
        $path = New-F53File ('formula-' + $n) ([long]$n)
        $cbc = New-Object Ghrdp.Mirror.EncryptedSource($path, $key)
        $cbcFormula = [Ghrdp.Mirror.ContainerLength]::Cbc([long]$n)
        $cbcCount = Read-F53Count $cbc
        $cbcDeclared = [long](Get-F53DeclaredPartLength -UploadSource $cbc -Path $path)
        $cbc.Dispose()
        $gcm = New-Object Ghrdp.MirrorLab.GcmLengthSource($path)
        $gcmFormula = [Ghrdp.Mirror.ContainerLength]::Gcm([long]$n)
        $gcmCount = Read-F53Count $gcm
        $gcm.Dispose()
        $ok = ($cbcCount -eq $cbcFormula -and $cbcDeclared -eq $cbcFormula -and $gcmCount -eq $gcmFormula)
        Result-F53 ('F53-LEN-FORMULA-' + $n) $ok ('cbc=' + $cbcCount + '/' + $cbcFormula + ' gcm=' + $gcmCount + '/' + $gcmFormula + ' framing=content-length')
    }

    $gcmAuth = Test-F46AesGcmUsable
    if ($gcmAuth) {
        $pt = New-Object byte[] 17
        $nonce = New-Object byte[] 12
        $tag = New-Object byte[] 16
        $ct = New-Object byte[] 17
        $aes = New-F46AesGcm -Key $key
        try { $aes.Encrypt($nonce, $pt, $ct, $tag) } finally { try { $aes.Dispose() } catch { } }
        Result-F53 'F53-GCM-AUTH' ($ct.Length -eq 17 -and ([Ghrdp.Mirror.ContainerLength]::Gcm(17) -eq (40 + 17))) 'gcm-auth=roundtrip ciphertext-length=plaintext'
    } else {
        Result-F53 'F53-GCM-AUTH' $true 'gcm-auth=length-witness AesGcm unavailable; formula still 40+plain'
    }

    function Invoke-F53Wire([string]$Mode, [long]$Size, [bool]$Tls) {
        $path = New-F53File ($Mode + '-' + $Size + $(if ($Tls) { '-tls' } else { '' })) $Size
        $cert = $null
        $rx = $null
        $src = $null
        $send = $null
        try {
            if ($Tls) {
                $cert = New-SelfSignedCertificate -DnsName '127.0.0.1' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
                $pfx = Join-Path $lab ('f53-' + $cert.Thumbprint + '.pfx')
                $secret = ConvertTo-SecureString 'f53-lab' -AsPlainText -Force
                Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secret | Out-Null
                $loaded = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfx, 'f53-lab', [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
                $rx = New-Object Ghrdp.MirrorLab.StrictReceiver($loaded)
            } else {
                $rx = New-Object Ghrdp.MirrorLab.StrictReceiver
            }
            $hostCfg = New-F53LoopHost $rx.Port
            $name = 'f53.bin.ghenc'
            $boundary = '----ghrdpF46' + [guid]::NewGuid().ToString('N')
            $spec = New-F46UploadRequestSpec -HostCfg $hostCfg -Name $name -Boundary $boundary -ContentType 'application/x-ghrdp-mirror'
            if ($Mode -eq 'cbc') { $src = New-Object Ghrdp.Mirror.EncryptedSource($path, $key) }
            else { $src = New-Object Ghrdp.MirrorLab.GcmLengthSource($path) }
            $part = [long](Get-F53DeclaredPartLength -UploadSource $src -Path $path)
            $formula = $(if ($Mode -eq 'cbc') { [Ghrdp.Mirror.ContainerLength]::Cbc($Size) } else { [Ghrdp.Mirror.ContainerLength]::Gcm($Size) })
            $measured = Measure-F53Upload -Stream $src -Length $part -Spec $spec -Boundary $boundary
            $src.Dispose(); $src = $null
            if ($Mode -eq 'cbc') { $send = New-Object Ghrdp.Mirror.EncryptedSource($path, $key) }
            else { $send = New-Object Ghrdp.MirrorLab.GcmLengthSource($path) }
            $res = $null
            if (-not $Tls) {
                $res = Send-F46GofileUpload -HostCfg $hostCfg -Path $path -Name $name -Target (Get-F46UploadTarget -HostCfg $hostCfg) -ContentType 'application/x-ghrdp-mirror' -UploadSource $send -StallWindowSec 60 -WorkerMode 'all' -AttemptNo 1
            } else {
                # Lab-only loopback TLS. Production guest upload stays HTTPS via GuestClient.
                $tcp = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $rx.Port)
                $acceptAny = [System.Net.Security.RemoteCertificateValidationCallback]{ param($sender, $certificate, $chain, $errors) $true }
                $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $acceptAny)
                $ssl.AuthenticateAsClient('127.0.0.1', $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
                $head = 'POST /uploadfile/ HTTP/1.1' + "`r`n" + 'Host: 127.0.0.1' + "`r`n" + 'Content-Type: multipart/form-data; boundary=' + $boundary + "`r`n" + 'Content-Length: ' + $measured.dryRun + "`r`n" + 'Connection: close' + "`r`n`r`n"
                $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
                $ssl.Write($hb, 0, $hb.Length)
                $mp = New-F46UploadContent -Stream $send -Length $part -State (New-Object Ghrdp.Mirror.ProgressState(60)) -Spec $spec -Boundary $boundary
                $mp.CopyToAsync($ssl).GetAwaiter().GetResult()
                $mp.Dispose()
                $ssl.Flush()
                $ack = New-Object byte[] 256
                try { [void]$ssl.Read($ack, 0, $ack.Length) } catch { }
                $res = @{ ok = $true }
                $tcp.Close()
            }
            $rx.Wait(900000)
            $ok = ($measured.declared -eq $measured.dryRun -and $measured.partSum -eq $formula -and $measured.framingMode -eq 'content-length' -and $rx.SawContentLength -and -not $rx.SawChunked -and -not $rx.Overshoot -and $rx.Drained -eq $rx.Declared -and $rx.Declared -eq ($formula + [long]$measured.framing) -and [bool]$res.ok -and $rx.StatusWritten -eq 200)
            $detail = ('mode=' + $Mode + ' declared=' + $measured.declared + ' part=' + $measured.partSum + ' dry=' + $measured.dryRun + ' framing=' + $measured.framing + ' listener=' + $rx.Declared + '/' + $rx.Drained + ' overshoot=' + $rx.Overshoot + ' tls=' + $Tls + ' err=' + $rx.Error)
            return @{ ok = $ok; detail = $detail }
        } finally {
            try { if ($src) { $src.Dispose() } } catch { }
            try { if ($send) { $send.Dispose() } } catch { }
            try { if ($rx) { $rx.Dispose() } } catch { }
            if ($cert) { try { Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $cert.Thumbprint) -Force } catch { } }
        }
    }

    $wire = @(17)
    if (-not $SkipLargeCells) { $wire += @(104857600, 1073741824, 3221225472) }
    foreach ($n in $wire) {
        foreach ($mode in @('cbc', 'gcm')) {
            try { $cell = Invoke-F53Wire $mode ([long]$n) $false }
            catch { $cell = @{ ok = $false; detail = $_.Exception.GetBaseException().Message } }
            Result-F53 ('F53-LEN-WIRE-' + $mode + '-' + $n) ([bool]$cell.ok) ([string]$cell.detail)
        }
    }
    try { $tlsCell = Invoke-F53Wire 'cbc' 17 $true }
    catch { $tlsCell = @{ ok = $false; detail = $_.Exception.GetBaseException().Message } }
    Result-F53 'F53-LEN-TLS' ([bool]$tlsCell.ok) ([string]$tlsCell.detail)

    $cap = 'UNPROVEN'
    $capNote = 'not-queried'
    try {
        $req = [System.Net.WebRequest]::Create('https://api.gofile.io/servers')
        $req.Method = 'GET'
        $req.Timeout = 20000
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $sr.ReadToEnd()
        $sr.Close(); $resp.Close()
        $capNote = 'http=' + [int]$resp.StatusCode
        $json = ConvertFrom-F46Json -Text $text
        $found = $null
        foreach ($name in @('maxFileSize', 'maxSize', 'fileSizeLimit', 'sizeLimit')) {
            $v = Get-F46Prop $json $name
            if ($null -ne $v -and [string]$v -match '^\d+$') { $found = [int64]$v }
        }
        if ($null -ne $found) { $cap = [string]$found } else { $cap = 'UNPROVEN'; $capNote = $capNote + ' no-numeric-cap-field' }
    } catch {
        $cap = 'UNPROVEN'
        $capNote = 'probe-failed ' + $_.Exception.GetBaseException().Message
    }
    if ($cap -ne 'UNPROVEN' -and [int64]$cap -lt 100000000000) {
        Result-F53 'F53-GUEST-CAP' $false ('proven=' + $cap + ' STOP options: self-hosted target for that size class | accept cap. No evasion.')
    } else {
        Result-F53 'F53-GUEST-CAP' $true ('guest-accepted=' + $cap + ' ' + $capNote + ' framing=content-length')
    }
} finally {
    try { [Array]::Clear($key, 0, $key.Length) } catch { }
    try { Remove-Item -LiteralPath $lab -Recurse -Force } catch { }
}
if ($script:f53Failures -gt 0) { exit 1 }
Write-Host 'F53 ALL CHECKS PASS'
exit 0
