# [F59 §2] FAIL-CLOSED verification for the prebuilt release assets.
#
# Dot-sourced by the main.yml F59 pre-warm step (both in the step process and
# inside the background download job) and by tests/f59-prewarm-parallel.ps1,
# which proves the fail-closed paths against real fixture files. These functions
# only ever READ; they never stage, execute or repair an asset.
#
# Contract: a non-empty, 64-hex pin must match the observed digest byte-for-byte.
# An EMPTY pin is refused (bootstrap must be completed and committed first) - a
# missing pin is never treated as "trust it". Any problem THROWS; there is no
# warn-and-continue mode.

function Test-F59AssetSha256 {
    param([string]$Path, [string]$Expected, [string]$Label)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { throw ('[F59 prebuilt] ' + $Label + ' missing at ' + $Path) }
    $sha = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    $pin = ''
    if ($Expected) { $pin = $Expected.Trim().ToLowerInvariant() }
    if ([string]::IsNullOrWhiteSpace($pin)) {
        throw ('[F59 prebuilt] ' + $Label + ' has an EMPTY sha256 pin - refusing an unverified asset (complete the bootstrap in payloads/f59-prebuilt-pins.json first)')
    }
    if ($sha -notmatch '^[0-9a-f]{64}$') { throw ('[F59 prebuilt] ' + $Label + ' digest unreadable: ' + $sha) }
    if ($sha -ne $pin) {
        throw ('[F59 prebuilt] SHA-256 MISMATCH for ' + $Label + ': pin=' + $pin + ' observed=' + $sha + ' - refusing to stage or execute')
    }
    Write-Host ('[F59 prebuilt] ' + $Label + ' sha256=' + $sha + ' PIN OK')
    return $sha
}

function Test-F59ChecksumsLine {
    param([string]$ChecksumsPath, [string]$AssetName, [string]$Expected)
    if (-not (Test-Path -LiteralPath $ChecksumsPath)) { throw ('[F59 prebuilt] release checksums.txt missing at ' + $ChecksumsPath) }
    $line = ''
    foreach ($l in (Get-Content -LiteralPath $ChecksumsPath)) {
        if ($l -match [regex]::Escape($AssetName)) { $line = $l.Trim(); break }
    }
    if (-not $line) { throw ('[F59 prebuilt] checksums.txt has no line for ' + $AssetName) }
    $sha = (($line -split '\s+')[0]).ToLowerInvariant()
    if ($Expected -and ($sha -ne $Expected.Trim().ToLowerInvariant())) {
        throw ('[F59 prebuilt] checksums.txt (' + $sha + ') disagrees with the committed pin (' + $Expected + ') for ' + $AssetName + ' - refusing')
    }
    if ($sha -notmatch '^[0-9a-f]{64}$') { throw ('[F59 prebuilt] checksums.txt line for ' + $AssetName + ' is not a sha256: ' + $sha) }
    return $sha
}
