# [F46] Mirror host contract + attempt policy + read-only probe.
#
# ONE implementation for the mirror worker (ghrdp-watcher.ps1), the Diagnose
# surface (ghrdp-server.ps1 /diag) and the Explorer uploader (ghrdp-fx.ps1).
# Dot-sourced - never copied - so the watcher, the server, the lab cell and the
# tests execute the same code.
#
# Ground truth this file answers (watcher log 2026-09-28 12:15-12:19Z): five
# attempts per file, each failing inside the second it started, ~10s apart, and
# the only recorded reason was the bare string "upload failed after 5 tries (all
# hosts; see log)" with NO host/phase/status/message anywhere. The policy below
# is the F44/S3 retry contract (src/components/explorer/api/retryPolicy.ts) in
# PowerShell: fail-fast statuses get exactly ONE attempt, only dns/tcp/tls/http
# are retried, backoff is jittered and a Retry-After hint is a FLOOR.
#
# Legitimate documented usage only (docs/MIRROR-HOSTS.md pins the contract
# fetched from https://gofile.io/api): no user-agent spoofing, no IP/proxy
# switching, no block evasion, no credential in a URL. The token travels in
# the `Authorization: Bearer <token>` header only - never a query-string token, never a URL.

# --- [F46 §2 policy-begin] -------------------------------------------------
# Mirrors src/components/explorer/api/retryPolicy.ts + errors.ts exactly.
$script:F46TransientPhases = @('dns', 'tcp', 'tls', 'http')
$script:F46FailFastStatuses = @(401, 403, 413, 415)
$script:F46MaxAttempts = 5
$script:F46BackoffBaseMs = 500
$script:F46BackoffCapMs = 8000
$script:F46BackoffFloorMs = 100
$script:F46RetryAfterCapMs = 120000
$script:F46AttemptMsgChars = 200
# --- [F46 §2 policy-end] ---------------------------------------------------

# --- [F46 §3 contract-begin] ----------------------------------------------
# Pinned from https://gofile.io/api (fetched 2026-09-28) - see
# docs/MIRROR-HOSTS.md for the verbatim excerpts and the deltas.
$script:F46GofileContract = [ordered]@{
    apiRoot = 'https://api.gofile.io'
    # POST /accounts with body {} -> data.token (guest account). No token needed.
    accountsPath = '/accounts'
    # GET /servers -> data.servers[].name (documented two-step upload flow).
    serversPath = '/servers'
    # Current reference: POST https://upload.gofile.io/uploadfile
    uploadHostAuto = 'upload.gofile.io'
    uploadPathAuto = '/uploadfile'
    # Legacy/documented fleet form: POST https://<server>.gofile.io/contents/uploadfile
    uploadPathFleet = '/contents/uploadfile'
    multipartField = 'file'
    authScheme = 'Bearer'
    # A few endpoints answer HTTP 200 with status=error-*: branch on the
    # envelope, never on the HTTP code alone.
    envelopeField = 'status'
    okStatus = 'ok'
    # Current response data carries `id`; the legacy form carried `fileId`.
    idFields = @('fileId', 'id')
    # Current response data carries `downloadPage`; legacy carried `directLink`.
    pageFields = @('downloadPage', 'directLink')
    codeField = 'code'
}
# --- [F46 §3 contract-end] --------------------------------------------------

function Get-F46DefaultHost {
    # mirrorHosts entry defaults. enabled=false keeps the remediation lock (no
    # mirror upload) until an operator opts in; the attempt is then reported as
    # ONE labeled fail-fast reason instead of five bare failures.
    return [ordered]@{
        id = 'gofile'
        displayName = 'gofile.io'
        apiRoot = 'https://api.gofile.io'
        uploadHostMode = 'auto'
        uploadHost = 'upload.gofile.io'
        uploadPath = '/uploadfile'
        enabled = $false
        autoAccount = $false
        maxFileBytes = 0
        blockedExtensions = @()
        tokenConfigKey = 'gofileToken'
        timeoutSec = 120
    }
}

function Get-F46Hosts {
    # config.json `mirrorHosts` is the ONLY place a host is configured. No entry
    # means the documented default host, still disabled.
    param($Cfg)
    $hosts = @()
    $configured = @()
    try { if ($Cfg -and $Cfg.PSObject.Properties['mirrorHosts']) { $configured = @($Cfg.mirrorHosts) } } catch { $configured = @() }
    foreach ($c in @($configured)) {
        $h = Get-F46DefaultHost
        foreach ($k in @('id', 'displayName', 'apiRoot', 'uploadHostMode', 'uploadHost', 'uploadPath', 'enabled', 'autoAccount', 'maxFileBytes', 'tokenConfigKey', 'timeoutSec')) {
            try {
                if ($c -and $c.PSObject.Properties[$k] -and $null -ne $c.$k) { $h[$k] = $c.$k }
            } catch { }
        }
        $bl = @()
        try { if ($c -and $c.PSObject.Properties['blockedExtensions']) { $bl = @($c.blockedExtensions) } } catch { $bl = @() }
        $h['blockedExtensions'] = @($bl)
        $hosts += $h
    }
    if (@($hosts).Count -eq 0) { $hosts += (Get-F46DefaultHost) }
    return @($hosts)
}

function Select-F46UploadHost {
    # First ENABLED host wins. None enabled is a labeled policy reason, never a
    # silent skip and never a five-try loop.
    param($Hosts)
    foreach ($h in @($Hosts)) {
        $on = $false
        try { $on = [bool]$h.enabled } catch { $on = $false }
        if ($on) { return $h }
    }
    return $null
}

function Get-F46HostToken {
    param($Cfg, [string]$Root, $HostCfg)
    $key = 'gofileToken'
    try { if ($HostCfg -and $HostCfg.tokenConfigKey) { $key = [string]$HostCfg.tokenConfigKey } } catch { }
    $t = ''
    try { if ($Cfg -and $Cfg.PSObject.Properties[$key]) { $t = [string]$Cfg.$key } } catch { $t = '' }
    if (-not $t -and $Root) {
        try {
            $p = Join-Path $Root 'gofile-token.txt'
            if (Test-Path -LiteralPath $p) { $t = ([System.IO.File]::ReadAllText($p)).Trim() }
        } catch { }
    }
    if ($t) { $t = $t.Trim() }
    return $t
}

function Protect-F46SecretText {
    # Every log/artifact surface goes through here: configured secrets first,
    # then bearer/token-shaped text (covers a guestToken echoed by the host).
    param([string]$Text, $Secrets)
    if ($null -eq $Text) { return '' }
    $out = [string]$Text
    foreach ($s in @($Secrets)) {
        $v = [string]$s
        if ($v -and $v.Length -ge 6) { $out = $out.Replace($v, '***REDACTED***') }
    }
    $out = [regex]::Replace($out, '(?i)(bearer\s+)[A-Za-z0-9\._\-]{12,}', '${1}***REDACTED***')
    $out = [regex]::Replace($out, '(?i)((?:token|apikey|api_key|password|passwd|secret)"?\s*[=:]\s*"?)([A-Za-z0-9\._\-]{6,})', '${1}***REDACTED***')
    return $out
}

function Test-F46FailFastStatus {
    param($Status)
    if ($null -eq $Status) { return $false }
    $s = 0
    try { $s = [int]$Status } catch { return $false }
    if ($s -le 0) { return $false }
    return ($script:F46FailFastStatuses -contains $s)
}

function Test-F46TransientPhase {
    # Fail-fast statuses are terminal whatever the phase. Only dns/tcp/tls/http
    # may be retried; encrypt/size/type/auth/parse/policy are terminal.
    param([string]$Phase, $Status)
    if (Test-F46FailFastStatus -Status $Status) { return $false }
    if ($null -eq $Phase) { return $false }
    return ($script:F46TransientPhases -contains ([string]$Phase).ToLower())
}

function Get-F46MaxAttempts {
    param([string]$Phase, $Status)
    if (Test-F46FailFastStatus -Status $Status) { return 1 }
    if (Test-F46TransientPhase -Phase $Phase -Status $Status) { return $script:F46MaxAttempts }
    return 1
}

function Get-F46BackoffMs {
    # Jittered exponential backoff; a Retry-After hint is a FLOOR clamped to
    # 120s (a hostile header must not park the queue). Mirrors backoffDelayMs().
    param([int]$Attempt, $RetryAfterMs, $Rand01)
    $a = [Math]::Max(0, $Attempt)
    $cap = [Math]::Min($script:F46BackoffCapMs, $script:F46BackoffBaseMs * [Math]::Pow(2, $a))
    $r = $Rand01
    if ($null -eq $r) { $r = (Get-Random -Minimum 0 -Maximum 10000) / 10000.0 }
    $r = [Math]::Min(1.0, [Math]::Max(0.0, [double]$r))
    $jittered = $script:F46BackoffFloorMs + ($cap - $script:F46BackoffFloorMs) * $r
    $floor = 0
    if ($null -ne $RetryAfterMs) {
        try { $floor = [Math]::Min([Math]::Max(0, [int]$RetryAfterMs), $script:F46RetryAfterCapMs) } catch { $floor = 0 }
    }
    return [int][Math]::Round([Math]::Max($jittered, $floor))
}

function New-F46AttemptRecord {
    param([int]$N, [string]$HostId, [string]$Phase, $Status, [string]$Message, [int]$Ms, [bool]$Retryable)
    $st = '-'
    if ($null -ne $Status) { if ([string]$Status) { $st = [string]$Status } }
    return [ordered]@{
        n = $N
        host = $HostId
        phase = $Phase
        status = $st
        msg = [string]$Message
        ms = $Ms
        retryable = [bool]$Retryable
        at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
}

function Format-F46AttemptLine {
    # [mirror] attempt n host=<id> phase=<p> status=<s|-> msg=<first 200 chars> ms=<duration>
    param($Attempt)
    $msg = [string]$Attempt.msg
    $msg = $msg -replace '\s+', ' '
    if ($msg.Length -gt $script:F46AttemptMsgChars) { $msg = $msg.Substring(0, $script:F46AttemptMsgChars) }
    return ('[mirror] attempt {0} host={1} phase={2} status={3} msg={4} ms={5}' -f [int]$Attempt.n, [string]$Attempt.host, [string]$Attempt.phase, [string]$Attempt.status, $msg, [int]$Attempt.ms)
}

function Format-F46FailureSummary {
    # The bare "upload failed after 5 tries (all hosts; see log)" string is
    # retired: every terminal line names host + phase + status + attempts.
    param([string]$HostId, [string]$Phase, [string]$Status, [int]$Attempts, [string]$Message)
    return ('[mirror] failed host={0} phase={1} status={2} attempts={3} msg={4}' -f $HostId, $Phase, $Status, $Attempts, $Message)
}

function Format-F46Reason {
    # The exact string the UI error column and the artifact render - complete,
    # never truncated (F44: the full host message is the point).
    param([string]$Phase, $Status, [string]$Message)
    $st = '-'
    if ($null -ne $Status) { if ([string]$Status) { $st = [string]$Status } }
    return ('phase={0} status={1} msg={2}' -f $Phase, $st, [string]$Message)
}

function Format-F46AttemptTableText {
    # Attempt table for the mirror-diag artifact / step summary.
    param($Attempts)
    $lines = @('n host phase status ms retryable at msg')
    foreach ($a in @($Attempts)) {
        $m = [string]$a.msg
        $m = $m -replace '\r?\n', ' | '
        $lines += ('{0} {1} {2} {3} {4} {5} {6} {7}' -f [int]$a.n, [string]$a.host, [string]$a.phase, [string]$a.status, [int]$a.ms, [bool]$a.retryable, [string]$a.at, $m)
    }
    return ($lines -join "`n")
}

function Test-F46UploadPreflight {
    # Attempt 0: per-host limits are decided from config with ZERO network tries.
    param([long]$Size, [string]$Name, $HostCfg)
    $maxBytes = 0
    try { if ($HostCfg -and $HostCfg.maxFileBytes) { $maxBytes = [long]$HostCfg.maxFileBytes } } catch { $maxBytes = 0 }
    if ($maxBytes -gt 0 -and [long]$Size -gt $maxBytes) {
        return @{ ok = $false; phase = 'size'; hostMessage = ('preflight (0 network tries): file is ' + [long]$Size + ' bytes and host ' + [string]$HostCfg.id + ' allows at most ' + $maxBytes + ' (config mirrorHosts[].maxFileBytes)') }
    }
    $ext = ''
    try { $ext = [System.IO.Path]::GetExtension([string]$Name).ToLower() } catch { $ext = '' }
    $blocked = @()
    try { if ($HostCfg) { $blocked = @($HostCfg.blockedExtensions) } } catch { $blocked = @() }
    foreach ($b in @($blocked)) {
        if (([string]$b) -and $ext -eq ([string]$b).ToLower()) {
            return @{ ok = $false; phase = 'type'; hostMessage = ('preflight (0 network tries): ' + $ext + ' is on the blocked-type list for host ' + [string]$HostCfg.id + ' (config mirrorHosts[].blockedExtensions)') }
        }
    }
    return @{ ok = $true; phase = $null; hostMessage = '' }
}

function ConvertFrom-F46Json {
    param([string]$Text)
    if (-not $Text) { return $null }
    try { return ($Text | ConvertFrom-Json) } catch { return $null }
}

function Get-F46Prop {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $null }
    try { if ($Obj.PSObject.Properties[$Name]) { return $Obj.$Name } } catch { }
    return $null
}

function Get-F46String {
    param($Obj, [string]$Name)
    $v = Get-F46Prop -Obj $Obj -Name $Name
    if ($null -eq $v) { return '' }
    return [string]$v
}

function Get-F46FirstString {
    # First non-empty value among the documented field names (contract aliases).
    param($Obj, $Names)
    if ($null -eq $Obj) { return '' }
    foreach ($n in @($Names)) {
        $v = Get-F46String -Obj $Obj -Name ([string]$n)
        if ($v) { return $v }
    }
    return ''
}

function Get-F46RetryAfterMs {
    param($RetryAfterHeader)
    $v = [string]$RetryAfterHeader
    if (-not $v) { return $null }
    $sec = 0
    if ([int]::TryParse($v.Trim(), [ref]$sec)) {
        if ($sec -lt 0) { return 0 }
        return ($sec * 1000)
    }
    $dt = [datetime]::MinValue
    try {
        if ([datetime]::TryParse($v.Trim(), [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$dt)) {
            $ms = [int](( $dt.ToUniversalTime() - (Get-Date).ToUniversalTime()).TotalMilliseconds)
            if ($ms -lt 0) { return 0 }
            return $ms
        }
    } catch { }
    return $null
}

function Get-F46GofileErrorClass {
    # Documented error statuses (https://gofile.io/api#common-error-statuses).
    # Fail-fast is the default: an unknown error-* is never retried blindly.
    param([string]$StatusText, $HttpStatus)
    $raw = ([string]$StatusText).Trim()
    $msg = ''
    if (-not $raw) { $msg = 'host answered without a status envelope' } else { $msg = ('host status=' + $raw) }
    $s = $raw.ToLower()
    switch -Regex ($s) {
        '^error-token$|^error-owner$|^error-notowner$|^error-notpremium$|^error-accountid$' { return @{ phase = 'auth'; retryable = $false; message = $msg } }
        '^error-ratelimit$' { return @{ phase = 'http'; retryable = $true; message = $msg } }
        '^error-limits$' { return @{ phase = 'size'; retryable = $false; message = $msg } }
        '^error-notfound$|^error-field|^error-contentsid|^error-rootfolder|^error-protectedfolder' { return @{ phase = 'parse'; retryable = $false; message = $msg } }
        default {
            $isFailFast = Test-F46FailFastStatus -Status $HttpStatus
            if ($isFailFast) { return @{ phase = 'auth'; retryable = $false; message = $msg } }
            return @{ phase = 'http'; retryable = $false; message = $msg }
        }
    }
}

function New-F46GofileAccount {
    # DOCUMENTED step 1 (POST https://api.gofile.io/accounts with {} -> a guest
    # account token). Never silent: only reached when the host config sets
    # autoAccount=true (see docs/MIRROR-HOSTS.md). The token is returned to the
    # caller and never logged.
    param([string]$ApiRoot = 'https://api.gofile.io', [int]$TimeoutSec = 30)
    $uri = $ApiRoot.TrimEnd('/') + [string]$script:F46GofileContract.accountsPath
    $body = '{}'
    $r = [System.Net.WebRequest]::Create($uri)
    $r.Method = 'POST'
    $r.ContentType = 'application/json'
    $r.Timeout = $TimeoutSec * 1000
    $r.ReadWriteTimeout = $TimeoutSec * 1000
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $r.ContentLength = $bytes.Length
    $rs = $r.GetRequestStream()
    $rs.Write($bytes, 0, $bytes.Length)
    $rs.Close()
    $resp = $r.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $text = $sr.ReadToEnd()
    $sr.Close()
    $resp.Close()
    $json = ConvertFrom-F46Json -Text $text
    $status = Get-F46String $json 'status'
    $token = Get-F46FirstString (Get-F46Prop $json 'data') @('token')
    if ($status -ne [string]$script:F46GofileContract.okStatus -or -not $token) {
        return @{ ok = $false; token = ''; message = ('account creation failed: status=' + $status) }
    }
    return @{ ok = $true; token = $token; message = 'guest account created (documented POST /accounts)' }
}

function Get-F46UploadTarget {
    # auto  -> https://upload.gofile.io/uploadfile (current reference)
    # fleet -> GET /servers then https://<server>/contents/uploadfile (documented
    #          two-step flow; the servers endpoint is what the brief pinned)
    param($HostCfg, [int]$TimeoutSec = 30)
    $apiRoot = [string]$HostCfg.apiRoot
    $mode = 'auto'
    try { if ($HostCfg.uploadHostMode) { $mode = ([string]$HostCfg.uploadHostMode).ToLower() } } catch { $mode = 'auto' }
    if ($mode -ne 'fleet') {
        $uh = [string]$HostCfg.uploadHost
        if (-not $uh) { $uh = [string]$script:F46GofileContract.uploadHostAuto }
        $up = [string]$HostCfg.uploadPath
        if (-not $up) { $up = [string]$script:F46GofileContract.uploadPathAuto }
        return @{ ok = $true; uri = ('https://' + $uh + $up); phase = $null; message = ''; server = $uh; mode = 'auto' }
    }
    $uri = $apiRoot.TrimEnd('/') + [string]$script:F46GofileContract.serversPath
    try {
        $req = [System.Net.WebRequest]::Create($uri)
        $req.Method = 'GET'
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        $req.Accept = 'application/json'
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        $json = ConvertFrom-F46Json -Text $text
        $status = Get-F46String $json 'status'
        if ($status -and $status -ne [string]$script:F46GofileContract.okStatus) {
            $cls = Get-F46GofileErrorClass -StatusText $status -HttpStatus $null
            return @{ ok = $false; uri = ''; phase = $cls.phase; message = ('servers endpoint refused: ' + $cls.message); server = ''; mode = 'fleet' }
        }
        $data = Get-F46Prop $json 'data'
        $list = Get-F46Prop $data 'servers'
        if ($null -eq $list) { $list = $data }
        $name = ''
        foreach ($s in @($list)) {
            $name = Get-F46String $s 'name'
            if ($name) { break }
        }
        if (-not $name) {
            return @{ ok = $false; uri = ''; phase = 'parse'; message = 'servers endpoint returned no usable store host'; server = ''; mode = 'fleet' }
        }
        return @{ ok = $true; uri = ('https://' + $name + [string]$script:F46GofileContract.uploadPathFleet); phase = $null; message = ''; server = $name; mode = 'fleet' }
    } catch [System.Net.WebException] {
        $phase = 'http'
        try { if ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::NameResolutionFailure) { $phase = 'dns' } } catch { }
        return @{ ok = $false; uri = ''; phase = $phase; message = ('servers endpoint transport failed: ' + $_.Exception.Message); server = ''; mode = 'fleet' }
    } catch {
        return @{ ok = $false; uri = ''; phase = 'http'; message = ('servers endpoint failed: ' + $_.Exception.Message); server = ''; mode = 'fleet' }
    }
}

function Send-F46GofileUpload {
    # The upload itself: multipart/form-data, field name `file`, token in the
    # Authorization header (never in the URL). Streamed - a multi-GB file is
    # never buffered in memory. Returns ok/phase/httpStatus/hostMessage plus the
    # documented response fields (code, file id, downloadPage).
    param($HostCfg, [string]$Path, [string]$Name, [string]$Token, [int]$TimeoutSec = 120, $Target = $null)
    if (-not $Target) { $Target = Get-F46UploadTarget -HostCfg $HostCfg -TimeoutSec ([Math]::Min($TimeoutSec, 30)) }
    if (-not $Target.ok) { return @{ ok = $false; phase = $Target.phase; httpStatus = $null; hostMessage = $Target.message; retryAfterMs = $null } }
    $fileLen = 0
    try { $fileLen = (Get-Item -LiteralPath $Path).Length } catch { return @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = ('upload source unreadable: ' + $_.Exception.Message); retryAfterMs = $null } }
    $boundary = '----ghrdpF46' + [guid]::NewGuid().ToString('N')
    $safeName = ([string]$Name) -replace '[\r\n"]', '_'
    $enc = [System.Text.Encoding]::UTF8
    $prefix = ('--' + $boundary + "`r`n" + 'Content-Disposition: form-data; name="' + [string]$script:F46GofileContract.multipartField + '"; filename="' + $safeName + '"' + "`r`n" + 'Content-Type: application/octet-stream' + "`r`n`r`n")
    $suffix = ("`r`n" + '--' + $boundary + '--' + "`r`n")
    $prefixBytes = $enc.GetBytes($prefix)
    $suffixBytes = $enc.GetBytes($suffix)
    $req = $null
    $fs = $null
    try {
        $req = [System.Net.WebRequest]::Create([string]$Target.uri)
        $req.Method = 'POST'
        $req.ContentType = ('multipart/form-data; boundary=' + $boundary)
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        $req.Accept = 'application/json'
        if ($Token) { $req.Headers['Authorization'] = ([string]$script:F46GofileContract.authScheme + ' ' + $Token) }
        $req.ContentLength = $prefixBytes.Length + [long]$fileLen + $suffixBytes.Length
        $rs = $req.GetRequestStream()
        $rs.Write($prefixBytes, 0, $prefixBytes.Length)
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $buf = New-Object byte[] 65536
        $read = 0
        while (($read = $fs.Read($buf, 0, $buf.Length)) -gt 0) { $rs.Write($buf, 0, $read) }
        $rs.Write($suffixBytes, 0, $suffixBytes.Length)
        $rs.Close()
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $retryAfter = $null
        try { $retryAfter = Get-F46RetryAfterMs -RetryAfterHeader $resp.Headers['Retry-After'] } catch { $retryAfter = $null }
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        return (ConvertFrom-F46UploadResponse -Text $text -HttpStatus $code -RetryAfterMs $retryAfter)
    } catch [System.Net.WebException] {
        $phase = 'http'
        $msg = $_.Exception.Message
        try {
            if ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::NameResolutionFailure) { $phase = 'dns' }
            elseif ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) { $phase = 'tcp' }
            elseif ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::TrustFailure) { $phase = 'tls' }
            elseif ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::SecureChannelFailure) { $phase = 'tls' }
        } catch { }
        $code = $null
        $bodyText = ''
        $retryAfter = $null
        try {
            if ($_.Exception.Response) {
                $code = [int]$_.Exception.Response.StatusCode
                $sr2 = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $bodyText = $sr2.ReadToEnd()
                $sr2.Close()
                try { $retryAfter = Get-F46RetryAfterMs -RetryAfterHeader $_.Exception.Response.Headers['Retry-After'] } catch { $retryAfter = $null }
            }
        } catch { }
        if ($code -and $code -gt 0) {
            $full = ('HTTP ' + $code + ': ' + $bodyText)
            return (ConvertFrom-F46UploadResponse -Text $bodyText -HttpStatus $code -RetryAfterMs $retryAfter -TransportMessage $full)
        }
        return @{ ok = $false; phase = $phase; httpStatus = $null; hostMessage = ('transport failed (' + $phase + '): ' + $msg); retryAfterMs = $retryAfter }
    } catch {
        return @{ ok = $false; phase = 'http'; httpStatus = $null; hostMessage = ('upload failed: ' + $_.Exception.Message); retryAfterMs = $null }
    } finally {
        try { if ($fs) { $fs.Dispose() } } catch { }
        try { if ($req) { $req.Abort() } } catch { }
    }
}

function ConvertFrom-F46UploadResponse {
    # Envelope + documented-field parsing shared by success and error bodies.
    param([string]$Text, $HttpStatus, $RetryAfterMs, [string]$TransportMessage = '')
    $json = ConvertFrom-F46Json -Text $Text
    $status = ''
    if ($json) { $status = Get-F46String $json 'status' }
    if ((-not $status) -and $HttpStatus -and [int]$HttpStatus -ge 200 -and [int]$HttpStatus -lt 300) {
        $head = [string]$Text
        if ($head.Length -gt 400) { $head = $head.Substring(0, 400) }
        return @{ ok = $false; phase = 'parse'; httpStatus = $HttpStatus; hostMessage = ('HTTP ' + $HttpStatus + ' but the body is not a gofile envelope: ' + $head); retryAfterMs = $RetryAfterMs }
    }
    if ($status -and $status -ne [string]$script:F46GofileContract.okStatus) {
        $cls = Get-F46GofileErrorClass -StatusText $status -HttpStatus $HttpStatus
        $httpText = ''
        if ($HttpStatus) { $httpText = ('HTTP ' + $HttpStatus + ' ') }
        return @{ ok = $false; phase = $cls.phase; httpStatus = $HttpStatus; hostMessage = ($httpText + $cls.message); retryAfterMs = $RetryAfterMs }
    }
    if ($HttpStatus -and ([int]$HttpStatus -lt 200 -or [int]$HttpStatus -ge 300)) {
        $head = [string]$Text
        if ($head.Length -gt 800) { $head = $head.Substring(0, 800) }
        $phase = 'http'
        try {
            if ([int]$HttpStatus -eq 401 -or [int]$HttpStatus -eq 403) { $phase = 'auth' }
            elseif ([int]$HttpStatus -eq 413) { $phase = 'size' }
            elseif ([int]$HttpStatus -eq 415) { $phase = 'type' }
        } catch { }
        $msg = $TransportMessage
        if (-not $msg) { $msg = ('HTTP ' + $HttpStatus + ': ' + $head) }
        return @{ ok = $false; phase = $phase; httpStatus = $HttpStatus; hostMessage = $msg; retryAfterMs = $RetryAfterMs }
    }
    $data = Get-F46Prop $json 'data'
    $fileId = Get-F46FirstString $data $script:F46GofileContract.idFields
    $code = Get-F46FirstString $data @([string]$script:F46GofileContract.codeField)
    $page = Get-F46FirstString $data $script:F46GofileContract.pageFields
    if (-not $fileId -and -not $code -and -not $page) {
        $head = [string]$Text
        if ($head.Length -gt 400) { $head = $head.Substring(0, 400) }
        return @{ ok = $false; phase = 'parse'; httpStatus = $HttpStatus; hostMessage = ('status=ok but no file id/code/downloadPage in the response data: ' + $head); retryAfterMs = $RetryAfterMs }
    }
    return @{ ok = $true; phase = $null; httpStatus = $HttpStatus; hostMessage = ''; fileId = $fileId; code = $code; downloadPage = $page; directUrl = $page; retryAfterMs = $RetryAfterMs }
}

function Invoke-F46MirrorAttempt {
    # ONE attempt, fully classified. Preflight (size/type), policy (host not
    # enabled), credential hold and the encrypt lock all produce a labeled
    # terminal reason with ZERO network tries.
    param($HostCfg, [string]$Path, [string]$Name, [long]$Size, [string]$Token, [int]$AttemptNo = 1, $Transport = $null, [bool]$EncryptRequested = $false, [bool]$Encrypted = $false, [int]$TimeoutSec = 0)
    $hostId = 'none'
    if ($HostCfg) { $hostId = [string]$HostCfg.id }
    $started = Get-Date
    $emit = {
        param($Phase, $Status, $Message, $Retryable, $Extra)
        $ms = [int]((Get-Date) - $started).TotalMilliseconds
        $rec = New-F46AttemptRecord -N $AttemptNo -HostId $hostId -Phase $Phase -Status $Status -Message $Message -Ms $ms -Retryable $Retryable
        $out = @{ ok = $false; phase = $Phase; httpStatus = $Status; hostMessage = $Message; retryAfterMs = $null; attemptNo = $AttemptNo; record = $rec; fileId = ''; code = ''; downloadPage = ''; directUrl = ''; durationMs = $ms }
        if ($Extra) { foreach ($k in @($Extra.Keys)) { $out[$k] = $Extra[$k] } }
        return $out
    }
    if (-not $HostCfg) {
        return (& $emit 'policy' $null 'no mirror host is enabled (config mirrorHosts[].enabled=false). The mirror worker does not attempt an upload and does not retry - see docs/MIRROR-HOSTS.md for the operator options.' $false $null)
    }
    if ($EncryptRequested -and -not $Encrypted) {
        return (& $emit 'encrypt' $null 'encryptMode requests AES-256 but the encryptor is unavailable on this runner (remediation lock) - refusing to upload plaintext' $false $null)
    }
    $pre = Test-F46UploadPreflight -Size $Size -Name $Name -Host $HostCfg
    if (-not $pre.ok) { return (& $emit $pre.phase $null $pre.hostMessage $false $null) }
    if (-not $Token) {
        $auto = $false
        try { $auto = [bool]$HostCfg.autoAccount } catch { $auto = $false }
        if (-not $auto) {
            return (& $emit 'auth' $null 'no host credential configured (config gofileToken / gofile-token.txt) and autoAccount=false - upload not attempted' $false $null)
        }
        $tries = 0
        $acct = $null
        while ($tries -lt 2 -and (-not $acct -or -not $acct.ok)) {
            $tries = $tries + 1
            try { $acct = New-F46GofileAccount -ApiRoot ([string]$HostCfg.apiRoot) -TimeoutSec 30 } catch { $acct = @{ ok = $false; token = ''; message = ('account creation failed: ' + $_.Exception.Message) } }
        }
        if (-not $acct.ok) { return (& $emit 'auth' $null ([string]$acct.message) $false $null) }
        $Token = [string]$acct.token
    }
    if ($Transport) {
        $raw = $null
        try { $raw = (& $Transport $HostCfg $Path $Name $Size $Token) } catch { $raw = @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = ('mock transport threw: ' + $_.Exception.Message); retryAfterMs = $null } }
        if ($null -eq $raw) { $raw = @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = 'mock transport returned no result'; retryAfterMs = $null } }
        $ms = [int]((Get-Date) - $started).TotalMilliseconds
        $phase = 'http'
        try { if ($raw.phase) { $phase = [string]$raw.phase } } catch { $phase = 'http' }
        $st = $null
        try { if ($null -ne $raw.httpStatus) { $st = $raw.httpStatus } } catch { $st = $null }
        $msg = ''
        try { $msg = [string]$raw.hostMessage } catch { $msg = '' }
        $retry = $false
        try { if ($null -ne $raw.retryable) { $retry = [bool]$raw.retryable } else { $retry = (Test-F46TransientPhase -Phase $phase -Status $st) } } catch { $retry = (Test-F46TransientPhase -Phase $phase -Status $st) }
        $rec = New-F46AttemptRecord -N $AttemptNo -HostId $hostId -Phase $phase -Status $st -Message $msg -Ms $ms -Retryable $retry
        $out = @{ ok = [bool]$raw.ok; phase = $phase; httpStatus = $st; hostMessage = $msg; retryAfterMs = $null; attemptNo = $AttemptNo; record = $rec; fileId = ''; code = ''; downloadPage = ''; directUrl = ''; durationMs = $ms }
        try { if ($raw.retryAfterMs) { $out['retryAfterMs'] = $raw.retryAfterMs } } catch { }
        try { $out['fileId'] = [string]$raw.fileId } catch { }
        try { $out['code'] = [string]$raw.code } catch { }
        try { $out['downloadPage'] = [string]$raw.downloadPage } catch { }
        # the worker/UI link is the download page when the host did not return a
        # separate direct URL (current reference returns downloadPage, legacy
        # returned directLink) - never a fabricated link.
        try { $out['directUrl'] = [string]$raw.directUrl } catch { }
        if (-not $out['directUrl']) { $out['directUrl'] = [string]$out['downloadPage'] }
        return $out
    }
    $to = 120
    if ($TimeoutSec -gt 0) { $to = $TimeoutSec } elseif ($HostCfg -and $HostCfg.timeoutSec) { try { $to = [int]$HostCfg.timeoutSec } catch { $to = 120 } }
    $res = Send-F46GofileUpload -HostCfg $HostCfg -Path $Path -Name $Name -Token $Token -TimeoutSec $to
    $ms2 = [int]((Get-Date) - $started).TotalMilliseconds
    $phase2 = 'http'
    try { if ($res.phase) { $phase2 = [string]$res.phase } } catch { $phase2 = 'http' }
    $st2 = $null
    try { if ($null -ne $res.httpStatus) { $st2 = $res.httpStatus } } catch { $st2 = $null }
    $msg2 = ''
    try { $msg2 = [string]$res.hostMessage } catch { $msg2 = '' }
    $ok2 = $false
    try { $ok2 = [bool]$res.ok } catch { $ok2 = $false }
    $retry2 = $false
    if (-not $ok2) { $retry2 = (Test-F46TransientPhase -Phase $phase2 -Status $st2) }
    $rec2 = New-F46AttemptRecord -N $AttemptNo -HostId $hostId -Phase $phase2 -Status $st2 -Message $msg2 -Ms $ms2 -Retryable $retry2
    $out2 = @{ ok = $ok2; phase = $phase2; httpStatus = $st2; hostMessage = $msg2; retryAfterMs = $null; attemptNo = $AttemptNo; record = $rec2; fileId = ''; code = ''; downloadPage = ''; directUrl = ''; durationMs = $ms2 }
    try { if ($res.retryAfterMs) { $out2['retryAfterMs'] = $res.retryAfterMs } } catch { }
    try { $out2['fileId'] = [string]$res.fileId } catch { }
    try { $out2['code'] = [string]$res.code } catch { }
    try { $out2['downloadPage'] = [string]$res.downloadPage } catch { }
    try { $out2['directUrl'] = [string]$res.directUrl } catch { }
    return $out2
}

function Invoke-F46MirrorUploadWithPolicy {
    # Whole-file loop with the F44/S3 policy. The watcher makes one attempt per
    # scan and schedules the next with Get-F46BackoffMs; this loop exists so the
    # lab can prove the attempt counts per status without a live host and without
    # waiting for wall-clock backoff ($Sleeper is injectable).
    param($HostCfg, [string]$Path, [string]$Name, [long]$Size, [string]$Token, $Transport = $null, [bool]$EncryptRequested = $false, [bool]$Encrypted = $false, [scriptblock]$Sleeper = $null, $Rand01 = $null)
    $attempts = New-Object System.Collections.ArrayList
    $n = 0
    $ok = $false
    $last = $null
    while (-not $ok) {
        $n = $n + 1
        $last = Invoke-F46MirrorAttempt -HostCfg $HostCfg -Path $Path -Name $Name -Size $Size -Token $Token -AttemptNo $n -Transport $Transport -EncryptRequested $EncryptRequested -Encrypted $Encrypted
        [void]$attempts.Add($last.record)
        if ($last.ok) { $ok = $true; break }
        $max = Get-F46MaxAttempts -Phase $last.phase -Status $last.httpStatus
        if ($n -ge $max) { break }
        $delay = Get-F46BackoffMs -Attempt ($n - 1) -RetryAfterMs $last.retryAfterMs -Rand01 $Rand01
        if ($Sleeper) { & $Sleeper $delay }
    }
    return @{
        ok = $ok
        attempts = @($attempts)
        attemptsUsed = $n
        phase = $(if ($last) { $last.phase } else { 'parse' })
        httpStatus = $(if ($last) { $last.httpStatus } else { $null })
        hostMessage = $(if ($last) { $last.hostMessage } else { '' })
        fileId = $(if ($last) { $last.fileId } else { '' })
        code = $(if ($last) { $last.code } else { '' })
        downloadPage = $(if ($last) { $last.downloadPage } else { '' })
        link = $(if ($last) { $last.directUrl } else { '' })
    }
}

function Invoke-F46HostProbe {
    # §5 READ-ONLY probe: HEAD/GET the API root of every configured host.
    # No content is uploaded, no credential is sent, no body content is parsed.
    # Rows are { host, status, note } and are what the step summary +
    # the Diagnose output render. All-403 from a runner egress is a documented
    # policy dead-end, never something to evade.
    param($Hosts, [int]$TimeoutSec = 8, $Transport = $null)
    $rows = @()
    foreach ($h in @($Hosts)) {
        $id = 'gofile'
        try { if ($h.id) { $id = [string]$h.id } } catch { }
        $apiRoot = ''
        try { $apiRoot = ([string]$h.apiRoot).TrimEnd('/') } catch { $apiRoot = '' }
        if (-not $apiRoot) { $rows += @{ host = $id; status = '-'; note = 'no apiRoot configured' }; continue }
        if ($Transport) {
            $raw = $null
            try { $raw = (& $Transport $h $apiRoot) } catch { $raw = $null }
            if ($null -eq $raw) { $rows += @{ host = $id; status = '-'; note = 'probe transport returned nothing' }; continue }
            $rows += @{ host = $id; status = $(if ($null -ne $raw.status) { [string]$raw.status } else { '-' }); note = [string]$raw.note }
            continue
        }
        $serversUri = $apiRoot + [string]$script:F46GofileContract.serversPath
        $status = '-'
        $note = ''
        $done = $false
        try {
            $req = [System.Net.WebRequest]::Create($serversUri)
            $req.Method = 'GET'
            $req.Timeout = $TimeoutSec * 1000
            $req.ReadWriteTimeout = $TimeoutSec * 1000
            $req.Accept = 'application/json'
            $resp = $req.GetResponse()
            $status = [string]([int]$resp.StatusCode)
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $text = $sr.ReadToEnd()
            $sr.Close()
            $resp.Close()
            $json = ConvertFrom-F46Json -Text $text
            $envStatus = Get-F46String $json 'status'
            if ($envStatus -and $envStatus -ne [string]$script:F46GofileContract.okStatus) {
                $note = ('read-only GET ' + [string]$script:F46GofileContract.serversPath + ' answered envelope status=' + $envStatus + ' (no upload attempted)')
            } else {
                $note = ('read-only GET ' + [string]$script:F46GofileContract.serversPath + ' reachable; upload flow is documented + enabled=' + [string]$h.enabled)
            }
            $done = $true
        } catch [System.Net.WebException] {
            $we = $_.Exception
            if ($we.Response) {
                try { $status = [string]([int]$we.Response.StatusCode) } catch { $status = '-' }
                if ($status -eq '403' -or $status -eq '401') {
                    $note = 'runner egress rejected (' + $status + ') - policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion)'
                } elseif ($status -eq '429') {
                    $note = 'rate limited (429) at the API root - back off; the probe never changes identity'
                } else {
                    $note = 'HTTP ' + $status + ' from the API root (read-only probe)'
                }
            } else {
                $note = 'transport failure: ' + $we.Status + ' - ' + $we.Message
            }
            $done = $true
        } catch {
            $note = 'probe failed: ' + $_.Exception.Message
            $done = $true
        }
        if (-not $done) { $note = 'probe did not complete' }
        $rows += @{ host = $id; status = $status; note = $note }
    }
    return @($rows)
}

function Format-F46ProbeTable {
    param($Rows)
    $lines = @('host status note')
    foreach ($r in @($Rows)) { $lines += ('{0} {1} {2}' -f [string]$r.host, [string]$r.status, [string]$r.note) }
    return ($lines -join "`n")
}
