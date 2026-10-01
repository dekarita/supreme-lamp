# [F56-d §2] qBittorrent-nox torrent lane - WebUI bound to the TAILNET INTERFACE ONLY
# (never 0.0.0.0, never '*'), port 8080, auth via GHRDP_QBT_PASSWORD, category
# 'ghrdp-fetched', save path D:\RDP-Storage\Fetched\. Preset legal-torrent allowlist:
# Linux distros, Blender open-movie, Internet Archive + operator-supplied own URLs
# (GHRDP_QBT_OWN_URLS, in-memory per run, never persisted). Magnet-only flows are
# refused (a magnet carries no HTTPS artifact and no allowlisted .torrent host), as
# are non-HTTPS artifacts, off-allowlist hosts and torrent-indexer lookups. The
# operator password is read from the environment (or the SYSTEM-only secret file),
# used for the WebUI session and never written to a log - only a redacted label.
# pre-dispatch transport selection + own-cred handling live in ghrdp-server.ps1.

# The policy (port, category, save path, tailnet predicate, preset host families,
# refused schemes, per-run own-URL env) lives in ONE machine-readable file that this
# lane and the Node lab both read - no duplicated constants to drift.
function Get-GhrdpQbtPolicyPath {
    param([string]$PolicyPath = '')
    if ($PolicyPath -and (Test-Path -LiteralPath $PolicyPath)) { return $PolicyPath }
    $candidates = @()
    try { if ($env:GHRDP_QBT_POLICY) { $candidates += [string]$env:GHRDP_QBT_POLICY } } catch { }
    try { if ($PSCommandPath) { $candidates += (Join-Path (Split-Path -Parent $PSCommandPath) 'ghrdp-qbt-policy.json') } } catch { }
    $candidates += 'C:\ghrdp\ghrdp-qbt-policy.json'
    try { if ($env:GITHUB_WORKSPACE) { $candidates += (Join-Path $env:GITHUB_WORKSPACE 'payloads\ghrdp-qbt-policy.json') } } catch { }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return ''
}

function Import-GhrdpQbtPolicy {
    param([string]$PolicyPath = '')
    $p = Get-GhrdpQbtPolicyPath -PolicyPath $PolicyPath
    if (-not $p) { return @{ ok = $false; reason = 'qbt-policy-missing'; policy = $null; path = '' } }
    try {
        $pol = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
        if (-not $pol.tailnetRegex) { return @{ ok = $false; reason = 'qbt-policy-invalid'; policy = $null; path = $p } }
        if ($pol.tailnetOnly -eq $false) { return @{ ok = $false; reason = 'qbt-tailnet-only-disabled'; policy = $null; path = $p } }
        return @{ ok = $true; reason = ''; policy = $pol; path = $p }
    } catch {
        return @{ ok = $false; reason = ('qbt-policy-unreadable: ' + $_.Exception.Message); policy = $null; path = $p }
    }
}

$script:QbtPolicy = Import-GhrdpQbtPolicy
$script:QbtPolicyOk = [bool]$script:QbtPolicy.ok
$script:QbtPolicyPath = [string]$script:QbtPolicy.path
$script:QbtPolicyReason = [string]$script:QbtPolicy.reason
$pol = $script:QbtPolicy.policy
$script:QbtWebUiPort = 0
$script:QbtCategory = 'ghrdp-fetched'
$script:QbtSavePath = ''
$script:QbtUserName = 'ghrdp'
$script:QbtSecretFile = ''
$script:QbtShaPinPath = ''
$script:QbtLogPath = ''
$script:QbtTorrentMaxBytes = 0
# F25-canonical CGNAT pattern (100.64.0.0/10), from the policy file. Octet bounds are
# checked in code, because a bare prefix test accepted '100.83.13.45evil' once already.
$script:QbtTailnetRegex = ''
$script:QbtPresets = [ordered]@{}
$script:QbtOwnUrlsEnv = 'GHRDP_QBT_OWN_URLS'
if ($script:QbtPolicyOk) {
    try { $script:QbtWebUiPort = [int]$pol.webUiPort } catch { }
    try { $script:QbtCategory = [string]$pol.category } catch { }
    try { $script:QbtSavePath = [string]$pol.savePath } catch { }
    try { $script:QbtUserName = [string]$pol.userName } catch { }
    try { $script:QbtSecretFile = [string]$pol.secretFile } catch { }
    try { $script:QbtShaPinPath = [string]$pol.shaPinPath } catch { }
    try { $script:QbtLogPath = [string]$pol.logPath } catch { }
    try { $script:QbtTorrentMaxBytes = [int]$pol.torrentMaxBytes } catch { }
    try { $script:QbtTailnetRegex = [string]$pol.tailnetRegex } catch { }
    try { $script:QbtOwnUrlsEnv = [string]$pol.ownUrlsEnv } catch { }
    try {
        foreach ($k in @($pol.presets.PSObject.Properties.Name)) {
            $script:QbtPresets[$k] = @($pol.presets.$k)
        }
    } catch { }
}

function Test-GhrdpQbtTailnetAddress {
    # [F56-d §2] tailnet-only predicate: CGNAT literal, each octet <= 255.
    param([string]$Ip)
    if (-not $Ip) { return $false }
    if (-not $script:QbtTailnetRegex) { return $false }
    if ($Ip -notmatch $script:QbtTailnetRegex) { return $false }
    foreach ($oct in @($Matches[2], $Matches[3])) {
        $n = 0
        if (-not [int]::TryParse($oct, [ref]$n)) { return $false }
        if ($n -lt 0 -or $n -gt 255) { return $false }
    }
    return $true
}

function Get-GhrdpQbtPassword {
    # Operator password: environment first (F49 GHRDP_ secret pattern), then the
    # SYSTEM-only file. Never logged, never returned in a details object.
    param([string]$SecretFile = $script:QbtSecretFile)
    $pw = ''
    try { $pw = [string]$env:GHRDP_QBT_PASSWORD } catch { }
    if (-not $pw) {
        try {
            if (Test-Path -LiteralPath $SecretFile) {
                $pw = ([System.IO.File]::ReadAllText($SecretFile)).Trim()
            }
        } catch { }
    }
    return $pw
}

function Get-GhrdpQbtOwnUrls {
    # Operator-supplied own URLs: per-run, in-memory only (never a repo literal,
    # never persisted). Comma or newline separated, https required.
    $out = @()
    try {
        $raw = ''
        try { $raw = [string](Get-Item -Path ('Env:' + $script:QbtOwnUrlsEnv) -ErrorAction Stop).Value } catch { $raw = '' }
        if ($raw) {
            foreach ($u in ($raw -split '[,\r\n]+')) {
                $t = $u.Trim()
                if ($t -and $t -match '^https://') { $out += $t }
            }
        }
    } catch { }
    return @($out)
}

function Resolve-GhrdpQbtBindAddress {
    # Ladder: L1 GHRDP_QBT_BIND_IP | L2 config.json .rdpIp | L3 .runnerResolvedIP |
    # L4 first CGNAT address on the host. Every candidate must pass the tailnet
    # predicate; nothing falls back to '*' or 0.0.0.0 - the lane fails closed.
    param([string]$ConfigPath = '')
    $candidates = @()
    try { if ($env:GHRDP_QBT_BIND_IP) { $candidates += [string]$env:GHRDP_QBT_BIND_IP } } catch { }
    if ($ConfigPath -and (Test-Path -LiteralPath $ConfigPath)) {
        try {
            $cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
            foreach ($p in @('rdpIp', 'runnerResolvedIP')) {
                try { $v = [string]$cfg.$p; if ($v) { $candidates += $v } } catch { }
            }
        } catch { }
    }
    try {
        foreach ($a in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
            if ($a.IPAddress) { $candidates += [string]$a.IPAddress }
        }
    } catch { }
    $i = 0
    foreach ($c in $candidates) {
        $i++
        if (Test-GhrdpQbtTailnetAddress -Ip $c) { return @{ ok = $true; address = $c; source = ('L' + $i); reason = '' } }
    }
    return @{ ok = $false; address = ''; source = ''; reason = 'tailnet-ip-unavailable' }
}

function Resolve-GhrdpQbtExe {
    # The -nox binary is the lane; a GUI binary is only reported (never silently
    # promoted into a headless lane: the lane needs --webui-port without a session).
    $names = @('qbittorrent-nox.exe', 'qbittorrent-nox', 'qbittorrent.exe')
    $roots = @()
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) { $roots += (Join-Path $base 'qBittorrent') }
    }
    $roots += 'C:\ProgramData\chocolatey\lib'
    $roots += 'C:\ProgramData\chocolatey\bin'
    foreach ($n in $names) {
        foreach ($r in $roots) {
            try {
                if (-not $r -or -not (Test-Path -LiteralPath $r)) { continue }
                $hit = Get-ChildItem -Path $r -Filter $n -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($hit -and $hit.FullName) { return @{ ok = $true; exe = $hit.FullName; name = $n; nox = ($n -like '*nox*'); reason = '' } }
            } catch { }
        }
    }
    $cmd = $null
    try { $cmd = Get-Command 'qbittorrent-nox.exe' -ErrorAction SilentlyContinue } catch { }
    if ($cmd -and $cmd.Source) { return @{ ok = $true; exe = $cmd.Source; name = 'qbittorrent-nox.exe'; nox = $true; reason = '' } }
    return @{ ok = $false; exe = ''; name = ''; nox = $false; reason = 'qbt-exe-missing' }
}

function Get-GhrdpQbtSha256 {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() } catch { return '' }
}

function Test-GhrdpQbtShaPin {
    # SHA-256 verification that never fabricates a digest: an operator pin
    # (GHRDP_QBT_SHA256) or the TOFU pin file written by the first verified run is
    # compared byte-for-byte. First run records the observed digest and reports
    # mode='recorded' - a later run that sees a different binary FAILS CLOSED.
    param(
        [string]$Path,
        [string]$Expected = '',
        [string]$PinPath = $script:QbtShaPinPath
    )
    $sha = Get-GhrdpQbtSha256 -Path $Path
    if (-not $sha) { return @{ ok = $false; sha256 = ''; mode = 'unreadable'; reason = 'qbt-sha-unreadable' } }
    $pin = ''
    if ($Expected) { $pin = $Expected.Trim().ToLowerInvariant() }
    if (-not $pin) {
        try { if (Test-Path -LiteralPath $PinPath) { $pin = ([System.IO.File]::ReadAllText($PinPath)).Trim().ToLowerInvariant() } } catch { }
    }
    if ($pin -and $pin -ne $sha) {
        return @{ ok = $false; sha256 = $sha; mode = 'verified'; expected = $pin; reason = 'qbt-sha-pin-mismatch' }
    }
    if ($pin) { return @{ ok = $true; sha256 = $sha; mode = 'verified'; expected = $pin; reason = '' } }
    try {
        $dir = Split-Path -Parent $PinPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($PinPath, $sha, (New-Object System.Text.UTF8Encoding($false)))
        return @{ ok = $true; sha256 = $sha; mode = 'recorded'; expected = $sha; reason = '' }
    } catch {
        return @{ ok = $true; sha256 = $sha; mode = 'unrecorded'; expected = ''; reason = 'pin-write-failed' }
    }
}

function Assert-GhrdpQbtTailnetOnly {
    # Hard guard: the WebUI address may never be '*' / 0.0.0.0 / '::' / a public IP.
    param([string]$Address, [int]$Port = $script:QbtWebUiPort)
    if (-not $Address) { throw 'qbt-tailnet-only: empty WebUI address refused' }
    $bad = @('*', '0.0.0.0', '::', '::0', '[::]', 'any')
    foreach ($b in $bad) {
        if ($Address.Trim().ToLowerInvariant() -eq $b) { throw ('qbt-tailnet-only: refused non-tailnet WebUI bind ' + $b) }
    }
    if (-not (Test-GhrdpQbtTailnetAddress -Ip $Address)) {
        throw ('qbt-tailnet-only: WebUI bind is not a tailnet address: ' + $Address)
    }
    if ($Port -ne $script:QbtWebUiPort) { throw ('qbt-tailnet-only: unexpected WebUI port ' + $Port) }
    return $true
}

function Set-GhrdpQbtWebUiConfig {
    # Writes the [Preferences] block the daemon reads at start. Address is the
    # resolved tailnet literal (asserted first), auth stays ON, CSRF + Host header
    # validation stay ON (no weakening), and the save path/category are pinned.
    param(
        [string]$Address,
        [int]$Port = $script:QbtWebUiPort,
        [string]$ConfPath = ''
    )
    $null = Assert-GhrdpQbtTailnetOnly -Address $Address -Port $Port
    if (-not $ConfPath) {
        $base = ''
        try { $base = [string]$env:APPDATA } catch { }
        if (-not $base) { $base = 'C:\Windows\System32\config\systemprofile\AppData\Roaming' }
        $ConfPath = Join-Path $base 'qBittorrent\qBittorrent.conf'
    }
    $dir = Split-Path -Parent $ConfPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    try {
        if ($script:QbtSavePath -and -not (Test-Path -LiteralPath $script:QbtSavePath)) {
            $null = New-Item -ItemType Directory -Path $script:QbtSavePath -Force -ErrorAction SilentlyContinue
        }
    } catch { }
    $keys = [ordered]@{
        'WebUI\Address'                = $Address
        'WebUI\Port'                   = [string]$Port
        'WebUI\Username'               = $script:QbtUserName
        'WebUI\CSRFProtection'         = 'true'
        'WebUI\HostHeaderValidation'   = 'true'
        'WebUI\ClickjackingProtection' = 'true'
        'Downloads\SavePath'           = ($script:QbtSavePath + '\')
        'Downloads\TempPath'           = ($script:QbtSavePath + '\')
    }
    $lines = @()
    if (Test-Path -LiteralPath $ConfPath) { $lines = @(Get-Content -LiteralPath $ConfPath) }
    $out = @()
    $seen = @{}
    $inPref = $false
    foreach ($l in $lines) {
        if ($l -match '^\s*\[(.+)\]\s*$') { $inPref = ($Matches[1] -eq 'Preferences') }
        $matched = $false
        if ($inPref) {
            foreach ($k in @($keys.Keys)) {
                if ($l -match ('^\s*' + [regex]::Escape($k) + '\s*=')) {
                    $out += ($k + '=' + $keys[$k]); $seen[$k] = $true; $matched = $true; break
                }
            }
        }
        if (-not $matched) { $out += $l }
    }
    if (-not $seen['WebUI\Address']) {
        $out += '[Preferences]'
        foreach ($k in @($keys.Keys)) { if (-not $seen[$k]) { $out += ($k + '=' + $keys[$k]) } }
    } elseif ($seen.Count -lt $keys.Count) {
        foreach ($k in @($keys.Keys)) { if (-not $seen[$k]) { $out += ($k + '=' + $keys[$k]) } }
    }
    [System.IO.File]::WriteAllLines($ConfPath, $out, (New-Object System.Text.UTF8Encoding($false)))
    return @{ ok = $true; path = $ConfPath; address = $Address; port = $Port }
}

function Read-GhrdpQbtConf {
    param([string]$ConfPath = '')
    if (-not $ConfPath) {
        $base = ''
        try { $base = [string]$env:APPDATA } catch { }
        $ConfPath = Join-Path $base 'qBittorrent\qBittorrent.conf'
    }
    if (-not (Test-Path -LiteralPath $ConfPath)) { return '' }
    try { return ([System.IO.File]::ReadAllText($ConfPath)) } catch { return '' }
}

function Invoke-GhrdpQbtApi {
    # Minimal WebUI API client. The password never rides in a URL or a log line;
    # the session cookie lives in the caller's WebSession object (memory only).
    param(
        [string]$Method = 'GET',
        [string]$Path = '/api/v2/app/version',
        [hashtable]$Body = @{},
        [string]$Address = '127.0.0.1',
        [int]$Port = $script:QbtWebUiPort,
        [object]$WebSession = $null
    )
    $url = ('http://' + $Address + ':' + $Port + $Path)
    $headers = @{
        Referer = ('http://' + $Address + ':' + $Port)
        Origin  = ('http://' + $Address + ':' + $Port)
    }
    $req = @{
        Uri         = $url
        Method      = $Method
        Headers     = $headers
        TimeoutSec  = 15
        ErrorAction = 'Stop'
    }
    if ($WebSession) { $req['WebSession'] = $WebSession }
    if ($Method -ne 'GET' -and $Body.Count -gt 0) {
        $req['Body'] = $Body
        $req['ContentType'] = 'application/x-www-form-urlencoded'
    }
    try {
        $r = Invoke-WebRequest @req
        return @{ ok = $true; status = [int]$r.StatusCode; body = [string]$r.Content; session = $WebSession; error = $null }
    } catch {
        $code = -1
        $body = ''
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        try { $body = [string]$_.ErrorDetails.Message } catch { }
        return @{ ok = $false; status = $code; body = $body; session = $WebSession; error = $_.Exception.Message }
    }
}

function Connect-GhrdpQbt {
    # Login ladder: operator password -> daemon-printed temporary password (adopted
    # in memory, then replaced with the operator password when one is configured) ->
    # fail closed. There is no unauthenticated fallback and no auth disabling.
    param(
        [string]$Address,
        [int]$Port = $script:QbtWebUiPort,
        [string]$Password = '',
        [string]$LogPath = $script:QbtLogPath,
        [string]$ConfPath = ''
    )
    $pw = $Password
    if (-not $pw) { $pw = Get-GhrdpQbtPassword }
    $sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $login = Invoke-GhrdpQbtApi -Method 'POST' -Path '/api/v2/auth/login' -Body @{ username = $script:QbtUserName; password = $pw } -Address $Address -Port $Port -WebSession $sess
    if ($login.ok -and ([string]$login.body).Trim() -eq 'Ok.') {
        return @{ ok = $true; mode = 'operator'; session = $login.session; address = $Address; reason = '' }
    }
    $temp = ''
    try {
        if (Test-Path -LiteralPath $LogPath) {
            foreach ($l in @(Get-Content -LiteralPath $LogPath -Tail 200)) {
                if ($l -match 'temporary password[^:]*:\s*(\S+)') { $temp = $Matches[1] }
                elseif ($l -match 'temporary password is provided[^:]*:\s*(\S+)') { $temp = $Matches[1] }
            }
        }
    } catch { }
    if ($temp) {
        $sess2 = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        $login2 = Invoke-GhrdpQbtApi -Method 'POST' -Path '/api/v2/auth/login' -Body @{ username = $script:QbtUserName; password = $temp } -Address $Address -Port $Port -WebSession $sess2
        $temp = ''
        if ($login2.ok -and ([string]$login2.body).Trim() -eq 'Ok.') {
            $mode = 'temporary'
            if ($pw) {
                # Replace the transient password with the operator one immediately.
                $set = Invoke-GhrdpQbtApi -Method 'POST' -Path '/api/v2/app/setPreferences' -Body @{ json = ('{"web_ui_password":"' + $pw + '"}') } -Address $Address -Port $Port -WebSession $login2.session
                if ($set.ok) { $mode = 'operator-adopted' }
            }
            return @{ ok = $true; mode = $mode; session = $login2.session; address = $Address; reason = '' }
        }
    }
    $reason = 'qbt-auth-unavailable'
    if ($login.status -eq 403) { $reason = 'qbt-auth-forbidden (Referer/Host header validation)' }
    elseif ($login.status -lt 0) { $reason = 'qbt-webui-unreachable' }
    return @{ ok = $false; mode = ''; session = $null; address = $Address; reason = $reason }
}

function Get-GhrdpQbtVersion {
    param([string]$Address, [int]$Port = $script:QbtWebUiPort, [object]$Session = $null)
    $r = Invoke-GhrdpQbtApi -Method 'GET' -Path '/api/v2/app/version' -Address $Address -Port $Port -WebSession $Session
    if (-not $r.ok) { return @{ ok = $false; version = ''; reason = ('qbt-api-' + $r.status) } }
    return @{ ok = $true; version = ([string]$r.body).Trim(); reason = '' }
}

function Invoke-GhrdpQbtApiFile {
    # multipart/form-data upload of the .torrent artifact. Used ONLY for the
    # own-credential path: the server has already fetched the artifact with the
    # in-memory credentials (wiped) and hands the bytes here - the daemon never
    # sees a credential, and a credentialed URL never reaches the daemon either.
    param(
        [string]$FilePath,
        [string]$Address,
        [int]$Port = $script:QbtWebUiPort,
        [object]$Session = $null,
        [hashtable]$Fields = @{}
    )
    if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath)) { return @{ ok = $false; status = -1; body = ''; error = 'torrent-file-missing' } }
    $boundary = '----ghrdp' + [guid]::NewGuid().ToString('N')
    $nl = "`r`n"
    $enc = [System.Text.Encoding]::UTF8
    $ms = New-Object System.IO.MemoryStream
    try {
        foreach ($k in @($Fields.Keys)) {
            $part = ('--' + $boundary + $nl + 'Content-Disposition: form-data; name="' + $k + '"' + $nl + $nl + [string]$Fields[$k] + $nl)
            $b = $enc.GetBytes($part); $ms.Write($b, 0, $b.Length)
        }
        $name = [System.IO.Path]::GetFileName($FilePath)
        $head = ('--' + $boundary + $nl + 'Content-Disposition: form-data; name="torrentfile"; filename="' + $name + '"' + $nl + 'Content-Type: application/x-bittorrent' + $nl + $nl)
        $hb = $enc.GetBytes($head); $ms.Write($hb, 0, $hb.Length)
        $bytes = [System.IO.File]::ReadAllBytes($FilePath)
        $ms.Write($bytes, 0, $bytes.Length)
        $tail = $enc.GetBytes($nl + '--' + $boundary + '--' + $nl); $ms.Write($tail, 0, $tail.Length)
        $payload = $ms.ToArray()
        $url = ('http://' + $Address + ':' + $Port + '/api/v2/torrents/add')
        $req = @{
            Uri         = $url
            Method      = 'POST'
            Headers     = @{ Referer = ('http://' + $Address + ':' + $Port); Origin = ('http://' + $Address + ':' + $Port) }
            ContentType = ('multipart/form-data; boundary=' + $boundary)
            Body        = $payload
            TimeoutSec  = 30
            ErrorAction = 'Stop'
        }
        if ($Session) { $req['WebSession'] = $Session }
        $r = Invoke-WebRequest @req
        return @{ ok = $true; status = [int]$r.StatusCode; body = [string]$r.Content; error = $null }
    } catch {
        $code = -1
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        return @{ ok = $false; status = $code; body = ''; error = $_.Exception.Message }
    } finally {
        try { $ms.Dispose() } catch { }
    }
}

function Test-GhrdpQbtTorrentAllowed {
    # HTTPS-only artifact, host must match a preset family or an operator own URL.
    # magnet: is refused outright (magnet-only flows are banned by the plan).
    param([string]$Url, [string[]]$OwnUrls = @())
    if (-not $Url) { return @{ ok = $false; reason = 'torrent-url-missing'; preset = ''; host = '' } }
    # Refused schemes come from the policy file: a magnet carries no allowlisted
    # HTTPS artifact host, so magnet-only flows can never enter the lane.
    if ($Url -match '^(?i)magnet:') { return @{ ok = $false; reason = 'magnet-refused'; preset = ''; host = '' } }
    if ($Url -notmatch '^https://') { return @{ ok = $false; reason = 'https-only'; preset = ''; host = '' } }
    $u = $null
    try { $u = [System.Uri]$Url } catch { return @{ ok = $false; reason = 'torrent-url-unparsable'; preset = ''; host = '' } }
    $hostName = $u.Host.ToLowerInvariant()
    foreach ($k in @($script:QbtPresets.Keys)) {
        foreach ($h in @($script:QbtPresets[$k])) {
            if ($hostName -eq $h -or $hostName.EndsWith('.' + $h)) {
                return @{ ok = $true; reason = ''; preset = $k; host = $hostName }
            }
        }
    }
    foreach ($o in @($OwnUrls)) {
        try {
            $ou = [System.Uri]$o
            if ($ou.Host.ToLowerInvariant() -eq $hostName -and $ou.Scheme -eq 'https') {
                return @{ ok = $true; reason = ''; preset = 'operator-own-url'; host = $hostName }
            }
        } catch { }
    }
    return @{ ok = $false; reason = 'torrent-not-allowlisted'; preset = ''; host = $hostName }
}

function Set-GhrdpQbtCategory {
    param([string]$Address, [int]$Port = $script:QbtWebUiPort, [object]$Session = $null)
    $r = Invoke-GhrdpQbtApi -Method 'POST' -Path '/api/v2/torrents/createCategory' -Body @{ category = $script:QbtCategory; savePath = $script:QbtSavePath } -Address $Address -Port $Port -WebSession $Session
    # 409 == already exists, which is the idempotent path.
    return @{ ok = [bool]($r.ok -or $r.status -eq 409); status = $r.status }
}

function Add-GhrdpQbtTorrent {
    # Adds the approved HTTPS artifact, pins category + save path, returns the
    # handle (torrent hash) the progress rail renders. When own-cred is in play the
    # server has already placed the artifact bytes at TorrentFilePath (creds wiped);
    # otherwise the URL is handed to the daemon.
    param(
        [string]$Url,
        [string[]]$OwnUrls = @(),
        [string]$Address,
        [int]$Port = $script:QbtWebUiPort,
        [object]$Session = $null,
        [string]$TorrentFilePath = ''
    )
    $allowed = Test-GhrdpQbtTorrentAllowed -Url $Url -OwnUrls $OwnUrls
    if (-not $allowed.ok) { return @{ ok = $false; handle = ''; reason = $allowed.reason } }
    $null = Set-GhrdpQbtCategory -Address $Address -Port $Port -Session $Session
    $pre = Invoke-GhrdpQbtApi -Method 'POST' -Path '/api/v2/app/setPreferences' -Body @{ json = ('{"save_path":"' + ($script:QbtSavePath -replace '\\', '\\\\') + '"}') } -Address $Address -Port $Port -WebSession $Session
    if (-not $pre.ok) { return @{ ok = $false; handle = ''; reason = ('qbt-setprefs-' + $pre.status) } }
    $body = @{ category = $script:QbtCategory; savepath = $script:QbtSavePath; paused = 'false' }
    if ($TorrentFilePath) {
        $add = Invoke-GhrdpQbtApiFile -FilePath $TorrentFilePath -Address $Address -Port $Port -Session $Session -Fields $body
    } else {
        $body['urls'] = $Url
        $add = Invoke-GhrdpQbtApi -Method 'POST' -Path '/api/v2/torrents/add' -Body $body -Address $Address -Port $Port -WebSession $Session
    }
    if (-not $add.ok) { return @{ ok = $false; handle = ''; reason = ('qbt-add-' + $add.status) } }
    $handle = ''
    try {
        $info = Invoke-GhrdpQbtApi -Method 'GET' -Path ('/api/v2/torrents/info?category=' + $script:QbtCategory) -Address $Address -Port $Port -WebSession $Session
        if ($info.ok) {
            $rows = @($info.body | ConvertFrom-Json)
            if (@($rows).Count -ge 1) { $handle = [string]@($rows)[-1].hash }
        }
    } catch { $handle = '' }
    if (-not $handle) { return @{ ok = $false; handle = ''; reason = 'qbt-handle-unresolved' } }
    return @{ ok = $true; handle = $handle; reason = '' }
}

function Get-GhrdpQbtTorrent {
    param([string]$Handle, [string]$Address, [int]$Port = $script:QbtWebUiPort, [object]$Session = $null)
    if (-not $Handle) { return @{ ok = $false; row = $null; reason = 'handle-required' } }
    $r = Invoke-GhrdpQbtApi -Method 'GET' -Path ('/api/v2/torrents/info?hashes=' + $Handle) -Address $Address -Port $Port -WebSession $Session
    if (-not $r.ok) { return @{ ok = $false; row = $null; reason = ('qbt-info-' + $r.status) } }
    $rows = @($r.body | ConvertFrom-Json)
    if (@($rows).Count -lt 1) { return @{ ok = $false; row = $null; reason = 'handle-gone' } }
    return @{ ok = $true; row = @($rows)[0]; reason = '' }
}

function Remove-GhrdpQbtTorrent {
    # Cancel semantics: the partial artifact is deleted so a cancelled fetch can
    # never reach the watcher; nothing else in the save path is touched.
    param([string]$Handle, [string]$Address, [int]$Port = $script:QbtWebUiPort, [object]$Session = $null, [bool]$DeleteFiles = $true)
    if (-not $Handle) { return @{ ok = $false; reason = 'handle-required' } }
    $r = Invoke-GhrdpQbtApi -Method 'POST' -Path '/api/v2/torrents/delete' -Body @{ hashes = $Handle; deleteFiles = ([string]$DeleteFiles).ToLowerInvariant() } -Address $Address -Port $Port -WebSession $Session
    return @{ ok = [bool]$r.ok; reason = ([string]$('qbt-delete-' + $r.status)) }
}

function Test-GhrdpQbtPublicRefusal {
    # Behavioral tailnet-only proof: the WebUI must refuse a non-tailnet local
    # address. Returns refused=$null with a labeled reason when the host has no
    # non-tailnet IPv4 to probe, so a lab never scores a vacuous PASS.
    param([string]$Address, [int]$Port = $script:QbtWebUiPort)
    $candidate = ''
    try {
        foreach ($a in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
            $ip = [string]$a.IPAddress
            if (-not $ip) { continue }
            if ($ip -match '^127\.') { continue }
            if ($ip -match '^169\.254\.') { continue }
            if (Test-GhrdpQbtTailnetAddress -Ip $ip) { continue }
            $candidate = $ip
            break
        }
    } catch { }
    if (-not $candidate) { return @{ refused = $null; candidate = ''; reason = 'no-public-candidate' } }
    $client = New-Object System.Net.Sockets.TcpClient
    $refused = $true
    try {
        $iar = $client.BeginConnect($candidate, $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(3000, $false)) { $client.EndConnect($iar); $refused = $false }
        else { $refused = $true }
    } catch { $refused = $true }
    finally { try { $client.Close() } catch { } }
    return @{ refused = $refused; candidate = $candidate; reason = '' }
}

function Initialize-GhrdpQbt {
    # One call that main.yml can run: resolve exe, verify SHA (pin/TOFU), resolve the
    # tailnet bind, write the WebUI config. Every failure carries a labeled reason;
    # nothing here silently degrades into an unauthenticated or public listener.
    param([string]$ConfigPath = '', [string]$ConfPath = '', [string]$ShaExpected = '')
    if (-not $script:QbtPolicyOk) { return @{ ok = $false; reason = $script:QbtPolicyReason; exe = ''; address = '' } }
    $exe = Resolve-GhrdpQbtExe
    if (-not $exe.ok) { return @{ ok = $false; reason = $exe.reason; exe = ''; address = '' } }
    $sha = Test-GhrdpQbtShaPin -Path $exe.exe -Expected $ShaExpected
    if (-not $sha.ok) { return @{ ok = $false; reason = $sha.reason; exe = $exe.exe; address = ''; sha256 = $sha.sha256 } }
    $bind = Resolve-GhrdpQbtBindAddress -ConfigPath $ConfigPath
    if (-not $bind.ok) { return @{ ok = $false; reason = $bind.reason; exe = $exe.exe; address = ''; sha256 = $sha.sha256 } }
    $cfg = Set-GhrdpQbtWebUiConfig -Address $bind.address -Port $script:QbtWebUiPort -ConfPath $ConfPath
    return @{ ok = $true; reason = ''; exe = $exe.exe; nox = $exe.nox; sha256 = $sha.sha256; shaMode = $sha.mode; address = $bind.address; bindSource = $bind.source; port = $script:QbtWebUiPort; conf = $cfg.path; category = $script:QbtCategory; savePath = $script:QbtSavePath }
}

function Get-GhrdpQbtTransportReady {
    # Cheap readiness probe for /api/fetch: WebUI answers app/version with a session.
    param([string]$Address, [int]$Port = $script:QbtWebUiPort)
    if (-not $script:QbtPolicyOk) { return @{ ready = $false; reason = $script:QbtPolicyReason; version = '' } }
    $conn = Connect-GhrdpQbt -Address $Address -Port $Port
    if (-not $conn.ok) { return @{ ready = $false; reason = $conn.reason; version = '' } }
    $ver = Get-GhrdpQbtVersion -Address $Address -Port $Port -Session $conn.session
    return @{ ready = [bool]$ver.ok; reason = $(if ($ver.ok) { '' } else { $ver.reason }); version = $ver.version; mode = $conn.mode }
}
