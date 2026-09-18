# Source functions for apply-agent-fixes.ps1. Not a second runtime agent.
function Assert-TailnetServer([string]$value) {
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($value, [ref]$ip)) { throw 'invalid-runner-address' }
    $b = $ip.GetAddressBytes()
    if ($b.Length -ne 4 -or $b[0] -ne 100 -or $b[1] -lt 64 -or $b[1] -gt 127) { throw 'runner-outside-tailnet' }
    return $ip.ToString()
}
function Http-Get([string]$url, [int]$timeoutSec = 6) {
    try {
        $r = Invoke-RestMethod -Uri $url -Method Get -UseBasicParsing -TimeoutSec $timeoutSec -ErrorAction Stop
        if ($url -like '*client-cmd*') { $script:Http401Count = 0 }
        return $r
    } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($url -like '*client-cmd*' -and $code -eq 401) { $script:Http401Count++ }
        Log ('GET failed HTTP=' + $code) 'HTTP' 'agent'
        return $null
    }
}
function Http-Post([string]$url, $body, [int]$timeoutSec = 8) {
    try {
        $json = $body | ConvertTo-Json -Depth 8 -Compress
        return (Invoke-RestMethod -Uri $url -Method Post -Body $json -ContentType 'application/json' -UseBasicParsing -TimeoutSec $timeoutSec -ErrorAction Stop)
    } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        Log ('POST failed HTTP=' + $code) 'HTTP' 'agent'
        return $null
    }
}
function Get-EnrollTail([int]$n = 40) {
    return 'Automatic historical log upload disabled. Run local diagnostics and redact secrets before sharing.'
}
function Upload-Diag($runner, $dev, [string]$reason) {
    if (-not $runner -or -not $dev -or -not $dev.deviceToken) { return }
    $bundle = @{reason=$reason; regQuery=(Get-RegPath); taskOk=(Get-TaskOk); build=$script:Build}
    Http-Post ('http://' + $runner + ':7331/api/diag-upload') @{deviceId=$dev.deviceId; dt=$dev.deviceToken; reason=$reason; bundle=$bundle} 3 | Out-Null
}
function Poll-Loop {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-Object Threading.Mutex($false, ('Local\GhrdpAgentLoop-' + $sid))
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { Log 'LOOP: another instance owns this interactive session'; return }
        Poll-LoopCore
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
function Do-Dispatch([string]$url) {
    Log 'DISPATCH begin (arguments redacted)'
    try {
        $uri = [uri]$url
        if ($uri.Scheme -ne 'ghrdp') { throw 'invalid-protocol' }
        $verb = $uri.Host.ToLowerInvariant()
        if ($verb -ne 'enroll' -and $verb -ne 'connect') { throw 'unsupported-protocol-verb' }
        $p = @{}
        foreach ($kv in ($uri.Query.TrimStart('?') -split '&')) {
            $pair = $kv -split '=', 2
            if ($pair.Count -eq 2) {
                $name = [uri]::UnescapeDataString($pair[0]).ToLowerInvariant()
                if ($p.ContainsKey($name)) { throw 'duplicate-query-key' }
                $p[$name] = [uri]::UnescapeDataString($pair[1])
            }
        }
        $runner = Assert-TailnetServer $p['server']
        if ($verb -eq 'enroll') { $script:Server = $runner; Do-Enroll; return }
        $token = [string]$p['t']
        if (-not $token) { $token = [string]$p['token'] }
        if (-not $token -or $token.Length -gt 4096) { throw 'missing-or-invalid-token' }
        $prn = $p['print'] -eq '1' -or $p['printers'] -eq '1'
        $pending = @{action='rdp-token'; server=$runner; token=$token; created=[DateTime]::UtcNow.ToString('o'); cmdId=[guid]::NewGuid().ToString('N'); clip=($p['clip'] -eq '1'); mic=($p['mic'] -eq '1'); print=$prn; drives=($p['drives'] -eq '1')}
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $lock = New-Object Threading.Mutex($false, ('Local\GhrdpPending-' + $sid))
        $owned = $false
        $tmp = $script:PendingPath + '.' + [guid]::NewGuid().ToString('N')
        try {
            try { $owned = $lock.WaitOne(2000) } catch [Threading.AbandonedMutexException] { $owned = $true }
            if (-not $owned) { throw 'pending-lock-timeout' }
            if (Test-Path -LiteralPath $script:PendingPath) { throw 'pending-request-exists' }
            $pending | ConvertTo-Json -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
            [IO.File]::Move($tmp, $script:PendingPath)
        } finally {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            if ($owned) { $lock.ReleaseMutex() }
            $lock.Dispose()
        }
        Start-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
        Log 'DISPATCH queued token request'
    } catch { Log 'DISPATCH failed; no credentials or URL logged' 'ERR'; throw }
}
function Consume-Pending($runner, $dev) {
    if (-not (Test-Path -LiteralPath $script:PendingPath)) { return }
    $claimed = $script:PendingPath + '.claimed-' + [guid]::NewGuid().ToString('N')
    try {
        [IO.File]::Move($script:PendingPath, $claimed)
        $p = Get-Content -LiteralPath $claimed -Raw | ConvertFrom-Json
        if ($p.action -ne 'rdp-token') { throw 'unsupported-pending-action' }
        $age = ([DateTime]::UtcNow - [DateTime]::Parse([string]$p.created).ToUniversalTime()).TotalSeconds
        if ($age -lt 0 -or $age -ge 60) { throw 'pending-token-expired' }
        $target = Assert-TailnetServer ([string]$p.server)
        if ($target -ne $runner) { throw 'pending-runner-mismatch' }
        $creds = Http-Get ('http://' + $target + ':7331/api/rdp-creds?token=' + [uri]::EscapeDataString([string]$p.token)) 4
        if (-not $creds -or -not $creds.user -or -not $creds.pass) { throw 'token-redemption-failed' }
        $cmd = @{action='rdp'; cmdId=$p.cmdId; host=$creds.host; user=$creds.user; pass=$creds.pass; clip=[bool]$p.clip; mic=[bool]$p.mic; print=[bool]$p.print; drives=[bool]$p.drives}
        if (-not $cmd.host) { $cmd.host = $creds.hostip }
        Ladder-Connect $runner $dev $cmd
    } catch { Log 'Pending request failed (no automatic retry)' 'ERR' }
    finally { Remove-Item -LiteralPath $claimed -Force -ErrorAction SilentlyContinue }
}
function Stop-StaleMstsc {
    $record = Join-Path $script:AgentDir 'owned-mstsc.json'
    if (-not (Test-Path -LiteralPath $record)) { return }
    try {
        $r = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
        $p = Get-Process -Id ([int]$r.pid) -ErrorAction Stop
        if ($p.ProcessName -eq 'mstsc' -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$r.startTicks) {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            $p.WaitForExit(2000) | Out-Null
        }
    } catch { }
    Remove-Item -LiteralPath $record -Force -ErrorAction SilentlyContinue
}
function Wait-Connected($mstscProc, [DateTime]$baseline, [int]$timeoutSec = 8) {
    # Security 4624 type 10 must be observed on the RDP SERVER, not this client.
    # Generic TSClient events and process survival do not prove Windows logon.
    return @{ok=$false; via='runner-logon-proof-unavailable'; age=-1}
}
function Ladder-Connect($runner, $dev, $cmd) {
    $script:CommandRan = $true
    $cmdId = [string]$cmd.cmdId
    try {
        $hostAddr = [string]$cmd.host
        $user = [string]$cmd.user
        $pass = [string]$cmd.pass
        if (-not $cmdId -or $hostAddr -notmatch '^[a-zA-Z0-9_.:-]+$' -or -not $user -or -not $pass -or $user -match '[\r\n]') { throw 'invalid-command' }
        $opts = @{clip=[bool]$cmd.clip; mic=[bool]$cmd.mic; print=[bool]$cmd.print; drives=[bool]$cmd.drives}
        Stop-StaleMstsc
        $cmdkey = Join-Path $env:SystemRoot 'System32\cmdkey.exe'
        & $cmdkey ('/generic:TERMSRV/' + $hostAddr) ('/user:' + $user) ('/pass:' + $pass) 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'cmdkey-failed' }
        $pass = $null
        $rdp = Write-Rdp $hostAddr $user $opts 2 1
        $mstsc = Join-Path $env:SystemRoot 'System32\mstsc.exe'
        $p = Start-Process -FilePath $mstsc -ArgumentList (([char]34 + $rdp + [char]34) + ' /f') -PassThru
        @{pid=$p.Id; startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString(); cmdId=$cmdId} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $script:AgentDir 'owned-mstsc.json') -Encoding UTF8
        Post-Status $runner $dev 'launched-unverified' @{cmdId=$cmdId; mstscPid=$p.Id; logonAge=-1; err='runner-logon-proof-unavailable'}
        Log ('MSTSC launched cmdId=' + $cmdId + '; logon UNVERIFIED')
    } catch {
        Post-Status $runner $dev 'failed' @{cmdId=$cmdId; err='rdp-launch-failed'}
        Log ('RDP launch failed cmdId=' + $cmdId) 'ERR'
    }
}
