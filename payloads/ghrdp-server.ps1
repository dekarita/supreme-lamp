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
    if ($Code -eq 401) { $status = 'Unauthorized' }
    if ($Code -eq 204) { $status = 'No Content' }
    if ($Code -eq 403) { $status = 'Forbidden' }
    if ($Code -eq 404) { $status = 'Not Found' }
    if ($Code -eq 409) { $status = 'Conflict' }
    if ($Code -eq 500) { $status = 'Server Error' }
    $hdr = "HTTP/1.1 $Code $status`r`nContent-Type: $CType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type, Authorization`r`nAccess-Control-Allow-Methods: GET,POST,OPTIONS`r`n$ExtraHeaders`r`n"
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
# ---------------------------------------------------------------------------
# [F45 S4 fx-core-begin] EXPLORER SERVER CORE (F45-S4, Explorer §5 endpoints).
#
# The whole Explorer server surface lives in this ONE extracted, self-contained
# region so the Windows lane can dot-source it and drive REAL request cycles
# (tests/f45-s4-fx-server.ps1) instead of grepping it. Contract sources:
#   * src/components/explorer/api/endpoints.ts  -> paths, op vocabulary, shapes
#   * src/components/explorer/api/errors.ts     -> HTTP -> F44 phase mapping
#   * src/components/explorer/api/fxClient.ts   -> X-Dash-Token / X-CSRF-Token
#   * src/components/explorer/data/migrations/v1_to_v2.ts + stableId.ts
#
# Rules this region MUST keep:
#   1. /api/fx/* answers are never CORS-wildcarded (Explorer §5.1 rule 8, D4).
#   2. No gofile token, dash token or CSRF token is ever logged, echoed in a
#      body, or embedded in a URL that this server logs (F44 + §1.8). Every
#      log line goes through Write-FxLog -> Protect-FxText.
#   3. Every index write emits schemaVersion 2 + the gofileHosts array
#      (§1.9), atomically (temp file in the same directory + rename).
#   4. The F44 mirror index (mirror-index.json, written by the workflow) is
#      READ-only here. Explorer state lives in fx-index.json.
# ---------------------------------------------------------------------------
$script:FxSchemaVersion = 2
$script:FxQueueSchemaVersion = 1
$script:FxRedacted = '***REDACTED***'
$script:FxEpoch = '1970-01-01T00:00:00.000Z'
$script:FxMaxAttempts = 5
$script:FxBackoffBaseMs = 500
$script:FxBackoffCapMs = 8000
$script:FxIntervalSec = 15
$script:FxPreviewMaxBytes = 262144000
$script:FxFxRootsName = 'fx-roots'
$script:FxTransientPhases = @('dns', 'tcp', 'tls', 'http')
$script:FxFailFastStatus = @(401, 403, 413, 415)
$script:FxOps = @('trash', 'restore', 'move', 'tag', 'pin')
$script:FxRoots = @('Downloads', 'Desktop', 'Documents', 'Temp', 'RDP-Storage')
$script:FxUploadPhases = @('dns', 'tcp', 'tls', 'encrypt', 'size', 'type', 'auth', 'http', 'parse')
$script:FxUploadStatuses = @('idle', 'queued', 'uploading', 'success', 'failed', 'canceled')
$script:FxGofileStatuses = @('none', 'uploaded', 'processing', 'expired', 'failed')
# Exactly the 41 types of the S2 MIME map (preview-mime-map.json); the S4 gate
# asserts the two lists are identical, so a type can never be renderable in the
# client and 415-refused here (or the other way round).
$script:FxPreviewMimeAllow = @(
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/bmp', 'image/tiff',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac',
    'application/pdf',
    'text/markdown', 'text/x-markdown', 'text/x-python', 'text/x-c', 'text/x-c++src', 'text/x-java-source',
    'text/x-shellscript', 'text/x-rust', 'text/x-go', 'text/x-typescript',
    'application/json', 'application/javascript', 'application/typescript', 'application/x-shellscript',
    'application/x-python-code',
    'text/plain', 'text/csv', 'text/tab-separated-values', 'text/html', 'text/css',
    'application/octet-stream', 'application/zip', 'application/x-7z-compressed', 'application/x-unknown',
    'application/x-ghrdp-mirror'
)
$script:FxDefaultGofileHost = [ordered]@{
    id = 'gofile'
    displayName = 'gofile.io'
    maxFileBytes = $null
    allowedMimePrefixes = $null
    ttlSeconds = $null
    notes = ''
}
$script:FxRoot = ''
try { if ($Root) { $script:FxRoot = [string]$Root } } catch { }
if (-not $script:FxRoot) { $script:FxRoot = [System.IO.Path]::GetTempPath() }
$script:FxRootsMap = [ordered]@{
    Downloads = (Join-Path $script:FxRoot 'fx-roots\Downloads')
    Desktop = (Join-Path $script:FxRoot 'fx-roots\Desktop')
    Documents = (Join-Path $script:FxRoot 'fx-roots\Documents')
    Temp = (Join-Path $script:FxRoot 'fx-roots\Temp')
    'RDP-Storage' = (Join-Path $script:FxRoot 'fx-roots\RDP-Storage')
}
$script:FxIndexReadPath = Join-Path $script:FxRoot 'mirror-index.json'
$script:FxIndexPath = Join-Path $script:FxRoot 'fx-index.json'
$script:FxLogPath = Join-Path $script:FxRoot 'fx-server.log'
$script:FxQueueDir = Join-Path ([System.IO.Path]::GetTempPath()) 'ghrdp'
$script:FxQueuePath = Join-Path $script:FxQueueDir 'fx-upload-queue.json'
$script:FxIdempotencyPath = Join-Path $script:FxRoot 'fx-idempotency.json'
$script:FxIdempotencyMax = 50
$script:FxGofileBase = 'https://api.gofile.io'
$script:FxGofileToken = ''
$script:FxGofileHostAllow = @('gofile.io', 'www.gofile.io', 'api.gofile.io', 'store1.gofile.io', 'store2.gofile.io')
$script:FxClock = $null
$script:FxCsrfOverride = ''
$script:FxRouteTable = @(
    [ordered]@{ method = 'GET'; path = '/api/fx/list'; auth = 'dash'; csrf = $false }
    [ordered]@{ method = 'GET'; path = '/api/fx/meta'; auth = 'dash'; csrf = $false }
    [ordered]@{ method = 'GET'; path = '/api/fx/gofile/status'; auth = 'dash'; csrf = $false }
    [ordered]@{ method = 'GET'; path = '/api/fx/preview'; auth = 'dash'; csrf = $false }
    [ordered]@{ method = 'POST'; path = '/api/fx/op'; auth = 'dash'; csrf = $true }
    [ordered]@{ method = 'POST'; path = '/api/fx/upload'; auth = 'dash'; csrf = $true }
)
$script:FxFetcher = $null
$script:FxUploader = $null
# System.Net.Http is NOT loaded by Windows PowerShell 5.1 by default, so the
# default transport (a test-injectable fetcher is the other path) resolves it
# ONCE here. If it cannot be resolved the transport reports the ordinary
# 502/504 phases instead of surfacing a type-load error to the operator.
$script:FxHttpClientReady = $false
try {
    if ($null -eq ('System.Net.Http.HttpClient' -as [type])) { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop }
    $script:FxHttpClientReady = ($null -ne ('System.Net.Http.HttpClient' -as [type]))
} catch { $script:FxHttpClientReady = $false }
$script:FxLastWriteError = ''
$script:FxStartedAt = $null
$script:FxQueueTicks = 0
$script:FxLogRedactionHits = 0

function Get-FxClock {
    if ($script:FxClock) { return [datetime]$script:FxClock }
    return (Get-Date).ToUniversalTime()
}

function Get-FxNowIso {
    return (Get-FxClock).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function ConvertTo-FxIso {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return ([datetime]$Value).ToUniversalTime().ToString('o') }
    if (-not ($Value -is [string])) { return $null }
    $s = [string]$Value
    if (-not $s) { return $null }
    $dt = [datetime]::MinValue
    $parsed = [datetime]::TryParse($s, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$dt)
    if (-not $parsed) { return $null }
    # The stored STRING is returned verbatim once it is a valid timestamp. It
    # used to be re-formatted to 7 fractional digits, which meant a document
    # re-read and re-normalized differed from its own input (the epoch fallback
    # is millisecond-precision) - i.e. migration was not idempotent, and every
    # read of an untouched file rewrote its mtime. Only a real [datetime] is
    # formatted; the client parses either form.
    return $s.Trim()
}

function Protect-FxText {
    # [F45 §1.8] Credential redaction for EVERY log line, error body and detail
    # string this region produces. Known secret values are replaced first, then
    # credential-shaped name=value pairs, so an unknown token shape still cannot
    # reach a log.
    param([string]$Text, [string[]]$Secrets = @())
    if (-not $Text) { return '' }
    $out = [string]$Text
    $all = @()
    if ($script:FxGofileToken) { $all += [string]$script:FxGofileToken }
    foreach ($s in @($Secrets)) { if ($s -and ([string]$s).Length -ge 8) { $all += [string]$s } }
    foreach ($s in @($all | Select-Object -Unique)) {
        if ($s) { $out = $out.Replace([string]$s, $script:FxRedacted) }
    }
    # Shape rule FIRST, independent of any name=value context: a host that echoes
    # its own credential inside an error page, a URL path or a bare token field
    # must not be able to smuggle `go_...` into a log line, a body or a detail
    # string (F44 + S1.8). This is what the unknown-token case relies on, because
    # $script:FxGofileToken is only set on a host that is configured.
    $out = [regex]::Replace($out, '(?i)\bgo_[A-Za-z0-9_-]{8,}', $script:FxRedacted)
    # Then the credential-shaped name=value pairs. The value may carry an
    # authentication scheme (`Authorization: Bearer <token>`), so the scheme word
    # is part of what gets replaced - otherwise the secret itself survives.
    $out = [regex]::Replace($out, '(?i)((?:dash[-_]?token|csrf[-_]?token|token|key|authorization|go_[A-Za-z0-9]{6,})\s*[:=]\s*)(?:(?:bearer|basic|digest)\s+)?[^&\s"'']+', ('$1' + $script:FxRedacted))
    return $out
}

function Write-FxLog {
    # The ONLY fx log writer: every line passes through Protect-FxText first.
    # Returns the redacted line so a test can assert a token never appears.
    param([string]$Message, [string[]]$Secrets = @())
    $raw = [string]$Message
    if ($script:FxGofileToken) { $Secrets = @($Secrets) + @([string]$script:FxGofileToken) }
    $red = Protect-FxText -Text $raw -Secrets $Secrets
    $line = ((Get-FxClock).ToString('o') + ' [fx] ' + $red)
    if ($raw -ne $red) { $script:FxLogRedactionHits = [int]$script:FxLogRedactionHits + 1 }
    if ($script:FxLogPath) {
        try {
            $dir = Split-Path -Parent $script:FxLogPath
            if ($dir -and -not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
            [System.IO.File]::AppendAllText($script:FxLogPath, ($line + "`n"), (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
    }
    return $line
}

function Test-FxConstantEquals {
    # Same shape as Test-TicketBearer: length check + XOR accumulate, no early
    # exit, so a token compare cannot be timed character by character.
    param([string]$A, [string]$B)
    if ($null -eq $A -or $null -eq $B) { return $false }
    if ($A.Length -ne $B.Length -or $A.Length -eq 0) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $A.Length; $i++) { $diff = $diff -bor ([int][char]$A[$i] -bxor [int][char]$B[$i]) }
    return ($diff -eq 0)
}

function Get-FxSha256Hex {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$Text))
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hash) { $null = $sb.Append($b.ToString('x2')) }
        return $sb.ToString()
    } finally { $sha.Dispose() }
}

function ConvertTo-FxStableId {
    # [F45 S2 stableId.ts] identity, not authentication: UTF-8 SHA1(root + path),
    # lowercase hex. The server must agree with the client byte for byte.
    param([string]$RootName, [string]$Path)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(([string]$RootName + [string]$Path)))
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hash) { $null = $sb.Append($b.ToString('x2')) }
        return $sb.ToString()
    } finally { $sha.Dispose() }
}

function ConvertTo-FxJsonBytes {
    param($Object)
    return [System.Text.Encoding]::UTF8.GetBytes(($Object | ConvertTo-Json -Depth 12 -Compress))
}

function Save-FxJsonAtomic {
    # temp file in the SAME directory, then rename: a reader can never observe a
    # half-written index or queue (Explorer §5.1 rule 5).
    param([string]$Path, $Object)
    $script:FxLastWriteError = ''
    try {
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
        $json = ($Object | ConvertTo-Json -Depth 12 -Compress)
        $tmp = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path) {
            try { [System.IO.File]::Replace($tmp, $Path, $null) }
            catch { [System.IO.File]::Delete($Path); [System.IO.File]::Move($tmp, $Path) }
        } else {
            [System.IO.File]::Move($tmp, $Path)
        }
        return $true
    } catch {
        $script:FxLastWriteError = Protect-FxText ([string]$_.Exception.Message)
        return $false
    }
}

function Read-FxJson {
    param([string]$Path)
    $result = [ordered]@{ ok = $false; value = $null; reason = 'missing'; detail = '' }
    if (-not $Path) { return $result }
    if (-not (Test-Path -LiteralPath $Path)) { return $result }
    try {
        $raw = [System.IO.File]::ReadAllText($Path)
        if (-not $raw -or -not $raw.Trim()) { $result.reason = 'empty'; return $result }
        $result.value = ($raw | ConvertFrom-Json)
        $result.ok = $true
        $result.reason = 'ok'
    } catch {
        $result.reason = 'parse'
        $result.detail = Protect-FxText ([string]$_.Exception.Message)
    }
    return $result
}

function Get-FxMember {
    # Dictionary-aware (the index/queue are [ordered] documents) and
    # PSObject-aware (a ConvertFrom-Json value), so a caller never has to know
    # which shape it holds.
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    try {
        $p = $Object.PSObject.Properties[$Name]
        if ($p) { return $p.Value }
    } catch { }
    return $null
}

function Get-FxRows {
    # Array-valued read for iteration and counting. PowerShell DROPS an empty
    # array on return, so `@(Get-FxRows $o 'roots')` cannot tell "no rows" from
    # "one null row": on 5.1 and 7 alike it iterates ONCE with $null and a
    # normalizer would fabricate a row (a phantom Temp root, a bogus queue job).
    # Callers therefore always write `@(Get-FxRows $o 'roots')`, which is 0 rows
    # when the member is missing, null or empty.
    param($Object, [string]$Name)
    $raw = Get-FxMember $Object $Name
    if ($null -eq $raw) { return }
    return @($raw)
}

function Test-FxMember {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return [bool]$Object.Contains($Name) }
    try { return ($null -ne $Object.PSObject.Properties[$Name]) } catch { return $false }
}

function Set-FxMember {
    # Set (or add) one member on either document shape. Returns $false instead
    # of throwing, so a malformed entry can never take the whole route down.
    param($Object, [string]$Name, $Value)
    if ($null -eq $Object) { return $false }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { $Object[$Name] = $Value } else { $Object.Add($Name, $Value) }
        return $true
    }
    try { $null = $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force; return $true } catch { return $false }
}

function Get-FxTextOr {
    param($Value, [string]$Fallback = '')
    if ($Value -is [string]) { return [string]$Value }
    return $Fallback
}

function Get-FxStringOrNull {
    param($Value)
    if ($Value -is [string] -and $Value.Length -gt 0) { return [string]$Value }
    return $null
}

function Get-FxBool {
    param($Value)
    if ($Value -is [bool]) { return [bool]$Value }
    return $false
}

function Get-FxNumberOrZero {
    param($Value)
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [int16] -or $Value -is [single]) {
        $d = [double]$Value
        if (-not [double]::IsNaN($d) -and -not [double]::IsInfinity($d) -and $d -ge 0) { return $d }
    }
    return [double]0
}

function Get-FxNumberOrNull {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [int16] -or $Value -is [single]) {
        $d = [double]$Value
        if (-not [double]::IsNaN($d) -and -not [double]::IsInfinity($d) -and $d -ge 0) { return $d }
    }
    return $null
}

function Get-FxStringArray {
    param($Value)
    $out = @()
    foreach ($item in @($Value)) {
        if ($item -is [string]) { $out += [string]$item }
    }
    return $out
}

function Get-FxUniqueStrings {
    param($Value)
    $out = @()
    foreach ($item in @(Get-FxStringArray $Value)) {
        if ($out -notcontains $item) { $out += $item }
    }
    return $out
}

function Test-FxStringArrayEqual {
    param($A, $B)
    $x = @(Get-FxStringArray $A)
    $y = @(Get-FxStringArray $B)
    if ($x.Count -ne $y.Count) { return $false }
    for ($i = 0; $i -lt $x.Count; $i++) { if ($x[$i] -cne $y[$i]) { return $false } }
    return $true
}

function Get-FxEnumMember {
    param($Value, [string[]]$Allowed, [string]$Fallback)
    if ($Value -is [string] -and ($Allowed -contains [string]$Value)) { return [string]$Value }
    return $Fallback
}

function Get-FxSafeDirectUrl {
    # Explorer §4 invariant, byte-identical to S2's safeDirectUrl: https only,
    # no userinfo, no query, no fragment. A credential-bearing link can never be
    # stored, logged or rendered.
    param($Value)
    if (-not ($Value -is [string])) { return $null }
    $s = [string]$Value
    if (-not $s) { return $null }
    try { $uri = [uri]$s } catch { return $null }
    if ($uri.Scheme -ne 'https') { return $null }
    if ($uri.UserInfo) { return $null }
    if ($uri.Query) { return $null }
    if ($uri.Fragment) { return $null }
    return $s
}

function Test-FxProxyAllowedUrl {
    # Only the configured gofile host may be proxied. This is the allowlist that
    # matters: it gates the OUTBOUND fetch, not the stored value, so S2's
    # "keep any credential-free https link" rule stays true.
    param([string]$Url)
    if (-not $Url) { return $false }
    try { $uri = [uri]$Url } catch { return $false }
    if ($uri.Scheme -ne 'https') { return $false }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { return $false }
    return ($script:FxGofileHostAllow -contains $uri.Host.ToLower())
}

# --- index model (port of data/migrations/v1_to_v2.ts) ---------------------

function Get-FxIdForEntry {
    param($Value, [string]$RootName, [string]$Path)
    $existing = Get-FxStringOrNull (Get-FxMember $Value 'id')
    if ($existing) { return $existing }
    return (ConvertTo-FxStableId -RootName $RootName -Path $Path)
}

function ConvertTo-FxUploadState {
    param($Value)
    $phase = $null
    if (Test-FxMember $Value 'phase') {
        $rawPhase = Get-FxMember $Value 'phase'
        if ($null -ne $rawPhase) { $phase = Get-FxEnumMember $rawPhase $script:FxUploadPhases 'parse' }
    }
    $lastError = $null
    if ((Test-FxMember $Value 'lastError') -and $null -ne (Get-FxMember $Value 'lastError')) {
        $src = Get-FxMember $Value 'lastError'
        $lastError = [ordered]@{ phase = (Get-FxEnumMember (Get-FxMember $src 'phase') $script:FxUploadPhases 'parse') }
        $hs = Get-FxMember $src 'httpStatus'
        if ($hs -is [int] -or $hs -is [long] -or $hs -is [double] -or $hs -is [decimal]) { $lastError['httpStatus'] = [int]$hs }
        # F44: the host message is carried COMPLETE. No substring, no cap.
        $hm = Get-FxMember $src 'hostMessage'
        if ($hm -is [string]) { $lastError['hostMessage'] = [string]$hm }
        $at = Get-FxStringOrNull (Get-FxMember $src 'at')
        if ($at) { $lastError['at'] = $at }
    }
    return [ordered]@{
        phase = $phase
        status = (Get-FxEnumMember (Get-FxMember $Value 'status') $script:FxUploadStatuses 'idle')
        retries = (Get-FxNumberOrZero (Get-FxMember $Value 'retries'))
        lastError = $lastError
        bytesSent = (Get-FxNumberOrZero (Get-FxMember $Value 'bytesSent'))
    }
}

function ConvertTo-FxGofileState {
    param($Value)
    $status = Get-FxEnumMember (Get-FxMember $Value 'status') $script:FxGofileStatuses 'none'
    $directUrl = $null
    # §4 invariant: a direct link exists ONLY for an uploaded file.
    if ($status -eq 'uploaded') { $directUrl = Get-FxSafeDirectUrl (Get-FxMember $Value 'directUrl') }
    return [ordered]@{
        code = (Get-FxStringOrNull (Get-FxMember $Value 'code'))
        fileId = (Get-FxStringOrNull (Get-FxMember $Value 'fileId'))
        directUrl = $directUrl
        status = $status
        uploadedAt = (Get-FxStringOrNull (Get-FxMember $Value 'uploadedAt'))
        expiryTs = (Get-FxStringOrNull (Get-FxMember $Value 'expiryTs'))
        downloads = (Get-FxNumberOrZero (Get-FxMember $Value 'downloads'))
        remoteSize = (Get-FxNumberOrNull (Get-FxMember $Value 'remoteSize'))
    }
}

function ConvertTo-FxFileEntry {
    param($Value)
    $rootName = Get-FxEnumMember (Get-FxMember $Value 'root') $script:FxRoots 'Temp'
    $rawPath = (Get-FxTextOr (Get-FxMember $Value 'path') '')
    $path = '/' + ($rawPath.Replace('\', '/').TrimStart('/'))
    return [ordered]@{
        id = (Get-FxIdForEntry -Value $Value -RootName $rootName -Path $path)
        root = $rootName
        path = $path
        size = (Get-FxNumberOrZero (Get-FxMember $Value 'size'))
        mtime = (Get-FxIsoOrFallbackValue -Value (Get-FxMember $Value 'mtime') -Fallback $script:FxEpoch)
        mime = (Get-FxTextOr (Get-FxMember $Value 'mime') 'application/octet-stream')
        checksum = (Get-FxStringOrNull (Get-FxMember $Value 'checksum'))
        tags = @(Get-FxUniqueStrings (Get-FxMember $Value 'tags'))
        pinned = (Get-FxBool (Get-FxMember $Value 'pinned'))
        trashed = (Get-FxBool (Get-FxMember $Value 'trashed'))
        trashedAt = (Get-FxStringOrNull (Get-FxMember $Value 'trashedAt'))
        recentsTs = (Get-FxStringOrNull (Get-FxMember $Value 'recentsTs'))
        upload = (ConvertTo-FxUploadState -Value (Get-FxMember $Value 'upload'))
        gofile = (ConvertTo-FxGofileState -Value (Get-FxMember $Value 'gofile'))
    }
}

function Get-FxIsoOrFallbackValue {
    param($Value, [string]$Fallback)
    $iso = ConvertTo-FxIso $Value
    if ($iso) { return $iso }
    return $Fallback
}

function ConvertTo-FxRootSnapshot {
    param($Value)
    return [ordered]@{
        root = (Get-FxEnumMember (Get-FxMember $Value 'root') $script:FxRoots 'Temp')
        scannedAt = (Get-FxIsoOrFallbackValue -Value (Get-FxMember $Value 'scannedAt') -Fallback $script:FxEpoch)
        totalBytes = (Get-FxNumberOrZero (Get-FxMember $Value 'totalBytes'))
        fileCount = (Get-FxNumberOrZero (Get-FxMember $Value 'fileCount'))
        quotaBytes = (Get-FxNumberOrNull (Get-FxMember $Value 'quotaBytes'))
    }
}

function ConvertTo-FxGofileHost {
    param($Value)
    $maxBytes = Get-FxNumberOrNull (Get-FxMember $Value 'maxFileBytes')
    $ttl = Get-FxNumberOrNull (Get-FxMember $Value 'ttlSeconds')
    $prefixes = $null
    if ((Test-FxMember $Value 'allowedMimePrefixes') -and $null -ne (Get-FxMember $Value 'allowedMimePrefixes')) {
        $prefixes = @(Get-FxStringArray (Get-FxMember $Value 'allowedMimePrefixes'))
    }
    return [ordered]@{
        id = 'gofile'
        displayName = (Get-FxTextOr (Get-FxMember $Value 'displayName') $script:FxDefaultGofileHost.displayName)
        maxFileBytes = $maxBytes
        allowedMimePrefixes = $prefixes
        ttlSeconds = $ttl
        notes = (Get-FxTextOr (Get-FxMember $Value 'notes') '')
    }
}

function Invoke-FxMigrateIndex {
    # Additive v1 -> v2 (also the normalizer for an already-v2 document, so every
    # read hands the operations layer a complete, mutable, allowlisted shape).
    # Unknown properties are not copied; missing timestamps get the epoch, never
    # a fabricated current clock; exactly one configured host.
    param($Value)
    $src = $Value
    if ($null -eq $src) { $src = [ordered]@{} }
    $configured = $null
    # NOT $host: that name is a read-only automatic variable and 5.1 throws
    # "Cannot overwrite variable Host" the moment it is bound.
    foreach ($hostEntry in @(Get-FxRows $src 'gofileHosts')) {
        if ((Get-FxEnumMember (Get-FxMember $hostEntry 'id') @('gofile') '') -eq 'gofile') { $configured = $hostEntry; break }
    }
    if ($null -eq $configured) { $configured = $script:FxDefaultGofileHost }
    $roots = @()
    foreach ($r in @(Get-FxRows $src 'roots')) { $roots += (ConvertTo-FxRootSnapshot -Value $r) }
    $files = @()
    foreach ($f in @(Get-FxRows $src 'files')) { $files += (ConvertTo-FxFileEntry -Value $f) }
    return [ordered]@{
        schemaVersion = $script:FxSchemaVersion
        generatedAt = (Get-FxIsoOrFallbackValue -Value (Get-FxMember $src 'generatedAt') -Fallback $script:FxEpoch)
        runnerId = (Get-FxTextOr (Get-FxMember $src 'runnerId') 'unknown')
        roots = $roots
        files = $files
        gofileHosts = @((ConvertTo-FxGofileHost -Value $configured))
    }
}

function New-FxEmptyIndex {
    $roots = @()
    foreach ($r in $script:FxRoots) {
        $roots += [ordered]@{ root = $r; scannedAt = $script:FxEpoch; totalBytes = 0; fileCount = 0; quotaBytes = $null }
    }
    $seed = (Get-FxSha256Hex ([string]$env:COMPUTERNAME + '|' + [string]$script:FxRoot)).Substring(0, 12)
    return [ordered]@{
        schemaVersion = $script:FxSchemaVersion
        generatedAt = (Get-FxNowIso)
        runnerId = ('runner-' + $seed)
        roots = $roots
        files = @()
        gofileHosts = @((ConvertTo-FxGofileHost -Value $script:FxDefaultGofileHost))
    }
}

function Get-FxIndexDoc {
    # ok=$false + reason='parse' carries the F44 phase the caller must report
    # (500 + phase=parse). reason='missing' means "not scanned yet", NOT an
    # empty index: the endpoint still answers 200 with an empty v2 document and
    # an explicit 'unscanned' source so the UI cannot mistake it for real data.
    param([string]$ReadPath = '', [string]$MirrorPath = '')
    if (-not $ReadPath) { $ReadPath = $script:FxIndexPath }
    if (-not $MirrorPath) { $MirrorPath = $script:FxIndexReadPath }
    $result = [ordered]@{ ok = $false; index = $null; source = 'missing'; reason = 'missing'; detail = ''; schemaVersion = 0; migrated = $false }
    $doc = $null
    $source = 'unscanned'
    $read = Read-FxJson -Path $ReadPath
    if ($read.ok) { $doc = $read.value; $source = 'fx-index' }
    elseif ($read.reason -eq 'parse') { $result.reason = 'parse'; $result.detail = $read.detail; return $result }
    if ($null -eq $doc -and $MirrorPath -and $MirrorPath -ne $ReadPath) {
        $mirror = Read-FxJson -Path $MirrorPath
        if ($mirror.ok) { $doc = $mirror.value; $source = 'mirror-index' }
        elseif ($mirror.reason -eq 'parse') { $result.reason = 'parse'; $result.detail = $mirror.detail; return $result }
    }
    $version = 0
    if ($null -ne $doc) {
        $rawVersion = Get-FxMember $doc 'schemaVersion'
        if ($rawVersion -is [int] -or $rawVersion -is [long] -or $rawVersion -is [double] -or $rawVersion -is [decimal]) { $version = [int]$rawVersion }
    }
    $result.schemaVersion = $version
    if ($null -eq $doc) {
        $doc = New-FxEmptyIndex
    } else {
        if ($version -ne $script:FxSchemaVersion) { $result.migrated = $true }
        $doc = Invoke-FxMigrateIndex -Value $doc
    }
    $result.ok = $true
    $result.reason = 'ok'
    $result.index = $doc
    $result.source = $source
    return $result
}

function Set-FxIndexDoc {
    # [F45 §1.9] every index write emits schemaVersion 2 + gofileHosts, from a
    # temp file in the same directory. Never writes the F44 mirror index.
    param($Index, [string]$Path = '')
    if (-not $Path) { $Path = $script:FxIndexPath }
    if ($null -eq $Index) { return $false }
    $doc = $Index
    if (-not ($doc -is [System.Collections.IDictionary])) { $doc = Invoke-FxMigrateIndex -Value $doc }
    try {
        $null = Set-FxMember -Object $doc -Name 'schemaVersion' -Value $script:FxSchemaVersion
        $null = Set-FxMember -Object $doc -Name 'generatedAt' -Value (Get-FxNowIso)
        if (-not (Test-FxMember $doc 'gofileHosts') -or @(Get-FxRows $doc 'gofileHosts').Count -eq 0) {
            $null = Set-FxMember -Object $doc -Name 'gofileHosts' -Value @((ConvertTo-FxGofileHost -Value $script:FxDefaultGofileHost))
        }
        $counts = @{}
        foreach ($entry in @(Get-FxRows $doc 'files')) {
            $r = Get-FxTextOr (Get-FxMember $entry 'root') 'Temp'
            if (-not $counts.ContainsKey($r)) { $counts[$r] = [ordered]@{ count = 0; bytes = [double]0 } }
            $counts[$r].count = [int]$counts[$r].count + 1
            $counts[$r].bytes = [double]$counts[$r].bytes + [double](Get-FxNumberOrZero (Get-FxMember $entry 'size'))
        }
        $roots = @()
        foreach ($r in $script:FxRoots) {
            $existing = $null
            foreach ($snap in @(Get-FxRows $doc 'roots')) { if ((Get-FxTextOr (Get-FxMember $snap 'root') '') -eq $r) { $existing = $snap; break } }
            $count = 0; $bytes = [double]0
            if ($counts.ContainsKey($r)) { $count = [int]$counts[$r].count; $bytes = [double]$counts[$r].bytes }
            $roots += [ordered]@{
                root = $r
                scannedAt = (Get-FxTextOr (Get-FxMember $existing 'scannedAt') $script:FxEpoch)
                totalBytes = $bytes
                fileCount = $count
                quotaBytes = (Get-FxNumberOrNull (Get-FxMember $existing 'quotaBytes'))
            }
        }
        $null = Set-FxMember -Object $doc -Name 'roots' -Value $roots
    } catch {
        $script:FxLastWriteError = Protect-FxText ([string]$_.Exception.Message)
        return $false
    }
    return (Save-FxJsonAtomic -Path $Path -Object $doc)
}

function Select-FxFileEntry {
    param($Index, [string]$Id)
    if ($null -eq $Index -or -not $Id) { return $null }
    foreach ($entry in @(Get-FxRows $Index 'files')) {
        if ((Get-FxTextOr (Get-FxMember $entry 'id') '') -ceq $Id) { return $entry }
    }
    return $null
}

function Initialize-FxIndex {
    # Startup: create fx-index.json (schemaVersion 2 + gofileHosts) from the F44
    # mirror index when one exists, else as an explicitly unscanned empty index.
    param([string]$ReadPath = '', [string]$MirrorPath = '', [string]$WritePath = '')
    if (-not $ReadPath) { $ReadPath = $script:FxIndexPath }
    if (-not $WritePath) { $WritePath = $script:FxIndexPath }
    if (-not $MirrorPath) { $MirrorPath = $script:FxIndexReadPath }
    if (Test-Path -LiteralPath $ReadPath) {
        $doc = Get-FxIndexDoc -ReadPath $ReadPath -MirrorPath ''
        if (-not $doc.ok) { return $doc }
        # Re-emit so an existing v1/partial file is upgraded in place (§1.9).
        $null = Set-FxIndexDoc -Index $doc.index -Path $WritePath
        return $doc
    }
    $fresh = Get-FxIndexDoc -ReadPath $ReadPath -MirrorPath $MirrorPath
    if (-not $fresh.ok) { return $fresh }
    $null = Set-FxIndexDoc -Index $fresh.index -Path $WritePath
    return $fresh
}

# --- gates -----------------------------------------------------------------

function Test-FxSourceAllowed {
    param([string]$SourceIp)
    if (-not $SourceIp) { return $false }
    $ip = $null
    try { $ip = [System.Net.IPAddress]::Parse($SourceIp) } catch { return $false }
    if (-not $ip) { return $false }
    if ($ip.IsIPv4MappedToIPv6) { $ip = $ip.MapToIPv4() }
    if ([System.Net.IPAddress]::IsLoopback($ip)) { return $true }
    $b = $ip.GetAddressBytes()
    return (($b.Length -eq 4 -and $b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127) -or
        ($b.Length -eq 16 -and $b[0] -eq 0xfd -and $b[1] -eq 0x7a))
}

function Get-FxCsrfToken {
    # §5.1 rule 4 needs a CSRF token that a cross-site attacker can never read:
    # it is derived from the dash token, lives only in a header (never a cookie,
    # never a URL) and is compared in constant time. Documented delta: the plan
    # requires CSRF but does not define its derivation.
    param([string]$Token)
    if (-not $Token) { return '' }
    return (Get-FxSha256Hex ([string]$Token + '|fx-csrf-v1')).Substring(0, 32)
}

function Test-FxDashToken {
    # The dash token arrives in X-Dash-Token only (Explorer §5.1 rule 1). The
    # parent ?key= form is accepted as documented compatibility for the existing
    # dashboard flows, and a tailnet/loopback source is the same trust path the
    # parent gate already grants. A token is REQUIRED here even when none is
    # configured: /api/fx fails closed.
    param($Headers, $Query, [string]$Token, [string]$SourceIp)
    $out = [ordered]@{ ok = $false; reason = 'missing'; via = 'none'; present = $false }
    if (Test-FxSourceAllowed -SourceIp $SourceIp) { $out.ok = $true; $out.reason = 'source'; $out.via = 'source'; return $out }
    $sent = ''
    if ($Headers -and $Headers.ContainsKey('x-dash-token')) { $sent = [string]$Headers['x-dash-token'] }
    if (-not $sent -and $Query -and $Query.ContainsKey('key')) { $sent = [string]$Query['key'] }
    if (-not $sent) { return $out }
    $out.present = $true
    $out.via = 'header'
    if ($Query -and -not ($Headers -and $Headers.ContainsKey('x-dash-token')) -and $Query.ContainsKey('key')) { $out.via = 'query' }
    if (-not $Token) { $out.reason = 'unconfigured'; return $out }
    if (Test-FxConstantEquals -A $sent -B $Token) { $out.ok = $true; $out.reason = 'token'; return $out }
    $out.reason = 'mismatch'
    return $out
}

function Test-FxCsrf {
    param($Headers, [string]$Method, [string]$Token)
    if ([string]$Method -ne 'POST') { return $true }
    $sent = ''
    if ($Headers -and $Headers.ContainsKey('x-csrf-token')) { $sent = [string]$Headers['x-csrf-token'] }
    if (-not $sent) { return $false }
    $expected = Get-FxCsrfToken -Token $Token
    if (-not $expected) {
        if ($script:FxCsrfOverride) { return (Test-FxConstantEquals -A $sent -B ([string]$script:FxCsrfOverride)) }
        return $false
    }
    return (Test-FxConstantEquals -A $sent -B $expected)
}

# --- idempotency (§5.1 rule 6) ---------------------------------------------

function Get-FxRequestHash {
    # SHA-256 over method + path + the raw body bytes: a replayed key is only
    # honoured for the IDENTICAL request, and a reuse with a different body is a
    # client error rather than a second side effect.
    param([string]$Method, [string]$Path, $Body)
    $prefix = [System.Text.Encoding]::UTF8.GetBytes(([string]$Method + ' ' + [string]$Path + '|'))
    $bodyBytes = @()
    if ($null -ne $Body) { $bodyBytes = [byte[]]$Body }
    $all = [byte[]]::new($prefix.Length + $bodyBytes.Length)
    [System.Array]::Copy($prefix, 0, $all, 0, $prefix.Length)
    if ($bodyBytes.Length -gt 0) { [System.Array]::Copy($bodyBytes, 0, $all, $prefix.Length, $bodyBytes.Length) }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($all)
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hash) { $null = $sb.Append($b.ToString('x2')) }
        return $sb.ToString()
    } finally { $sha.Dispose() }
}

function Get-FxIdempotentHit {
    param([string]$Key, [string]$RequestHash, [string]$Path = '')
    if (-not $Path) { $Path = $script:FxIdempotencyPath }
    $out = [ordered]@{ hit = $false; conflict = $false; code = 0; body = ''; at = '' }
    if (-not $Key) { return $out }
    $doc = Read-FxJson -Path $Path
    if (-not $doc.ok -or $null -eq $doc.value) { return $out }
    foreach ($entry in @(Get-FxRows $doc.value 'entries')) {
        if ((Get-FxTextOr (Get-FxMember $entry 'key') '') -ceq $Key) {
            $stored = Get-FxTextOr (Get-FxMember $entry 'requestHash') ''
            if ($stored -ceq $RequestHash) {
                $out.hit = $true
                $out.code = [int](Get-FxNumberOrZero (Get-FxMember $entry 'code'))
                $out.body = Get-FxTextOr (Get-FxMember $entry 'body') ''
                $out.at = Get-FxTextOr (Get-FxMember $entry 'at') ''
            } else {
                $out.conflict = $true
            }
            return $out
        }
    }
    return $out
}

function Save-FxIdempotentResult {
    # Bounded ring (the last $script:FxIdempotencyMax keys), atomic write. The
    # stored body is the response the replay must reproduce, so the key must
    # never be used for two different requests.
    param([string]$Key, [string]$Method, [string]$Path, [string]$RequestHash, [int]$Code, [string]$Body, [string]$StorePath = '')
    if (-not $Key) { return $false }
    if (-not $StorePath) { $StorePath = $script:FxIdempotencyPath }
    $doc = Read-FxJson -Path $StorePath
    $entries = @()
    $seq = 0
    if ($doc.ok -and $null -ne $doc.value) {
        foreach ($entry in @(Get-FxRows $doc.value 'entries')) {
            $seq = [int](Get-FxNumberOrZero (Get-FxMember $entry 'seq'))
            $entries += [ordered]@{
                seq = $seq
                key = (Get-FxTextOr (Get-FxMember $entry 'key') '')
                method = (Get-FxTextOr (Get-FxMember $entry 'method') '')
                path = (Get-FxTextOr (Get-FxMember $entry 'path') '')
                requestHash = (Get-FxTextOr (Get-FxMember $entry 'requestHash') '')
                code = [int](Get-FxNumberOrZero (Get-FxMember $entry 'code'))
                body = (Get-FxTextOr (Get-FxMember $entry 'body') '')
                at = (Get-FxTextOr (Get-FxMember $entry 'at') '')
            }
        }
    }
    $seq = $seq + 1
    $entries += [ordered]@{ seq = $seq; key = $Key; method = [string]$Method; path = [string]$Path; requestHash = [string]$RequestHash; code = [int]$Code; body = [string]$Body; at = (Get-FxNowIso) }
    while ($entries.Count -gt $script:FxIdempotencyMax) { $entries = @($entries | Select-Object -Skip 1) }
    $store = [ordered]@{ schemaVersion = 1; updatedAt = (Get-FxNowIso); entries = $entries }
    return (Save-FxJsonAtomic -Path $StorePath -Object $store)
}

# --- operations (POST /api/fx/op) ------------------------------------------

function Get-FxBodyObject {
    param([byte[]]$Body)
    if (-not $Body -or $Body.Length -eq 0) { return $null }
    try { return ([System.Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json) } catch { return $null }
}

function Test-FxBodyHasHardFlag {
    # §5.1 rule 3: no hard delete ANYWHERE. A smuggled hard flag is a 400, not a
    # silently ignored field.
    param($Body)
    if ($null -eq $Body) { return $false }
    try {
        foreach ($p in @($Body.PSObject.Properties)) { if ([string]$p.Name -ieq 'hard') { return $true } }
    } catch { return $false }
    return $false
}

function New-FxSkips {
    param([string]$Id, [string]$Reason)
    return [ordered]@{ id = $Id; reason = $Reason }
}

function Invoke-FxOpOnIndex {
    # Pure in-memory application of one operation to a normalized index. The
    # caller persists the result atomically; a 400 here means the REQUEST is
    # malformed, an entry-level refusal is a `skipped` row (§5.1 rule 5).
    param($Index, $Body, [string]$Now = '')
    if (-not $Now) { $Now = (Get-FxNowIso) }
    $result = [ordered]@{ code = 400; applied = @(); skipped = @(); reason = 'bad-op'; message = '' }
    if ($null -eq $Body) { $result.message = 'op requires a JSON body'; return $result }
    if ($null -eq $Index) { $result.message = 'index unavailable'; return $result }
    if (Test-FxBodyHasHardFlag -Body $Body) { $result.message = 'hard delete is not an Explorer operation'; return $result }
    $op = Get-FxStringOrNull (Get-FxMember $Body 'op')
    if (-not $op -or ($script:FxOps -notcontains $op)) { $result.message = ('unknown op: ' + [string]$op); return $result }
    $ids = @(Get-FxUniqueStrings (Get-FxMember $Body 'ids'))
    if ($ids.Count -eq 0) { $result.message = 'op requires at least one id'; return $result }
    $target = Get-FxStringOrNull (Get-FxMember $Body 'target')
    if ($op -eq 'move') {
        # `target` is a DESTINATION DIRECTORY (Explorer: "destination for move,
        # relative to a root"). The file keeps its own name, which is what makes
        # one request able to move several files, and what keeps a move from
        # collapsing two entries onto a single path.
        if (-not $target -or -not $target.StartsWith('/')) { $result.message = 'move requires a POSIX target directory'; return $result }
        foreach ($seg in $target.Split('/')) {
            if ($seg -eq '..' -or $seg -eq '.') { $result.message = 'target must not contain . or ..'; return $result }
            if ($seg.IndexOfAny([char[]]@(':', '*', '?', '"', '<', '>', '|')) -ge 0) { $result.message = 'target contains an unsafe character'; return $result }
        }
        while ($target.Length -gt 1 -and $target.EndsWith('/')) { $target = $target.Substring(0, $target.Length - 1) }
    }
    if ($op -eq 'pin' -and -not ((Get-FxMember $Body 'pin') -is [bool])) { $result.message = 'pin requires a boolean pin field'; return $result }
    if ($op -eq 'tag' -and -not (Test-FxMember $Body 'tags')) { $result.message = 'tag requires a tags array'; return $result }
    $tags = @(Get-FxUniqueStrings (Get-FxMember $Body 'tags'))
    $pin = Get-FxBool (Get-FxMember $Body 'pin')
    $applied = @()
    $skipped = @()
    foreach ($id in $ids) {
        $entry = Select-FxFileEntry -Index $Index -Id $id
        if ($null -eq $entry) { $skipped += (New-FxSkips -Id $id -Reason 'unknown-id'); continue }
        $changed = $false
        if ($op -eq 'trash') {
            if ([bool](Get-FxBool (Get-FxMember $entry 'trashed'))) { $skipped += (New-FxSkips -Id $id -Reason 'no-change') }
            else { $null = Set-FxMember -Object $entry -Name 'trashed' -Value $true; $null = Set-FxMember -Object $entry -Name 'trashedAt' -Value $Now; $changed = $true }
        } elseif ($op -eq 'restore') {
            if (-not [bool](Get-FxBool (Get-FxMember $entry 'trashed'))) { $skipped += (New-FxSkips -Id $id -Reason 'no-change') }
            else { $null = Set-FxMember -Object $entry -Name 'trashed' -Value $false; $null = Set-FxMember -Object $entry -Name 'trashedAt' -Value $null; $changed = $true }
        } elseif ($op -eq 'move') {
            $base = Get-FxTextOr (Get-FxMember $entry 'path') ''
            if ([bool](Get-FxBool (Get-FxMember $entry 'trashed'))) { $skipped += (New-FxSkips -Id $id -Reason 'trashed') }
            else {
                $leaf = $base
                $slash = $base.LastIndexOf('/')
                if ($slash -ge 0) { $leaf = $base.Substring($slash + 1) }
                if (-not $leaf) { $skipped += (New-FxSkips -Id $id -Reason 'no-change') }
                else {
                    $dest = $target + '/' + $leaf
                    if ($dest -eq $base) { $skipped += (New-FxSkips -Id $id -Reason 'no-change') }
                    else { $null = Set-FxMember -Object $entry -Name 'path' -Value $dest; $changed = $true }
                }
            }
        } elseif ($op -eq 'tag') {
            if ([bool](Get-FxBool (Get-FxMember $entry 'trashed'))) { $skipped += (New-FxSkips -Id $id -Reason 'trashed') }
            elseif (Test-FxStringArrayEqual (Get-FxMember $entry 'tags') $tags) { $skipped += (New-FxSkips -Id $id -Reason 'no-change') }
            else { $null = Set-FxMember -Object $entry -Name 'tags' -Value $tags; $changed = $true }
        } elseif ($op -eq 'pin') {
            if ([bool](Get-FxBool (Get-FxMember $entry 'trashed'))) { $skipped += (New-FxSkips -Id $id -Reason 'trashed') }
            elseif ([bool](Get-FxBool (Get-FxMember $entry 'pinned')) -eq $pin) { $skipped += (New-FxSkips -Id $id -Reason 'no-change') }
            else { $null = Set-FxMember -Object $entry -Name 'pinned' -Value $pin; $changed = $true }
        }
        if ($changed) { $applied += $id }
    }
    $result.code = 200
    $result.applied = $applied
    $result.skipped = $skipped
    $result.reason = 'ok'
    return $result
}

# --- upload queue (§1.6) ---------------------------------------------------

function ConvertTo-FxUploadJob {
    # One shape for a queue row, whatever the JSON on disk looked like, so the
    # worker can transition state without depending on PSCustomObject semantics.
    param($Value)
    $phase = $null
    if ($null -ne (Get-FxMember $Value 'phase')) { $phase = Get-FxEnumMember (Get-FxMember $Value 'phase') $script:FxUploadPhases 'parse' }
    return [ordered]@{
        uploadJobId = (Get-FxTextOr (Get-FxMember $Value 'uploadJobId') '')
        id = (Get-FxTextOr (Get-FxMember $Value 'id') '')
        host = (Get-FxEnumMember (Get-FxMember $Value 'host') @('gofile') 'gofile')
        state = (Get-FxEnumMember (Get-FxMember $Value 'state') @('queued', 'uploading', 'success', 'failed', 'canceled') 'queued')
        phase = $phase
        attempts = [int](Get-FxNumberOrZero (Get-FxMember $Value 'attempts'))
        bytesSent = (Get-FxNumberOrZero (Get-FxMember $Value 'bytesSent'))
        size = (Get-FxNumberOrZero (Get-FxMember $Value 'size'))
        path = (Get-FxTextOr (Get-FxMember $Value 'path') '')
        root = (Get-FxTextOr (Get-FxMember $Value 'root') 'Temp')
        createdAt = (Get-FxTextOr (Get-FxMember $Value 'createdAt') '')
        updatedAt = (Get-FxTextOr (Get-FxMember $Value 'updatedAt') '')
        lastError = (Get-FxMember $Value 'lastError')
        nextAttemptMs = (Get-FxNumberOrNull (Get-FxMember $Value 'nextAttemptMs'))
        retryAt = (Get-FxStringOrNull (Get-FxMember $Value 'retryAt'))
    }
}

function Get-FxUploadQueue {
    param([string]$Path = '')
    if (-not $Path) { $Path = $script:FxQueuePath }
    $doc = Read-FxJson -Path $Path
    $jobs = @()
    $seq = 0
    $updatedAt = ''
    if ($doc.ok -and $null -ne $doc.value) {
        foreach ($j in @(Get-FxRows $doc.value 'jobs')) { $jobs += (ConvertTo-FxUploadJob -Value $j) }
        $seq = [int](Get-FxNumberOrZero (Get-FxMember $doc.value 'seq'))
        $t = Get-FxStringOrNull (Get-FxMember $doc.value 'updatedAt')
        if ($t) { $updatedAt = $t }
    }
    return [ordered]@{ schemaVersion = $script:FxQueueSchemaVersion; updatedAt = $updatedAt; seq = $seq; jobs = $jobs; path = $Path; parseError = $(if ($doc.reason -eq 'parse') { $doc.detail } else { '' }) }
}

function Add-FxUploadJobs {
    # POST /api/fx/upload -> 202 { jobs: [{ id, uploadJobId }] }. The queue is
    # persisted to %TEMP%\ghrdp\fx-upload-queue.json with a temp file + rename.
    # The host parameter is NOT named $Host: that is a read-only automatic
    # variable, and binding it throws on Windows PowerShell 5.1.
    param($Index, [string[]]$Ids, [string]$HostId = 'gofile', [string]$Path = '', [string]$Now = '')
    if (-not $Path) { $Path = $script:FxQueuePath }
    if (-not $Now) { $Now = (Get-FxNowIso) }
    $out = [ordered]@{ code = 400; jobs = @(); skipped = @(); message = ''; queuePath = $Path }
    if ($HostId -ne 'gofile') { $out.message = ('unknown upload host: ' + [string]$HostId); return $out }
    $ids = @(Get-FxUniqueStrings $Ids)
    if ($ids.Count -eq 0) { $out.message = 'upload requires at least one id'; return $out }
    if ($null -eq $Index) { $out.message = 'index unavailable'; return $out }
    $queue = Get-FxUploadQueue -Path $Path
    if ($queue.parseError) { $out.code = 500; $out.message = ('queue unreadable: ' + [string]$queue.parseError); return $out }
    $jobs = @($queue.jobs)
    $seq = [int]$queue.seq
    $accepted = @()
    $skipped = @()
    foreach ($id in $ids) {
        $entry = Select-FxFileEntry -Index $Index -Id $id
        if ($null -eq $entry) { $skipped += (New-FxSkips -Id $id -Reason 'unknown-id'); continue }
        if ([bool](Get-FxBool (Get-FxMember $entry 'trashed'))) { $skipped += (New-FxSkips -Id $id -Reason 'trashed'); continue }
        $gofile = Get-FxMember $entry 'gofile'
        if ((Get-FxEnumMember (Get-FxMember $gofile 'status') $script:FxGofileStatuses 'none') -eq 'uploaded') { $skipped += (New-FxSkips -Id $id -Reason 'already-uploaded'); continue }
        $existing = $null
        foreach ($j in $jobs) {
            if ((Get-FxTextOr (Get-FxMember $j 'id') '') -ceq $id -and (@('queued', 'uploading') -contains (Get-FxEnumMember (Get-FxMember $j 'state') @('queued', 'uploading') ''))) { $existing = $j; break }
        }
        if ($null -ne $existing) {
            # Idempotent: the same id never gets two live jobs (§5.1 rule 6).
            $accepted += [ordered]@{ id = $id; uploadJobId = (Get-FxTextOr (Get-FxMember $existing 'uploadJobId') '') }
            continue
        }
        $seq = $seq + 1
        $jobId = 'fxj-' + $seq.ToString('000000') + '-' + (Get-FxSha256Hex ($id + '|' + $Now)).Substring(0, 8)
        $jobs += [ordered]@{
            uploadJobId = $jobId
            id = $id
            host = 'gofile'
            state = 'queued'
            phase = $null
            attempts = 0
            bytesSent = 0
            size = (Get-FxNumberOrZero (Get-FxMember $entry 'size'))
            path = (Get-FxTextOr (Get-FxMember $entry 'path') '')
            root = (Get-FxTextOr (Get-FxMember $entry 'root') 'Temp')
            createdAt = $Now
            updatedAt = $Now
            lastError = $null
        }
        $accepted += [ordered]@{ id = $id; uploadJobId = $jobId }
    }
    $null = Set-FxMember -Object $queue -Name 'jobs' -Value $jobs
    $null = Set-FxMember -Object $queue -Name 'seq' -Value $seq
    $null = Set-FxMember -Object $queue -Name 'updatedAt' -Value $Now
    if ($accepted.Count -gt 0) {
        if (-not (Save-FxJsonAtomic -Path $Path -Object $queue)) {
            $out.code = 500
            $out.message = 'queue write failed'
            return $out
        }
    }
    $out.code = 202
    $out.jobs = $accepted
    $out.skipped = $skipped
    $out.message = 'queued'
    return $out
}

function Set-FxUploadQueue {
    param($Queue, [string]$Path = '')
    if (-not $Path) { $Path = $script:FxQueuePath }
    $doc = [ordered]@{
        schemaVersion = $script:FxQueueSchemaVersion
        updatedAt = (Get-FxNowIso)
        seq = [int](Get-FxNumberOrZero (Get-FxMember $Queue 'seq'))
        jobs = @(Get-FxRows $Queue 'jobs')
    }
    return (Save-FxJsonAtomic -Path $Path -Object $doc)
}

function Test-FxPhaseRetryable {
    # §8.2/§5.2: 401/403/413/415 fail fast; a transient phase retries.
    param([string]$Phase, $HttpStatus)
    if ($null -ne $HttpStatus) {
        foreach ($code in $script:FxFailFastStatus) { if ([int]$HttpStatus -eq [int]$code) { return $false } }
    }
    return ($script:FxTransientPhases -contains [string]$Phase)
}

function Get-FxJobMaxAttempts {
    param([string]$Phase, $HttpStatus)
    if (Test-FxPhaseRetryable -Phase $Phase -HttpStatus $HttpStatus) { return $script:FxMaxAttempts }
    return 1
}

function Get-FxBackoffMs {
    param([int]$Attempt = 1, $RetryAfterMs = $null)
    if ($null -ne $RetryAfterMs -and [double]$RetryAfterMs -gt 0) {
        $clamped = [double]$RetryAfterMs
        if ($clamped -gt 120000) { $clamped = 120000 }
        return [int]$clamped
    }
    $d = [double]$script:FxBackoffBaseMs * [math]::Pow(2, [math]::Max(0, $Attempt - 1))
    if ($d -gt $script:FxBackoffCapMs) { $d = $script:FxBackoffCapMs }
    if ($d -lt 100) { $d = 100 }
    return [int]$d
}

function Step-FxUploadQueue {
    # ONE bounded worker pass over the queue. The state machine is §8: a job is
    # queued -> uploading -> success, or -> failed with the F44 phase plus the
    # COMPLETE host message. Transient phases retry (bounded attempts); a
    # fail-fast status is terminal at the first attempt. Every transition is
    # persisted before the next HTTP call, so a crash can never lose the state.
    param([string]$Path = '', [string]$IndexPath = '', [scriptblock]$Uploader = $null, $Index = $null)
    if (-not $Path) { $Path = $script:FxQueuePath }
    if (-not $IndexPath) { $IndexPath = $script:FxIndexPath }
    $summary = [ordered]@{ processed = 0; succeeded = 0; failed = 0; queued = 0; skipped = 0; ticks = 0 }
    $queue = Get-FxUploadQueue -Path $Path
    if ($queue.parseError) {
        $null = Write-FxLog ('upload queue unreadable, refusing to process: ' + [string]$queue.parseError)
        return $summary
    }
    $jobs = @($queue.jobs)
    if ($jobs.Count -eq 0) { return $summary }
    $ownIndex = $false
    if ($null -eq $Index) {
        $doc = Get-FxIndexDoc -ReadPath $IndexPath -MirrorPath ''
        if (-not $doc.ok) {
            $null = Write-FxLog ('index unreadable, upload pass aborted: ' + [string]$doc.reason)
            return $summary
        }
        $Index = $doc.index
        $ownIndex = $true
    }
    $doUpload = $Uploader
    if (-not $doUpload) { $doUpload = $script:FxUploader }
    $touched = $false
    $changedIndex = $false
    foreach ($job in $jobs) {
        $state = Get-FxEnumMember (Get-FxMember $job 'state') @('queued', 'uploading', 'success', 'failed', 'canceled') 'queued'
        if ($state -ne 'queued' -and $state -ne 'uploading') { continue }
        # A retry is not attempted before the backoff it was given: the tick is
        # 15s and the cap is 8s, but a job that failed a moment ago still waits
        # its own delay instead of riding the next tick.
        if ($state -eq 'queued') {
            $retryAt = Get-FxStringOrNull (Get-FxMember $job 'retryAt')
            if ($retryAt) {
                $when = [datetime]::MinValue
                $okParse = [datetime]::TryParse($retryAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$when)
                if ($okParse -and (Get-FxClock) -lt $when.ToUniversalTime()) { $summary.skipped = [int]$summary.skipped + 1; continue }
            }
        }
        $summary.processed = [int]$summary.processed + 1
        $id = Get-FxTextOr (Get-FxMember $job 'id') ''
        $entry = Select-FxFileEntry -Index $Index -Id $id
        if ($null -eq $entry) {
            $null = Set-FxMember -Object $job -Name 'state' -Value 'failed'
            $null = Set-FxMember -Object $job -Name 'phase' -Value 'parse'
            $null = Set-FxMember -Object $job -Name 'lastError' -Value 'unknown-id'
            $null = Set-FxMember -Object $job -Name 'updatedAt' -Value (Get-FxNowIso)
            $touched = $true
            $summary.failed = [int]$summary.failed + 1
            continue
        }
        $resolved = Resolve-FxLocalPath -RootName (Get-FxTextOr (Get-FxMember $entry 'root') 'Temp') -Path (Get-FxTextOr (Get-FxMember $entry 'path') '')
        if (-not $resolved.ok -or -not (Test-Path -LiteralPath $resolved.fullPath -PathType Leaf)) {
            $null = Set-FxMember -Object $job -Name 'state' -Value 'failed'
            $null = Set-FxMember -Object $job -Name 'phase' -Value 'type'
            $null = Set-FxMember -Object $job -Name 'lastError' -Value ('source file unavailable (' + [string]$resolved.reason + ')')
            $null = Set-FxMember -Object $job -Name 'updatedAt' -Value (Get-FxNowIso)
            $touched = $true
            $summary.failed = [int]$summary.failed + 1
            continue
        }
        $null = Set-FxMember -Object $job -Name 'state' -Value 'uploading'
        $null = Set-FxMember -Object $job -Name 'updatedAt' -Value (Get-FxNowIso)
        $attempt = [int](Get-FxNumberOrZero (Get-FxMember $job 'attempts')) + 1
        $null = Set-FxMember -Object $job -Name 'attempts' -Value $attempt
        $touched = $true
        $attemptResult = $null
        try {
            $attemptResult = & $doUpload $job $resolved.fullPath
        } catch {
            $attemptResult = [ordered]@{ ok = $false; phase = 'parse'; status = $null; message = (Protect-FxText ([string]$_.Exception.Message)) }
        }
        if ($null -eq $attemptResult) { $attemptResult = [ordered]@{ ok = $false; phase = 'parse'; status = $null; message = 'uploader returned no result' } }
        $ok = [bool](Get-FxMember $attemptResult 'ok')
        $phase = Get-FxEnumMember (Get-FxMember $attemptResult 'phase') $script:FxUploadPhases 'parse'
        $status = Get-FxNumberOrNull (Get-FxMember $attemptResult 'status')
        $message = Get-FxTextOr (Get-FxMember $attemptResult 'message') ''
        if ($ok) {
            $null = Set-FxMember -Object $job -Name 'state' -Value 'success'
            $null = Set-FxMember -Object $job -Name 'phase' -Value $null
            $null = Set-FxMember -Object $job -Name 'lastError' -Value $null
            $null = Set-FxMember -Object $job -Name 'bytesSent' -Value (Get-FxNumberOrZero (Get-FxMember $job 'size'))
            $null = Set-FxMember -Object $job -Name 'retryAt' -Value $null
            $null = Set-FxMember -Object $job -Name 'updatedAt' -Value (Get-FxNowIso)
            $fileId = Get-FxStringOrNull (Get-FxMember $attemptResult 'fileId')
            $code = Get-FxStringOrNull (Get-FxMember $attemptResult 'code')
            $direct = Get-FxStringOrNull (Get-FxMember $attemptResult 'directUrl')
            try {
                $null = Set-FxMember -Object $entry -Name 'upload' -Value (ConvertTo-FxUploadState -Value @{ phase = $null; status = 'success'; retries = ($attempt - 1); lastError = $null; bytesSent = (Get-FxMember $job 'bytesSent') })
                $null = Set-FxMember -Object $entry -Name 'gofile' -Value (ConvertTo-FxGofileState -Value @{ code = $code; fileId = $fileId; directUrl = (Get-FxSafeDirectUrl $direct); status = 'uploaded'; uploadedAt = (Get-FxNowIso); expiryTs = $null; downloads = 0; remoteSize = (Get-FxMember $job 'size') })
                $changedIndex = $true
            } catch { }
            $summary.succeeded = [int]$summary.succeeded + 1
            $null = Write-FxLog ('upload job ' + $id + ' succeeded via ' + [string]$phase)
        } else {
            $retryable = Test-FxPhaseRetryable -Phase $phase -HttpStatus $status
            $max = Get-FxJobMaxAttempts -Phase $phase -HttpStatus $status
            # F44: the host message is stored COMPLETE (no truncation, no
            # substring) but never raw - a host that echoes the credential in an
            # error page must not have it written into the queue, the index or a
            # log line. This is the only transformation applied to it.
            $safeMessage = Protect-FxText -Text $message -Secrets @([string]$script:FxGofileToken)
            $lastError = [ordered]@{ phase = $phase; hostMessage = $safeMessage }
            if ($null -ne $status) { $lastError['httpStatus'] = [int]$status }
            $lastError['at'] = (Get-FxNowIso)
            $null = Set-FxMember -Object $job -Name 'phase' -Value $phase
            # The queue row and the index entry carry the SAME structured
            # lastError (phase + optional httpStatus + the complete, already
            # redacted host message + the attempt stamp), so the F44 shape the
            # client reads is a property of the state, not of where it landed.
            $null = Set-FxMember -Object $job -Name 'lastError' -Value $lastError
            $null = Set-FxMember -Object $job -Name 'updatedAt' -Value (Get-FxNowIso)
            $nextState = 'failed'
            if ($retryable -and $attempt -lt $max) {
                $nextState = 'queued'
                $delayMs = Get-FxBackoffMs -Attempt $attempt
                $null = Set-FxMember -Object $job -Name 'nextAttemptMs' -Value $delayMs
                $null = Set-FxMember -Object $job -Name 'retryAt' -Value ((Get-FxClock).AddMilliseconds([double]$delayMs).ToString('o'))
                $summary.queued = [int]$summary.queued + 1
            } else {
                $null = Set-FxMember -Object $job -Name 'retryAt' -Value $null
                $summary.failed = [int]$summary.failed + 1
            }
            $null = Set-FxMember -Object $job -Name 'state' -Value $nextState
            try {
                $null = Set-FxMember -Object $entry -Name 'upload' -Value (ConvertTo-FxUploadState -Value @{ phase = $phase; status = $nextState; retries = ($attempt - 1); lastError = $lastError; bytesSent = 0 })
                $changedIndex = $true
            } catch { }
            # F44: the COMPLETE host message reaches the UI; the log copy is the
            # same text with credentials redacted by Write-FxLog, never cut.
            $null = Write-FxLog ('upload job ' + $id + ' ' + $nextState + ' phase=' + $phase + ' status=' + [string]$status + ' message=' + $safeMessage)
        }
    }
    if ($touched) {
        $null = Set-FxUploadQueue -Queue $queue -Path $Path
    }
    if ($ownIndex -and $changedIndex) {
        $null = Set-FxIndexDoc -Index $Index -Path $IndexPath
    }
    $summary.ticks = 1
    $script:FxQueueTicks = [int]$script:FxQueueTicks + 1
    return $summary
}

# --- gofile transport (§1.3 / §1.4 proxy) ---------------------------------

function Invoke-FxHttpRequest {
    # One seam for every outbound call: a scriptblock fetcher is injected by the
    # tests (no live host), and the default uses HttpClient. Result phases are
    # §5.2 shapes: 502 = a status line arrived (http), 504 = no response in time
    # (tcp), dns = the connection never established.
    param([string]$Url, [string]$Method = 'GET', $Headers = $null, [byte[]]$Body = $null, [string]$ContentType = '', [int]$TimeoutSec = 30, [scriptblock]$Fetcher = $null)
    $request = [ordered]@{ url = $Url; method = $Method; headers = $(if ($Headers) { $Headers } else { @{} }); body = $Body; contentType = $ContentType; timeoutSec = $TimeoutSec }
    $use = $Fetcher
    if (-not $use) { $use = $script:FxFetcher }
    $result = [ordered]@{ ok = $false; status = 0; text = ''; phase = 'dns'; message = ''; bytes = $null; contentRange = '' }
    if ($use) {
        try {
            $r = & $use $request
            if ($null -eq $r) { $result.message = 'fetcher returned nothing'; return $result }
            $result.ok = [bool](Get-FxMember $r 'ok')
            $result.status = [int](Get-FxNumberOrZero (Get-FxMember $r 'status'))
            $result.text = (Get-FxTextOr (Get-FxMember $r 'text') '')
            $result.phase = Get-FxEnumMember (Get-FxMember $r 'phase') $script:FxUploadPhases 'http'
            $result.message = Protect-FxText (Get-FxTextOr (Get-FxMember $r 'message') '')
            $result.bytes = Get-FxMember $r 'bytes'
            $result.contentRange = Get-FxTextOr (Get-FxMember $r 'contentRange') ''
            return $result
        } catch {
            $result.phase = 'dns'
            $result.message = Protect-FxText ([string]$_.Exception.Message)
            return $result
        }
    }
    if (-not $script:FxHttpClientReady) {
        $result.phase = 'dns'
        $result.message = 'the HTTP client type is unavailable on this host'
        return $result
    }
    try {
        $handler = New-Object System.Net.Http.HttpClientHandler
        $client = New-Object System.Net.Http.HttpClient($handler)
        try {
            $client.Timeout = [System.TimeSpan]::FromSeconds($TimeoutSec)
            $methodObj = New-Object System.Net.Http.HttpMethod($Method)
            $msg = New-Object System.Net.Http.HttpRequestMessage($methodObj, $Url)
            if ($Headers) {
                foreach ($k in @($Headers.Keys)) { $null = $msg.Headers.TryAddWithoutValidation([string]$k, [string]$Headers[$k]) }
            }
            if ($null -ne $Body) {
                $content = New-Object System.Net.Http.ByteArrayContent($Body)
                if ($ContentType) { $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType) }
                $msg.Content = $content
            }
            $resp = $client.SendAsync($msg).GetAwaiter().GetResult()
            $result.status = [int]$resp.StatusCode
            $result.bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            if ($result.bytes -and $result.bytes.Length -le 1048576) { $result.text = [System.Text.Encoding]::UTF8.GetString($result.bytes) }
            $cr = $resp.Content.Headers.ContentRange
            if ($cr -and $cr.ToString()) { $result.contentRange = [string]$cr.ToString() }
            $result.ok = ($result.status -ge 200 -and $result.status -lt 300)
            $result.phase = 'http'
            return $result
        } finally { $client.Dispose() }
    } catch [System.Threading.Tasks.TaskCanceledException] {
        $result.phase = 'tcp'
        $result.message = 'host transport timed out'
        return $result
    } catch [System.OperationCanceledException] {
        $result.phase = 'tcp'
        $result.message = 'host transport timed out'
        return $result
    } catch {
        $result.phase = 'dns'
        $result.message = Protect-FxText ([string]$_.Exception.Message)
        return $result
    }
}

function Get-FxGofileStatusResponse {
    # GET /api/fx/gofile/status?id=... The stored state is the answer; when a
    # token is configured the host is polled for a fresher one, and a host
    # failure is reported as 502 (status line) / 504 (transport), never as a
    # silently stale "success".
    param($Index, [string]$Id, [string]$Token = '', [string]$Base = '', [scriptblock]$Fetcher = $null)
    $out = [ordered]@{ code = 404; json = $null; phase = $null; message = '' }
    $entry = Select-FxFileEntry -Index $Index -Id $Id
    if ($null -eq $entry) { $out.message = 'unknown id'; return $out }
    $state = Get-FxMember $entry 'gofile'
    $out.code = 200
    $out.json = $state
    if (-not $Token) { return $out }
    $code = Get-FxStringOrNull (Get-FxMember $state 'code')
    if (-not $code) { return $out }
    if (-not $Base) { $Base = $script:FxGofileBase }
    $url = $Base + '/contents/' + [uri]::EscapeDataString($code) + '?token=' + [uri]::EscapeDataString($Token)
    # never log the request URL: it carries the host token in the query.
    $resp = Invoke-FxHttpRequest -Url $url -Method 'GET' -TimeoutSec 20 -Fetcher $Fetcher
    if ($resp.phase -eq 'tcp') { $out.code = 504; $out.json = $state; $out.phase = 'tcp'; $out.message = Protect-FxText -Text 'host transport timed out' -Secrets @($Token); return $out }
    if ($resp.phase -eq 'dns') { $out.code = 502; $out.json = $state; $out.phase = 'dns'; $out.message = Protect-FxText -Text 'host unreachable' -Secrets @($Token); return $out }
    if (-not $resp.ok) {
        $out.code = 502
        $out.json = $state
        $out.phase = 'http'
        # The host text is redacted with THIS request's token before it can
        # become a body or a log line: a host that echoes the credential in an
        # error page must not be able to publish it back to the operator.
        $out.message = Protect-FxText -Text ('host returned ' + [string]$resp.status) -Secrets @($Token)
        return $out
    }
    try {
        $parsed = ($resp.text | ConvertFrom-Json)
        $data = Get-FxMember $parsed 'data'
        if ($null -eq $data) { $data = $parsed }
        $fresh = Get-FxMember $data 'status'
        if ($fresh -is [string]) {
            $mapped = Get-FxEnumMember ([string]$fresh).ToLower() @('uploaded', 'processing', 'expired', 'failed', 'none') 'processing'
            $null = Set-FxMember -Object $state -Name 'status' -Value $mapped
            $downloads = Get-FxNumberOrNull (Get-FxMember $data 'downloadCount')
            if ($null -ne $downloads) { $null = Set-FxMember -Object $state -Name 'downloads' -Value ([int]$downloads) }
            $size = Get-FxNumberOrNull (Get-FxMember $data 'size')
            if ($null -ne $size) { $null = Set-FxMember -Object $state -Name 'remoteSize' -Value $size }
        }
    } catch {
        $out.code = 502
        $out.json = $state
        $out.phase = 'parse'
        $out.message = 'host reply was not JSON'
        return $out
    }
    $out.json = $state
    return $out
}

function New-FxMultipartBody {
    # Multipart/form-data encoder for the gofile upload endpoint. Pure bytes in,
    # bytes out: the state machine can be driven in CI with no host access.
    param([string]$Boundary, [string]$FieldName, [string]$FileName, [byte[]]$FileBytes, [string]$MimeType = 'application/octet-stream')
    if (-not $Boundary) { $Boundary = '----fx' + [guid]::NewGuid().ToString('N') }
    $prefix = "--$Boundary`r`nContent-Disposition: form-data; name=`"$FieldName`"; filename=`"$FileName`"`r`nContent-Type: $MimeType`r`n`r`n"
    $suffix = "`r`n--$Boundary--`r`n"
    $prefixBytes = [System.Text.Encoding]::UTF8.GetBytes($prefix)
    $suffixBytes = [System.Text.Encoding]::UTF8.GetBytes($suffix)
    $fileLen = 0
    if ($null -ne $FileBytes) { $fileLen = [int]$FileBytes.Length }
    $out = [byte[]]::new($prefixBytes.Length + $fileLen + $suffixBytes.Length)
    [System.Array]::Copy($prefixBytes, 0, $out, 0, $prefixBytes.Length)
    if ($fileLen -gt 0) { [System.Array]::Copy($FileBytes, 0, $out, $prefixBytes.Length, $fileLen) }
    [System.Array]::Copy($suffixBytes, 0, $out, $prefixBytes.Length + $fileLen, $suffixBytes.Length)
    return [ordered]@{ boundary = $Boundary; contentType = ('multipart/form-data; boundary=' + $Boundary); bytes = $out }
}

function Invoke-FxGofileUpload {
    # Default uploader for the queue worker. Fail closed: with no token
    # configured the job fails in the `auth` phase rather than pretending to
    # upload. The complete host message is preserved (F44).
    param($Job, [string]$FullPath, [string]$Token = '', [string]$Base = '', [scriptblock]$Fetcher = $null)
    if (-not $Token) { $Token = [string]$script:FxGofileToken }
    if (-not $Token) { return [ordered]@{ ok = $false; phase = 'auth'; status = $null; message = 'gofile token is not configured on the runner' } }
    if (-not $Base) { $Base = $script:FxGofileBase }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($FullPath)
    } catch {
        return [ordered]@{ ok = $false; phase = 'type'; status = $null; message = ('source unreadable: ' + (Protect-FxText ([string]$_.Exception.Message))) }
    }
    $fileName = [System.IO.Path]::GetFileName($FullPath)
    $form = New-FxMultipartBody -Boundary '' -FieldName 'file' -FileName $fileName -FileBytes $bytes
    $headers = @{ Authorization = 'Bearer ' + $Token }
    $url = $Base + '/uploadFile'
    $resp = Invoke-FxHttpRequest -Url $url -Method 'POST' -Headers $headers -Body $form.bytes -ContentType $form.contentType -TimeoutSec 300 -Fetcher $Fetcher
    if (-not $resp.ok) {
        $phase = $resp.phase
        if ($phase -eq 'http' -and $resp.status -eq 0) { $phase = 'dns' }
        return [ordered]@{ ok = $false; phase = $phase; status = $(if ($resp.status -gt 0) { $resp.status } else { $null }); message = $(if ($resp.message) { $resp.message } else { Protect-FxText $resp.text }) }
    }
    try {
        $parsed = ($resp.text | ConvertFrom-Json)
        $data = Get-FxMember $parsed 'data'
        if ($null -eq $data) { $data = $parsed }
        $fileId = Get-FxStringOrNull (Get-FxMember $data 'id')
        $parent = Get-FxMember $data 'parentFolder'
        $code = $null
        if ($parent -is [string]) { $code = [string]$parent }
        $download = Get-FxStringOrNull (Get-FxMember $data 'downloadPage')
        if (-not $download) { $download = Get-FxStringOrNull (Get-FxMember $data 'directLink') }
        return [ordered]@{ ok = $true; phase = 'http'; status = $resp.status; fileId = $fileId; code = $code; directUrl = (Get-FxSafeDirectUrl $download); message = '' }
    } catch {
        return [ordered]@{ ok = $false; phase = 'parse'; status = $resp.status; message = 'host reply was not JSON' }
    }
}

# --- path resolution + preview (§1.4) -------------------------------------

function Resolve-FxLocalPath {
    # Every Explorer path is a POSIX path under a known root. Resolution refuses
    # traversal outright and then re-checks the realpath prefix, so a symlink or
    # an encoded separator cannot walk out of the root tree.
    param([string]$RootName, [string]$Path, $RootMap = $null)
    $out = [ordered]@{ ok = $false; fullPath = ''; reason = 'unknown-root'; basePath = '' }
    if (-not $RootMap) { $RootMap = $script:FxRootsMap }
    if ($script:FxRoots -notcontains $RootName) { return $out }
    $rel = [string]$Path
    if (-not $rel -or -not $rel.StartsWith('/')) { $out.reason = 'not-absolute'; return $out }
    $rel = $rel.Substring(1).Replace('/', '\')
    if (-not $rel) { $out.reason = 'empty-path'; return $out }
    foreach ($seg in $rel.Split('\')) {
        if ($seg -eq '..' -or $seg -eq '.') { $out.reason = 'unsafe-segment'; return $out }
        if ($seg.IndexOfAny([char[]]@(':', '*', '?', '"', '<', '>', '|')) -ge 0) { $out.reason = 'unsafe-segment'; return $out }
    }
    $base = [string](Get-FxMember $RootMap $RootName)
    if (-not $base) { $out.reason = 'no-root-map'; return $out }
    $out.basePath = $base
    try {
        $baseFull = [System.IO.Path]::GetFullPath($base)
        if (-not $baseFull.EndsWith([string][System.IO.Path]::DirectorySeparatorChar)) { $baseFull = $baseFull + [System.IO.Path]::DirectorySeparatorChar }
        $full = [System.IO.Path]::GetFullPath((Join-Path $base $rel))
    } catch {
        $out.reason = 'bad-path'
        return $out
    }
    if (-not $full.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) { $out.reason = 'escape'; return $out }
    $out.fullPath = $full
    $out.ok = $true
    $out.reason = 'ok'
    return $out
}

function Get-FxContentRange {
    # One range, one answer: `bytes=a-b`, `bytes=a-`, `bytes=-n`. Anything else
    # (multi-range, malformed, start beyond EOF) is unsatisfiable -> 416 with
    # `Content-Range: bytes */total`.
    param([string]$RangeHeader, [int64]$TotalLength)
    $out = [ordered]@{ ok = $false; unsatisfiable = $false; start = [int64]0; end = [int64]0; length = [int64]0; header = '' }
    if ($TotalLength -lt 0) { $TotalLength = 0 }
    if (-not $RangeHeader -or -not $RangeHeader.Trim()) {
        $out.ok = $true
        $out.start = 0
        $out.end = $TotalLength - 1
        $out.length = $TotalLength
        return $out
    }
    $raw = $RangeHeader.Trim()
    $m = [regex]::Match($raw, '^bytes=(\d*)-(\d*)$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $m.Success) { $out.unsatisfiable = $true; $out.header = 'bytes */' + $TotalLength; return $out }
    $startText = $m.Groups[1].Value
    $endText = $m.Groups[2].Value
    $start = [int64]0
    $end = [int64]0
    if (-not $startText -and -not $endText) { $out.unsatisfiable = $true; $out.header = 'bytes */' + $TotalLength; return $out }
    if (-not $startText) {
        $suffix = [int64]$endText
        if ($suffix -le 0) { $out.unsatisfiable = $true; $out.header = 'bytes */' + $TotalLength; return $out }
        if ($suffix -gt $TotalLength) { $suffix = $TotalLength }
        $start = $TotalLength - $suffix
        $end = $TotalLength - 1
    } else {
        $start = [int64]$startText
        if (-not $endText) { $end = $TotalLength - 1 } else { $end = [int64]$endText }
    }
    if ($TotalLength -le 0 -or $start -ge $TotalLength -or $start -gt $end) { $out.unsatisfiable = $true; $out.header = 'bytes */' + $TotalLength; return $out }
    if ($end -gt $TotalLength - 1) { $end = $TotalLength - 1 }
    $out.ok = $true
    $out.start = $start
    $out.end = $end
    $out.length = ($end - $start) + 1
    $out.header = 'bytes ' + $start + '-' + $end + '/' + $TotalLength
    return $out
}

function Get-FxMimeVerdict {
    # 415 for a type the Explorer cannot render inline (and for a missing one:
    # application/octet-stream IS in the map, so a missing mime is a refusal).
    param($Entry)
    $mime = (Get-FxTextOr (Get-FxMember $Entry 'mime') '').ToLower()
    if (-not $mime) { return $false }
    return ($script:FxPreviewMimeAllow -contains $mime)
}

function Get-FxPreviewResponse {
    # GET /api/fx/preview?id=&Range:
    #   200/206 local file stream, 404 unknown id, 413 too large, 415 wrong
    #   type, 416 unsatisfiable range, 502/504 when the hosted copy must be
    #   proxied and the host refuses or times out.
    param($Index, [string]$Id, [string]$RangeHeader = '', [int64]$MaxBytes = 0, [scriptblock]$Fetcher = $null, [string]$Token = '')
    $out = [ordered]@{ code = 404; ctype = 'application/json; charset=utf-8'; headers = @(); body = $null; file = $null; phase = $null; message = '' }
    if (-not $MaxBytes) { $MaxBytes = $script:FxPreviewMaxBytes }
    $entry = Select-FxFileEntry -Index $Index -Id $Id
    if ($null -eq $entry) { $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'parse'; error = 'unknown id' })); $out.message = 'unknown id'; return $out }
    $size = [int64](Get-FxNumberOrZero (Get-FxMember $entry 'size'))
    if ($MaxBytes -gt 0 -and $size -gt $MaxBytes) {
        $out.code = 413
        $out.phase = 'size'
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'size'; error = ('file exceeds the ' + $MaxBytes + ' byte preview ceiling'); size = $size }))
        return $out
    }
    if (-not (Get-FxMimeVerdict -Entry $entry)) {
        $out.code = 415
        $out.phase = 'type'
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'type'; error = ('preview refuses ' + (Get-FxTextOr (Get-FxMember $entry 'mime') 'unknown') + ' inline') }))
        return $out
    }
    $resolved = Resolve-FxLocalPath -RootName (Get-FxTextOr (Get-FxMember $entry 'root') 'Temp') -Path (Get-FxTextOr (Get-FxMember $entry 'path') '')
    if ($resolved.ok -and (Test-Path -LiteralPath $resolved.fullPath -PathType Leaf)) {
        $total = [int64](New-Object -TypeName System.IO.FileInfo -ArgumentList $resolved.fullPath).Length
        $range = Get-FxContentRange -RangeHeader $RangeHeader -TotalLength $total
        $mime = (Get-FxTextOr (Get-FxMember $entry 'mime') 'application/octet-stream')
        $out.headers = @('Accept-Ranges: bytes', 'X-Content-Type-Options: nosniff', 'Content-Security-Policy: sandbox; default-src ''none''', 'Cross-Origin-Resource-Policy: same-site')
        $out.ctype = $mime
        if (-not $range.ok) {
            $out.code = 416
            $out.phase = 'parse'
            $out.headers = @('Accept-Ranges: bytes', 'Content-Range: ' + $range.header)
            $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'parse'; error = 'range not satisfiable' }))
            return $out
        }
        if ($RangeHeader -and $RangeHeader.Trim()) {
            # A satisfied Range request is answered 206 even when it happens to
            # cover the whole file: media elements use `bytes=0-` to probe for
            # seek support, and a 200 there reads as "not seekable".
            $out.code = 206
            $out.headers = @('Accept-Ranges: bytes', 'Content-Range: ' + $range.header, 'X-Content-Type-Options: nosniff', 'Content-Security-Policy: sandbox; default-src ''none''', 'Cross-Origin-Resource-Policy: same-site')
        } else {
            $out.code = 200
        }
        $out.file = [ordered]@{ path = $resolved.fullPath; offset = $range.start; length = $range.length; total = $total }
        return $out
    }
    # Not on this host: proxy the hosted copy, but ONLY to the configured host.
    $gofile = Get-FxMember $entry 'gofile'
    $direct = Get-FxStringOrNull (Get-FxMember $gofile 'directUrl')
    if (-not (Test-FxProxyAllowedUrl -Url $direct)) {
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'parse'; error = 'not available locally and no proxyable hosted copy' }))
        $out.message = 'no proxyable copy'
        return $out
    }
    $headersToHost = @{}
    if ($RangeHeader -and $RangeHeader.Trim()) { $headersToHost['Range'] = $RangeHeader.Trim() }
    $resp = Invoke-FxHttpRequest -Url $direct -Method 'GET' -Headers $headersToHost -TimeoutSec 60 -Fetcher $Fetcher
    if ($resp.phase -eq 'tcp') { $out.code = 504; $out.phase = 'tcp'; $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'tcp'; error = 'host transport timed out' })); return $out }
    if ($resp.phase -eq 'dns') { $out.code = 502; $out.phase = 'dns'; $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'dns'; error = 'host unreachable' })); return $out }
    if (-not $resp.ok -and $resp.status -ne 206) {
        $out.code = 502
        $out.phase = 'http'
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'http'; error = ('host returned ' + [string]$resp.status) }))
        return $out
    }
    if ($null -eq $resp.bytes) {
        $out.code = 502
        $out.phase = 'parse'
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = 'parse'; error = 'host reply carried no body' }))
        return $out
    }
    $out.code = $(if ($resp.status -eq 206) { 206 } else { 200 })
    $out.ctype = (Get-FxTextOr (Get-FxMember $entry 'mime') 'application/octet-stream')
    $out.headers = @('Accept-Ranges: bytes', 'X-Content-Type-Options: nosniff', 'Content-Security-Policy: sandbox; default-src ''none''', 'Cross-Origin-Resource-Policy: same-site')
    if ($resp.status -eq 206 -and $resp.contentRange) { $out.headers = @($out.headers) + @('Content-Range: ' + [string]$resp.contentRange) }
    $out.body = [byte[]]$resp.bytes
    return $out
}

# --- response writer -------------------------------------------------------

function Get-FxStatusText {
    param([int]$Code)
    if ($Code -eq 200) { return 'OK' }
    if ($Code -eq 202) { return 'Accepted' }
    if ($Code -eq 204) { return 'No Content' }
    if ($Code -eq 206) { return 'Partial Content' }
    if ($Code -eq 400) { return 'Bad Request' }
    if ($Code -eq 401) { return 'Unauthorized' }
    if ($Code -eq 403) { return 'Forbidden' }
    if ($Code -eq 404) { return 'Not Found' }
    if ($Code -eq 405) { return 'Method Not Allowed' }
    if ($Code -eq 409) { return 'Conflict' }
    if ($Code -eq 413) { return 'Payload Too Large' }
    if ($Code -eq 415) { return 'Unsupported Media Type' }
    if ($Code -eq 416) { return 'Range Not Satisfiable' }
    if ($Code -eq 429) { return 'Too Many Requests' }
    if ($Code -eq 500) { return 'Server Error' }
    if ($Code -eq 502) { return 'Bad Gateway' }
    if ($Code -eq 504) { return 'Gateway Timeout' }
    return 'OK'
}

function Send-FxResponse {
    # Explorer responses carry NO wildcard CORS (unlike Send-ClientResponse) and
    # stream file bodies in 64 KiB chunks instead of buffering them.
    param($Stream, $Response)
    if (-not $Response -or -not $Stream) { return }
    $code = [int]$Response.code
    $body = $Response.body
    $bodyLen = [int64]0
    if ($null -ne $body) { $bodyLen = [int64]([byte[]]$body).LongLength }
    $fileLen = [int64]0
    if ($Response.file) { $fileLen = [int64](Get-FxNumberOrZero (Get-FxMember $Response.file 'length')) }
    $contentLength = $(if ($Response.file) { $fileLen } else { $bodyLen })
    $headerLines = New-Object System.Collections.Generic.List[string]
    $headerLines.Add('Content-Type: ' + [string]$Response.ctype)
    $headerLines.Add('Content-Length: ' + $contentLength)
    $headerLines.Add('Connection: close')
    $headerLines.Add('Cache-Control: no-store')
    $headerLines.Add('X-Content-Type-Options: nosniff')
    foreach ($h in @($Response.headers)) { if ($h) { $headerLines.Add([string]$h) } }
    $head = 'HTTP/1.1 ' + $code + ' ' + (Get-FxStatusText -Code $code) + "`r`n" + ($headerLines -join "`r`n") + "`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    $Stream.Write($hb, 0, $hb.Length)
    if ($Response.file) {
        $fs = $null
        try {
            $fs = [System.IO.File]::Open((Get-FxTextOr (Get-FxMember $Response.file 'path') ''), [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            $fs.Position = [int64](Get-FxNumberOrZero (Get-FxMember $Response.file 'offset'))
            $remaining = [int64](Get-FxNumberOrZero (Get-FxMember $Response.file 'length'))
            $buffer = New-Object byte[] 65536
            while ($remaining -gt 0) {
                $want = $buffer.Length
                if ($remaining -lt $want) { $want = [int]$remaining }
                $read = $fs.Read($buffer, 0, $want)
                if ($read -le 0) { break }
                $Stream.Write($buffer, 0, $read)
                $remaining = $remaining - $read
            }
        } finally { if ($fs) { $fs.Dispose() } }
    } elseif ($bodyLen -gt 0) {
        $Stream.Write([byte[]]$body, 0, [byte[]]$body.Length)
    }
    $Stream.Flush()
}

# --- sandbox shell (§1.7) --------------------------------------------------

function Get-FxSandboxShell {
    # MIME-explicit HTML shell: explicit doctype + meta charset, NO inline script
    # without the nonce, and a CSP that cannot be loosened by the payload. Data
    # arrives later (S8) only through the parent's postMessage bridge.
    param([string]$Nonce)
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.AppendLine('<!DOCTYPE html>')
    $null = $sb.AppendLine('<html lang="en">')
    $null = $sb.AppendLine('<head>')
    $null = $sb.AppendLine('<meta charset="utf-8">')
    $null = $sb.AppendLine('<meta name="viewport" content="width=device-width, initial-scale=1">')
    $null = $sb.AppendLine('<meta name="referrer" content="no-referrer">')
    $null = $sb.AppendLine('<title>ghrdp preview sandbox</title>')
    $null = $sb.AppendLine('<link rel="stylesheet" href="data:text/css,:root{color-scheme:light dark}">')
    $null = $sb.AppendLine('<script nonce="' + $Nonce + '">"use strict";window.__fxSandbox=function(){return{ready:true,mime:"",bytes:0};};</script>')
    $null = $sb.AppendLine('</head>')
    $null = $sb.AppendLine('<body>')
    $null = $sb.AppendLine('<output id="fx-sandbox-body" data-renderer="none">preview sandbox ready</output>')
    $null = $sb.AppendLine('</body>')
    $null = $sb.AppendLine('</html>')
    return $sb.ToString()
}

function Get-FxSandboxResponse {
    # /preview-sandbox/<nonce>/* : CSP + Origin-Agent-Cluster + CORP and a
    # SameSite=Strict cookie scoped to /preview-sandbox. The cookie is NOT
    # Secure: the dashboard is also served over plain tailnet HTTP, and a Secure
    # cookie would simply vanish there (fail open in the operator's browser).
    param([string]$Path)
    $out = [ordered]@{ code = 404; ctype = 'application/json; charset=utf-8'; headers = @(); body = $null; file = $null; phase = 'parse' }
    $rel = [string]$Path
    if (-not $rel.StartsWith('/preview-sandbox')) {
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; error = 'not a sandbox path' }))
        return $out
    }
    $parts = @($rel.Split('/') | Where-Object { $_ -ne '' })
    if ($parts.Count -lt 2 -or $parts.Count -gt 3) {
        $out.headers = @('Cross-Origin-Resource-Policy: same-site', 'Origin-Agent-Cluster: ?1')
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; error = 'sandbox path must be /preview-sandbox/<nonce> or /preview-sandbox/<nonce>/body' }))
        return $out
    }
    $nonce = [string]$parts[1]
    if ($nonce -notmatch '^[a-f0-9]{16,64}$') {
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; error = 'sandbox nonce must be lowercase hex' }))
        return $out
    }
    $doc = ($parts.Count -eq 3 -and $parts[2] -eq 'body')
    $out.code = 200
    $csp = "default-src 'none'; script-src 'nonce-$nonce'; style-src 'nonce-$nonce' data:; img-src data: blob:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'; sandbox allow-scripts"
    # The two expression elements are PARENTHESIZED on purpose: the comma
    # operator binds tighter than +, so an unparenthesized
    # `'Content-Security-Policy: ' + $csp,` swallows the whole rest of the list
    # into one space-joined string (one malformed header instead of six).
    $out.headers = @(
        ('Content-Security-Policy: ' + $csp),
        'Origin-Agent-Cluster: ?1',
        'Cross-Origin-Resource-Policy: same-site',
        'Referrer-Policy: no-referrer',
        'X-Content-Type-Options: nosniff',
        ('Set-Cookie: fx_sandbox=' + $nonce + '; Path=/preview-sandbox; SameSite=Strict; HttpOnly; Max-Age=900')
    )
    if ($doc) {
        $out.ctype = 'text/html; charset=utf-8'
        $out.body = [System.Text.Encoding]::UTF8.GetBytes((Get-FxSandboxShell -Nonce $nonce))
    } else {
        $out.ctype = 'application/json; charset=utf-8'
        $out.body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $true; nonce = $nonce; shell = ('/preview-sandbox/' + $nonce + '/body') }))
    }
    return $out
}

# --- router ----------------------------------------------------------------

function New-FxErrorResponse {
    # The parameter is deliberately NOT named $Error: that is a read-only
    # automatic variable on Windows PowerShell 5.1, and binding it throws
    # "Cannot overwrite variable Error" before the function body ever runs. The
    # JSON FIELD is still `error` - that is the F44 envelope the client reads.
    param([int]$Code, [string]$Phase, [string]$Message, [string[]]$Headers = @())
    return [ordered]@{
        code = $Code
        ctype = 'application/json; charset=utf-8'
        headers = @($Headers)
        body = (ConvertTo-FxJsonBytes ([ordered]@{ ok = $false; phase = $Phase; error = $Message }))
        file = $null
        phase = $Phase
        message = $Message
    }
}

function Invoke-FxRoute {
    # The single Explorer entry point. Returns a response descriptor, or $null
    # when the path is not an Explorer route (the caller then continues with the
    # parent routes). Nothing here touches the F44 mirror index.
    param([string]$Method, [string]$Path, $Query, $Headers, [byte[]]$Body = $null, [string]$SourceIp = '', [string]$Token = '', $Now = $null)
    if (-not $Path) { return $null }
    $isApi = $Path.StartsWith('/api/fx/')
    $isSandbox = $Path.StartsWith('/preview-sandbox')
    if (-not $isApi -and -not $isSandbox) { return $null }
    $method = [string]$Method
    if (-not $method) { $method = 'GET' }
    if ($method -eq 'OPTIONS') {
        return [ordered]@{ code = 204; ctype = 'text/plain'; headers = @('Allow: GET, POST, OPTIONS'); body = $null; file = $null; phase = $null; message = '' }
    }
    if ($isSandbox) {
        # The shell is static and secret-free, but it is still only served to the
        # dashboard's own trust path.
        $gateS = Test-FxDashToken -Headers $Headers -Query $Query -Token $Token -SourceIp $SourceIp
        if (-not $gateS.ok) {
            $null = Write-FxLog ('sandbox denied (' + [string]$gateS.reason + ')')
            return (New-FxErrorResponse -Code 401 -Phase 'auth' -Message 'dashboard authorization required')
        }
        return (Get-FxSandboxResponse -Path $Path)
    }
    if (-not ($Path -in @('/api/fx/list', '/api/fx/meta', '/api/fx/gofile/status', '/api/fx/preview', '/api/fx/op', '/api/fx/upload'))) {
        return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message ('no such Explorer endpoint: ' + $Path))
    }
    $gate = Test-FxDashToken -Headers $Headers -Query $Query -Token $Token -SourceIp $SourceIp
    if (-not $gate.ok) {
        # The reason is a sentence, never the presented value.
        $null = Write-FxLog ('fx request denied (' + [string]$gate.reason + ') for ' + $Path)
        return (New-FxErrorResponse -Code 401 -Phase 'auth' -Message 'dashboard authorization required')
    }
    if ($method -eq 'POST') {
        if (-not (Test-FxCsrf -Headers $Headers -Method $method -Token $Token)) {
            $null = Write-FxLog ('fx POST refused: CSRF token missing or wrong for ' + $Path)
            return (New-FxErrorResponse -Code 403 -Phase 'auth' -Message 'CSRF token missing or invalid')
        }
    }
    # §5.1 rule 6: a POST carrying X-Idempotency-Key is replayed, not re-run.
    $idemKey = ''
    $idemHash = ''
    if ($method -eq 'POST' -and $Headers -and $Headers.ContainsKey('x-idempotency-key')) {
        $idemKey = [string]$Headers['x-idempotency-key']
    }
    if ($idemKey) {
        $idemHash = Get-FxRequestHash -Method $method -Path $Path -Body $Body
        $idem = Get-FxIdempotentHit -Key $idemKey -RequestHash $idemHash
        if ($idem.conflict) {
            $null = Write-FxLog ('idempotency key reused with a different body for ' + $Path)
            return (New-FxErrorResponse -Code 409 -Phase 'parse' -Message 'idempotency key reused with a different request')
        }
        if ($idem.hit) {
            $null = Write-FxLog ('replaying the recorded result for ' + $Path)
            return [ordered]@{
                code = [int]$idem.code
                ctype = 'application/json; charset=utf-8'
                headers = @('X-Idempotent-Replay: 1')
                body = [System.Text.Encoding]::UTF8.GetBytes([string]$idem.body)
                file = $null
                phase = $null
                message = 'replay'
            }
        }
    }
    $id = ''
    if ($Query -and $Query.ContainsKey('id')) { $id = [string]$Query['id'] }
    switch ($Path) {
        '/api/fx/list' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'list is GET only') }
            $doc = Get-FxIndexDoc
            if (-not $doc.ok) {
                $null = Write-FxLog ('index unreadable: ' + [string]$doc.detail)
                return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('index JSON could not be parsed: ' + [string]$doc.detail))
            }
            if ($doc.migrated) { $null = Write-FxLog ('index migrated from schemaVersion ' + [string]$doc.schemaVersion + ' to ' + [string]$script:FxSchemaVersion) }
            $payload = [ordered]@{
                schemaVersion = $script:FxSchemaVersion
                generatedAt = (Get-FxTextOr (Get-FxMember $doc.index 'generatedAt') $script:FxEpoch)
                runnerId = (Get-FxTextOr (Get-FxMember $doc.index 'runnerId') 'unknown')
                roots = @(Get-FxRows $doc.index 'roots')
                files = @(Get-FxRows $doc.index 'files')
                gofileHosts = @(Get-FxRows $doc.index 'gofileHosts')
                source = [string]$doc.source
            }
            return [ordered]@{ code = 200; ctype = 'application/json; charset=utf-8'; headers = @('Vary: X-Dash-Token'); body = (ConvertTo-FxJsonBytes $payload); file = $null; phase = $null; message = '' }
        }
        '/api/fx/meta' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'meta is GET only') }
            if (-not $id) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message 'meta requires an id') }
            $doc = Get-FxIndexDoc
            if (-not $doc.ok) { return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('index JSON could not be parsed: ' + [string]$doc.detail)) }
            $entry = Select-FxFileEntry -Index $doc.index -Id $id
            if ($null -eq $entry) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message 'unknown id') }
            return [ordered]@{ code = 200; ctype = 'application/json; charset=utf-8'; headers = @(); body = (ConvertTo-FxJsonBytes $entry); file = $null; phase = $null; message = '' }
        }
        '/api/fx/gofile/status' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'gofile/status is GET only') }
            if (-not $id) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message 'gofile/status requires an id') }
            $doc = Get-FxIndexDoc
            if (-not $doc.ok) { return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('index JSON could not be parsed: ' + [string]$doc.detail)) }
            $st = Get-FxGofileStatusResponse -Index $doc.index -Id $id -Token $script:FxGofileToken
            if ($st.code -ne 200) {
                if ($st.code -eq 404) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message 'unknown id') }
                return (New-FxErrorResponse -Code $st.code -Phase ([string]$st.phase) -Message (Protect-FxText ([string]$st.message)))
            }
            return [ordered]@{ code = 200; ctype = 'application/json; charset=utf-8'; headers = @(); body = (ConvertTo-FxJsonBytes $st.json); file = $null; phase = $null; message = '' }
        }
        '/api/fx/preview' {
            if ($method -ne 'GET') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'preview is GET only') }
            if (-not $id) { return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message 'preview requires an id') }
            $rangeHeader = ''
            if ($Headers -and $Headers.ContainsKey('range')) { $rangeHeader = [string]$Headers['range'] }
            $doc = Get-FxIndexDoc
            if (-not $doc.ok) { return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('index JSON could not be parsed: ' + [string]$doc.detail)) }
            return (Get-FxPreviewResponse -Index $doc.index -Id $id -RangeHeader $rangeHeader -Token $Token)
        }
        '/api/fx/op' {
            if ($method -ne 'POST') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'op is POST only') }
            $bodyObj = Get-FxBodyObject -Body $Body
            $doc = Get-FxIndexDoc
            if (-not $doc.ok) { return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('index JSON could not be parsed: ' + [string]$doc.detail)) }
            $opResult = Invoke-FxOpOnIndex -Index $doc.index -Body $bodyObj -Now ($(if ($Now) { [string]$Now } else { Get-FxNowIso }))
            if ($opResult.code -ne 200) {
                $null = Write-FxLog ('op refused: ' + [string]$opResult.message)
                return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message ([string]$opResult.message))
            }
            if (-not (Set-FxIndexDoc -Index $doc.index)) {
                return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('index write failed: ' + [string]$script:FxLastWriteError))
            }
            $payload = [ordered]@{ applied = @($opResult.applied); skipped = @($opResult.skipped) }
            $opBytes = ConvertTo-FxJsonBytes $payload
            if ($idemKey) {
                $null = Save-FxIdempotentResult -Key $idemKey -Method $method -Path $Path -RequestHash $idemHash -Code 200 -Body ([System.Text.Encoding]::UTF8.GetString($opBytes))
            }
            return [ordered]@{ code = 200; ctype = 'application/json; charset=utf-8'; headers = @(); body = $opBytes; file = $null; phase = $null; message = '' }
        }
        '/api/fx/upload' {
            if ($method -ne 'POST') { return (New-FxErrorResponse -Code 405 -Phase 'parse' -Message 'upload is POST only') }
            $bodyObj = Get-FxBodyObject -Body $Body
            if ($null -eq $bodyObj) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'upload requires a JSON body') }
            if (Test-FxBodyHasHardFlag -Body $bodyObj) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message 'hard delete is not an Explorer operation') }
            $doc = Get-FxIndexDoc
            if (-not $doc.ok) { return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('index JSON could not be parsed: ' + [string]$doc.detail)) }
            $hostName = Get-FxTextOr (Get-FxMember $bodyObj 'host') ''
            $idsParam = @(Get-FxUniqueStrings (Get-FxMember $bodyObj 'ids'))
            $queued = Add-FxUploadJobs -Index $doc.index -Ids $idsParam -HostId $hostName -Now ($(if ($Now) { [string]$Now } else { Get-FxNowIso }))
            if ($queued.code -eq 500) { return (New-FxErrorResponse -Code 500 -Phase 'parse' -Message (Protect-FxText ([string]$queued.message))) }
            if ($queued.code -ne 202) { return (New-FxErrorResponse -Code 400 -Phase 'parse' -Message ([string]$queued.message)) }
            $payload = [ordered]@{ jobs = @($queued.jobs); skipped = @($queued.skipped) }
            $jobBytes = ConvertTo-FxJsonBytes $payload
            if ($idemKey) {
                $null = Save-FxIdempotentResult -Key $idemKey -Method $method -Path $Path -RequestHash $idemHash -Code 202 -Body ([System.Text.Encoding]::UTF8.GetString($jobBytes))
            }
            return [ordered]@{ code = 202; ctype = 'application/json; charset=utf-8'; headers = @(); body = $jobBytes; file = $null; phase = $null; message = 'queued' }
        }
    }
    return (New-FxErrorResponse -Code 404 -Phase 'parse' -Message 'no such Explorer endpoint')
}

function Initialize-FxServer {
    # Startup wiring: index readiness, gofile token from config (never logged),
    # and the first queue pass timestamp.
    param([string]$ConfigPath = '')
    if (-not $ConfigPath) { $ConfigPath = $script:CfgPath }
    $script:FxStartedAt = Get-FxNowIso
    if ($ConfigPath -and -not $script:FxGofileToken) {
        $cfg = Read-FxJson -Path $ConfigPath
        if ($cfg.ok -and $null -ne $cfg.value) {
            $tok = Get-FxStringOrNull (Get-FxMember $cfg.value 'gofileToken')
            if ($tok) { $script:FxGofileToken = $tok }
            $base = Get-FxStringOrNull (Get-FxMember $cfg.value 'gofileBase')
            if ($base) { $script:FxGofileBase = $base }
            $maxPreview = Get-FxNumberOrNull (Get-FxMember $cfg.value 'fxPreviewMaxBytes')
            if ($null -ne $maxPreview -and $maxPreview -gt 0) { $script:FxPreviewMaxBytes = [int64]$maxPreview }
        }
    }
    if ($env:GHRDP_GOFILE_TOKEN -and -not $script:FxGofileToken) { $script:FxGofileToken = [string]$env:GHRDP_GOFILE_TOKEN }
    $doc = Initialize-FxIndex
    if ($doc.ok) {
        $fileCount = [int]@(Get-FxRows $doc.index 'files').Count
        $null = Write-FxLog ('index ready: source=' + [string]$doc.source + ' schemaVersion=' + [string]$script:FxSchemaVersion + ' files=' + [string]$fileCount + ' migrated=' + [string]$doc.migrated + ' gofileToken=' + $(if ($script:FxGofileToken) { 'configured' } else { 'absent' }))
    } else {
        $null = Write-FxLog ('index NOT ready: reason=' + [string]$doc.reason + ' detail=' + [string]$doc.detail)
    }
    return $doc
}
# [F45 S4 fx-core-end]

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
        # [F45 S4 fx-route-begin] Explorer routes are dispatched BEFORE the
        # parent gate because they authenticate the same dashboard out of the
        # X-Dash-Token header (the S3 client never puts a token in a URL), and
        # because their error contract is 401/403/404/413/415/500/502/504 with
        # an F44 phase, not the parent's plain-text 401. Nothing else is
        # affected: a non-Explorer path falls straight through to the parent
        # routes below, and the Explorer gate fails closed on its own.
        if ($path.StartsWith('/api/fx/') -or $path.StartsWith('/preview-sandbox')) {
            $fxSrc = ''
            try { $fxSrc = $Client.Client.RemoteEndPoint.Address.ToString() } catch { }
            $fxResp = $null
            try {
                $fxResp = Invoke-FxRoute -Method $parts.method -Path $path -Query $parts.query -Headers $parts.headers -Body ([byte[]]$parts.body) -SourceIp $fxSrc -Token $Token
            } catch {
                $fxErr = Protect-FxText ([string]$_.Exception.Message)
                $null = Write-FxLog ('fx route failed: ' + $fxErr)
                $fxResp = New-FxErrorResponse -Code 500 -Phase 'parse' -Message ('explorer handler failed: ' + $fxErr)
            }
            if ($fxResp) {
                Send-FxResponse -Stream $stream -Response $fxResp
                return
            }
        }
        # [F45 S4 fx-route-end]
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
# [F45 S4] Explorer index readiness: fx-index.json is created/migrated to
# schemaVersion 2 (with the gofileHosts array) BEFORE the first client can ask
# for it, so /api/fx/list never races the first write.
try { $null = Initialize-FxServer -ConfigPath $script:CfgPath } catch { try { $null = Write-FxLog ('fx init failed: ' + [string]$_.Exception.Message) } catch { } }
$lastFxTick = Get-Date
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
    # [F45 S4] Explorer upload-queue worker: ONE bounded pass every
    # $script:FxIntervalSec inside this loop. Deliberately in-process: the queue
    # file and fx-index.json then have exactly one writer, so no child process
    # can interleave a partial upload state into the index.
    if (((Get-Date) - $lastFxTick).TotalSeconds -ge $script:FxIntervalSec) {
        $lastFxTick = Get-Date
        try { $null = Step-FxUploadQueue } catch { }
    }
    Start-Sleep -Milliseconds 50
}
try { $listener.Stop() } catch { }
