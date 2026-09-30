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
# switching, no block evasion, no credential anywhere. [F48 §0] TOKEN-LESS
# MIRROR MODE: uploads are a guest multipart POST (field `file`) to the pinned
# anonymous endpoint with NO Authorization, NO X-Gofile-Token, NO Cookie header
# toward the host, ever. A host that answers 401/403 gets ONE labeled terminal
# reason (host requires account token; token-less mode unsupported) plus the
# operator options - never a retry loop and never a credential workaround.

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
    # [F48 §0] GET /servers -> data.servers[].name (read-only probe + the
    # documented two-step upload flow). The account-minting POST /accounts rung
    # was removed with all token plumbing: the guest contract needs no account.
    serversPath = '/servers'
    # Current reference: POST https://upload.gofile.io/uploadfile
    uploadHostAuto = 'upload.gofile.io'
    uploadPathAuto = '/uploadfile'
    # Legacy/documented fleet form: POST https://<server>.gofile.io/contents/uploadfile
    uploadPathFleet = '/contents/uploadfile'
    multipartField = 'file'
    # [F48 §0] guest contract: NO Authorization / X-Gofile-Token / Cookie header
    # is ever attached to a host request. The scheme is a CONTRACT constant,
    # never a per-attempt choice:
    # production uploads are https. The lab points one host at a local listener
    # over http to prove the wire contract; no other value is honoured anywhere.
    uploadScheme = 'https'
    # [F47 §3] encrypted parts are stamped with the mirror mime the Explorer
    # preview allowlist already carries (payloads/ghrdp-fx.ps1 $FxPreviewMime),
    # so the legacy Explorer decrypt path recognises them.
    encryptedMime = 'application/x-ghrdp-mirror'
    plainMime = 'application/octet-stream'
    encryptedSuffix = '.ghenc'
    # [F47 §3] AES-256: a 32-byte key, 12-byte GCM nonce, 16-byte tag.
    keyBytes = 32
    gcmNonceBytes = 12
    gcmTagBytes = 16
    # Container magic for the GCM form: 'GHRDPMIR' + ver + alg + nonce + tag.
    containerMagic = 'GHRDPMIR'
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

# --- [F52 telemetry + lane truth] -----------------------------------------
function Add-F52ProgressTypes {
    if ('Ghrdp.Mirror.ProgressContent' -as [type]) { return }
    if (-not ('System.Net.Http.HttpClient' -as [type])) { Add-Type -AssemblyName System.Net.Http }
    $cs = Join-Path $PSScriptRoot 'ghrdp-mirror-progress.cs'
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        Add-Type -Path $cs -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Net.Http.dll') -ErrorAction Stop
    } else { Add-Type -Path $cs -ErrorAction Stop }
}

function ConvertTo-F52JsonSafe {
    # Keep Int64 IN MEMORY; JSON numbers above JavaScript's exact range become
    # decimal strings. Recurse without mutating the worker's live objects.
    param($Value)
    if ($null -eq $Value) { return $null }
    if (($Value -is [long]) -or ($Value -is [uint64])) {
        if ([decimal]$Value -gt 9007199254740991 -or [decimal]$Value -lt -9007199254740991) {
            return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        }
        return $Value
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $obj = [ordered]@{}
        foreach ($k in @($Value.Keys)) { $obj[$k] = ConvertTo-F52JsonSafe $Value[$k] }
        return $obj
    }
    if ($Value -is [array] -or $Value -is [System.Collections.IList]) {
        $list = @()
        foreach ($v in $Value) { $list += ,(ConvertTo-F52JsonSafe $v) }
        return ,$list
    }
    if ($Value -is [pscustomobject]) {
        $obj = [ordered]@{}
        foreach ($prop in $Value.PSObject.Properties) { $obj[$prop.Name] = ConvertTo-F52JsonSafe $prop.Value }
        return $obj
    }
    return $Value
}

function Get-F52WorkerMode {
    param($Cfg, [bool]$Auto = $false)
    # Downloads ALWAYS encrypt, including a plaintext-elected dispatch. A
    # dashboard runtime opt-in also overrides the manual dispatch election.
    if ($Auto) { return 'all' }
    if (Get-F49RuntimeOptIn -Cfg $Cfg) { return 'all' }
    $elected = $false
    try { $elected = ($Cfg.mirrorPlaintextElection -eq $true) } catch { }
    if ($elected) { return 'none' }
    return 'all'
}

function ConvertTo-F52Progress {
    param($Snapshot, [long]$Size, [string]$HostId, [string]$WorkerMode, [int]$AttemptNo = 1)
    $sent = [long]$Snapshot.BytesSent
    $window = [long]$Snapshot.WindowBytes
    $speed = [double]$Snapshot.SpeedBps
    $eta = $null
    if ($window -gt 0 -and $speed -gt 0 -and -not $Snapshot.Stalled) {
        $eta = [double]([decimal][Math]::Max([long]0, ($Size - $sent)) / [decimal]$speed)
    }
    $label = ''
    if ($window -eq 0 -or $Snapshot.Stalled) { $label = ('stalled (no bytes in ' + [int]$Snapshot.NoBytesSeconds + 's)') }
    return [ordered]@{
        host = $HostId; phase = 'http'; status = $(if ($Snapshot.Failed) { 'failed' } elseif ($label) { 'stalled' } else { 'uploading' })
        n = $AttemptNo; ms = [long]($Snapshot.ElapsedSeconds * 1000); msg = $label
        encryptMode = $WorkerMode; bytesSent = $sent; size = [long]$Size
        windowBytes = $window; windowSeconds = [double]$Snapshot.WindowSeconds
        speedBps = $(if ($label) { [double]0 } else { $speed }); etaSeconds = $eta
        noBytesSeconds = [int]$Snapshot.NoBytesSeconds; stallWindows = [int]$Snapshot.StallWindows
        stalled = [bool]($label); stallLabel = $label; lastSocketText = [string]$Snapshot.LastMessage
        at = (Get-Date).ToUniversalTime().ToString('o')
    }
}

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
        uploadScheme = 'https'
        enabled = $false
        maxFileBytes = $null # null = unknown; NOT a proven unlimited host
        blockedExtensions = @()
        # [F48 §1.3] 'guest' is the token-less contract this module always
        # attempts; it flips to 'requires-account' only from a probe or first
        # attempt result (401/403), never from the presence of any secret.
        authMode = 'guest'
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
        foreach ($k in @('id', 'displayName', 'apiRoot', 'uploadHostMode', 'uploadHost', 'uploadPath', 'uploadScheme', 'enabled', 'maxFileBytes', 'authMode', 'timeoutSec')) {
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

function Protect-F46SecretText {
    # Every log/artifact surface goes through here: configured secrets first,
    # then any stray token-shaped text - including bare `token=` strings a host
    # or a stale fixture may echo ([F48 §1.2] the redaction set greps them).
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

function New-F46MirrorKey {
    # [F47 §3] PER-RUN AES-256 KEY: 32 cryptographically random bytes, returned
    # base64. The stage step stores it in config `mirrorKey` (the ONE place it
    # lives). F52 keeps it runner-local: no key or fragment in the UI. It is
    # redacted from every log line, attempt record, artifact and URL.
    param([int]$Bytes = 32)
    $n = $Bytes
    if ($n -le 0) { $n = [int]$script:F46GofileContract.keyBytes }
    $buf = New-Object byte[] $n
    $rng = $null
    try {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($buf)
    } finally { try { if ($rng) { $rng.Dispose() } } catch { } }
    return [Convert]::ToBase64String($buf)
}

function Get-F46MirrorKeyBytes {
    # 32 bytes or NOTHING: a short, padded or garbled key is refused, never
    # silently stretched into a weaker key.
    param([string]$KeyBase64)
    $txt = ([string]$KeyBase64).Trim()
    if (-not $txt) { return $null }
    try {
        $k = [Convert]::FromBase64String($txt)
        if (@($k).Length -ne [int]$script:F46GofileContract.keyBytes) { return $null }
        return $k
    } catch { return $null }
}

function Test-F46AesGcmUsable {
    # [F47 §3] AES-256-GCM is the documented mode. Availability is PROVEN by a
    # real 16-byte encrypt+decrypt round trip on this runner, never assumed from
    # a version string: a runner whose .NET cannot bind AesGcm reports $false
    # and the caller falls back to the legacy AES-256-CBC+PBKDF2 container
    # (docs/decrypt.html decrypts that one in the browser). Both are AES-256;
    # which one ran is recorded per file and in the attempt table.
    try {
        $t = [System.Security.Cryptography.AesGcm]
        if (-not $t) { return $false }
        $key = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($key) } finally { try { $rng.Dispose() } catch { } }
        $aes = New-F46AesGcm -Key $key
        if (-not $aes) { return $false }
        try {
            $nonce = New-Object byte[] ([int]$script:F46GofileContract.gcmNonceBytes)
            $rng2 = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng2.GetBytes($nonce) } finally { try { $rng2.Dispose() } catch { } }
            $pt = [System.Text.Encoding]::UTF8.GetBytes('ghrdp-f47-selftest')
            $ct = New-Object byte[] $pt.Length
            $tag = New-Object byte[] ([int]$script:F46GofileContract.gcmTagBytes)
            $aes.Encrypt($nonce, $pt, $ct, $tag)
            $back = New-Object byte[] $pt.Length
            $aes.Decrypt($nonce, $ct, $tag, $back)
            return ([System.Text.Encoding]::UTF8.GetString($back) -eq 'ghrdp-f47-selftest')
        } finally { try { $aes.Dispose() } catch { } }
    } catch { return $false }
}

function New-F46AesGcm {
    # .NET 8 wants (key, tagSizeInBytes); .NET Core 3.x-7 only had (key).
    param([byte[]]$Key)
    try { return ([System.Security.Cryptography.AesGcm]::new($Key, [int]$script:F46GofileContract.gcmTagBytes)) } catch { }
    try { return ([System.Security.Cryptography.AesGcm]::new($Key)) } catch { }
    return $null
}

function Invoke-F46EncryptFile {
    # [F52] Bounded AES-256-CBC/PBKDF2-SHA256 in the existing .ghenc form.
    # StreamOnly is the worker path: encryption follows the socket's pull,
    # never allocates/stages a whole ciphertext, and has no client-side cap.
    # The file-output path remains for the F47 round-trip lab and local tools.
    param([string]$Path, [string]$OutPath = '', [string]$KeyBase64, [switch]$StreamOnly)
    $key = Get-F46MirrorKeyBytes -KeyBase64 $KeyBase64
    if ($null -eq $key) { return @{ ok = $false; alg = ''; bytes = [long]0; message = 'mirrorKey is not 32 base64-decoded bytes - refusing to upload plaintext' } }
    $source = $null
    $output = $null
    try {
        Add-F52ProgressTypes
        $source = New-Object Ghrdp.Mirror.EncryptedSource($Path, ([byte[]]$key))
        $len = [long]$source.WireLength
        if ($StreamOnly) { return @{ ok = $true; alg = 'AES-256-CBC-PBKDF2'; bytes = $len; stream = $source; message = '' } }
        $output = [System.IO.File]::Open($OutPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
        $source.CopyTo($output, 1048576)
        $output.Flush()
        return @{ ok = $true; alg = 'AES-256-CBC-PBKDF2'; bytes = $len; message = '' }
    } catch {
        try { if ($source) { $source.Dispose() } } catch { }
        return @{ ok = $false; alg = ''; bytes = [long]0; message = ('encryption failed: ' + $_.Exception.GetBaseException().Message + '; refusing to upload plaintext') }
    } finally {
        try { if ($output) { $output.Dispose() } } catch { }
        try { if ($source -and -not $StreamOnly) { $source.Dispose() } } catch { }
        try { [Array]::Clear($key, 0, $key.Length) } catch { }
    }
}

function Invoke-F46DecryptFile {
    # [F47 §3] The inverse, so the operator (and the lab's round-trip proof)
    # can open what the worker uploaded. Header-driven: GHRDPMIR => GCM,
    # otherwise the legacy salt|iv|CBC container.
    param([string]$Path, [string]$OutPath, [string]$KeyBase64)
    $key = Get-F46MirrorKeyBytes -KeyBase64 $KeyBase64
    if ($null -eq $key) { return @{ ok = $false; alg = ''; message = 'mirrorKey is not 32 bytes' } }
    $blob = $null
    try { $blob = [System.IO.File]::ReadAllBytes($Path) } catch { return @{ ok = $false; alg = ''; message = ('ciphertext unreadable: ' + $_.Exception.Message) } }
    $magic = [System.Text.Encoding]::ASCII.GetBytes([string]$script:F46GofileContract.containerMagic)
    $isGcm = $true
    if ($blob.Length -lt ($magic.Length + 3)) { $isGcm = $false }
    else { for ($i = 0; $i -lt $magic.Length; $i++) { if ($blob[$i] -ne $magic[$i]) { $isGcm = $false } } }
    try {
        if ($isGcm) {
            $p = $magic.Length
            $ver = [int]$blob[$p]; $p = $p + 1
            $algId = [int]$blob[$p]; $p = $p + 1
            if ($ver -ne 1 -or $algId -ne 1) { return @{ ok = $false; alg = ''; message = ('unknown container ver=' + $ver + ' alg=' + $algId) } }
            $nLen = [int]$blob[$p]; $p = $p + 1
            $nonce = New-Object byte[] $nLen
            [Array]::Copy($blob, $p, $nonce, 0, $nLen); $p = $p + $nLen
            $tLen = [int]$blob[$p]; $p = $p + 1
            $tag = New-Object byte[] $tLen
            [Array]::Copy($blob, $p, $tag, 0, $tLen); $p = $p + $tLen
            $ct = New-Object byte[] ($blob.Length - $p)
            [Array]::Copy($blob, $p, $ct, 0, $ct.Length)
            $aes = New-F46AesGcm -Key $key
            if (-not $aes) { return @{ ok = $false; alg = 'AES-256-GCM'; message = 'this runner cannot construct AesGcm to decrypt' } }
            try {
                $pt = New-Object byte[] $ct.Length
                $aes.Decrypt($nonce, $ct, $tag, $pt)
                [System.IO.File]::WriteAllBytes($OutPath, $pt)
                return @{ ok = $true; alg = 'AES-256-GCM'; message = '' }
            } finally { try { $aes.Dispose() } catch { } }
        }
        $salt = New-Object byte[] 16
        $iv = New-Object byte[] 16
        [Array]::Copy($blob, 0, $salt, 0, 16)
        [Array]::Copy($blob, 16, $iv, 0, 16)
        $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(([System.Text.Encoding]::UTF8.GetString($key)), $salt, 100000, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
        try {
            $a = [System.Security.Cryptography.Aes]::Create()
            try {
                $a.KeySize = 256
                $a.Key = $kdf.GetBytes(32)
                $a.IV = $iv
                $a.Mode = [System.Security.Cryptography.CipherMode]::CBC
                $a.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
                $dec = $a.CreateDecryptor()
                try {
                    $pt2 = $dec.TransformFinalBlock($blob, 32, $blob.Length - 32)
                    [System.IO.File]::WriteAllBytes($OutPath, $pt2)
                    return @{ ok = $true; alg = 'AES-256-CBC-PBKDF2'; message = '' }
                } finally { try { $dec.Dispose() } catch { } }
            } finally { try { $a.Dispose() } catch { } }
        } finally { try { $kdf.Dispose() } catch { } }
    } catch { return @{ ok = $false; alg = ''; message = ('decryption failed: ' + $_.Exception.Message) } }
    return @{ ok = $false; alg = ''; message = 'decryption produced no output' }
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

# [F52] A missing cap is UNKNOWN, not unlimited. Only an explicit byte-valued
# maxFileBytes in a successful GET /servers envelope is host-cap evidence.
function ConvertTo-F52CapBytes {
    param($Value)
    try {
        if ($null -eq $Value -or [string]$Value -eq '') { return $null }
        $n = [long]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture)
        if ($n -gt 0) { return $n }
    } catch { }
    return $null
}

function Get-F52ServersCap {
    param($Json, $HostCfg)
    if ((Get-F46String $Json 'status') -ne 'ok') { return $null }
    $data = Get-F46Prop $Json 'data'
    $globalCap = ConvertTo-F52CapBytes (Get-F46Prop $data 'maxFileBytes')
    if ($null -ne $globalCap) { return $globalCap }
    $servers = @(Get-F46Prop $data 'servers')
    if ([string]$HostCfg.uploadHostMode -eq 'fleet') {
        # Same fixed first usable server as Get-F46UploadTarget.
        foreach ($srv in $servers) {
            if (Get-F46String $srv 'name') { return (ConvertTo-F52CapBytes (Get-F46Prop $srv 'maxFileBytes')) }
        }
        return $null
    }
    # The automatic endpoint may select any listed server. A per-server limit
    # applies to that endpoint only when ALL usable servers advertise it and
    # agree. Missing/mixed caps cannot honestly become an automatic-host cap.
    $caps = @()
    foreach ($srv in $servers) {
        if (-not (Get-F46String $srv 'name')) { continue }
        $n = ConvertTo-F52CapBytes (Get-F46Prop $srv 'maxFileBytes')
        if ($null -eq $n) { return $null }
        $caps += $n
    }
    if ($caps.Count -gt 0 -and @($caps | Select-Object -Unique).Count -eq 1) { return [long]$caps[0] }
    return $null
}

function Set-F52HostCap {
    param($HostCfg, $Rows)
    if (-not $HostCfg) { return $null }
    foreach ($row in @($Rows)) {
        if ([string]$row.host -ne [string]$HostCfg.id) { continue }
        $cap = ConvertTo-F52CapBytes $row.maxFileBytes
        if ($null -ne $cap) {
            $configured = ConvertTo-F52CapBytes $HostCfg.maxFileBytes
            if ($null -eq $configured -or $cap -le $configured) {
                $HostCfg['maxFileBytes'] = [long]$cap
                $HostCfg['capSource'] = 'GET /servers maxFileBytes (advertised, not upload-proven)'
            }
        }
    }
    return $HostCfg
}

function Get-F52HostMatrix {
    param([string]$Root, $Hosts)
    $path = Join-Path $Root 'mirror-probe.json'
    try {
        if (Test-Path -LiteralPath $path) { return @([System.IO.File]::ReadAllText($path) | ConvertFrom-Json) }
    } catch { }
    $rows = @(Invoke-F46HostProbe -Hosts $Hosts -TimeoutSec 8)
    try { [System.IO.File]::WriteAllText($path, ((ConvertTo-F52JsonSafe $rows) | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false))) } catch { }
    return @($rows)
}

function Test-F46UploadPreflight {
    # Attempt 0: per-host limits are decided from config with ZERO network tries.
    param([long]$Size, [string]$Name, $HostCfg)
    $maxBytes = 0
    try { if ($HostCfg -and $HostCfg.maxFileBytes) { $maxBytes = [long]$HostCfg.maxFileBytes } } catch { $maxBytes = 0 }
    if ($maxBytes -gt 0 -and [long]$Size -gt $maxBytes) {
        $source = 'config mirrorHosts[].maxFileBytes'
        try { if ($HostCfg.capSource) { $source = [string]$HostCfg.capSource } } catch { }
        return @{ ok = $false; phase = 'size'; hostMessage = ('preflight (0 network tries; network=0): file is ' + [long]$Size + ' bytes and host ' + [string]$HostCfg.id + ' allows at most ' + $maxBytes + ' bytes (' + $source + ')') }
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

function Format-F48AuthReason {
    # [F48 §2] The ONE labeled terminal reason for a 401/403 (or auth-class
    # envelope) answer to an unauthenticated guest attempt: fail-fast (no
    # retry loop) + the rendered operator options. The original host message
    # is appended, never truncated (F44).
    param([string]$Message)
    $reason = 'host requires account token; token-less mode unsupported (authMode=requires-account). Operator options: (1) disable mirror (mirror_enable=false); (2) self-hosted operator target; (3) token mode - a separate future decision, out of scope here.'
    if ($Message) { return ($reason + ' | ' + $Message) }
    return $reason
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
        # [F47] scheme comes from the CONTRACT (https); only a host config that
        # explicitly says http (the local lab listener) can lower it.
        $sch = ([string]$script:F46GofileContract.uploadScheme).ToLower()
        try { if (([string]$HostCfg.uploadScheme).ToLower() -eq 'http') { $sch = 'http' } } catch { }
        return @{ ok = $true; uri = ($sch + '://' + $uh + $up); phase = $null; message = ''; server = $uh; mode = 'auto' }
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

function New-F46UploadRequestSpec {
    # [F48 §0] The ONE place the multipart contract is assembled: field name
    # `file` and the part Content-Type - application/octet-stream for a
    # plaintext upload, application/x-ghrdp-mirror for an encrypted one. The
    # request carries ONLY Accept; no Authorization, no X-Gofile-Token, no
    # Cookie header toward the host ever exists. The lab asserts this spec AND
    # the bytes a local listener receives, so the contract cannot drift
    # between the two proof lanes.
    param($HostCfg, [string]$Name, [string]$Boundary, [string]$ContentType = '')
    $fieldName = [string]$script:F46GofileContract.multipartField
    $ct = [string]$ContentType
    if (-not $ct) { $ct = [string]$script:F46GofileContract.plainMime }
    $safeName = ([string]$Name) -replace '[\r\n"]', '_'
    $headers = [ordered]@{ 'Accept' = 'application/json' }
    $partHeader = ('--' + $Boundary + "`r`n" + 'Content-Disposition: form-data; name="' + $fieldName + '"; filename="' + $safeName + '"' + "`r`n" + 'Content-Type: ' + $ct + "`r`n`r`n")
    return [ordered]@{
        fieldName = $fieldName
        fileName = $safeName
        partContentType = $ct
        boundary = $Boundary
        requestContentType = ('multipart/form-data; boundary=' + $Boundary)
        headers = $headers
        partHeader = $partHeader
        partTrailer = ("`r`n" + '--' + $Boundary + '--' + "`r`n")
    }
}

function Get-F53DeclaredPartLength {
    # [F53] Content-Length is the container formula when the source publishes
    # WireLength. Never a plaintext Length, never an index FileEntry.size.
    param($UploadSource, [string]$Path)
    if ($UploadSource) {
        $wire = $null
        try { $wire = $UploadSource.PSObject.Properties['WireLength'] } catch { $wire = $null }
        if ($wire -and $null -ne $wire.Value) { return [long]$wire.Value }
        return [long]$UploadSource.Length
    }
    return [long](Get-Item -LiteralPath $Path).Length
}

function New-F46UploadContent {
    # [F53] The only multipart-framing owner. Send and the dry-run measure
    # both call this; a second framing writer would double the boundary bytes.
    param($Stream, [long]$Length, $State, $Spec, [string]$Boundary)
    $innerContent = New-Object System.Net.Http.StreamContent($Stream, 1048576)
    $fileContent = New-Object Ghrdp.Mirror.ProgressContent($innerContent, $Length, $State)
    $disp = New-Object System.Net.Http.Headers.ContentDispositionHeaderValue('form-data')
    $disp.Name = '"' + [string]$Spec.fieldName + '"'
    $disp.FileName = '"' + [string]$Spec.fileName + '"'
    $fileContent.Headers.ContentDisposition = $disp
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse([string]$Spec.partContentType)
    # Part length is materialized before the multipart length is read.
    $null = $fileContent.Headers.ContentLength
    $mp = New-Object System.Net.Http.MultipartFormDataContent($Boundary)
    $mp.Add($fileContent)
    # MultipartContent is IEnumerable. A bare return would unwrap it to the
    # file part and drop the framing (name="file" / part Content-Type).
    return ,$mp
}

function Measure-F53Upload {
    # Dry-run serialized length. CountingStream, no socket.
    param($Stream, [long]$Length, $Spec, [string]$Boundary, $State)
    if (-not $State) { $State = New-Object Ghrdp.Mirror.ProgressState(60) }
    $mp = New-F46UploadContent -Stream $Stream -Length $Length -State $State -Spec $Spec -Boundary $Boundary
    $declared = $mp.Headers.ContentLength
    if ($null -eq $declared) { throw 'multipart Content-Length is null; framing=chunked is not the guest path' }
    $count = New-Object Ghrdp.Mirror.CountingStream
    $mp.CopyToAsync($count).GetAwaiter().GetResult()
    $dry = [long]$count.Count
    $mp.Dispose()
    return @{ declared = [long]$declared; partSum = [long]$Length; dryRun = $dry; framing = ($dry - [long]$Length); framingMode = 'content-length' }
}

function Set-F53PendingRetry {
    # A pending/retrying row is not a finished upload. Zero the failed
    # attempt's socket count so the row cannot render 100%.
    param($Entry, [int]$AttemptNo, [int]$DelayMs)
    $Entry['bytesSent'] = [long]0
    $Entry['pct'] = 0
    $Entry['phase'] = 'queued'
    $Entry['status'] = 'pending'
    $Entry['attempt'] = ([int]$AttemptNo + 1)
    $Entry['retryInMs'] = [int]$DelayMs
    return $Entry
}

function Send-F46GofileUpload {
    # [F48 §0] The upload itself: guest multipart/form-data, field name `file`,
    # NO auth header of any kind (never a credential in the URL either).
    # [F50 §2] TRANSPORT REWRITE (Thread B): the body is streamed with
    # HttpClient + MultipartFormDataContent + StreamContent(FileStream). The
    # file is never materialised in memory - no whole-file byte array, no
    # buffering request stream. (The previous HttpWebRequest path relied on the
    # in-box request buffering, whose 2GB ceiling surfaced as the runner
    # failure "Stream was too long" on large uploads.) Multi-GB files now go
    # to the wire in bounded chunks straight from the FileStream.
    # [F47 §3] $ContentType stamps the part: the encrypted path passes
    # application/x-ghrdp-mirror, the plaintext path stays octet-stream.
    # Returns ok/phase/httpStatus/hostMessage plus the documented response
    # fields (code, file id, downloadPage).
    param($HostCfg, [string]$Path, [string]$Name, [int]$TimeoutSec = 120, $Target = $null, [string]$ContentType = '', $ProgressAction = $null, $UploadSource = $null, [int]$StallWindowSec = 60, [string]$WorkerMode = '', [int]$AttemptNo = 1)
    if (-not $Target) { $Target = Get-F46UploadTarget -HostCfg $HostCfg -TimeoutSec ([Math]::Min($TimeoutSec, 30)) }
    if (-not $Target.ok) { return @{ ok = $false; phase = $Target.phase; httpStatus = $null; hostMessage = $Target.message; retryAfterMs = $null } }
    $fileLen = [long]0
    try { $fileLen = [long](Get-F53DeclaredPartLength -UploadSource $UploadSource -Path $Path) } catch { return @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = ('upload source unreadable: ' + $_.Exception.Message); retryAfterMs = $null } }
    if (-not ('System.Net.Http.HttpClient' -as [type])) { try { Add-Type -AssemblyName System.Net.Http } catch { } }
    $boundary = '----ghrdpF46' + [guid]::NewGuid().ToString('N')
    $spec = New-F46UploadRequestSpec -HostCfg $HostCfg -Name $Name -Boundary $boundary -ContentType $ContentType
    $client = $null
    $req = $null
    $mp = $null
    $fs = $null
    $cancel = $null
    $state52 = $null
    try {
        Add-F52ProgressTypes
        # Shortened stall clocks are a loopback LAB seam only.
        if ($StallWindowSec -ne 60 -and -not ([uri]$Target.uri).IsLoopback) { throw 'F52: shortened stall windows are loopback-lab only' }
        $state52 = New-Object Ghrdp.Mirror.ProgressState($StallWindowSec)
        $state52.Reset()
        $cancel = New-Object System.Threading.CancellationTokenSource
        if ($UploadSource) { $fs = $UploadSource } else { $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite) }
        # [F50] StreamContent over the FileStream: bounded-chunk wire I/O, no
        # whole-file byte array anywhere in this path. [F53] one framing owner.
        $mp = New-F46UploadContent -Stream $fs -Length $fileLen -State $state52 -Spec $spec -Boundary $boundary
        $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, [string]$Target.uri)
        foreach ($hk in @($spec.headers.Keys)) {
            # [F48] the spec only ever carries Accept: no auth header exists to
            # set, and no other header is ever added toward the host.
            if (([string]$hk) -eq 'Accept') { $req.Headers.Accept.ParseAdd([string]$spec.headers[$hk]) } else { $req.Headers.TryAddWithoutValidation([string]$hk, [string]$spec.headers[$hk]) | Out-Null }
        }
        $req.Content = $mp
        $client = [Ghrdp.Mirror.GuestClient]::Create()
        # A whole-request timeout is a hidden large-file cap. Only the three
        # no-byte windows cancel a transfer; progress keeps any size alive.
        $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
        $task52 = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseContentRead, $cancel.Token)
        while (-not $task52.IsCompleted) {
            $snap52 = $state52.Snapshot()
            $progress52 = ConvertTo-F52Progress -Snapshot $snap52 -Size $fileLen -HostId ([string]$HostCfg.id) -WorkerMode $WorkerMode -AttemptNo $AttemptNo
            if ($ProgressAction) { & $ProgressAction $progress52 | Out-Null }
            if ($snap52.Failed) {
                $state52.CancelForStall()
                $cancel.Cancel()
                return @{ ok = $false; phase = 'http'; httpStatus = $null; hostMessage = ($progress52.stallLabel + ' | last socket/host text: ' + $snap52.LastMessage); retryAfterMs = $null; bytesSent = [long]$snap52.BytesSent; progress = $progress52 }
            }
            try { [void]$task52.Wait(250) } catch { break }
        }
        $resp = $task52.GetAwaiter().GetResult()
        $progress52 = ConvertTo-F52Progress -Snapshot ($state52.Snapshot()) -Size $fileLen -HostId ([string]$HostCfg.id) -WorkerMode $WorkerMode -AttemptNo $AttemptNo
        if ($ProgressAction) { & $ProgressAction $progress52 | Out-Null }
        $code = [int]$resp.StatusCode
        $retryAfter = $null
        $ra = $null
        try { $ra = $resp.Headers.RetryAfter } catch { $ra = $null }
        # [F50] DeltaSeconds is a Nullable<TimeSpan>: pwsh unwraps it to a bare
        # TimeSpan, so the parse must not lean on .Value. The F44 contract says
        # a Retry-After hint is ALWAYS honored, so the typed parse is backed by
        # a raw-header fallback before it may stay null.
        if ($ra -and ($null -ne $ra.DeltaSeconds)) {
            $ds50 = $ra.DeltaSeconds
            if ($ds50 -is [TimeSpan]) { $retryAfter = [int]$ds50.TotalMilliseconds }
            else { $retryAfter = Get-F46RetryAfterMs -RetryAfterHeader ([string]$ds50) }
        } elseif ($ra -and $ra.Date) {
            $retryAfter = Get-F46RetryAfterMs -RetryAfterHeader ($ra.Date.Value.ToString('R'))
        }
        if (-not $retryAfter) {
            $ravals = $null
            try { if ($resp.Headers.TryGetValues('Retry-After', [ref]$ravals)) { if ($ravals) { $retryAfter = Get-F46RetryAfterMs -RetryAfterHeader ([string]@($ravals)[0]) } } } catch { }
        }
        $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $resp.Dispose()
        $result52 = ConvertFrom-F46UploadResponse -Text $text -HttpStatus $code -RetryAfterMs $retryAfter
        $result52['bytesSent'] = [long]$progress52.bytesSent
        $result52['progress'] = $progress52
        return $result52
    } catch {
        # [F50] transport failures: phase comes from the inner socket/host
        # exception, keeping the F44 dns/tcp/tls ladder honest on BOTH runtimes
        # (Windows PowerShell 5.1 wraps a WebException; pwsh/.NET surfaces a
        # SocketException or an AuthenticationException directly).
        $phase = 'http'
        $msg = $_.Exception.Message
        try {
            $inner = $_.Exception.InnerException
            while ($inner) {
                if ($inner -is [System.Net.WebException]) {
                    $msg = $inner.Message
                    if ($inner.Status -eq [System.Net.WebExceptionStatus]::NameResolutionFailure) { $phase = 'dns' }
                    elseif ($inner.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) { $phase = 'tcp' }
                    elseif ($inner.Status -eq [System.Net.WebExceptionStatus]::TrustFailure) { $phase = 'tls' }
                    elseif ($inner.Status -eq [System.Net.WebExceptionStatus]::SecureChannelFailure) { $phase = 'tls' }
                    break
                }
                if ($inner -is [System.Net.Sockets.SocketException]) {
                    $msg = $inner.Message
                    $sec = $inner.SocketErrorCode
                    if ($sec -eq [System.Net.Sockets.SocketError]::HostNotFound -or $sec -eq [System.Net.Sockets.SocketError]::NoData -or $sec -eq [System.Net.Sockets.SocketError]::TryAgain) { $phase = 'dns' }
                    elseif ($sec -eq [System.Net.Sockets.SocketError]::ConnectionRefused -or $sec -eq [System.Net.Sockets.SocketError]::TimedOut -or $sec -eq [System.Net.Sockets.SocketError]::NetworkUnreachable -or $sec -eq [System.Net.Sockets.SocketError]::HostUnreachable) { $phase = 'tcp' }
                    break
                }
                if ($inner -is [System.Security.Authentication.AuthenticationException]) { $msg = $inner.Message; $phase = 'tls'; break }
                $inner = $inner.InnerException
            }
        } catch { }
        $sent52 = [long]0
        $progress52 = $null
        if ($state52) {
            $state52.SocketMessage($msg)
            $progress52 = ConvertTo-F52Progress -Snapshot ($state52.Snapshot()) -Size $fileLen -HostId ([string]$HostCfg.id) -WorkerMode $WorkerMode -AttemptNo $AttemptNo
            $sent52 = [long]$progress52.bytesSent
            if ($ProgressAction) { & $ProgressAction $progress52 | Out-Null }
        }
        return @{ ok = $false; phase = $phase; httpStatus = $null; hostMessage = ('transport failed (' + $phase + '): ' + $msg); retryAfterMs = $null; bytesSent = $sent52; progress = $progress52 }
    } finally {
        try { if ($req) { $req.Dispose() } } catch { }
        try { if ($mp) { $mp.Dispose() } } catch { }
        try { if ($fs) { $fs.Dispose() } } catch { }
        try { if ($client) { $client.Dispose() } } catch { }
        try { if ($cancel) { $cancel.Dispose() } } catch { }
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
    # enabled) and the encrypt lock produce a labeled terminal reason with
    # ZERO network tries. [F48 §2] the attempt itself is ALWAYS the unauthenticated
    # guest multipart POST: a 401/403 answer is ONE fail-fast attempt labeled
    # 'host requires account token; token-less mode unsupported' (+ operator
    # options), never a retry loop and never a credential.
    param($HostCfg, [string]$Path, [string]$Name, [long]$Size, [int]$AttemptNo = 1, $Transport = $null, [bool]$EncryptRequested = $false, [bool]$Encrypted = $false, [int]$TimeoutSec = 0, [string]$ContentType = '', $ProgressAction = $null, $UploadSource = $null, [string]$WorkerMode = '', [int]$StallWindowSec = 60, [string]$WorkerLane = 'manual')
    $hostId = 'none'
    if ($HostCfg) { $hostId = [string]$HostCfg.id }
    $started = Get-Date
    if (-not $WorkerMode) { $WorkerMode = $(if ($EncryptRequested) { 'all' } else { 'none' }) }
    $emit = {
        param($Phase, $Status, $Message, $Retryable, $Extra)
        $ms = [int]((Get-Date) - $started).TotalMilliseconds
        $rec = New-F46AttemptRecord -N $AttemptNo -HostId $hostId -Phase $Phase -Status $Status -Message $Message -Ms $ms -Retryable $Retryable
        $rec['encryptMode'] = $WorkerMode; $rec['encrypted'] = [bool]$Encrypted
        $out = @{ ok = $false; phase = $Phase; httpStatus = $Status; hostMessage = $Message; retryAfterMs = $null; attemptNo = $AttemptNo; record = $rec; fileId = ''; code = ''; downloadPage = ''; directUrl = ''; durationMs = $ms }
        if ($Extra) { foreach ($k in @($Extra.Keys)) { $out[$k] = $Extra[$k] } }
        return $out
    }
    if (-not $HostCfg) {
        return (& $emit 'policy' $null 'no mirror host is enabled (config mirrorHosts[].enabled=false). The mirror worker does not attempt an upload and does not retry - see docs/MIRROR-HOSTS.md for the operator options.' $false $null)
    }
    if ($WorkerLane -ne 'manual' -and ($WorkerMode -ne 'all' -or -not $EncryptRequested -or -not $Encrypted)) {
        return (& $emit 'encrypt' $null 'F52 STOP: auto/runtime encryption defect; refusing to upload plaintext (one fix loop required)' $false $null)
    }
    if ($EncryptRequested -and -not $Encrypted) {
        return (& $emit 'encrypt' $null 'encryptMode requests AES-256 but the encryptor is unavailable on this runner (remediation lock) - refusing to upload plaintext' $false $null)
    }
    $pre = Test-F46UploadPreflight -Size $Size -Name $Name -HostCfg $HostCfg
    if (-not $pre.ok) { return (& $emit $pre.phase $null $pre.hostMessage $false $null) }
    if ($Transport) {
        $raw = $null
        try { $raw = (& $Transport $HostCfg $Path $Name $Size) } catch { $raw = @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = ('mock transport threw: ' + $_.Exception.Message); retryAfterMs = $null } }
        if ($null -eq $raw) { $raw = @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = 'mock transport returned no result'; retryAfterMs = $null } }
        $ms = [int]((Get-Date) - $started).TotalMilliseconds
        $phase = 'http'
        try { if ($raw.phase) { $phase = [string]$raw.phase } } catch { $phase = 'http' }
        $st = $null
        try { if ($null -ne $raw.httpStatus) { $st = $raw.httpStatus } } catch { $st = $null }
        $msg = ''
        try { $msg = [string]$raw.hostMessage } catch { $msg = '' }
        # [F48 §2] auth refusal => labeled reason + requires-account, ONE attempt.
        $authMode = 'guest'
        if ($phase -eq 'auth') { $msg = (Format-F48AuthReason -Message $msg); $authMode = 'requires-account' }
        $retry = $false
        try { if ($null -ne $raw.retryable) { $retry = [bool]$raw.retryable } else { $retry = (Test-F46TransientPhase -Phase $phase -Status $st) } } catch { $retry = (Test-F46TransientPhase -Phase $phase -Status $st) }
        if ($phase -eq 'auth') { $retry = $false }
        $rec = New-F46AttemptRecord -N $AttemptNo -HostId $hostId -Phase $phase -Status $st -Message $msg -Ms $ms -Retryable $retry
        $rec['encryptMode'] = $WorkerMode; $rec['encrypted'] = [bool]$Encrypted
        $out = @{ ok = [bool]$raw.ok; phase = $phase; httpStatus = $st; hostMessage = $msg; retryAfterMs = $null; attemptNo = $AttemptNo; record = $rec; fileId = ''; code = ''; downloadPage = ''; directUrl = ''; durationMs = $ms; authMode = $authMode }
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
    $res = Send-F46GofileUpload -HostCfg $HostCfg -Path $Path -Name $Name -TimeoutSec $to -ContentType $ContentType -ProgressAction $ProgressAction -UploadSource $UploadSource -WorkerMode $WorkerMode -AttemptNo $AttemptNo -StallWindowSec $StallWindowSec
    $ms2 = [int]((Get-Date) - $started).TotalMilliseconds
    $phase2 = 'http'
    try { if ($res.phase) { $phase2 = [string]$res.phase } } catch { $phase2 = 'http' }
    $st2 = $null
    try { if ($null -ne $res.httpStatus) { $st2 = $res.httpStatus } } catch { $st2 = $null }
    $msg2 = ''
    try { $msg2 = [string]$res.hostMessage } catch { $msg2 = '' }
    $ok2 = $false
    try { $ok2 = [bool]$res.ok } catch { $ok2 = $false }
    # [F48 §2] auth refusal => labeled reason + requires-account, ONE attempt.
    $authMode2 = 'guest'
    if ($phase2 -eq 'auth') { $msg2 = (Format-F48AuthReason -Message $msg2); $authMode2 = 'requires-account' }
    $retry2 = $false
    if (-not $ok2) { $retry2 = (Test-F46TransientPhase -Phase $phase2 -Status $st2) }
    if ($phase2 -eq 'auth') { $retry2 = $false }
    $rec2 = New-F46AttemptRecord -N $AttemptNo -HostId $hostId -Phase $phase2 -Status $st2 -Message $msg2 -Ms $ms2 -Retryable $retry2
    $rec2['encryptMode'] = $WorkerMode; $rec2['encrypted'] = [bool]$Encrypted
    $out2 = @{ ok = $ok2; phase = $phase2; httpStatus = $st2; hostMessage = $msg2; retryAfterMs = $null; attemptNo = $AttemptNo; record = $rec2; fileId = ''; code = ''; downloadPage = ''; directUrl = ''; durationMs = $ms2; authMode = $authMode2 }
    try { if ($res.retryAfterMs) { $out2['retryAfterMs'] = $res.retryAfterMs } } catch { }
    try { $out2['fileId'] = [string]$res.fileId } catch { }
    try { $out2['code'] = [string]$res.code } catch { }
    try { $out2['downloadPage'] = [string]$res.downloadPage } catch { }
    try { $out2['directUrl'] = [string]$res.directUrl } catch { }
    $out2['bytesSent'] = [long]$res.bytesSent
    $out2['progress'] = $res.progress
    $rec2['bytesSent'] = [long]$res.bytesSent
    return $out2
}

function Invoke-F46MirrorUploadWithPolicy {
    # Whole-file loop with the F44/S3 policy. The watcher makes one attempt per
    # scan and schedules the next with Get-F46BackoffMs; this loop exists so the
    # lab can prove the attempt counts per status without a live host and without
    # waiting for wall-clock backoff ($Sleeper is injectable).
    param($HostCfg, [string]$Path, [string]$Name, [long]$Size, $Transport = $null, [bool]$EncryptRequested = $false, [bool]$Encrypted = $false, [scriptblock]$Sleeper = $null, $Rand01 = $null, [string]$ContentType = '')
    $attempts = New-Object System.Collections.ArrayList
    $n = 0
    $ok = $false
    $last = $null
    while (-not $ok) {
        $n = $n + 1
        $last = Invoke-F46MirrorAttempt -HostCfg $HostCfg -Path $Path -Name $Name -Size $Size -AttemptNo $n -Transport $Transport -EncryptRequested $EncryptRequested -Encrypted $Encrypted -ContentType $ContentType
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
        authMode = $(if ($last -and $last.authMode) { $last.authMode } else { '' })
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
            $rows += @{ host = $id; status = $(if ($null -ne $raw.status) { [string]$raw.status } else { '-' }); note = [string]$raw.note; maxFileBytes = (ConvertTo-F52CapBytes $raw.maxFileBytes); maxProvenBytes = $null; capEvidence = 'advertised-only' }
            continue
        }
        $serversUri = $apiRoot + [string]$script:F46GofileContract.serversPath
        $status = '-'
        $note = ''
        $done = $false
        $maxFileBytes = $null
        $servers52 = @()
        $probeWatch = [System.Diagnostics.Stopwatch]::StartNew()
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
            $maxFileBytes = Get-F52ServersCap -Json $json -HostCfg $h
            foreach ($srv52 in @(Get-F46Prop (Get-F46Prop $json 'data') 'servers')) {
                $servers52 += [ordered]@{ name = (Get-F46String $srv52 'name'); maxFileBytes = (ConvertTo-F52CapBytes (Get-F46Prop $srv52 'maxFileBytes')) }
            }
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
                    $note = 'runner egress rejected (' + $status + ') - token-less guest probe refused (authMode=requires-account); policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion)'
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
        $note += (' | maxFileBytes=' + $(if ($null -ne $maxFileBytes) { [string]$maxFileBytes } else { 'unknown' }) + '; max-proven=unknown (read-only, no upload acceptance proven)')
        $rows += @{ host = $id; phase = 'size'; status = $status; ms = [long]$probeWatch.ElapsedMilliseconds; msg = $note; note = $note; maxFileBytes = $maxFileBytes; maxProvenBytes = $null; capEvidence = 'advertised-only'; servers = @($servers52) }
    }
    return @($rows)
}

function Format-F46ProbeTable {
    param($Rows)
    $lines = @('host status note')
    foreach ($r in @($Rows)) { $lines += ('{0} {1} {2}' -f [string]$r.host, [string]$r.status, [string]$r.note) }
    return ($lines -join "`n")
}

# --- [F49 runtime-opt-in-begin] --------------------------------------------
# ONE-click runtime opt-in for the token-less mirror (the dashboard
# ConfirmModal -> POST /api/mirror/enable). The dispatch mirror_enable path
# (F47/F48) is UNCHANGED; this is the second, operator-clicked path with the
# same THIS-RUN scope: the runner is ephemeral, so a config.json write can
# never outlive the run, and the shipped code default stays enabled=false
# (F11-5.2). The guest contract is unchanged: no Authorization, no
# X-Gofile-Token, no Cookie toward the host, ever.
$script:F49OptInScope = 'this-run'
$script:F49OptInSource = 'runtime'
$script:F49OptInBeaconName = 'mirror-optin-beacon.json'
$script:F49OptInEnableFlag = 'mirror-enable.flag'
$script:F49OptInDisableFlag = 'mirror-disable.flag'

function Set-F49CfgProp {
    # Config objects arrive as PSCustomObject (ConvertFrom-Json) in production
    # and as hashtables in some lab fixtures: write through either shape.
    param($Cfg, [string]$Name, $Value)
    if (-not $Cfg) { return }
    if ($Cfg -is [System.Collections.IDictionary]) { try { $Cfg[$Name] = $Value } catch { } return }
    $has = $false
    try { $has = ($null -ne $Cfg.PSObject.Properties[$Name]) } catch { $has = $false }
    if ($has) { try { $Cfg.$Name = $Value } catch { } }
    else { try { $Cfg | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force } catch { } }
}

function ConvertTo-F49UtcIso {
    # [F17 S2] the SAME coercion the beacon-age bug taught: ConvertFrom-Json in
    # Windows PowerShell 5.1 turns an ISO "...Z" stamp into a [datetime], and a
    # bare [string] of it renders locale-without-Z. The opt-in marker rides
    # config.json, so every read-back MUST normalize: strings parse with
    # RoundtripKind (an explicit offset is honored, a bare stamp is UTC),
    # datetimes convert to UTC. Returns '' when there is no stamp.
    param($Ts)
    try {
        if ($null -eq $Ts) { return '' }
        $dt = $null
        if ($Ts -is [datetime]) { $dt = $Ts }
        else {
            $s = [string]$Ts
            if (-not $s) { return '' }
            $dt = [datetime]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
        }
        if ($dt.Kind -eq [System.DateTimeKind]::Unspecified) { $dt = New-Object System.DateTime($dt.Ticks, [System.DateTimeKind]::Utc) }
        return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    } catch { return '' }
}

function Get-F49RuntimeOptIn {
    param($Cfg)
    try {
        if ($Cfg -and $Cfg.PSObject.Properties['mirrorRuntimeOptIn'] -and $Cfg.mirrorRuntimeOptIn) { return $Cfg.mirrorRuntimeOptIn }
    } catch { }
    return $null
}

function Test-F49MirrorEnabled {
    # The worker's actual gate, in one place: the master switch AND an enabled
    # host. Either one off means no upload is attempted.
    param($Cfg)
    $on = $false
    try { $on = [bool]$Cfg.mirror } catch { $on = $false }
    if (-not $on) { return $false }
    $hosts = @()
    try { $hosts = @(Get-F46Hosts -Cfg $Cfg) } catch { $hosts = @() }
    $sel = $null
    try { $sel = Select-F46UploadHost -Hosts $hosts } catch { $sel = $null }
    return ($null -ne $sel)
}

function Get-F49OptInStatus {
    # source=runtime only when the marker exists; a dispatch-enabled config
    # (mirror=true, no marker) reports dispatch; anything else is off. Scope is
    # always this-run: both paths die with the ephemeral runner.
    param($Cfg)
    $enabled = $false
    try { $enabled = (Test-F49MirrorEnabled -Cfg $Cfg) } catch { $enabled = $false }
    $marker = $null
    try { $marker = (Get-F49RuntimeOptIn -Cfg $Cfg) } catch { $marker = $null }
    $source = 'off'
    if ($marker) { $source = [string]$script:F49OptInSource }
    elseif ($enabled) { $source = 'dispatch' }
    $at = ''
    try { if ($marker -and $marker.PSObject.Properties['at']) { $at = ConvertTo-F49UtcIso $marker.at } } catch { }
    $hosts = @()
    try { $hosts = @(Get-F46Hosts -Cfg $Cfg) } catch { $hosts = @() }
    $rows = @()
    foreach ($h in @($hosts)) {
        $id = 'gofile'
        $en = $false
        try { if ($h.id) { $id = [string]$h.id } } catch { }
        try { $en = [bool]$h.enabled } catch { }
        $rows += ([ordered]@{ id = $id; enabled = $en })
    }
    $selHost = ''
    try { $sel = Select-F46UploadHost -Hosts $hosts; if ($sel) { $selHost = [string]$sel.id } } catch { }
    $mirror = $false
    try { $mirror = [bool]$Cfg.mirror } catch { }
    return [ordered]@{ enabled = [bool]$enabled; mirror = [bool]$mirror; hosts = @($rows); host = $selHost; scope = [string]$script:F49OptInScope; source = $source; at = $at }
}

function Set-F49RuntimeOptIn {
    # Converge a config OBJECT to runtime-enabled: master switch on, first host
    # enabled (the default gofile entry is created when mirrorHosts is
    # missing/empty), the runtime marker stamped. F52 also converges encryption.
    # Returns @{ changed; host } - changed=false means the config was already
    # fully runtime-enabled (an idempotent re-POST keeps the original marker).
    param($Cfg, [string]$At = '')
    $stamp = $At
    if (-not $stamp) { $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    $beforeEnabled = $false
    $beforeSource = 'off'
    try { $b = Get-F49OptInStatus -Cfg $Cfg; $beforeEnabled = [bool]$b.enabled; $beforeSource = [string]$b.source } catch { }
    $already = ([bool]$beforeEnabled -and ($beforeSource -eq [string]$script:F49OptInSource))
    $list = @()
    try { if ($Cfg -and $Cfg.PSObject.Properties['mirrorHosts'] -and $Cfg.mirrorHosts) { $list = @($Cfg.mirrorHosts) } } catch { $list = @() }
    if (@($list).Count -eq 0) {
        $d = Get-F46DefaultHost
        $d.enabled = $true
        $list = @([pscustomobject]$d)
    } else {
        $first = $list[0]
        if ($first -is [System.Collections.IDictionary]) { try { $first['enabled'] = $true } catch { } }
        else { try { $first.enabled = $true } catch { } }
    }
    Set-F49CfgProp -Cfg $Cfg -Name 'mirrorHosts' -Value @($list)
    Set-F49CfgProp -Cfg $Cfg -Name 'mirror' -Value $true
    Set-F49CfgProp -Cfg $Cfg -Name 'encryptMode' -Value 'all'
    Set-F49CfgProp -Cfg $Cfg -Name 'mirrorPlaintextElection' -Value $false
    if (-not (Get-F46MirrorKeyBytes -KeyBase64 ([string]$Cfg.mirrorKey))) {
        Set-F49CfgProp -Cfg $Cfg -Name 'mirrorKey' -Value (New-F46MirrorKey)
    }
    if (-not $already) {
        $marker = [pscustomobject][ordered]@{ at = $stamp; source = [string]$script:F49OptInSource; scope = [string]$script:F49OptInScope; by = 'dashboard' }
        Set-F49CfgProp -Cfg $Cfg -Name 'mirrorRuntimeOptIn' -Value $marker
    }
    $selHost = ''
    try { $a = Get-F49OptInStatus -Cfg $Cfg; $selHost = [string]$a.host } catch { }
    return @{ changed = (-not $already); host = $selHost }
}

function Clear-F49RuntimeOptIn {
    # Converge a config OBJECT to default-off: master switch false, EVERY host
    # disabled, the runtime marker removed. Returns @{ changed }.
    param($Cfg)
    $beforeEnabled = $false
    try { $b = Get-F49OptInStatus -Cfg $Cfg; $beforeEnabled = [bool]$b.enabled } catch { }
    Set-F49CfgProp -Cfg $Cfg -Name 'mirror' -Value $false
    $list = @()
    try { if ($Cfg -and $Cfg.PSObject.Properties['mirrorHosts'] -and $Cfg.mirrorHosts) { $list = @($Cfg.mirrorHosts) } } catch { $list = @() }
    foreach ($h in @($list)) {
        if ($h -is [System.Collections.IDictionary]) { try { $h['enabled'] = $false } catch { } }
        else { try { $h.enabled = $false } catch { } }
    }
    $hadMarker = $false
    try { $hadMarker = ($null -ne $Cfg.PSObject.Properties['mirrorRuntimeOptIn']) } catch { $hadMarker = $false }
    if ($hadMarker) {
        if ($Cfg -is [System.Collections.IDictionary]) { try { $Cfg.Remove('mirrorRuntimeOptIn') } catch { } }
        else { try { $Cfg.PSObject.Properties.Remove('mirrorRuntimeOptIn') } catch { } }
    }
    return @{ changed = [bool]$beforeEnabled }
}

function Format-F49OptInLedger {
    # THE §3 ledger line. One format function, used by the watcher and pinned
    # by the lab: the operator pastes this line as the opt-in proof.
    param($Marker, [string]$HostId = 'gofile')
    $at = ''
    try { if ($Marker -and $Marker.PSObject.Properties['at']) { $at = ConvertTo-F49UtcIso $Marker.at } } catch { }
    if (-not $at) { $at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return ('[mirror] RUNTIME OPT-IN: enabled=true scope=this-run source=runtime host=' + $HostId + ' at=' + $at + ' (dashboard one-click; token-less guest, no credential)')
}

function Format-F49OptOutLedger {
    return '[mirror] RUNTIME OPT-IN: cleared by dashboard (mirror=false, hosts disabled)'
}

function Write-F49OptInBeacon {
    # The per-run opt-in beacon (own file: the same no-writer-race rule as the
    # F28/F30 state files). Written by enable, deleted by disable; it carries
    # no secret and dies with the ephemeral runner.
    param([string]$Root, $Marker, [string]$HostId = 'gofile')
    $at = ''
    try { if ($Marker -and $Marker.PSObject.Properties['at']) { $at = ConvertTo-F49UtcIso $Marker.at } } catch { }
    $beacon = [ordered]@{ event = 'mirror-runtime-opt-in'; enabled = $true; scope = [string]$script:F49OptInScope; source = [string]$script:F49OptInSource; host = $HostId; at = $at }
    $p = Join-Path $Root ([string]$script:F49OptInBeaconName)
    [System.IO.File]::WriteAllText($p, ($beacon | ConvertTo-Json -Compress -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    return $p
}

function Remove-F49OptInBeacon {
    param([string]$Root)
    $p = Join-Path $Root ([string]$script:F49OptInBeaconName)
    try { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction Stop } } catch { }
}
# --- [F49 runtime-opt-in-end] ----------------------------------------------
