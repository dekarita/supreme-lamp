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
# [F43] v2 dashboard is the DEFAULT UI. Routing contract (fail-visible):
#   /?ui=v1  -> always serve v1 ui.html (one-release Classic UI escape)
#   /?ui=v2  -> serve ui-v2.html when staged; when NOT staged serve v1 PLUS the
#               red uiV2MissingBanner (F42 §2: silent v1 fallback is forbidden)
#   no param -> v2 (UiV2Default=$true); requested v2 but file missing -> v1 + banner
$script:UiV2Path = Join-Path $Root 'ui-v2.html'
$script:UiV2Default = $true
$script:InstPath = Join-Path $Root 'ghrdp-install.ps1'
# [F14 §2] the ONLY files GET /dl/<name> may serve. Exactly these three, never
# more: they carry no secrets, so no dash token is required for them. Anything
# else under /dl (including every other file in $Root) is a 404.
$script:DlNames = @('ghrdp-handler-kit.zip', 'install.cmd', 'ghrdp-rdp-launcher.cs')
$script:OkFile = Join-Path $Root 'server-ok.txt'
$script:FlushFlag = Join-Path $Root 'flush.flag'
# [F28 §1] Server start clock + the logon-result state file. The 30s scan tick
# runs in THIS process from start (see the listener loop), so the logon verdict
# exists even when no keep-alive step ever runs.
$script:ServerStartedUtc = (Get-Date).ToUniversalTime()
$script:LogonStatePath = Join-Path $Root 'rdp-logon.json'
# [F30 §3] server connection-log state (own file: same no-writer-race rule as
# the F28 logon state - main.yml only MIRRORS it into config.json).
$script:ConnLogStatePath = Join-Path $Root 'rdp-connlog.json'
# [F37 §4] live runner telescope (own 60s tick, own state file - never a writer
# race with the workflow) + the client beacon ring the launcher posts to.
$script:F37TelStatePath = Join-Path $Root 'rdp-listener-telescope.json'
$script:F37TelClientPath = Join-Path $Root 'rdp-telescope-client.jsonl'
$script:NoBom = New-Object System.Text.UTF8Encoding($false)
$script:WebDeskHtml = ''
$script:Token = ''
try {
    $tp = Join-Path $Root 'dash-token.txt'
    if (Test-Path -LiteralPath $tp) { $script:Token = ([System.IO.File]::ReadAllText($tp)).Trim() }
} catch { }
$script:RdpTokens = @{}
# [F30 §2.2 purge-cmd-begin] The "nuclear option" the operator runs on THEIR PC:
# ONE PowerShell line that deletes EVERY TERMSRV credential whose LastWritten is
# older than 7 days (cmdkey /list cannot show ages - the store API can). It
# shells out to nothing, types nothing into any window, and prints only a COUNT;
# no credential value is ever read, logged or transmitted. Served ONLY by the
# dash-token-gated /api/purge-stale-creds route.
$script:F30PurgeType = 'using System;using System.Runtime.InteropServices;public static class GhrdpCredPurge{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct C{public uint Flags;public uint Type;public string TargetName;public string Comment;public long LastWritten;public uint BlobSize;public IntPtr Blob;public uint Persist;public uint AttrCount;public IntPtr Attrs;public string Alias;public string User;}[DllImport("advapi32.dll",EntryPoint="CredEnumerateW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool Enum(string f,uint fl,out uint n,out IntPtr a);[DllImport("advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool Del(string t,uint ty,uint fl);[DllImport("advapi32.dll")]public static extern void Free(IntPtr p);public static int Purge(int days){uint n=0;IntPtr a=IntPtr.Zero;int killed=0;if(!Enum("TERMSRV/*",0,out n,out a)){return 0;}try{DateTime floor=DateTime.UtcNow.AddDays(-days);for(uint i=0;i<n;i++){IntPtr it=Marshal.ReadIntPtr(a,(int)i*IntPtr.Size);if(it==IntPtr.Zero){continue;}C c=(C)Marshal.PtrToStructure(it,typeof(C));if(c.TargetName==null){continue;}if(!c.TargetName.StartsWith("TERMSRV/",StringComparison.OrdinalIgnoreCase)){continue;}DateTime w=DateTime.MinValue;try{w=DateTime.FromFileTimeUtc(c.LastWritten);}catch{}if(w>floor){continue;}if(Del(c.TargetName,c.Type,0)){killed++;}}}finally{Free(a);}return killed;}}'
$script:F30PurgeCommand = 'Add-Type -TypeDefinition ' + [char]39 + $script:F30PurgeType + [char]39 + '; ''purged '' + [GhrdpCredPurge]::Purge(7) + '' TERMSRV entries older than 7 days'''
# [F30 §2.2 purge-cmd-end]
$script:LauncherSeen = $false
$script:HandlerChain = @()
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
# [F17 §2] ROOT CAUSE of the +05:30 beacon-age bug (19805s): stored ISO ts
# strings were read back through ConvertFrom-Json, which converts "…Z" into a
# [datetime] in the SERVER'S LOCAL timezone and then [string] renders it
# WITHOUT the Z - the dashboard parsed that bare ts as the VISITOR'S local
# time and inflated the beacon age by the local-UTC offset. Contract now:
# every stored ts is re-extracted from the RAW file text and parsed with
# DateTime.Parse(..., RoundtripKind) - an explicit offset is honored, a bare
# ts is UTC, never local.
function Get-RawJsonTs {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return '' }
        $raw = [System.IO.File]::ReadAllText($Path)
        if ($raw -match '"ts"\s*:\s*"([^"]+)"') { return $Matches[1] }
    } catch { }
    return ''
}
function ConvertTo-UtcDateTime {
    param($Ts)
    try {
        if ($null -eq $Ts) { return $null }
        if ($Ts -isnot [datetime]) {
            $s = [string]$Ts
            if (-not $s) { return $null }
            $Ts = [datetime]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
        }
        if ($Ts.Kind -eq [System.DateTimeKind]::Unspecified) { $Ts = New-Object System.DateTime($Ts.Ticks, [System.DateTimeKind]::Utc) }
        return $Ts.ToUniversalTime()
    } catch { return $null }
}
function Get-UtcAgeSeconds {
    param($Ts)
    $dt = ConvertTo-UtcDateTime $Ts
    if ($null -eq $dt) { return $null }
    return [int]([datetime]::UtcNow - $dt).TotalSeconds
}
function ConvertTo-UtcIso {
    param($Ts)
    $dt = ConvertTo-UtcDateTime $Ts
    if ($null -eq $dt) { return '' }
    return $dt.ToString('o')
}
# [F17 §2] per-run beacon store: a handler-hello-last.json left over from a
# PRIOR run (re-dispatch on the same host, or a VPS) would render a stale
# beacon row as if THIS run's launcher had reported. Reset at server start so
# every beacon row is per-run only.
foreach ($f17bf in @('handler-hello-last.json', 'launcher-hello-last.json')) {
    try { Remove-Item -LiteralPath (Join-Path $Root $f17bf) -Force -ErrorAction SilentlyContinue } catch { }
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
                # [F42 §1] the live ticket link was /?key=<token>?ui=v2: the
                # SECOND '?' is not a separator, so a raw split on '&' left
                # ui=v2 glued onto the key and the ui param was never parsed
                # (v1 rendered). Normalise EVERY literal '?' after the FIRST
                # one to '&' BEFORE splitting; url-decode per pair AFTER the
                # split, so an encoded %3F inside a value stays a value.
                $qNorm = ($target.Substring($qAt + 1)).Replace('?', '&')
                foreach ($kv in ($qNorm -split '&')) {
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
function Test-IsLoopbackAddr {
    # [F10-15] `$ip.IsLoopback` resolved to $false for a genuine 127.0.0.1
    # remote endpoint on the Windows lab host (probe annotation: addr=127.0.0.1
    # family=InterNetwork isloopback=<empty> verdict=False), so loopback clients
    # were silently 401'd by Test-ClientAllowed. Use the static API plus an
    # explicit 127.0.0.0/8 byte check; both are valid on every PowerShell.
    param($Ip)
    try {
        if ($Ip) {
            if ([System.Net.IPAddress]::IsLoopback($Ip)) { return $true }
            $ob = $Ip.GetAddressBytes()
            if ($ob.Length -eq 4 -and $ob[0] -eq 127) { return $true }
        }
    } catch { }
    return $false
}
function Test-ClientAllowed {
    param($Client, $Query, $Token)
    try {
        $ip = $Client.Client.RemoteEndPoint.Address
        if (Test-IsLoopbackAddr $ip) { return $true }
        if (Test-TicketSource $ip) { return $true }
        $oct = $ip.GetAddressBytes()
        if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) { return $true }
    } catch { }
    if ([string]::IsNullOrEmpty($Token)) { return $true }
    if ($Query -and $Query.ContainsKey('key') -and ([string]$Query['key'] -eq [string]$Token)) { return $true }
    return $false
}
function Test-CredsAllowed {
    # [F10-2 §3] STRICTER than Test-ClientAllowed: passwords may leave this
    # host only for (a) a request carrying the dash token, or (b) a source IP
    # inside the tailnet CGNAT range (the operator's own device). Bare
    # loopback (self-tests, local probes) never receives the creds block.
    param($Client, $Query, $Token)
    try {
        $ip = $Client.Client.RemoteEndPoint.Address
        $oct = $ip.GetAddressBytes()
        if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) { return $true }
    } catch { }
    if (-not [string]::IsNullOrEmpty($Token) -and $Query -and $Query.ContainsKey('key') -and ([string]$Query['key'] -eq [string]$Token)) { return $true }
    return $false
}
# [F27 ticket-core-begin] Direct socket source only; never trust forwarded headers.
$script:TicketAudit = [ordered]@{ issued = 0; redeemed = 0; rejected = 0 }
function Test-TicketBearer([byte[]]$Received, [byte[]]$Expected) {
    if ($Received.Length -ne $Expected.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $Expected.Length; $i++) { $diff = $diff -bor ($Received[$i] -bxor $Expected[$i]) }
    return ($diff -eq 0)
}
function Test-TicketSource([System.Net.IPAddress]$Ip) {
    if (-not $Ip) { return $false }
    if ($Ip.IsIPv4MappedToIPv6) { $Ip = $Ip.MapToIPv4() }
    $b = $Ip.GetAddressBytes()
    return (($b.Length -eq 4 -and $b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127) -or
        ($b.Length -eq 16 -and $b[0] -eq 0xfd -and $b[1] -eq 0x7a -and $b[2] -eq 0x11 -and $b[3] -eq 0x5c -and $b[4] -eq 0xa1 -and $b[5] -eq 0xe0))
}
function Write-TicketAudit([string]$Event, [string]$Source) {
    $script:TicketAudit[$Event]++
    $row = @{ ts = [datetime]::UtcNow.ToString('o'); source = $Source; counts = $script:TicketAudit }
    try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), (($row | ConvertTo-Json -Compress) + "`n")) } catch { }
}
function Use-RdpTicket([string]$Ticket, [System.Net.IPAddress]$Source, [datetime]$Now) {
    if (-not (Test-TicketSource $Source)) { return $false }
    if ($Ticket -notmatch '^[0-9a-f]{32}$' -or -not $script:RdpTokens.ContainsKey($Ticket)) { return $false }
    $entry = $script:RdpTokens[$Ticket]
    # Bind to the issuing PC as well as requiring a direct tailnet source.
    if ($entry.source -ne $Source.ToString()) { return $false }
    $script:RdpTokens.Remove($Ticket) # consume before response, including expired tickets
    $age = ($Now - $entry.created).TotalSeconds
    return ($age -ge 0 -and $age -lt 60)
}
# [F27 ticket-core-end]

# [F28 §1 scanner-begin] SERVER-SIDE LOGON-RESULT SCANNER (secret-free).
# The dashboard could only show 4624/4625 COUNTS from the workflow's keep-alive
# tick (F24), so nobody could see whether an mstsc attempt actually LOGGED ON.
# This scanner runs as an INDEPENDENT 30s tick inside the server process - from
# SERVER START, never dependent on the keep-alive step - and stamps
# rdpListener.authLast = {result: success|failed|none, sub, eventTs, scanTs}.
# scanTs is written on EVERY scan (success, failure, empty window AND a
# security-log-unreadable probe error), so the dashboard can distinguish
# "scanned <ts>, nothing yet" from a dead collector. Reads ONLY the event id,
# LogonType, Status/SubStatus/FailureReason codes and TargetUserName of 4624
# (LogonType 10) / 4625: never a password, a domain or an address. Extracted
# VERBATIM by the F28 gate + lab cell and driven with synthetic event XML.
$script:F28IntervalSec = 30
$script:F28WindowSec = 3600
$script:F28StaleSec = 90
$script:F28Scans = 0
$script:F28LastProbeError = ''
function Get-RdpLogonEventFields {
    param([xml]$Xml)
    $id = ''
    $t = ''
    $name = @{}
    try { $id = [string]($Xml.SelectSingleNode("//*[local-name()='EventID']")).InnerText } catch { }
    try { $t = [string]($Xml.SelectSingleNode("//*[local-name()='TimeCreated']").GetAttribute('SystemTime')) } catch { }
    try {
        foreach ($d in @($Xml.SelectNodes("//*[local-name()='Data']"))) {
            $n = [string]$d.GetAttribute('Name')
            if ($n) { $name[$n] = [string]$d.InnerText }
        }
    } catch { }
    return [pscustomobject]@{
        id        = $id.Trim()
        timeUtc   = $t
        status    = ([string]$name['Status']).Trim().ToUpperInvariant()
        subStatus = ([string]$name['SubStatus']).Trim().ToUpperInvariant()
        reason    = ([string]$name['FailureReason']).Trim()
        logonType = ([string]$name['LogonType']).Trim()
        targetUserName = ([string]$name['TargetUserName']).Trim()
    }
}
function Get-RdpLogonSubMeaning {
    param([string]$Code)
    switch (([string]$Code).Trim().ToUpperInvariant()) {
        '0XC000006A' { return 'wrong-password' }
        '0XC000006D' { return 'bad-user-or-password' }
        '0XC0000064' { return 'no-such-user' }
        '0XC000015B' { return 'logon-type-denied' }
        '0XC0000234' { return 'account-locked' }
        '0XC0000072' { return 'account-disabled' }
        '0XC000006E' { return 'account-restriction' }
        '0XC000006F' { return 'time-restriction' }
        '0XC0000070' { return 'workstation-restriction' }
        '0XC0000071' { return 'credential-expired' }
        default { if ($Code) { return 'other' } return '' }
    }
}
function Get-RdpLogonAuthLast {
    # Pure: items in, verdict out. scanTs is ALWAYS stamped - the only way the
    # dashboard can tell "scanned, nothing yet" from "collector not running".
    param($Items, [datetime]$ScanStartedUtc, [string]$ProbeError = '')
    $scanTs = (Get-Date).ToUniversalTime().ToString('o')
    $nowUtc = (Get-Date).ToUniversalTime()
    $windowStart = $ScanStartedUtc.AddSeconds(-120)
    $floor = $nowUtc.AddSeconds(-1 * $script:F28WindowSec)
    if ($windowStart -lt $floor) { $windowStart = $floor }
    $okWhen = $null; $okTs = ''
    $failWhen = $null; $failTs = ''; $failSub = ''
    $c4624 = 0; $c4625 = 0
    foreach ($it in @($Items)) {
        if (-not $it) { continue }
        if ([string]$it.logonType -ne '10' -and [string]$it.id -eq '4624') { continue }
        $when = $null
        try {
            $when = [datetime]::Parse([string]$it.timeUtc, [System.Globalization.CultureInfo]::InvariantCulture,
                ([System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal))
        } catch { $when = $null }
        if ($null -ne $when) {
            if ($when -lt $windowStart) { continue }
            if ($when -gt $nowUtc.AddSeconds(120)) { continue }
        }
        if ([string]$it.id -eq '4624') {
            # LogonType 10 (RemoteInteractive) only: a console/service logon is
            # never an RDP success.
            if ([string]$it.logonType -eq '10') {
                $c4624++
                if (($null -eq $okWhen) -or ($null -eq $when) -or ($when -ge $okWhen)) { $okWhen = $when; $okTs = [string]$it.timeUtc }
            }
            continue
        }
        if ([string]$it.id -ne '4625') { continue }
        $c4625++
        if (($null -eq $failWhen) -or ($null -eq $when) -or ($when -ge $failWhen)) {
            $failWhen = $when; $failTs = [string]$it.timeUtc; $failSub = ([string]$it.subStatus).ToUpperInvariant()
        }
    }
    $result = 'none'; $eventTs = ''; $sub = ''
    if ($null -ne $okWhen -and ($null -eq $failWhen -or $okWhen -ge $failWhen)) {
        $result = 'success'; $eventTs = $okTs
    } elseif ($null -ne $failWhen) {
        $result = 'failed'; $eventTs = $failTs; $sub = $failSub
    }
    return [pscustomobject]@{
        result      = $result
        sub         = $sub
        eventTs     = $eventTs
        scanTs      = $scanTs
        windowSec   = $script:F28WindowSec
        windowStart = $windowStart.ToString('o')
        count4624   = $c4624
        count4625   = $c4625
        subMeaning  = (Get-RdpLogonSubMeaning -Code $sub)
        probeError  = $ProbeError
    }
}
function Update-RdpLogonAuthLast {
    # The tick body: read the runner's OWN Security log, stamp, persist. It
    # never throws (a dead probe stamps result=none + probeError + scanTs) and
    # writes ONLY the allowlisted fields above.
    param([string]$StatePath, [datetime]$ScanStartedUtc)
    $items = @()
    $probeErr = ''
    try {
        $since = $ScanStartedUtc.AddSeconds(-120)
        $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(4624, 4625); StartTime = $since.ToLocalTime() } -MaxEvents 400 -ErrorAction Stop)
        foreach ($e in $raw) { $items += (Get-RdpLogonEventFields -Xml ([xml]$e.ToXml())) }
    } catch { $probeErr = 'security-log-unreadable' }
    $sum = Get-RdpLogonAuthLast -Items $items -ScanStartedUtc $ScanStartedUtc -ProbeError $probeErr
    try { [System.IO.File]::WriteAllText($StatePath, ($sum | ConvertTo-Json -Depth 5 -Compress), $script:NoBom) } catch { }
    $script:F28Scans = [int]$script:F28Scans + 1
    $script:F28LastProbeError = $probeErr
    Write-Host ('[F28] logon scan #' + $script:F28Scans + ' result=' + $sum.result +
        ' sub=' + $(if ($sum.sub) { $sum.sub } else { '-' }) +
        ' eventTs=' + $(if ($sum.eventTs) { $sum.eventTs } else { '-' }) +
        ' 4624=' + $sum.count4624 + ' 4625=' + $sum.count4625 +
        ' scanTs=' + $sum.scanTs + $(if ($probeErr) { ' probeError=' + $probeErr } else { '' }))
    return $sum
}
function Get-RdpLogonCollectorState {
    # Read-back for /api/native-status: authLast plus the collector's own
    # liveness (a missing or >90s stale state file is NOT a green collector).
    param([string]$StatePath, [datetime]$ServerStartedUtc)
    $authLast = $null
    $ageSec = $null
    if (Test-Path -LiteralPath $StatePath) {
        $authLast = Read-JsonFile -Path $StatePath
        try { $ageSec = [int]((Get-Date) - (Get-Item -LiteralPath $StatePath).LastWriteTime).TotalSeconds } catch { $ageSec = $null }
    }
    $uptime = [int]((Get-Date).ToUniversalTime() - $ServerStartedUtc).TotalSeconds
    $alive = $false
    if ($null -ne $ageSec) { $alive = ($ageSec -le $script:F28StaleSec) } else { $alive = ($uptime -le $script:F28StaleSec) }
    $collector = [ordered]@{
        intervalSec = $script:F28IntervalSec
        staleSec    = $script:F28StaleSec
        scans       = [int]$script:F28Scans
        alive       = $alive
        startedAt   = $ServerStartedUtc.ToString('o')
        uptimeSec   = $uptime
        lastScanAgeSec = $ageSec
        probeError  = [string]$script:F28LastProbeError
    }
    return [pscustomobject]@{ authLast = $authLast; logonCollector = $collector }
}
# [F28 §1 scanner-end]

# [F30 §3 connlog-begin] SERVER CONNECTION-LOG COLLECTOR (secret-free).
# Ground truth 2026-09-26: the client is dropped DURING the TLS handshake and
# 4624/4625 never fire, so the Security log is BLIND to it. These two RDP
# Operational logs are where the handshake/cert/listener events actually land:
#   Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational
#   Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational
# The collector runs on its OWN 30s tick inside the server process (same shape as
# the F28 logon scanner, from SERVER START - never dependent on the keep-alive
# step), keeps the last 10 events of EACH log, and stamps a small state file the
# dashboard renders as "SERVER CONN LOG" (newest 3 + reason codes). It stores
# only: EventID, provider, TimeCreated, level, a 200-char clipped description and
# a derived reason code - never a credential, and credential-shaped text is
# redacted before it is stored or shown.
$script:F30ConnLogIntervalSec = 30
$script:F30ConnLogStaleSec = 90
$script:F30ConnLogPerLog = 10
$script:F30ConnLogMaxItems = 12
$script:F30ConnLogSources = @(
    'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational',
    'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational'
)
$script:F30ConnLogScans = 0
$script:F30ConnLogLastProbeError = ''
# The lab dot-sources THIS block alone, so the shared no-BOM encoder may not
# exist yet: create it if missing (an undefined encoding makes WriteAllText
# throw and the state file would simply never appear - a silent blackout).
if (-not (Get-Variable -Name NoBom -Scope Script -ErrorAction SilentlyContinue)) {
    $script:NoBom = New-Object System.Text.UTF8Encoding($false)
}
function Get-RdpConnLogEventFields {
    param([xml]$Xml, [string]$Provider)
    $id = ''
    $t = ''
    $lvl = ''
    $msg = ''
    try { $id = [string]($Xml.SelectSingleNode("//*[local-name()='EventID']")).InnerText } catch { }
    try { $t = [string]($Xml.SelectSingleNode("//*[local-name()='TimeCreated']").GetAttribute('SystemTime')) } catch { }
    try { $lvl = [string]($Xml.SelectSingleNode("//*[local-name()='Level']")).InnerText } catch { }
    try { $msg = [string]($Xml.SelectSingleNode("//*[local-name()='RenderingInfo']")).InnerText } catch { }
    if (-not $msg) { try { $msg = [string]($Xml.SelectSingleNode("//*[local-name()='EventData']")).InnerText } catch { } }
    $desc = ''
    if ($msg) {
        $desc = ($msg -replace '\s+', ' ').Trim()
        # Defensive redaction: this line is DISPLAYED, so a credential-shaped
        # token in prose can never reach it (event messages carry none today).
        $desc = $desc -replace '(?i)(password|passwd|pwd|subjectusername|targetusername|subjectdomainname)(\s*[=:]\s*)\S+', '$1$2[redacted]'
        if ($desc.Length -gt 200) { $desc = $desc.Substring(0, 200) }
    }
    return [pscustomobject]@{
        id       = $id.Trim()
        provider = $Provider
        timeUtc  = $t
        level    = $lvl.Trim()
        desc     = $desc
        reason   = (Get-RdpConnLogReason -Provider $Provider -Id $id -Level $lvl -Text $desc)
    }
}
function Get-RdpConnLogReason {
    # reason codes, derived from the stored fields only (never a guess about a
    # host we cannot see): tls-forcibly-closed | tls-handshake-failed |
    # cert-rejected | connection-reset | auth-succeeded | auth-failed |
    # listener-lifecycle | session-state | event-<id> | other
    param([string]$Provider, [string]$Id, [string]$Level, [string]$Text)
    $t = ([string]$Text).ToLowerInvariant()
    $p = ([string]$Provider).ToLowerInvariant()
    $evt = ([string]$Id).Trim()
    if ($p -match 'schannel' -and $evt -eq '36870') {
        if ($t -match '0x[0-9a-f]{8}') { return ('key-open-failed:' + $Matches[0]) }
        return 'key-open-failed:unknown'
    }
    if ($p -match 'schannel' -and $evt -eq '36888') {
        if ($t -match 'error state (?:is )?(\d+)') { return ('tls-alert-sent:' + $Matches[1]) }
        return 'tls-alert-sent:unknown'
    }
    if ($t -match 'forcibly closed') { return 'tls-forcibly-closed' }
    # certificate FIRST: a cert failure message also says "TLS ... failed", and
    # 'cert-rejected' is the actionable reason code for it.
    if ($t -match 'certificat') { return 'cert-rejected' }
    if ($t -match 'handshake' -and ($t -match 'fail|error|abort|denied')) { return 'tls-handshake-failed' }
    if ($t -match 'schannel|tls' -and ($t -match 'fail|error|fatal')) { return 'tls-handshake-failed' }
    if ($t -match 'reset' -and $t -match 'connection|peer|transport') { return 'connection-reset' }
    if ($t -match 'authenticat' -and $t -match 'succeed|success') { return 'auth-succeeded' }
    if ($t -match 'authenticat' -and $t -match 'fail|denied|reject') { return 'auth-failed' }
    if ($t -match 'listen') { return 'listener-lifecycle' }
    if ($t -match 'session') { return 'session-state' }
    if ($p -match 'rdpcorets' -and $evt -in @('100', '101', '102', '103', '104', '105', '106', '107', '108', '110', '131')) { return 'listener-lifecycle' }
    if ($evt) { return ('event-' + $evt) }
    return 'other'
}
function Get-RdpConnLog {
    # PURE: items in, display shape out (newest first, newest 3 flagged for the
    # dashboard row). probeError is named on every scan so a dead collector can
    # never look like a clean log.
    param([object[]]$Items, [datetime]$ScanStartedUtc, [string]$ProbeError = '')
    $scanTs = (Get-Date).ToUniversalTime().ToString('o')
    $sorted = @($Items | Sort-Object -Property timeUtc -Descending)
    $items = @()
    $n = 0
    foreach ($it in $sorted) {
        if ($n -ge $script:F30ConnLogMaxItems) { break }
        $items += [pscustomobject]@{
            id       = [string]$it.id
            provider = [string]$it.provider
            timeUtc  = [string]$it.timeUtc
            level    = [string]$it.level
            reason   = [string]$it.reason
            desc     = [string]$it.desc
        }
        $n++
    }
    $reasons = @($items | ForEach-Object { $_.reason } | Select-Object -First 3)
    return [pscustomobject]@{
        ts          = $scanTs
        scanTs      = $scanTs
        windowStart = (Get-RdpConnLogWindowStart -ScanStartedUtc $ScanStartedUtc)
        items       = $items
        newest      = @($items | Select-Object -First 3)
        topReasons  = $reasons
        count       = $items.Count
        probeError  = $ProbeError
        intervalSec = $script:F30ConnLogIntervalSec
        staleSec    = $script:F30ConnLogStaleSec
        perLog      = $script:F30ConnLogPerLog
        sources     = $script:F30ConnLogSources
    }
}
function Get-RdpConnLogWindowStart {
    param([datetime]$ScanStartedUtc)
    return $ScanStartedUtc.AddSeconds(-1 * $script:F30ConnLogIntervalSec).ToString('o')
}
function Update-RdpConnLog {
    # The tick body: read the last 10 events of BOTH RDP Operational logs, stamp,
    # persist. Never throws (a dead probe stamps probeError + scanTs).
    param([string]$StatePath, [datetime]$ScanStartedUtc)
    $items = @()
    $failed = @()
    foreach ($logName in $script:F30ConnLogSources) {
        try {
            $since = (Get-Date).ToLocalTime().AddSeconds(-300)
            $raw = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $since } -MaxEvents $script:F30ConnLogPerLog -ErrorAction Stop)
            foreach ($e in $raw) {
                $prov = $logName.Split('/')[0] -replace '^Microsoft-Windows-', ''
                $items += (Get-RdpConnLogEventFields -Xml ([xml]$e.ToXml()) -Provider $prov)
            }
        } catch { $failed += $logName }
    }
    $probeErr = ''
    if ($failed.Count -eq $script:F30ConnLogSources.Count) { $probeErr = 'conn-logs-unreadable' }
    elseif ($failed.Count -gt 0) { $probeErr = 'partial:' + (($failed | ForEach-Object { $_.Split('/')[0] -replace '^Microsoft-Windows-', '' }) -join '+') }
    $sum = Get-RdpConnLog -Items $items -ScanStartedUtc $ScanStartedUtc -ProbeError $probeErr
    try { [System.IO.File]::WriteAllText($StatePath, ($sum | ConvertTo-Json -Depth 6 -Compress), $script:NoBom) }
    catch {
        # A state file that never appears is a silent blackout: retry with the
        # default encoding and, if even that fails, say so in probeError.
        try { [System.IO.File]::WriteAllText($StatePath, ($sum | ConvertTo-Json -Depth 6 -Compress)) }
        catch {
            $probeErr = 'state-write-failed: ' + $_.Exception.Message
            $sum | Add-Member -NotePropertyName probeError -NotePropertyValue $probeErr -Force
        }
    }
    $script:F30ConnLogScans = [int]$script:F30ConnLogScans + 1
    $script:F30ConnLogLastProbeError = $probeErr
    $head = ''
    if ($sum.count -gt 0) { $head = ($sum.newest | ForEach-Object { ('[' + $_.id + ' ' + $_.reason + ']') }) -join ' ' }
    Write-Host ('[F30] conn-log scan #' + $script:F30ConnLogScans + ' items=' + $sum.count +
        ' reasons=' + $(if ($head) { $head } else { '(none)' }) +
        ' scanTs=' + $sum.scanTs + $(if ($probeErr) { ' probeError=' + $probeErr } else { '' }))
    return $sum
}
function Get-RdpConnLogState {
    # Read-back for /api/native-status: newest items + collector liveness (a
    # missing or >90s stale state file is NOT a clean log).
    param([string]$StatePath, [datetime]$ServerStartedUtc)
    $state = $null
    $ageSec = $null
    if (Test-Path -LiteralPath $StatePath) {
        $state = Read-JsonFile -Path $StatePath
        try { $ageSec = [int]((Get-Date) - (Get-Item -LiteralPath $StatePath).LastWriteTime).TotalSeconds } catch { $ageSec = $null }
    }
    $uptime = [int]((Get-Date).ToUniversalTime() - $ServerStartedUtc).TotalSeconds
    $alive = $false
    if ($null -ne $ageSec) { $alive = ($ageSec -le $script:F30ConnLogStaleSec) } else { $alive = ($uptime -le $script:F30ConnLogStaleSec) }
    $collector = [ordered]@{
        intervalSec = $script:F30ConnLogIntervalSec
        staleSec    = $script:F30ConnLogStaleSec
        perLog      = $script:F30ConnLogPerLog
        scans       = [int]$script:F30ConnLogScans
        alive       = $alive
        uptimeSec   = $uptime
        lastScanAgeSec = $ageSec
        probeError  = [string]$script:F30ConnLogLastProbeError
        sources     = $script:F30ConnLogSources
    }
    return [pscustomobject]@{ connLog = $state; connLogCollector = $collector }
}
function Get-F30TlsNormState {
    # [F30 §1] Read the normalization stamp the workflow's F30 step wrote
    # (C:\ghrdp\tls-norm.json): what the server ACTUALLY enabled/ordered. Served
    # so the dashboard can show the server-side cipher state next to the client
    # copy-lines - never a credential, never a private key.
    param([string]$StatePath)
    if (-not $StatePath -or -not (Test-Path -LiteralPath $StatePath)) { return $null }
    $st = Read-JsonFile -Path $StatePath
    if (-not $st) { return $null }
    $age = Get-UtcAgeSeconds (Get-RawJsonTs $StatePath)
    if ($null -ne $age -and -not $st.PSObject.Properties['ageSec']) {
        $st | Add-Member -NotePropertyName ageSec -NotePropertyValue ([int]$age) -Force
    }
    return $st
}
# [F30 §3 connlog-end]
# [F45 S4 fx-module-begin] EXPLORER FILE-API ROUTES. The route implementation
# lives in payloads/ghrdp-fx.ps1 (deployed next to this script) and is
# dot-sourced here, never copied: the server and tests/f45-fx-server.ps1 execute
# the SAME functions. $script:FxReady is the fail-visible flag the dispatch
# below honours - a missing module answers 503 on every /api/fx/* route instead
# of pretending the API exists.
$script:FxModule = ''
$script:FxReady = $false
$script:FxLoadError = ''
$script:FxCsrf = ''
foreach ($fxCand in @((Join-Path $Root 'ghrdp-fx.ps1'), (Join-Path $PSScriptRoot 'ghrdp-fx.ps1'))) {
    try {
        if ($script:FxReady) { break }
        if ($fxCand -and (Test-Path -LiteralPath $fxCand -PathType Leaf)) {
            . $fxCand
            $script:FxModule = $fxCand
            $script:FxReady = $true
        }
    } catch {
        $script:FxLoadError = ('module load failed: ' + $_.Exception.Message)
    }
}
if (-not $script:FxReady) { $script:FxLoadError = ('ghrdp-fx.ps1 not found next to the server at ' + $Root) }
# [F46 §3/§5] mirror host module (documented gofile contract + attempt policy +
# READ-ONLY probe). Dot-sourced for the Diagnose surface; the watcher's mirror
# worker and the Explorer uploader execute the SAME functions. A missing module
# is fail-visible in /diag and in every upload reason - never silent.
$script:F46MirrorReady = $false
foreach ($f46cand in @((Join-Path $Root 'ghrdp-mirror.ps1'), (Join-Path $PSScriptRoot 'ghrdp-mirror.ps1'))) {
    if ($script:F46MirrorReady) { break }
    if ($f46cand -and (Test-Path -LiteralPath $f46cand -PathType Leaf)) {
        try {
            . $f46cand
            $script:F46MirrorReady = $true
        } catch {
            $script:F46MirrorReady = $false
        }
    }
}
if (-not $script:F46MirrorReady) { $script:F46MirrorLoadError = ('ghrdp-mirror.ps1 not found next to the server at ' + $Root) }
# §1.5/§1.6 CSRF token: one per server process, 24 random bytes, never logged.
# It reaches the dashboard as the JS-readable SameSite=Strict cookie
# ghrdp_fx_csrf (and the X-CSRF-Token response header on /api/fx/list); a POST
# without it is refused with 403.
try {
    $fxCsrfBytes = New-Object byte[] 24
    $fxCsrfRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $fxCsrfRng.GetBytes($fxCsrfBytes) } finally { $fxCsrfRng.Dispose() }
    $script:FxCsrf = ([BitConverter]::ToString($fxCsrfBytes)).Replace('-', '').ToLowerInvariant()
} catch { $script:FxCsrf = '' }
# [F45 S4 fx-module-end]
# [F37 §4 telescope-begin] LIVE RUNNER TELESCOPE (secret-free).
# The runner keeps its OWN observability: a 60s tick runs the SINGLE telescope
# implementation (payloads/rdp-telescope.ps1 - dot-sourced here, never a copy)
# against the listener this host serves and stamps the result so
# /api/native-status can show boundThumb vs servedThumb LIVE (bind drift is
# visible instantly), the key container + its ACL SIDs, and the Schannel tail.
# If the module is not deployed the row still explains itself (ok=false,
# why='module missing') - a silent absence would be a red-without-why again.
$script:F37TelIntervalSec = 60
# LAB-ONLY shortening (GHRDP_LAB_TEL_INTERVAL_SEC): lets the Windows lab
# observe a FRESH sample without waiting a full production minute. Accepted only
# as a plain number in [5,600]; production main.yml carries no GHRDP_LAB_
# switch at all (launch-gates F17 proves it), so production is always 60.
try {
    $f37LabInt = [string]$env:GHRDP_LAB_TEL_INTERVAL_SEC
    if ($f37LabInt -match '^\d{1,3}$') {
        $f37LabVal = [int]$f37LabInt
        if ($f37LabVal -ge 5 -and $f37LabVal -le 600) { $script:F37TelIntervalSec = $f37LabVal }
    }
} catch { }
$script:F37TelStaleSec = 180
$script:F37TelMaxClient = 60
$script:F37TelSlugRe = '^telescope-(dns|tcp)-(ok|fail)$|^telescope-tls-(ok|fail)$|^telescope-cred-(ok|missing)$|^telescope-(rst-before-cert|chain|name-mismatch|eku)$'
$script:F37TelModule = ''
$script:F37TelScans = 0
$script:F37TelLastError = ''
$script:F37TelLastWarn = ''
$script:F37ClientBeacons = @()
foreach ($f37cand in @((Join-Path $Root 'rdp-telescope.ps1'), (Join-Path $PSScriptRoot 'rdp-telescope.ps1'))) {
    try {
        if ($script:F37TelModule) { break }
        if ($f37cand -and (Test-Path -LiteralPath $f37cand -PathType Leaf)) {
            . $f37cand
            $script:F37TelModule = $f37cand
        }
    } catch { $script:F37TelLastError = ('module load failed: ' + $_.Exception.Message) }
}
function Get-F37BeaconStageForSlug {
    # [F37 §1 telescope-format beacon-stage] slug -> stage THROUGH THE MODULE (the
    # one token table); the server never keeps a second mapping of its own. '' is
    # the honest answer for a slug the format does not know, and the caller then
    # stores no verdict. The structural fallback exists only for the case where
    # the module is not deployed at all (the same condition that makes
    # Invoke-F37Telescope return its self-explaining fallback line) - it reads the
    # slug's SHAPE, so it cannot drift from a slug list.
    param([string]$Slug)
    if (-not $Slug) { return '' }
    if ($script:F37TelModule) {
        $st = ''
        try { $st = [string](Get-RdpTelescopeBeaconStage -Slug $Slug) } catch { $st = '' }
        return $st
    }
    switch -Regex ($Slug) {
        '^telescope-dns-' { return 'dns' }
        '^telescope-tcp-' { return 'tcp' }
        '^telescope-cred-' { return 'cred' }
        '^telescope-(tls|rst-before-cert|chain|name-mismatch|eku)' { return 'tls' }
    }
    return ''
}
function New-F37TelescopeFallback {
    # The telescope explains its own absence: same line shape, same keys.
    param([string]$Why, [string]$Src = 'live', [string]$Trace = '')
    $line = [ordered]@{
        ts = (Get-Date).ToUniversalTime().ToString('o')
        trace = $Trace
        src = $Src
        stage = 'telescope'
        ok = $false
        why = $Why
    }
    return [pscustomobject]@{ trace = $Trace; src = $Src; deathPoint = 'none'; lines = @(($line | ConvertTo-Json -Compress)) }
}
function Invoke-F37Telescope {
    # One call, one implementation: the module's Invoke-RdpTelescope. Never
    # throws - a missing module or a probe error is itself a telescope line.
    param([string]$Fqdn, [string]$Src = 'live', [string]$ExpectedThumb = '')
    if (-not $script:F37TelModule) {
        return (New-F37TelescopeFallback -Why ('rdp-telescope.ps1 not deployed at ' + $Root) -Src $Src)
    }
    try {
        if (-not $Fqdn) { $Fqdn = 'localhost' }
        # [F37 §4] -SkipCred: the stored TERMSRV target is the CLIENT's stage.
        # This host SERVES the listener, so "no stored credential here" is a
        # scope fact - reporting it red painted every healthy runner sample with
        # a false death point (credssp) and made the row unreadable.
        $telOut = (Invoke-RdpTelescope -Fqdn $Fqdn -ExpectedThumb $ExpectedThumb -Src $Src -Local -Ip '127.0.0.1' -SkipCred)
        # Every degraded line must be readable from native-status, never only
        # from a server log the session cannot fetch. probeError is the
        # LISTENER FACE (tcp/tls/listener): those are the stages that mean the
        # path this host serves is broken. Schannel events and an informational
        # logon line are EVIDENCE and travel as probeWarn instead, so a runner
        # that is serving fine never reads as degraded.
        try {
            # Classified through ConvertFrom-Json (never a hand-rolled match on
            # the wire format - the module owns the format, this only reads it).
            $fatal = @(); $warn = @()
            foreach ($f37l in @($telOut.lines)) {
                $f37o = $null
                try { $f37o = ([string]$f37l | ConvertFrom-Json) } catch { }
                if (-not $f37o) { continue }
                if ([bool]$f37o.ok) { continue }
                if (@('tcp', 'tls', 'listener') -contains [string]$f37o.stage) { $fatal += [string]$f37l } else { $warn += [string]$f37l }
            }
            if ($fatal.Count -gt 0) { $script:F37TelLastError = ('telescope red: ' + [string]$fatal[0]) } else { $script:F37TelLastError = '' }
            if ($warn.Count -gt 0) { $script:F37TelLastWarn = ('telescope evidence: ' + [string]$warn[0]) } else { $script:F37TelLastWarn = '' }
        } catch { }
        return $telOut
    } catch {
        $script:F37TelLastError = ('telescope failed: ' + $_.Exception.Message)
        return (New-F37TelescopeFallback -Why $script:F37TelLastError -Src $Src)
    }
}
function Get-F37LineField {
    # Read ONE field out of a telescope line (JSON string) - tolerates a missing
    # or unparsable line instead of killing the tick.
    param([string]$Line, [string]$Field)
    try {
        if (-not $Line) { return $null }
        $o = $Line | ConvertFrom-Json
        if ($o -and $o.PSObject.Properties[$Field]) { return $o.$Field }
    } catch { }
    return $null
}
function Update-RdpListenerTelescope {
    # The 60s tick body: run the telescope, stamp the derived bind-drift fields
    # (boundThumb/servedThumb/serving/aclSids/schannel tail) and persist.
    param([string]$StatePath, [datetime]$ScanStartedUtc)
    $scanTs = (Get-Date).ToUniversalTime().ToString('o')
    $cfgT = $null
    try { $cfgT = Read-JsonFile -Path $script:CfgPath } catch { }
    $fqdn = ''
    try { if ($cfgT -and $cfgT.PSObject.Properties['dnsName']) { $fqdn = [string]$cfgT.dnsName } } catch { }
    $expected = ''
    try {
        $rdpK = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
        $b = (Get-ItemProperty -Path $rdpK -Name 'SSLCertificateSHA1Hash' -ErrorAction Stop).SSLCertificateSHA1Hash
        $expected = (($b | ForEach-Object { $_.ToString('X2') }) -join '')
    } catch { }
    $tel = Invoke-F37Telescope -Fqdn $fqdn -Src 'live' -ExpectedThumb $expected
    $script:F37TelScans = [int]$script:F37TelScans + 1
    # ONE derivation, shared with the workflow stamp (module, not a copy).
    $derived = $null
    $deriveThrown = ''
    if ($script:F37TelModule) {
        try { $derived = Get-RdpTelescopeFields -Telescope $tel } catch { $deriveThrown = ('derivation threw: ' + $_.Exception.Message) }
    } else { $deriveThrown = 'module not loaded: no derivation possible' }
    if (-not $derived) {
        # A derivation fault is NAMED, never silent: an empty row that claims
        # nothing is the red-without-why class this feature exists to kill. The
        # fallback carries EVERY key the state reads, so a consumer can never
        # mistake "derivation failed" for "the field is absent from the format".
        if (-not $deriveThrown) { $deriveThrown = 'derivation returned nothing' }
        $derived = [pscustomobject]@{
            boundThumb = ''; servedThumb = ''; serving = $false; bindDrift = $false
            inStore = $false; hasKey = $false; container = ''; aclRead = $false; aclOk = $false
            hasServerAuth = $false; eku = @(); san = @()
            keyFileFound = $false; containerKind = ''; keyDirHits = @(); keyDirSample = @(); keyFilePathSource = ''
            containerPath = ''; keyTypedError = ''; typesLoader = ''
            aclSids = @(); aclReadMethod = ''; aclModule = ''; schannelTail = @(); schannelWhy = ''
            tlsWhy = ''; listenerWhy = ''
            logonEventId = ''; logonSub = ''; count4624 = 0; count4625 = 0; logonWhy = ''
            redStages = @(); fatalStages = @(); deriveError = $deriveThrown
            deathPoint = [string]$tel.deathPoint; trace = [string]$tel.trace; src = [string]$tel.src
        }
    }
    $state = [ordered]@{
        ts          = $scanTs
        scanTs      = $scanTs
        trace       = [string]$tel.trace
        src         = [string]$tel.src
        deathPoint  = [string]$tel.deathPoint
        fqdn        = $fqdn
        module      = $script:F37TelModule
        boundThumb  = [string]$derived.boundThumb
        servedThumb = [string]$derived.servedThumb
        serving     = [bool]$derived.serving
        bindDrift   = [bool]$derived.bindDrift
        aclSids     = @($derived.aclSids)
        aclRead     = [bool]$derived.aclRead
        # [F37 §4] WHICH reader produced the ACL verdict (get-acl |
        # dotnet-fileinfo | acl-extensions | icacls | none) + what the module
        # path repair had to do: the runner lost Get-Acl to an unloadable
        # Microsoft.PowerShell.Security module under a pwsh parent, and the row
        # rendered deathPoint=acl on a healthy key. The method makes that
        # difference visible instead of debatable.
        aclReadMethod = [string]$derived.aclReadMethod
        aclModule   = [string]$derived.aclModule
        container   = [string]$derived.container
        schannelTail = @($derived.schannelTail)
        schannelWhy = [string]$derived.schannelWhy
        lines       = @($tel.lines)
        listenerLine = $(if ($script:F37TelModule) { Get-RdpTelescopeStageLine -Lines $tel.lines -Stage 'listener' } else { '' })
        tlsLine      = $(if ($script:F37TelModule) { Get-RdpTelescopeStageLine -Lines $tel.lines -Stage 'tls' } else { '' })
        moduleLoaded = [bool]($script:F37TelModule)
        lineCount    = @($tel.lines).Count
        intervalSec = $script:F37TelIntervalSec
        scans       = [int]$script:F37TelScans
        probeError  = [string]$script:F37TelLastError
        # [F37 §4] the rest of the derived verdict, served verbatim so the row
        # and any annotation can NAME a fault (key file, EKU, ACL, stage) with
        # evidence instead of an empty field list. credScope states why this
        # sample carries no cred line: that stage belongs to the client.
        probeWarn   = [string]$script:F37TelLastWarn
        credScope   = 'client-only'
        deriveError = $(if ([string]$derived.deriveError) { [string]$derived.deriveError } else { [string]$deriveThrown })
        redStages   = @($derived.redStages)
        fatalStages = @($derived.fatalStages)
        inStore     = [bool]$derived.inStore
        hasKey      = [bool]$derived.hasKey
        hasServerAuth = [bool]$derived.hasServerAuth
        eku         = @($derived.eku)
        san         = @($derived.san)
        aclOk       = [bool]$derived.aclOk
        keyFileFound = [bool]$derived.keyFileFound
        containerKind = [string]$derived.containerKind
        containerPath = [string]$derived.containerPath
        keyFilePathSource = [string]$derived.keyFilePathSource
        keyDirHits  = @($derived.keyDirHits)
        keyDirSample = @($derived.keyDirSample)
        keyTypedError = [string]$derived.keyTypedError
        typesLoader = [string]$derived.typesLoader
        tlsWhy      = [string]$derived.tlsWhy
        listenerWhy = [string]$derived.listenerWhy
        logonEventId = [string]$derived.logonEventId
        logonSub    = [string]$derived.logonSub
        logonWhy    = [string]$derived.logonWhy
    }
    try { [System.IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Compress -Depth 6), $script:NoBom) } catch { }
    return $state
}
function Get-RdpListenerTelescopeState {
    # Read-back for /api/native-status: the state + the tick's own liveness
    # (a missing or >180s stale sample is NOT a green telescope).
    param([string]$StatePath, [datetime]$ServerStartedUtc)
    $state = $null
    $ageSec = $null
    if ($StatePath -and (Test-Path -LiteralPath $StatePath)) {
        $state = Read-JsonFile -Path $StatePath
        try { $ageSec = [int]((Get-Date) - (Get-Item -LiteralPath $StatePath).LastWriteTime).TotalSeconds } catch { $ageSec = $null }
    }
    $uptime = [int]((Get-Date).ToUniversalTime() - $ServerStartedUtc).TotalSeconds
    $alive = $false
    if ($null -ne $ageSec) { $alive = ($ageSec -le $script:F37TelStaleSec) } else { $alive = ($uptime -le $script:F37TelStaleSec) }
    $collector = [ordered]@{
        intervalSec = $script:F37TelIntervalSec
        staleSec    = $script:F37TelStaleSec
        scans       = [int]$script:F37TelScans
        alive       = $alive
        uptimeSec   = $uptime
        lastScanAgeSec = $ageSec
        module      = $script:F37TelModule
        probeError  = [string]$script:F37TelLastError
        probeWarn   = [string]$script:F37TelLastWarn
        shell       = [string]$PSVersionTable.PSVersion.ToString()
        listenerLine = $(if ($state -and $state.PSObject.Properties['listenerLine']) { [string]$state.listenerLine } else { '' })
        moduleLoaded = [bool]($script:F37TelModule)
    }
    return [pscustomobject]@{ telescope = $state; telescopeCollector = $collector }
}
function Add-F37ClientBeacon {
    # Ring buffer (last N) + JSONL append for the launcher's stage beacons.
    # Only ts/trace/stage/ok/details are accepted: the endpoint allowlists them
    # before this is called, so a beacon can never carry a secret.
    param([string]$Path, [System.Collections.IDictionary]$Beacon)
    $obj = [ordered]@{
        ts      = [string]$Beacon['ts']
        trace   = [string]$Beacon['trace']
        stage   = [string]$Beacon['stage']
        ok      = [bool]$Beacon['ok']
        details = [string]$Beacon['details']
    }
    $script:F37ClientBeacons = @(@($obj) + @($script:F37ClientBeacons) | Select-Object -First $script:F37TelMaxClient)
    try { [System.IO.File]::AppendAllText($Path, (($obj | ConvertTo-Json -Compress) + "`n"), $script:NoBom) } catch { }
    return $obj
}
function Get-F37ClientTelescope {
    # Newest-first beacons + the trace the timeline should focus on. Re-seeds
    # from the JSONL file after a server restart so a restart never blanks the
    # timeline (the last 60 lines are enough for one attempt).
    param([string]$Path)
    if (@($script:F37ClientBeacons).Count -eq 0 -and $Path -and (Test-Path -LiteralPath $Path)) {
        try {
            $all = @([System.IO.File]::ReadAllLines($Path) | Where-Object { $_ } | Select-Object -Last $script:F37TelMaxClient)
            $items = @()
            foreach ($l in $all) {
                try {
                    $o = $l | ConvertFrom-Json
                    $items += [ordered]@{ ts = [string]$o.ts; trace = [string]$o.trace; stage = [string]$o.stage; ok = [bool]$o.ok; details = [string]$o.details }
                } catch { }
            }
            $script:F37ClientBeacons = @(@($items) | Sort-Object -Property ts -Descending | Select-Object -First $script:F37TelMaxClient)
        } catch { }
    }
    $items = @($script:F37ClientBeacons)
    $newestTrace = ''
    foreach ($it in $items) { if ($it['trace']) { $newestTrace = [string]$it['trace']; break } }
    return [pscustomobject]@{
        items       = $items
        count       = $items.Count
        newestTrace = $newestTrace
        intervalSec = $script:F37TelIntervalSec
        ageSec      = $(if ($items.Count -gt 0) { try { [int]((Get-Date).ToUniversalTime() - ([datetime]$items[0]['ts']).ToUniversalTime()).TotalSeconds } catch { $null } } else { $null })
    }
}
# [F37 §4 telescope-end]

# [F31c §2 schannel-begin] System Schannel 36870/36871 are NOT in the RDP
# Operational logs the F30 collector reads. Merge the last 5 minutes into the
# served connLog so the LIVE DISPATCH STATUS card can prove absence instead of
# assuming it. Ids + clipped descriptions only - never a key, a password, or a
# thumbprint. A dead System log is a named probe error (not a clean absence).
$script:F31cSchannelAt = [datetime]::MinValue
$script:F31cSchannelMemo = $null
function Get-F31cSchannelWindow {
    $now = Get-Date
    if ($script:F31cSchannelMemo -and (($now - $script:F31cSchannelAt).TotalSeconds -lt 30)) {
        return $script:F31cSchannelMemo
    }
    $items = @()
    $probeError = ''
    try {
        $since = $now.ToLocalTime().AddMinutes(-5)
        $raw = @()
        try {
            $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = @(36870, 36871, 36888); StartTime = $since } -MaxEvents 10 -ErrorAction Stop)
        } catch {
            $em = [string]$_.Exception.Message
            if ($em -notmatch 'No events were found|No events found') { $probeError = 'schannel-log-unreadable' }
        }
        foreach ($e in @($raw)) {
            if (-not $e) { continue }
            $desc = ''
            try { $desc = [string]$e.Message } catch { $desc = '' }
            if ($desc.Length -gt 200) { $desc = $desc.Substring(0, 200) }
            $desc = [regex]::Replace($desc, '(?i)(password|passwd|pwd|subjectusername|targetusername|subjectdomainname)(\s*[=:]\s*)\S+', '$1$2[redacted]')
            $id = [string]$e.Id
            $items += [pscustomobject]@{
                id       = $id
                provider = 'Schannel'
                timeUtc  = $e.TimeCreated.ToUniversalTime().ToString('o')
                level    = [string]$e.Level
                reason   = (Get-RdpConnLogReason -Provider 'Schannel' -Id $id -Level ([string]$e.Level) -Text $desc)
                desc     = $desc
            }
        }
    } catch { $probeError = 'schannel-log-unreadable' }
    $memo = [pscustomobject]@{ items = @($items | Where-Object { $_ }); probeError = $probeError; windowSec = 300 }
    $script:F31cSchannelAt = $now
    $script:F31cSchannelMemo = $memo
    return $memo
}
function Merge-F31cConnLog {
    param($ConnLog, $Sch)
    if (-not $Sch) { return $ConnLog }
    $extra = @($Sch.items | Where-Object { $_ })
    if (-not $ConnLog) {
        if ($extra.Count -eq 0) { return $null }
        return [pscustomobject]@{
            ts = (Get-Date).ToUniversalTime().ToString('o')
            items = $extra
            newest = @($extra | Select-Object -First 3)
            count = $extra.Count
            probeError = ''
            schannelProbeError = [string]$Sch.probeError
        }
    }
    $have = @{}
    $merged = @()
    foreach ($it in @($ConnLog.items)) {
        if (-not $it) { continue }
        $k = ([string]$it.id) + '|' + ([string]$it.timeUtc)
        if (-not $have.ContainsKey($k)) { $have[$k] = $true; $merged += $it }
    }
    foreach ($it in $extra) {
        $k = ([string]$it.id) + '|' + ([string]$it.timeUtc)
        if (-not $have.ContainsKey($k)) { $have[$k] = $true; $merged += $it }
    }
    try { $ConnLog | Add-Member -NotePropertyName items -NotePropertyValue $merged -Force } catch { }
    try { $ConnLog | Add-Member -NotePropertyName schannelProbeError -NotePropertyValue ([string]$Sch.probeError) -Force } catch { }
    return $ConnLog
}
# [F31c §2 schannel-end]
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
    # [F14 §2] $ExtraHeaders carries EXTRA raw header lines (CRLF-less; one per
    # line, appended verbatim). Empty by default, so every existing call site
    # emits byte-identical headers. Cache-Control: no-store is always set.
    param($Stream, [int]$Code, [string]$CType, [byte[]]$Body, [string]$ExtraHeaders = '')
    $status = 'OK'
    if ($Code -eq 202) { $status = 'Accepted' }
    if ($Code -eq 204) { $status = 'No Content' }
    if ($Code -eq 206) { $status = 'Partial Content' }
    if ($Code -eq 400) { $status = 'Bad Request' }
    if ($Code -eq 401) { $status = 'Unauthorized' }
    if ($Code -eq 403) { $status = 'Forbidden' }
    if ($Code -eq 404) { $status = 'Not Found' }
    if ($Code -eq 405) { $status = 'Method Not Allowed' }
    if ($Code -eq 409) { $status = 'Conflict' }
    if ($Code -eq 413) { $status = 'Payload Too Large' }
    if ($Code -eq 415) { $status = 'Unsupported Media Type' }
    if ($Code -eq 416) { $status = 'Range Not Satisfiable' }
    if ($Code -eq 429) { $status = 'Too Many Requests' }
    if ($Code -eq 500) { $status = 'Server Error' }
    if ($Code -eq 502) { $status = 'Bad Gateway' }
    if ($Code -eq 503) { $status = 'Service Unavailable' }
    if ($Code -eq 504) { $status = 'Gateway Timeout' }
    # [F45 S4 fix] the blank line that terminates the header block: with no extra
    # headers the template already ends in CRLFCRLF (byte-identical to every
    # existing response). With extra headers the last ONE of them used to sit
    # directly against the body - no separator at all - so an HTTP client (and
    # the F45 harness) saw the body as a bogus header line and every successful
    # fx response arrived with an empty body.
    $tail = ''
    if ($ExtraHeaders) { $tail = "`r`n" }
    $hdr = "HTTP/1.1 $Code $status`r`nContent-Type: $CType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type, Authorization`r`nAccess-Control-Allow-Methods: GET,POST,OPTIONS`r`n$ExtraHeaders$tail`r`n"
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
    if (Get-Command ConvertTo-F52JsonSafe -ErrorAction SilentlyContinue) { $Obj = ConvertTo-F52JsonSafe $Obj }
    return [System.Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth 12 -Compress))
}
function Remove-CredKeys {
    # [remediation #7A / U1] Strip secrets from a config object before it leaves
    # in any response body, then rebuild `creds` to expose ONLY the fields the UI
    # needs for the native mstsc auto-login flow: { fqdn, user, ip }.
    #   fqdn = config.dnsName only (*.ts.net). Never the tailnet IP.
    #   user = config.rdpUser  (a username, not a secret; the password is never here).
    #   ip   = config.rdpIp    (the same value as fqdn under P2).
    # Everything else that could carry a secret (rdpPass, vncPass, mirrorKey,
    # legacyDecryptKey, rentryEditCode, rentryEditCookie, dashToken) is removed.
    # [F10-2 §3] passwords reach a response ONLY at the single /api/config
    # creds-block write site, only when the request is dash-token or tailnet
    # authenticated (see Test-CredsAllowed + the /api/config route).
    param($Obj)
    if (-not $Obj) { return $Obj }
    $fqdn = ''; $user = ''; $ip = ''
    try { if ($Obj.PSObject.Properties['dnsName']) { $fqdn = [string]$Obj.dnsName } } catch { }
    try { if ($Obj.PSObject.Properties['rdpUser']) { $user = [string]$Obj.rdpUser } } catch { }
    try { if ($Obj.PSObject.Properties['rdpIp'])   { $ip   = [string]$Obj.rdpIp   } } catch { }
    # dnsName only. Never present the tailnet IP as the FQDN.
    foreach ($k in @('rdpUser','rdpPass','vncPass','mirrorKey','legacyDecryptKey','creds','rentryEditCode','rentryEditCookie','dashToken')) {
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
        # [F10-2 §2.2] dash-token source peer capture: the rdp-ping loop targets
        # THIS client ip (the operator's device), not an arbitrary first peer.
        # RemoteEndPoint covers the direct tailnet-HTTP path; X-Forwarded-For
        # covers the tailscale-serve proxy path. Write only on change.
        try {
            $raC = $Client.Client.RemoteEndPoint.Address
            $octC = $raC.GetAddressBytes()
            $cand = ''
            if ($octC.Length -eq 4 -and $octC[0] -eq 100 -and $octC[1] -ge 64 -and $octC[1] -le 127) { $cand = $raC.ToString() }
            elseif ($parts.headers.ContainsKey('x-forwarded-for')) {
                $xf = ([string]$parts.headers['x-forwarded-for']).Split(',')[0].Trim()
                if ($xf -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') { $cand = $xf }
            }
            if ($cand) {
                $cipFile = Join-Path $Root 'dash-client-ip.txt'
                $prev = ''
                try { if (Test-Path -LiteralPath $cipFile) { $prev = ([System.IO.File]::ReadAllText($cipFile)).Trim() } } catch { }
                if ($prev -ne $cand) { [System.IO.File]::WriteAllText($cipFile, $cand, $script:NoBom) }
            }
        } catch { }
        # [F10-2 §3] per-request creds authorization (strict subset of access).
        $credsAllowed = Test-CredsAllowed -Client $Client -Query $parts.query -Token $Token
        $cfg = Read-JsonFile -Path $script:CfgPath
        # [F45 S4 fx-dispatch-begin] Explorer file-API + preview-sandbox routes.
        # Everything security-relevant is decided INSIDE the module (dash-token
        # presentation, query-credential refusal, CSRF, path containment); this
        # block only translates the parsed request into the module's context and
        # writes the response back through the one response writer. The audit
        # line carries method+path+status only - never a query string, never a
        # header, never a token.
        if ($path -eq '/api/fx' -or $path.StartsWith('/api/fx/') -or $path -eq '/preview-sandbox' -or $path.StartsWith('/preview-sandbox/')) {
            if (-not $script:FxReady) {
                Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ phase = 'parse'; error = ('Explorer API unavailable: ' + [string]$script:FxLoadError) })
                Write-ClientAudit ('fx ' + [string]$parts.method + ' ' + $path + ' -> 503 (module missing)')
                return
            }
            $fxClass = 'other'
            try {
                $fxIp = $Client.Client.RemoteEndPoint.Address
                if (Test-IsLoopbackAddr $fxIp) { $fxClass = 'loopback' }
                else {
                    $fxOct = $fxIp.GetAddressBytes()
                    if ($fxOct.Length -eq 4 -and $fxOct[0] -eq 100 -and $fxOct[1] -ge 64 -and $fxOct[1] -le 127) { $fxClass = 'tailnet' }
                }
            } catch { }
            $fxCtx = @{
                root = $Root
                path = $path
                method = [string]$parts.method
                query = $parts.query
                headers = $parts.headers
                body = [byte[]]$parts.body
                clientClass = $fxClass
                dashToken = [string]$Token
                csrfToken = [string]$script:FxCsrf
                options = @{ Config = $cfg }
            }
            $fxResp = $null
            $fxErr = ''
            try { $fxResp = Invoke-FxRoute -Ctx $fxCtx } catch { $fxErr = $_.Exception.Message }
            if (-not $fxResp) {
                $fxMsg = 'fx route failed'
                if ($fxErr) { $fxMsg = $fxMsg + ': ' + (Protect-FxText -Text $fxErr -Secrets @([string]$Token)) }
                $fxResp = @{ Code = 500; CType = 'application/json; charset=utf-8'; Body = (ConvertTo-JsonBytes @{ phase = 'parse'; error = $fxMsg }); Headers = @() }
            }
            $fxExtra = ''
            $fxHdrList = @($fxResp.Headers)
            if ($fxHdrList.Count -gt 0) { $fxExtra = ($fxHdrList -join "`r`n") }
            # Copy the body byte by byte instead of casting: a response object that
            # is a hashtable must never be able to lose its body to a cast, and the
            # count is audited so a body that never reaches the socket is visible.
            $fxBodyBytes = [byte[]]@()
            try {
                if ($null -ne $fxResp.Body) {
                    $fxArr = @($fxResp.Body)
                    if ($fxArr.Count -gt 0) {
                        $fxBodyBytes = New-Object byte[] $fxArr.Count
                        for ($fxBi = 0; $fxBi -lt $fxArr.Count; $fxBi++) { $fxBodyBytes[$fxBi] = [byte]$fxArr[$fxBi] }
                    }
                }
            } catch { $fxBodyBytes = [byte[]]@() }
            Send-ClientResponse -Stream $stream -Code ([int]$fxResp.Code) -CType ([string]$fxResp.CType) -Body $fxBodyBytes -ExtraHeaders $fxExtra
            Write-ClientAudit ('fx ' + [string]$parts.method + ' ' + $path + ' -> ' + [string]$fxResp.Code + ' body=' + [string]$fxBodyBytes.Length)
            return
        }
        # [F45 S4 fx-dispatch-end]
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
        # [F49 runtime-opt-in-begin] One-click THIS-RUN opt-in for the token-less
        # mirror (the Mirror page ConfirmModal). GET /api/mirror/status is the
        # read; POST /api/mirror/enable|/disable converge the run. The dispatch
        # mirror_enable path is untouched and the shipped default stays
        # disabled (F11-5.2). Auth: the dash token in X-Dash-Token or
        # Authorization: Bearer, never in the query string (fx rule); POSTs
        # additionally require X-CSRF-Token (the per-process token, delivered
        # by the status response header + cookie). The enable POST also queues
        # the flush, so [Enable & Upload] is one action.
        if ($path -eq '/api/mirror/status' -or $path -eq '/api/mirror/enable' -or $path -eq '/api/mirror/disable') {
            if ($parts.method -eq 'OPTIONS') {
                Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@()) -ExtraHeaders "Access-Control-Allow-Headers: Content-Type, Authorization, X-Dash-Token, X-CSRF-Token`r`nAccess-Control-Max-Age: 600"
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 204 (preflight)')
                return
            }
            $mIsPost = ($path -eq '/api/mirror/enable' -or $path -eq '/api/mirror/disable')
            if ($mIsPost -and ($parts.method -ne 'POST')) {
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'method not allowed (POST required)' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 405')
                return
            }
            if ((-not $mIsPost) -and ($parts.method -ne 'GET')) {
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'method not allowed (GET required)' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 405')
                return
            }
            $mQueryCred = $false
            try {
                foreach ($qk in @('key', 'token', 'dash-token', 'dash_token', 'dashtoken', 'access-token', 'access_token', 'password')) {
                    if ($parts.query.ContainsKey($qk)) { $mQueryCred = $true; break }
                }
            } catch { }
            if ($mQueryCred) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'credentials are not accepted in the query string; send X-Dash-Token' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (query credential refused)')
                return
            }
            $mPresented = ''
            try { $mPresented = [string]$parts.headers['x-dash-token'] } catch { }
            if (-not $mPresented) {
                $mAuth = ''
                try { $mAuth = [string]$parts.headers['authorization'] } catch { }
                if ($mAuth -match '^(?i)Bearer\s+(.+)$') { $mPresented = $Matches[1].Trim() }
            }
            $mTokenOk = $false
            if ($mPresented -and $Token) {
                $mRecv = [System.Text.Encoding]::UTF8.GetBytes($mPresented)
                $mExp = [System.Text.Encoding]::UTF8.GetBytes([string]$Token)
                if (($mRecv.Length -eq $mExp.Length) -and (Test-TicketBearer $mRecv $mExp)) { $mTokenOk = $true }
            }
            $mClass = 'other'
            try {
                $mIp = $Client.Client.RemoteEndPoint.Address
                if (Test-IsLoopbackAddr $mIp) { $mClass = 'loopback' }
                else {
                    $mOct = $mIp.GetAddressBytes()
                    if ($mOct.Length -eq 4 -and $mOct[0] -eq 100 -and $mOct[1] -ge 64 -and $mOct[1] -le 127) { $mClass = 'tailnet' }
                }
            } catch { }
            if ($mIsPost) {
                if (-not $mTokenOk) {
                    Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'dashboard authorization required (X-Dash-Token or Bearer)' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (dash token required)')
                    return
                }
                $mCsrf = ''
                try { $mCsrf = [string]$parts.headers['x-csrf-token'] } catch { }
                $mCsrfOk = $false
                if ($mCsrf -and [string]$script:FxCsrf) {
                    $mCsrfRecv = [System.Text.Encoding]::UTF8.GetBytes($mCsrf)
                    $mCsrfExp = [System.Text.Encoding]::UTF8.GetBytes([string]$script:FxCsrf)
                    if (($mCsrfRecv.Length -eq $mCsrfExp.Length) -and (Test-TicketBearer $mCsrfRecv $mCsrfExp)) { $mCsrfOk = $true }
                }
                if (-not $mCsrfOk) {
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'CSRF token missing or invalid' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 403 (CSRF)')
                    return
                }
            } else {
                if ($mPresented -and (-not $mTokenOk)) {
                    Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'dashboard authorization required (X-Dash-Token or Bearer)' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (dash token invalid)')
                    return
                }
                if (-not ($mTokenOk -or ($mClass -eq 'loopback') -or ($mClass -eq 'tailnet'))) {
                    Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'dashboard authorization required (X-Dash-Token or Bearer)' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (dash token required)')
                    return
                }
            }
            if (-not $script:F46MirrorReady) {
                Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('mirror module unavailable: ' + [string]$script:F46MirrorLoadError) })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 503 (module missing)')
                return
            }
            $mCfg = Read-JsonFile -Path $script:CfgPath
            if (-not $mCfg) {
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'config.json is missing or unreadable' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 500 (config unreadable)')
                return
            }
            if ($path -eq '/api/mirror/status') {
                $mSt = $null
                try { $mSt = Get-F49OptInStatus -Cfg $mCfg } catch { $mSt = $null }
                if (-not $mSt) {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'mirror status unavailable' })
                    Write-ClientAudit ('mirror GET /api/mirror/status -> 500')
                    return
                }
                $mPending = $false
                try { $mPending = (Test-Path -LiteralPath (Join-Path $Root ([string]$script:F49OptInEnableFlag))) -or (Test-Path -LiteralPath (Join-Path $Root ([string]$script:F49OptInDisableFlag))) } catch { }
                $mBody = [ordered]@{ ok = $true; enabled = [bool]$mSt.enabled; mirror = [bool]$mSt.mirror; hosts = @($mSt.hosts); host = [string]$mSt.host; scope = [string]$mSt.scope; source = [string]$mSt.source; at = [string]$mSt.at; pending = [bool]$mPending }
                $mExtra = ('X-CSRF-Token: ' + [string]$script:FxCsrf + "`r`n" + 'Access-Control-Expose-Headers: X-CSRF-Token' + "`r`n" + 'Set-Cookie: ghrdp_mirror_csrf=' + [string]$script:FxCsrf + '; Path=/; SameSite=Strict')
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $mBody) -ExtraHeaders $mExtra
                Write-ClientAudit ('mirror GET /api/mirror/status -> 200')
                return
            }
            if ($path -eq '/api/mirror/enable') {
                $mRes = $null
                try { $mRes = Set-F49RuntimeOptIn -Cfg $mCfg } catch { $mRes = $null }
                if (-not $mRes) {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'runtime opt-in failed' })
                    Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (converge failed)')
                    return
                }
                try {
                    [System.IO.File]::WriteAllText($script:CfgPath, ($mCfg | ConvertTo-Json -Depth 10), $script:NoBom)
                } catch {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('config write failed: ' + $_.Exception.Message) })
                    Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (config write failed)')
                    return
                }
                try { Write-F49OptInBeacon -Root $Root -Marker (Get-F49RuntimeOptIn -Cfg $mCfg) -HostId ([string]$mRes.host) } catch { }
                if ([bool]$mRes.changed) {
                    try {
                        [System.IO.File]::WriteAllText((Join-Path $Root ([string]$script:F49OptInEnableFlag)), (Get-Date -Format o), $script:NoBom)
                    } catch {
                        Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('opt-in flag write failed: ' + $_.Exception.Message) })
                        Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (flag write failed)')
                        return
                    }
                }
                try {
                    [System.IO.File]::WriteAllText($script:FlushFlag, (Get-Date -Format o), $script:NoBom)
                } catch {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('flush flag write failed: ' + $_.Exception.Message) })
                    Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (flush write failed)')
                    return
                }
                $mSt2 = $null
                try { $mSt2 = Get-F49OptInStatus -Cfg $mCfg } catch { $mSt2 = $null }
                $mPend2 = $false
                try { $mPend2 = (Test-Path -LiteralPath (Join-Path $Root ([string]$script:F49OptInEnableFlag))) } catch { }
                $mBody2 = [ordered]@{ ok = $true; enabled = $true; host = [string]$mRes.host; scope = [string]$script:F49OptInScope; source = [string]$script:F49OptInSource; at = $(if ($mSt2) { [string]$mSt2.at } else { '' }); alreadyEnabled = (-not [bool]$mRes.changed); pending = [bool]$mPend2 }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $mBody2)
                Write-ClientAudit ('mirror POST /api/mirror/enable -> 200')
                return
            }
            $mResOff = $null
            try { $mResOff = Clear-F49RuntimeOptIn -Cfg $mCfg } catch { $mResOff = $null }
            if (-not $mResOff) {
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'runtime opt-out failed' })
                Write-ClientAudit ('mirror POST /api/mirror/disable -> 500 (converge failed)')
                return
            }
            try {
                [System.IO.File]::WriteAllText($script:CfgPath, ($mCfg | ConvertTo-Json -Depth 10), $script:NoBom)
            } catch {
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('config write failed: ' + $_.Exception.Message) })
                Write-ClientAudit ('mirror POST /api/mirror/disable -> 500 (config write failed)')
                return
            }
            try { Remove-F49OptInBeacon -Root $Root } catch { }
            if ([bool]$mResOff.changed) {
                try {
                    [System.IO.File]::WriteAllText((Join-Path $Root ([string]$script:F49OptInDisableFlag)), (Get-Date -Format o), $script:NoBom)
                } catch {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('opt-out flag write failed: ' + $_.Exception.Message) })
                    Write-ClientAudit ('mirror POST /api/mirror/disable -> 500 (flag write failed)')
                    return
                }
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; enabled = $false; scope = [string]$script:F49OptInScope; source = 'off'; alreadyDisabled = (-not [bool]$mResOff.changed) }))
            Write-ClientAudit ('mirror POST /api/mirror/disable -> 200')
            return
        }
        # [F49 runtime-opt-in-end]
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
            # [F46 §5] READ-ONLY mirror host probe + the worker's attempt table.
            # HEAD/GET of each configured host API root: no credential, no body
            # upload, no evasion. The matrix is the Diagnose output the operator
            # reads; all-403 from a runner egress is a documented policy
            # dead-end (operator options in docs/MIRROR-HOSTS.md).
            $mirrorRows = @()
            if ($script:F46MirrorReady) {
                try {
                    $mCfg = Read-JsonFile -Path $script:CfgPath
                    $mirrorRows = @(Get-F52HostMatrix -Root $Root -Hosts (@(Get-F46Hosts -Cfg $mCfg)))
                } catch {
                    $mirrorRows = @(@{ host = 'probe'; status = '-'; note = ('probe failed: ' + $_.Exception.Message) })
                }
            } else {
                $mirrorRows = @(@{ host = 'none'; status = '-'; note = 'ghrdp-mirror.ps1 not staged next to the server - read-only probe unavailable (F46 §5)' })
            }
            $mirrorAttempts = @()
            try { if ($prog -and $prog.mirrorDiag) { $mirrorAttempts = @($prog.mirrorDiag.attempts) } } catch { $mirrorAttempts = @() }
            $mirrorPolicy = $null
            if ($script:F46MirrorReady) {
                try { $mirrorPolicy = [ordered]@{ failFast = @($script:F46FailFastStatuses); transient = @($script:F46TransientPhases); maxAttempts = [int]$script:F46MaxAttempts } } catch { $mirrorPolicy = $null }
            }
            # [F56-d §3] SEARCH_INPUT propagation: main.yml adds search_enable boolean default false
            # SEARCH_INPUT env = inputs.search_enable. /diag returns searchEnabled boolean + searchInput echo.
            # Search surface reads window.__GHRDP_SEARCH_ENABLED from /diag.
            $searchInputStr = ''
            try { $searchInputStr = [string]$env:SEARCH_INPUT } catch { $searchInputStr = '' }
            $searchEnabledFlag = $false
            try {
                if ($searchInputStr -eq 'true') { $searchEnabledFlag = $true }
                elseif ($cfg -and $cfg.PSObject.Properties['searchEnabled'] -and [bool]$cfg.searchEnabled) { $searchEnabledFlag = $true }
            } catch { }
            # Also respect config file searchEnabled if present (future opt-in via POST /api/mirror? no, search is dispatch-only)
            try {
                $searchCfg = Read-JsonFile -Path $script:CfgPath
                if ($searchCfg -and $searchCfg.PSObject.Properties['searchEnabled']) {
                    if ([bool]$searchCfg.searchEnabled) { $searchEnabledFlag = $true }
                }
            } catch { }
            $d = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                port = $Port
                pid = $PID
                rust7332Listening = $listen7332
                watcherTask = $watcherState
                progressAgeSeconds = $progAge
                watcherAlive = [bool]$prog.alive
                mirrorHosts = @($mirrorRows)
                mirrorAttempts = @($mirrorAttempts)
                mirrorDiag = $prog.mirrorDiag
                mirrorPolicy = $mirrorPolicy
                searchEnabled = [bool]$searchEnabledFlag
                searchInput = [string]$searchInputStr
                note = 'ps server 7331 (fallback); rust realtime dashboard 7332 when available'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $d)
            return
        }
        # [F56-d §2 /api/fetch backend] POST /api/fetch per docs/f56/backend.json start|cancel|retry
        # validate resultId or URL-import descriptor allowlisted adapter+snapshot call aria2.addUri return fetchId+gid+progress ref
        # cancel aria2.remove retry fresh snapshot only if backend supplies provenance-6 gate server-side reject executable+missing field
        # error envelope 17 F58 codes. Own-cred path: decrypts creds in memory using F46 AES-GCM per-run key, feeds aria2c --http-user/--http-passwd memory wiped no disk persist.
        if ($path -eq '/api/fetch') {
            # [F56-d] Auth: dash-token required (same as mirror enable), never query creds
            if ($parts.method -eq 'OPTIONS') {
                Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@()) -ExtraHeaders "Access-Control-Allow-Headers: Content-Type, Authorization, X-Dash-Token, X-CSRF-Token`r`nAccess-Control-Max-Age: 600"
                return
            }
            if ($parts.method -ne 'POST') {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'POST required' } }
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $qCred = $false
            try {
                foreach ($qk in @('key','token','dash-token','dash_token','dashtoken','access-token','access_token','password')) {
                    if ($parts.query.ContainsKey($qk)) { $qCred = $true; break }
                }
            } catch { }
            if ($qCred) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query credential refused' } }
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $presented = ''
            try { $presented = [string]$parts.headers['x-dash-token'] } catch { }
            if (-not $presented) {
                $authH = ''
                try { $authH = [string]$parts.headers['authorization'] } catch { }
                if ($authH -match '^(?i)Bearer\s+(.+)$') { $presented = $Matches[1].Trim() }
            }
            $tokenOk = $false
            if ($presented -and $Token) {
                $recv = [System.Text.Encoding]::UTF8.GetBytes($presented)
                $exp = [System.Text.Encoding]::UTF8.GetBytes([string]$Token)
                if (($recv.Length -eq $exp.Length) -and (Test-TicketBearer $recv $exp)) { $tokenOk = $true }
            }
            if (-not $tokenOk) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'dash token required' } }
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $bodyText = ''
            try { $bodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $bodyText = '' }
            $bodyJson = $null
            try { $bodyJson = $bodyText | ConvertFrom-Json -ErrorAction Stop } catch { $bodyJson = $null }
            if (-not $bodyJson) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,8); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'invalid json' } }
                Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $reqId = ''
            try { $reqId = [string]$bodyJson.requestId } catch { }
            if (-not $reqId) { $reqId = [guid]::NewGuid().ToString('N').Substring(0,12) }
            $traceId = [guid]::NewGuid().ToString('N').Substring(0,12)
            $op = ''
            try { $op = [string]$bodyJson.operation } catch { }
            if (-not $op) { $op = 'start' }
            $op = $op.ToLowerInvariant()
            # Initialize fetch map if missing
            if (-not $script:FetchMap) { $script:FetchMap = @{} }
            # Load aria2 helper if available
            $ariaReady = $false
            $ariaMod = Join-Path $Root 'ghrdp-aria2.ps1'
            if (-not (Test-Path -LiteralPath $ariaMod)) { $ariaMod = Join-Path $env:GITHUB_WORKSPACE 'payloads\ghrdp-aria2.ps1' }
            if (Test-Path -LiteralPath $ariaMod) {
                try { . $ariaMod; $ariaReady = $true } catch { $ariaReady = $false }
            }
            # [F56-d §2] torrent lane helper (qBittorrent-nox, Tailnet-only WebUI).
            $qbtReady = $false
            $qbtMod = Join-Path $Root 'ghrdp-qbt.ps1'
            if (-not (Test-Path -LiteralPath $qbtMod)) { $qbtMod = Join-Path $env:GITHUB_WORKSPACE 'payloads\ghrdp-qbt.ps1' }
            if (Test-Path -LiteralPath $qbtMod) {
                try { . $qbtMod; $qbtReady = $true } catch { $qbtReady = $false }
            }
            # One qbt session per request: resolve the tailnet bind (fail closed,
            # never 0.0.0.0) and log in with the operator secret (never logged).
            function Get-F56dQbtSession {
                if (-not $qbtReady) { return @{ ok = $false; address = ''; reason = 'qbt-helper-missing' } }
                $bind = Resolve-GhrdpQbtBindAddress -ConfigPath $script:CfgPath
                if (-not $bind.ok) { return @{ ok = $false; address = ''; reason = $bind.reason } }
                $conn = Connect-GhrdpQbt -Address $bind.address -Port $script:QbtWebUiPort
                if (-not $conn.ok) { return @{ ok = $false; address = $bind.address; reason = $conn.reason } }
                return @{ ok = $true; address = $bind.address; reason = ''; session = $conn.session; mode = $conn.mode }
            }
            # Allowlisted adapters from F56 inventory (subset of search sources)
            # [F69 §1.1] kebab-case to match the client roster (src/pages/search/v2/adapters.ts derives
            # project-gutenberg from the i18n search.sources.* keys); camelCase here 400'd 15 adapters.
            # [F70 §2.1] google-books-public added for the public Volumes API lane
            # (www.googleapis.com; results link out to books.google.com).
            $allowedAdapters = @('project-gutenberg','standard-ebooks','librivox','ia-open-library','hathitrust','wikisource','doab','arxiv','biorxiv','pubmed-central','doaj','oer-commons','ssrn','internet-archive','blender-studio','wikimedia-commons','sourceforge','github-releases','bandcamp','cc-marked-youtube','kindle-audible','kobo','google-books','google-books-public','sarasavi','vijitha-yapa','godage','overdrive-libby','own-storage','custom')
            # [F69 §1.2] resultId -> resolved https URL map. [F70 §1.1] the search
            # lane populates it with result rows (adapterId/sourceUrl/title/
            # mimeType/sizeBytes/createdAt); /api/fetch unwraps row.sourceUrl.
            if (-not $script:F56dResultsMap) { $script:F56dResultsMap = @{} }
            # [F56-d §2] provenance-6 gate server-side reject executable+missing field
            function Test-F56dProvenance {
                param($Prov)
                $execExt = @('.exe','.msi','.dmg','.iso','.zip')
                $fName = ''
                try { $fName = [string]$Prov.fileName } catch { }
                if (-not $fName) { return @{ isExec = $false; missing = @() } }
                $lower = $fName.ToLowerInvariant()
                $isExec = $false
                foreach ($e in $execExt) { if ($lower.EndsWith($e)) { $isExec = $true; break } }
                if (-not $isExec) { return @{ isExec = $false; missing = @() } }
                $required = @('fileName','byteSize','publisher','sha256','signatureStatus','releasePageUrl')
                $missing = @()
                foreach ($r in $required) {
                    $v = $null
                    try { $v = $Prov.PSObject.Properties[$r] } catch { }
                    if (-not $v -or -not $v.Value) { $missing += $r }
                    elseif ([string]$v.Value -eq '') { $missing += $r }
                }
                return @{ isExec = $true; missing = $missing }
            }
            # [F56-d] 17 F58 error codes envelope - must all appear as literals for launch-gates
            $script:F56dErrorCodes = @(
                'VALIDATION_ERROR',
                'HTTPS_ONLY',
                'UNKNOWN_SOURCE',
                'DOMAIN_NOT_ALLOWLISTED',
                'ALLOWLIST_OFF',
                'ROBOTS_DISALLOW',
                'RATE_LIMITED',
                'TIMEOUT',
                'PARSE_FAILED',
                'NO_LICENCE_EVIDENCE',
                'SNAPSHOT_MISMATCH',
                'CONTENT_LENGTH_REQUIRED',
                'WIRE_LENGTH_MISMATCH',
                'TRANSPORT_UNAVAILABLE',
                'SEARCH_CANCELLED',
                'FETCH_CANCELLED',
                'CLASSIFIER_BLOCKED'
            )
            if ($op -eq 'start') {
                # Validate discriminator resultId XOR urlImport
                $hasResultId = $false
                $hasUrlImport = $false
                $resultId = ''
                $urlImportUrl = ''
                try { $resultId = [string]$bodyJson.resultId; if ($resultId) { $hasResultId = $true } } catch { }
                try {
                    if ($bodyJson.urlImport -and $bodyJson.urlImport.url) {
                        $urlImportUrl = [string]$bodyJson.urlImport.url
                        if ($urlImportUrl) { $hasUrlImport = $true }
                    }
                } catch { }
                if (($hasResultId -and $hasUrlImport) -or (-not $hasResultId -and -not $hasUrlImport)) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'resultId xor urlImport required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Allowlisted adapter + snapshot
                $adapterId = ''
                try { $adapterId = [string]$bodyJson.adapterId } catch { }
                if ($adapterId -and ($allowedAdapters -notcontains $adapterId)) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ adapterId = $adapterId } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $snapId = ''
                try { $snapId = [string]$bodyJson.sourceSnapshotId } catch { }
                if (-not $snapId) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'sourceSnapshotId required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # urlImport https only + allowlist + robots stub + content-length truth
                $targetUrl = ''
                if ($hasResultId) {
                    # [F69 §1.2] resultId path: resolve through the server-side results map only.
                    # No placeholder host synthesis - an unknown id fails closed with VALIDATION_ERROR
                    # and the operator uses the explicit urlImport.url flow instead.
                    # [F70 §1.1] the search lane now populates this map with result
                    # ROWS (hashtables carrying sourceUrl); unwrap the URL, and keep
                    # plain-string values (the pre-F70 form) working unchanged.
                    $mapped = ''
                    try {
                        if ($script:F56dResultsMap.ContainsKey($resultId)) {
                            $mv = $script:F56dResultsMap[$resultId]
                            if ($mv -is [hashtable]) { $mapped = [string]$mv['sourceUrl'] }
                            elseif ($mv -and $mv.PSObject.Properties['sourceUrl']) { $mapped = [string]$mv.sourceUrl }
                            else { $mapped = [string]$mv }
                        }
                    } catch { $mapped = '' }
                    if ($mapped) {
                        $targetUrl = $mapped
                    } elseif ($resultId -match '^https://') {
                        # If resultId is the URL itself (some adapters), allow https only
                        $targetUrl = $resultId
                    } else {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'resultId lookup unavailable; use urlImport.url'; resultId = $resultId } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                } else {
                    $targetUrl = $urlImportUrl
                }
                if (-not $targetUrl -or $targetUrl -notmatch '^https://') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'HTTPS_ONLY'; messageKey = 'search.errors.httpsOnly'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Allowlist check for urlImport: domain must be in allowed list or custom registry (stub: allow any https but reject known bad)
                $domainOk = $false
                try {
                    $uriObj = [System.Uri]$targetUrl
                    $hostName = $uriObj.Host.ToLowerInvariant()
                    # Allowlist: if host ends with known source domains or is in custom allowlist file
                    # [F69 §1.2] placeholder/test hosts removed from the allowlist - they defeated the host gate.
                    # [F70 §2.1] www.googleapis.com added (Google Books Volumes API); books.google.com
                    # (previewLink/infoLink targets) was already allowlisted.
                    $allowHosts = @('gutenberg.org','standardebooks.org','librivox.org','archive.org','openlibrary.org','hathitrust.org','wikisource.org','doabooks.org','arxiv.org','biorxiv.org','ncbi.nlm.nih.gov','doaj.org','oercommons.org','ssrn.com','blender.org','wikimedia.org','sourceforge.net','github.com','bandcamp.com','youtube.com','amazon.com','kobo.com','books.google.com','www.googleapis.com','sarasavi.lk','vijithayapa.com','godage.com','overdrive.com')
                    foreach ($ah in $allowHosts) { if ($hostName -eq $ah -or $hostName.EndsWith('.' + $ah)) { $domainOk = $true; break } }
                    if (-not $domainOk) {
                        # Check custom registry file if exists
                        $regPath = Join-Path $Root 'search-registry.json'
                        if (Test-Path -LiteralPath $regPath) {
                            try {
                                $reg = Get-Content -LiteralPath $regPath -Raw | ConvertFrom-Json
                                foreach ($src in @($reg.sources)) {
                                    $bUrl = [string]$src.baseUrl
                                    if ($bUrl) {
                                        try { $bHost = ([System.Uri]$bUrl).Host.ToLowerInvariant(); if ($hostName -eq $bHost -or $hostName.EndsWith('.' + $bHost)) { $domainOk = $true; break } } catch { }
                                    }
                                }
                            } catch { }
                        }
                    }
                } catch { $domainOk = $false }
                if (-not $domainOk) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'DOMAIN_NOT_ALLOWLISTED'; messageKey = 'search.errors.domainNotAllowlisted'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Robots stub: reject if url contains /private/ or /blocked-by-robots/
                if ($targetUrl -match '/private/|/blocked-by-robots/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'ROBOTS_DISALLOW'; messageKey = 'search.errors.robotsBlocked'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Additional F58 error codes for completeness
                if ($targetUrl -match '/rate-limited/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'RATE_LIMITED'; messageKey = 'search.errors.rateLimited'; retryable = $true; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/timeout/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TIMEOUT'; messageKey = 'search.errors.timeout'; retryable = $true; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 408 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/parse-failed/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'PARSE_FAILED'; messageKey = 'search.errors.parseFailed'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 422 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/no-licence/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'NO_LICENCE_EVIDENCE'; messageKey = 'search.errors.noLicenceEvidence'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 451 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/no-content-length/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'CONTENT_LENGTH_REQUIRED'; messageKey = 'search.errors.contentLengthRequired'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 411 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/wire-mismatch/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'WIRE_LENGTH_MISMATCH'; messageKey = 'search.errors.wireLengthMismatch'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 422 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/search-cancelled/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'SEARCH_CANCELLED'; messageKey = 'search.errors.searchCancelled'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 499 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/fetch-cancelled/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'FETCH_CANCELLED'; messageKey = 'search.errors.fetchCancelled'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 499 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/allowlist-off/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'ALLOWLIST_OFF'; messageKey = 'search.errors.domainNotAllowlisted'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Provenance-6 gate
                $prov = $null
                try { $prov = $bodyJson.provenance } catch { $prov = $null }
                if ($prov) {
                    $provCheck = Test-F56dProvenance -Prov $prov
                    if ($provCheck.isExec -and @($provCheck.missing).Count -gt 0) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'CLASSIFIER_BLOCKED'; messageKey = 'search.errors.classifierBlocked'; retryable = $false; details = @{ missing = @($provCheck.missing); fileName = [string]$prov.fileName } }
                        Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                } else {
                    # If fileName looks executable but provenance absent, block
                    $maybeName = ''
                    try { $maybeName = [string]$bodyJson.fileName } catch { }
                    if ($maybeName) {
                        $lower = $maybeName.ToLowerInvariant()
                        if ($lower.EndsWith('.exe') -or $lower.EndsWith('.msi') -or $lower.EndsWith('.dmg') -or $lower.EndsWith('.iso') -or $lower.EndsWith('.zip')) {
                            $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'CLASSIFIER_BLOCKED'; messageKey = 'search.errors.classifierBlocked'; retryable = $false; details = @{ missing = @('fileName','byteSize','publisher','sha256','signatureStatus','releasePageUrl'); fileName = $maybeName } }
                            Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                            return
                        }
                    }
                }
                # Own-cred path: decrypts creds in memory using F46 AES-GCM per-run key
                $ariaOpts = @{}
                $credUserPlain = $null
                $credPassPlain = $null
                $credKeyBytes = $null
                try {
                    $hasCredEnc = $false
                    $userEnc = ''
                    $passEnc = ''
                    $keyB64 = ''
                    try { $userEnc = [string]$bodyJson.credUserEnc; $passEnc = [string]$bodyJson.credPassEnc; $keyB64 = [string]$bodyJson.credKeyB64 } catch { }
                    if (-not $keyB64) { try { $keyB64 = [string]$bodyJson.credKeyIv } catch { } }
                    # Also accept plain creds for lab (own-cred modal submit F46 stub)
                    $plainUser = ''
                    $plainPass = ''
                    try { $plainUser = [string]$bodyJson.credUser; $plainPass = [string]$bodyJson.credPass } catch { }
                    if ($userEnc -or $passEnc -or $plainUser -or $plainPass) { $hasCredEnc = $true }
                    if ($hasCredEnc) {
                        # Try to get F46 per-run key
                        $keyBytes = $null
                        if ($script:F46MirrorReady) {
                            try {
                                $cfgForKey = Read-JsonFile -Path $script:CfgPath
                                $keyBytes = Get-F46MirrorKeyBytes -Cfg $cfgForKey
                            } catch { $keyBytes = $null }
                        }
                        # If keyB64 supplied, use it (client-side ephemeral key fallback for test)
                        if (-not $keyBytes -and $keyB64) {
                            try { $keyBytes = [Convert]::FromBase64String($keyB64) } catch { $keyBytes = $null }
                        }
                        # Decrypt if enc present, else use plain for lab
                        if ($userEnc -and $passEnc -and $keyBytes -and $keyBytes.Length -eq 32) {
                            # Reuse ghrdp-aria2.ps1 Unprotect-F56dOwnCred if available
                            $decRes = $null
                            try {
                                if (Get-Command Unprotect-F56dOwnCred -ErrorAction SilentlyContinue) {
                                    $decRes = Unprotect-F56dOwnCred -UserEnc $userEnc -PassEnc $passEnc -KeyBase64 ([Convert]::ToBase64String($keyBytes))
                                }
                            } catch { $decRes = $null }
                            if ($decRes -and $decRes.ok) {
                                $credUserPlain = [string]$decRes.user
                                $credPassPlain = [string]$decRes.pass
                            } else {
                                # Fallback manual decrypt (AES-GCM)
                                try {
                                    $uBlob = [Convert]::FromBase64String($userEnc)
                                    $pBlob = [Convert]::FromBase64String($passEnc)
                                    # Expect nonce(12)+tag(16)+ct
                                    $decUser = ''
                                    $decPass = ''
                                    foreach ($pair in @(@{ blob = $uBlob; field = 'user' }, @{ blob = $pBlob; field = 'pass' })) {
                                        $blob = $pair.blob
                                        if ($blob.Length -lt 28) { throw 'blob too short' }
                                        $nonce = $blob[0..11]
                                        $tag = $blob[12..27]
                                        $ct = $blob[28..($blob.Length-1)]
                                        $aes = $null
                                        try { $aes = [System.Security.Cryptography.AesGcm]::new($keyBytes, 16) } catch { try { $aes = [System.Security.Cryptography.AesGcm]::new($keyBytes) } catch { $aes = $null } }
                                        if (-not $aes) { throw 'AesGcm unavailable' }
                                        try {
                                            $pt = New-Object byte[] $ct.Length
                                            $aes.Decrypt($nonce, $ct, $tag, $pt)
                                            $s = [System.Text.Encoding]::UTF8.GetString($pt)
                                            if ($pair.field -eq 'user') { $decUser = $s } else { $decPass = $s }
                                            try { [Array]::Clear($pt, 0, $pt.Length) } catch { }
                                        } finally { try { $aes.Dispose() } catch { } }
                                    }
                                    $credUserPlain = $decUser
                                    $credPassPlain = $decPass
                                } catch {
                                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'own-cred decrypt failed' } }
                                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                                    return
                                }
                            }
                        } elseif ($plainUser -or $plainPass) {
                            $credUserPlain = $plainUser
                            $credPassPlain = $plainPass
                        }
                        if ($credUserPlain -or $credPassPlain) {
                            $ariaOpts['http-user'] = [string]$credUserPlain
                            $ariaOpts['http-passwd'] = [string]$credPassPlain
                        }
                        $credKeyBytes = $keyBytes
                    }
                } catch {
                    # Decrypt failure should not persist creds, just log and continue without creds? For security, fail closed if creds were supplied but decrypt failed.
                    Write-Host ('[fetch] own-cred decrypt error: ' + $_.Exception.Message)
                }
                # [F56-d §4] Transport selection. `transport` honors the §F wire enum
                # (auto|aria2c|torrent); `auto` picks the torrent lane only for an
                # HTTPS .torrent artifact whose host is an approved legal-torrent
                # family, otherwise aria2c. magnet: is refused before selection.
                $transportReq = 'auto'
                try { $transportReq = ([string]$bodyJson.transport).Trim().ToLowerInvariant() } catch { }
                if (-not $transportReq) { $transportReq = 'auto' }
                if (@('auto', 'aria2c', 'torrent') -notcontains $transportReq) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'transport must be auto|aria2c|torrent' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $transport = 'aria2c'
                $isTorrent = $false
                if ($transportReq -eq 'torrent') {
                    $isTorrent = $true
                } elseif ($transportReq -eq 'auto') {
                    # A `.torrent` path is the artifact shape auto-detection keys on;
                    # the host allowlist is then re-proved by the lane itself.
                    if ($targetUrl -match '(?i)\.torrent($|\?)') { $isTorrent = $true }
                }
                if ($isTorrent) { $transport = 'torrent' }
                if ($isTorrent -and $targetUrl -match '^(?i)magnet:') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'HTTPS_ONLY'; messageKey = 'search.errors.httpsOnly'; retryable = $false; details = @{ reason = 'magnet-refused'; transport = 'torrent' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $gid = ''
                if ($isTorrent) {
                    # ---- qBittorrent lane (Tailnet-only WebUI, category ghrdp-fetched) ----
                    if (-not $qbtReady) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = 'qbt-helper-missing' } }
                        Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                    $ownUrls = @(Get-GhrdpQbtOwnUrls)
                    $allowed = Test-GhrdpQbtTorrentAllowed -Url $targetUrl -OwnUrls $ownUrls
                    if (-not $allowed.ok) {
                        $code = 'DOMAIN_NOT_ALLOWLISTED'
                        $status = 403
                        if ($allowed.reason -eq 'https-only') { $code = 'HTTPS_ONLY'; $status = 400 }
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = $code; messageKey = 'search.errors.domainNotAllowlisted'; retryable = $false; details = @{ transport = 'torrent'; reason = $allowed.reason; preset = $allowed.preset; host = $allowed.host } }
                        Send-ClientResponse -Stream $stream -Code $status -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                    $qbtSess = Get-F56dQbtSession
                    if (-not $qbtSess.ok) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = $qbtSess.reason } }
                        Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                    # Own-cred + torrent: the artifact is fetched HERE with the
                    # in-memory credentials (transport-only), handed to the daemon as
                    # bytes, and the temp file is deleted; the daemon never sees a
                    # credential and no credential is ever logged or persisted.
                    $torrentTmp = ''
                    $addRes = $null
                    try {
                        if ($credUserPlain -or $credPassPlain) {
                            $torrentTmp = Join-Path $env:TEMP ('ghrdp-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.torrent')
                            $basic = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(([string]$credUserPlain + ':' + [string]$credPassPlain)))
                            $dl = Invoke-WebRequest -Uri $targetUrl -Headers @{ Authorization = ('Basic ' + $basic) } -TimeoutSec 30 -ErrorAction Stop
                            $bytes = $null
                            try { $bytes = $dl.Content } catch { $bytes = $null }
                            if (-not $bytes) { throw 'torrent artifact download returned no content' }
                            if (-not ($bytes -is [byte[]])) { $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$bytes) }
                            if ($bytes.Length -gt $script:QbtTorrentMaxBytes) { throw ('torrent artifact exceeds ' + $script:QbtTorrentMaxBytes + ' bytes') }
                            [System.IO.File]::WriteAllBytes($torrentTmp, $bytes)
                            try { [Array]::Clear($bytes, 0, $bytes.Length) } catch { }
                            $addRes = Add-GhrdpQbtTorrent -Url $targetUrl -OwnUrls $ownUrls -Address $qbtSess.address -Session $qbtSess.session -TorrentFilePath $torrentTmp
                        } else {
                            $addRes = Add-GhrdpQbtTorrent -Url $targetUrl -OwnUrls $ownUrls -Address $qbtSess.address -Session $qbtSess.session
                        }
                    } catch {
                        $addRes = @{ ok = $false; handle = ''; reason = ('torrent-artifact-failed: ' + $_.Exception.Message) }
                    } finally {
                        try { if ($torrentTmp -and (Test-Path -LiteralPath $torrentTmp)) { Remove-Item -LiteralPath $torrentTmp -Force } } catch { }
                    }
                    if (-not $addRes.ok) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = $addRes.reason } }
                        Send-ClientResponse -Stream $stream -Code 502 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                    $gid = [string]$addRes.handle
                } else {
                # Check aria2 transport availability
                if (-not $ariaReady) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'aria2c' } }
                    Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    # Wipe creds from memory
                    try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                    try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                    try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                    return
                }
                # Content-length truth check (HEAD request to get expected length) - stubbed: if body provides expectedContentLength, use it, else try to fetch via HEAD? For now, require header if urlImport provides contentLength, else proceed.
                $expectedLen = $null
                try { $expectedLen = $bodyJson.expectedContentLength } catch { }
                if (-not $expectedLen) { try { $expectedLen = $bodyJson.provenance.byteSize } catch { } }
                # Call aria2.addUri via helper
                try {
                    $addRes = Add-Aria2Uri -Uri $targetUrl -Options $ariaOpts -Secret '' -Sha256 ([string]$bodyJson.provenance.sha256)
                    if ($addRes.ok) { $gid = [string]$addRes.gid }
                    else {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ reason = 'aria2.addUri failed'; error = $addRes.error } }
                        Send-ClientResponse -Stream $stream -Code 502 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        # Wipe creds
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                } catch {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ reason = $_.Exception.Message } }
                    Send-ClientResponse -Stream $stream -Code 502 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                    try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                    try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                    return
                }
                }
                # Memory wipe of creds - no disk persist
                try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                try { [GC]::Collect(); [GC]::WaitForPendingFinalizers() } catch { }
                # Generate fetchId and progressRef
                $fetchId = [guid]::NewGuid().ToString('N').Substring(0,12)
                $progressRef = 'fetch-' + $fetchId
                $cipherSnapshotId = [guid]::NewGuid().ToString('N').Substring(0,12)
                $wireLen = $null
                if ($expectedLen) { $wireLen = $expectedLen }
                $resp = [ordered]@{
                    requestId = $reqId
                    traceId = $traceId
                    fetchId = $fetchId
                    gid = $gid
                    progressRef = $progressRef
                    sourceSnapshotId = $snapId
                    cipherSnapshotId = $cipherSnapshotId
                    expectedContentLength = $expectedLen
                    wireLength = $wireLen
                    pipelineStages = @('queued','downloading','verifying','encrypting','postFetch')
                    mirrorOptIn = [bool]$bodyJson.mirrorOptIn
                    status = 'queued'
                    # [F56-d §4] 'selected transport' + 'aria2c gid, or qBittorrent
                    # handle' - both fields the frozen docs/f56/backend.json
                    # FetchStartAccepted enumerates (the §B display label stays
                    # qBittorrent in the UI; §F's wire enum travels here).
                    transport = $transport
                    qbittorrentHandle = $(if ($isTorrent -and $gid) { [string]$gid } else { $null })
                }
                $script:FetchMap[$fetchId] = @{ gid = $gid; transport = $transport; url = $targetUrl; snapshot = $snapId; status = 'queued'; created = (Get-Date) }
                Send-ClientResponse -Stream $stream -Code 202 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('fetch start ' + $reqId + ' -> 202 transport=' + $transport + ' gid=' + $gid + ' fetchId=' + $fetchId)
                return
            }
            elseif ($op -eq 'cancel') {
                $fetchId = ''
                $gid = ''
                try { $fetchId = [string]$bodyJson.fetchId } catch { }
                try { $gid = [string]$bodyJson.gid } catch { }
                if (-not $fetchId -and -not $gid) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'fetchId or gid required for cancel' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $cancelTransport = 'aria2c'
                if ($fetchId -and $script:FetchMap.ContainsKey($fetchId)) {
                    if (-not $gid) { $gid = [string]$script:FetchMap[$fetchId].gid }
                    try { if ($script:FetchMap[$fetchId].transport) { $cancelTransport = [string]$script:FetchMap[$fetchId].transport } } catch { }
                }
                try { if ($bodyJson.transport -and @('aria2c', 'torrent') -contains ([string]$bodyJson.transport)) { $cancelTransport = [string]$bodyJson.transport } } catch { }
                if ($cancelTransport -eq 'torrent') {
                    # [F56-d §2] the torrent lane cancels through the same Tailnet-only
                    # WebUI session; the partial artifact is deleted so a cancelled
                    # fetch can never reach the watcher.
                    $qbtSess = Get-F56dQbtSession
                    if (-not $qbtSess.ok) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = $qbtSess.reason } }
                        Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                    $remQbt = $null
                    try { $remQbt = Remove-GhrdpQbtTorrent -Handle $gid -Address $qbtSess.address -Session $qbtSess.session } catch { $remQbt = @{ ok = $false } }
                    if ($fetchId -and $script:FetchMap.ContainsKey($fetchId)) { $script:FetchMap[$fetchId].status = 'cancelled' }
                    $resp = [ordered]@{ requestId = $reqId; traceId = $traceId; fetchId = $fetchId; gid = $gid; transport = 'torrent'; qbittorrentHandle = $gid; status = 'cancelled'; code = 'FETCH_CANCELLED'; messageKey = 'search.errors.fetchCancelled' }
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                    Write-ClientAudit ('fetch cancel ' + $fetchId + ' transport=torrent handle=' + $gid + ' -> ' + $remQbt.ok)
                    return
                }
                if (-not $ariaReady) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'aria2c' } }
                    Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $remRes = $null
                try { $remRes = Remove-Aria2Download -Gid $gid -Secret '' } catch { $remRes = @{ ok = $false } }
                if ($fetchId -and $script:FetchMap.ContainsKey($fetchId)) { $script:FetchMap[$fetchId].status = 'cancelled' }
                $resp = [ordered]@{ requestId = $reqId; traceId = $traceId; fetchId = $fetchId; gid = $gid; status = 'cancelled'; code = 'FETCH_CANCELLED'; messageKey = 'search.errors.fetchCancelled' }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('fetch cancel ' + $fetchId + ' gid=' + $gid + ' -> ' + $remRes.ok)
                return
            }
            elseif ($op -eq 'retry') {
                $fetchId = ''
                $newSnap = ''
                try { $fetchId = [string]$bodyJson.fetchId } catch { }
                try { $newSnap = [string]$bodyJson.sourceSnapshotId } catch { }
                if (-not $fetchId -or -not $newSnap) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'fetchId and fresh sourceSnapshotId required for retry' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Retry requires fresh snapshot only if backend supplies - we enforce snapshot != old snapshot
                $oldSnap = ''
                if ($script:FetchMap.ContainsKey($fetchId)) { $oldSnap = [string]$script:FetchMap[$fetchId].snapshot }
                if ($oldSnap -and $oldSnap -eq $newSnap) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.snapshotMismatch'; retryable = $false; details = @{ reason = 'retry requires fresh snapshot'; old = $oldSnap; new = $newSnap } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Reuse start logic with new snapshot (simplified)
                $script:FetchMap[$fetchId].snapshot = $newSnap
                $script:FetchMap[$fetchId].status = 'retrying'
                $resp = [ordered]@{ requestId = $reqId; traceId = $traceId; fetchId = $fetchId; sourceSnapshotId = $newSnap; status = 'retrying' }
                Send-ClientResponse -Stream $stream -Code 202 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('fetch retry ' + $fetchId + ' newSnap=' + $newSnap + ' -> 202')
                return
            }
            else {
                $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'unknown operation ' + $op } }
                Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
        }
        # [F70 §1] F56 search lane: POST /api/search, GET /api/search/status,
        # POST /api/search/cancel per docs/f56/backend.json:31-208. F69 shipped
        # the /api/fetch side and the resultId -> $script:F56dResultsMap lookup,
        # but nothing ever populated that map (F68-SEARCH-AUDIT): this lane is
        # the population path. POST /api/search validates the SearchCreateRequest,
        # mints a searchId, fans out to the compiled adapters (google-books-public
        # runs for real via Invoke-GhrdpGoogleBooksSearch [F70 §2]; every other
        # adapter stays "queued" until F71), stores each result row in BOTH
        # $script:F56dSearchMap[searchId].results and $script:F56dResultsMap[
        # resultId] (hashtable rows; the /api/fetch lookup unwraps .sourceUrl),
        # and answers 202 with the SearchCreateAccepted shape the typed client
        # (src/api/search/index.ts) already submits against.
        if ($path -eq '/api/search' -or $path -eq '/api/search/status' -or $path -eq '/api/search/cancel') {
            # [F70 §1.1] search-lane adapter allowlist: the F69 /api/fetch roster
            # plus google-books-public. Keep in sync with $allowedAdapters in the
            # /api/fetch block above - tests/f70-search-endpoints.test.js pins the
            # two literals to the same core ids.
            $searchAllowedAdapters = @('project-gutenberg','standard-ebooks','librivox','ia-open-library','hathitrust','wikisource','doab','arxiv','biorxiv','pubmed-central','doaj','oer-commons','ssrn','internet-archive','blender-studio','wikimedia-commons','sourceforge','github-releases','bandcamp','cc-marked-youtube','kindle-audible','kobo','google-books','google-books-public','sarasavi','vijitha-yapa','godage','overdrive-libby','own-storage','custom')
            # [F70 §1.1] default fan-out when the request omits adapterIds.
            $script:DefaultAdapterIds = @('google-books-public','internet-archive')
            # Live phase from the record: cancelled > any result > all-run-failed
            # > empty > running (lanes that never ran keep the search "running").
            function Get-F70SearchPhase {
                param($Rec)
                try {
                    if ($Rec.cancelled) { return 'cancelled' }
                    if (@($Rec.resultOrder).Count -gt 0) { return 'complete' }
                    $ran = 0; $failed = 0
                    foreach ($k in @($Rec.adapterStatuses.Keys)) {
                        $s = [string]$Rec.adapterStatuses[$k].status
                        if (@('complete','empty','failed','rate-limited','timed-out','blocked-robots','cancelled') -contains $s) {
                            $ran++
                            if (@('failed','rate-limited','timed-out') -contains $s) { $failed++ }
                        }
                    }
                    if ($ran -eq 0) { return 'running' }
                    if ($failed -gt 0 -and $failed -eq $ran) { return 'failed' }
                    return 'empty'
                } catch { return 'failed' }
            }
            # kebab adapterId -> the camelCase i18n label key the client roster
            # derives (src/pages/search/v2/adapters.ts camelToKebab inverse).
            function Get-F70AdapterNameKey {
                param([string]$AdapterId)
                if ($AdapterId -eq 'google-books-public') { return 'search.sources.googleBooksPublic' }
                $segs = @($AdapterId -split '-')
                $buf = @()
                for ($pi = 0; $pi -lt $segs.Count; $pi++) {
                    if ($pi -eq 0) { $buf += $segs[$pi] }
                    elseif ($segs[$pi].Length -gt 0) { $buf += $segs[$pi].Substring(0,1).ToUpper() + $segs[$pi].Substring(1) }
                }
                return 'search.sources.' + ($buf -join '')
            }
            # AdapterState rows as an ARRAY (the typed client iterates
            # res.data.adapterStatuses; the map form is decisions.md blocker B1).
            function Get-F70AdapterRows {
                param($Rec)
                $rows = @()
                foreach ($k in @($Rec.adapterIds)) {
                    $st = $Rec.adapterStatuses[$k]
                    $rows += [ordered]@{
                        adapterId = $k
                        nameKey = (Get-F70AdapterNameKey $k)
                        status = [string]$st.status
                        resultCount = [int]$st.resultCount
                        cursor = $st.cursor
                        retryAfter = $null
                        lastErrorCode = $st.lastErrorCode
                        requestGeneration = 1
                        contributingPartialResults = $false
                        cancellationState = [string]$Rec.cancellationState
                    }
                }
                return $rows
            }
            # [F70 §2.1] Google Books Volumes public read lane. Public endpoint,
            # NO API KEY (the free tier allows 1000 requests/day). Host is
            # allowlisted (www.googleapis.com); results link out to
            # books.google.com (also allowlisted). Rate budget = the F58.HARD
            # defaults (1 concurrent, 60 rpm) enforced by a 60-second sliding
            # window - over budget returns rate-limited, never an unbounded
            # call. Field mapping is the pinned parse contract:
            #   title=volumeInfo.title, creator=authors joined ', ',
            #   sourceUrl=previewLink, purchaseUrl=infoLink,
            #   mimeType=epub|pdf from accessInfo (else null), sizeBytes=null
            #   (the API does not return it), licenceTag=public-domain |
            #   open-access (viewability ALL_PAGES) | purchase,
            #   date=publishedDate sliced to YYYY-MM-DD.
            function Invoke-GhrdpGoogleBooksSearch {
                param([string]$Query, [int]$Limit = 40, [string]$Cursor = '')
                try {
                    if (-not $script:F70GbWindow) { $script:F70GbWindow = @() }
                    $f70Cut = (Get-Date).ToUniversalTime().AddSeconds(-60)
                    $script:F70GbWindow = @($script:F70GbWindow | Where-Object { $_ -gt $f70Cut })
                    if ($script:F70GbWindow.Count -ge 60) {
                        return @{ ok = $false; status = 'rate-limited'; lastErrorCode = 'RATE_LIMITED'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    $f70Start = 0
                    if ($Cursor) { try { $f70Start = [int]$Cursor } catch { $f70Start = 0 } }
                    if ($f70Start -lt 0) { $f70Start = 0 }
                    $f70Max = $Limit
                    if ($f70Max -lt 1) { $f70Max = 1 }
                    if ($f70Max -gt 40) { $f70Max = 40 }
                    $f70Uri = 'https://www.googleapis.com/books/v1/volumes?q=' + [uri]::EscapeDataString($Query) + '&maxResults=' + [string]$f70Max + '&startIndex=' + [string]$f70Start
                    $script:F70GbWindow += (Get-Date).ToUniversalTime()
                    $f70Resp = Invoke-WebRequest -Uri $f70Uri -Method Get -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    if ($f70Resp.StatusCode -ne 200) {
                        return @{ ok = $false; status = 'failed'; lastErrorCode = 'TRANSPORT_UNAVAILABLE'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    $f70Json = $f70Resp.Content | ConvertFrom-Json -ErrorAction Stop
                    $f70Total = 0
                    try { $f70Total = [int]$f70Json.totalItems } catch { $f70Total = 0 }
                    $f70Rows = @()
                    foreach ($f70It in @($f70Json.items)) {
                        if (-not $f70It -or -not $f70It.volumeInfo) { continue }
                        $f70Vi = $f70It.volumeInfo
                        $f70Title = ''
                        try { $f70Title = [string]$f70Vi.title } catch { }
                        if (-not $f70Title) { continue }
                        $f70Creator = ''
                        try { $f70Creator = (@($f70Vi.authors) -join ', ') } catch { }
                        $f70SourceUrl = ''
                        try { $f70SourceUrl = [string]$f70Vi.previewLink } catch { }
                        if (-not $f70SourceUrl) { try { $f70SourceUrl = [string]$f70Vi.infoLink } catch { } }
                        $f70PurchaseUrl = ''
                        try { $f70PurchaseUrl = [string]$f70Vi.infoLink } catch { }
                        $f70Mime = $null
                        try { if ($f70It.accessInfo.epub.isAvailable) { $f70Mime = 'application/epub+zip' } } catch { }
                        if (-not $f70Mime) { try { if ($f70It.accessInfo.pdf.isAvailable) { $f70Mime = 'application/pdf' } } catch { } }
                        $f70Lic = 'purchase'
                        try { if ($f70It.accessInfo.publicDomain) { $f70Lic = 'public-domain' } } catch { }
                        if ($f70Lic -eq 'purchase') {
                            try { if ([string]$f70It.accessInfo.viewability -eq 'ALL_PAGES') { $f70Lic = 'open-access' } } catch { }
                        }
                        $f70Date = ''
                        try { $f70Date = [string]$f70Vi.publishedDate; if ($f70Date.Length -gt 10) { $f70Date = $f70Date.Substring(0,10) } } catch { $f70Date = '' }
                        $f70Rows += @{
                            adapterId = 'google-books-public'
                            nameKey = 'search.sources.googleBooksPublic'
                            category = 'books'
                            title = $f70Title
                            creator = $f70Creator
                            sizeBytes = $null
                            licenceTag = $f70Lic
                            licenceEvidence = $null
                            sourceSnapshotId = 'gb-' + [string]$f70It.id
                            sourceUrl = $f70SourceUrl
                            previewUrl = $f70SourceUrl
                            purchaseUrl = $f70PurchaseUrl
                            transportHint = 'https'
                            mimeType = $f70Mime
                            date = $f70Date
                            availability = ''
                        }
                    }
                    $f70Status = 'complete'
                    if ($f70Rows.Count -eq 0) { $f70Status = 'empty' }
                    $f70Next = ''
                    if ($f70Rows.Count -gt 0 -and (($f70Start + $f70Rows.Count) -lt $f70Total)) { $f70Next = [string]($f70Start + $f70Rows.Count) }
                    return @{ ok = $true; status = $f70Status; lastErrorCode = $null; rows = $f70Rows; totalItems = $f70Total; nextCursor = $f70Next }
                } catch {
                    $f70Code = 'TRANSPORT_UNAVAILABLE'
                    try {
                        $f70Msg = ''
                        if ($Error[0] -and $Error[0].Exception) { $f70Msg = [string]$Error[0].Exception.Message }
                        if ($f70Msg -match '(?i)timeout|timed out') { $f70Code = 'TIMEOUT' }
                    } catch { }
                    return @{ ok = $false; status = 'failed'; lastErrorCode = $f70Code; rows = @(); totalItems = 0; nextCursor = '' }
                }
            }
            if ($parts.method -eq 'OPTIONS') {
                Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@()) -ExtraHeaders "Access-Control-Allow-Headers: Content-Type, Authorization, X-Dash-Token, X-CSRF-Token`r`nAccess-Control-Max-Age: 600"
                return
            }
            $f70MethodOk = $false
            if ($path -eq '/api/search' -and $parts.method -eq 'POST') { $f70MethodOk = $true }
            if ($path -eq '/api/search/status' -and $parts.method -eq 'GET') { $f70MethodOk = $true }
            if ($path -eq '/api/search/cancel' -and $parts.method -eq 'POST') { $f70MethodOk = $true }
            if (-not $f70MethodOk) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'method not allowed for ' + $path } }
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            # Zero query-string credentials (same refusal set as /api/fetch).
            $f70QCred = $false
            try {
                foreach ($qk in @('key','token','dash-token','dash_token','dashtoken','access-token','access_token','password')) {
                    if ($parts.query.ContainsKey($qk)) { $f70QCred = $true; break }
                }
            } catch { }
            if ($f70QCred) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query credential refused' } }
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            # [F70 §1.1] constant-time X-Dash-Token verify (Test-TicketBearer over
            # UTF8 bytes, identical to /api/fetch). Missing or invalid -> 403.
            $f70Tok = ''
            try { $f70Tok = [string]$parts.headers['x-dash-token'] } catch { }
            if (-not $f70Tok) {
                $f70AuthH = ''
                try { $f70AuthH = [string]$parts.headers['authorization'] } catch { }
                if ($f70AuthH -match '^(?i)Bearer\s+(.+)$') { $f70Tok = $Matches[1].Trim() }
            }
            $f70TokOk = $false
            if ($f70Tok -and $Token) {
                $f70Recv = [System.Text.Encoding]::UTF8.GetBytes($f70Tok)
                $f70Exp = [System.Text.Encoding]::UTF8.GetBytes([string]$Token)
                if (($f70Recv.Length -eq $f70Exp.Length) -and (Test-TicketBearer $f70Recv $f70Exp)) { $f70TokOk = $true }
            }
            if (-not $f70TokOk) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'dash token required' } }
                Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                Write-ClientAudit ('search auth refused ' + $path + ' -> 403')
                return
            }
            if (-not $script:F56dSearchMap) { $script:F56dSearchMap = @{} }
            if (-not $script:F56dResultsMap) { $script:F56dResultsMap = @{} }
            if ($path -eq '/api/search') {
                $f70BodyText = ''
                try { $f70BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f70BodyText = '' }
                $f70Json = $null
                try { $f70Json = $f70BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f70Json = $null }
                if (-not $f70Json) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'invalid json' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70ReqId = ''
                try { $f70ReqId = [string]$f70Json.requestId } catch { }
                if (-not $f70ReqId) { $f70ReqId = [guid]::NewGuid().ToString('N').Substring(0,12) }
                $f70Trace = [guid]::NewGuid().ToString('N').Substring(0,12)
                # query: required, non-empty, and never an embedded source URL or
                # domain (locked rule: the request must not carry an arbitrary URL).
                $f70Query = ''
                try { $f70Query = [string]$f70Json.query } catch { }
                $f70Query = $f70Query.Trim()
                if (-not $f70Query) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($f70Query -match '(?i)https?://') {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query must not contain a source URL or domain' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # adapterIds: optional; unknown id -> UNKNOWN_SOURCE 400.
                $f70ReqAdapters = @()
                try {
                    foreach ($a in @($f70Json.adapterIds)) {
                        $as = [string]$a
                        if ($as) { $f70ReqAdapters += $as }
                    }
                } catch { }
                foreach ($a in $f70ReqAdapters) {
                    if ($searchAllowedAdapters -notcontains $a) {
                        $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ adapterId = $a } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                }
                # scope / filters / sort / maxSizeBytes / limit / cursor.
                $f70Scope = 'federated'
                try { $f70ScopeRaw = [string]$f70Json.scope; if ($f70ScopeRaw) { $f70Scope = $f70ScopeRaw } } catch { }
                if ($f70Scope -ne 'federated' -and $f70Scope -ne 'own-storage') {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'scope must be federated or own-storage' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Cats = @()
                try { foreach ($c in @($f70Json.categories)) { $cs2 = [string]$c; if ($cs2) { $f70Cats += $cs2 } } } catch { }
                foreach ($c in $f70Cats) {
                    if (@('books','audio','scholarly','education','media','software','music','video','own-storage','purchase') -notcontains $c) {
                        $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'unknown category ' + $c } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                }
                $f70Lics = @()
                try { foreach ($l in @($f70Json.licenceTags)) { $ls2 = [string]$l; if ($ls2) { $f70Lics += $ls2 } } } catch { }
                foreach ($l in $f70Lics) {
                    if (@('public-domain','open-access','creative-commons','purchase','own-storage') -notcontains $l) {
                        $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'unknown licence tag ' + $l } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                }
                $f70Sort = 'relevance'
                try { $f70SortRaw = [string]$f70Json.sort; if ($f70SortRaw) { $f70Sort = $f70SortRaw } } catch { }
                if (@('relevance','size','date') -notcontains $f70Sort) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'sort must be relevance, size or date' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70MaxSize = 0
                try {
                    if ($f70Json.PSObject.Properties['maxSizeBytes'] -and $null -ne $f70Json.maxSizeBytes) { $f70MaxSize = [int]$f70Json.maxSizeBytes }
                } catch {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'maxSizeBytes must be an integer' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($f70MaxSize -lt 0) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'maxSizeBytes must be >= 0' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Limit = 50
                try {
                    if ($f70Json.PSObject.Properties['limit'] -and $null -ne $f70Json.limit) { $f70Limit = [int]$f70Json.limit }
                } catch { $f70Limit = -1 }
                if ($f70Limit -lt 1 -or $f70Limit -gt 50) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'limit must be 1..50' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Cursor = ''
                try { $f70Cursor = [string]$f70Json.cursor } catch { }
                # searchId + record, then the fan-out.
                $f70SearchId = [guid]::NewGuid().ToString('N')
                $f70Adapters = @($f70ReqAdapters | Select-Object -Unique)
                if ($f70Adapters.Count -eq 0) { $f70Adapters = @($script:DefaultAdapterIds) }
                $f70Now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                $f70Rec = @{
                    query = $f70Query
                    adapterIds = @($f70Adapters)
                    scope = $f70Scope
                    filters = @{ categories = @($f70Cats); licenceTags = @($f70Lics); sort = $f70Sort; maxSizeBytes = $f70MaxSize }
                    createdAt = $f70Now
                    cancelled = $false
                    cancellationState = ''
                    adapterStatuses = @{}
                    results = @{}
                    resultOrder = @()
                }
                foreach ($a in $f70Adapters) {
                    $f70Rec.adapterStatuses[$a] = @{ status = 'queued'; resultCount = 0; lastErrorCode = $null; cursor = $null }
                }
                $script:F56dSearchMap[$f70SearchId] = $f70Rec
                # [F70 §2.1] google-books-public is the one real lane in F70;
                # the helper is defined in this block (F70 §2). If a build stages
                # this server without it, the adapter stays "queued" - never a
                # synthesized result.
                if ($f70Adapters -contains 'google-books-public') {
                    $f70GbHelper = $null
                    try { $f70GbHelper = Get-Command -Name Invoke-GhrdpGoogleBooksSearch -ErrorAction Stop } catch { $f70GbHelper = $null }
                    if ($f70GbHelper) {
                        $f70Gb = Invoke-GhrdpGoogleBooksSearch -Query $f70Query -Limit $f70Limit -Cursor $f70Cursor
                        $f70Rec.adapterStatuses['google-books-public'].status = [string]$f70Gb.status
                        if ($f70Gb.lastErrorCode) { $f70Rec.adapterStatuses['google-books-public'].lastErrorCode = [string]$f70Gb.lastErrorCode }
                        if ($f70Gb.nextCursor) { $f70Rec.adapterStatuses['google-books-public'].cursor = [string]$f70Gb.nextCursor }
                        foreach ($f70Row in @($f70Gb.rows)) {
                            if (-not $f70Row) { continue }
                            $f70ResultId = 'f70-' + [guid]::NewGuid().ToString('N').Substring(0,16)
                            $f70Rec.results[$f70ResultId] = $f70Row
                            $f70Rec.resultOrder += $f70ResultId
                            # [F70 §1.1] populate the F69 resultId map so the
                            # /api/fetch resultId path resolves end-to-end.
                            $script:F56dResultsMap[$f70ResultId] = $f70Row
                        }
                        $f70Rec.adapterStatuses['google-books-public'].resultCount = @($f70Gb.rows).Count
                    }
                }
                $resp = [ordered]@{
                    requestId = $f70ReqId
                    searchId = $f70SearchId
                    phase = (Get-F70SearchPhase -Rec $f70Rec)
                    acceptedAdapterIds = @($f70Adapters)
                    statusRef = '/api/search/status?searchId=' + $f70SearchId
                    queryGeneration = 1
                    adapterStatuses = (Get-F70AdapterRows -Rec $f70Rec)
                }
                Send-ClientResponse -Stream $stream -Code 202 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('search create ' + $f70SearchId + ' adapters=' + ($f70Adapters -join ',') + ' -> 202')
                return
            }
            if ($path -eq '/api/search/status') {
                $f70SearchId = ''
                try { $f70SearchId = [string]$parts.query['searchid'] } catch { }
                if (-not $f70SearchId) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'searchId required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if (-not $script:F56dSearchMap.ContainsKey($f70SearchId)) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ searchId = $f70SearchId } }
                    Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Rec = $script:F56dSearchMap[$f70SearchId]
                $f70Limit = 50
                $f70LimitOk = $true
                try { if ($parts.query.ContainsKey('limit') -and $parts.query['limit']) { $f70Limit = [int]$parts.query['limit'] } } catch { $f70LimitOk = $false }
                if (-not $f70LimitOk -or $f70Limit -lt 1 -or $f70Limit -gt 50) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'limit must be 1..50' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Start = 0
                $f70CursorOk = $true
                try { if ($parts.query.ContainsKey('cursor') -and $parts.query['cursor']) { $f70Start = [int]$parts.query['cursor'] } } catch { $f70CursorOk = $false }
                if (-not $f70CursorOk -or $f70Start -lt 0) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'invalid cursor' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Order = @($f70Rec.resultOrder)
                $f70Page = @()
                for ($fi = $f70Start; $fi -lt $f70Order.Count -and $f70Page.Count -lt $f70Limit; $fi++) { $f70Page += $f70Order[$fi] }
                $f70Rows = @()
                foreach ($rid in $f70Page) {
                    $row = $f70Rec.results[$rid]
                    if (-not $row) { continue }
                    $f70Rows += [ordered]@{
                        resultId = $rid
                        adapterId = [string]$row.adapterId
                        nameKey = [string]$row.nameKey
                        category = [string]$row.category
                        title = [string]$row.title
                        creator = [string]$row.creator
                        sizeBytes = $row.sizeBytes
                        contentLength = $row.sizeBytes
                        licenceTag = [string]$row.licenceTag
                        licenceEvidence = $row.licenceEvidence
                        sourceSnapshotId = [string]$row.sourceSnapshotId
                        sourceUrl = [string]$row.sourceUrl
                        previewUrl = $row.previewUrl
                        purchaseUrl = $row.purchaseUrl
                        transportHint = $row.transportHint
                        mimeType = $row.mimeType
                        date = [string]$row.date
                        availability = $row.availability
                    }
                }
                $f70HasMore = (($f70Start + $f70Page.Count) -lt $f70Order.Count)
                $f70NextCursor = $null
                if ($f70HasMore) { $f70NextCursor = [string]($f70Start + $f70Page.Count) }
                $resp = [ordered]@{
                    searchId = $f70SearchId
                    phase = (Get-F70SearchPhase -Rec $f70Rec)
                    queryGeneration = 1
                    adapterStatuses = (Get-F70AdapterRows -Rec $f70Rec)
                    results = $f70Rows
                    resultOrder = $f70Order
                    cursor = $f70NextCursor
                    hasMore = $f70HasMore
                    serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    cancellationState = [string]$f70Rec.cancellationState
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                return
            }
            # POST /api/search/cancel: searchId from the SearchCancelRequest body
            # (client contract) or the query param (F70 §1.3). Idempotent; a
            # cancelled search can never append results (the F70 fan-out is
            # synchronous, and the cancelled flag guards any future async lane).
            if ($path -eq '/api/search/cancel') {
                $f70BodyText = ''
                try { $f70BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f70BodyText = '' }
                $f70Json = $null
                if ($f70BodyText) { try { $f70Json = $f70BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f70Json = $null } }
                $f70SearchId = ''
                if ($f70Json) { try { $f70SearchId = [string]$f70Json.searchId } catch { } }
                if (-not $f70SearchId) { try { $f70SearchId = [string]$parts.query['searchid'] } catch { } }
                if (-not $f70SearchId) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'searchId required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if (-not $script:F56dSearchMap.ContainsKey($f70SearchId)) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ searchId = $f70SearchId } }
                    Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Rec = $script:F56dSearchMap[$f70SearchId]
                $f70Already = [bool]$f70Rec.cancelled
                $f70Rec.cancelled = $true
                $f70Rec.cancellationState = 'cancelled'
                $f70Cancel = @{}
                foreach ($k in @($f70Rec.adapterStatuses.Keys)) {
                    $f70St = [string]$f70Rec.adapterStatuses[$k].status
                    if ($f70St -ne 'complete' -and $f70St -ne 'empty') { $f70Rec.adapterStatuses[$k].status = 'cancelled' }
                    $f70Cancel[$k] = [string]$f70Rec.adapterStatuses[$k].status
                }
                $f70Idem = 'cancelled'
                if ($f70Already) { $f70Idem = 'already-cancelled' }
                $resp = [ordered]@{ searchId = $f70SearchId; cancellationState = 'cancelled'; adapterCancellations = $f70Cancel; idempotency = $f70Idem }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('search cancel ' + $f70SearchId + ' -> 200 ' + $f70Idem)
                return
            }
        }
        # [remediation] C2 / agent-payload / .bat endpoints removed -> 404
        # (no enrollment, no command queue, no agent hello/status, no diag up/download, no served payloads/bat)
        if ($path -in @('/install.bat','/connect-now.bat','/install.ps1','/client-install.ps1','/api/enroll.ps1','/api/launch.ps1','/launcher.ps1','/api/launcher-hello','/api/agent.ps1','/api/agent-hash','/api/accept.ps1','/api/acceptance.ps1','/api/device-enroll','/api/client-cmd','/api/agent-hello','/api/agent-status','/api/client-status','/api/diag-upload','/api/diag-file')) {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('endpoint removed per remediation'))
            return
        }
        # [F14 §2] GET /dl/<name> - one-click install-kit download. Tailnet-only
        # (CGNAT 100.64/10 source; loopback allowed for the lab self-test). NO
        # dash token: the allowlisted files carry no secrets. Allowlist is EXACT
        # ($script:DlNames): no directory listing (/dl and /dl/ 404), no
        # traversal, no other file in $Root reachable; everything else 404.
        if ($path -eq '/dl' -or $path.StartsWith('/dl/')) {
            $dlName = ''
            if ($path.Length -gt 4) { $dlName = $path.Substring(4) }
            $dlAllowed = $false
            try {
                $dlIp = $Client.Client.RemoteEndPoint.Address
                if (Test-IsLoopbackAddr $dlIp) { $dlAllowed = $true }
                else {
                    $dlOct = $dlIp.GetAddressBytes()
                    if ($dlOct.Length -eq 4 -and $dlOct[0] -eq 100 -and $dlOct[1] -ge 64 -and $dlOct[1] -le 127) { $dlAllowed = $true }
                }
            } catch { }
            if (-not $dlAllowed -or ($script:DlNames -notcontains $dlName)) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
                return
            }
            $dlBytes = $null
            try { $dlBytes = [System.IO.File]::ReadAllBytes((Join-Path $Root $dlName)) } catch { $dlBytes = $null }
            if (-not $dlBytes) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
                return
            }
            $dlType = 'application/octet-stream'
            if ($dlName -like '*.zip') { $dlType = 'application/zip' }
            # single combined write: headers + binary body in ONE buffer so the
            # socket never interleaves the ASCII head with the file bytes.
            $dlHead = "HTTP/1.1 200 OK`r`nContent-Type: $dlType`r`nContent-Length: $($dlBytes.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nContent-Disposition: attachment; filename=`"$dlName`"`r`n`r`n"
            $dlHeadB = [System.Text.Encoding]::ASCII.GetBytes($dlHead)
            $dlResp = New-Object byte[] ($dlHeadB.Length + $dlBytes.Length)
            [Array]::Copy($dlHeadB, 0, $dlResp, 0, $dlHeadB.Length)
            [Array]::Copy($dlBytes, 0, $dlResp, $dlHeadB.Length, $dlBytes.Length)
            $stream.Write($dlResp, 0, $dlResp.Length)
            $stream.Flush()
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
                -not (Test-TicketBearer $received $expected)) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('dashboard authorization required'))
                return
            }
            $source = $Client.Client.RemoteEndPoint.Address
            if (-not (Test-TicketSource $source)) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 403 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('direct tailnet source required'))
                return
            }
            if (-not $cfg -or [string]$cfg.dnsName -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
                Send-ClientResponse -Stream $stream -Code 409 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('MagicDNS FQDN missing'))
                return
            }
            $now = [datetime]::UtcNow
            $expired = @($script:RdpTokens.Keys | Where-Object { ($now - $script:RdpTokens[$_].created).TotalSeconds -ge 60 })
            foreach ($ek in $expired) { $script:RdpTokens.Remove($ek) }
            $random = New-Object byte[] 16
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($random) } finally { $rng.Dispose() }
            $newTok = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
            $script:RdpTokens[$newTok] = @{ created = $now; source = $source.ToString() }
            Write-TicketAudit 'issued' $source.ToString()
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ rid = $newTok; ttl = 60 })
            return
        }
        # [F27 redeem-route-begin] No aliases, no GET/query ticket, no proxy exemption.
        if ($path -eq '/rdp-creds' -or $path -eq '/api/rdp-info') {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([byte[]]@())
            return
        }
        if ($path -eq '/api/rdp-creds') {
            $source = $Client.Client.RemoteEndPoint.Address
            if ($parts.method -ne 'POST' -or -not (Test-TicketSource $source)) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 403 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('tailnet POST required'))
                return
            }
            $reqTok = ''
            try { $reqTok = [string](([System.Text.Encoding]::UTF8.GetString($parts.body) | ConvertFrom-Json -ErrorAction Stop).token) } catch { }
            if (-not (Use-RdpTicket $reqTok $source ([datetime]::UtcNow))) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('ticket invalid or expired'))
                return
            }
            $cfgC = Read-JsonFile -Path $script:CfgPath
            $rdpTarget = [string]$cfgC.dnsName
            if ($rdpTarget -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$' -or -not $cfgC.rdpUser -or -not $cfgC.rdpPass) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 409 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('credential config unavailable'))
                return
            }
            Write-TicketAudit 'redeemed' $source.ToString()
            $reply = ConvertTo-JsonBytes @{ fqdn = $rdpTarget; user = [string]$cfgC.rdpUser; pass = [string]$cfgC.rdpPass }
            try { Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body $reply }
            finally { [Array]::Clear($reply, 0, $reply.Length); $cfgC = $null; $reqTok = '' }
            return
        }
        # [F27 redeem-route-end]
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
                # [F17 §2] raw-ts + RoundtripKind parse (the ConvertFrom-Json
                # [datetime] conversion loses the Z and shifts by local offset).
                $hhFile = Join-Path $Root 'handler-hello-last.json'
                $handlerAge = Get-UtcAgeSeconds (Get-RawJsonTs $hhFile)
            } catch { }
            # [F19 §2] LAUNCHER VERSION GUARD. launcherVersion is the REPO
            # CONSTANT: main.yml reads `private const string Ver = "<x>"` out of
            # payloads/ghrdp-rdp-launcher.cs and writes it into config.json. The
            # beacon carries the client's exe stamp; the version inside it is
            # compared numerically. Client older => launcherOutdated=true (a
            # YELLOW row in the UI - never an AUTO-LOGIN blocker: the installed
            # exe still works, it just lacks the F19 client-DNS remediation).
            $launcherVersion = ''
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['launcherVersion']) { $launcherVersion = ([string]$cfgN.launcherVersion).Trim() }
            } catch { }
            if ($launcherVersion -notmatch '^\d+(\.\d+){1,3}$') { $launcherVersion = '' }
            $launcherSeenVersion = ''
            try {
                $hvFile = Join-Path $Root 'handler-hello-last.json'
                if (Test-Path -LiteralPath $hvFile) {
                    # Raw-text scan: the exe stamp lives inside a JSON string and
                    # never needs property binding (no [datetime] conversion risk).
                    $hvRaw = [System.IO.File]::ReadAllText($hvFile)
                    $hvExe = [regex]::Match($hvRaw, '"exe"\s*:\s*"([^"]{0,200})"').Groups[1].Value
                    $hvVer = [regex]::Match($hvExe, '(\d+(\.\d+){1,3})').Groups[1].Value
                    if ($hvVer -match '^\d+(\.\d+){1,3}$') { $launcherSeenVersion = $hvVer }
                }
            } catch { }
            # Numeric compare; unknown on either side => NOT outdated (never a
            # false alarm from a missing beacon or a pre-F19 config).
            $launcherOutdated = $false
            if ($launcherVersion -and $launcherSeenVersion) {
                try { $launcherOutdated = ([version]$launcherSeenVersion -lt [version]$launcherVersion) } catch { $launcherOutdated = $false }
            }
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
            $runnerResolvedIP = ''
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['runnerResolvedIP']) { $runnerResolvedIP = [string]$cfgN.runnerResolvedIP }
            } catch { }
            $runnerDnsOk = ($runnerResolvedIP -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.')
            if (-not $fqdnOk)   { $reasons += 'fqdn-not-tsnet' }
            if (-not $runnerDnsOk) { $reasons += 'runner-dns-broken' }
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
            # [F10-2 §2.1] RDP LOGON AGE: newest LogonType 10 (RemoteInteractive)
            # Win32_LogonSession StartTime -> age in seconds ($null = no RDP
            # session; the UI keeps --:--:-- until the first non-null value).
            $rdpLogonAgeSec = $null
            try {
                $ls = Get-CimInstance -ClassName Win32_LogonSession -Filter 'LogonType=10' -ErrorAction Stop
                if ($ls) {
                    $newest = ($ls | Sort-Object StartTime -Descending | Select-Object -First 1).StartTime
                    if ($newest) {
                        $rdpLogonAgeSec = [int]((Get-Date) - $newest).TotalSeconds
                        if ($rdpLogonAgeSec -lt 0) { $rdpLogonAgeSec = 0 }
                    }
                }
            } catch { $rdpLogonAgeSec = $null }
            # [F10-2 §2.2] real path latency to the dashboard client, measured by
            # the rdp-ping loop (tailscale ping every 15s against the dash-token
            # source peer); surfaced only when the sample is fresh (<45s).
            # [F11-3 §3] RDP USAGE accumulator sample (rdp-usage.ps1 loop, 5s
            # tick, only while an RDP session is CONNECTED or a webdesk client is
            # attached). rdpUsageActive drives the UI's live tick; rdpUsageAgeSec
            # says how old the sample is (stale => frozen, never re-opened).
            $rdpUsageSec = $null; $rdpUsageActive = $false; $rdpUsageAgeSec = $null
            try {
                $uf = Join-Path $Root 'rdp-usage.json'
                if (Test-Path -LiteralPath $uf) {
                    $uj = [System.IO.File]::ReadAllText($uf) | ConvertFrom-Json
                    if ($uj -and $null -ne $uj.sec) {
                        $rdpUsageSec = [int]$uj.sec
                        $rdpUsageActive = [bool]$uj.active
                        # [F17 §2] raw-ts + RoundtripKind age (never local-shifted).
                        $rdpUsageAgeSec = Get-UtcAgeSeconds (Get-RawJsonTs $uf)
                        if ($null -eq $rdpUsageAgeSec) { $rdpUsageAgeSec = Get-UtcAgeSeconds $uj.ts }
                        if ($rdpUsageAgeSec -gt 45) { $rdpUsageActive = $false }
                    }
                }
            } catch { }
            $rdpPingMs = $null; $rdpPingPath = ''; $rdpPingTarget = ''
            try {
                $rpFile = Join-Path $Root 'rdp-ping.json'
                if (Test-Path -LiteralPath $rpFile) {
                    $pj = [System.IO.File]::ReadAllText($rpFile) | ConvertFrom-Json
                    # [F17 §2] raw-ts + RoundtripKind freshness check.
                    $pingAge = Get-UtcAgeSeconds (Get-RawJsonTs $rpFile)
                    if ($null -eq $pingAge) { $pingAge = Get-UtcAgeSeconds $pj.ts }
                    if ($pj -and $pj.ts -and ($null -ne $pingAge) -and ($pingAge -lt 45)) {
                        if ($null -ne $pj.ms) { $rdpPingMs = [int]$pj.ms }
                        if ($pj.path -and ([string]$pj.path -in @('direct','relay','unknown'))) { $rdpPingPath = [string]$pj.path }
                        if ($pj.target -and ([string]$pj.target -match '^100\.')) { $rdpPingTarget = [string]$pj.target }
                    }
                }
            } catch { }
            # [F28 §4] LIVE CredSSP probe: the SAME determinants the listener
            # checkbox asserts (NLA on, bound trusted cert, strict CredSSP
            # policy, TLS security layer, high min encryption) are re-probed
            # HERE, at request time, so the row can never read a stale config
            # stamp while the listener renders a live ✅. Never weakens
            # anything; it only reads.
            $csLive = 'unknown'; $csLiveWhy = ''
            try {
                $oracle = $null
                try { $oracle = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\CredSSP\Parameters' -Name 'AllowEncryptionOracle' -ErrorAction SilentlyContinue).AllowEncryptionOracle } catch { $oracle = $null }
                $secLayer = $null; $minEnc = $null
                try { $secLayer = (Get-ItemProperty -Path $rdpKey -Name 'SecurityLayer' -ErrorAction SilentlyContinue).SecurityLayer } catch { $secLayer = $null }
                try { $minEnc = (Get-ItemProperty -Path $rdpKey -Name 'MinEncryptionLevel' -ErrorAction SilentlyContinue).MinEncryptionLevel } catch { $minEnc = $null }
                if (-not $nlaOn) { $csLive = 'warn'; $csLiveWhy = 'nla-off (UserAuthentication != 1)' }
                elseif (-not $certBound) { $csLive = 'warn'; $csLiveWhy = 'cert-not-bound' }
                elseif ($null -ne $oracle -and [int]$oracle -ne 0) { $csLive = 'warn'; $csLiveWhy = ('credssp-allow-encryption-oracle=' + [int]$oracle) }
                elseif ($null -ne $secLayer -and [int]$secLayer -ne 2) { $csLive = 'warn'; $csLiveWhy = ('rdp-security-layer=' + [int]$secLayer) }
                elseif ($null -ne $minEnc -and [int]$minEnc -lt 3) { $csLive = 'warn'; $csLiveWhy = ('rdp-min-encryption-level=' + [int]$minEnc) }
                else { $csLive = 'ok' }
            } catch { $csLive = 'unknown'; $csLiveWhy = 'credssp-probe-failed' }
            # [F28 §1] logon verdict + collector liveness (own state file, never
            # written into config.json - no writer race with the workflow).
            $logonState = [pscustomobject]@{ authLast = $null; logonCollector = $null }
            try { $logonState = Get-RdpLogonCollectorState -StatePath $script:LogonStatePath -ServerStartedUtc $script:ServerStartedUtc } catch { }
            # [F30 §3] connLog: the RDP Operational-log collector (own 30s tick,
            # own state file) - the ONLY evidence for a handshake drop that never
            # reaches LSA and therefore never writes 4624/4625.
            $connState = [pscustomobject]@{ connLog = $null; connLogCollector = $null }
            try { $connState = Get-RdpConnLogState -StatePath $script:ConnLogStatePath -ServerStartedUtc $script:ServerStartedUtc } catch { }
            # [F31c §2] fold last-5-minute Schannel 36870/36871 into the served
            # connLog. listenerHandshakeOk stays a pass-through of the F31
            # self-probe stamp (absent => the card says F31 not bound).
            try { $connState.connLog = Merge-F31cConnLog -ConnLog $connState.connLog -Sch (Get-F31cSchannelWindow) } catch { }
            # [F37 §4] telescope: the runner's own 60s observation of the
            # listener it serves + the client beacons the launcher posted. The
            # SERVER CONN LOG row reads boundThumb/servedThumb/aclSids/schannel
            # from here, so bind drift can never hide behind a cached stamp.
            $f37State = [pscustomobject]@{ telescope = $null; telescopeCollector = $null }
            try { $f37State = Get-RdpListenerTelescopeState -StatePath $script:F37TelStatePath -ServerStartedUtc $script:ServerStartedUtc } catch { }
            $f37Client = $null
            try { $f37Client = Get-F37ClientTelescope -Path $script:F37TelClientPath } catch { }
            $tlsNormState = $null
            try { $tlsNormState = Get-F30TlsNormState -StatePath (Join-Path $Root 'tls-norm.json') } catch { }
            $rlOut = $null
            if ($cfgN -and $cfgN.PSObject.Properties['rdpListener'] -and $cfgN.rdpListener) { $rlOut = $cfgN.rdpListener }
            if ($null -eq $rlOut) { $rlOut = New-Object psobject }
            try {
                $rlOut | Add-Member -NotePropertyName authLast -NotePropertyValue $logonState.authLast -Force
                $rlOut | Add-Member -NotePropertyName logonCollector -NotePropertyValue $logonState.logonCollector -Force
                $rlOut | Add-Member -NotePropertyName credsspLive -NotePropertyValue $csLive -Force
                $rlOut | Add-Member -NotePropertyName credsspLiveWhy -NotePropertyValue $csLiveWhy -Force
                $rlOut | Add-Member -NotePropertyName credsspLiveTs -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
                # [F30 §3] rdpListener.connLog = newest RDP Operational-log
                # events (id/provider/time/level/reason/desc) + the collector's
                # own liveness. Never a credential; descriptions are clipped and
                # redacted at collection time.
                $rlOut | Add-Member -NotePropertyName connLog -NotePropertyValue $connState.connLog -Force
                $rlOut | Add-Member -NotePropertyName connLogCollector -NotePropertyValue $connState.connLogCollector -Force
                # [F30 §1] tlsNorm: the server's own cipher/TLS state (written by
                # the F30 normalization step) - the row shows it next to the
                # client-side cipher list.
                $rlOut | Add-Member -NotePropertyName tlsNorm -NotePropertyValue $tlsNormState -Force
                # [F37 §4] rdpListener.telescopeLive: the RUNNER's own 60s
                # observation, always served next to the config stamp
                # (rdpListener.telescope, written by the workflow's F17 probe /
                # keep-alive tick). The row prefers LIVE: a bind drift that
                # happened after the last dispatch must be visible NOW.
                if ($f37State.telescope) {
                    $rlOut | Add-Member -NotePropertyName telescopeLive -NotePropertyValue $f37State.telescope -Force
                }
            } catch { }
            $ns = [ordered]@{
                fqdn = $fqdnN
                hostKind = $hostKind
                buildSha = $(if ($cfgN -and $cfgN.PSObject.Properties['buildSha']) { [string]$cfgN.buildSha } else { '' })
                # [F17 §2] rdpListener: the runner-side self-probe (main.yml step
                # 'RDP listener self-probe (F17)') stores listening/termService/
                # fwRule/fwScope/certThumb/nla into config.json; served verbatim
                # + age. $null => probe never ran (the UI says so and keeps
                # WINDOWS AUTO-LOGIN disabled - a missing probe is never a ✅).
                # [F28 §1/§4] rdpListener (config stamp) + authLast (the live
                # 30s logon scan) + logonCollector (its liveness) + credsspLive
                # (request-time probe). The config object itself is never
                # written back from this route.
                rdpListener = $rlOut
                rdpListenerAgeSec = $(if ($cfgN -and $cfgN.PSObject.Properties['rdpListener'] -and $cfgN.rdpListener) { Get-UtcAgeSeconds $cfgN.rdpListener.ts } else { $null })
                logonCollector = $logonState.logonCollector
                # [F30 §3] SERVER CONN LOG row source (same object as
                # rdpListener.connLog; top-level so the page can render it even
                # when the config stamp is absent).
                connLog = $connState.connLog
                connLogCollector = $connState.connLogCollector
                # [F37 §4] telescope (runner 60s observation of the listener it
                # serves: boundThumb vs servedThumb, serving, aclSids, schannel
                # tail) + telescopeClient (the launcher's per-stage beacons,
                # newest first). Top-level so the timeline renders even when the
                # config stamp is absent. Never a credential.
                telescope = $f37State.telescope
                telescopeCollector = $f37State.telescopeCollector
                telescopeClient = $f37Client
                # [F18 §4] runnerResolvedIP: the F18 runner FQDN self-test result
                # (100.64.0.0/10 only). Empty/invalid => AUTO-LOGIN stays disabled.
                runnerResolvedIP = $(if ($cfgN -and $cfgN.PSObject.Properties['runnerResolvedIP'] -and ([string]$cfgN.runnerResolvedIP -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.')) { [string]$cfgN.runnerResolvedIP } else { '' })
                # [F19 §2] launcher version guard: config constant + the version
                # found in the last beacon's exe stamp + the outdated verdict.
                launcherVersion = $launcherVersion
                launcherSeenVersion = $launcherSeenVersion
                launcherOutdated = $launcherOutdated
                certBound = $certBound
                nlaOn = $nlaOn
                handlerSeenAgeSec = $handlerAge
                webdeskUrl = $wd
                webdeskReason = $wdr
                webdeskDetail = $wdDetail
                webdeskAuth = $wda
                vncPassAdminUrl = $vncAdmin
                tsReason = $tsr
                tsAuthAdminUrl = $tsAdmin
                vpsPending = $vpsPending
                rdpLogonAgeSec = $rdpLogonAgeSec
                rdpUsageSec = $rdpUsageSec
                rdpUsageActive = $rdpUsageActive
                rdpUsageAgeSec = $rdpUsageAgeSec
                pingMs = $rdpPingMs
                pingPath = $rdpPingPath
                pingTarget = $rdpPingTarget
                # [F9c] actionable MagicDNS admin link: the dashboard linkifies
                # it whenever the fqdn reason renders (fqdn missing) and hides
                # it once the FQDN resolves. Carries no credentials.
                magicDnsAdminUrl = 'https://login.tailscale.com/admin/dns'
                probeReasons = $probeReasons
                reasonsDisabled = @($reasons)
                advisory = @($advisory)
            }
            $ns.ticketAudit = $script:TicketAudit
            $ns.handlerChain = @($script:HandlerChain)
            # [F31c §2] launcher.beacons: allowlisted handler-chain slugs only
            # (credwrite-ok, mstsc-started, ...) so the LIVE DISPATCH STATUS card
            # can see whether the last attempt stored a credential. Never a
            # password, a ticket, or a URL.
            $f31cBeacons = @()
            foreach ($hb in @($script:HandlerChain)) {
                if (-not $hb) { continue }
                $f31cBeacons += [ordered]@{
                    ts = [string]$hb.ts
                    verb = [string]$hb.verb
                    details = [string]$hb.details
                    ok = $(if ($null -ne $hb.ok) { [bool]$hb.ok } else { $false })
                }
            }
            $ns.launcher = [ordered]@{ beacons = @($f31cBeacons) }
            # [U4] lastHandlerVerb: verb + result of the most recent /api/handler-hello,
            # so the dashboard can show "last: install ok" / "last: setup skipped" without
            # keeping any per-client state on the server. Optional (may be null).
            try {
                $lvFile = Join-Path $Root 'handler-hello-last.json'
                if (Test-Path -LiteralPath $lvFile) {
                    $lv = [System.IO.File]::ReadAllText($lvFile) | ConvertFrom-Json
                    if ($lv -and $lv.verb) {
                        # [F17 §2] ts is re-serialized as explicit UTC ISO 'o'
                        # (with Z). The old `[string]$lv.ts` emitted the
                        # server-LOCAL Z-less form, which the visitor's browser
                        # parsed as local (+05:30 => beacon age +19800s).
                        # [F19 §2] exe: the client's launcher version stamp from
                        # the beacon (string only, never a path/credential).
                        $ns.lastHandlerVerb = @{ verb = [string]$lv.verb; ok = [bool]$lv.ok; details = [string]$lv.details; exe = $(if ($lv.PSObject.Properties['exe']) { ([string]$lv.exe).Substring(0, [Math]::Min(120, ([string]$lv.exe).Length)) } else { '' }); ts = (ConvertTo-UtcIso (Get-RawJsonTs $lvFile)) }
                    }
                }
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $ns)
            return
        }
        # [F30 §2.2] GET /api/purge-stale-creds - dash-token gated (bearer header,
        # the SAME gate as /api/rdp-token): tailnet reachability alone must never
        # hand out a credential-deleting command. Returns the ONE-LINE local
        # command that deletes every TERMSRV entry older than 7 days, plus the
        # exact this-host target so the operator can see what it applies to.
        # Nothing here runs anything on the server, reads a credential value, or
        # automates any credential UI.
        if ($path -eq '/api/purge-stale-creds') {
            $authP = [string]$parts.headers['authorization']
            $expectP = [System.Text.Encoding]::UTF8.GetBytes('Bearer ' + $Token)
            $recvP = [System.Text.Encoding]::UTF8.GetBytes($authP)
            if (-not $Token -or $recvP.Length -ne $expectP.Length -or
                -not (Test-TicketBearer $recvP $expectP)) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('dashboard authorization required'))
                return
            }
            $cfgP30 = Read-JsonFile -Path $script:CfgPath
            $fqdnP30 = ''
            if ($cfgP30 -and $cfgP30.PSObject.Properties['dnsName'] -and $cfgP30.dnsName -and
                ([string]$cfgP30.dnsName -match '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$')) { $fqdnP30 = [string]$cfgP30.dnsName }
            $respP30 = @{
                olderThanDays = 7
                target        = $(if ($fqdnP30) { 'TERMSRV/' + $fqdnP30 } else { '' })
                command       = [string]$script:F30PurgeCommand
                ts            = (Get-Date).ToUniversalTime().ToString('o')
                note          = 'run ONCE on YOUR PC (current user); deletes only TERMSRV entries whose LastWritten is older than 7 days; prints a count, never a credential'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $respP30)
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
                        if ([string]$bj.verb -in @('rdp','check','setup','install','connect')) { $hh.verb = [string]$bj.verb } else { $hh.verb = 'other' }
                        if ($null -ne $bj.ok) { $hh.ok = [bool]$bj.ok }
                        # F27: reject arbitrary telemetry strings rather than redact guesses.
                        $detail = [string]$bj.details
                        # [F28 §2/§3] recred-redeemed = the recovery redemption;
                        # fallback-mstsc-native-prompt = the closed fallback gap
                        # (the beacon immediately preceding a /prompt launch).
                        # [F30 §2.1/§2.3] purged <n> stale entries, wrote new as
                        # Domain = the purge-before-write proof; rdp-truncated =
                        # the .rdp byte-floor failure (never a silent launch).
                        if ($detail -match '^(invoked|ticket-redeemed|recred-redeemed|credwrite-ok|credwrite-failed|rdp-written|rdp-truncated|purged [0-9]+ stale entries, wrote new as Domain|mstsc-started( pid=[0-9]+)?|mstsc-exited=-?[0-9]+|check-shown|cmdkey-shown|cmdkey-timeout|cmdkey-stored=(true|false)|client-dns-off|cred-param-rejected|invalid-target|fallback-mstsc-native-prompt|fallback-cmdkey reason=(ticket-missing|unreachable|ticket-invalid-or-expired))$') { $hh.details = $detail }
                        elseif ($detail -like 'dns-guard:*') { $hh.details = 'dns-guard-failed' }
                        else { $hh.details = 'launcher-error' }
                        # [F19 §2] exe: the launcher's version stamp, used by the
                        # version guard below. Length-capped, string only - the
                        # beacon never carries a credential and this store never
                        # carries a path or a user.
                        if ([string]$bj.exe -match '^ghrdp-rdp-launcher ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)') { $hh.exe = 'ghrdp-rdp-launcher ' + $Matches[1] }
                    }
                }
            } catch { }
            $script:HandlerChain = @(@($script:HandlerChain) + @($hh) | Select-Object -Last 40)
            try { [System.IO.File]::AppendAllText((Join-Path $Root 'handler-hello-chain.jsonl'), (($hh | ConvertTo-Json -Compress) + "`n"), $script:NoBom) } catch { }
            try { [System.IO.File]::WriteAllText((Join-Path $Root 'handler-hello-last.json'), ($hh | ConvertTo-Json -Compress), $script:NoBom) } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
            return
        }
        # [F37 §3] POST /api/rdp-telescope - the CLIENT telescope beacon (the
        # launcher's dns/tcp/tls/cred stages, one trace id per click). Strict
        # allowlist: stage in dns|tcp|tls|cred, details matching the SHARED slug
        # set of payloads/rdp-telescope.ps1, trace an opaque id. A beacon cannot
        # smuggle a secret: an unknown slug becomes 'telescope-unparsed' and only
        # these five fields are ever stored.
        if ($path -eq '/api/rdp-telescope' -and $parts.method -eq 'POST') {
            $cb = [ordered]@{ ts = [datetime]::UtcNow.ToString('o'); trace = ''; stage = 'other'; ok = $false; details = 'telescope-unparsed' }
            try {
                $bodyRawT = $parts.body
                if ($bodyRawT -and $bodyRawT.Length -gt 0) {
                    $bTxtT = [System.Text.Encoding]::UTF8.GetString([byte[]]$bodyRawT)
                    $bjT = $bTxtT | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($bjT) {
                        $trT = [string]$bjT.trace
                        if ($trT -match '^[A-Za-z0-9\-]{4,64}$') { $cb.trace = $trT }
                        $stT = [string]$bjT.stage
                        if ($null -ne $bjT.ok) { $cb.ok = [bool]$bjT.ok }
                        $detT = [string]$bjT.details
                        if ($detT -match $script:F37TelSlugRe) { $cb.details = $detT }
                        # [F37 §3 beacon-stage] the stage is DERIVED from the shared
                        # slug through the module's token table, never taken on the
                        # client's word: a beacon whose slug belongs to no stage, or
                        # whose declared stage disagrees with its slug, is neutralized
                        # (stage=other + telescope-unparsed) instead of being stored as
                        # a verdict. The server encodes no stage of its own.
                        $derivedT = Get-F37BeaconStageForSlug -Slug ([string]$cb.details)
                        if (-not $derivedT -or ($stT -and $stT -ne $derivedT)) {
                            $cb.stage = 'other'
                            $cb.details = 'telescope-unparsed'
                        } else {
                            $cb.stage = $derivedT
                        }
                    }
                }
            } catch { }
            Add-F37ClientBeacon -Path $script:F37TelClientPath -Beacon $cb | Out-Null
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
            return
        }
        # [remediation 8C] /api/launch.ps1, /launcher.ps1, /api/enroll.ps1 bodies deleted; unreachable due to guard above.
        # [remediation 8C-extended] /api/launcher-hello body deleted; unreachable due to 404 guard above. It acknowledged agent-launcher heartbeats — obsolete under the native mstsc flow (no agent, no launcher).
        if ($path -eq '/api/launcher-status') {
            $body = '{"ver":0,"ts":"","ageSeconds":-1}'
            try {
                # [F17 §2] raw-ts + RoundtripKind age; the echoed ts is explicit
                # UTC ISO (with Z), never the local Z-less form.
                $lhFile = Join-Path $Root 'launcher-hello-last.json'
                if (Test-Path -LiteralPath $lhFile) {
                    $lh = [System.IO.File]::ReadAllText($lhFile) | ConvertFrom-Json
                    $age = Get-UtcAgeSeconds (Get-RawJsonTs $lhFile)
                    if ($null -eq $age) { $age = -1 }
                    $body = '{"ver":' + [int]$lh.ver + ',"build":"' + [string]$lh.build + '","ts":"' + (ConvertTo-UtcIso (Get-RawJsonTs $lhFile)) + '","ageSeconds":' + $age + '}'
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
        if ($path -eq '/progress' -or $path -eq '/api/progress' -or $path -eq '/mirror') {
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
                encryptMode = $(if ($prog.encryptMode) { [string]$prog.encryptMode } else { $em })
                mirrorPlaintextElection = ([bool]$cfg.mirrorPlaintextElection -and -not (Get-F49RuntimeOptIn -Cfg $cfg))
                mirrorDiag = $prog.mirrorDiag
                mirrorProbe = $prog.mirrorProbe
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
            # [F43 / F42 §2] ui selection: DEFAULT v2; ?ui=v1 pins classic v1;
            # ?ui=v2 forces v2. A missing v2 file is fail-VISIBLE: v1 + the red
            # uiV2MissingBanner, never a silent v1. No other query value changes
            # the default.
            $html = '<h1>Mission Control UI file missing</h1>'
            $uiSel = ''
            try { if ($parts.query -and $parts.query.ContainsKey('ui')) { $uiSel = [string]$parts.query['ui'] } } catch { }
            $wantV2 = $script:UiV2Default -or ($uiSel -eq 'v2')
            if ($uiSel -eq 'v1') { $wantV2 = $false }
            $uiFile = $script:UiPath
            # [F42 §2] fail-VISIBLE v2: a ui=v2 request with ui-v2.html NOT
            # staged must never fall back to v1 silently. Serve v1 plus an
            # injected top red banner (HTTP 200) and log the same text. The
            # banner carries no key/token material.
            $v2Missing = $false
            if ($wantV2) {
                if (Test-Path -LiteralPath $script:UiV2Path) { $uiFile = $script:UiV2Path }
                else { $v2Missing = $true }
            }
            try { $html = [System.IO.File]::ReadAllText($uiFile, [System.Text.Encoding]::UTF8) } catch { }
            $ip = ''; $tg = ''
            if ($cfg) {
                $ip = [string]$cfg.rdpIp
                $tg = [string]$cfg.mirrorIndexUrl
            }
            $html = $html.Replace('__IP__', $ip).Replace('__TELEGRAPH__', $tg)
            if ($v2Missing) {
                $v2BannerText = 'ui-v2.html not staged in this run - main.yml stage step failed; re-dispatch or check CI'
                $v2Banner = '<div id="uiV2MissingBanner" role="alert" style="position:sticky;top:0;z-index:99999;display:block;width:100%;box-sizing:border-box;background:#7f1d1d;color:#fff;font:600 13px/1.5 system-ui,sans-serif;text-align:center;padding:8px 12px">' + $v2BannerText + '</div>'
                $html = $html -replace '(?i)(<body[^>]*>)', ('$1' + $v2Banner)
                Write-Host ('[F42] V2-MISSING: ' + $v2BannerText + ' (v1 served with red banner; no key/token logged)')
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        # [F38] the same Root that serves ui.html also serves the staged Sinhala
        # subset. Allowlist is exactly the two latin-free woff2 files. The page
        # embeds the same bytes (tailnet-offline); this route is the static fetch.
        if ($path -eq '/fonts/noto-sans-sinhala-400-latin-free.woff2' -or $path -eq '/fonts/noto-sans-sinhala-600-latin-free.woff2') {
            $fontName = [System.IO.Path]::GetFileName($path)
            $fp = Join-Path (Join-Path $Root 'fonts') $fontName
            if (-not (Test-Path -LiteralPath $fp)) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('font not staged'))
                return
            }
            try { $fontBytes = [System.IO.File]::ReadAllBytes($fp) } catch { $fontBytes = $null }
            if (-not $fontBytes) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('font unreadable'))
                return
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'font/woff2' -Body $fontBytes
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
            # [F10-2 §3] capture password fields BEFORE Remove-CredKeys strips
            # them; they are re-attached ONLY when $credsAllowed (dash-token or
            # tailnet source). Masked siblings (last 4) feed the UI display;
            # the raw values feed only the UI copy buttons. Never logged.
            $cfgRaw = Read-JsonFile -Path $script:CfgPath
            $rawU = ''; $rawP = ''; $rawV = ''
            try { if ($cfgRaw -and $cfgRaw.PSObject.Properties['rdpUser']) { $rawU = [string]$cfgRaw.rdpUser } } catch { }
            try { if ($cfgRaw -and $cfgRaw.PSObject.Properties['rdpPass']) { $rawP = [string]$cfgRaw.rdpPass } } catch { }
            try { if ($cfgRaw -and $cfgRaw.PSObject.Properties['vncPass']) { $rawV = [string]$cfgRaw.vncPass } } catch { }
            $cfgOut = Remove-CredKeys $cfgRaw
            if ($cfgOut -and $credsAllowed) {
                # [F10-16] last-4 mask. The previous one-liner compared
                # '[string]$v.Length -le 4', which PowerShell evaluates as a
                # STRING comparison ('17' -le '4' is true), so every password
                # rendered as '****' (lab annotation stage=gated-mask mask=[****]).
                # Bounded by length explicitly now.
                function Get-CredsMask([string]$s) {
                    if ([string]::IsNullOrEmpty($s)) { return '' }
                    if ($s.Length -le 4) { return '****' }
                    return (('*' * ($s.Length - 4)) + $s.Substring($s.Length - 4))
                }
                try {
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'windowsPass' -Value ([string]$rawP) -Force
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'windowsPassMask' -Value ([string](Get-CredsMask $rawP)) -Force
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'vncPass' -Value ([string]$rawV) -Force
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'vncPassMask' -Value ([string](Get-CredsMask $rawV)) -Force
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
        try { Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); handlerError = $_.Exception.GetType().Name }) } catch { }
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
# [F10-2 §2.2] rdp-ping loop: every 15s, `tailscale ping -c 1 -timeout 3s`
# against the dash-token SOURCE PEER (dash-client-ip.txt, captured per request);
# falls back to the first online tailnet peer until a dashboard visit records
# the client. Parses RTT + direct/DERP path into rdp-ping.json (consumed by
# /api/native-status -> CONNECTIVITY row).
$rdpPingScript = @'
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$out = 'C:\ghrdp\rdp-ping.json'
while ($true) {
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); ms = $null; path = 'unknown'; target = '' }
  try {
    $target = ''
    if (Test-Path 'C:\ghrdp\dash-client-ip.txt') { $target = ([System.IO.File]::ReadAllText('C:\ghrdp\dash-client-ip.txt')).Trim() }
    if ($target -notmatch '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') { $target = '' }
    if (-not $target) {
      $j = (& $ts status --json 2>$null) | ConvertFrom-Json
      if ($j -and $j.Peer) { foreach ($p in $j.Peer.PSObject.Properties) { if ($p.Value.Online) { $target = @($p.Value.TailscaleIPs)[0]; break } } }
    }
    if ($target) {
      $obj.target = $target
      $o = (& $ts ping -c 1 -timeout 3s $target 2>$null) -join ' '
      if ($o -match 'in ([0-9]+)ms') { $obj.ms = [int]$Matches[1] }
      if ($o -match 'via DERP') { $obj.path = 'relay' }
      elseif ($o -match 'via [0-9][0-9.:]+') { $obj.path = 'direct' }
    }
  } catch { }
  try { [System.IO.File]::WriteAllText($out, ($obj | ConvertTo-Json -Compress)) } catch { }
  Start-Sleep -Seconds 15
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'rdp-ping.ps1'), $rdpPingScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'rdp-ping.ps1') -WindowStyle Hidden } catch { }
# [F11-3 §3] RDP USAGE accumulator (replaces logon age as the headline timer).
# rdpUsageSec grows ONLY while (a) an RDP logon-type-10 session is CONNECTED
# (qwinsta 'Active' rdp-tcp line) OR (b) at least one webdesk client is attached
# (Rust dash ws-clients.txt, an Established non-loopback TCP connection on 7333,
# or a websockify log 'connect' newer than its last 'disconnect'). It freezes
# within one 5s tick after both signals drop and resumes on reconnect. The
# accumulator is persisted into config.json (rdpUsageSec/rdpUsageAt/rdpUsageHost)
# so a re-dispatch on the SAME host continues instead of restarting at zero.
$usageScript = @'
$ErrorActionPreference = 'Continue'
$root = 'C:\ghrdp'
$state = Join-Path $root 'rdp-usage.json'
$cfg = Join-Path $root 'config.json'
$enc = New-Object System.Text.UTF8Encoding($false)
# [F11-3 §3 loop-owner] ONE loop per Root. This child is detached, so stopping
# the server orphans it; a second loop would interleave its OWN counter into the
# same state file - which is exactly how the accumulator was observed going
# BACKWARDS (15 -> 10). If a live rdp-usage.ps1 for this Root already owns the
# file, step aside without writing a single sample.
try {
  if (Test-Path -LiteralPath $state) {
    $own = [System.IO.File]::ReadAllText($state) | ConvertFrom-Json
    if ($own -and $null -ne $own.pid -and [int]$own.pid -ne $PID) {
      $op = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$own.pid) -ErrorAction SilentlyContinue
      if ($op -and ([string]$op.CommandLine) -match 'rdp-usage\.ps1') { exit 0 }
    }
  }
} catch { }
$sec = 0
try {
  if (Test-Path -LiteralPath $state) {
    $sj = [System.IO.File]::ReadAllText($state) | ConvertFrom-Json
    if ($null -ne $sj.sec) { $sec = [int]$sj.sec }
  } elseif (Test-Path -LiteralPath $cfg) {
    $cj = [System.IO.File]::ReadAllText($cfg) | ConvertFrom-Json
    if ($null -ne $cj.rdpUsageSec) { $sec = [int]$cj.rdpUsageSec }
  }
} catch { $sec = 0 }
$lastPersist = [datetime]::MinValue
function Test-RdpConnected {
  try {
    $q = ((& qwinsta.exe 2>$null) -join "`n")
    if ($q -match '(?im)rdp-tcp#\d+\s+\S.*?\sActive') { return $true }
    if ($q -match '(?im)rdp-tcp') { return $false }
  } catch { }
  try { return [bool](Get-CimInstance -ClassName Win32_LogonSession -Filter 'LogonType=10' -ErrorAction Stop) } catch { return $false }
}
function Test-WebdeskClient {
  try {
    $f = Join-Path $root 'webdesk\ws-clients.txt'
    if (Test-Path -LiteralPath $f) {
      $n = 0
      if ([int]::TryParse(([System.IO.File]::ReadAllText($f)).Trim(), [ref]$n) -and $n -gt 0) { return $true }
    }
  } catch { }
  try {
    foreach ($c in @(Get-NetTCPConnection -LocalPort 7333 -State Established -ErrorAction Stop)) { return $true }
  } catch { }
  try {
    $lg = Join-Path $root 'webdesk\websockify.log'
    if (Test-Path -LiteralPath $lg) {
      $t = [System.IO.File]::ReadAllText($lg)
      $ci = $t.LastIndexOf('connect'); $di = $t.LastIndexOf('disconnect')
      if ($ci -ge 0 -and $ci -gt $di) { return $true }
    }
  } catch { }
  return $false
}
while ($true) {
  $rdp = Test-RdpConnected
  $web = Test-WebdeskClient
  $active = ($rdp -or $web)
  if ($active) { $sec = $sec + 5 }
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); sec = $sec; active = $active; rdp = $rdp; webdesk = $web; pid = $PID }
  try { [System.IO.File]::WriteAllText($state, ($obj | ConvertTo-Json -Compress), $enc) } catch { }
  # Persist on every STOP (durable freeze) and at most every 30s while running.
  if ((-not $active) -or (([datetime]::UtcNow - $lastPersist).TotalSeconds -ge 30)) {
    try {
      if (Test-Path -LiteralPath $cfg) {
        $c = [System.IO.File]::ReadAllText($cfg) | ConvertFrom-Json
        foreach ($kv in @(@('rdpUsageSec', $sec), @('rdpUsageAt', (Get-Date).ToUniversalTime().ToString('o')), @('rdpUsageHost', [string]$c.dnsName))) {
          $c | Add-Member -MemberType NoteProperty -Name $kv[0] -Value $kv[1] -Force
        }
        [System.IO.File]::WriteAllText($cfg, ($c | ConvertTo-Json -Depth 10), $enc)
        $lastPersist = [datetime]::UtcNow
      }
    } catch { }
  }
  Start-Sleep -Seconds 5
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'rdp-usage.ps1'), $usageScript, $script:NoBom)
# [F11-3 §3 loop-reap] A server stop/update kills THIS process and never the
# detached loop it started, so reap any live loop for THIS Root before launching
# the singleton: exactly one writer may own rdp-usage.json / config.json.
try {
    $us = Join-Path $Root 'rdp-usage.ps1'
    foreach ($lp in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        if ($lp.CommandLine -and ([string]$lp.CommandLine).IndexOf($us, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { try { Stop-Process -Id $lp.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
    }
} catch { }
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'rdp-usage.ps1') -WindowStyle Hidden } catch { }
# [F28 §1] STARTUP SCAN: the first stamp lands before the first client can
# poll, so /api/native-status never has to guess "not reported yet" when the
# collector is actually alive. Failure is contained (the function stamps
# probeError + scanTs instead of throwing).
try { Update-RdpLogonAuthLast -StatePath $script:LogonStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
$lastLogonScan = Get-Date
# [F30 §3] STARTUP SCAN: the first conn-log stamp lands before the first
# client can poll, so the SERVER CONN LOG row never reads "not reported yet"
# while the collector is actually alive. Failure is contained (probeError +
# scanTs are stamped by the function instead of throwing).
try { Update-RdpConnLog -StatePath $script:ConnLogStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
$lastConnLogScan = Get-Date
# [F37 §4] STARTUP SCAN: the telescope stamps BEFORE the first client can poll
# (same shape as the F28/F30 startup scans), so "not reported yet" can only mean
# a genuinely absent sample - and the 60s tick below keeps it live.
try { Update-RdpListenerTelescope -StatePath $script:F37TelStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
$lastTelScan = Get-Date
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Bind), $Port)
try { $listener.Start() } catch {
    try { [System.IO.File]::WriteAllText($script:OkFile, 'LISTEN_FAIL: ' + $_.Exception.Message, $script:NoBom) } catch { }
    exit 1
}
[System.IO.File]::WriteAllText($script:OkFile, ('LISTENING pid={0} bind={1} port={2} at={3}' -f $PID, $Bind, $Port, (Get-Date -Format o)), $script:NoBom)
# [F45 S4 fx-worker-begin] Queue worker: one process per Root owns
# %TEMP%\ghrdp\fx-upload-queue.json (same singleton discipline as the wire-probe
# / rdp-ping / rdp-usage loops). It is a no-op off Windows and it never runs
# when the module failed to load, so a lab harness stays deterministic.
try {
    if ($script:FxReady) {
        $fxWorker = Start-FxUploadWorker -Root $Root -QueuePath (Get-FxQueuePath -Root $Root -Options @{}) -ModulePath $script:FxModule
        Write-Host ('[F45] fx upload worker: started=' + [string]$fxWorker.started + ' reason=' + [string]$fxWorker.reason)
    } else {
        Write-Host ('[F45] fx upload worker not started: ' + [string]$script:FxLoadError)
    }
} catch { Write-Host ('[F45] fx upload worker start failed: ' + $_.Exception.Message) }
# [F45 S4 fx-worker-end]
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
    # [F28 §1] INDEPENDENT 30s logon-result tick (server start, not the
    # workflow's keep-alive step). The accept loop sleeps 50ms, so this costs
    # nothing and the verdict is never older than ~30s.
    if (((Get-Date) - $lastLogonScan).TotalSeconds -ge $script:F28IntervalSec) {
        $lastLogonScan = Get-Date
        try { Update-RdpLogonAuthLast -StatePath $script:LogonStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
    }
    # [F30 §3] INDEPENDENT 30s RDP connection-log tick (both Operational logs).
    # This is the ONLY surface that can see a TLS handshake drop, because
    # 4624/4625 never fire for a connection killed before LSA.
    if (((Get-Date) - $lastConnLogScan).TotalSeconds -ge $script:F30ConnLogIntervalSec) {
        $lastConnLogScan = Get-Date
        try { Update-RdpConnLog -StatePath $script:ConnLogStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
    }
    # [F37 §4] INDEPENDENT 60s telescope tick: binds the OBSERVED listener
    # (boundThumb vs servedThumb, serving, key container + ACL SIDs, Schannel
    # tail) to the row, so a bind drift or a refused handshake is visible the
    # moment it happens instead of at the next workflow dispatch.
    if (((Get-Date) - $lastTelScan).TotalSeconds -ge $script:F37TelIntervalSec) {
        $lastTelScan = Get-Date
        try { Update-RdpListenerTelescope -StatePath $script:F37TelStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
    }
    if (((Get-Date) - $lastHeal).TotalSeconds -ge 60) {
        $lastHeal = Get-Date
        try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 50
}
try { $listener.Stop() } catch { }
