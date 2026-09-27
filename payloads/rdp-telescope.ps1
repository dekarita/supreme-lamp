# rdp-telescope.ps1  [F37 §1] RDP TELESCOPE - SELF-EXPLAINING OBSERVABILITY.
#
# SINGLE SOURCE OF TRUTH for the client <-> runner RDP diagnostic format. Every
# surface that observes the path (the lab cell, the live runner, the launcher
# beacon) speaks THIS vocabulary - the format is never re-implemented, only
# imported (dot-source) or mirrored token-for-token by the compiled launcher.
#
# [F37 §1 telescope-format] ONE JSON OBJECT PER LINE (JSONL), flat, secret-free:
#   { "ts":"<utc iso>", "trace":"<id>", "src":"<lab|live|keepalive|client>",
#     "stage":"<stage>", "ok":<bool>, "why":"<short reason>", ...stage fields }
#
# -Local makes the runner observe its OWN listener face (loopback): the dns
# stage is then informational and the tcp/tls/listener/acl stages are the ones
# that matter, so a bind drift is reported even while DNS is down.
#
# stages (in path order):
#   dns       fqdn -> ip                : fqdn, ip, addresses, ok, why
#   tcp       ip:3389 reachability+rtt  : ip, port, rttMs, ok, why
#   x224+tls  what the listener SERVES  : servedThumb, chainStatus[], chainOk,
#                                         nameMatch, serverAuth, eku, protocol,
#                                         cipher, failureAt, ok, why
#   cred      stored target (no secret) : credTarget, credExists, credType,
#                                         credUser, ok, why
#   logon     last 4624/4625 + sub      : eventId, logonType, sub, eventTs,
#                                         count4624, count4625, ok, why
#   schannel  last 36870/36871/36888/12018 : schannelIds, lastSchannelId,
#                                         lastSchannelTs, schannelWhy, ok, why
#   listener  bind effectiveness        : boundThumb, servedThumb, inStore,
#                                         hasKey, container, containerPath,
#                                         certutilContainer, aclSids, aclRead,
#                                         aclOk, serving, ok, why
#
# TLS failure points (failureAt) - the ONE field that names the death point:
#   rst-before-cert  server reset before it ever presented a certificate
#                    (Schannel refused: missing ServerAuth EKU, denied key ACL,
#                     or no cert bound at all) - servedThumb stays empty
#   chain=<status>   certificate WAS served and the chain status is named
#   name-mismatch    certificate served, chain fine, name does not cover fqdn
#   eku              certificate served, EKU present but ServerAuth absent
#
# death points (Get-RdpTelescopeDeathPoint):
#   dns | tcp | tls-cert | tls-chain | tls-eku | name-mismatch | credssp |
#   logon | acl | none
#
# client beacon slugs (shared with payloads/ghrdp-rdp-launcher.cs verb diag):
#   telescope-dns-ok | telescope-dns-fail | telescope-tcp-ok | telescope-tcp-fail
#   telescope-tls-ok | telescope-rst-before-cert | telescope-chain
#   telescope-name-mismatch | telescope-eku | telescope-cred-ok
#   telescope-cred-missing
#
# HARD RULES (enforced by tests/f37-telescope.test.js and the F37 gate):
#   * NEVER reads, stores, logs or transports a password, hash, ticket or blob:
#     the only credential facts are target existence, type and user name.
#   * No credential-UI automation, no NLA weakening, no client trust installs:
#     the TLS probe uses a PERMISSIVE callback that only READS the presented
#     certificate, it never installs or trusts anything.
#   * Every field name must be in $script:F37TelFields: Select-RdpTelescopeLine
#     drops anything else, so a new caller cannot leak a new value by accident.
#   * A telescope never throws: a stage that cannot run emits ok=false+why.

$script:F37TelSrc = 'live'
$script:F37TelTrace = ''
$script:F37TelPortDefault = 3389

# [F37 §1 telescope-format] the allowlist IS the wire format.
$script:F37TelFields = @{
    common   = @('ts', 'trace', 'src', 'stage', 'ok', 'why')
    dns      = @('fqdn', 'ip', 'addresses')
    tcp      = @('ip', 'port', 'rttMs')
    tls      = @('servedThumb', 'chainStatus', 'chainOk', 'nameMatch', 'nameServed', 'serverAuth', 'eku', 'protocol', 'cipher', 'cipherStrength', 'failureAt', 'expectedThumb')
    cred     = @('credTarget', 'credExists', 'credType', 'credUser')
    logon    = @('eventId', 'logonType', 'sub', 'eventTs', 'count4624', 'count4625')
    schannel = @('schannelIds', 'lastSchannelId', 'lastSchannelTs', 'schannelWhy', 'sinceSec')
    listener = @('boundThumb', 'servedThumb', 'inStore', 'hasKey', 'container', 'containerKind', 'containerPath', 'keyFilePathSource', 'keyFileFound', 'keyFileCandidates', 'keyDirHits', 'keyDirSample', 'keyTypedError', 'typesLoader', 'certutilContainer', 'aclSids', 'aclRead', 'aclOk', 'serving', 'hasServerAuth', 'eku', 'san')
    beacon   = @('beacon')
}
function Get-RdpTelescopeFormatTokens {
    # [F37 §1 telescope-format] canonical, machine-checkable vocabulary. The F37
    # gate compares the compiled launcher against THESE tokens; the launcher may
    # not invent a stage, a failure point or a beacon slug on its own.
    param([string]$Kind = 'all')
    $stages = @('dns', 'tcp', 'tls', 'cred', 'logon', 'schannel', 'listener')
    $failureAt = @('rst-before-cert', 'chain', 'name-mismatch', 'eku')
    $deathPoints = @('dns', 'tcp', 'tls-cert', 'tls-chain', 'tls-eku', 'name-mismatch', 'credssp', 'logon', 'acl', 'none')
    $slugs = @(
        'telescope-dns-ok', 'telescope-dns-fail', 'telescope-tcp-ok', 'telescope-tcp-fail',
        'telescope-tls-ok', 'telescope-rst-before-cert', 'telescope-chain',
        'telescope-name-mismatch', 'telescope-eku', 'telescope-cred-ok',
        'telescope-cred-missing'
    )
    switch ($Kind) {
        'stages' { return $stages }
        'failureAt' { return $failureAt }
        'deathPoints' { return $deathPoints }
        'slugs' { return $slugs }
        default { return @{ stages = $stages; failureAt = $failureAt; deathPoints = $deathPoints; slugs = $slugs } }
    }
}
function New-RdpTelescopeTraceId {
    # minted per click (dashboard/launcher) so every line of one attempt shares
    # one id. Random + timestamp only, never derived from a credential.
    param([string]$Src = 'live')
    # The SERVER runs Windows PowerShell 5.1 (.NET Framework 4.8): the static
    # RandomNumberGenerator::GetBytes(int) is .NET Core 3.0+ only and made the
    # whole runner telescope degrade - so mint with the instance API that exists
    # on every supported runtime.
    $r = [byte[]]::new(4)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($r) } finally { if ($rng) { $rng.Dispose() } }
    return ('t' + (Get-Date).ToUniversalTime().ToString('yyMMddHHmmss') + '-' + $Src + '-' + (($r | ForEach-Object { $_.ToString('x2') }) -join ''))
}
function Select-RdpTelescopeLine {
    # Enforce the allowlist + secret-free rule. Unknown keys are DROPPED (never
    # emitted), values are clipped and scrubbed: defence in depth so a caller
    # cannot smuggle a password into the telescope by naming a field after it.
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Line)
    $stage = [string]$Line['stage']
    $allowed = @($script:F37TelFields.common)
    if ($stage -and $script:F37TelFields.ContainsKey($stage)) { $allowed += @($script:F37TelFields[$stage]) }
    $secretName = '(?i)(pass|pwd|secret|token|ticket|hash|credential|blob|apikey|authkey|privatekey|pfx)'
    $out = [ordered]@{}
    foreach ($k in @($Line.Keys)) {
        if (-not ($allowed -contains $k)) { continue }
        if ($k -match $secretName) { continue }
        $v = $Line[$k]
        if ($v -is [array]) {
            $out[$k] = @($v | ForEach-Object { ([string]$_).Substring(0, [Math]::Min(160, ([string]$_).Length)) })
        } elseif ($v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double]) {
            $out[$k] = $v
        } else {
            $s = [string]$v
            if ($s.Length -gt 200) { $s = $s.Substring(0, 200) }
            $out[$k] = $s
        }
    }
    return $out
}
function New-RdpTelescopeLine {
    # One JSONL line (ConvertTo-Json -Compress). Unknown fields are dropped by
    # Select-RdpTelescopeLine; the result is always a single line.
    param(
        [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][bool]$Ok,
        [string]$Why = '',
        [System.Collections.IDictionary]$Fields = @{},
        [string]$Trace = '',
        [string]$Src = ''
    )
    $line = [ordered]@{}
    $line['ts'] = (Get-Date).ToUniversalTime().ToString('o')
    $line['trace'] = $(if ($Trace) { $Trace } else { $script:F37TelTrace })
    $line['src'] = $(if ($Src) { $Src } else { $script:F37TelSrc })
    $line['stage'] = $Stage
    $line['ok'] = $Ok
    $line['why'] = $Why
    foreach ($k in @($Fields.Keys)) { $line[$k] = $Fields[$k] }
    $safe = Select-RdpTelescopeLine -Line $line
    return (($safe | ConvertTo-Json -Compress -Depth 4) -replace "`r?`n", ' ')
}
function New-RdpTelescopeResult {
    # The telescope VALUE is the lines (JSONL) plus the verdict. Lines are the
    # only thing that travels (config / beacon / artifact / summary).
    param([string]$Trace = '', [string]$Src = 'live', [object[]]$Lines = @(), [string]$DeathPoint = 'none')
    return [pscustomobject]@{ trace = $Trace; src = $Src; lines = @($Lines); deathPoint = $DeathPoint }
}
function Get-RdpTelescopeDns {
    # stage dns: fqdn -> ip. A tailnet address (100.64.0.0/10) is preferred and
    # reported first so a poisoned/blocked name is visible WITHOUT mstsc.
    param([Parameter(Mandatory)][string]$Fqdn, [string]$Trace = '', [string]$Src = '')
    $ip = ''; $addrs = @()
    try {
        if ($Fqdn -match '^\d{1,3}(\.\d{1,3}){3}$') {
            $addrs = @($Fqdn); $ip = $Fqdn
        } else {
            $addrs = @([System.Net.Dns]::GetHostAddresses($Fqdn) | ForEach-Object { $_.IPAddressToString })
            foreach ($a in $addrs) { if ($a -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.') { $ip = $a; break } }
            if (-not $ip) { $ip = [string]($addrs | Select-Object -First 1) }
        }
        if (-not $ip) { throw 'no addresses returned' }
        return New-RdpTelescopeLine -Stage 'dns' -Ok $true -Fields @{ fqdn = $Fqdn; ip = $ip; addresses = $addrs } -Trace $Trace -Src $Src
    } catch {
        return New-RdpTelescopeLine -Stage 'dns' -Ok $false -Why ('resolve failed: ' + $_.Exception.Message) -Fields @{ fqdn = $Fqdn; ip = ''; addresses = @() } -Trace $Trace -Src $Src
    }
}
function Get-RdpTelescopeTcp {
    # stage tcp: ip:3389 reachability + round trip. Separates "nothing is
    # listening / firewalled" from "TLS is refused", which is the entire point.
    param([Parameter(Mandatory)][string]$Ip, [int]$Port = 3389, [int]$TimeoutMs = 5000, [string]$Trace = '', [string]$Src = '')
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $tcp = $null
    try {
        if (-not $Ip) { throw 'no address to probe' }
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $connect = $tcp.ConnectAsync($Ip, $Port)
        if (-not $connect.Wait($TimeoutMs)) { throw ('TCP connect timeout after ' + $TimeoutMs + 'ms') }
        $sw.Stop()
        return New-RdpTelescopeLine -Stage 'tcp' -Ok $true -Fields @{ ip = $Ip; port = $Port; rttMs = [int]$sw.ElapsedMilliseconds } -Trace $Trace -Src $Src
    } catch {
        $sw.Stop()
        return New-RdpTelescopeLine -Stage 'tcp' -Ok $false -Why ($_.Exception.Message) -Fields @{ ip = $Ip; port = $Port; rttMs = [int]$sw.ElapsedMilliseconds } -Trace $Trace -Src $Src
    } finally { if ($tcp) { $tcp.Dispose() } }
}
function Test-RdpTelescopeX224Confirm {
    # [F37 §1] ONE implementation of the RESPONSE layout (TPKT already trimmed:
    # X.224 connection confirm is 7 bytes - LI, 0xD0, dst-ref(2), src-ref(2),
    # class - and the RDP_NEG_RSP follows: type=0x02, flags, length=0x0008
    # LITTLE-ENDIAN, selectedProtocol(4). Byte offsets are the whole point: an
    # off-by-one here reads "did not select TLS" from a healthy listener, which
    # is exactly how a red cell hid a working handshake.
    param([Parameter(Mandatory)][byte[]]$Response)
    if ($Response.Length -lt 15) { throw ('X.224 response too short: ' + $Response.Length) }
    if ($Response[1] -ne 0xd0) { throw 'X.224 is not a connection confirm' }
    if ($Response[7] -ne 2 -or $Response[9] -ne 8 -or $Response[10] -ne 0) { throw 'RDP negotiation did not select TLS' }
    $selected = [BitConverter]::ToUInt32($Response, 11)
    if ($selected -ne 1 -and $selected -ne 2 -and $selected -ne 8) { throw ('RDP selected non-TLS protocol ' + $selected) }
    return $selected
}
function Get-RdpTelescopeX224Request {
    return ,([byte[]](0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00))
}
function Add-RdpTelescopeTlsShim {
    # [F37 §1] A PowerShell SCRIPTBLOCK cannot be the certificate callback: the
    # handshake completes on a threadpool thread that has no runspace
    # ("There is no Runspace available to run scripts in this thread"), the task
    # faults and the probe reports a FALSE rst-before-cert - exactly what the lab
    # showed while the listener itself was healthy. ONE compiled delegate (C# 5,
    # in-box compiler) records the served certificate and the validation errors
    # for the caller and ALWAYS accepts: read-only, never trusted or installed.
    if ('GhrdpTelTls' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class GhrdpTelTls {
    public static byte[] ServedRaw;
    public static string ServedThumb = "";
    public static string ChainStatus = "";
    public static bool ChainOk;
    public static int Errors;
    public static void Reset() { ServedRaw = null; ServedThumb = ""; ChainStatus = ""; ChainOk = false; Errors = 0; }
    public static bool Accept(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors) {
        try {
            if (cert != null) {
                ServedRaw = cert.GetRawCertData();
                string t = cert.GetCertHashString();
                ServedThumb = (t == null) ? "" : t.ToUpperInvariant();
            }
        } catch { }
        try {
            if (chain != null) {
                System.Text.StringBuilder sb = new System.Text.StringBuilder();
                foreach (X509ChainStatus s in chain.ChainStatus) {
                    if (sb.Length > 0) { sb.Append('|'); }
                    sb.Append(s.Status.ToString());
                }
                ChainStatus = sb.ToString();
            }
        } catch { }
        Errors = (int)errors;
        ChainOk = (errors == SslPolicyErrors.None);
        return true;
    }
    public static RemoteCertificateValidationCallback Callback() { return new RemoteCertificateValidationCallback(Accept); }
}
'@
}
function Test-RdpTelescopeCertServerAuth {
    # ServerAuth EKU check, shared by the client probe (tls stage) and the runner
    # probe (listener stage). Absent EKU means "any usage" (RFC 5280) - that is
    # not a failure on its own; a PRESENT EKU without serverAuth is.
    param([Parameter(Mandatory)]$Certificate)
    $oids = @()
    try {
        foreach ($ext in @($Certificate.Extensions)) {
            if ($ext.Oid -and $ext.Oid.Value -eq '2.5.29.37') {
                foreach ($line in @(([string]$ext.Format($false)) -split "[`r`n,]+")) {
                    $t = $line.Trim()
                    if ($t -match '^\d+(\.\d+)+$') { $oids += $t }
                }
            }
        }
        if ($oids.Count -eq 0) {
            $ekuExt = @($Certificate.Extensions | Where-Object { $_.Oid -and $_.Oid.Value -eq '2.5.29.37' } | Select-Object -First 1)
            if ($ekuExt.Count -gt 0) {
                $ekuObj = New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($ekuExt[0], $false)
                $oids = @($ekuObj.EnhancedKeyUsages | ForEach-Object { [string]$_.Value })
            }
        }
    } catch { }
    $has = [bool](@($oids | Where-Object { $_ -eq '1.3.6.1.5.5.7.3.1' }).Count -gt 0)
    return [pscustomobject]@{ eku = $oids; ekuText = ($oids -join '|'); hasServerAuth = $has; ekuAbsent = [bool]($oids.Count -eq 0) }
}
function Get-RdpTelescopeTls {
    # stage x224+tls: negotiate X.224, then read what the listener SERVES.
    # The validation callback is PERMISSIVE (returns true) so the certificate is
    # READ even when the chain fails - it is never trusted, installed or used.
    # (The launcher's TelTls uses the same documented permissive/read-only
    # callback, so both client and runner classify the SAME failure points.)
    # failureAt distinguishes rst-before-cert (no certificate was ever
    # presented: Schannel refused the key) from chain/name/EKU rejects.
    param(
        [Parameter(Mandatory)][string]$Fqdn,
        [string]$Ip = '127.0.0.1',
        [int]$Port = 3389,
        [int]$TimeoutMs = 7000,
        [string]$ExpectedThumb = '',
        [string]$Trace = '',
        [string]$Src = ''
    )
    $tcp = $null; $ssl = $null
    $fields = @{ servedThumb = ''; chainStatus = @(); chainOk = $false; nameMatch = $false; nameServed = ''; serverAuth = $false; eku = ''; protocol = ''; cipher = ''; cipherStrength = 0; failureAt = ''; expectedThumb = $ExpectedThumb }
    $script:F37TelCert = $null
    $script:F37TelErrors = $null
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $connect = $tcp.ConnectAsync($Ip, $Port)
        if (-not $connect.Wait($TimeoutMs)) { throw 'TCP connect timeout' }
        $tcp.ReceiveTimeout = $TimeoutMs; $tcp.SendTimeout = $TimeoutMs
        $stream = $tcp.GetStream()
        [byte[]]$request = Get-RdpTelescopeX224Request
        $stream.Write($request, 0, $request.Length)
        $header = [byte[]]::new(4); $got = 0
        while ($got -lt 4) {
            $n = $stream.Read($header, $got, 4 - $got)
            if ($n -le 0) { throw 'X.224 connection reset/EOF before TLS' }
            $got += $n
        }
        if ($header[0] -ne 3 -or $header[1] -ne 0) { throw 'invalid TPKT header' }
        $length = ([int]$header[2] -shl 8) -bor [int]$header[3]
        if ($length -lt 19 -or $length -gt 1024) { throw ('invalid X.224 length ' + $length) }
        $response = [byte[]]::new($length - 4); $got = 0
        while ($got -lt $response.Length) {
            $n = $stream.Read($response, $got, $response.Length - $got)
            if ($n -le 0) { throw 'X.224 connection reset/EOF in negotiation' }
            $got += $n
        }
        $protocol = Test-RdpTelescopeX224Confirm -Response $response
        # PERMISSIVE on purpose: read, never trust (no install, no override) -
        # through the COMPILED delegate, because a scriptblock cannot run on the
        # threadpool thread that completes the handshake.
        Add-RdpTelescopeTlsShim
        [GhrdpTelTls]::Reset()
        $callback = [GhrdpTelTls]::Callback()
        $ssl = [System.Net.Security.SslStream]::new($stream, $false, $callback)
        $task = $ssl.AuthenticateAsClientAsync($Fqdn)
        if (-not $task.Wait($TimeoutMs)) { throw 'TLS handshake timeout' }
        if (-not $ssl.IsAuthenticated) { throw 'TLS stream did not authenticate' }
        $fields.protocol = [string]$ssl.SslProtocol
        try { $fields.cipher = [string]$ssl.NegotiatedCipherSuite } catch { }
        if (-not $fields.cipher) { $fields.cipher = [string]$ssl.CipherAlgorithm }
        try { $fields.cipherStrength = [int]$ssl.CipherStrength } catch { }
        if ([GhrdpTelTls]::ServedRaw) {
            try { $script:F37TelCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]][GhrdpTelTls]::ServedRaw) } catch { }
        }
        $cert = $script:F37TelCert
        if (-not $cert) {
            $fields.failureAt = 'rst-before-cert'
            return New-RdpTelescopeLine -Stage 'tls' -Ok $false -Why 'TLS completed without a certificate (protocol/name mismatch class)' -Fields $fields -Trace $Trace -Src $Src
        }
        $fields.servedThumb = $cert.GetCertHashString().ToUpperInvariant()
        try {
            $chain2 = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
            $chain2.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
            $built = $chain2.Build($cert)
            $statuses = @($chain2.ChainStatus | ForEach-Object { [string]$_.Status })
            $chain2.Dispose()
            $fields.chainOk = [bool]$built
            if ($statuses.Count -eq 0 -and [string][GhrdpTelTls]::ChainStatus) { $statuses = @(([string][GhrdpTelTls]::ChainStatus) -split '\|') }
            $fields.chainStatus = $(if ($statuses.Count) { $statuses } else { @('(no status)') })
        } catch {
            $fields.chainOk = $false
            $fields.chainStatus = @('chain-eval-failed: ' + $_.Exception.Message)
        }
        $names = @()
        try { $names += [string]$cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false) } catch { }
        foreach ($ext in @($cert.Extensions)) {
            if ($ext.Oid -and $ext.Oid.Value -eq '2.5.29.17') { $names += [string]$ext.Format($false) }
        }
        $fields.nameServed = ($names | Where-Object { $_ } | Select-Object -First 1)
        $fields.nameMatch = $false
        foreach ($n in @($names)) { if ($n -and $n -match [regex]::Escape($Fqdn)) { $fields.nameMatch = $true } }
        $ekuInfo = Test-RdpTelescopeCertServerAuth -Certificate $cert
        $fields.eku = [string]$ekuInfo.ekuText
        $fields.serverAuth = [bool]$ekuInfo.hasServerAuth
        if ($ExpectedThumb -and $fields.servedThumb -ne $ExpectedThumb.ToUpperInvariant()) {
            $fields.failureAt = 'served!=bound'
            return New-RdpTelescopeLine -Stage 'tls' -Ok $false -Why ('served certificate ' + $fields.servedThumb + ' != bound ' + $ExpectedThumb.ToUpperInvariant()) -Fields $fields -Trace $Trace -Src $Src
        }
        if (-not $fields.serverAuth) {
            $fields.failureAt = 'eku'
            return New-RdpTelescopeLine -Stage 'tls' -Ok $false -Why ('EKU lacks Server Authentication (' + $fields.eku + ')') -Fields $fields -Trace $Trace -Src $Src
        }
        if (-not $fields.chainOk) {
            $fields.failureAt = ('chain=' + (($fields.chainStatus) -join '|'))
            return New-RdpTelescopeLine -Stage 'tls' -Ok $false -Why ('chain: ' + (($fields.chainStatus) -join '|')) -Fields $fields -Trace $Trace -Src $Src
        }
        if (-not $fields.nameMatch) {
            $fields.failureAt = 'name-mismatch'
            return New-RdpTelescopeLine -Stage 'tls' -Ok $false -Why ('certificate does not cover ' + $Fqdn) -Fields $fields -Trace $Trace -Src $Src
        }
        return New-RdpTelescopeLine -Stage 'tls' -Ok $true -Fields $fields -Trace $Trace -Src $Src
    } catch {
        $msg = $_.Exception.Message
        if (-not $script:F37TelCert) {
            $fields.failureAt = 'rst-before-cert'
            $why = 'server reset before presenting a certificate (' + $msg + '): Schannel refused the listener key/cert (ACL, EKU or no bind)'
        } else {
            $fields.servedThumb = $script:F37TelCert.GetCertHashString().ToUpperInvariant()
            if (-not $fields.failureAt) { $fields.failureAt = 'handshake-aborted' }
            $why = $msg
        }
        return New-RdpTelescopeLine -Stage 'tls' -Ok $false -Why $why -Fields $fields -Trace $Trace -Src $Src
    } finally {
        if ($ssl) { $ssl.Dispose() }
        if ($tcp) { $tcp.Dispose() }
    }
}
function Get-RdpTelescopeCredReadback {
    # stage cred: does THIS machine hold a stored target for the listener, what
    # TYPE is it and for WHICH user. cmdkey /list prints metadata only - this
    # function never requests, parses or logs a credential blob.
    # [F37 §4] -Informational is the RUNNER FACE: the host that SERVES the
    # listener is not the client, so "no stored TERMSRV target here" is a fact
    # about scope, not a fault on the path. Without it every live runner sample
    # was permanently red (deathPoint=credssp) on a healthy listener - a false
    # death point is worse than no telescope. The CLIENT telescope (launcher
    # verb diag) still reports telescope-cred-missing as a real death point.
    param([Parameter(Mandatory)][string]$Fqdn, [string]$User = '', [string]$Trace = '', [string]$Src = '', [switch]$Informational)
    $target = 'TERMSRV/' + $Fqdn
    $type = ''; $user = $User; $exists = $false
    try {
        $lines = @(cmdkey.exe /list:$target 2>&1 | ForEach-Object { [string]$_ })
        foreach ($l in $lines) {
            if ($l -match '(?i)^\s*Target:\s*(.+?)\s*$' -and $Matches[1] -match [regex]::Escape($target)) { $exists = $true }
            if ($l -match '(?i)^\s*Type:\s*(.+?)\s*$') { $type = ($Matches[1] -replace '\s+', '') }
            if ($l -match '(?i)^\s*User:\s*(.+?)\s*$') { $user = $Matches[1] }
        }
        if ($type -match '(?i)generic|domain') { } elseif ($exists) { $type = 'unknown' }
        if (-not $exists -and $Informational) {
            return New-RdpTelescopeLine -Stage 'cred' -Ok $true -Why ('runner face: no stored TERMSRV target here (client-owned stage; the client telescope reports telescope-cred-missing) target=' + $target) -Fields @{ credTarget = $target; credExists = $false; credType = $type; credUser = $user } -Trace $Trace -Src $Src
        }
        return New-RdpTelescopeLine -Stage 'cred' -Ok ([bool]$exists) -Why $(if ($exists) { '' } else { 'no stored target for ' + $target }) -Fields @{ credTarget = $target; credExists = [bool]$exists; credType = $type; credUser = $user } -Trace $Trace -Src $Src
    } catch {
        # A read-back FAULT is named on both faces, but only the CLIENT face may
        # go red for it: on the runner this stage is out of scope, and cmdkey
        # writing to stderr must not be able to paint a healthy listener red.
        if ($Informational) {
            return New-RdpTelescopeLine -Stage 'cred' -Ok $true -Why ('runner face: credential read-back unavailable (' + $_.Exception.Message + ') - client-owned stage') -Fields @{ credTarget = $target; credExists = $false; credType = $type; credUser = $user } -Trace $Trace -Src $Src
        }
        return New-RdpTelescopeLine -Stage 'cred' -Ok $false -Why ('credential read-back failed: ' + $_.Exception.Message) -Fields @{ credTarget = $target; credExists = $false; credType = $type; credUser = $user } -Trace $Trace -Src $Src
    }
}
function Get-RdpTelescopeLogon {
    # stage logon: the last interactive-RDP 4624 (type 10) / 4625 and its
    # SubStatus. Reads ONLY ids, codes and timestamps - never a password.
    param([int]$WindowSec = 3600, [string]$Trace = '', [string]$Src = '')
    $id = ''; $type = ''; $sub = ''; $ts = ''; $c24 = 0; $c25 = 0
    try {
        $since = (Get-Date).AddSeconds(-1 * $WindowSec)
        $events = @()
        try {
            $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(4624, 4625); StartTime = $since } -MaxEvents 40 -ErrorAction Stop)
        } catch {
            # An empty window is a named verdict ("no 4624 in window"), not an error.
            if (($_.Exception.Message -notmatch '(?i)no events') -and ($_.Exception.Message -notmatch '(?i)not found')) { throw }
        }
        $newestReject = $false
        $newestTs = $null
        foreach ($ev in $events) {
            $xml = [xml]$ev.ToXml()
            $lt = ''
            foreach ($d in @($xml.SelectNodes("//*[local-name()='Data']"))) {
                if ([string]$d.GetAttribute('Name') -eq 'LogonType') { $lt = [string]$d.InnerText }
                if ([string]$d.GetAttribute('Name') -eq 'SubStatus') { $sub = [string]$d.InnerText }
            }
            if ([string]$ev.Id -eq '4624') { if ($lt -eq '10') { $c24++ } } else { $c25++ }
            if ($lt -eq '10' -and -not $ts) {
                $id = [string]$ev.Id; $type = $lt; $ts = $ev.TimeCreated.ToUniversalTime().ToString('o')
            }
            # Get-WinEvent returns newest-first: the FIRST record decides whether
            # the last word in the window was a rejection.
            if ($null -eq $newestTs) { $newestTs = $ev.TimeCreated; $newestReject = ([string]$ev.Id -eq '4625') }
        }
        # [F37 §4] "no logon in the window" is INFORMATIONAL on the runner face:
        # a host nobody has logged into is not a broken path, and painting it red
        # made every healthy runner sample carry deathPoint=logon. The fault this
        # stage owns is a REJECTION (the newest event is a 4625) or a log that
        # cannot be read at all - both stay red and both name themselves.
        $okL = [bool](-not $newestReject)
        $whyL = $(if ($id -eq '4624') { '' } elseif ($newestReject) { ('RDP logon rejected: newest event is a 4625 (sub=' + $sub + ')') } else { ('no 4624 logon type 10 in the last ' + $WindowSec + 's (informational: nobody has logged on yet)') })
        return New-RdpTelescopeLine -Stage 'logon' -Ok $okL -Why $whyL -Fields @{ eventId = $id; logonType = $type; sub = $sub; eventTs = $ts; count4624 = $c24; count4625 = $c25 } -Trace $Trace -Src $Src
    } catch {
        return New-RdpTelescopeLine -Stage 'logon' -Ok $false -Why ('Security log unreadable: ' + $_.Exception.Message) -Fields @{ eventId = $id; logonType = $type; sub = $sub; eventTs = $ts; count4624 = $c24; count4625 = $c25 } -Trace $Trace -Src $Src
    }
}
function Get-RdpTelescopeSchannel {
    # stage schannel: the Schannel verdict tail that NAMES a refused handshake:
    # 36870 (fatal alert, often the key ACL), 36871 (internal error), 36888
    # (generated fatal alert), 12018 (TLS fatal alert received/sent).
    param([int]$SinceSec = 3600, [string]$Trace = '', [string]$Src = '')
    $ids = @(); $lastId = ''; $lastTs = ''; $why = ''
    try {
        $since = (Get-Date).AddSeconds(-1 * $SinceSec)
        $events = @()
        try {
            $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = @(36870, 36871, 36888, 12018); StartTime = $since } -MaxEvents 20 -ErrorAction Stop)
        } catch {
            # "No events were found" is the QUIET, good case - never a probe error.
            if (($_.Exception.Message -notmatch '(?i)no events') -and ($_.Exception.Message -notmatch '(?i)not found')) { throw }
        }
        foreach ($ev in $events) {
            $ids += [string]$ev.Id
            if (-not $lastTs) {
                $lastId = [string]$ev.Id
                $lastTs = $ev.TimeCreated.ToUniversalTime().ToString('o')
                $why = ([string]$ev.Message -split "[`r`n]+")[0]
            }
        }
        if ($why.Length -gt 160) { $why = $why.Substring(0, 160) }
        return New-RdpTelescopeLine -Stage 'schannel' -Ok ($ids.Count -eq 0) -Why $(if ($ids.Count) { 'Schannel refusal events present: ' + ($ids -join ',') } else { '' }) -Fields @{ schannelIds = $ids; lastSchannelId = $lastId; lastSchannelTs = $lastTs; schannelWhy = $why; sinceSec = $SinceSec } -Trace $Trace -Src $Src
    } catch {
        return New-RdpTelescopeLine -Stage 'schannel' -Ok $false -Why ('System Schannel log unavailable: ' + $_.Exception.Message) -Fields @{ schannelIds = @(); lastSchannelId = ''; lastSchannelTs = ''; schannelWhy = ''; sinceSec = $SinceSec } -Trace $Trace -Src $Src
    }
}
$script:F37TelTypesReady = $false
function Initialize-RdpTelescopeCryptoTypes {
    # [F37 §4] WINDOWS POWERSHELL 5.1 (.NET Framework) does NOT load
    # System.Security.Cryptography.X509Certificates / .Cng by default, so
    # RSACertificateExtensions is a TypeNotFound THERE - and the live runner is
    # the ONE surface that always runs under 5.1 (ghrdp-server.ps1 is started
    # with powershell.exe). The resolver then degraded every runner sample to
    # "key file not found / ACL absent" while the listener was healthy: a red
    # row that named nothing. Load the assemblies once, on both runtimes, and
    # SAY which loader worked so a future degradation names itself.
    if ($script:F37TelTypesReady) { return $script:F37TelTypesReady }
    $loaded = @()
    foreach ($a in @('System.Security.Cryptography.X509Certificates', 'System.Security.Cryptography.Cng', 'System.Security')) {
        try { $null = [System.Reflection.Assembly]::LoadWithPartialName($a); $loaded += ($a + ':partial') } catch { }
        try { Add-Type -AssemblyName $a -ErrorAction SilentlyContinue; $loaded += ($a + ':addtype') } catch { }
    }
    $script:F37TelTypesLoader = ($loaded -join ',')
    try {
        $null = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]
        $script:F37TelTypesReady = 'extensions-resolved'
    } catch {
        $script:F37TelTypesReady = ('extensions-unresolved: ' + $_.Exception.Message)
    }
    return $script:F37TelTypesReady
}
function Resolve-RdpTelescopeKeyFile {
    # WHERE is the persisted private-key file? A provider-reported container name
    # is NOT proof that a file exists in the first directory you try: Windows has
    # the CNG store (Crypto\Keys), the CAPI store (Crypto\RSA\MachineKeys) and
    # per-user variants, and the lab died exactly there (Schannel 36870 /
    # 0x8009030D on one side, "key file missing" on the other). This resolver
    # reports every candidate, which ones exist, any near-miss hit, and a bounded
    # listing of each store - so the environment explains itself next time.
    param([Parameter(Mandatory)]$Certificate)
    $out = [ordered]@{ name = ''; kind = ''; provider = ''; candidates = @(); found = ''; hits = @(); dirSample = @(); roots = @(); pathSource = ''; typedError = ''; typesLoader = '' }
    # 5.1 first: without the extension assemblies the typed path below cannot run.
    try { $out.typesLoader = [string](Initialize-RdpTelescopeCryptoTypes) } catch { $out.typesLoader = ('loader-threw: ' + $_.Exception.Message) }
    $key = $null
    try {
        $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
        if (-not $key) { $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($Certificate) }
        if (-not $key) { $out.kind = 'no-key'; return [pscustomobject]$out }
        if ($key -is [System.Security.Cryptography.RSACng] -or $key -is [System.Security.Cryptography.ECDsaCng]) {
            $out.kind = 'cng'
            try { $out.provider = [string]$key.Key.Provider.Provider } catch { }
            $out.name = [string]$key.Key.UniqueName
        } elseif ($key -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
            $out.kind = 'capi'
            try { $out.provider = [string]$key.CspKeyContainerInfo.ProviderName } catch { }
            $out.name = [string]$key.CspKeyContainerInfo.UniqueKeyContainerName
        } else { $out.kind = ('unsupported:' + $key.GetType().Name) }
    } catch { $out.kind = ('error:' + $_.Exception.Message); $out.typedError = [string]$_.Exception.Message } finally { if ($key) { $key.Dispose() } }
    # [F37 §4] CERTUTIL FALLBACK: when the typed provider path is unavailable
    # (5.1 without the extension assemblies, an unsupported provider) the
    # container name is still a FACT on the box - certutil prints it. Using it
    # keeps the live runner's ACL evidence alive instead of degrading to
    # "key file not found" with no name for the cause.
    if (-not $out.name) {
        try {
            $cuName = ''
            foreach ($l in @(certutil.exe -store -v My $Certificate.Thumbprint 2>&1 | ForEach-Object { [string]$_ })) {
                if ($l -match '(?i)^\s*Key Container\s*=\s*(.+?)\s*$') { $cuName = $Matches[1]; break }
                if ($l -match '(?i)^\s*Unique container name:\s*(.+?)\s*$') { $cuName = $Matches[1]; break }
            }
            if ($cuName) { $out.name = $cuName; if (-not $out.kind) { $out.kind = 'certutil' } }
        } catch { $out.typedError = ([string]$out.typedError + ' certutil: ' + $_.Exception.Message).Trim() }
    }
    if (-not $out.name -or $out.name -match '[\\/]') { return [pscustomobject]$out }
    $roots = @(
        (Join-Path $env:ProgramData 'Microsoft\Crypto\Keys'),
        (Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys'),
        (Join-Path $env:APPDATA 'Microsoft\Crypto\Keys'),
        (Join-Path $env:APPDATA 'Microsoft\Crypto\RSA\MachineKeys')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
    $out.roots = @($roots)
    foreach ($r in @($roots)) { $out.candidates += (Join-Path $r $out.name) }
    foreach ($c in @($out.candidates)) { if ((-not $out.found) -and (Test-Path -LiteralPath $c -PathType Leaf)) { $out.found = $c } }
    # A provider name is a CLAIM; the file is the fact. Some runtimes report the
    # container with a trailing _GUID while the store holds the bare 32-hex stem
    # (and vice versa) - so when no exact candidate exists, accept a UNIQUE
    # stem match and say so, instead of reporting "not found" while Schannel
    # fails with 0x8009030D on the very same key.
    $stem = [string]($out.name -split '_')[0]
    if (-not $out.found) {
        foreach ($r in @($roots)) {
            try {
                foreach ($f in @(Get-ChildItem -LiteralPath $r -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $out.name -or ($stem.Length -ge 8 -and $_.Name -like ($stem + '*')) } | Select-Object -First 4)) {
                    $out.hits += $f.FullName
                }
            } catch { }
        }
        if (@($out.hits).Count -eq 1) { $out.found = [string](@($out.hits)[0]); $out.pathSource = 'stem-hit' }
        elseif (@($out.hits).Count -gt 1) { $out.pathSource = 'ambiguous-stem-hit' }
        else { $out.pathSource = 'none' }
    } else { $out.pathSource = $(if ($out.kind -eq 'certutil') { 'certutil-candidate' } else { 'candidate' }) }
    foreach ($r in @($roots)) {
        try {
            $names = @(Get-ChildItem -LiteralPath $r -File -ErrorAction SilentlyContinue | Select-Object -First 6 | ForEach-Object { $_.Name })
            $out.dirSample += ([string]$r + ' :: ' + ($names -join ','))
        } catch { }
    }
    return [pscustomobject]$out
}
function Get-RdpTelescopeListener {
    # stage listener: BIND EFFECTIVENESS - boundThumb vs servedThumb, the store
    # entry, HasPrivateKey, the persisted container, its ACL SIDs and the
    # certutil container readback. This is the stage that makes the lab's
    # former red-without-why cell impossible.
    param(
        [string]$ExpectedThumb = '',
        [string]$ServedThumb = '',
        [string]$KeyFile = '',
        [string]$Trace = '',
        [string]$Src = ''
    )
    $fields = @{ boundThumb = ''; servedThumb = $ServedThumb; inStore = $false; hasKey = $false; container = ''; containerKind = ''; containerPath = ''; keyFilePathSource = ''; keyFileFound = $false; keyFileCandidates = @(); keyDirHits = @(); keyDirSample = @(); keyTypedError = ''; typesLoader = ''; certutilContainer = ''; aclSids = @(); aclRead = $false; aclOk = $false; serving = $false; hasServerAuth = $false; eku = @(); san = @() }
    $why = @()
    try {
        $rdpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
        $boundHex = ''
        try {
            $bound = (Get-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash' -ErrorAction Stop).SSLCertificateSHA1Hash
            $boundHex = ($bound | ForEach-Object { $_.ToString('X2') }) -join ''
        } catch { $why += 'no SSLCertificateSHA1Hash on RDP-Tcp' }
        $fields.boundThumb = $boundHex.ToUpperInvariant()
        $want = $(if ($ExpectedThumb) { $ExpectedThumb.ToUpperInvariant() } else { $boundHex.ToUpperInvariant() })
        if (-not $fields.servedThumb -and $want) { $fields.servedThumb = $want }
        $servedUp = ([string]$fields.servedThumb).ToUpperInvariant()
        $fields.serving = ([bool]$fields.boundThumb -and $fields.boundThumb -eq $servedUp)
        if ($want -and $fields.boundThumb -and $fields.boundThumb -ne $want) { $why += ('bound ' + $fields.boundThumb + ' != expected ' + $want) }
        $cert = $null
        # Resolve the EXPECTED certificate too: before the bind there is nothing
        # in SSLCertificateSHA1Hash, and the whole point of the BEFORE telescope
        # is to prove whether that certificate's key file is where Schannel will
        # look for it.
        $lookupThumb = $(if ($want) { $want } else { $boundHex })
        if ($lookupThumb) {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
            try {
                $store.Open('ReadOnly')
                $cert = @($store.Certificates | Where-Object { $_.Thumbprint -ieq $lookupThumb }) | Select-Object -First 1
            } finally { $store.Close() }
        }
        if (-not $cert) {
            if ($lookupThumb) { $why += ('thumbprint ' + $lookupThumb + ' not present in LocalMachine\My') }
        } else {
            $fields.inStore = $true
            $fields.hasKey = [bool]$cert.HasPrivateKey
            if (-not $fields.hasKey) { $why += 'store entry has NO private key' }
            try {
                $kr = Resolve-RdpTelescopeKeyFile -Certificate $cert
                $fields.container = [string]$kr.name
                $fields.containerKind = [string]$kr.kind
                $fields.keyFileCandidates = @($kr.candidates)
                $fields.keyDirHits = @($kr.hits)
                $fields.keyDirSample = @($kr.dirSample)
                $fields.keyFilePathSource = [string]$kr.pathSource
                $fields.keyTypedError = [string]$kr.typedError
                $fields.typesLoader = [string]$kr.typesLoader
                if ($kr.found) { $fields.containerPath = [string]$kr.found; $fields.keyFileFound = $true }
                elseif (@($fields.keyFileCandidates).Count -gt 0) { $fields.containerPath = [string](@($fields.keyFileCandidates)[0]) }
                if ($fields.keyFileFound) { }
                elseif ($fields.containerPath) {
                    $why += ('persisted key file NOT FOUND (name=' + $fields.container + ' kind=' + $fields.containerKind + ' tried=[' + (@($fields.keyFileCandidates) -join ',') + '] hits=[' + (@($fields.keyDirHits) -join ',') + '] source=' + $fields.keyFilePathSource + ' typedError=' + $fields.keyTypedError + ' typesLoader=' + $fields.typesLoader + ' stores=[' + (@($fields.keyDirSample) -join ' | ') + ']')
                }
            } catch { $why += ('key container resolution failed: ' + $_.Exception.Message) }
            if (-not $fields.container) { $why += 'no persisted key container name' }
            # The certificate's own acceptance: without the ServerAuth EKU
            # Schannel resets the connection BEFORE presenting it, and without a
            # SAN naming the FQDN the client fails the name check. Both are
            # named here, because the handshake cannot say either one.
            try {
                $ekuInfoL = Test-RdpTelescopeCertServerAuth -Certificate $cert
                $fields.eku = @($ekuInfoL.eku)
                $fields.hasServerAuth = [bool]$ekuInfoL.hasServerAuth
                if (-not $fields.hasServerAuth) { $why += 'bound cert has NO ServerAuth EKU (Schannel resets before presenting it: rst-before-cert)' }
                $sanExt = @($cert.Extensions | Where-Object { $_.Oid -and $_.Oid.Value -eq '2.5.29.17' } | Select-Object -First 1)
                if ($sanExt.Count -gt 0) {
                    $fields.san = @(($sanExt[0].Format($false) -split ',\s*') | ForEach-Object { ([string]$_ -replace '^DNS Name=', '') })
                } else { $why += 'bound cert has NO subject alternative name (name-mismatch on every client)' }
            } catch { $why += ('EKU/SAN read failed: ' + $_.Exception.Message) }
            try {
                $cu = @(certutil.exe -store -v My $lookupThumb 2>&1 | ForEach-Object { [string]$_ })
                foreach ($l in $cu) { if ($l -match '(?i)container') { $fields.certutilContainer = $l.Trim(); break } }
            } catch { $fields.certutilContainer = '' }
        }
        $kf = $KeyFile
        if (-not $kf -and $fields.containerPath) { $kf = $fields.containerPath }
        if ($kf -and (Test-Path -LiteralPath $kf -PathType Leaf)) {
            try {
                $acl = Get-Acl -LiteralPath $kf -ErrorAction Stop
                $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
                $fields.aclSids = @($rules | ForEach-Object { ([string]$_.IdentityReference.Value) + ':' + ([string]$_.FileSystemRights) + ':' + ([string]$_.AccessControlType) })
                $fields.aclRead = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-20' -and $_.AccessControlType -eq 'Allow' -and (($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Read) -eq [System.Security.AccessControl.FileSystemRights]::Read) }).Count -gt 0
                $fields.aclOk = $fields.aclRead
            } catch { $why += ('key ACL unreadable: ' + $_.Exception.Message) }
        } elseif ($kf) {
            $why += ('persisted key file missing: ' + $kf)
        }
        if (-not $fields.aclOk) { $why += 'NETWORK SERVICE (S-1-5-20) Read ACE absent or unverified' }
        if (-not $fields.serving) { $why += ('served ' + $fields.servedThumb + ' != bound ' + $fields.boundThumb) }
        $ok = ($fields.inStore -and $fields.hasKey -and $fields.hasServerAuth -and $fields.aclOk -and $fields.serving)
        return New-RdpTelescopeLine -Stage 'listener' -Ok $ok -Why ($why -join '; ') -Fields $fields -Trace $Trace -Src $Src
    } catch {
        return New-RdpTelescopeLine -Stage 'listener' -Ok $false -Why ('listener probe failed: ' + $_.Exception.Message) -Fields $fields -Trace $Trace -Src $Src
    }
}
function Get-RdpTelescopeFields {
    # The DERIVED fields every consumer needs (config stamp, SERVER CONN LOG
    # row, timeline): boundThumb vs servedThumb (bind drift), serving, the key
    # container + its ACL SIDs, the Schannel tail and the death point. ONE
    # implementation - the workflow stamp and the server tick both call THIS, so
    # the two surfaces can never drift apart.
    param([Parameter(Mandatory)]$Telescope)
    $out = [ordered]@{
        boundThumb = ''; servedThumb = ''; serving = $false; bindDrift = $false
        inStore = $false; hasKey = $false; container = ''; aclRead = $false; aclOk = $false
        hasServerAuth = $false; eku = @(); san = @()
        keyFileFound = $false; containerKind = ''; keyDirHits = @(); keyDirSample = @(); keyFilePathSource = ''
        containerPath = ''; keyTypedError = ''; typesLoader = ''
        aclSids = @(); schannelTail = @(); schannelWhy = ''
        protocol = ''; cipher = ''; failureAt = ''; tlsWhy = ''; listenerWhy = ''
        logonEventId = ''; logonSub = ''; count4624 = 0; count4625 = 0; logonWhy = ''
        # [F37 §4] redStages/fatalStages: WHICH stage is red, in the module's own
        # vocabulary, so a consumer never has to re-parse lines (and can never
        # invent a second format). fatalStages are the listener-face stages - the
        # only ones that mean "the path this host serves is broken"; schannel and
        # an informational logon/cred line are EVIDENCE, not a fatal verdict.
        redStages = @(); fatalStages = @(); deriveError = ''
        deathPoint = [string]$Telescope.deathPoint
        trace = [string]$Telescope.trace
        src = [string]$Telescope.src
    }
    # Never throw: a derivation fault must itself be a NAMED field, because a
    # silently empty derivation is exactly the red-without-why class F37 kills.
    try {
    foreach ($l in @($Telescope.lines)) {
        $o = $l
        if ($l -is [string]) { try { $o = ($l | ConvertFrom-Json) } catch { continue } }
        if (-not $o -or -not $o.stage) { continue }
        switch ([string]$o.stage) {
            'tls' {
                if ($o.PSObject.Properties['servedThumb'] -and $o.servedThumb) { $out.servedThumb = [string]$o.servedThumb }
                if ($o.PSObject.Properties['failureAt']) { $out.failureAt = [string]$o.failureAt }
                if ($o.PSObject.Properties['protocol']) { $out.protocol = [string]$o.protocol }
                if ($o.PSObject.Properties['cipher']) { $out.cipher = [string]$o.cipher }
                if ($o.PSObject.Properties['why']) { $out.tlsWhy = [string]$o.why }
            }
            'listener' {
                if ($o.PSObject.Properties['boundThumb']) { $out.boundThumb = [string]$o.boundThumb }
                if ($o.PSObject.Properties['serving']) { $out.serving = [bool]$o.serving }
                if ($o.PSObject.Properties['inStore']) { $out.inStore = [bool]$o.inStore }
                if ($o.PSObject.Properties['hasKey']) { $out.hasKey = [bool]$o.hasKey }
                if ($o.PSObject.Properties['container']) { $out.container = [string]$o.container }
                if ($o.PSObject.Properties['aclRead']) { $out.aclRead = [bool]$o.aclRead }
                if ($o.PSObject.Properties['hasServerAuth']) { $out.hasServerAuth = [bool]$o.hasServerAuth }
                if ($o.PSObject.Properties['keyFileFound']) { $out.keyFileFound = [bool]$o.keyFileFound }
                if ($o.PSObject.Properties['containerKind']) { $out.containerKind = [string]$o.containerKind }
                if ($o.PSObject.Properties['keyFilePathSource']) { $out.keyFilePathSource = [string]$o.keyFilePathSource }
                if ($o.PSObject.Properties['keyDirHits']) { $out.keyDirHits = @($o.keyDirHits) }
                if ($o.PSObject.Properties['keyDirSample']) { $out.keyDirSample = @($o.keyDirSample) }
                if ($o.PSObject.Properties['eku']) { $out.eku = @($o.eku) }
                if ($o.PSObject.Properties['san']) { $out.san = @($o.san) }
                if ($o.PSObject.Properties['aclSids']) { $out.aclSids = @($o.aclSids) }
                if ($o.PSObject.Properties['aclOk']) { $out.aclOk = [bool]$o.aclOk }
                if ($o.PSObject.Properties['containerPath']) { $out.containerPath = [string]$o.containerPath }
                if ($o.PSObject.Properties['keyTypedError']) { $out.keyTypedError = [string]$o.keyTypedError }
                if ($o.PSObject.Properties['typesLoader']) { $out.typesLoader = [string]$o.typesLoader }
                if ($o.PSObject.Properties['why']) { $out.listenerWhy = [string]$o.why }
            }
            'schannel' {
                if ($o.PSObject.Properties['schannelIds']) { $out.schannelTail = @($o.schannelIds) }
                if ($o.PSObject.Properties['schannelWhy']) { $out.schannelWhy = [string]$o.schannelWhy }
            }
            'logon' {
                if ($o.PSObject.Properties['eventId']) { $out.logonEventId = [string]$o.eventId }
                if ($o.PSObject.Properties['sub']) { $out.logonSub = [string]$o.sub }
                if ($o.PSObject.Properties['count4624']) { $out.count4624 = [int]$o.count4624 }
                if ($o.PSObject.Properties['count4625']) { $out.count4625 = [int]$o.count4625 }
                if ($o.PSObject.Properties['why']) { $out.logonWhy = [string]$o.why }
            }
        }
    }
    foreach ($l in @($Telescope.lines)) {
        $r = $l
        if ($l -is [string]) { try { $r = ($l | ConvertFrom-Json) } catch { continue } }
        if (-not $r -or -not $r.stage) { continue }
        if ([bool]$r.ok) { continue }
        $out.redStages += [string]$r.stage
        if (@('tcp', 'tls', 'listener') -contains [string]$r.stage) { $out.fatalStages += [string]$r.stage }
    }
    } catch {
        $out.deriveError = ('field derivation failed: ' + $_.Exception.Message)
    }
    $out.bindDrift = [bool]($out.boundThumb -and $out.servedThumb -and ($out.boundThumb -ne $out.servedThumb))
    return [pscustomobject]$out
}
function Get-RdpTelescopeStageLine {
    # Select ONE stage's raw JSONL line out of a telescope result. Selection
    # only: the module is still the only writer of the format, so a caller
    # (server tick, workflow stamp, lab) can never invent a line.
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Lines, [Parameter(Mandatory)][string]$Stage)
    foreach ($l in @($Lines)) {
        $o = $null
        try { $o = ($l | ConvertFrom-Json) } catch { continue }
        if ($o -and [string]$o.stage -eq $Stage) { return [string]$l }
    }
    return ''
}
function Get-RdpTelescopeDeathPoint {
    # The FIRST red segment of the path, named in the vocabulary the session
    # maps to a fix: dns|tcp|tls-cert|tls-chain|tls-eku|name-mismatch|credssp|
    # logon|acl. 'none' means every observed stage was green.
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Lines)
    $byStage = @{}
    $tlsFailure = ''
    foreach ($l in @($Lines)) {
        $o = $l
        if ($l -is [string]) { try { $o = ($l | ConvertFrom-Json) } catch { continue } }
        if (-not $o -or -not $o.stage) { continue }
        $byStage[[string]$o.stage] = $o
        if ([string]$o.stage -eq 'tls' -and -not $o.ok) { $tlsFailure = [string]$o.failureAt }
    }
    if ($byStage.ContainsKey('dns') -and -not $byStage['dns'].ok) { return 'dns' }
    if ($byStage.ContainsKey('tcp') -and -not $byStage['tcp'].ok) { return 'tcp' }
    $listenerObj = 0
    if ($byStage.ContainsKey('listener')) { $listenerObj = $byStage['listener'] }
    # A missing ServerAuth EKU is only a CAUSE when a certificate is actually
    # bound/in-store: with NOTHING bound the honest name is tls-cert (the old
    # order reported tls-eku for a listener that had no certificate at all).
    if ($listenerObj -and [bool]$listenerObj.inStore -and $listenerObj.PSObject.Properties['hasServerAuth'] -and -not [bool]$listenerObj.hasServerAuth) { return 'tls-eku' }
    if ($tlsFailure) {
        if ($tlsFailure -eq 'rst-before-cert') { return 'tls-cert' }
        if ($tlsFailure -eq 'name-mismatch') { return 'name-mismatch' }
        if ($tlsFailure -eq 'eku') { return 'tls-eku' }
        if ($tlsFailure -eq 'served!=bound') { return 'tls-cert' }
        return 'tls-chain'
    }
    if ($listenerObj -and $listenerObj.PSObject.Properties['boundThumb'] -and -not [string]$listenerObj.boundThumb) { return 'tls-cert' }
    if ($byStage.ContainsKey('cred') -and -not $byStage['cred'].ok) { return 'credssp' }
    if ($byStage.ContainsKey('listener') -and -not $byStage['listener'].ok) { return 'acl' }
    if ($byStage.ContainsKey('logon') -and -not $byStage['logon'].ok) { return 'logon' }
    return 'none'
}
function Invoke-RdpTelescope {
    # The orchestrator: every stage runs, every stage emits, nothing throws.
    # Client (launcher verb diag), runner (keep-alive/live tick) and lab all call
    # THIS function - the format has exactly one implementation.
    param(
        [Parameter(Mandatory)][string]$Fqdn,
        [string]$User = '',
        [string]$Ip = '',
        [int]$Port = 3389,
        [string]$ExpectedThumb = '',
        [string]$Src = 'live',
        [string]$Trace = '',
        [switch]$SkipLogon,
        [switch]$SkipCred,
        [switch]$Local
    )
    if (-not $Trace) { $Trace = New-RdpTelescopeTraceId -Src $Src }
    $script:F37TelSrc = $Src
    $script:F37TelTrace = $Trace
    $lines = @()
    $target = ''
    if ($Local) {
        # [F37 §4] RUNNER-LOCAL observation: the runner telescopes the LISTENER
        # FACE it serves (loopback), so a bind drift or a refused handshake is
        # reported even while DNS/Tailscale are down. Client-facing DNS is the
        # client telescope's stage, never this one's.
        $target = $(if ($Ip) { $Ip } else { '127.0.0.1' })
        $lines += New-RdpTelescopeLine -Stage 'dns' -Ok $true -Why 'runner-local observation (listener face; DNS is not on this path)' -Fields @{ fqdn = $Fqdn; ip = $target; addresses = @() } -Trace $Trace -Src $Src
    } else {
        $dnsLine = Get-RdpTelescopeDns -Fqdn $Fqdn -Trace $Trace -Src $Src
        $lines += $dnsLine
        $dnsObj = $dnsLine | ConvertFrom-Json
        $target = $(if ($dnsObj.ok) { [string]$dnsObj.ip } elseif ($Ip) { $Ip } else { '' })
    }
    $tcpLine = Get-RdpTelescopeTcp -Ip $target -Port $Port -Trace $Trace -Src $Src
    $lines += $tcpLine
    $tcpObj = $tcpLine | ConvertFrom-Json
    $tlsLine = $null
    if ($tcpObj.ok) {
        $tlsLine = Get-RdpTelescopeTls -Fqdn $Fqdn -Ip $target -Port $Port -ExpectedThumb $ExpectedThumb -Trace $Trace -Src $Src
    } else {
        $tlsLine = New-RdpTelescopeLine -Stage 'tls' -Ok $false -Why 'skipped: TCP never answered' -Fields @{ failureAt = '' } -Trace $Trace -Src $Src
    }
    $lines += $tlsLine
    $tlsObj = $tlsLine | ConvertFrom-Json
    if (-not $SkipCred) { $lines += (Get-RdpTelescopeCredReadback -Fqdn $Fqdn -User $User -Trace $Trace -Src $Src -Informational:$Local) }
    $lines += (Get-RdpTelescopeListener -ExpectedThumb $ExpectedThumb -ServedThumb ([string]$tlsObj.servedThumb) -Trace $Trace -Src $Src)
    $lines += (Get-RdpTelescopeSchannel -Trace $Trace -Src $Src)
    if (-not $SkipLogon) { $lines += (Get-RdpTelescopeLogon -Trace $Trace -Src $Src) }
    $death = Get-RdpTelescopeDeathPoint -Lines $lines
    return New-RdpTelescopeResult -Trace $Trace -Src $Src -Lines $lines -DeathPoint $death
}
function Format-RdpTelescopeDump {
    # EVERY field of EVERY line, one per row: this is what the lab prints into
    # the step summary, so a red cell can never be red-without-why again.
    param([Parameter(Mandatory)]$Telescope)
    $out = @()
    $out += ('[F37] telescope trace=' + [string]$Telescope.trace + ' src=' + [string]$Telescope.src + ' deathPoint=' + [string]$Telescope.deathPoint)
    foreach ($l in @($Telescope.lines)) {
        $o = $l
        if ($l -is [string]) { try { $o = ($l | ConvertFrom-Json) } catch { $out += ('[F37] ' + [string]$l); continue } }
        $parts = @()
        foreach ($p in $o.PSObject.Properties) {
            if ($p.Name -in @('ts', 'trace', 'src', 'stage')) { continue }
            $v = $p.Value
            if ($v -is [array]) { $v = ('[' + (($v | ForEach-Object { [string]$_ }) -join ',') + ']') }
            $parts += ($p.Name + '=' + [string]$v)
        }
        $out += ('[F37] ' + [string]$o.stage + ' ' + ($parts -join ' '))
    }
    return ($out -join "`n")
}
function Write-RdpTelescopeLines {
    # JSONL artifact (one file, appended): the machine-readable trace.
    param([Parameter(Mandatory)]$Telescope, [Parameter(Mandatory)][string]$Path)
    try {
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        foreach ($l in @($Telescope.lines)) { [System.IO.File]::AppendAllText($Path, ([string]$l + "`n")) }
    } catch { Write-Host ('[F37] telescope artifact write failed: ' + $_.Exception.Message) }
}
function Write-RdpTelescopeSummary {
    # Step summary block (lab + live): the diagnosis IS the printed telescope.
    param([Parameter(Mandatory)]$Telescope, [string]$SummaryPath = '', [string]$Title = 'RDP telescope (F37)')
    $dump = Format-RdpTelescopeDump -Telescope $Telescope
    Write-Host $dump
    $path = $SummaryPath
    if (-not $path) { $path = [string]$env:GITHUB_STEP_SUMMARY }
    if (-not $path) { return $dump }
    try {
        ('### ' + $Title + ' - deathPoint=`' + [string]$Telescope.deathPoint + '`') | Add-Content -Path $path
        ('```') | Add-Content -Path $path
        $dump | Add-Content -Path $path
        ('```') | Add-Content -Path $path
    } catch { Write-Host ('[F37] telescope summary write failed: ' + $_.Exception.Message) }
    return $dump
}
function Get-RdpTelescopeBeaconSlug {
    # The client-side vocabulary: ONE slug per stage verdict, shared verbatim
    # with the launcher's diag verb and the server's beacon allowlist.
    param([Parameter(Mandatory)][string]$Stage, [Parameter(Mandatory)][bool]$Ok, [string]$FailureAt = '')
    switch ($Stage) {
        'dns' { return $(if ($Ok) { 'telescope-dns-ok' } else { 'telescope-dns-fail' }) }
        'tcp' { return $(if ($Ok) { 'telescope-tcp-ok' } else { 'telescope-tcp-fail' }) }
        'cred' { return $(if ($Ok) { 'telescope-cred-ok' } else { 'telescope-cred-missing' }) }
        default {
            if ($Ok) { return 'telescope-tls-ok' }
            if ($FailureAt -eq 'rst-before-cert') { return 'telescope-rst-before-cert' }
            if ($FailureAt -eq 'name-mismatch') { return 'telescope-name-mismatch' }
            if ($FailureAt -eq 'eku') { return 'telescope-eku' }
            return 'telescope-chain'
        }
    }
}
