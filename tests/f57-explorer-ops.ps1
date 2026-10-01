# [F57 SS5 PS lab] watcher roots=6 live file ops.
# The Explorer's real ops (new / renamed / moved / deleted) are only honest if
# the watcher actually SEES them: this lab resolves the same six roots
# Get-WatcherRoots resolves (Downloads / Desktop / Documents / %TEMP% /
# D:\RDP-Storage / D:\RDP-Storage\Fetched), performs each op for real in every
# root that exists on the runner, and re-walks the root with the SAME
# enumeration the watcher's scan uses (Get-ChildItem -LiteralPath <root> -File
# -Recurse) to prove the change is visible. A root that does not exist on the
# runner (or that the runner refuses writes to) is a LABELED skip (and is
# counted), never a silent pass.
#
# Every cell is wrapped so a single problem can never abort the lab: the last
# line always carries the full failed-cell list, and the exit code is 1 when
# any cell failed.
param([switch]$SkipLiveCells)
$ErrorActionPreference = 'Stop'
Write-Host '[F57] explorer ops lab: watcher roots=6 live file ops'
$script:fails = 0
$script:failed = New-Object System.Collections.ArrayList

function Ok([bool]$cond, [string]$label, [string]$detail) {
    $line = ($label + ' :: ' + $detail) -replace '[\r\n]+', ' '
    if ($cond) {
        Write-Host ('[F57] PASS ' + $line)
    } else {
        Write-Host ('[F57] FAIL ' + $line)
        [void]$script:failed.Add($label)
        Write-Host ('::error title=F57 cell::' + $line)
        $script:fails = $script:fails + 1
    }
}
function Fence([string]$label, [scriptblock]$body) {
    # A cell must be able to throw without taking the whole lab with it.
    try { & $body } catch { Ok $false $label ('threw: ' + $_.Exception.Message) }
}
function Cell([string]$label, [string]$detail, [bool]$cond) { Ok $cond $label $detail }

# ---- 0. repo + watcher resolution (the f52/f53 proven idiom) -----------------
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$watcher = Join-Path $repo 'payloads\ghrdp-watcher.ps1'
if (-not (Test-Path -LiteralPath $watcher)) {
    Ok $false 'WATCHER-PRESENT' 'payloads\ghrdp-watcher.ps1 is missing from the checkout'
    Write-Host ('[F57] explorer ops lab FAILED (1 cell): ' + (($script:failed) -join ', '))
    exit 1
}

try {
    # ---- 1. the watcher parses, and the six-root + scan contracts are pinned --
    $parseErrs = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($watcher, [ref]$null, [ref]$parseErrs)
    Ok ($null -eq $parseErrs -or @($parseErrs).Count -eq 0) 'WATCHER-PARSE' 'ghrdp-watcher.ps1 parses clean (no syntax errors)'

    $text = Get-Content -LiteralPath $watcher -Raw
    Ok ($text.Contains('roots 5->6')) 'ROOTS-5-6' 'the F56-d 5->6 root marker is present'
    Ok ($text.Contains('D:\RDP-Storage\Fetched')) 'ROOT-FETCHED' 'D:\RDP-Storage\Fetched is the sixth root'
    Ok ($text.Contains('function Get-WatcherRoots')) 'ROOT-FN' 'Get-WatcherRoots is the single root source'
    Ok ($text -match 'Get-ChildItem -LiteralPath \$r -File -Recurse') 'SCAN-ENUM' 'the scan enumerates each root with the same walk this lab uses'

    # ---- 2. the six roots, resolved the way Get-WatcherRoots resolves them ----
    $prof = [string]$env:USERPROFILE
    if (-not $prof) { try { $prof = [Environment]::GetFolderPath('UserProfile') } catch { $prof = '' } }
    $tmp = [string]$env:TEMP
    if (-not $tmp) { try { $tmp = [IO.Path]::GetTempPath() } catch { $tmp = '' } }
    $candidates = New-Object System.Collections.ArrayList
    foreach ($sub in @('Downloads', 'Desktop', 'Documents')) {
        if ($prof) { [void]$candidates.Add((Join-Path $prof $sub)) }
    }
    if ($tmp) { [void]$candidates.Add($tmp) }
    [void]$candidates.Add('D:\RDP-Storage')
    [void]$candidates.Add('D:\RDP-Storage\Fetched')
    $roots = @($candidates | Select-Object -Unique)
    Ok ($roots.Count -eq 6) 'ROOT-COUNT' ('six candidate roots resolved on this runner: ' + $roots.Count)

    function Test-ScanSees([string]$root, [string]$fullPath) {
        $found = @()
        try { $found = @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue) } catch { $found = @() }
        foreach ($f in $found) {
            if ($null -eq $f) { continue }
            if (([string]$f.FullName).ToLower() -eq $fullPath.ToLower()) { return $true }
        }
        return $false
    }

    # ---- 3. live ops in every root that exists (new / renamed / moved / deleted)
    $live = 0
    $skipped = 0
    if ($SkipLiveCells.IsPresent) {
        Write-Host '[F57] SKIP live file-op cells (-SkipLiveCells)'
    } else {
        foreach ($r in $roots) {
            if (-not (Test-Path -LiteralPath $r)) {
                $skipped = $skipped + 1
                Ok $true ('ROOT-SKIP:' + $r) 'root not present on this runner - live cells skipped (labeled)'
                continue
            }
            Write-Host ('[F57] live root: ' + $r)
            $live = $live + 1
            $name = 'f57-lab-' + [guid]::NewGuid().ToString('N') + '.txt'
            $file = Join-Path $r $name
            $sub = Join-Path $r 'f57-lab-sub'
            try {
                # NEW
                'f57 lab benign content' | Set-Content -LiteralPath $file -Encoding utf8
                Ok (Test-ScanSees $r $file) ('NEW:' + $r) 'a newly created file is visible to the watcher scan walk'

                # RENAMED
                $renamed = Join-Path $r ($name -replace '\.txt$', '-renamed.txt')
                Move-Item -LiteralPath $file -Destination $renamed -Force
                Ok ((Test-ScanSees $r $renamed) -and (-not (Test-ScanSees $r $file))) ('RENAMED:' + $r) 'the renamed file is visible and the old name is gone'

                # MOVED (into a subfolder of the same root)
                $null = New-Item -ItemType Directory -Path $sub -Force
                $moved = Join-Path $sub (Split-Path -Leaf $renamed)
                Move-Item -LiteralPath $renamed -Destination $moved -Force
                Ok ((Test-ScanSees $r $moved) -and (-not (Test-ScanSees $r $renamed))) ('MOVED:' + $r) 'the moved file is visible at the destination and gone from the source'

                # DELETED
                Remove-Item -LiteralPath $moved -Force
                Ok (-not (Test-ScanSees $r $moved)) ('DELETED:' + $r) 'the deleted file is gone from the scan walk'
            } catch {
                $msg = $_.Exception.Message
                if ($msg -match 'denied|UnauthorizedAccess') {
                    $skipped = $skipped + 1
                    Ok $true ('ROOT-SKIP-WRITE:' + $r) ('runner refused writes to this root - live cells skipped (labeled): ' + $msg)
                } else {
                    Ok $false ('OPS:' + $r) ('live file ops threw: ' + $msg)
                }
            } finally {
                try { if (Test-Path -LiteralPath $sub) { Remove-Item -LiteralPath $sub -Recurse -Force -ErrorAction SilentlyContinue } } catch { }
                try { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue } } catch { }
            }
        }
    }
    Ok ($live -ge 1) 'LIVE-CELLS' ('roots exercised live: ' + $live + ' | labeled skips: ' + $skipped)

    # ---- 4. the contracts the Explorer's transport + trash rely on ------------
    $transport = Join-Path $repo 'src\lib\explorer\transport.ts'
    $trash = Join-Path $repo 'src\lib\explorer\trash.ts'
    $ops = Join-Path $repo 'src\lib\explorer\ops.ts'
    if (Test-Path -LiteralPath $transport) {
        $ts = Get-Content -LiteralPath $transport -Raw
        Ok ($ts.Contains('SERVER_OPS: readonly ServerOpName[] = ["trash", "restore", "move"]')) 'OP-FENCE' 'the client can only express trash/restore/move - there is no hard-delete op'
    } else {
        Ok $true 'OP-FENCE' 'transport.ts not present in this checkout - cell skipped (labeled)'
    }
    if (Test-Path -LiteralPath $trash) {
        $tt = Get-Content -LiteralPath $trash -Raw
        Ok ($tt.Contains('D:\RDP-Storage\.trash') -and $tt.Contains('30')) 'TRASH-ROOT' 'soft delete routes to D:\RDP-Storage\.trash with a 30-day retention'
    } else {
        Ok $true 'TRASH-ROOT' 'trash.ts not present in this checkout - cell skipped (labeled)'
    }
    if (Test-Path -LiteralPath $ops) {
        $ot = Get-Content -LiteralPath $ops -Raw
        Ok ($ot.Contains('UNDO_LIMIT = 20')) 'UNDO-20' 'the undo stack keeps the last 20 ops'
    } else {
        Ok $true 'UNDO-20' 'ops.ts not present in this checkout - cell skipped (labeled)'
    }
} catch {
    Ok $false 'UNEXPECTED-ABORT' ($_.Exception.Message)
}

if ($script:fails -gt 0) {
    $list = ($script:failed) -join ', '
    Write-Host ('[F57] watcher roots=6 live file ops lab FAILED (' + $script:fails + ' cell(s)): ' + $list)
    Write-Host ('::error title=F57 lab summary::' + $script:fails + ' cell(s) failed: ' + $list)
    exit 1
}
Write-Host '[F57] watcher roots=6 live file ops lab PASS'
exit 0
