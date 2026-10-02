# [F65 §3] D: DRIVE SCRATCH DISCIPLINE.
#
# Picks the scratch root for every F65 unpack / temp target: D:\scratch when the
# D: drive exists on the runner, otherwise C:\scratch with a loud ::warning::
# annotation (never a silent fallback, never a halt - scratch is an optimization,
# not a dependency). Dot-source to call Get-F65ScratchRoot; run directly to print
# the verdict and (when GITHUB_ENV is set) export GHRDP_F65_SCRATCH.
function Get-F65ScratchRoot {
    param(
        [string]$Preferred = 'D:\scratch',
        [string]$Fallback = 'C:\scratch',
        [string]$DriveProbe = 'D:\',
        [switch]$Quiet
    )
    $probe = [ordered]@{ d_present = $false; root = ''; source = ''; warning = ''; drive_probe = $DriveProbe }
    try { $probe.d_present = (Test-Path -LiteralPath $DriveProbe -PathType Container) } catch { $probe.d_present = $false }
    if ($probe.d_present) {
        $probe.root = $Preferred
        $probe.source = 'D'
    } else {
        $probe.root = $Fallback
        $probe.source = 'C-fallback'
        $probe.warning = ($DriveProbe + ' not present on this runner - using ' + $Fallback + ' (F65 §3 fallback; measured cost, never fatal)')
    }
    try { New-Item -ItemType Directory -Path $probe.root -Force -ErrorAction Stop | Out-Null } catch { }
    if (-not $Quiet) {
        if ($probe.warning) { Write-Host ('::warning title=F65 scratch::' + $probe.warning) }
        Write-Host ('[F65 scratch] root=' + $probe.root + ' source=' + $probe.source + ' d_present=' + $probe.d_present)
    }
    return [pscustomobject]$probe
}

function Set-F65ScratchEnv {
    param([string]$Root)
    if (-not $Root) { return }
    $env:GHRDP_F65_SCRATCH = $Root
    if ($env:GITHUB_ENV) {
        try { Add-Content -Path $env:GITHUB_ENV -Value ('GHRDP_F65_SCRATCH=' + $Root) -Encoding utf8 } catch { }
    }
}

# Functions only: this file is DOT-SOURCED (the prefetch producer, the main.yml
# launcher/report steps, the windows lab). A run-as-script branch would be a
# footgun the other way round - `$MyInvocation.InvocationName` is not reliably
# '.' when a caller dot-sources a parenthesized path, and an accidental `exit`
# would silently skip the whole prefetch.
# Standalone use: `. .\scripts\f65-detect-scratch.ps1; Get-F65ScratchRoot`
