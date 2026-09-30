# [F58 §4] PS lab: the F58 store encrypt/decrypt round-trip + write-verify, run
# against the SHIPPED module (payloads/ghrdp-sources.ps1) - not a copy. Temp dir
# only; nothing here touches ~/.ghrdp, the network, or a real credential store.
param([switch]$SkipLargeCells)
$ErrorActionPreference = 'Stop'
$skipLarge = $SkipLargeCells.IsPresent
$mod = Join-Path $PSScriptRoot '..\payloads\ghrdp-sources.ps1'
if (-not (Test-Path -LiteralPath $mod)) { Write-Host '[F58] FAIL module missing'; exit 1 }
. (Resolve-Path $mod)

$script:fails = 0
function Ok([bool]$cond, [string]$label, [string]$detail) {
    # One annotation per cell: the windows run-log blob is not reachable from the
    # session sandbox, so the check-run annotations carry the proof (F50 lesson).
    $line = ($label + ' :: ' + $detail) -replace '[\r\n]+', ' '
    if ($cond) { Write-Host ('[F58] PASS ' + $line); Write-Host ('::notice title=F58 cell::' + $line) }
    else { Write-Host ('[F58] FAIL ' + $line); Write-Host ('::error title=F58 cell::' + $line); $script:fails = $script:fails + 1 }
}

$dir = Join-Path $env:RUNNER_TEMP ('ghrdp-f58-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $dir -Force
try {
    $key = New-F58PerRunKey
    Ok ($key.Length -eq 32) 'KEY-SHAPE' 'per-run key is 32 bytes, memory only'
    $key2 = New-F58PerRunKey
    Ok (([System.BitConverter]::ToString($key) -ne [System.BitConverter]::ToString($key2))) 'KEY-RANDOM' 'two calls produced independent keys'

    # ---- 1. round-trip (unicode + Sinhala, since operator names are localized)
    $sentinel = 'PLAINTEXT-MARKER-4f9c'
    $plain = '{"sources":[{"descriptor":{"id":"code-hosting-github","nameKey":"' + $sentinel + '"},"f58":{"enableState":"permanent"}}],"note":"සංස්කරණය"}'
    $cipher = Protect-F58Blob -Plain $plain -Key $key
    Ok ($cipher.StartsWith('v1:')) 'ENVELOPE' 'v1 salt:iv:ciphertext envelope'
    $back = Unprotect-F58Blob -Cipher $cipher -Key $key
    Ok ($back -eq $plain) 'CRYPTO-ROUNDTRIP' 'decrypt(encrypt(x)) == x (unicode + Sinhala preserved)'
    Ok ($cipher -notmatch [regex]::Escape($sentinel)) 'CIPHER-SCRUBBED' 'the ciphertext never carries the plaintext marker'

    # ---- 2. wrong key fails closed, never a partial plaintext
    $wrong = Unprotect-F58Blob -Cipher $cipher -Key $key2
    Ok ($null -eq $wrong) 'WRONG-KEY-REFUSED' 'decrypt with a foreign key returns null (no fallthrough)'
    $torn = $cipher.Substring(0, $cipher.Length - 8) + 'AAAAAAAA'
    Ok ($null -eq (Unprotect-F58Blob -Cipher $torn -Key $key)) 'TORN-CIPHER-REFUSED' 'a truncated envelope is refused'
    Ok ($null -eq (Unprotect-F58Blob -Cipher 'not-an-envelope' -Key $key)) 'BAD-ENVELOPE-REFUSED' 'a non-v1 payload is refused'

    # ---- 3. write-verify: sidecar digest of the WRITTEN bytes, read back
    $w = Write-F58StoreFile -Dir $dir -Name 'operator-cache' -Json $cipher -Key $key
    Ok ($w.ok -eq $true) 'WRITE-OK' 'atomic write + sidecar digest'
    $fileBytes = [System.IO.File]::ReadAllBytes($w.path)
    $recalc = Get-F58Sha256Hex -Bytes $fileBytes
    Ok ($recalc -eq $w.sha256) 'WRITE-VERIFY' 'read-back digest == recorded digest'
    Ok ((Get-Content -LiteralPath $w.sidecar -Raw).Trim() -eq $w.sha256) 'SIDECAR-TRUE' 'the sidecar names the bytes actually on disk'
    $left = @(Get-ChildItem -LiteralPath $dir -Filter '*.tmp' -ErrorAction SilentlyContinue)
    Ok ($left.Count -eq 0) 'ATOMIC-TMP' 'no temp file survives a write'
    $r = Read-F58StoreFile -Dir $dir -Name 'operator-cache' -Key $key
    Ok ($r.ok -eq $true -and $r.plain -eq $cipher) 'READ-BACK' 'store read returns the stored ciphertext payload'

    # ---- 4. tamper: one flipped byte is refused before any decrypt is attempted
    $bytes = [System.IO.File]::ReadAllBytes($w.path)
    $bytes[3] = ($bytes[3] -bxor 0xFF)
    [System.IO.File]::WriteAllBytes($w.path, $bytes)
    $t = Read-F58StoreFile -Dir $dir -Name 'operator-cache' -Key $key
    Ok ($t.ok -eq $false -and $t.reason -like '*sha256-mismatch*') 'TAMPER-DETECTED' ('refused with: ' + $t.reason)
    $null = Remove-Item -LiteralPath $w.path, $w.sidecar -Force

    # ---- 5. no plaintext ever lands on disk (recursive scan of the store dir)
    $hits = @(Get-ChildItem -LiteralPath $dir -Recurse -File | Where-Object {
            (Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue) -match [regex]::Escape($sentinel)
        })
    Ok ($hits.Count -eq 0) 'NO-PLAINTEXT-ON-DISK' 'the descriptor plaintext marker appears in zero files in the store dir'

    # ---- 6. cross-runtime digest parity with the shared TS store (sha256Hex)
    $vector = [System.Text.Encoding]::UTF8.GetBytes('{"a":1,"b":[2,"x"]}')
    $vh = Get-F58Sha256Hex -Bytes $vector
    Ok ($vh -eq '454597f51f0e5988dd7d0864f82e826d91fd43ed815a21bb06cd7181e8547a2f') 'DIGEST-PARITY' 'PowerShell and the TS store agree on one digest'

    # ---- 7. startup: unreachable operator store + cached cipher = READ-ONLY live
    $doc = '{"sources":[{"descriptor":{"id":"code-hosting-github"},"f58":{"enableState":"permanent"}}]}'
    $docCipher = Protect-F58Blob -Plain $doc -Key $key
    $null = Write-F58StoreFile -Dir $dir -Name 'operator-cache' -Json $docCipher -Key $key
    $s = Invoke-F58Startup -Key $key -Url '' -Dir $dir
    Ok ($s.mode -eq 'cache-read-only' -and $s.readOnly -eq $true -and $s.entries -eq 1) 'STARTUP-CACHE-FALLBACK' ('mode=' + $s.mode + ' entries=' + $s.entries)
    Ok ($s.plain -eq $doc) 'STARTUP-PLAIN-EXACT' 'the registry is populated from the decrypted cache, byte for byte'

    # ---- 8. startup with a foreign key: decrypt fails, startup is REFUSED
    $empty = Join-Path $dir ('empty-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $empty -Force
    $s2 = Invoke-F58Startup -Key $key -Url '' -Dir $empty
    Ok ($s2.mode -eq 'live' -and $s2.reason -like '*no cached blob*') 'STARTUP-EMPTY-IS-LOUD' ('reason=' + $s2.reason)
    $s3 = Invoke-F58Startup -Key $key2 -Url '' -Dir $dir
    Ok ($s3.mode -ne 'cache-read-only' -and $s3.plain -eq $null) 'STARTUP-WRONG-KEY-NO-PLAINTEXT' 'a wrong key yields no plaintext and no registry'

    # ---- 9. operator-store guards: https only, no IP literal, no silent call
    $g1 = Get-F58OperatorBlob -Url ''
    Ok ($g1.reason -like 'sources-url-unset*') 'GUARD-UNSET' ('reason=' + $g1.reason)
    $g2 = Get-F58OperatorBlob -Url 'http://100.64.1.1/sources.json'
    Ok ($g2.reason -eq 'sources-url-not-https') 'GUARD-HTTPS' ('reason=' + $g2.reason)
    $g3 = Get-F58OperatorBlob -Url 'https://100.64.1.1/sources.json'
    Ok ($g3.reason -eq 'sources-url-ip-literal') 'GUARD-IP-LITERAL' ('reason=' + $g3.reason)

    # ---- 10. oversized blobs are refused before a write (bounded store)
    if (-not $skipLarge) {
        $big = 'x' * 4400000
        $wb = Write-F58StoreFile -Dir $dir -Name 'oversize' -Json $big -Key $key
        Ok ($wb.ok -eq $false -and $wb.reason -eq 'blob-too-large') 'BOUNDED-STORE' ('reason=' + $wb.reason)
    } else {
        Write-Host '[F58] SKIP BOUNDED-STORE (small-cells mode)'
    }
} finally {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($script:fails -gt 0) {
    Write-Host ('[F58] FAIL ' + $script:fails + ' cell(s) failed')
    exit 1
}
Write-Host '[F58] PS lab PASS: round-trip, fail-closed decrypt, write-verify, tamper refusal, no plaintext on disk, cross-runtime digest parity, startup fallback ladder, store guards'
exit 0
