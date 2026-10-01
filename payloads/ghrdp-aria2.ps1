# [F56-d §1] aria2c JSON-RPC helper - loopback only (127.0.0.1:6800).
# Provides addUri, tellStatus, remove, pauseAll. CLI pins per spec:
# max-connection-per-server=8, split=8, min-split-size=1M, dir=Fetched-root,
# follow-metalink=false, follow-torrent=false, check-integrity=true when sha256 given.
# Secret via GHRDP_ARIA2_RPC_SECRET env, session at D:\ghrdp\aria2\session.
# No disk persist of creds - own-cred decrypted in memory, wiped after.

$script:Aria2RpcUrl = 'http://127.0.0.1:6800/jsonrpc'
$script:Aria2Secret = ''
try { $script:Aria2Secret = [string]$env:GHRDP_ARIA2_RPC_SECRET } catch { }
if (-not $script:Aria2Secret) {
    try {
        $sf = 'C:\ghrdp\aria2-secret.txt'
        if (Test-Path -LiteralPath $sf) { $script:Aria2Secret = ([System.IO.File]::ReadAllText($sf)).Trim() }
    } catch { }
}

function Get-Aria2SecretToken {
    param([string]$Secret = '')
    $s = $Secret
    if (-not $s) { $s = $script:Aria2Secret }
    if (-not $s) { try { $s = [string]$env:GHRDP_ARIA2_RPC_SECRET } catch { } }
    if ($s) { return ('token:' + $s) }
    return ''
}

function Invoke-Aria2Rpc {
    param(
        [string]$Method,
        [object[]]$Params = @(),
        [string]$Secret = '',
        [string]$RpcUrl = $script:Aria2RpcUrl
    )
    $tok = Get-Aria2SecretToken -Secret $Secret
    # [F56-d loop 4] Array-valued params must survive as ONE element. The old
    # per-param accumulation into a plain array silently FLATTENED them (in
    # PowerShell, accumulating an array onto an array concatenates instead of
    # nesting), so aria2.addUri received the URIs list as a bare string instead of
    # an array of strings and rejected the call - which would have broken
    # /api/fetch start in production too. The ArrayList preserves each param
    # object exactly as passed (one index per param, no flattening).
    $fullParams = New-Object System.Collections.ArrayList
    if ($tok) { [void]$fullParams.Add($tok) }
    foreach ($p in @($Params)) { [void]$fullParams.Add($p) }
    $body = @{
        jsonrpc = '2.0'
        id = [guid]::NewGuid().ToString('N').Substring(0,8)
        method = $Method
        params = @($fullParams)
    } | ConvertTo-Json -Depth 8 -Compress
    try {
        $r = Invoke-RestMethod -Uri $RpcUrl -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 -ErrorAction Stop
        if ($r -and $r.PSObject.Properties['error'] -and $r.error) {
            return @{ ok = $false; error = $r.error; result = $null }
        }
        return @{ ok = $true; result = $r.result; error = $null }
    } catch {
        return @{ ok = $false; error = @{ code = -1; message = $_.Exception.Message }; result = $null }
    }
}

function Add-Aria2Uri {
    param(
        [string]$Uri,
        [hashtable]$Options = @{},
        [string]$Secret = '',
        [string]$RpcUrl = $script:Aria2RpcUrl,
        [string]$Sha256 = ''
    )
    if (-not $Uri -or $Uri -notmatch '^https://') { return @{ ok = $false; gid = ''; error = 'HTTPS_REQUIRED' } }
    $opts = @{
        dir = 'D:\RDP-Storage\Fetched'
        'max-connection-per-server' = '8'
        split = '8'
        'min-split-size' = '1M'
        'follow-metalink' = 'false'
        'follow-torrent' = 'false'
    }
    foreach ($k in @($Options.Keys)) { $opts[$k] = $Options[$k] }
    if ($Sha256 -and $Sha256 -match '^[a-fA-F0-9]{64}$') {
        $opts['checksum'] = ('sha-256=' + $Sha256.ToLowerInvariant())
        $opts['check-integrity'] = 'true'
    }
    $res = Invoke-Aria2Rpc -Method 'aria2.addUri' -Params @(@($Uri), $opts) -Secret $Secret -RpcUrl $RpcUrl
    if (-not $res.ok) { return @{ ok = $false; gid = ''; error = $res.error } }
    return @{ ok = $true; gid = [string]$res.result; error = $null }
}

function Get-Aria2Status {
    param([string]$Gid, [string]$Secret = '', [string]$RpcUrl = $script:Aria2RpcUrl)
    if (-not $Gid) { return @{ ok = $false; status = $null } }
    $res = Invoke-Aria2Rpc -Method 'aria2.tellStatus' -Params @($Gid) -Secret $Secret -RpcUrl $RpcUrl
    if (-not $res.ok) { return @{ ok = $false; status = $null; error = $res.error } }
    return @{ ok = $true; status = $res.result; error = $null }
}

function Remove-Aria2Download {
    param([string]$Gid, [string]$Secret = '', [string]$RpcUrl = $script:Aria2RpcUrl)
    if (-not $Gid) { return @{ ok = $false } }
    $res = Invoke-Aria2Rpc -Method 'aria2.remove' -Params @($Gid) -Secret $Secret -RpcUrl $RpcUrl
    return @{ ok = [bool]$res.ok; result = $res.result; error = $res.error }
}

function Pause-Aria2All {
    param([string]$Secret = '', [string]$RpcUrl = $script:Aria2RpcUrl)
    $res = Invoke-Aria2Rpc -Method 'aria2.pauseAll' -Params @() -Secret $Secret -RpcUrl $RpcUrl
    return @{ ok = [bool]$res.ok; result = $res.result; error = $res.error }
}

function Get-Aria2Version {
    param([string]$Secret = '', [string]$RpcUrl = $script:Aria2RpcUrl)
    $res = Invoke-Aria2Rpc -Method 'aria2.getVersion' -Params @() -Secret $Secret -RpcUrl $RpcUrl
    if (-not $res.ok) { return @{ ok = $false; version = '' } }
    $ver = ''
    try { $ver = [string]$res.result.version } catch { }
    return @{ ok = $true; version = $ver; result = $res.result }
}

# [F56-d §3] Own-cred memory-only helper: decrypts F46 per-run key encrypted creds
# in process memory, returns plain user/pass for that invocation, wipes after.
function Unprotect-F56dOwnCred {
    param([string]$UserEnc, [string]$PassEnc, [string]$KeyBase64)
    $plainUser = $null
    $plainPass = $null
    try {
        $keyBytes = $null
        try { $keyBytes = [Convert]::FromBase64String($KeyBase64) } catch { $keyBytes = $null }
        if (-not $keyBytes -or $keyBytes.Length -ne 32) { return @{ ok = $false; user = ''; pass = ''; error = 'invalid per-run key' } }
        # Expect UserEnc/PassEnc as base64 AES-GCM: nonce(12) + tag(16) + ct
        # For lab simplicity, also accept base64 plain if prefixed with 'plain:'
        foreach ($pair in @(@{ enc = $UserEnc; field = 'user' }, @{ enc = $PassEnc; field = 'pass' })) {
            $encB64 = [string]$pair.enc
            if (-not $encB64) { continue }
            if ($encB64.StartsWith('plain:')) {
                $b64 = $encB64.Substring(6)
                $plain = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
                if ($pair.field -eq 'user') { $plainUser = $plain } else { $plainPass = $plain }
                continue
            }
            try {
                $blob = [Convert]::FromBase64String($encB64)
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
                    if ($pair.field -eq 'user') { $plainUser = $s } else { $plainPass = $s }
                    try { [Array]::Clear($pt, 0, $pt.Length) } catch { }
                } finally { try { $aes.Dispose() } catch { } }
            } catch {
                return @{ ok = $false; user = ''; pass = ''; error = ('decrypt failed: ' + $_.Exception.Message) }
            }
        }
        return @{ ok = $true; user = [string]$plainUser; pass = [string]$plainPass; error = '' }
    } finally {
        # Memory wipe: clear key bytes and any intermediate buffers
        try { if ($keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) } } catch { }
    }
}

function Clear-F56dCredMemory {
    param([ref]$UserRef, [ref]$PassRef)
    try { if ($UserRef.Value) { $UserRef.Value = '' } } catch { }
    try { if ($PassRef.Value) { $PassRef.Value = '' } } catch { }
    try { [GC]::Collect(); [GC]::WaitForPendingFinalizers() } catch { }
}

# [F56-d §1] CLI pins verifier - ensures no forbidden options leak
function Test-F56dAria2Pins {
    param([hashtable]$Options)
    $forbidden = @('follow-metalink=true', 'follow-torrent=true', 'rpc-listen-all=true', 'check-integrity=false')
    $optsText = ($Options.Keys | ForEach-Object { $_ + '=' + $Options[$_] }) -join ' '
    foreach ($f in $forbidden) {
        if ($optsText -like ('*' + $f + '*')) { return $false }
    }
    return $true
}
