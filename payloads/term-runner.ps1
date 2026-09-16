# term-runner.ps1 — async terminal execution runner
# Started detached by ghrdp-server /terminal-exec. Reads config JSON, runs command, writes result JSON.
param([string]$CfgPath)
$ErrorActionPreference = 'Continue'
try {
    $c = [System.IO.File]::ReadAllText($CfgPath) | ConvertFrom-Json
    $tscript   = [string]$c.scriptPath
    $timeoutMs = [int]$c.timeoutMs
    $workDir   = [string]$c.workDir
    $toutF     = [string]$c.outFile
    $terrF     = [string]$c.errFile
    $resultFile= [string]$c.resultFile
    $tsess     = [string]$c.session
    $tid       = [string]$c.tid
    $rdpUser   = [string]$c.rdpUser
    $auditLog  = [string]$c.auditLog
    $ownScript = [bool]$c.ownScript
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $tres = ''; $terr = ''; $texit = $null; $ttimed = $false
    if ($tsess -eq 'interactive') {
        $ttask = 'GhrdpTerm-' + $tid
        $twrap = '& ' + [char]39 + $tscript + [char]39 + ' *> ' + [char]39 + $toutF + [char]39 + '; exit $LASTEXITCODE'
        $targ = '-NoProfile -ExecutionPolicy Bypass -Command "' + $twrap + '"'
        $tact = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $targ
        $activeU = $null
        foreach ($ln2 in (@(& quser.exe 2>$null))) { if ($ln2 -match '^\s*>?\s*(\S+)\s+\S+\s+\d+\s+Active') { $activeU = $Matches[1] } }
        if (-not $activeU) { $activeU = $rdpUser }
        $tprn = New-ScheduledTaskPrincipal -UserId $activeU -LogonType Interactive -RunLevel Highest
        try {
            Register-ScheduledTask -TaskName $ttask -Action $tact -Principal $tprn -Force -ErrorAction Stop | Out-Null
            Start-ScheduledTask -TaskName $ttask -ErrorAction Stop
            Start-Sleep -Seconds 2
            $tstarted = $false; $tbegin = Get-Date
            while (((Get-Date) - $tbegin).TotalMilliseconds -lt $timeoutMs) {
                try { $tst = (Get-ScheduledTask -TaskName $ttask -ErrorAction Stop).State } catch { $tst = '' }
                if ($tst -eq 'Running') { $tstarted = $true }
                elseif ($tstarted) { break }
                elseif (((Get-Date) - $tbegin).TotalSeconds -gt 20) { break }
                Start-Sleep -Milliseconds 500
            }
            if (-not $tstarted) { throw 'task did not start (no interactive session?)' }
            if (((Get-Date) - $tbegin).TotalMilliseconds -ge $timeoutMs) { $ttimed = $true }
            try { $texit = [int](Get-ScheduledTaskInfo -TaskName $ttask -ErrorAction SilentlyContinue).LastTaskResult } catch { }
        } finally {
            try { Unregister-ScheduledTask -TaskName $ttask -Confirm:$false -ErrorAction SilentlyContinue } catch { }
        }
    } else {
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$tscript+'"')) -RedirectStandardOutput $toutF -RedirectStandardError $terrF -NoNewWindow -PassThru -WorkingDirectory $workDir
        if (-not $p.WaitForExit($timeoutMs)) { try { $p.Kill() } catch { }; $ttimed = $true } else { $texit = $p.ExitCode }
    }
    $sw.Stop()
    for ($rd = 0; $rd -lt 5; $rd++) {
        try { if (Test-Path -LiteralPath $toutF) { $tres = [System.IO.File]::ReadAllText($toutF) }; if (Test-Path -LiteralPath $terrF) { $terr = [System.IO.File]::ReadAllText($terrF) }; break } catch { Start-Sleep -Milliseconds 400 }
    }
    if ($ownScript) { try { Remove-Item -LiteralPath $tscript -Force -ErrorAction SilentlyContinue } catch { } }
    try { Remove-Item -LiteralPath $toutF -Force -ErrorAction SilentlyContinue } catch { }
    try { Remove-Item -LiteralPath $terrF -Force -ErrorAction SilentlyContinue } catch { }
    if ($ttimed) { $tres = 'TIMEOUT after ' + ([int]($timeoutMs / 1000)) + 's' + "`n" + $tres }
    if (-not $tres) { $tres = '(no output)' }
    try { [System.IO.File]::AppendAllText($auditLog, ('RESULT exit=' + $texit + ' timedOut=' + $ttimed + ' ms=' + $sw.ElapsedMilliseconds + ' outLen=' + ([string]$tres).Length + "`n")) } catch { }
    $result = @{ done = $true; output = $tres; error = $terr; exitCode = $texit; timedOut = $ttimed; durationMs = [int]$sw.ElapsedMilliseconds; session = $tsess; scriptPath = $tscript }
    [System.IO.File]::WriteAllText($resultFile, ($result | ConvertTo-Json -Compress))
} catch {
    try { [System.IO.File]::WriteAllText([string]$resultFile, (@{ done = $true; output = ('ERROR: ' + $_.Exception.Message); error = ''; exitCode = $null; timedOut = $false; durationMs = 0; session = 'system'; scriptPath = '' } | ConvertTo-Json -Compress)) } catch { }
} finally {
    try { Remove-Item -LiteralPath $CfgPath -Force -ErrorAction SilentlyContinue } catch { }
}
