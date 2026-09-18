# ghrdp-agent.ps1 v3 (build 3.0.0) - persistent pull-model RDP agent.
# INVARIANTS (do not violate):
#   - param() FIRST executable statement (else PowerShell ignores it)
#   - ASCII-only (no non-ASCII chars anywhere)
#   - ZERO -f format operators (bug #56: & inside -f breaks the parser)
#   - URLs built by single-quoted concatenation only
#   - Test-PsSyntax gates every remote agent.ps1 copy before overwrite
#   - transcript-before-action to enroll.log
#   - top-level try/catch logs exceptions

[CmdletBinding()]
param(
    [switch]$Enroll,
    [string]$Server = '',
    [switch]$Loop,
    [switch]$Poll,
    [string]$Dispatch = '',
    [switch]$SelfHealOnly
)

# ---- Transcript-before-action ---------------------------------------------
$script:AgentDir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
if (-not (Test-Path $script:AgentDir)) { try { New-Item -ItemType Directory -Path $script:AgentDir -Force | Out-Null } catch {} }
$script:EnrollLog = Join-Path $script:AgentDir 'enroll.log'
$script:LogPath   = Join-Path $script:AgentDir 'agent.log'
$script:LogBak    = $script:LogPath + '.1'
try {
    $argSummary = 'START v3.0.0 pid=' + $PID + ' Enroll=' + [bool]$Enroll + ' Server=' + $Server + ' Loop=' + [bool]$Loop + ' Poll=' + [bool]$Poll + ' Dispatch=' + $Dispatch + ' SelfHealOnly=' + [bool]$SelfHealOnly
    Add-Content -LiteralPath $script:EnrollLog -Value ((Get-Date -Format o) + ' ' + $argSummary) -ErrorAction SilentlyContinue
} catch {}

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$script:Build       = '3.0.0'
$script:AgentPath   = Join-Path $script:AgentDir 'agent.ps1'
$script:PendingPath = Join-Path $script:AgentDir 'pending.json'
$script:DeviceJson  = Join-Path $script:AgentDir 'device.json'
$script:TaskName    = 'GhrdpAgent'
$script:SysPwsh     = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Sustained 401 tracking (bug #58 companion: auto re-enroll after token invalidation)
$script:Http401Count = 0
$script:LastReEnroll = [DateTime]::MinValue

function Log([string]$msg,[string]$lvl='INFO',[string]$tgt='both') {
    $ln = (Get-Date -Format o) + ' [' + $lvl + '] ' + $msg
    try {
        if ($tgt -eq 'both' -or $tgt -eq 'enroll') {
            Add-Content -LiteralPath $script:EnrollLog -Value $ln -ErrorAction SilentlyContinue
        }
        if ($tgt -eq 'both' -or $tgt -eq 'agent') {
            if ((Test-Path $script:LogPath) -and (Get-Item $script:LogPath).Length -gt 200KB) {
                try { Copy-Item $script:LogPath $script:LogBak -Force -ErrorAction SilentlyContinue } catch {}
                try { Clear-Content $script:LogPath -Force -ErrorAction SilentlyContinue } catch {}
            }
            Add-Content -LiteralPath $script:LogPath -Value $ln -ErrorAction SilentlyContinue
        }
    } catch {}
}

# ---- PSParser gate (Test-PsSyntax) ----------------------------------------
# Returns $true when the script parses cleanly. Used to protect against bug #58
# (never overwrite a good local agent with an unparseable remote push).
function Test-PsSyntax([string]$path) {
    try {
        if (-not (Test-Path -LiteralPath $path)) { return $false }
        $text = Get-Content -LiteralPath $path -Raw
        if (-not $text -or $text.Length -lt 1000) { return $false }
        $errors = $null
        [void][System.Management.Automation.PSParser]::Tokenize($text, [ref]$errors)
        if ($errors -and $errors.Count -gt 0) {
            $first = $errors[0]
            Log ('PSParser FAIL count=' + $errors.Count + ' first-line=' + $first.Token.StartLine + ' msg=' + $first.Message) 'ERR'
            return $false
        }
        return $true
    } catch { Log ('PSParser exception: ' + $_.Exception.Message) 'ERR'; return $false }
}

# ---- HTTP helpers with 3 retries + full transcript ------------------------
function Http-Get([string]$url,[int]$timeoutSec = 6) {
    for ($i = 1; $i -le 3; $i++) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            Log ('GET ' + $url + ' attempt=' + $i + ' timeout=' + $timeoutSec) 'HTTP' 'agent'
            $r = Invoke-RestMethod -Uri $url -Method Get -UseBasicParsing -TimeoutSec $timeoutSec
            $sw.Stop()
            Log ('GET-OK ' + $url + ' ms=' + $sw.ElapsedMilliseconds) 'HTTP' 'agent'
            return $r
        } catch {
            $sw.Stop()
            $stat = ''
            try { $stat = 'status=' + [int]$_.Exception.Response.StatusCode + ' ' } catch {}
            Log ('GET-FAIL ' + $url + ' attempt=' + $i + ' ms=' + $sw.ElapsedMilliseconds + ' ' + $stat + 'err=' + $_.Exception.Message) 'HTTP' 'agent'
            # Sustained 401 tracker on client-cmd
            if ($url -like '*client-cmd*' -and $stat -like '*401*') { $script:Http401Count++ }
            if ($i -lt 3) { Start-Sleep -Milliseconds (400 * $i) }
        }
    }
    return $null
}
function Http-Post([string]$url, $body, [int]$timeoutSec = 8) {
    $json = $null
    try { $json = ($body | ConvertTo-Json -Depth 8 -Compress) } catch { Log ('POST serialize fail ' + $url + ' ' + $_.Exception.Message) 'ERR' 'agent'; return $null }
    for ($i = 1; $i -le 3; $i++) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            $snip = $json
            if ($snip.Length -gt 220) { $snip = $snip.Substring(0, 220) + '...' }
            Log ('POST ' + $url + ' attempt=' + $i + ' body=' + $snip) 'HTTP' 'agent'
            $r = Invoke-RestMethod -Uri $url -Method Post -Body $json -ContentType 'application/json' -UseBasicParsing -TimeoutSec $timeoutSec
            $sw.Stop()
            Log ('POST-OK ' + $url + ' ms=' + $sw.ElapsedMilliseconds) 'HTTP' 'agent'
            return $r
        } catch {
            $sw.Stop()
            $stat = ''
            try { $stat = 'status=' + [int]$_.Exception.Response.StatusCode + ' ' } catch {}
            Log ('POST-FAIL ' + $url + ' attempt=' + $i + ' ms=' + $sw.ElapsedMilliseconds + ' ' + $stat + 'err=' + $_.Exception.Message) 'HTTP' 'agent'
            if ($i -lt 3) { Start-Sleep -Milliseconds (400 * $i) }
        }
    }
    return $null
}

function Normalize-Url([string]$u) {
    if (-not $u) { return '' }
    return ($u -replace '(?<!:)/{2,}', '/')
}

# ---- F1: atomic + shared device.json IO (fixes E1 lock contention) --------
# Read-DeviceJson opens the file with FileShare.ReadWrite so a concurrent writer/reader
# never triggers IOException 'file is being used by another process'. 4 retries at 250ms
# backoff cover transient collisions inside the atomic rename window. Never returns null
# on transient failure - only when the file genuinely does not exist or is truly corrupt.
function Read-DeviceJson {
    if (-not (Test-Path -LiteralPath $script:DeviceJson)) { return $null }
    $lastErr = ''
    for ($i = 1; $i -le 4; $i++) {
        $fs = $null; $sr = $null
        try {
            $fs = [System.IO.File]::Open($script:DeviceJson, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8, $true)
            $text = $sr.ReadToEnd()
            if ($text) {
                # Strip BOM if present
                if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
                return ($text | ConvertFrom-Json)
            }
            return $null
        } catch {
            $lastErr = $_.Exception.Message
            if ($i -lt 4) { Start-Sleep -Milliseconds 250 }
        } finally {
            if ($sr) { $sr.Dispose() }
            if ($fs) { $fs.Dispose() }
        }
    }
    Log ('Read-DeviceJson: exhausted 4 retries err=' + $lastErr) 'WARN'
    return $null
}
function Write-DeviceJson($obj) {
    $tmp = $script:DeviceJson + '.tmp'
    try {
        $json = $obj | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::Move($tmp, $script:DeviceJson, $true)
        return $true
    } catch {
        Log ('Write-DeviceJson: fail err=' + $_.Exception.Message) 'ERR'
        try { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } } catch {}
        return $false
    }
}
# Back-compat wrappers so existing call sites keep working
function Load-Device { return (Read-DeviceJson) }
function Save-Device($obj) { [void](Write-DeviceJson $obj) }

function Ping-Runner([string]$ip) {
    if ([string]::IsNullOrWhiteSpace($ip)) { return $null }
    $r = Http-Get ('http://' + $ip + ':7331/api/ping') 3
    if ($r -and $r.epoch) { return $r }
    return $null
}

$script:LastTailScan = [DateTime]::MinValue
$script:TailCache = @()
function Scan-Tailscale {
    # 30s throttle to avoid spawning tailscale.exe every 2s
    if (([DateTime]::UtcNow - $script:LastTailScan).TotalSeconds -lt 30 -and $script:TailCache.Count -gt 0) { return $script:TailCache }
    $ts = 'C:\Program Files\Tailscale\tailscale.exe'
    if (-not (Test-Path $ts)) { return @() }
    try {
        $j = (& $ts status --json 2>$null | ConvertFrom-Json)
        $ips = @()
        if ($j.Peer) {
            foreach ($p in $j.Peer.PSObject.Properties) {
                if ($p.Value.Online) { $ips += @($p.Value.TailscaleIPs)[0] }
            }
        }
        $script:LastTailScan = [DateTime]::UtcNow
        $script:TailCache = $ips
        Log ('tailscale online peers=' + $ips.Count) 'DBG' 'agent'
        return $ips
    } catch {
        Log ('tailscale scan fail ' + $_.Exception.Message) 'WARN' 'agent'
        return @()
    }
}

function Discover-Runner($dev) {
    if ($Server) {
        $p = Ping-Runner $Server
        if ($p) { Log ('discover: -Server arg OK ' + $Server) 'DBG' 'agent'; return $Server }
    }
    if ($dev -and $dev.lastRunner) {
        $p = Ping-Runner $dev.lastRunner
        if ($p) { return $dev.lastRunner }
    }
    foreach ($ip in (Scan-Tailscale)) {
        $p = Ping-Runner $ip
        if ($p) { Log ('discover: tailscale ' + $ip) 'DBG' 'agent'; return $ip }
    }
    if ($dev -and $dev.pagesUrl) {
        $u = Normalize-Url $dev.pagesUrl
        $s = Http-Get $u 6
        if ($s -and $s.runnerIp) {
            $p = Ping-Runner $s.runnerIp
            if ($p) { Log ('discover: pages ' + $s.runnerIp) 'DBG' 'agent'; return $s.runnerIp }
        }
    }
    if ($dev -and $dev.runnersCache) {
        foreach ($ip in @($dev.runnersCache)) {
            $p = Ping-Runner $ip
            if ($p) { return $ip }
        }
    }
    Log 'discover: NO RUNNER FOUND' 'ERR' 'agent'
    return $null
}

function Update-Cache($dev, [string]$ip) {
    if (-not $dev) { return $dev }
    $dev.lastRunner = $ip
    $cache = @()
    if ($dev.runnersCache) { $cache = @($dev.runnersCache) }
    $cache = @($ip) + ($cache | Where-Object { $_ -ne $ip })
    if ($cache.Count -gt 5) { $cache = $cache[0..4] }
    $dev.runnersCache = $cache
    Save-Device $dev
    return $dev
}

function Get-AgentHash {
    try {
        if (-not (Test-Path $script:AgentPath)) { return '' }
        return (Get-FileHash -LiteralPath $script:AgentPath -Algorithm SHA256).Hash.ToLower()
    } catch { return '' }
}

function Get-RegPath {
    try { return [string](Get-ItemProperty -Path 'HKCU:\Software\Classes\ghrdp\shell\open\command' -Name '(default)' -ErrorAction Stop).'(default)' } catch { return '' }
}

function Get-TaskOk {
    try { $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop; return ($null -ne $t) } catch { return $false }
}

# ---- Wait-Connected: LogonType 10 preferred, degraded fallbacks -----------
# baseline = timestamp before mstsc launch. Only counts events NEWER than baseline
# (else stale 4624 from an unrelated logon reads as instant success).
function Wait-Connected($mstscProc, [DateTime]$baseline, [int]$timeoutSec = 8) {
    for ($i = 0; $i -lt $timeoutSec; $i++) {
        Start-Sleep -Seconds 1
        # (a) Preferred: Security 4624 LogonType 10 newer than baseline (requires SeSecurityPrivilege)
        try {
            $ev = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4624; StartTime=$baseline } -MaxEvents 5 -ErrorAction SilentlyContinue |
                  Where-Object { $_.Message -match 'Logon Type:\s+10' } | Select-Object -First 1
            if ($ev) {
                $age = [int]((Get-Date) - $ev.TimeCreated).TotalSeconds
                return @{ ok = $true; via = '4624'; age = $age }
            }
        } catch {}
        # (b) Degraded: TerminalServices-ClientActiveXCore recency <=20s (standard-user readable)
        try {
            $ev2 = Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational'; StartTime=$baseline } -MaxEvents 5 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($ev2) {
                $age2 = [int]((Get-Date) - $ev2.TimeCreated).TotalSeconds
                if ($age2 -le 20) { return @{ ok = $true; via = 'tsclient'; age = $age2 } }
            }
        } catch {}
        # (c) Final fallback: mstsc survives 8s grace (didn't crash / no blank dialog)
        if ($mstscProc -and $mstscProc.HasExited) { return @{ ok = $false; via = 'mstsc-exited'; age = -1 } }
    }
    # Timed out - one last mstsc-survival check
    if ($mstscProc -and -not $mstscProc.HasExited) { return @{ ok = $true; via = 'mstsc-survived'; age = -1 } }
    return @{ ok = $false; via = 'timeout'; age = -1 }
}

# ---- Stale RDP file cleanup + stale mstsc kill ----------------------------
function Cleanup-StaleRdp {
    try {
        Get-ChildItem -LiteralPath $script:AgentDir -Filter 'ghrdp-*.rdp' -ErrorAction SilentlyContinue |
            Where-Object { ((Get-Date) - $_.LastWriteTime).TotalHours -gt 1 } |
            ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }
        Get-ChildItem -LiteralPath $script:AgentDir -Filter 'sess-*.rdp' -ErrorAction SilentlyContinue |
            Where-Object { ((Get-Date) - $_.LastWriteTime).TotalHours -gt 1 } |
            ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }
    } catch {}
}
function Stop-StaleMstsc {
    try {
        Get-Process mstsc -ErrorAction SilentlyContinue | ForEach-Object {
            try { $_ | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
        }
    } catch {}
}

function Get-EnrollTail([int]$n = 40) {
    try {
        if (-not (Test-Path $script:EnrollLog)) { return '' }
        return ((Get-Content -LiteralPath $script:EnrollLog -Tail $n) -join "`n")
    } catch { return '' }
}

function Register-Protocol {
    Log ('register-protocol: HKCU\Software\Classes\ghrdp -> ' + $script:SysPwsh)
    try {
        $cls = 'HKCU:\Software\Classes\ghrdp'
        New-Item -Path $cls -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path $cls -Name '(default)' -Value 'URL:GHRDP Protocol' -Force
        Set-ItemProperty -Path $cls -Name 'URL Protocol' -Value '' -Force
        $cmdKey = $cls + '\shell\open\command'
        New-Item -Path $cmdKey -Force -ErrorAction SilentlyContinue | Out-Null
        $cmd = '"' + $script:SysPwsh + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script:AgentPath + '" -Dispatch "%1"'
        Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $cmd -Force
        Log ('register-protocol OK cmd=' + $cmd)
    } catch { Log ('register-protocol FAIL ' + $_.Exception.Message) 'ERR' }
}

# ---- Persistence ladder (F2/RC1 fix: E2 0x80070005 in non-elevated context) ----
# Try scheduled task first; on ANY failure fall back to Startup .lnk + HKCU Run key.
# Both fallbacks are user-scope only, no admin required.
$script:PersistMech = 'none'

function Get-StartupLnkPath {
    $startup = [Environment]::GetFolderPath('Startup')
    if (-not $startup) { $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
    return (Join-Path $startup 'GhrdpAgent.lnk')
}

function Register-StartupLnk {
    try {
        $lnk = Get-StartupLnkPath
        $sh = New-Object -ComObject WScript.Shell
        $s = $sh.CreateShortcut($lnk)
        $s.TargetPath = $script:SysPwsh
        $s.Arguments  = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script:AgentPath + '" -Loop'
        $s.WorkingDirectory = $script:AgentDir
        $s.WindowStyle = 7  # Minimized
        $s.Description = 'GHRDP Agent (auto-start)'
        $s.Save()
        if (Test-Path -LiteralPath $lnk) { Log ('persist: startup .lnk written ' + $lnk); return $true }
    } catch { Log ('persist: startup .lnk fail ' + $_.Exception.Message) 'WARN' }
    return $false
}

function Register-RunKey {
    try {
        $rk = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        if (-not (Test-Path $rk)) { New-Item -Path $rk -Force -ErrorAction SilentlyContinue | Out-Null }
        $cmd = '"' + $script:SysPwsh + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script:AgentPath + '" -Loop'
        Set-ItemProperty -Path $rk -Name 'GhrdpAgent' -Value $cmd -Force
        $v = (Get-ItemProperty -Path $rk -Name 'GhrdpAgent' -ErrorAction SilentlyContinue).GhrdpAgent
        if ($v -eq $cmd) { Log 'persist: HKCU Run key written'; return $true }
    } catch { Log ('persist: HKCU Run key fail ' + $_.Exception.Message) 'WARN' }
    return $false
}

function Get-PersistOk {
    $viaTask = $false
    try { $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop; if ($t) { $viaTask = $true } } catch {}
    $viaStartup = $false
    try { $viaStartup = Test-Path -LiteralPath (Get-StartupLnkPath) } catch {}
    $viaRun = $false
    try { $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'GhrdpAgent' -ErrorAction Stop).GhrdpAgent; if ($v) { $viaRun = $true } } catch {}
    $mech = @()
    if ($viaTask) { $mech += 'task' }
    if ($viaStartup) { $mech += 'startup' }
    if ($viaRun) { $mech += 'run' }
    if ($mech.Count -eq 0) { return @{ ok = $false; mech = 'none' } }
    return @{ ok = $true; mech = ($mech -join '+') }
}

function Register-Persistence {
    Log 'register-persistence: attempting task -> startup -> HKCU Run ladder'
    $taskOk = $false
    try {
        try { Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
        $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script:AgentPath + '" -Loop'
        $act = New-ScheduledTaskAction -Execute $script:SysPwsh -Argument $arg
        $trigA = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\' + $env:USERNAME)
        $trigB = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(3))
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        $prin = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $script:TaskName -Action $act -Trigger @($trigA,$trigB) -Settings $set -Principal $prin -Force -ErrorAction Stop | Out-Null
        $taskOk = $true
        Log 'persist: scheduled task registered'
        try { Start-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop; Log 'persist: task started' } catch { Log ('persist: task start warn ' + $_.Exception.Message) 'WARN' }
    } catch {
        Log ('persist: task registration FAILED (' + $_.Exception.Message + ') -- falling back to Startup+Run') 'WARN'
    }
    # ALWAYS layer Startup .lnk + HKCU Run alongside (belt+suspenders). If task exists it wins at logon; the
    # others cover the case where the task is denied or later unregistered.
    $startupOk = Register-StartupLnk
    $runOk = Register-RunKey
    $status = Get-PersistOk
    $script:PersistMech = $status.mech
    if (-not $status.ok) { Log 'persist: ALL MECHANISMS FAILED' 'ERR'; return }
    Log ('persist: active mechanisms=' + $status.mech)
}

# Ensure-Loop-Running: spawn a hidden detached -Loop if none is present in the current session.
# Used from Do-Dispatch (protocol click) and after enroll (immediate liveness).
function Ensure-Loop-Running {
    $running = 0
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                   Where-Object { $_.CommandLine -match [regex]::Escape('agent.ps1') -and $_.CommandLine -match '(?i)(^|\s)-Loop(\s|$)' })
        $running = $procs.Count
    } catch {}
    if ($running -ge 1) { Log ('loop-check: already running (' + $running + ')'); return $true }
    Log 'loop-check: no -Loop process found, starting detached'
    try {
        Start-Process -FilePath $script:SysPwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $script:AgentPath + '"'),'-Loop') -WindowStyle Hidden | Out-Null
        return $true
    } catch { Log ('loop-check: spawn fail ' + $_.Exception.Message) 'ERR'; return $false }
}

# Idempotent RDP client registry sweep (F5). All keys are HKCU (no admin).
function Sweep-RdpRegistry {
    Log 'rdp-sweep: applying HKCU Terminal Server Client zero-prompt defaults'
    try {
        $tsc = 'HKCU:\Software\Microsoft\Terminal Server Client'
        if (-not (Test-Path $tsc)) { New-Item -Path $tsc -Force -ErrorAction SilentlyContinue | Out-Null }
        Set-ItemProperty -Path $tsc -Name 'AuthenticationLevelOverride' -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
        Set-ItemProperty -Path $tsc -Name 'DisablePasswordSaving'       -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
        Set-ItemProperty -Path $tsc -Name 'PublisherBypassList'         -Value '*' -Force -ErrorAction SilentlyContinue
        $ld = $tsc + '\LocalDevices'
        if (-not (Test-Path $ld)) { New-Item -Path $ld -Force -ErrorAction SilentlyContinue | Out-Null }
        # Wildcard trust: local devices + clipboard + drives + printers + audio
        # 0x01 local | 0x20 clipboard | 0x04 drives | 0x08 printers | 0x40 audio = 0x6D; keep 0xC5 for compat
        Set-ItemProperty -Path $ld -Name '*' -Value 0xC5 -Type DWord -Force -ErrorAction SilentlyContinue
        Log 'rdp-sweep: OK (AuthLvlOverride=0, LocalDevices\*=0xC5)'
    } catch { Log ('rdp-sweep FAIL ' + $_.Exception.Message) 'WARN' }
}

function Post-Status($runner, $dev, [string]$stage, [hashtable]$extra) {
    if (-not $runner -or -not $dev -or -not $dev.deviceToken) { return }
    $persistNow = Get-PersistOk
    $body = [ordered]@{
        deviceId  = $dev.deviceId
        dt        = $dev.deviceToken
        stage     = $stage
        build     = $script:Build
        agentHash = (Get-AgentHash)
        regPath   = (Get-RegPath)
        taskOk    = (Get-TaskOk)
        persist   = $persistNow.mech
        mstscPid  = 0
        logonAge  = -1
        err       = ''
        received  = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($extra) { foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] } }
    if ($body.err) { $body.enrollLogTail = (Get-EnrollTail 40) }
    Http-Post ('http://' + $runner + ':7331/api/agent-status') $body 6 | Out-Null
}

function Write-Rdp([string]$hostAddr, [string]$user, [hashtable]$opts, [int]$authLvl, [int]$credssp) {
    $file = Join-Path $script:AgentDir ('ghrdp-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.rdp')
    $mic = [bool]$opts.mic
    $audiomode = 2
    if ($mic) { $audiomode = 0 }
    $lines = @(
        'screen mode id:i:2',
        'use multimon:i:0',
        'session bpp:i:32',
        'connection type:i:7',
        'gatewayusagemethod:i:0',
        ('full address:s:' + $hostAddr),
        ('username:s:' + $user),
        ('authentication level:i:' + $authLvl),
        ('enablecredsspsupport:i:' + $credssp),
        'prompt for credentials:i:0',
        'prompt for credentials on client:i:0',
        'enable password share:i:1',
        'negotiate security layer:i:1',
        'autoreconnection enabled:i:1',
        'bitmapcachepersistenable:i:1',
        ('redirectclipboard:i:' + [int][bool]$opts.clip),
        ('redirectprinters:i:'  + [int][bool]$opts.print),
        ('redirectdrives:i:'    + [int][bool]$opts.drives),
        ('audiomode:i:'         + $audiomode),
        ('audiocapturemode:i:'  + [int]$mic),
        'redirectcomports:i:0',
        'redirectsmartcards:i:1',
        'redirectposdevices:i:0'
    )
    [System.IO.File]::WriteAllText($file, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    try { Unblock-File -LiteralPath $file -ErrorAction SilentlyContinue } catch {}
    try {
        $zi = $file + ':Zone.Identifier'
        if (Test-Path -LiteralPath $zi) { Remove-Item -LiteralPath $zi -Force -ErrorAction SilentlyContinue }
    } catch {}
    return $file
}

function Ladder-Connect($runner, $dev, $cmd) {
    $hostAddr = [string]$cmd.host
    $user     = [string]$cmd.user
    $pass     = [string]$cmd.pass
    $opts     = @{ clip = [bool]$cmd.clip; print = [bool]$cmd.print; drives = [bool]$cmd.drives; mic = [bool]$cmd.mic }
    $cmdId    = [string]$cmd.cmdId
    if (-not $hostAddr -or -not $user -or -not $pass) { Post-Status $runner $dev 'failed' @{ cmdId=$cmdId; err='missing creds' }; return }
    Log ('connect: host=' + $hostAddr + ' user=' + $user + ' clip=' + $opts.clip + ' print=' + $opts.print + ' drives=' + $opts.drives + ' mic=' + $opts.mic + ' cmdId=' + $cmdId)

    # cmdkey - hidden, wait for it to persist
    & cmdkey ('/generic:TERMSRV/' + $hostAddr) ('/user:' + $user) ('/pass:' + $pass) 2>$null | Out-Null
    Start-Sleep -Milliseconds 200
    Post-Status $runner $dev 'cmdkey-armed' @{ cmdId=$cmdId }

    # Stop any stale mstsc so we don't stack sessions (A3)
    Stop-StaleMstsc
    $baseline = Get-Date

    $needRdp = ($opts.print -or $opts.drives -or $opts.mic)
    Post-Status $runner $dev 'L1-launching' @{ cmdId=$cmdId }
    if (-not $needRdp) {
        $p = Start-Process -FilePath 'mstsc.exe' -ArgumentList @('/v:' + $hostAddr, '/f') -WindowStyle Hidden -PassThru
    } else {
        $rdp = Write-Rdp $hostAddr $user $opts 2 1
        $p = Start-Process -FilePath 'mstsc.exe' -ArgumentList @($rdp, '/f') -WindowStyle Hidden -PassThru
    }
    Post-Status $runner $dev 'mstsc-alive' @{ cmdId=$cmdId; mstscPid = if ($p) { $p.Id } else { 0 } }
    $r = Wait-Connected $p $baseline 8
    if ($r.ok) { Post-Status $runner $dev 'connected' @{ cmdId=$cmdId; mstscPid=$p.Id; logonAge=$r.age; err=('via=' + $r.via) }; Log ('L1 connected via=' + $r.via + ' age=' + $r.age); return }
    Log ('L1 no connect (via=' + $r.via + '), escalating')

    Stop-StaleMstsc
    $baseline = Get-Date
    Post-Status $runner $dev 'L2-launching' @{ cmdId=$cmdId }
    $rdp2 = Write-Rdp $hostAddr $user $opts 2 1
    $p2 = Start-Process -FilePath 'mstsc.exe' -ArgumentList @($rdp2, '/f') -WindowStyle Hidden -PassThru
    $r2 = Wait-Connected $p2 $baseline 10
    if ($r2.ok) { Post-Status $runner $dev 'connected' @{ cmdId=$cmdId; mstscPid=$p2.Id; logonAge=$r2.age; err=('via=' + $r2.via) }; return }

    Stop-StaleMstsc
    $baseline = Get-Date
    Post-Status $runner $dev 'L3-launching' @{ cmdId=$cmdId }
    try {
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Terminal Server Client' -Name 'PublisherBypassList' -Value '*' -Force -ErrorAction SilentlyContinue
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Terminal Server Client' -Name 'AuthenticationLevelOverride' -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
    } catch {}
    $rdp3 = Write-Rdp $hostAddr $user $opts 0 0
    $p3 = Start-Process -FilePath 'mstsc.exe' -ArgumentList @($rdp3, '/f') -WindowStyle Hidden -PassThru
    $r3 = Wait-Connected $p3 $baseline 10
    if ($r3.ok) { Post-Status $runner $dev 'connected' @{ cmdId=$cmdId; mstscPid=$p3.Id; logonAge=$r3.age; err=('via=' + $r3.via) }; return }

    Post-Status $runner $dev 'failed' @{ cmdId=$cmdId; err='ladder-exhausted' }
    Upload-Diag $runner $dev 'ladder-exhausted'
}

function Upload-Diag($runner, $dev, [string]$reason) {
    Log ('diag-upload: reason=' + $reason) 'ERR'
    if (-not $runner -or -not $dev -or -not $dev.deviceToken) { return }
    $bundle = @{
        enrollLogTail = (Get-EnrollTail 100)
        agentLogTail  = ''
        regQuery      = (Get-RegPath)
        taskOk        = (Get-TaskOk)
        cmdkeyCount   = 0
        wevtutil      = ''
    }
    try { if (Test-Path $script:LogPath) { $bundle.agentLogTail = ((Get-Content -LiteralPath $script:LogPath -Tail 100) -join "`n") } } catch {}
    try { $bundle.cmdkeyCount = (& cmdkey /list 2>$null | Select-String 'TERMSRV' | Measure-Object).Count } catch {}
    try { $bundle.wevtutil = ((& wevtutil.exe qe Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational /c:5 /rd:true /f:text 2>$null) -join "`n") } catch {}
    Http-Post ('http://' + $runner + ':7331/api/diag-upload') @{ deviceId=$dev.deviceId; dt=$dev.deviceToken; reason=$reason; bundle=$bundle } 8 | Out-Null
}

# ---- Self-Heal: gated remote refresh (never install unparseable) ---------
function Self-Heal($runner, $dev) {
    Log 'self-heal: check'
    $ps = Get-PersistOk
    if (-not $ps.ok) { Log 'self-heal: no persistence mechanism active, re-register ladder'; Register-Persistence }
    $reg = Get-RegPath
    $needReg = $false
    if (-not $reg) { $needReg = $true }
    elseif ($reg -notmatch [regex]::Escape($script:AgentPath)) { $needReg = $true }
    elseif ($reg -notmatch 'System32\\WindowsPowerShell') { $needReg = $true }
    if ($needReg) { Log 'self-heal: reg drifted, re-register'; Register-Protocol }
    if ($runner) {
        $h = Http-Get ('http://' + $runner + ':7331/api/agent-hash') 4
        if ($h -and $h.sha256) {
            $local = Get-AgentHash
            if ($local -and ($local -ne $h.sha256.ToLower())) {
                Log ('self-heal: hash drift local=' + $local + ' remote=' + $h.sha256)
                $tmpPath = $script:AgentPath + '.new'
                try {
                    Invoke-WebRequest -Uri ('http://' + $runner + ':7331/api/agent.ps1') -OutFile $tmpPath -UseBasicParsing -TimeoutSec 15
                    # Gate #57: PSParser tokenize before overwrite
                    if (Test-PsSyntax $tmpPath) {
                        $newHash = (Get-FileHash -LiteralPath $tmpPath -Algorithm SHA256).Hash.ToLower()
                        if ($newHash -eq $h.sha256.ToLower()) {
                            Copy-Item $tmpPath $script:AgentPath -Force
                            Log ('self-heal: agent.ps1 refreshed to ' + $newHash)
                        } else { Log ('self-heal: refreshed bytes hash mismatch - abort') 'ERR' }
                    } else { Log 'self-heal: REMOTE UNPARSEABLE - keeping local (bug #58)' 'ERR' }
                    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
                } catch { Log ('self-heal refresh fail ' + $_.Exception.Message) 'ERR' }
            }
        }
    }
    Cleanup-StaleRdp
}

function Consume-Pending($runner, $dev) {
    if (-not (Test-Path $script:PendingPath)) { return }
    try {
        $p = Get-Content -LiteralPath $script:PendingPath -Raw | ConvertFrom-Json
        Remove-Item -LiteralPath $script:PendingPath -Force -ErrorAction SilentlyContinue
        Log ('pending consumed action=' + $p.action)
        if ($p.action -eq 'rdp') { Ladder-Connect $runner $dev $p }
    } catch { Log ('pending parse fail ' + $_.Exception.Message) 'ERR' }
}

function Do-Enroll {
    Log ('== ENROLL BEGIN Server=' + $Server + ' ==')
    $dev = Load-Device
    $runner = Discover-Runner $dev
    if (-not $runner) { Log 'ENROLL FATAL: no runner discovered' 'ERR'; exit 0 }
    Log ('enroll: runner=' + $runner)

    # Gated agent.ps1 refresh (bug #58: never overwrite local with unparseable remote)
    Log 'enroll: refreshing agent.ps1 (gated)'
    try {
        $tmpPath = $script:AgentPath + '.new'
        Invoke-WebRequest -Uri ('http://' + $runner + ':7331/api/agent.ps1') -OutFile $tmpPath -UseBasicParsing -TimeoutSec 15
        if (Test-PsSyntax $tmpPath) {
            try { Unblock-File -LiteralPath $tmpPath -ErrorAction SilentlyContinue } catch {}
            Copy-Item $tmpPath $script:AgentPath -Force
            Log ('enroll: agent.ps1 refreshed (' + (Get-Item $script:AgentPath).Length + ' bytes)')
        } else { Log 'enroll: remote agent UNPARSEABLE - keeping local' 'ERR' }
        Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    } catch { Log ('enroll: refresh fail (continuing) ' + $_.Exception.Message) 'WARN' }

    # Stable dev-key from MachineGuid + username
    $mg = ''
    try { $mg = [string](Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { $mg = [guid]::NewGuid().ToString() }
    $devKey = $mg + '-' + $env:USERNAME
    if (-not $dev) {
        $dev = [pscustomobject]@{
            deviceId     = ''
            deviceToken  = ''
            runnersCache = @($runner)
            lastRunner   = $runner
            pagesUrl     = ''
            enrolledAt   = ''
        }
    }
    $body = @{ dev = $devKey; name = $env:COMPUTERNAME; os = ([Environment]::OSVersion.Version.ToString()); deviceIdHint = $dev.deviceId }
    Log ('enroll: POST /api/device-enroll dev=' + $devKey)
    $resp = Http-Post ('http://' + $runner + ':7331/api/device-enroll') $body 10
    if (-not $resp -or -not $resp.deviceToken) { Log 'ENROLL FATAL: no deviceToken in response' 'ERR'; exit 0 }

    $dev.deviceId    = [string]$resp.deviceId
    $dev.deviceToken = [string]$resp.deviceToken
    if (-not $dev.deviceId) { $dev.deviceId = [guid]::NewGuid().ToString('N') }
    if ($resp.pagesStatusUrl) { $dev.pagesUrl = Normalize-Url $resp.pagesStatusUrl }
    $dev = Update-Cache $dev $runner
    $dev.enrolledAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Device $dev
    Log ('enroll: deviceId=' + $dev.deviceId + ' tokenLen=' + $dev.deviceToken.Length + ' pagesUrl=' + $dev.pagesUrl)

    Register-Protocol
    Register-Persistence
    Sweep-RdpRegistry

    $persist = Get-PersistOk
    Log 'enroll: POST /api/agent-hello'
    Http-Post ('http://' + $runner + ':7331/api/agent-hello') @{ deviceId=$dev.deviceId; dt=$dev.deviceToken; build=$script:Build; regPath=(Get-RegPath); taskOk=(Get-TaskOk); persist=$persist.mech } 6 | Out-Null

    # F3: guarantee loop is running (task may be denied on this account; belt+suspenders)
    Ensure-Loop-Running

    $script:Http401Count = 0

    # F4: enroll self-verify - poll probe up to 20s and confirm heartbeat visibility
    Log 'enroll: self-verify (poll /api/agent-status?probe=1 for seen=true up to 20s)'
    $verifyOk = $false
    $verifyDetail = ''
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 20) {
        try {
            $pr = Invoke-RestMethod -Uri ('http://' + $runner + ':7331/api/agent-status?device=' + [uri]::EscapeDataString($dev.deviceId) + '&probe=1') -TimeoutSec 3 -UseBasicParsing
            if ($pr -and $pr.seen -eq $true) {
                $verifyOk = $true
                $verifyDetail = 'stage=' + $pr.stage + ' ageSeconds=' + $pr.ageSeconds + ' build=' + $pr.build
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    $loopN = 0
    try { $loopN = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match [regex]::Escape('agent.ps1') -and $_.CommandLine -match '(?i)(^|\s)-Loop(\s|$)' }).Count } catch {}
    if ($verifyOk) {
        Log ('ENROLL-VERIFY PASS deviceId=' + $dev.deviceId + ' loop=' + $loopN + ' persist=' + $persist.mech + ' ' + $verifyDetail)
        Write-Host ('ENROLL-VERIFY PASS deviceId=' + $dev.deviceId)
        Write-Host ('  loopProcs=' + $loopN + ' persist=' + $persist.mech + ' ' + $verifyDetail)
    } else {
        Log ('ENROLL-VERIFY FAIL loop=' + $loopN + ' persist=' + $persist.mech) 'ERR'
        Write-Host 'ENROLL-VERIFY FAIL' -ForegroundColor Red
        Write-Host ('  loopProcs=' + $loopN + ' persist=' + $persist.mech)
        Write-Host '  device.json:'
        if (Test-Path $script:DeviceJson) { Get-Content $script:DeviceJson | Write-Host } else { Write-Host '  (missing)' }
        Write-Host '  enroll.log tail 20:'
        Get-Content $script:EnrollLog -Tail 20 | Write-Host
        Write-Host '  agent.log tail 20:'
        if (Test-Path $script:LogPath) { Get-Content $script:LogPath -Tail 20 | Write-Host } else { Write-Host '  (no agent.log yet)' }
        Write-Host '  next: verify persistence via `Get-ScheduledTask GhrdpAgent`, Startup folder, HKCU Run key'
        exit 1
    }

    Log ('ENROLL-OK deviceId=' + $dev.deviceId + ' persist=' + $persist.mech)
    exit 0
}

function Poll-Loop {
    Log ('== LOOP BEGIN build=' + $script:Build + ' ==')
    # F2: single-instance mutex - second concurrent loop exits immediately.
    # Uses Global\ so it is machine-wide (task + startup + Run key + detached spawn all contend for one slot).
    $loopMutex = $null
    $loopOwned = $false
    try {
        $created = $false
        $loopMutex = New-Object System.Threading.Mutex($true, 'Global\GhrdpAgentLoopSingle', [ref]$created)
        if ($created) {
            $loopOwned = $true
        } else {
            try { $loopOwned = $loopMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $loopOwned = $true }
        }
    } catch { Log ('LOOP: mutex create/acquire fail ' + $_.Exception.Message) 'ERR'; return }
    if (-not $loopOwned) { Log 'LOOP: another loop instance holds Global\GhrdpAgentLoopSingle - exiting cleanly (F2 single-instance)'; return }
    Log 'LOOP: acquired Global\GhrdpAgentLoopSingle mutex'

    # F3: retry Load-Device 10 x 2s on transient failure. Never die on first hit.
    $dev = $null
    for ($i = 1; $i -le 10; $i++) {
        $dev = Read-DeviceJson
        if ($dev -and $dev.deviceToken) { break }
        Log ('LOOP: Read-DeviceJson attempt ' + $i + '/10 empty or locked, waiting 2s')
        Start-Sleep -Seconds 2
    }
    if (-not $dev -or -not $dev.deviceToken) {
        Log 'LOOP: 10 device.json retries exhausted - need re-enrollment' 'ERR'
        if ($loopOwned) { try { $loopMutex.ReleaseMutex() } catch {} }
        if ($loopMutex) { $loopMutex.Dispose() }
        return
    }

    $tickHb = [DateTime]::UtcNow.AddSeconds(-100)
    $tickHeal = [DateTime]::UtcNow.AddSeconds(-100)
    $tickReload = [DateTime]::UtcNow

    while ($true) {
        try {
            # Every 60s, re-read device.json so re-enrollments (F4 rotates deviceToken) are picked up
            # by the running loop instead of remaining pinned to a stale token (fixes REVIEW.md N6).
            if (([DateTime]::UtcNow - $tickReload).TotalSeconds -ge 60) {
                $fresh = Read-DeviceJson
                if ($fresh -and $fresh.deviceToken -and $fresh.deviceId -eq $dev.deviceId -and $fresh.deviceToken -ne $dev.deviceToken) {
                    Log 'LOOP: device.json rotated (fresh token detected), reloading'
                    $dev = $fresh
                }
                $tickReload = [DateTime]::UtcNow
            }
            $runner = Discover-Runner $dev
            if (-not $runner) { Start-Sleep -Seconds 5; continue }
            $dev = Update-Cache $dev $runner

            if (([DateTime]::UtcNow - $tickHeal).TotalSeconds -ge 300) {
                Self-Heal $runner $dev
                $tickHeal = [DateTime]::UtcNow
            }

            Consume-Pending $runner $dev

            $cmd = Http-Get ('http://' + $runner + ':7331/api/client-cmd?device=' + [uri]::EscapeDataString($dev.deviceId) + '&dt=' + [uri]::EscapeDataString($dev.deviceToken)) 5
            if ($cmd -and $cmd.action -eq 'rdp' -and $cmd.host) {
                $script:Http401Count = 0
                Ladder-Connect $runner $dev $cmd
            }

            # Sustained-401 auto re-enroll (>=3, rate limited to <=1/300s)
            if ($script:Http401Count -ge 3 -and (([DateTime]::UtcNow - $script:LastReEnroll).TotalSeconds -ge 300)) {
                Log ('sustained 401 detected (count=' + $script:Http401Count + '), auto re-enroll') 'WARN'
                $script:LastReEnroll = [DateTime]::UtcNow
                $script:Http401Count = 0
                try {
                    Start-Process -FilePath $script:SysPwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $script:AgentPath + '"'),'-Enroll','-Server',$runner) -WindowStyle Hidden | Out-Null
                } catch { Log ('auto-reenroll spawn fail ' + $_.Exception.Message) 'ERR' }
            }

            if (([DateTime]::UtcNow - $tickHb).TotalSeconds -ge 30) {
                $mp = 0
                try { $mp = (@(Get-Process mstsc -ErrorAction SilentlyContinue))[0].Id } catch {}
                Post-Status $runner $dev 'heartbeat' @{ mstscPid = $mp }
                Cleanup-StaleRdp
                $tickHb = [DateTime]::UtcNow
            }
            Start-Sleep -Seconds 2
        } catch {
            Log ('LOOP iteration exception ' + $_.Exception.Message) 'ERR'
            Start-Sleep -Seconds 3
        }
    }
}

function Do-Dispatch([string]$url) {
    Log ('== DISPATCH url=' + $url + ' ==')
    try {
        $raw = $url -replace '^ghrdp:(//)?', '' -replace '^connect\??', '' -replace '^/', ''
        $p = @{}
        foreach ($kv in ($raw -split '&')) {
            $eq = $kv.IndexOf('=')
            if ($eq -gt 0) {
                $k = [uri]::UnescapeDataString($kv.Substring(0, $eq)).ToLower()
                $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
                $p[$k] = $v
            }
        }
        if ($url -match '^ghrdp://enroll') {
            $script:Server = $p['server']
            Do-Enroll
            return
        }
        if ($p.host -or $p.server) {
            $obj = @{ action='rdp'; host=$p['host']; server=$p['server']; clip=($p['clip'] -eq '1'); print=($p['print'] -eq '1'); drives=($p['drives'] -eq '1'); mic=($p['mic'] -eq '1') }
            $obj | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:PendingPath -Encoding UTF8 -Force
            Log 'dispatch: wrote pending.json'
            # F3: guarantee a loop is up to consume pending.json (task may be missing/denied)
            Ensure-Loop-Running
        }
    } catch { Log ('dispatch fail ' + $_.Exception.Message) 'ERR' }
}

# ---- Entrypoint dispatch --------------------------------------------------
try {
    if ($Enroll)                 { Do-Enroll; exit 0 }
    if ($Dispatch)               { Do-Dispatch $Dispatch; exit 0 }
    if ($SelfHealOnly)           { $d = Load-Device; if ($d) { $r = Discover-Runner $d; Self-Heal $r $d }; exit 0 }
    if ($Loop -or $Poll)         { Poll-Loop; exit 0 }
    Log ('no mode flag provided - nothing to do') 'WARN'
    exit 0
} catch {
    Log ('TOP-LEVEL EXCEPTION ' + $_.Exception.Message) 'ERR'
    exit 0
}
