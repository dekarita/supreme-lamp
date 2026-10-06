# [F58 §1] CUSTOM SOURCE REGISTRY - runner-side store substrate.
#
# The operator-added search sources live at ~/.ghrdp/sources/*.json, ENCRYPTED AT
# REST with the F46 per-run key, and are pulled at startup from the Tailscale
# operator store (env TS_SOURCES_URL; auth via the F49 GHRDP_ secret pattern -
# never a repo literal, never a URL query key, never logged).
#
# This module is the ONLY place the plaintext of a descriptor blob ever exists on
# the runner, and only in memory for the lifetime of the call:
#   * decrypt failure  -> REFUSE (no plaintext fallthrough, no cache retry in the
#     clear, nothing written);
#   * fetch failure    -> the last-known LOCAL cached cipher is used READ-ONLY
#     until the next successful pull;
#   * every write      -> atomic temp+move, then a sidecar sha256 of the WRITTEN
#     bytes, then a read-back re-digest (the round-trip verify the shared TS store
#     contract in src/search/custom-source-store.ts requires).
#
# NOT wired into main.yml by this session (F56-d owns the server start and the
# /api/fetch backend); tests/f58-source-store.ps1 executes these shipped
# functions directly on the windows-native lane. No endpoint is exposed here, so
# there is nothing for a client to call: no site-walking agent, no C2 surface, no
# credential storage beyond the F46 per-run key that never leaves memory.
Set-StrictMode -Version Latest

$script:F58Iterations = 100000
$script:F58MaxBytes = 4194304
$script:F58MacTag = 'F58A1|'  # [F97] inner authentication tag (see Protect/Unprotect)

function Get-F58StoreDir {
    if ($env:GHRDP_SOURCE_STORE_DIR) { return $env:GHRDP_SOURCE_STORE_DIR }
    return (Join-Path $env:USERPROFILE '.ghrdp\sources')
}

function New-F58PerRunKey {
    # F46 per-run key: 32 random bytes, memory only. Never written, never
    # returned in a status payload, never placed in an artifact or a log line.
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ,$bytes
}

function ConvertTo-F58Base64UrlSafe {
    param([byte[]]$Bytes)
    return [System.Convert]::ToBase64String($Bytes)
}

function Get-F58Sha256Hex {
    # Same digest the shared TS store computes for its round-trip verify
    # (sha256Hex in src/search/custom-source-store.ts) - the lab pins one
    # cross-runtime vector so the two can never silently disagree.
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hash) { $null = $sb.Append($b.ToString('x2')) }
        return $sb.ToString()
    } finally { $sha.Dispose() }
}

function Get-F58KeyMaterial {
    param([byte[]]$Key, [byte[]]$Salt)
    $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes -ArgumentList @($Key, $Salt, [int]$script:F58Iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    try { return $kdf.GetBytes(32) } finally { $kdf.Dispose() }
}

function Get-F58MacKey {
    # [F97] Domain-separated MAC key: the SAME PBKDF2 stream as the AES key, but
    # the upper 32 bytes, so AES-256-CBC and HMAC-SHA256 never share key material.
    param([byte[]]$Key, [byte[]]$Salt)
    $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes -ArgumentList @($Key, $Salt, [int]$script:F58Iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $material = $kdf.GetBytes(64)
        return ,[byte[]]($material[32..63])
    } finally { $kdf.Dispose() }
}

function Protect-F58Blob {
    # v1:<salt>:<iv>:<ciphertext>, all base64. AES-256-CBC + PKCS7, fresh salt and
    # IV per call (no IV reuse across revisions of the same source). [F97] the
    # plaintext is framed as <F58A1|><json>|<hmac> INSIDE the ciphertext, so the
    # envelope is authenticated: a foreign key or a flipped ciphertext byte is
    # refused deterministically instead of depending on PKCS7 padding luck.
    param([string]$Plain, [byte[]]$Key)
    if (-not $Plain) { throw 'F58: Protect-F58Blob requires a non-empty plaintext' }
    if (-not $Key -or $Key.Length -ne 32) { throw 'F58: the per-run key must be 32 bytes' }
    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $salt = New-Object byte[] 16
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($salt); $iv = New-Object byte[] 16; $rng.GetBytes($iv) } finally { $rng.Dispose() }
        $aes.Key = (Get-F58KeyMaterial -Key $Key -Salt $salt)
        $aes.IV = $iv
        $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
        $enc = $aes.CreateEncryptor()
        $macKey = Get-F58MacKey -Key $Key -Salt $salt
        $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList @(,$macKey)
        try { $macBytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:F58MacTag + $Plain)) } finally { $hmac.Dispose() }
        $framed = $script:F58MacTag + $Plain + '|' + (ConvertTo-F58Base64UrlSafe $macBytes)
        $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($framed)
        $cipherBytes = $enc.TransformFinalBlock($plainBytes, 0, $plainBytes.Length)
        return ('v1:' + (ConvertTo-F58Base64UrlSafe $salt) + ':' + (ConvertTo-F58Base64UrlSafe $iv) + ':' + (ConvertTo-F58Base64UrlSafe $cipherBytes))
    } finally { $aes.Dispose() }
}

function Unprotect-F58Blob {
    # Fail-closed: ANY problem (bad envelope, wrong key, torn/flipped ciphertext,
    # unauthenticated framing) returns $null. The HMAC tag is verified BEFORE any
    # plaintext is returned, so there is no unauthenticated decrypt path and no
    # plaintext fallthrough, and nothing is ever written from this function.
    param([string]$Cipher, [byte[]]$Key)
    try {
        if (-not $Cipher) { return $null }
        $parts = $Cipher.Split(':')
        if ($parts.Length -ne 4 -or $parts[0] -ne 'v1') { return $null }
        $salt = [System.Convert]::FromBase64String($parts[1])
        $iv = [System.Convert]::FromBase64String($parts[2])
        $cipherBytes = [System.Convert]::FromBase64String($parts[3])
        if (-not $Key -or $Key.Length -ne 32) { return $null }
        $aes = [System.Security.Cryptography.Aes]::Create()
        try {
            $aes.Key = (Get-F58KeyMaterial -Key $Key -Salt $salt)
            $aes.IV = $iv
            $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
            $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
            $dec = $aes.CreateDecryptor()
            $plainBytes = $dec.TransformFinalBlock($cipherBytes, 0, $cipherBytes.Length)
            $framed = [System.Text.Encoding]::UTF8.GetString($plainBytes)
            if (-not $framed.StartsWith($script:F58MacTag)) { return $null }
            $cut = $framed.LastIndexOf('|')
            if ($cut -le $script:F58MacTag.Length) { return $null }
            $body = $framed.Substring($script:F58MacTag.Length, $cut - $script:F58MacTag.Length)
            $tag = $framed.Substring($cut + 1)
            $macKey = Get-F58MacKey -Key $Key -Salt $salt
            $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList @(,$macKey)
            try { $expect = ConvertTo-F58Base64UrlSafe ($hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:F58MacTag + $body))) } finally { $hmac.Dispose() }
            if ($tag -cne $expect) { return $null }
            return $body
        } finally { $aes.Dispose() }
    } catch {
        return $null
    }
}

function Write-F58StoreFile {
    param([string]$Dir, [string]$Name, [string]$Json, [byte[]]$Key)
    $out = [pscustomobject]@{ ok = $false; path = ''; sidecar = ''; sha256 = ''; bytes = 0; reason = $null }
    try {
        if (-not (Test-Path -LiteralPath $Dir)) { $null = New-Item -ItemType Directory -Path $Dir -Force }
        $cipher = Protect-F58Blob -Plain $Json -Key $Key
        $cipherBytes = [System.Text.Encoding]::UTF8.GetBytes($cipher)
        if ($cipherBytes.Length -gt $script:F58MaxBytes) { $out.reason = 'blob-too-large'; return $out }
        $path = Join-Path $Dir ($Name + '.json')
        $tmp = Join-Path $Dir ($Name + '.json.' + [guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllBytes($tmp, $cipherBytes)
        Move-Item -LiteralPath $tmp -Destination $path -Force
        $written = [System.IO.File]::ReadAllBytes($path)
        $digest = Get-F58Sha256Hex -Bytes $written
        $sidecar = $path + '.sha256'
        [System.IO.File]::WriteAllText($sidecar, $digest + "`n")
        $back = (Get-Content -LiteralPath $sidecar -Raw).Trim()
        if ($back -ne $digest) {
            $out.reason = 'persist-verify: sha256 round-trip mismatch'
            return $out
        }
        $out.ok = $true
        $out.path = $path
        $out.sidecar = $sidecar
        $out.sha256 = $digest
        $out.bytes = $written.Length
        return $out
    } catch {
        $out.reason = 'write-failed: ' + $_.Exception.Message
        return $out
    }
}

function Read-F58StoreFile {
    param([string]$Dir, [string]$Name, [byte[]]$Key)
    $out = [pscustomobject]@{ ok = $false; plain = $null; reason = $null; sha256 = '' }
    $path = Join-Path $Dir ($Name + '.json')
    $sidecar = $path + '.sha256'
    if (-not (Test-Path -LiteralPath $path)) { $out.reason = 'store-file-missing'; return $out }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $digest = Get-F58Sha256Hex -Bytes $bytes
    $out.sha256 = $digest
    if (Test-Path -LiteralPath $sidecar) {
        $want = (Get-Content -LiteralPath $sidecar -Raw).Trim()
        if ($want -ne $digest) { $out.reason = 'persist-verify: sha256-mismatch (file changed on disk)'; return $out }
    } else {
        $out.reason = 'persist-verify: sidecar-missing'
        return $out
    }
    $plain = Unprotect-F58Blob -Cipher ([System.Text.Encoding]::UTF8.GetString($bytes)) -Key $Key
    if ($null -eq $plain) { $out.reason = 'decrypt-failed'; return $out }
    $out.ok = $true
    $out.plain = $plain
    return $out
}

function Get-F58OperatorBlob {
    # The Tailscale operator-store pull. https only; no IP literal; the bearer
    # comes from the F49 GHRDP_ secret pattern in the environment and is sent as
    # a header only - never in a URL, never echoed.
    param([string]$Url)
    $out = [pscustomobject]@{ ok = $false; cipher = $null; reason = $null }
    try {
        if (-not $Url) { $out.reason = 'sources-url-unset (operator store not configured; the registry starts empty)'; return $out }
        if ($Url -notmatch '^https://') { $out.reason = 'sources-url-not-https'; return $out }
        $host0 = ([System.Uri]$Url).Host
        if ($host0 -match '^\d{1,3}(\.\d{1,3}){3}$') { $out.reason = 'sources-url-ip-literal'; return $out }
        $headers = @{}
        if ($env:GHRDP_DASH_TOKEN) { $headers['Authorization'] = 'Bearer ' + $env:GHRDP_DASH_TOKEN }
        $resp = Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing -TimeoutSec 30
        $out.ok = $true
        $out.cipher = [string]$resp.Content
        return $out
    } catch {
        $out.reason = 'operator-store-unreachable: ' + $_.Exception.Message
        return $out
    }
}

function Invoke-F58Startup {
    param([byte[]]$Key, [string]$Url, [string]$Dir)
    if (-not $Dir) { $Dir = Get-F58StoreDir }
    $res = [pscustomobject]@{ mode = 'live'; readOnly = $false; plain = $null; reason = $null; entries = 0 }
    $pull = Get-F58OperatorBlob -Url $Url
    $cipherText = $null
    $fromCache = $false
    if ($pull.ok) {
        $cipherText = $pull.cipher
    } else {
        # fetch failure: the last-known LOCAL cached copy is the only fallback, and
        # it is read-only until the next successful pull.
        $cached = Read-F58StoreFile -Dir $Dir -Name 'operator-cache' -Key $Key
        if ($cached.ok) { $cipherText = $cached.plain; $fromCache = $true }
        else {
            $res.mode = 'live'
            $res.reason = 'operator-store-unreachable: no cached blob, registry starts empty'
            return $res
        }
    }
    # $cipherText is CIPHERTEXT on both paths; Unprotect-F58Blob is the single
    # decrypt site and it fails closed. A $null result REFUSES startup - there is
    # no plaintext fallthrough and the cached copy is never retried in the clear.
    $plain = Unprotect-F58Blob -Cipher $cipherText -Key $Key
    if ($null -eq $plain) {
        $res.mode = 'refused'
        $res.readOnly = $true
        if ($fromCache) { $res.reason = 'decrypt-failed:cached-copy (startup refused)' }
        else { $res.reason = 'decrypt-failed (startup refused, cached copy not retried)' }
        return $res
    }
    $doc = $null
    try { $doc = $plain | ConvertFrom-Json } catch { $doc = $null }
    if (-not $doc) {
        $res.mode = 'cache-read-only'
        if (-not $fromCache) { $res.mode = 'live' }
        $res.readOnly = $fromCache
        $res.reason = 'blob-unparseable'
        return $res
    }
    $res.mode = 'live'
    if ($fromCache) { $res.mode = 'cache-read-only' }
    $res.readOnly = $fromCache
    $res.plain = $plain
    $res.entries = @($doc.sources).Count
    if (-not $fromCache) {
        # Persist the fetched CIPHERTEXT (never the plaintext) as the read-only
        # fallback for the next unreachable startup.
        $enc = Write-F58StoreFile -Dir $Dir -Name 'operator-cache' -Json $cipherText -Key $Key
        if (-not $enc.ok) { $res.reason = 'cache-write-refused: ' + $enc.reason }
    }
    return $res
}
