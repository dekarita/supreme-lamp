param(
    [int]$Port = 7331,
    [string]$Bind = '0.0.0.0',
    [string]$Root = 'C:\ghrdp',
    [int]$LimitMinutes = 350
)
$ErrorActionPreference = 'Continue'
$script:CfgPath = Join-Path $Root 'config.json'
$script:ProgPath = Join-Path $Root 'progress.json'
$script:UiPath = Join-Path $Root 'ui.html'
$script:InstPath = Join-Path $Root 'ghrdp-install.ps1'
$script:OkFile = Join-Path $Root 'server-ok.txt'
$script:FlushFlag = Join-Path $Root 'flush.flag'
$script:NoBom = New-Object System.Text.UTF8Encoding($false)
$script:WebDeskHtml = ''
$script:Token = ''
try {
    $tp = Join-Path $Root 'dash-token.txt'
    if (Test-Path -LiteralPath $tp) { $script:Token = ([System.IO.File]::ReadAllText($tp)).Trim() }
} catch { }
$script:RdpTokens = @{}
$script:LauncherSeen = $false
# [F10 s2] telemetry state: dash-token source peer (ping target) + cached
# newest LogonType 10 session age (rdpLogonAgeSec).
$script:DashPeerIp = ''
$script:LogonAge = $null
$script:LogonAgeTs = [datetime]::MinValue
$script:DeviceTokens = @{}
$script:DeviceTokensPath = Join-Path $Root 'device-tokens.json'
$script:ClientAuditLog = Join-Path $Root 'client-audit.log'
$script:AgentPath = Join-Path $Root 'ghrdp-agent.ps1'
$script:DiagDir = Join-Path $Root 'diag-bundles'
try {
    if (Test-Path -LiteralPath $script:DeviceTokensPath) {
        $dt0 = [System.IO.File]::ReadAllText($script:DeviceTokensPath) | ConvertFrom-Json
        if ($dt0) { foreach ($p in $dt0.PSObject.Properties) { $script:DeviceTokens[[string]$p.Name] = @{ deviceId = [string]$p.Value.deviceId; enrolledAt = [string]$p.Value.enrolledAt } } }
    }
} catch { }
function Save-DeviceTokens {
    try {
        $h = @{}
        foreach ($k in $script:DeviceTokens.Keys) { $h[$k] = @{ deviceId = $script:DeviceTokens[$k].deviceId; enrolledAt = $script:DeviceTokens[$k].enrolledAt } }
        [System.IO.File]::WriteAllText($script:DeviceTokensPath, ($h | ConvertTo-Json -Depth 5 -Compress), $script:NoBom)
    } catch { }
}
function Write-ClientAudit {
    param([string]$Line)
    try { [System.IO.File]::AppendAllText($script:ClientAuditLog, ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $Line + "`n")) } catch { }
}
function Get-TailnetIp {
    try {
        $addrs = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())
        foreach ($a in $addrs) {
            if ($a.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
                $ob = $a.GetAddressBytes()
                if ($ob[0] -eq 100 -and $ob[1] -ge 64 -and $ob[1] -le 127) { return $a.ToString() }
            }
        }
    } catch { }
    return '127.0.0.1'
}

function Read-JsonFile {
    param([string]$Path)
    for ($a = 1; $a -le 3; $a++) {
        try {
            if (-not (Test-Path -LiteralPath $Path)) { return $null }
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $ms = New-Object System.IO.MemoryStream
            $fs.CopyTo($ms)
            $fs.Dispose()
            $b = $ms.ToArray()
            $ms.Dispose()
            if ($b.Length -eq 0) { return $null }
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
            $t = [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
            return ($t | ConvertFrom-Json)
        } catch { Start-Sleep -Milliseconds 40 }
    }
    return $null
}
function Get-RequestParts {
    param([string]$Raw)
    $headers = @{}
    $query = @{}
    $lines = @($Raw -split "`r`n")
    $path = '/'
    if ($lines.Count -gt 0 -and $lines[0]) {
        $first = $lines[0].Trim()
        $sp = $first.IndexOf(' ')
        if ($sp -gt 0) {
            $rest = $first.Substring($sp + 1).Trim()
            $target = (@($rest -split ' '))[0]
            $qAt = $target.IndexOf('?')
            if ($qAt -ge 0) {
                $path = $target.Substring(0, $qAt)
                foreach ($kv in ($target.Substring($qAt + 1) -split '&')) {
                    $eq = $kv.IndexOf('=')
                    if ($eq -gt 0) {
                        $k = [uri]::UnescapeDataString($kv.Substring(0, $eq)).ToLower()
                        $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
                        $query[$k] = $v
                    }
                }
            } else {
                $path = $target
            }
        }
    }
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]
        $ix = $l.IndexOf(':')
        if ($ix -gt 0) { $headers[$l.Substring(0, $ix).Trim().ToLower()] = $l.Substring($ix + 1).Trim() }
    }
    $method = 'GET'
    if ($lines.Count -gt 0 -and $lines[0]) { $tok0 = ($lines[0].Trim() -split ' ')[0]; if ($tok0) { $method = $tok0.ToUpper() } }
    return @{ path = $path; headers = $headers; query = $query; method = $method }
}
function Test-ClientAllowed {
    param($Client, $Query, $Token)
    $why = ''
    $ip = $null
    $ra0 = ''
    try {
        $ra = $Client.Client.RemoteEndPoint
        if ($ra) { $ra0 = [string]$ra.ToString(); $ip = $ra.Address }
        if ($ip -and $ip.IsIPv6MappedToIPv4) { $ip = $ip.MapToIPv4() }
    } catch { $why = 'ip-resolve:' + $_.Exception.Message }
    try {
        # String-first loopback check (whole 127.0.0.0/8) - cannot fail via member quirks.
        if ($ra0 -like '127.*' -or $ra0 -eq '::1' -or $ra0 -eq '::1:0:0:0:0:0:0:1') {
            Write-ClientAudit ('gate-allow-loopback-str ra=' + $ra0)
            return $true
        }
        if ($ip -and $ip.IsLoopback) {
            Write-ClientAudit ('gate-allow-loopback-obj ra=' + $ra0 + ' loop=True')
            return $true
        }
        if ($ip) {
            $oct = $ip.GetAddressBytes()
            if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) {
                Write-ClientAudit ('gate-allow-cgnat ra=' + $ra0)
                return $true
            }
        }
        if (-not $ip) { $why = 'ip-empty' }
    } catch { $why = 'ip-check:' + $_.Exception.Message }
    if ([string]::IsNullOrEmpty($Token)) { return $true }
    if ($Query -and $Query.ContainsKey('key') -and ([string]$Query['key'] -eq [string]$Token)) {
        Write-ClientAudit ('gate-allow-key ra=' + $ra0)
        return $true
    }
    $ipTxt = 'unknown'
    try { if ($ip) { $ipTxt = $ip.ToString() } } catch { }
    $loopTxt = 'E'
    try { $loopTxt = [string][bool]$ip.IsLoopback } catch { }
    $typTxt = 'E'
    try { if ($ip) { $typTxt = $ip.GetType().FullName } } catch { }
    Write-ClientAudit ('gate-deny ip=' + $ipTxt + ' ra=' + $ra0 + ' loop=' + $loopTxt + ' typ=' + $typTxt + ' why=' + $why)
    return $false
}
function Read-ClientRequest {
param($Stream)
$acc = New-Object System.Text.StringBuilder
$buf = New-Object byte[] 4096
try { $Stream.ReadTimeout = 5000 } catch { }
$headerDone = $false
$idx = -1
$cl = 0
$bodyBytes = New-Object System.Collections.Generic.List[byte]
while ($true) {
$n = 0
try { $n = $Stream.Read($buf, 0, $buf.Length) } catch { break }
if ($n -le 0) { break }
if (-not $headerDone) {
[void]$acc.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
$txt = $acc.ToString()
$idx = $txt.IndexOf("`r`n`r`n")
if ($idx -ge 0) {
$headerDone = $true
$m = [regex]::Match($txt, '(?im)^Content-Length:\s*(\d+)')
if ($m.Success) { $cl = [int]$m.Groups[1].Value }
$priorLen = $acc.Length - $n
$bodyStart = ($idx + 4) - $priorLen
if ($bodyStart -lt 0) { $bodyStart = 0 }
if ($bodyStart -lt $n) { $bodyBytes.AddRange([byte[]]$buf[$bodyStart..($n - 1)]) }
if ($bodyBytes.Count -ge $cl) { break }
}
if ($acc.Length -gt 65536) { break }
} else {
$bodyBytes.AddRange([byte[]]$buf[0..($n - 1)])
if ($bodyBytes.Count -ge $cl) { break }
}
}
$head = $acc.ToString()
if ($idx -ge 0) { $head = $head.Substring(0, $idx + 4) }
return @{ head = $head; body = $bodyBytes.ToArray() }
}
function Send-ClientResponse {
    param($Stream, [int]$Code, [string]$CType, [byte[]]$Body)
    $status = 'OK'
    if ($Code -eq 401) { $status = 'Unauthorized' }
    if ($Code -eq 204) { $status = 'No Content' }
    if ($Code -eq 403) { $status = 'Forbidden' }
    if ($Code -eq 404) { $status = 'Not Found' }
    if ($Code -eq 409) { $status = 'Conflict' }
    if ($Code -eq 500) { $status = 'Server Error' }
    $hdr = "HTTP/1.1 $Code $status`r`nContent-Type: $CType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type, Authorization`r`nAccess-Control-Allow-Methods: GET,POST,OPTIONS`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
    $Stream.Write($hb, 0, $hb.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}
function To-IsoUtc {
    param([string]$S)
    if (-not $S) { return '' }
    $s2 = $S.Trim()
    if ($s2 -match 'Z$' -or $s2 -match '[+-]\d{2}:\d{2}$') { return $s2 }
    $dt = [datetime]::MinValue
    if ([datetime]::TryParse($s2, [ref]$dt)) { return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return $s2
}
function ConvertTo-JsonBytes {
    param($Obj)
    return [System.Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth 10 -Compress))
}
function Remove-CredKeys {
    # [remediation #7A / U1] Strip secrets from a config object before it leaves
    # in any response body, then rebuild `creds` to expose ONLY the fields the UI
    # needs for the native mstsc auto-login flow: { fqdn, user, ip }.
    #   fqdn = config.dnsName only (*.ts.net). Never the tailnet IP.
    #   user = config.rdpUser  (a username, not a secret; the password is never here).
    #   ip   = config.rdpIp    (the same value as fqdn under P2).
    # Everything else that could carry a secret (rdpPass, mirrorKey,
    # legacyDecryptKey, rentryEditCode, rentryEditCookie, dashToken) is removed.
    param($Obj)
    if (-not $Obj) { return $Obj }
    $fqdn = ''; $user = ''; $ip = ''
    try { if ($Obj.PSObject.Properties['dnsName']) { $fqdn = [string]$Obj.dnsName } } catch { }
    try { if ($Obj.PSObject.Properties['rdpUser']) { $user = [string]$Obj.rdpUser } } catch { }
    try { if ($Obj.PSObject.Properties['rdpIp'])   { $ip   = [string]$Obj.rdpIp   } } catch { }
    # dnsName only. Never present the tailnet IP as the FQDN.
    foreach ($k in @('rdpUser','rdpPass','mirrorKey','legacyDecryptKey','creds','rentryEditCode','rentryEditCookie','dashToken','vncPass')) {
        try { if ($Obj.PSObject.Properties[$k]) { $Obj.PSObject.Properties.Remove($k) } } catch { }
    }
    try {
        $Obj | Add-Member -MemberType NoteProperty -Name 'creds' -Value ([pscustomobject]@{ fqdn = $fqdn; user = $user; ip = $ip }) -Force
    } catch { }
    return $Obj
}
function Invoke-ClientRequest {
    param($Client, $Token)
    $stream = $null
    try {
        $stream = $Client.GetStream()
        $rr = Read-ClientRequest -Stream $stream
        if (-not $rr -or -not $rr.head) { return }
        $parts = Get-RequestParts -Raw ([string]$rr.head)
        $parts['body'] = [byte[]]$rr.body
        $path = [string]$parts.path
        if (-not $path) { $path = '/' }
        # Browser cross-origin preflight carries no bearer; disclose nothing.
        if ($path -eq '/api/rdp-token' -and $parts.method -eq 'OPTIONS') {
            Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@())
            return
        }
        if (-not (Test-ClientAllowed -Client $Client -Query $parts.query -Token $Token)) {
            Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('unauthorized'))
            return
        }
        # [F10 s2.2] dash-token source peer: when a request carries the exact
        # dashboard token (query key= or Authorization: Bearer, constant-time
        # compare), remember the caller's tailnet IPv4 as the target for the
        # runner-side 15s tailscale ping. ONLY the IP is written - the token
        # itself never reaches disk here.
        try {
            $qkF10 = ''
            if ($parts.query -and $parts.query.ContainsKey('key')) { $qkF10 = [string]$parts.query['key'] }
            $ahF10 = ''
            try { $ahF10 = [string]$parts.headers['authorization'] } catch { }
            $hasTokF10 = $false
            if ($Token -and $qkF10 -and $qkF10.Length -eq ([string]$Token).Length) {
                $b1 = [System.Text.Encoding]::UTF8.GetBytes($qkF10)
                $b2 = [System.Text.Encoding]::UTF8.GetBytes([string]$Token)
                if ([System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($b1, $b2)) { $hasTokF10 = $true }
            }
            if (-not $hasTokF10 -and $Token -and $ahF10 -and $ahF10.Length -eq (([string]$Token).Length + 7)) {
                $b1 = [System.Text.Encoding]::UTF8.GetBytes($ahF10)
                $b2 = [System.Text.Encoding]::UTF8.GetBytes('Bearer ' + [string]$Token)
                if ([System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($b1, $b2)) { $hasTokF10 = $true }
            }
            if ($hasTokF10) {
                $ripF10 = ''
                try { $ripF10 = $Client.Client.RemoteEndPoint.Address.ToString() } catch { }
                if ($ripF10 -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') {
                    $script:DashPeerIp = $ripF10
                    [System.IO.File]::WriteAllText((Join-Path $Root 'dash-peer.txt'), $ripF10, $script:NoBom)
                }
            }
        } catch { }
        $cfg = Read-JsonFile -Path $script:CfgPath
        # [remediation 8A] /rentrydiag removed: no public-mirror editing
        if ($path -eq '/rentrydiag') {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('endpoint removed per remediation'))
            return
        }
        if ($path -eq '/flush') {
            $note = 'flush flag set - the watcher will upload everything on its next pass'
            try { [System.IO.File]::WriteAllText($script:FlushFlag, (Get-Date -Format o), $script:NoBom) } catch { $note = 'flush flag write failed: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $note })
            return
        }
        if ($path -eq '/launch') {
            $msg = 'watcher task start requested'
            try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction Stop } catch { $msg = 'could not start watcher task (log in via RDP first): ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $msg })
            return
        }
        if ($path -eq '/diag') {
            $prog = Read-JsonFile -Path $script:ProgPath
            $listen7332 = $false
            try { $listen7332 = [bool](Get-NetTCPConnection -LocalPort 7332 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $watcherState = 'not found'
            try { $wt = Get-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue; if ($wt) { $watcherState = [string]$wt.State } } catch { }
            $progAge = $null
            try { if ($prog -and $prog.ts) { $progAge = [int]((Get-Date) - [datetime]$prog.ts).TotalSeconds } } catch { }
            $d = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                port = $Port
                pid = $PID
                rust7332Listening = $listen7332
                watcherTask = $watcherState
                progressAgeSeconds = $progAge
                watcherAlive = [bool]$prog.alive
                note = 'ps server 7331 (fallback); rust realtime dashboard 7332 when available'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $d)
            return
        }
        # [remediation] C2 / agent-payload / .bat endpoints removed -> 404
        # (no enrollment, no command queue, no agent hello/status, no diag up/download, no served payloads/bat)
        if ($path -in @('/install.bat','/connect-now.bat','/install.ps1','/client-install.ps1','/api/enroll.ps1','/api/launch.ps1','/launcher.ps1','/api/launcher-hello','/api/agent.ps1','/api/agent-hash','/api/accept.ps1','/api/acceptance.ps1','/api/device-enroll','/api/client-cmd','/api/agent-hello','/api/agent-status','/api/client-status','/api/diag-upload','/api/diag-file')) {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('endpoint removed per remediation'))
            return
        }
        # [remediation 8C-extended] /install.bat + /connect-now.bat bodies deleted; unreachable due to 404 guard above. /connect-now.bat body was serving a .bat with cmdkey /generic:TERMSRV/<ip> /pass:<plaintext> - direct violation of the no-plaintext-transit decision.
        if ($path -eq '/api/rdp-token' -and $parts.method -eq 'POST') {
            # Tailnet reachability alone must not mint native RDP tokens. Require
            # the dashboard secret in a header (never in the request URL).
            $auth = [string]$parts.headers['authorization']
            $expected = [System.Text.Encoding]::UTF8.GetBytes('Bearer ' + $Token)
            $received = [System.Text.Encoding]::UTF8.GetBytes($auth)
            if (-not $Token -or $received.Length -ne $expected.Length -or
                -not [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($received, $expected)) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('dashboard authorization required'))
                return
            }
            $vps = ($cfg -and $cfg.PSObject.Properties['hostKind'] -and $cfg.hostKind -eq 'vps')
            if (-not $vps -and (Test-Path -LiteralPath (Join-Path $Root 'hostKind.txt'))) {
                $vps = ([System.IO.File]::ReadAllText((Join-Path $Root 'hostKind.txt'))).Trim() -eq 'vps'
            }
            if (-not $vps) {
                Send-ClientResponse -Stream $stream -Code 403 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('native auto-login is VPS-only'))
                return
            }
            if (-not $cfg -or [string]$cfg.dnsName -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
                Send-ClientResponse -Stream $stream -Code 409 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('MagicDNS FQDN missing'))
                return
            }
            $now = [datetime]::UtcNow
            $expired = @($script:RdpTokens.Keys | Where-Object { ($now - $script:RdpTokens[$_].created).TotalSeconds -gt 60 })
            foreach ($ek in $expired) { $script:RdpTokens.Remove($ek) }
            $random = New-Object byte[] 16
            [System.Security.Cryptography.RandomNumberGenerator]::Fill($random)
            $newTok = [Convert]::ToHexString($random).ToLowerInvariant()
            $script:RdpTokens[$newTok] = @{ created = $now; used = $false }
            try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), ($now.ToString('o') + ' ISSUED ' + $newTok.Substring(0,8) + "...`n")) } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ rid = $newTok; ttl = 60 })
            return
        }
        if ($path -eq '/api/rdp-creds' -or $path -eq '/rdp-creds' -or $path -eq '/api/rdp-info') {
            $now2 = [datetime]::UtcNow
            $cip = ''
            try { $cip = $Client.Client.RemoteEndPoint.Address.ToString() } catch { }

            # [P3] GET is deprecated. Token in query string leaks to any process
            # that can read the URL (browser history, HTTP server access logs,
            # any proxy in between). Force POST with token in JSON body.
            if ($parts.method -ne 'POST') {
                try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), ($now2.ToString('o') + " REJECTED method=$($parts.method) from $cip (use POST)`n")) } catch { }
                Send-ClientResponse -Stream $stream -Code 410 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes("Gone. Use POST /api/rdp-creds with body {`"token`":`"...`"}. GET was deprecated in P3 (token in query string leaked to logs)."))
                return
            }

            # [P3] Extract token from JSON body only. Query string is ignored.
            $reqTok = ''
            try {
                if ($parts.body -and $parts.body.Length -gt 0) {
                    $bodyTxt = [System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)
                    if ($bodyTxt) {
                        $bj = $bodyTxt | ConvertFrom-Json
                        if ($bj -and $bj.token) { $reqTok = [string]$bj.token }
                    }
                }
            } catch { }

            $allow = $false
            if ($reqTok -and $script:RdpTokens.ContainsKey($reqTok)) {
                $te = $script:RdpTokens[$reqTok]
                if (($now2 - $te.created).TotalSeconds -le 60 -and -not $te.used) {
                    $script:RdpTokens.Remove($reqTok)
                    try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), ($now2.ToString('o') + ' REDEEMED ' + $reqTok.Substring(0,8) + '... from ' + $cip + "`n")) } catch { }
                    $allow = $true
                } else {
                    $script:RdpTokens.Remove($reqTok)
                    try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), ($now2.ToString('o') + ' REJECTED expired/used ' + $reqTok.Substring(0,8) + "...`n")) } catch { }
                }
            } elseif (-not $reqTok) {
                # [P3] The legacy "tailnet source implies allow" no-token path is
                # gone. Every redemption requires a live token issued by
                # /api/rdp-token. Tailnet-only firewalling is a network guard, not
                # an auth mechanism, and confusing the two enabled earlier bugs.
                try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), ($now2.ToString('o') + " REJECTED missing token from $cip`n")) } catch { }
            } else {
                try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), ($now2.ToString('o') + " REJECTED invalid from $cip`n")) } catch { }
            }

            if ($allow) {
                $cfgC = Read-JsonFile -Path $script:CfgPath
                # dnsName only. Missing or non-*.ts.net is a 409. Never use rdpIp.
                # every redemption on ephemeral runners.
                $rdpTarget = ''
                if ($cfgC -and $cfgC.PSObject.Properties['dnsName'] -and $cfgC.dnsName) { $rdpTarget = [string]$cfgC.dnsName }
                # no rdpIp fallback: an IP is not a MagicDNS name
                # [P2 FQDN discipline] Only a MagicDNS FQDN may be returned.
                if ($rdpTarget -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
                    try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), ($now2.ToString('o') + " REJECTED non-fqdn resolved target='$rdpTarget'`n")) } catch { }
                    Send-ClientResponse -Stream $stream -Code 409 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('server config.dnsName is missing or not a MagicDNS FQDN (*.ts.net); handler will refuse to launch. Fix config.json.'))
                } else {
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ fqdn = $rdpTarget })
                }
            } else {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('token invalid, expired, or missing'))
            }
            return
        }
        # [U3 / U5a] GET /api/native-status - dashboard readiness snapshot for
        # the native mstsc auto-login button. Aggregates FQDN validity, LE-cert
        # bind, NLA state, and handler-hello age. reasonsDisabled is computed
        # server-side (client contributes cred-store presence separately).
        # Dash-token gated via Test-ClientAllowed at the routing entry.
        # FQDN validity is config.dnsName only. An empty name stays empty;
        # the tailnet IP is never substituted. vpsPending stays advisory.
        if ($path -eq '/api/native-status') {
            $cfgN = Read-JsonFile -Path $script:CfgPath
            $fqdnN = ''
            if ($cfgN -and $cfgN.PSObject.Properties['dnsName'] -and $cfgN.dnsName) { $fqdnN = [string]$cfgN.dnsName }
            # no rdpIp fallback
            $fqdnOk = ($fqdnN -match '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$')
            # certBound requires the *bound* LE certificate to match this exact
            # FQDN, remain valid, and have a private key. Issuer alone is NOT
            # enough (a different node's LE certificate still triggers a prompt).
            $certBound = $false; $nlaOn = $false; $certReason = ''
            try {
                $rdpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
                $sh = (Get-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash' -ErrorAction SilentlyContinue).SSLCertificateSHA1Hash
                if ($sh -and $sh.Length -ge 20) {
                    $thumb = ($sh | ForEach-Object { $_.ToString('X2') }) -join ''
                    $bound = $null
                    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
                    try {
                        $store.Open('ReadOnly')
                        $bound = $store.Certificates | Where-Object { $_.Thumbprint -eq $thumb } | Select-Object -First 1
                    } finally { try { $store.Close() } catch { } }
                    if ($bound) {
                        $dns = $bound.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
                        if ($bound.Subject -eq $bound.Issuer -or $bound.Issuer -notmatch "Let'?s Encrypt") {
                            $certReason = 'listener certificate is not a Tailscale LE certificate'
                        } elseif ($dns -ne $fqdnN) {
                            $certReason = 'bound listener certificate does not match the MagicDNS FQDN'
                        } elseif ($bound.NotAfter.ToUniversalTime() -le [datetime]::UtcNow -or
                            $bound.NotBefore.ToUniversalTime() -gt [datetime]::UtcNow -or -not $bound.HasPrivateKey) {
                            $certReason = 'bound listener certificate expired, not yet valid or missing private key'
                        } else {
                            $certBound = $true
                        }
                    } else {
                        $certReason = 'bound cert thumbprint not in LocalMachine\My'
                    }
                }
                $ua = (Get-ItemProperty -Path $rdpKey -Name 'UserAuthentication' -ErrorAction SilentlyContinue).UserAuthentication
                if ([int]$ua -eq 1) { $nlaOn = $true }
            } catch { }
            $handlerAge = $null
            try {
                $hhFile = Join-Path $Root 'handler-hello-last.json'
                if (Test-Path -LiteralPath $hhFile) {
                    $hh = [System.IO.File]::ReadAllText($hhFile) | ConvertFrom-Json
                    if ($hh -and $hh.ts) { $handlerAge = [int]([datetime]::UtcNow - [datetime]$hh.ts).TotalSeconds }
                }
            } catch { }
            $vpsPending = $false
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['vpsPending']) { $vpsPending = [bool]$cfgN.vpsPending }
            } catch { }
            # [F7] hostKind must be resolved BEFORE building reasons so 'no-cmdkey-entry'
            # can be conditionally emitted for VPS only. Ephemeral runners never carry a
            # persistent cmdkey (they're new hosts every run) - use WEB DESKTOP instead.
            $hostKind = 'ephemeral'
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['hostKind'] -and [string]$cfgN.hostKind -eq 'vps') { $hostKind = 'vps' }
                elseif (Test-Path -LiteralPath (Join-Path $Root 'hostKind.txt')) {
                    $hk = ([System.IO.File]::ReadAllText((Join-Path $Root 'hostKind.txt'))).Trim().ToLower()
                    if ($hk -eq 'vps') { $hostKind = 'vps' }
                }
            } catch { }
            # [F7] handler-hello reason removed. This page never launches a ghrdp:// handler
            # post-F2, so absence of a handler beacon can no longer block AUTO-LOGIN readiness.
            $reasons = @()
            if (-not $fqdnOk)   { $reasons += 'fqdn-not-tsnet' }
            if (-not $certBound){ $reasons += 'cert-not-bound' }
            if (-not $nlaOn)    { $reasons += 'nla-off' }
            if ($hostKind -eq 'vps') { $reasons += 'no-cmdkey-entry' }
            $probeReasons = [ordered]@{
                fqdn    = $(if ($fqdnOk)    { '' } else { 'dnsName missing or not *.ts.net (config.dnsName=' + $fqdnN + ') - enable MagicDNS: https://login.tailscale.com/admin/dns' })
                cert    = $(if ($certBound) { '' } elseif ($certReason) { $certReason } else { 'no SSLCertificateSHA1Hash bound on RDP-Tcp' })
                nla     = $(if ($nlaOn)     { '' } else { 'UserAuthentication != 1 on RDP-Tcp' })
                cmdkey  = $(if ($hostKind -eq 'vps') { 'TERMSRV/<fqdn> cmdkey entry not verifiable server-side; run once on your PC' } else { '' })
            }
            # [F7] advisory[] carries yellow guidance the UI renders as a NOTE row.
            # Never blocks AUTO-LOGIN, never counted in reasonsDisabled.
            $advisory = @()
            if ($hostKind -eq 'ephemeral') {
                $advisory += 'stored TERMSRV entry is VPS-only - use WEB DESKTOP'
            } elseif ($hostKind -eq 'vps') {
                $advisory += 'run the cmdkey line once (current user), then pin the mstsc shortcut'
            }
            $wd = ''; $wdr = ''; $wdDetail = ''; $wda = ''
            # [F8a] webdeskReason explains an EMPTY webdeskUrl. Enum:
            # vnc-pass-missing | vnc-pass-too-short | serve-failed | config-stale
            # | step-not-run | invalid-webdesk-url. (A PRESENT-but-short VNC_PASS is 'vnc-pass-too-short',
            # never 'vnc-pass-missing' - the dashboard must not tell the user to
            # add a secret that already exists.)
            # Config is re-read per request (Read-JsonFile at the top of this
            # block), so a reason/URL written by the workflow AFTER server
            # start is visible on the very next poll - no restart needed.
            if ($cfgN -and $cfgN.webdeskUrl) { $wd = [string]$cfgN.webdeskUrl }
            if ($cfgN -and $cfgN.PSObject.Properties['webdeskReason'] -and $cfgN.webdeskReason) { $wdr = [string]$cfgN.webdeskReason }
            if ($cfgN -and $cfgN.PSObject.Properties['webdeskDetail'] -and $cfgN.webdeskDetail) { $wdDetail = [string]$cfgN.webdeskDetail }
            # [F9o] webdeskAuth: the VERIFIED VNC mode stamped by the deploy
            # ladder ('vnc' | 'none-tailnet-only'). Strict allowlist: any other
            # value (including tampered config) reads as '' (unknown).
            if ($cfgN -and $cfgN.PSObject.Properties['webdeskAuth'] -and ([string]$cfgN.webdeskAuth -in @('vnc', 'none-tailnet-only'))) { $wda = [string]$cfgN.webdeskAuth }
            # [F9i] webdeskDetail is a fixed, secret-free sub-cause code written
            # only by the workflow (tightvnc-install | novnc-assets |
            # websockify-bind | tailnet-ip-unavailable | firewall-rule |
            # vnc-auth-unverifiable | serve-mapping | self-test-failed). Cap
            # length so a tampered config cannot bloat the response; never
            # carries secrets.
            if ($wdDetail.Length -gt 64) { $wdDetail = $wdDetail.Substring(0, 64) }
            # [F9i] vncPassAdminUrl: the direct secrets-settings link the F9h
            # guard writes into config.json; default is the repo's fixed URL.
            # Exposed so the dashboard links the verified location instead of
            # hardcoding it in the page.
            $vncAdmin = 'https://github.com/dekarita/supreme-lamp/settings/secrets/actions'
            if ($cfgN -and $cfgN.PSObject.Properties['vncPassAdminUrl'] -and $cfgN.vncPassAdminUrl -match '^https://github\.com/') { $vncAdmin = [string]$cfgN.vncPassAdminUrl }
            # [F9k] tsReason + tsAuthAdminUrl: stamped into config.json by the
            # workflow's Emit-SecretHalt when TS_AUTHKEY is missing or rejected
            # (ts-authkey-missing|ts-authkey-invalid|ts-authkey-ratelimited|
            # ts-authkey-unknown). The dashboard renders the keys-page link as
            # a second conditional box. Admin URL is allowlist-validated;
            # nothing here ever carries key material.
            $tsr = ''
            if ($cfgN -and $cfgN.PSObject.Properties['tsReason'] -and [string]$cfgN.tsReason -match '^ts-[a-z-]+$') { $tsr = ([string]$cfgN.tsReason).Substring(0, [Math]::Min(64, ([string]$cfgN.tsReason).Length)) }
            $tsAdmin = 'https://login.tailscale.com/admin/settings/keys'
            if ($cfgN -and $cfgN.PSObject.Properties['tsAuthAdminUrl'] -and [string]$cfgN.tsAuthAdminUrl -match '^https://login\.tailscale\.com/admin/') { $tsAdmin = [string]$cfgN.tsAuthAdminUrl }
            # [F9n] webdeskUrl acceptance allowlist (tailnet-only; reject
            # everything else - no public URLs, no credentials, no invented
            # hosts): http://100.64-127.x.x:7333/ (F9n transport) OR
            # https://<name>.ts.net/ (legacy serve URL, still honored for older
            # configs/VPS). A rejected URL is blanked and reported as
            # invalid-webdesk-url so the dashboard never renders or opens an
            # untrusted value.
            $wdOk = $false
            if ($wd -match '^http://100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}:7333/') { $wdOk = $true }
            elseif ($wd -match '^https://[a-z0-9.-]+\.ts\.net/') { $wdOk = $true }
            if ($wd -and -not $wdOk) { $wd = ''; if (-not $wdr) { $wdr = 'invalid-webdesk-url' } }
            if ($wd) { $wdr = ''; $wdDetail = '' } elseif (-not $wdr) { $wdr = 'step-not-run' }
            # [F8a] config-stale: URL advertised but nothing listens on
            # <tailnet-ip>:7333 (websockify died after the step wrote config).
            # Best-effort; any error leaves the advertised values untouched.
            if ($wd) {
                try {
                    $wsConn = Get-NetTCPConnection -LocalPort 7333 -State Listen -ErrorAction Stop
                    if (-not $wsConn) { $wd = ''; $wdr = 'config-stale'; $wdDetail = 'listener-gone' }
                } catch { }
            }
            # [F9o] No URL => no auth mode (a blanked URL must not keep a stale 'vnc').
            if (-not $wd) { $wda = '' }
            # [F10 s2.1] newest interactive RDP session (LogonType 10) age,
            # cached for 10s so the UI poll cadence never hammers CIM. Null =
            # no interactive session yet (the row keeps --:--:-- until one
            # exists; the UI anchors at the first non-null value).
            $rdpAgeSec = $null
            try {
                if (([datetime]::UtcNow - $script:LogonAgeTs).TotalSeconds -ge 10) {
                    $newestStart = $null
                    foreach ($ls in (Get-CimInstance Win32_LogonSession -Filter 'LogonType = 10' -ErrorAction SilentlyContinue)) {
                        if ($ls.StartTime) {
                            $st = [datetime]$ls.StartTime
                            if (($null -eq $newestStart) -or ($st -gt $newestStart)) { $newestStart = $st }
                        }
                    }
                    if ($newestStart) {
                        $age0 = [int]((Get-Date) - $newestStart).TotalSeconds
                        if ($age0 -ge 0 -and $age0 -lt 604800) { $script:LogonAge = $age0 } else { $script:LogonAge = $null }
                    } else { $script:LogonAge = $null }
                    $script:LogonAgeTs = [datetime]::UtcNow
                }
                if ($null -ne $script:LogonAge) { $rdpAgeSec = [int]$script:LogonAge }
            } catch { }
            # [F10 s2.2] runner-side tailscale ping probe result (15s cadence,
            # spawned below as ping-probe.ps1). Only fresh results (<45s) are
            # exposed so the UI can age out a dead probe honestly.
            $pingMs = $null
            $pingPath = ''
            try {
                $ppFile = Join-Path $Root 'ping-probe.json'
                if (Test-Path -LiteralPath $ppFile) {
                    $pp = [System.IO.File]::ReadAllText($ppFile) | ConvertFrom-Json
                    if ($pp -and $pp.ts) {
                        $ppAge = ([datetime]::UtcNow - ([datetime]$pp.ts).ToUniversalTime()).TotalSeconds
                        if ($ppAge -ge 0 -and $ppAge -le 45) {
                            if ($null -ne $pp.ms) { $pingMs = [math]::Round([double]$pp.ms, 1) }
                            if ([string]$pp.path -in @('direct', 'relay')) { $pingPath = [string]$pp.path } else { $pingPath = 'unknown' }
                        }
                    }
                }
            } catch { }
            $ns = [ordered]@{
                fqdn = $fqdnN
                hostKind = $hostKind
                buildSha = $(if ($cfgN -and $cfgN.PSObject.Properties['buildSha']) { [string]$cfgN.buildSha } else { '' })
                certBound = $certBound
                nlaOn = $nlaOn
                handlerSeenAgeSec = $handlerAge
                # [F10 s2] real telemetry: interactive-logon age (null until a
                # LogonType 10 session exists) + runner-side tailscale ping.
                rdpLogonAgeSec = $rdpAgeSec
                pingMs = $pingMs
                pingPath = $pingPath
                webdeskUrl = $wd
                webdeskReason = $wdr
                webdeskDetail = $wdDetail
                webdeskAuth = $wda
                vncPassAdminUrl = $vncAdmin
                tsReason = $tsr
                tsAuthAdminUrl = $tsAdmin
                vpsPending = $vpsPending
                # [F9c] actionable MagicDNS admin link: the dashboard linkifies
                # it whenever the fqdn reason renders (fqdn missing) and hides
                # it once the FQDN resolves. Carries no credentials.
                magicDnsAdminUrl = 'https://login.tailscale.com/admin/dns'
                probeReasons = $probeReasons
                reasonsDisabled = @($reasons)
                advisory = @($advisory)
            }
            # [U4] lastHandlerVerb: verb + result of the most recent /api/handler-hello,
            # so the dashboard can show "last: install ok" / "last: setup skipped" without
            # keeping any per-client state on the server. Optional (may be null).
            try {
                $lvFile = Join-Path $Root 'handler-hello-last.json'
                if (Test-Path -LiteralPath $lvFile) {
                    $lv = [System.IO.File]::ReadAllText($lvFile) | ConvertFrom-Json
                    if ($lv -and $lv.verb) { $ns.lastHandlerVerb = @{ verb = [string]$lv.verb; ok = [bool]$lv.ok; details = [string]$lv.details; ts = [string]$lv.ts } }
                }
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $ns)
            return
        }
        # [U3/U4] POST /api/handler-hello - handler beacon. Body may carry
        # {verb,ok,details} from install/setup/check verbs; connect posts empty
        # body. Only timestamp + verb summary are written; no IP/user/creds.
        # Dash-token gated via routing entry.
        if ($path -eq '/api/handler-hello' -and $parts.method -eq 'POST') {
            $hh = [ordered]@{ ts = [datetime]::UtcNow.ToString('o') }
            try {
                $bodyRaw = $parts.body
                if ($bodyRaw -and $bodyRaw.Length -gt 0) {
                    $bTxt = [System.Text.Encoding]::UTF8.GetString([byte[]]$bodyRaw)
                    $bj = $bTxt | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($bj) {
                        if ($bj.verb)    { $hh.verb    = [string]$bj.verb }
                        if ($null -ne $bj.ok) { $hh.ok = [bool]$bj.ok }
                        if ($bj.details) { $hh.details = ([string]$bj.details).Substring(0, [Math]::Min(280, ([string]$bj.details).Length)) }
                    }
                }
            } catch { }
            try { [System.IO.File]::WriteAllText((Join-Path $Root 'handler-hello-last.json'), ($hh | ConvertTo-Json -Compress), $script:NoBom) } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
            return
        }
        # [remediation 8C] /api/launch.ps1, /launcher.ps1, /api/enroll.ps1 bodies deleted; unreachable due to guard above.
        # [remediation 8C-extended] /api/launcher-hello body deleted; unreachable due to 404 guard above. It acknowledged agent-launcher heartbeats — obsolete under the native mstsc flow (no agent, no launcher).
        if ($path -eq '/api/launcher-status') {
            $body = '{"ver":0,"ts":"","ageSeconds":-1}'
            try {
                $lhFile = Join-Path $Root 'launcher-hello-last.json'
                if (Test-Path -LiteralPath $lhFile) {
                    $lh = [System.IO.File]::ReadAllText($lhFile) | ConvertFrom-Json
                    $age = [int]([datetime]::UtcNow - [datetime]$lh.ts).TotalSeconds
                    $body = '{"ver":' + [int]$lh.ver + ',"build":"' + [string]$lh.build + '","ts":"' + [string]$lh.ts + '","ageSeconds":' + $age + '}'
                }
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
            return
        }
        if ($path -eq '/api/rdp-status') {
            $rdpAgeSec = -1
            $logonType = 0
            try {
                $cfgS = Read-JsonFile -Path $script:CfgPath
                $u = [string]$cfgS.rdpUser
                $sessions = @(query.exe user 2>$null)
                foreach ($qr in $sessions) {
                    if (($qr -match [regex]::Escape($u)) -and ($qr -match '\bActive\b')) {
                        if ($qr -match '(\d{1,2}:\d{2})') {
                            $rdpAgeSec = 0
                        } else { $rdpAgeSec = 0 }
                        $logonType = 10
                        break
                    }
                }
                if ($rdpAgeSec -lt 0) {
                    $ev = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4624} -MaxEvents 20 -ErrorAction SilentlyContinue |
                        Where-Object { $_.Message -match 'Logon Type:\s+10' -and $_.Message -match [regex]::Escape($u) } |
                        Select-Object -First 1
                    if ($ev) {
                        $rdpAgeSec = [int]((Get-Date) - $ev.TimeCreated).TotalSeconds
                        $logonType = 10
                    }
                }
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"rdp_age_s":' + $rdpAgeSec + ',"logon_type":' + $logonType + '}'))
            return
        }
        if ($path -eq '/api/ping') {
            $tIp = Get-TailnetIp
            $commit = ''
            try { $cfgP2 = Read-JsonFile -Path $script:CfgPath; if ($cfgP2 -and $cfgP2.commit) { $commit = [string]$cfgP2.commit } } catch { }
            $obj = [ordered]@{ ok = $true; ip = $tIp; epoch = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); commit = $commit }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $obj)
            return
        }
        # [remediation 8C] /api/device-enroll, /api/agent-hello, /api/client-cmd (POST+GET),
        # /api/client-status + /api/agent-status (POST+GET), /api/agent.ps1, /api/accept.ps1,
        # /api/acceptance.ps1 bodies deleted; unreachable due to 404 guard above.
        if ($path -eq '/api/diag.ps1') {
            $dp = Join-Path $Root 'ghrdp-diag.ps1'
            if (Test-Path -LiteralPath $dp) {
                Send-ClientResponse -Stream $stream -Code 200 -CType 'text/plain; charset=utf-8' -Body ([System.IO.File]::ReadAllBytes($dp))
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('diag.ps1 not deployed'))
            }
            return
        }
        # /api/logon-status — RUNNER-SIDE RDP logon proof (addresses REVIEW.md N8).
        # Query the RUNNER's Security log for event 4624 with Logon Type 10 for the RDP account
        # newer than the caller-supplied baseline. This is genuine RDP-into-runner evidence.
        # Client-side LogonType 10 is inbound-to-client and does NOT prove the outbound RDP.
        if ($path -eq '/api/logon-status') {
            $sinceIso = ''
            if ($parts.query -and $parts.query.ContainsKey('since')) { $sinceIso = [string]$parts.query['since'] }
            $userQ = ''
            if ($parts.query -and $parts.query.ContainsKey('user')) { $userQ = [string]$parts.query['user'] }
            if (-not $userQ) { try { $cfgL = Read-JsonFile -Path $script:CfgPath; $userQ = [string]$cfgL.rdpUser } catch { } }
            $since = [DateTime]::UtcNow.AddMinutes(-2)
            if ($sinceIso) { try { $since = [DateTime]::Parse($sinceIso).ToUniversalTime() } catch { } }
            $connected = $false; $ts = ''; $ageSec = -1; $ip = ''; $checked = 0
            try {
                $filter = @{ LogName='Security'; Id=4624; StartTime=$since.ToLocalTime() }
                $events = Get-WinEvent -FilterHashtable $filter -MaxEvents 80 -ErrorAction SilentlyContinue
                foreach ($ev in @($events)) {
                    $checked++
                    $msg = [string]$ev.Message
                    if ($msg -notmatch 'Logon Type:\s+10') { continue }
                    if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { continue }
                    $connected = $true
                    $ts = $ev.TimeCreated.ToUniversalTime().ToString('o')
                    $ageSec = [int]((Get-Date) - $ev.TimeCreated).TotalSeconds
                    if ($msg -match 'Source Network Address:\s+(\S+)') { $ip = $Matches[1] }
                    break
                }
            } catch { }
            $body = [ordered]@{
                connected  = $connected
                ts         = $ts
                ageSeconds = $ageSec
                sourceIp   = $ip
                user       = $userQ
                since      = $since.ToString('o')
                checked    = $checked
                note       = 'Runner-side Security 4624 LogonType 10; requires SeSecurityPrivilege on server process'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $body)
            return
        }
        # [remediation 8C-extended] /api/agent-hash body deleted; unreachable due to 404 guard above. It served SHA256 of the removed agent.ps1 payload — no agent, no hash.
        # [remediation 8C] /api/diag-upload, /api/diag-file bodies deleted; unreachable due to 404 guard above.
        # [remediation 8C-extended] /client-install.ps1 body deleted; unreachable due to 404 guard above. It served the client-install script — replaced by docs/AUTOLOGIN.md manual reg-add + cmdkey.
        if ($path -eq '/webdesk-boot') {
            # [remediation #7C] loopback-boot call removed - it turned NLA off + stashed plaintext cmdkey.
            $outB = @{ ok = $false; message = 'loopback bootstrap removed per remediation #7C - log in via real RDP with NLA on' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(($outB | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-probe') {
            $wPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-pub2.ps1'
            $bPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-bootstrap-session.ps1'
            $task = $false
            try { $task = [bool](Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue) } catch { }
            $sess = $false
            try { $q = (& quser.exe 2>$null) -join "`n"; $LASTEXITCODE = 0; $cfgP = Read-JsonFile -Path $script:CfgPath; if (($q -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($q -match 'runneradmin')) { $sess = $true } } catch { }
            $sessState = 'no-session'
            try { $ql2 = @(& quser.exe 2>$null); $LASTEXITCODE = 0; foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin')) -and ($qr2 -match '\bActive\b')) { $sessState = 'Active'; break } }; if ($sessState -eq 'no-session') { foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin'))) { $sessState = 'Disc'; break } } } } catch { $sessState = 'error' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ webdeskPs = $wPs; bootstrapPs = $bPs; task = $task; session = $sess; diag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\boot-diag.txt') } catch { '' }); wdErr = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); mstscDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\mstsc-exit-diag.txt') } catch { '' }); tsPath = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\ts-path.txt') } catch { '' }); aliveAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-alive.txt')).TotalMilliseconds } catch { -1 }); capFail = $(try { $cfi = Get-Item 'C:\ghrdp\webdesk\webdesk-capture-fail.txt' -ErrorAction Stop; if (((Get-Date) - $cfi.LastWriteTime).TotalSeconds -lt 60) { [System.IO.File]::ReadAllText($cfi.FullName) } else { '' } } catch { '' }); version = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-version.txt') } catch { '' }); manualDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\diag-manual.txt') } catch { '' }); displayCount = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\display-count.txt') } catch { '' }); frameExists = $(Test-Path 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction SilentlyContinue); frameSize = $(try { (Get-Item 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction Stop).Length } catch { -1 }); startAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-start.txt')).TotalMilliseconds } catch { -1 }); initResult = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-init.txt') } catch { '' }); captureProcAlive = $(try { $m = [System.Threading.Mutex]::OpenExisting('Global\GhrdpWebDeskSingle'); $h = $m.WaitOne(0); if (-not $h) { 'RUNNING (mutex held)' } else { $m.ReleaseMutex(); 'NOT RUNNING' } } catch { 'NOT RUNNING' }); pidFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk.pid') } catch { '' }); errFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); trace = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-trace.txt') } catch { '' }); captureProcs = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\procs.txt') } catch { '' }); sessionState = $sessState; taskState = $(try { $t = Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() } else { 'not-registered' } } catch { 'error' }); taskLastRun = $(try { $i = Get-ScheduledTaskInfo -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($i) { $i.LastRunTime.ToString() + ' result=' + $i.LastTaskResult } else { 'never' } } catch { 'error' }) } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-status') {
            $ageMs = -1
            try { $tsTxt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\frame-ts.txt'); $ageMs = [int]((Get-Date) - [datetime]$tsTxt).TotalMilliseconds } catch { }
            $outJ = @{ ok = ($ageMs -ge 0 -and $ageMs -lt 15000); frameAgeMs = $ageMs } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
            return
        }
        if ($path -eq '/webdesk-frame') {
            $b = $null
            for ($ra = 1; $ra -le 4; $ra++) {
                try { $b = [System.IO.File]::ReadAllBytes('C:\ghrdp\webdesk\frame.jpg'); if ($b -and $b.Length -gt 0) { break } } catch { $b = $null }
                Start-Sleep -Milliseconds 25
            }
            if ($b -and $b.Length -gt 0) { Send-ClientResponse -Stream $stream -Code 200 -CType 'image/jpeg' -Body $b } else { Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('no frame yet')) }
            return
        }
        if ($path -eq '/webdesk-input') {
            $btxt = ''
            try { $btxt = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) } catch { }
            $wrote = $false
            try {
                $bj = $null
                try { $bj = $btxt | ConvertFrom-Json } catch { }
                $linesOut = @()
                if ($bj -is [System.Collections.IEnumerable] -and $bj -isnot [string]) { foreach ($e1 in @($bj)) { $linesOut += ($e1 | ConvertTo-Json -Compress) } } else { $linesOut += $btxt }
                $dir = 'C:\ghrdp\webdesk'
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null }
                try {
                    [System.IO.File]::AppendAllText((Join-Path $dir 'input.ndjson'), (($linesOut -join "`n") + "`n"))
                    $wrote = $true
                } catch {
                    try { Add-Content -LiteralPath (Join-Path $dir 'input.ndjson') -Value (($linesOut -join "`n")) -Encoding UTF8; $wrote = $true } catch { }
                }
            } catch { }
            try { $cf = 'C:\ghrdp\webdesk\input-count.txt'; $n = 0; if (Test-Path -LiteralPath $cf) { try { $n = [int]([System.IO.File]::ReadAllText($cf).Trim()) } catch { } }; [System.IO.File]::WriteAllText($cf, ([string]($n + 1))) } catch { }
            $okTxt = if ($wrote) { 'true' } else { 'false' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":' + $okTxt + '}'))
            return
        }
        if ($path -eq '/webdesk-clip') {
            if ([string]$parts.method -eq 'POST') {
                try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-set.json', ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body))) } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                return
            }
            try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-get.flag', (Get-Date).ToUniversalTime().ToString('o')) } catch { }
            $txt = $null
            try { if (Test-Path 'C:\ghrdp\webdesk\clip.txt') { $txt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\clip.txt') } } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ text = $txt } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-ctl') {
            if ($parts.method -eq 'POST') {
                try {
                    $body = [System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)
                    $j = $body | ConvertFrom-Json
                    if ($j -and $null -ne $j.q -and $null -ne $j.scale) {
                        $qq = [long]$j.q; $ss = [double]$j.scale
                        if ($qq -ge 1 -and $qq -le 100 -and $ss -gt 0 -and $ss -le 1) {
                            [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\ctl.json', ('{"q":' + $qq + ',"scale":' + $ss.ToString([System.Globalization.CultureInfo]::InvariantCulture) + '}'))
                        }
                    }
                } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                return
            } else {
                $cur = @{ q = 35; scale = 0.5 }
                if (Test-Path -LiteralPath 'C:\ghrdp\webdesk\ctl.json') {
                    try {
                        $raw2 = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\ctl.json').Trim()
                        if ($raw2.Length -gt 0) { $cur = $raw2 | ConvertFrom-Json } else { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\ctl.json', '{"q":35,"scale":0.5}') }
                    } catch { }
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(($cur | ConvertTo-Json -Compress)))
                return
            }
        }
        if ($path -eq '/terminal') {
            $termPage = @'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHRDP Terminal</title>
<style>
:root{--glass:rgba(255,255,255,.08);--stroke:rgba(255,255,255,.16);--txt:#f5f5f7;--dim:rgba(245,245,247,.6)}
*{box-sizing:border-box}
body{margin:0;height:100vh;color:var(--txt);font:14px/1.45 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif;background:#0b0e14;overflow:hidden}
body::before{content:'';position:fixed;inset:-20%;background:radial-gradient(40% 35% at 20% 20%,rgba(64,120,255,.35),transparent 60%),radial-gradient(35% 30% at 80% 25%,rgba(255,80,160,.28),transparent 60%),radial-gradient(45% 40% at 50% 85%,rgba(60,220,180,.22),transparent 60%);filter:blur(40px) saturate(160%);animation:drift 18s ease-in-out infinite alternate;z-index:0}
@keyframes drift{from{transform:translate3d(-2%,-1%,0) scale(1)}to{transform:translate3d(2%,2%,0) scale(1.06)}}
.glass{position:relative;z-index:1;background:var(--glass);border:1px solid var(--stroke);border-radius:18px;backdrop-filter:saturate(180%) blur(22px);-webkit-backdrop-filter:saturate(180%) blur(22px);box-shadow:0 8px 32px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12)}
#app{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;height:100vh;padding:14px}
#bar{display:flex;gap:8px;align-items:center;padding:10px 12px;flex-wrap:wrap}
#bar input,#bar select{background:rgba(255,255,255,.06);border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 10px;font:inherit;outline:none}
#bar input:focus{border-color:rgba(120,170,255,.7);box-shadow:0 0 0 3px rgba(90,140,255,.25)}
button{background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.08));border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 12px;font:inherit;cursor:pointer;backdrop-filter:blur(8px)}
button:hover{background:linear-gradient(180deg,rgba(255,255,255,.3),rgba(255,255,255,.14))}
button.primary{background:linear-gradient(180deg,#4f8cff,#2f6bff);border-color:rgba(255,255,255,.35)}
#code{flex:0 0 26vh;background:rgba(0,0,0,.35);border:1px solid var(--stroke);border-radius:16px;color:#e8f0ff;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:none;outline:none;backdrop-filter:blur(14px)}
#out{flex:1;overflow:auto;background:rgba(0,0,0,.45);border:1px solid var(--stroke);border-radius:16px;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;backdrop-filter:blur(14px)}
.meta{color:#7ee787}.err{color:#ff7b72}.dim{color:var(--dim)}
#chip{margin-left:auto;font-size:12px;color:var(--dim)}
</style></head><body>
<div id="app">
 <div id="bar" class="glass">
  <input id="cmd" size="52" placeholder="one-line command (inline mode)">
  <button id="bCmd" class="primary">Run Cmd</button>
  <input id="fpath" size="34" placeholder="C:\path\script.ps1 (file mode)">
  <button id="bFile">Run File</button>
  <select id="sess"><option value="system">SYSTEM (s0)</option><option value="interactive">INTERACTIVE (user session)</option></select>
  <input id="tmo" size="6" value="60000">
  <button id="bPaste">Run Paste</button>
  <button id="bCopy">Copy Out</button>
  <span id="chip">GHRDP Terminal · liquid glass</span>
 </div>
 <textarea id="code" class="glass" placeholder="paste long .ps1 here → Run Paste (upload mode, base64-safe)"></textarea>
 <div id="out" class="glass"><span class="dim">ready.</span></div>
</div>
<script>
var tok=new URLSearchParams(location.search).get('token')||'';
var out=document.getElementById('out');
function show(j){out.innerHTML='';var m=document.createElement('div');m.className='meta';m.textContent='exit='+j.exitCode+' timedOut='+j.timedOut+' ms='+j.durationMs+' session='+j.session+' file='+j.scriptPath;out.appendChild(m);var o=document.createElement('div');o.textContent=j.output||'(no stdout)';out.appendChild(o);if(j.error){var e=document.createElement('div');e.className='err';e.textContent='STDERR:\n'+j.error;out.appendChild(e);}}
function run(body){out.innerHTML='<span class="dim">running…</span>';fetch('/terminal-exec',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(show).catch(function(e){out.textContent='FETCH ERROR: '+e;});}
document.getElementById('bCmd').onclick=function(){run({mode:'inline',cmd:document.getElementById('cmd').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bFile').onclick=function(){run({mode:'file',file:document.getElementById('fpath').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bPaste').onclick=function(){var t=document.getElementById('code').value;run({mode:'upload',script_b64:btoa(unescape(encodeURIComponent(t))),session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bCopy').onclick=function(){navigator.clipboard.writeText(out.innerText);};
</script></body></html>
'@
                      $htmlT = $null
                      try { if (Test-Path -LiteralPath 'C:\ghrdp\terminal-ui.html') { $htmlT = [System.IO.File]::ReadAllText('C:\ghrdp\terminal-ui.html') } } catch { }
                      if (-not $htmlT) { $htmlT = $termPage }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($htmlT))
            return
        }
                if ($path -eq '/terminal-exec') {
                    $timeoutMs = 60000
                    $tmode = 'inline'
                    $tsess = 'system'
                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $tid = ''
                    $tscript = ''
                    $toutF = ''
                    $terrF = ''
                    $workDir = 'C:\ghrdp\webdesk\term'
                    try {
                        $req = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                        $tmode = if ($req.mode) { [string]$req.mode } else { 'inline' }
                        if ($req.timeout) { $timeoutMs = [int]$req.timeout }
                        if ($timeoutMs -gt 300000) { $timeoutMs = 300000 }
                        if ($timeoutMs -lt 1000) { $timeoutMs = 1000 }
                        if ($req.session -eq 'interactive') { $tsess = 'interactive' }
                        New-Item -ItemType Directory -Path $workDir -Force -ErrorAction SilentlyContinue | Out-Null
                        $tid = [guid]::NewGuid().ToString('N').Substring(0, 8)
                        $tscript = Join-Path $workDir ('run-' + $tid + '.ps1')
                        $toutF = Join-Path $workDir ('out-' + $tid + '.txt')
                        $terrF = Join-Path $workDir ('err-' + $tid + '.txt')
                        $ownScript = $true
                        if ($tmode -eq 'upload') {
                            if (-not [string]$req.script_b64) { throw 'missing script_b64' }
                            [System.IO.File]::WriteAllText($tscript, ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$req.script_b64))))
                        } elseif ($tmode -eq 'file') {
                            if (-not (Test-Path -LiteralPath ([string]$req.file))) { throw ('file not found: ' + [string]$req.file) }
                            $tscript = [string]$req.file
                            $ownScript = $false
                        } else {
                            if (-not [string]$req.cmd) { throw 'empty cmd' }
                            [System.IO.File]::WriteAllText($tscript, ([string]$req.cmd))
                        }
                        try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\terminal-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' mode=' + $tmode + ' session=' + $tsess + ' file=' + $tscript + "`n")) } catch { }
                      $statusFile = Join-Path $workDir ('status-' + $tid + '.txt')
                      [System.IO.File]::WriteAllText($statusFile, 'running')
                      if ($tsess -eq 'system') {
                          try {
                              $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $tscript + '"')) -WorkingDirectory $workDir -RedirectStandardOutput $toutF -RedirectStandardError $terrF -NoNewWindow -PassThru
                              Start-Job -ScriptBlock { param($pid2,$tmo,$sf) $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue; if ($p) { if (-not $p.WaitForExit($tmo)) { try { $p.Kill() } catch { }; [System.IO.File]::WriteAllText($sf,'timeout') } else { [System.IO.File]::WriteAllText($sf,('exit=' + $p.ExitCode)) } } else { [System.IO.File]::WriteAllText($sf,'exit=-1') } } -ArgumentList $proc.Id, $timeoutMs, $statusFile | Out-Null
                          } catch { [System.IO.File]::WriteAllText($statusFile, ('error=' + $_.Exception.Message)) }
                      } else {
                          $activeUser = ''
                          try { $qu = & quser.exe 2>$null; $LASTEXITCODE = 0; foreach ($line in @($qu)) { if ($line -match '^\s*>?\s*(\S+)\s+\S+\s+\d+\s+Active') { $activeUser = $Matches[1]; break } } } catch { }
                          if (-not $activeUser) { [System.IO.File]::WriteAllText($statusFile, 'error=no active user session') }
                          else {
                              $taskName = 'GhrdpTerm-' + $tid
                              $wrapPath = Join-Path $workDir ('wrap-' + $tid + '.ps1')
                              $wrap = 'param($sp,$op,$ep2)' + "`r`n" + '$p = Start-Process -FilePath ''powershell.exe'' -ArgumentList @(''-NoProfile'',''-ExecutionPolicy'',''Bypass'',''-File'',([char]34 + $sp + [char]34)) -RedirectStandardOutput $op -RedirectStandardError $ep2 -NoNewWindow -Wait -PassThru' + "`r`n" + 'exit $p.ExitCode'
                              [System.IO.File]::WriteAllText($wrapPath, $wrap)
                              try {
                                  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $wrapPath + '" "' + $tscript + '" "' + $toutF + '" "' + $terrF + '"')
                                  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(1)
                                  $principal = New-ScheduledTaskPrincipal -UserId $activeUser -LogonType Interactive -RunLevel Highest
                                  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMilliseconds($timeoutMs))
                                  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
                                  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
                                  Start-Job -ScriptBlock { param($tn,$tmo,$sf) $deadline = (Get-Date).AddMilliseconds($tmo); while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $ti = Get-ScheduledTaskInfo -TaskName $tn -ErrorAction SilentlyContinue; if ($ti) { $lr = [int]$ti.LastTaskResult; if ($lr -ne 267009 -and $lr -ne 267010 -and $lr -ne 267011) { [System.IO.File]::WriteAllText($sf, ('exit=' + $lr)); try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue } catch { }; return } } }; [System.IO.File]::WriteAllText($sf, 'timeout'); try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue } catch { } } -ArgumentList $taskName, $timeoutMs, $statusFile | Out-Null
                              } catch { [System.IO.File]::WriteAllText($statusFile, ('error=' + $_.Exception.Message)) }
                          }
                      }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ runId = $tid; session = $tsess; scriptPath = $tscript })
                      return
                    } catch {
                      $errMsg = $_.Exception.Message
                      try {
                        if ($tid) {
                          $sfErr = Join-Path $workDir ('status-' + $tid + '.txt')
                          [System.IO.File]::WriteAllText($sfErr, ('error=' + $errMsg))
                        }
                      } catch { }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ error = $errMsg })
                      return
                    }
                  }
                  # ============= /terminal-result (GET ?id=) =============
                  if ($path -eq '/terminal-result') {
                      $rid = ''
                      if ($parts.query -and $parts.query.ContainsKey('id')) { $rid = [string]$parts.query['id'] }
                      $workDir2 = 'C:\ghrdp\webdesk\term'
                      $sf2 = Join-Path $workDir2 ('status-' + $rid + '.txt')
                      $st = 'running'; if (Test-Path -LiteralPath $sf2) { try { $st = [System.IO.File]::ReadAllText($sf2).Trim() } catch { } }
                      $done = ($st -ne 'running')
                      $exitCode = $null; $timedOut = $false; $errMsg = ''
                      if ($st -like 'exit=*') { $exitCode = [int]($st.Substring(5)) }
                      elseif ($st -eq 'timeout') { $timedOut = $true }
                      elseif ($st -like 'error=*') { $errMsg = $st.Substring(6) }
                      $outTxt = ''; $errTxt = ''
                      if ($done) {
                          for ($a = 1; $a -le 5; $a++) {
                              $o1 = $true; $o2 = $true
                              try { $op = Join-Path $workDir2 ('out-' + $rid + '.txt'); if (Test-Path -LiteralPath $op) { $outTxt = [System.IO.File]::ReadAllText($op) } } catch { $o1 = $false }
                              try { $ep2 = Join-Path $workDir2 ('err-' + $rid + '.txt'); if (Test-Path -LiteralPath $ep2) { $errTxt = [System.IO.File]::ReadAllText($ep2) } } catch { $o2 = $false }
                              if ($o1 -and $o2) { break }
                              Start-Sleep -Milliseconds 300
                          }
                          if ($errMsg -and -not $errTxt) { $errTxt = $errMsg }
                      }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ done = $done; exitCode = $exitCode; timedOut = $timedOut; output = $outTxt; error = $errTxt })
                      return
                  }
        if ($path -eq '/remote-exec') {
            $timeout = 30000
            $out = ''
            try {
                $rj = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                $sb64 = [string]$rj.script_b64
                if (-not $sb64) { throw 'missing script_b64' }
                if ($rj.timeout) { $timeout = [int]$rj.timeout }
                $scriptContent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sb64))
                try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\remote-exec-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' REMOTE-EXEC len=' + $scriptContent.Length + ' head=' + $scriptContent.Substring(0, [Math]::Min(200, $scriptContent.Length)) + "`n")) } catch { }
                $tmpScript = Join-Path $env:TEMP ('ghrdp-remote-' + [guid]::NewGuid().ToString('N') + '.ps1')
                [System.IO.File]::WriteAllText($tmpScript, $scriptContent)
                $job = Start-Job -ScriptBlock { param($s) powershell -NoProfile -ExecutionPolicy Bypass -File $s } -ArgumentList $tmpScript
                $job | Wait-Job -Timeout ($timeout / 1000) | Out-Null
                if ($job.State -eq 'Running') { $job | Stop-Job -Force; $out = 'TIMEOUT after ' + ($timeout / 1000) + 's' }
                else { $out = ($job | Receive-Job | Out-String); if (-not $out) { $out = '(no output)' } }
                try { $job | Remove-Job -Force } catch { }
                try { Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue } catch { }
            } catch { $out = 'ERROR: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(('{"output":' + ([string]$out | ConvertTo-Json) + '}')))
            return
        }
        if ($path -eq '/webdesk') {
            $html = $null
            try { if (Test-Path -LiteralPath 'C:\ghrdp\webdesk-ui.html') { $html = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk-ui.html') } } catch { }
            if (-not $html) { $html = $script:WebDeskHtml }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        if ($path -eq '/novnc') {
            $htmlN = @'
<!doctype html><html><head><meta charset="utf-8"><title>GHRDP Web Desktop</title>
<style>html,body{margin:0;height:100%;background:#101418;overflow:hidden}#screen{width:100%;height:100%}#bar{position:fixed;top:0;left:0;right:0;padding:8px 12px;font:13px system-ui;color:#e8eef3;background:#1b2530;display:flex;gap:12px;align-items:center;z-index:9}#bar .st{color:#8aa0ad}#bar button{background:#153e5c;color:#e8eef3;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}</style>
</head><body>
<div id="bar"><b>GHRDP Web Desktop</b><span class="st" id="st">checking backend...</span><button id="re">Retry</button></div>
<div id="screen"></div>
<script type="module">
const st=document.getElementById('st');
const WS='ws://'+location.hostname+':7333/';
function wsProbe(url){return new Promise((res,rej)=>{let w;try{w=new WebSocket(url);}catch(e){rej(e);return;}const t=setTimeout(()=>{try{w.close();}catch(e){}rej(new Error('timeout - bridge not answering'));},5000);w.onopen=()=>{clearTimeout(t);try{w.close();}catch(e){}res(true);};w.onerror=()=>{clearTimeout(t);rej(new Error('websocket refused/blocked - firewall 7333 or websockify down'));};});}
let rfb=null;
async function boot(){
  st.textContent='checking backend...';
  try{
    const r=await fetch('/vncstatus',{cache:'no-store'});
    const j=await r.json();
    if(!j.ok){ st.textContent='backend down: vnc5900='+j.vnc+' bridge7333='+j.bridge+' - keep-alive self-heals every 2 min; click Retry'; return; }
  }catch(e){ st.textContent='cannot reach /vncstatus: '+e; return; }
  st.textContent='probing websocket '+WS+' ...';
  try{ await wsProbe(WS); }catch(e){ st.textContent='WS probe failed: '+e.message; return; }
  st.textContent='loading noVNC + connecting...';
  try{
    const mod=await import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.4.0/core/rfb.js');
    if(rfb){ try{rfb.disconnect();}catch(e){} }
    rfb=new mod.default(document.getElementById('screen'),WS,{});
    rfb.scaleViewport=true; rfb.clipboardCapable=true;
    rfb.addEventListener('connect',()=>{st.textContent='connected - clipboard active';});
    rfb.addEventListener('securityfailure',e=>{st.textContent='VNC security rejected: '+e.detail.reason+' (type '+e.detail.status+')';});
    rfb.addEventListener('disconnect',e=>{st.textContent='disconnected code='+((e.detail&&e.detail.code)||'none')+' reason='+((e.detail&&e.detail.reason)||'none')+' clean='+((e.detail&&e.detail.clean)||false)+' - Retry';});
    rfb.addEventListener('credentialsrequired',()=>{st.textContent='server demands a password but auth should be NONE - run PATCH 1 on the runner';});
  }catch(e){ st.textContent='noVNC load failed: '+e; }
}
document.getElementById('re').onclick=boot;
boot();
</script></body></html>
'@
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($htmlN))
            return
        }
        if ($path -eq '/vncstatus') {
            $vncUp = $false; $brUp = $false
            try { $vncUp = [bool](Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue) } catch { }
            try { $brUp = [bool](Get-NetTCPConnection -LocalPort 7333 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $outJ = @{ ok = ($vncUp -and $brUp); vnc = $vncUp; bridge = $brUp } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
            return
        }
        # [remediation 8C-extended] /install.ps1 body deleted; unreachable due to 404 guard above. It served the ghrdp:// handler installer — replaced by docs/AUTOLOGIN.md manual reg-add.
        if ($path -eq '/config') {
            $cfgOut = Remove-CredKeys (Read-JsonFile -Path $script:CfgPath)
            if ($cfgOut) {
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $cfgOut)
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing'))
            }
            return
        }
        if ($path -eq '/progress' -or $path -eq '/api/progress') {
            $prog = Read-JsonFile -Path $script:ProgPath
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
            if (-not $prog) {
                $prog = [ordered]@{
                    ts = ''
                    alive = $false
                    active = [ordered]@{ name = ''; phase = 'idle'; pct = 0 }
                    agg = [ordered]@{ total = 0; done = 0; failed = 0; active = 0; bytesDone = 0; bytesTotal = 0; overallPct = 0; speedBps = 0 }
                    telemetry = [ordered]@{ scans = 0; lastScan = ''; seen = 0; skippedJunk = 0; skippedSmall = 0; locked = 0; queued = 0; roots = @() }
                    archives = @()
                    files = @()
                    log = @()
                    speedHistory = @()
                }
            }
            $ip = ''; $us = ''; $pw = ''; $mk = ''; $tg = ''; $sv = ''; $fu = ''; $sa = ''; $rsa = ''; $ssa = ''; $em = 'none'; $lu = ''; $lk = ''; $rn = ''; $eg = ''
            $mirrorFlag = $false
            if ($cfg) {
                $tg = [string]$cfg.mirrorIndexUrl
                $sv = [string]$cfg.serveUrl; $fu = [string]$cfg.funnelUrl; $sa = [string]$cfg.startedAt
                $rsa = [string]$cfg.runStartedAt; $ssa = [string]$cfg.sessionStartedAt
                $em = if ([string]$cfg.encryptMode) { [string]$cfg.encryptMode } else { 'none' }
                $lu = [string]$cfg.legacyIndexUrl; $rn = [string]$cfg.rentryNewUrl; $eg = [string]$cfg.runnerEgressIp
                $mirrorFlag = [bool]$cfg.mirror
            }
            $sessionEnd = $null; $cands = @()
            foreach ($k in @('githubDeadline','keepAliveDeadline','watcherDeadline')) { $v = [string]$cfg.$k; if ($v) { try { $cands += [datetime]$v } catch { } } }
            if ($cands.Count) { $sessionEnd = ($cands | Measure-Object -Minimum).Minimum }
            $obj = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                mirror = $mirrorFlag
                encryptMode = $em
                ghrdp = [string]$cfg.ghrdp
                mirrorIndexUrl = $tg
                serveUrl = $sv
                funnelUrl = $fu
                startedAt = (To-IsoUtc $sa)
                runStartedAt = (To-IsoUtc $rsa)
                sessionStartedAt = (To-IsoUtc $ssa)
                sessionEnd = $(if ($sessionEnd) { $sessionEnd.ToString('o') } else { '' })
                legacyIndexUrl = $lu
                rentryNewUrl = $rn
                runnerEgressIp = $eg
                keepAliveDeadline = [string]$cfg.keepAliveDeadline
                keepAlivePhase = [string]$cfg.keepAlivePhase
                pagesBase = [string]$cfg.pagesBase
                ts = $prog.ts
                alive = [bool]$prog.alive
                active = $prog.active
                agg = $prog.agg
                telemetry = $prog.telemetry
                archives = $prog.archives
                files = $prog.files
                log = $prog.log
                progress = $prog
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj.conn = $conn
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj)
            return
        }
        if (($path -eq '/') -or ($path -eq '/index.html')) {
            $html = '<h1>Mission Control UI file missing</h1>'
            try { $html = [System.IO.File]::ReadAllText($script:UiPath, [System.Text.Encoding]::UTF8) } catch { }
            $ip = ''; $tg = ''
            if ($cfg) {
                $ip = [string]$cfg.rdpIp
                $tg = [string]$cfg.mirrorIndexUrl
            }
            $html = $html.Replace('__IP__', $ip).Replace('__TELEGRAPH__', $tg)
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        if ($path -eq '/rdp') {
            $rdpIp2 = ''; $rdpUser2 = ''
            if ($cfg) { $rdpIp2 = [string]$cfg.rdpIp; $rdpUser2 = [string]$cfg.rdpUser }
            $lines = @(
                'screen mode id:i:2',
                'desktopwidth:i:1920',
                'desktopheight:i:1080',
                'session bpp:i:32',
                'compression:i:1',
                'keyboardhook:i:2',
                'audiocapturemode:i:0',
                'videoplaybackmode:i:0',
                'connection type:i:3',
                'networkautodetect:i:0',
                'bandwidthautodetect:i:0',
                'disable wallpaper:i:1',
                'disable full window drag:i:1',
                'disable menu anims:i:1',
                'disable themes:i:0',
                'disable cursor setting:i:1',
                'bitmapcachepersist:i:1',
                'smart sizing:i:0',
                'redirectclipboard:i:1',
                'redirectprinters:i:0',
                'redirectcomports:i:0',
                'redirectsmartcards:i:0',
                'redirectdrives:i:0',
                'autoreconnection enabled:i:1',
                'prompt credential once:i:0',
                'enableworkspacereconnect:i:0',
                'use multimon:i:0',
                'enablerdpudp:i:1',
                ('full address:s:' + $rdpIp2),
                ('username:s:' + $rdpUser2),
                'prompt for credentials:i:1',
                'negotiate security layer:i:1'
            )
            $rdpTxt = ($lines -join "`r`n")
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/x-rdp-file; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($rdpTxt))
            return
        }
        if ($path -eq '/ping') {
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ts = (Get-Date -Format o); wire = $script:Wire })
            return
        }
        if ($path -eq '/health') {
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ws = $false; port = $Port; pid = $PID; ts = (Get-Date -Format o) })
            return
        }
        if ($path -eq '/api/config') {
            $cfgOut = Remove-CredKeys (Read-JsonFile -Path $script:CfgPath)
            # [F10 s3] dash-token-gated creds block: the FULL Windows and VNC
            # passwords are attached to creds ONLY when this request carries
            # the exact dashboard token in ?key= (constant-time compare).
            # Every other caller - tailnet IP alone is NOT enough - receives
            # the stripped object (fqdn/user/ip only). Nothing is logged.
            $gatedF10 = $false
            try {
                $qkF10 = ''
                if ($parts.query -and $parts.query.ContainsKey('key')) { $qkF10 = [string]$parts.query['key'] }
                if ($Token -and $qkF10 -and $qkF10.Length -eq ([string]$Token).Length) {
                    $b1 = [System.Text.Encoding]::UTF8.GetBytes($qkF10)
                    $b2 = [System.Text.Encoding]::UTF8.GetBytes([string]$Token)
                    if ([System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($b1, $b2)) { $gatedF10 = $true }
                }
            } catch { }
            if ($gatedF10 -and $cfgOut) {
                $cfgIn = Read-JsonFile -Path $script:CfgPath
                $pRdp = ''; $pVnc = ''
                try { if ($cfgIn -and $cfgIn.PSObject.Properties['rdpPass']) { $pRdp = [string]$cfgIn.rdpPass } } catch { }
                try { if ($cfgIn -and $cfgIn.PSObject.Properties['vncPass']) { $pVnc = [string]$cfgIn.vncPass } } catch { }
                try {
                    if (-not $cfgOut.PSObject.Properties['creds']) {
                        $cfgOut | Add-Member -MemberType NoteProperty -Name 'creds' -Value ([pscustomobject]@{ fqdn = ''; user = ''; ip = '' }) -Force
                    }
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'pass' -Value $pRdp -Force
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'vncPass' -Value $pVnc -Force
                } catch { }
            }
            if ($cfgOut) { Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $cfgOut) } else { Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing')) }
            return
        }
        if ($path -eq '/api/progress' -or $path -eq '/api/stats') {
            $prog2 = Read-JsonFile -Path $script:ProgPath
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
            if (-not $prog2) { $prog2 = [ordered]@{ ts=''; alive=$false; active=[ordered]@{name='';phase='idle';pct=0}; agg=[ordered]@{total=0;done=0;failed=0;active=0;bytesDone=0;bytesTotal=0;overallPct=0;speedBps=0}; telemetry=[ordered]@{scans=0;lastScan=''}; files=@(); log=@() } }
            $cfg2 = Read-JsonFile -Path $script:CfgPath
            $obj2 = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                kind = 'snapshot'
                mirror = [bool]$cfg2.mirror
                encryptMode = [string]$cfg2.encryptMode
                mirrorIndexUrl = [string]$cfg2.mirrorIndexUrl
                rentryNewUrl = [string]$cfg2.rentryNewUrl
                legacyIndexUrl = [string]$cfg2.legacyIndexUrl
                runnerEgressIp = [string]$cfg2.runnerEgressIp
                keepAliveDeadline = [string]$cfg2.keepAliveDeadline
                keepAlivePhase = [string]$cfg2.keepAlivePhase
                pagesBase = [string]$cfg2.pagesBase
                startedAt = (To-IsoUtc ([string]$cfg2.startedAt))
                runStartedAt = (To-IsoUtc ([string]$cfg2.runStartedAt))
                sessionStartedAt = (To-IsoUtc ([string]$cfg2.sessionStartedAt))
                progress = $prog2
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj2.conn = $conn
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj2)
            return
        }
        # [remediation 8B] /parsec-push removed: no plaintext rdpPass transit / ONLOGON credential push
        if ($path -eq '/parsec-push') {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('endpoint removed per remediation'))
            return
        }
        Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
    } catch {
        try { Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); handlerError = $_.Exception.Message }) } catch { }
    } finally {
        try { if ($stream) { $stream.Dispose() } } catch { }
        try { $Client.Close() } catch { }
    }
}
$script:Wire = $null
$lastWirePing = [datetime]::MinValue
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
$wireProbeScript = @'
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$out = 'C:\ghrdp\wire-probe.json'
$hist = New-Object System.Collections.ArrayList
while ($true) {
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); rtt = $null; via = 'unknown'; direct = $false; peerIp = ''; peerName = ''; jit = $null; hist = @() }
  try {
    $j = (& $ts status --json 2>$null) | ConvertFrom-Json
    $peer = $null
    if ($j -and $j.Peer) { foreach ($p in $j.Peer.PSObject.Properties) { if ($p.Value.Online) { $peer = $p.Value; break } } }
    if ($peer) {
      $obj.peerIp = @($peer.TailscaleIPs)[0]
      $obj.peerName = [string]$peer.HostName
      $o = (& $ts ping -c 1 --timeout 5s $obj.peerIp 2>$null) -join ' '
      if ($o -match 'in ([0-9]+)ms') { $obj.rtt = [int]$Matches[1] }
      if ($o -match 'via DERP\(([a-z0-9]+)\)') { $obj.via = 'DERP(' + $Matches[1] + ')'; $obj.direct = $false }
      elseif ($o -match 'via ([0-9][0-9.:]+)') { $obj.via = 'DIRECT ' + $Matches[1]; $obj.direct = $true }
      if ($null -ne $obj.rtt) { [void]$hist.Add([int]$obj.rtt); if ($hist.Count -gt 20) { $hist.RemoveAt(0) } }
      if ($hist.Count -ge 3) { $d = 0; for ($i = 1; $i -lt $hist.Count; $i++) { $d += [math]::Abs([int]$hist[$i] - [int]$hist[$i-1]) }; $obj.jit = [math]::Round($d / ($hist.Count - 1), 1) }
      $obj.hist = @($hist)
    }
  } catch { }
  try { [System.IO.File]::WriteAllText($out, ($obj | ConvertTo-Json -Compress)) } catch { }
  Start-Sleep -Seconds 4
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'wire-probe.ps1'), $wireProbeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'wire-probe.ps1') -WindowStyle Hidden } catch { }
# [F10 s2.2] runner-side ping probe: every 15s run `tailscale ping -c 1
# -timeout 3s <dash-token source peer>` and parse RTT + direct/DERP path to
# ping-probe.json (native-status exposes fresh results as pingMs/pingPath).
$pingProbeScript = @'
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$out = 'C:\ghrdp\ping-probe.json'
$peerFile = 'C:\ghrdp\dash-peer.txt'
try {
  $others = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*ping-probe.ps1*' -and $_.ProcessId -ne $PID }
  if ($others) { exit 0 }
} catch { }
while ($true) {
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); target = ''; ms = $null; path = 'unknown' }
  try {
    if (Test-Path -LiteralPath $peerFile) {
      $t0 = ([System.IO.File]::ReadAllText($peerFile)).Trim()
      if ($t0 -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') { $obj.target = $t0 }
    }
  } catch { }
  if ($obj.target) {
    try {
      $o = (& $ts ping -c 1 -timeout 3s $obj.target 2>&1) -join ' '
      if ($o -match 'in ([0-9.]+)\s*ms') { $obj.ms = [double]$Matches[1] }
      if ($o -match 'timeout|no peers|Unknown host|Bad arguments') { $obj.ms = $null }
      if ($null -ne $obj.ms) {
        if ($o -match 'via DERP') { $obj.path = 'relay' }
        elseif ($o -match 'via ') { $obj.path = 'direct' }
        else { $obj.path = 'unknown' }
      }
    } catch { }
  }
  try { [System.IO.File]::WriteAllText($out, ($obj | ConvertTo-Json -Compress)) } catch { }
  Start-Sleep -Seconds 15
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'ping-probe.ps1'), $pingProbeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'ping-probe.ps1') -WindowStyle Hidden } catch { }
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Bind), $Port)
try { $listener.Start() } catch {
    try { [System.IO.File]::WriteAllText($script:OkFile, 'LISTEN_FAIL: ' + $_.Exception.Message, $script:NoBom) } catch { }
    exit 1
}
[System.IO.File]::WriteAllText($script:OkFile, ('LISTENING pid={0} bind={1} port={2} at={3}' -f $PID, $Bind, $Port, (Get-Date -Format o)), $script:NoBom)
$probeScript = @'
$ErrorActionPreference='Continue'
$ts='C:\Program Files\Tailscale\tailscale.exe'
$out='C:\ghrdp\conn-probe.json'
while($true){
  $obj=@{ts=(Get-Date).ToString('o'); rtt=$null; via='unknown'; direct=$false; peer=''}
  try{
    $j=(& $ts status --json 2>$null)|ConvertFrom-Json
    if($j -and $j.Peer){
      foreach($p in $j.Peer.PSObject.Properties){
        $peer=$p.Value
        if($peer.Online){
          $obj.peer=@($peer.TailscaleIPs)[0]
          break
        }
      }
    }
    if($obj.peer){
      $o=(& $ts ping -c 1 --timeout 2s $obj.peer 2>$null) -join ' '
      if($o -match 'via (DERP[A-Za-z0-9]*|[Dd]irect[A-Za-z0-9]*)'){ $obj.via=$Matches[1]; $obj.direct=($Matches[1] -like 'irect*' -or $Matches[1] -like 'D*irect*') }
      if($o -match 'in ([0-9.]+)\s*ms'){ $obj.rtt=[double]$Matches[1] }
    }
  }catch{}
  try{ [System.IO.File]::WriteAllText($out,($obj|ConvertTo-Json -Compress)) }catch{}
  Start-Sleep -Seconds 4
}
'@
$probePath = Join-Path $Root 'conn-probe.ps1'
[System.IO.File]::WriteAllText($probePath, $probeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$probePath -WindowStyle Hidden } catch { }
$start = Get-Date
$limit = New-TimeSpan -Minutes $LimitMinutes
$lastHeal = Get-Date
while (((Get-Date) - $start) -lt $limit) {
    while ($listener.Pending()) {
        $client = $null
        try { $client = $listener.AcceptTcpClient() } catch { }
        if ($client) { Invoke-ClientRequest -Client $client -Token $script:Token }
    }
    if (((Get-Date) - $lastHeal).TotalSeconds -ge 60) {
        $lastHeal = Get-Date
        try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 50
}
try { $listener.Stop() } catch { }
