# [F44] Mirror upload classification + lab-reproducible error visibility.
# Transport diagnostics ONLY. Every attempt is recorded as the F44 §1.1 shape:
#   {host, ts, phase, httpStatus, hostMessage, bytesSent, durationMs}
# phase vocabulary: dns|tcp|tls|encrypt|size|type|auth|http|parse
# NO host-policy evasion here: no UA spoofing (honest ghrdp-mirror-diag UA),
# no proxy chains, no IP rotation, no Origin/Referer forgery. Host policy
# rejections (403/413/451/content) fail FAST, labeled, and are documented.
$ErrorActionPreference = 'Continue'

# Global hard cap: a runner lives ~330 min; >4 GiB cannot finish encrypt+upload
# with retries on a single ephemeral run, so it is labeled phase=size with
# ZERO network tries instead of burning attempts (operator evidence: 7.90 GB ISO).
$global:GhrdpMirrorGlobalMaxBytes = [long]4294967296

# Per-host caps table (§1.3). maxBytes/deniedExt reflect each host's published
# public limits; the §3 lab probe verifies reachability and reports 403 as a
# POLICY outcome, never something to route around.
$global:GhrdpMirrorHostCaps = @(
    @{ name = 'catbox.moe';        url = 'https://catbox.moe/user/api.php';                        apiRoot = 'https://catbox.moe/user/api.php'; formField = 'fileToUpload'; extraFields = @('reqtype=fileupload');            parseKind = 'plain-url';     maxBytes = [long]209715200;  deniedExt = @('.exe', '.dll', '.scr', '.cpl', '.com', '.bat', '.cmd', '.msi', '.jar', '.lnk', '.ps1', '.vbs') }
    @{ name = 'litter.catbox.moe'; url = 'https://litter.catbox.moe/resources/internals/api.php';  apiRoot = 'https://litter.catbox.moe/';    formField = 'fileToUpload'; extraFields = @('reqtype=fileupload', 'time=72h'); parseKind = 'plain-url';     maxBytes = [long]1073741824; deniedExt = @('.exe', '.dll', '.scr', '.cpl', '.com', '.bat', '.cmd', '.msi', '.jar', '.lnk', '.ps1', '.vbs') }
    @{ name = '0x0.st';            url = 'https://0x0.st';                                         apiRoot = 'https://0x0.st';                formField = 'file';         extraFields = @();                                    parseKind = 'plain-url';     maxBytes = [long]536870912;  deniedExt = @('.exe', '.dll', '.scr', '.cpl', '.com', '.jar', '.lnk') }
    @{ name = 'tmpfiles.org';      url = 'https://tmpfiles.org/api/v1/upload';                     apiRoot = 'https://tmpfiles.org/api/v1/upload'; formField = 'file';    extraFields = @();                                    parseKind = 'json-data-url'; maxBytes = [long]104857600;  deniedExt = @() }
    @{ name = 'file.io';           url = 'https://file.io/';                                       apiRoot = 'https://file.io/';               formField = 'file';         extraFields = @();                                    parseKind = 'fileio-json';   maxBytes = [long]2147483648; deniedExt = @() }
    @{ name = 'pixeldrain';        url = 'https://pixeldrain.com/api/files/file';                  apiRoot = 'https://pixeldrain.com/api/files'; formField = 'file';       extraFields = @();                                    parseKind = 'pix-json';      maxBytes = [long]4294967296; deniedExt = @() }
)

# [F44 §1.3 §5] RETRY POLICY (single source; unit-tested in CI by
# tests/f44-mirror-diag.test.js AND executed end-to-end by the lab driver).
# Retry ONLY the transient set: phase tcp/tls (reset/timeout), http 429/500/502/
# 503/504. EVERYTHING else fails fast with its labeled reason.
$global:GhrdpMirrorRetryPolicy = @(
    @{ phases = @('tcp', 'tls'); statuses = @();                        retry = $true;  reason = 'transient-transport' }
    @{ phases = @('http');        statuses = @(429, 500, 502, 503, 504); retry = $true;  reason = 'transient-http' }
    @{ phases = @('dns', 'encrypt', 'size', 'type', 'auth', 'parse'); statuses = @(); retry = $false; reason = 'fail-fast-permanent' }
)

function Protect-MirrorText {
    # Redact secrets/keys, collapse whitespace, cap at 300 chars (§1.1).
    param([string]$Text, [string[]]$ExtraSecrets = @())
    $t = [string]$Text
    foreach ($s in @($ExtraSecrets)) { if ($s -and $s.Length -ge 4) { $t = $t.Replace([string]$s, '<redacted>') } }
    $t = [regex]::Replace($t, '(?i)\b(token|api[-_]?key|apikey|password|passwd|secret|session[-_]?id|access[-_]?key|auth[-_]?key)\s*[=:]\s*[^\s&"'',}]{0,200}', '$1=<redacted>')
    $t = [regex]::Replace($t, '(?i)Bearer\s+[A-Za-z0-9._\-]{4,}', 'Bearer <redacted>')
    $t = [regex]::Replace($t, '(?i)(set-cookie|cookie)\s*[:=]\s*[^\r\n]{0,200}', '$1=<redacted>')
    $t = ($t -replace '\s+', ' ').Trim()
    if ($t.Length -gt 300) { $t = $t.Substring(0, 300) }
    return $t
}

function New-MirrorAttemptRecord {
    # [F44 §1.1] exact per-attempt shape, fixed key order.
    param([string]$Host, [string]$Phase, [int]$HttpStatus, [string]$HostMessage, [long]$BytesSent, [long]$DurationMs, [string[]]$ExtraSecrets = @())
    return [ordered]@{
        host        = [string]$Host
        ts          = (Get-Date).ToUniversalTime().ToString('o')
        phase       = [string]$Phase
        httpStatus  = [int]$HttpStatus
        hostMessage = (Protect-MirrorText -Text $HostMessage -ExtraSecrets $ExtraSecrets)
        bytesSent   = [long]$BytesSent
        durationMs  = [long]$DurationMs
    }
}

function Get-MirrorRetryDecision {
    param([string]$Phase, [int]$HttpStatus)
    foreach ($rule in @($global:GhrdpMirrorRetryPolicy)) {
        $phaseHit = (@($rule.phases) -contains $Phase)
        if (-not $phaseHit) { continue }
        $statusRules = @($rule.statuses)
        if (($statusRules.Count -eq 0) -or ($statusRules -contains [int]$HttpStatus)) {
            return @{ retry = [bool]$rule.retry; reason = [string]$rule.reason }
        }
    }
    return @{ retry = $false; reason = 'fail-fast-default' }
}

function ConvertFrom-CurlExit {
    # Transport-class map for curl exit codes (no response available).
    param([int]$Code)
    switch ($Code) {
        0  { return @{ phase = 'http'; label = 'curl-ok' } }
        6  { return @{ phase = 'dns';  label = 'could-not-resolve' } }
        7  { return @{ phase = 'tcp';  label = 'connect-refused' } }
        9  { return @{ phase = 'tcp';  label = 'access-denied' } }
        28 { return @{ phase = 'tcp';  label = 'timeout' } }
        52 { return @{ phase = 'tcp';  label = 'empty-reply' } }
        55 { return @{ phase = 'tcp';  label = 'send-reset' } }
        56 { return @{ phase = 'tcp';  label = 'recv-reset (incl. tls-reset)' } }
        35 { return @{ phase = 'tls';  label = 'handshake' } }
        { $_ -in 51, 53, 54, 58, 59, 60, 66, 77, 83, 90, 91, 98 } { return @{ phase = 'tls'; label = ('tls-' + $Code) } }
        default { return @{ phase = 'http'; label = ('curl-exit-' + $Code) } }
    }
}

function ConvertFrom-HttpStatus {
    # Response-status class map. Body decides 403 (policy text => phase=type).
    param([int]$Status, [string]$Body)
    switch ($Status) {
        413 { return @{ phase = 'size'; code = 'entity-too-large' } }
        415 { return @{ phase = 'type'; code = 'unsupported-media' } }
        401 { return @{ phase = 'auth'; code = 'unauthorized' } }
        402 { return @{ phase = 'auth'; code = 'payment-required' } }
        403 {
            if ([string]$Body -match '(?i)(not allowed|content[- ]?policy|banned|forbidden (file|extension|type)|file ?type|extension|illegal|abuse)') {
                return @{ phase = 'type'; code = 'content-policy' }
            }
            return @{ phase = 'auth'; code = 'forbidden' }
        }
        451 { return @{ phase = 'type'; code = 'legal-block' } }
        404 { return @{ phase = 'http'; code = 'not-found' } }
        default { return @{ phase = 'http'; code = ('http-' + $Status) } }
    }
}

function Test-MirrorHostCaps {
    # [F44 §1.3] size/type PRE-FLIGHT vs ONE host's caps: BEFORE any attempt,
    # zero network tries when it does not fit.
    param([hashtable]$Cap, [long]$SizeBytes, [string]$Name)
    if ([long]$SizeBytes -gt [long]$Cap.maxBytes) {
        return @{ ok = $false; phase = 'size'; reason = ('preflight: file ' + [long]$SizeBytes + ' B over ' + [string]$Cap.name + ' cap ' + [long]$Cap.maxBytes + ' B (0 network tries)') }
    }
    $ext = [System.IO.Path]::GetExtension(([string]$Name).ToLower())
    if ($ext -and (@($Cap.deniedExt) -contains $ext)) {
        return @{ ok = $false; phase = 'type'; reason = ('preflight: extension ' + $ext + ' denied by ' + [string]$Cap.name + ' content policy (0 network tries)') }
    }
    return @{ ok = $true; phase = ''; reason = '' }
}

function Test-MirrorEncryptOutput {
    # [F44 §1.4] ciphertext must exist and be >0 bytes BEFORE the first upload.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw ('phase=encrypt: ciphertext missing after encrypt step: ' + $Path) }
    $len = [long](Get-Item -LiteralPath $Path).Length
    if ($len -le 0) { throw ('phase=encrypt: ciphertext is 0 bytes after encrypt step: ' + $Path) }
    return $len
}

function Resolve-MirrorLink {
    # Response-body parser per parseKind; BOTH directions lab-asserted (§4e):
    # a 200 with an unusable/error body is phase=parse, never success.
    param([string]$Kind, [string]$Body)
    $b = ([string]$Body).Trim()
    switch ($Kind) {
        'plain-url' {
            if ($b -match '^https?://\S+$') { return @{ link = $b; err = '' } }
            return @{ link = ''; err = ('unrecognized body: ' + $b) }
        }
        'json-data-url' {
            $j = $null; try { $j = $b | ConvertFrom-Json } catch { }
            if ($j -and $j.data -and [string]$j.data.url) { return @{ link = [string]$j.data.url; err = '' } }
            return @{ link = ''; err = ('json without data.url: ' + $b) }
        }
        'fileio-json' {
            $j = $null; try { $j = $b | ConvertFrom-Json } catch { }
            if ($j -and $j.success -eq $true -and [string]$j.link) { return @{ link = [string]$j.link; err = '' } }
            if ($j -and $j.message) { return @{ link = ''; err = [string]$j.message } }
            return @{ link = ''; err = ('json without link: ' + $b) }
        }
        'pix-json' {
            $j = $null; try { $j = $b | ConvertFrom-Json } catch { }
            if ($j -and $j.success -eq $true -and [string]$j.id) { return @{ link = ('https://pixeldrain.com/u/' + [string]$j.id); err = '' } }
            if ($j -and $j.message) { return @{ link = ''; err = [string]$j.message } }
            return @{ link = ''; err = ('json without id: ' + $b) }
        }
        default { return @{ link = ''; err = ('unknown parseKind ' + $Kind) } }
    }
}

function Invoke-MirrorHostAttempt {
    # ONE network try against ONE host. Honest UA, no Origin/Referer forgery,
    # no proxy flags: a rejection here is a POLICY answer, not a puzzle.
    param([hashtable]$Cap, [string]$Path, [string]$DispName, [string[]]$ExtraSecrets = @())
    $bodyFile = Join-Path $env:TEMP ('ghrdp-mup-' + [guid]::NewGuid().ToString('N') + '.body')
    $errFile = Join-Path $env:TEMP ('ghrdp-mup-' + [guid]::NewGuid().ToString('N') + '.err')
    $cargs = @('-sS', '-o', $bodyFile, '-w', '%{http_code} %{size_upload} %{time_total}', '--max-time', '1800', '--connect-timeout', '60', '-A', 'ghrdp-mirror-diag/1.0')
    foreach ($xf in @($Cap.extraFields)) { $cargs += @('-F', [string]$xf) }
    $cargs += @('-F', ([string]$Cap.formField + '=@' + [string]$Path + ';filename=' + [string]$DispName))
    $cargs += [string]$Cap.url
    $httpStatus = 0; $bytesSent = [long]0; $durationMs = [long]0
    $exit = 0
    $out = $null
    try { $out = & curl.exe @cargs 2>$errFile; $exit = $LASTEXITCODE } catch { $exit = -1 }
    if ($out) {
        $meta = ([string]($out -join ' ')).Trim()
        if ($meta -match '(\d{3})\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$') {
            $httpStatus = [int]$Matches[1]
            $bytesSent = [long][double]$Matches[2]
            $durationMs = [long]([double]$Matches[3] * 1000)
        }
    }
    $body = ''
    try { if (Test-Path -LiteralPath $bodyFile) { $body = [System.IO.File]::ReadAllText($bodyFile) } } catch { }
    $errTxt = ''
    try { if (Test-Path -LiteralPath $errFile) { $errTxt = ([string](Get-Content -LiteralPath $errFile -Raw)) } } catch { }
    Remove-Item -LiteralPath $bodyFile, $errFile -Force -ErrorAction SilentlyContinue
    if ($exit -eq 0 -and $httpStatus -ge 200 -and $httpStatus -lt 300) {
        $p = Resolve-MirrorLink -Kind ([string]$Cap.parseKind) -Body $body
        if ($p.link) {
            return @{ record = (New-MirrorAttemptRecord -Host ([string]$Cap.name) -Phase 'http' -HttpStatus $httpStatus -HostMessage 'OK' -BytesSent $bytesSent -DurationMs $durationMs -ExtraSecrets $ExtraSecrets); link = [string]$p.link }
        }
        return @{ record = (New-MirrorAttemptRecord -Host ([string]$Cap.name) -Phase 'parse' -HttpStatus $httpStatus -HostMessage $p.err -BytesSent $bytesSent -DurationMs $durationMs -ExtraSecrets $ExtraSecrets); link = '' }
    }
    if ($exit -ne 0) {
        $c = ConvertFrom-CurlExit -Code $exit
        $msg = if ($errTxt) { $errTxt } else { $c.label }
        return @{ record = (New-MirrorAttemptRecord -Host ([string]$Cap.name) -Phase ([string]$c.phase) -HttpStatus $httpStatus -HostMessage ($c.label + ': ' + $msg) -BytesSent $bytesSent -DurationMs $durationMs -ExtraSecrets $ExtraSecrets); link = '' }
    }
    $h = ConvertFrom-HttpStatus -Status $httpStatus -Body $body
    $hmsg = if ($body) { $body } elseif ($errTxt) { $errTxt } else { $h.code }
    return @{ record = (New-MirrorAttemptRecord -Host ([string]$Cap.name) -Phase ([string]$h.phase) -HttpStatus $httpStatus -HostMessage ($h.code + ': ' + $hmsg) -BytesSent $bytesSent -DurationMs $durationMs -ExtraSecrets $ExtraSecrets); link = '' }
}

function Invoke-MirrorUpload {
    # [F44 §1] orchestrator: per-host preflight (zero network), then attempts
    # with the retry policy; per-attempt records; FULL composed error text, no
    # truncation anywhere. Returns ok/link/phase/attempts/errorText/retryable.
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DispName,
        [array]$CapsOverride = $null,
        [int]$MaxAttemptsPerHost = 3,
        [long]$GlobalMaxBytes = -1,
        [string[]]$ExtraSecrets = @()
    )
    $caps = if ($null -ne $CapsOverride) { @($CapsOverride) } else { @($global:GhrdpMirrorHostCaps) }
    $attempts = New-Object System.Collections.ArrayList
    $result0 = [ordered]@{ ok = $false; link = ''; phase = 'http'; attempts = @(); errorText = ''; retryable = $false }
    if (-not (Test-Path -LiteralPath $Path)) {
        [void]$attempts.Add((New-MirrorAttemptRecord -Host '*' -Phase 'encrypt' -HttpStatus 0 -HostMessage ('input vanished before upload: ' + $Path) -BytesSent 0 -DurationMs 0 -ExtraSecrets $ExtraSecrets))
        $result0.phase = 'encrypt'
        $result0.attempts = @($attempts)
        $result0.errorText = 'phase=encrypt | *: phase=encrypt http=0 tries=1 msg="input vanished before upload"'
        return $result0
    }
    $size = [long](Get-Item -LiteralPath $Path).Length
    $gmax = if ($GlobalMaxBytes -ge 0) { [long]$GlobalMaxBytes } else { [long]$global:GhrdpMirrorGlobalMaxBytes }
    if ($size -gt $gmax) {
        $msg = 'preflight: file ' + $size + ' B over global cap ' + $gmax + ' B (0 network tries)'
        [void]$attempts.Add((New-MirrorAttemptRecord -Host '*' -Phase 'size' -HttpStatus 0 -HostMessage $msg -BytesSent 0 -DurationMs 0 -ExtraSecrets $ExtraSecrets))
        $result0.phase = 'size'
        $result0.attempts = @($attempts)
        $result0.errorText = 'phase=size | *: phase=size http=0 tries=1 msg="' + $msg + '"'
        return $result0
    }
    $anyRetryable = $false
    foreach ($cap in $caps) {
        $pf = Test-MirrorHostCaps -Cap $cap -SizeBytes $size -Name $DispName
        if (-not $pf.ok) {
            [void]$attempts.Add((New-MirrorAttemptRecord -Host ([string]$cap.name) -Phase ([string]$pf.phase) -HttpStatus 0 -HostMessage ([string]$pf.reason) -BytesSent 0 -DurationMs 0 -ExtraSecrets $ExtraSecrets))
            continue
        }
        for ($n = 1; $n -le $MaxAttemptsPerHost; $n++) {
            $r = Invoke-MirrorHostAttempt -Cap $cap -Path $Path -DispName $DispName -ExtraSecrets $ExtraSecrets
            [void]$attempts.Add($r.record)
            if ($r.link) {
                $result0.ok = $true
                $result0.link = [string]$r.link
                $result0.phase = 'done'
                $result0.attempts = @($attempts)
                return $result0
            }
            $d = Get-MirrorRetryDecision -Phase ([string]$r.record.phase) -HttpStatus ([int]$r.record.httpStatus)
            if (-not $d.retry) { break }
            if ($n -lt $MaxAttemptsPerHost) { Start-Sleep -Seconds ([math]::Min(15, [int][math]::Pow(2, ($n - 1)))) }
        }
        $last = $attempts[$attempts.Count - 1]
        $dl = Get-MirrorRetryDecision -Phase ([string]$last.phase) -HttpStatus ([int]$last.httpStatus)
        if ($dl.retry) { $anyRetryable = $true }
    }
    $final = $attempts[$attempts.Count - 1]
    $segs = @()
    $byHost = [ordered]@{}
    foreach ($a in @($attempts)) { $byHost[[string]$a.host] = New-Object System.Collections.ArrayList }
    foreach ($a in @($attempts)) { [void]$byHost[[string]$a.host].Add($a) }
    foreach ($h in $byHost.Keys) {
        $rows = @($byHost[$h])
        $lr = $rows[$rows.Count - 1]
        $segs += ([string]$h + ': phase=' + [string]$lr.phase + ' http=' + [int]$lr.httpStatus + ' tries=' + $rows.Count + ' msg="' + [string]$lr.hostMessage + '"')
    }
    $result0.phase = [string]$final.phase
    $result0.attempts = @($attempts)
    $result0.retryable = $anyRetryable
    $result0.errorText = 'phase=' + [string]$final.phase + ' | ' + ($segs -join ' ; ')
    return $result0
}
