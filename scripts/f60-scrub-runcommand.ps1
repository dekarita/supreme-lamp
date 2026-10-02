# [F60 §2 step 6b] POST-RUN SECRET SCRUB for the Azure VM.
#
# `az vm run-command invoke` writes every --parameters value into the Run Command
# extension's RuntimeSettings files on the VM. The bootstrap's parameters include
# the Tailscale auth key, the runner registration token and the repo access token,
# so those files are secret-bearing on disk. scripts/f60-bootstrap.ps1 deletes the
# OLDER ones but must keep its own (deleting the settings of the invocation that is
# currently running can stop the extension from reporting status, which would read
# as a failed provision).
#
# The provisioning workflow therefore runs THIS script after the bootstrap
# returns. It takes NO parameters, so its own settings file carries no secret, and
# it removes every other settings file - including the bootstrap's.
#
# Marker contract: SCRUB_OK removed=<n> kept=<m>  |  SCRUB_FAILED: <reason>

[CmdletBinding()]
param(
    [switch]$DefineOnly,
    [switch]$IncludeNewest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Clear-F60RunCommandSettings {
    # Returns @{ removed = <int>; kept = <int>; files = <string[]> }. Never throws
    # for a missing plugin directory: an absent extension simply has nothing to
    # scrub, and the count is the evidence.
    param([switch]$IncludeNewest)
    $removed = 0
    $kept = 0
    $seen = @()
    foreach ($plugin in @('Microsoft.Compute.RunCommandExtension', 'Microsoft.Compute.CustomScriptExtension')) {
        $base = Join-Path 'C:\Packages\Plugins' $plugin
        if (-not (Test-Path -LiteralPath $base)) { continue }
        $files = @(Get-ChildItem -Path $base -Recurse -Filter '*.settings' -File -ErrorAction SilentlyContinue | Sort-Object -Property LastWriteTimeUtc -Descending)
        $i = 0
        foreach ($f in $files) {
            $i++
            $seen += $f.FullName
            if (($i -eq 1) -and (-not $IncludeNewest)) { $kept++; continue }
            try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $removed++ } catch { $kept++ }
        }
    }
    return @{ removed = $removed; kept = $kept; files = $seen }
}

if (-not $DefineOnly) {
    try {
        $r = Clear-F60RunCommandSettings -IncludeNewest:$IncludeNewest
        Write-Host ('[F60 scrub] Run Command runtime-settings files seen=' + @($r.files).Count + ' removed=' + $r.removed + ' kept=' + $r.kept)
        Write-Host ('SCRUB_OK removed=' + $r.removed + ' kept=' + $r.kept)
        exit 0
    } catch {
        Write-Host ('SCRUB_FAILED: ' + $_.Exception.Message)
        exit 1
    }
}
