# ghrdp-agent.ps1 v2 — persistent pull-model RDP agent.
# Modes: -Enroll -Server <ip> | -Loop | -Poll (alias -Loop) | -Dispatch <url> | -SelfHealOnly
# CRITICAL: param() must be the FIRST executable statement — PowerShell ignores it otherwise.
[CmdletBinding()]
param(
    [switch]$Enroll,
    [string]$Server = '',
    [switch]$Loop,
    [switch]$Poll,
    [string]$Dispatch = '',
    [switch]$SelfHealOnly,
    [string]$PagesUrl = ''
)

# Transcript-before-action: FIRST executable code after param() creates log dir + records invocation.
# This is the transcript-before-action guarantee: no code path can die silently.
$script:AgentDir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
if (-not (Test-Path $script:AgentDir)) { try { New-Item -ItemType Directory -Path $script:AgentDir -Force | Out-Null } catch {} }
$script:EnrollLog = Join-Path $script:AgentDir 'enroll.log'
try {
    $argStr = @()
    if ($Enroll) { $argStr += '-Enroll' }
    if ($Server) { $argStr += "-Server=$Server" }
    if ($Loop)   { $argStr += '-Loop' }
    if ($Poll)   { $argStr += '-Poll' }
    if ($Dispatch) { $argStr += "-Dispatch=$Dispatch" }
    if ($SelfHealOnly) { $argStr += '-SelfHealOnly' }
    if ($PagesUrl) { $argStr += "-PagesUrl=$PagesUrl" }
    if ($args) { $argStr += ('extra:' + ($args -join ' ')) }
    Add-Content -LiteralPath $script:EnrollLog -Value ("{0} START v2 pid={1} argv=[{2}]" -f (Get-Date -Format o), $PID, ($argStr -join ' ')) -ErrorAction SilentlyContinue
} catch {}

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$script:Build          = 20260918002
$script:AgentPath      = Join-Path $script:AgentDir 'agent.ps1'
$script:PendingPath    = Join-Path $script:AgentDir 'pending.json'
$script:DeviceJson     = Join-Path $script:AgentDir 'device.json'
$script:LogPath        = Join-Path $script:AgentDir 'agent.log'
$script:LogBak         = "$script:LogPath.1"
$script:TaskName       = 'GhrdpAgent'
$script:ProtoName      = 'ghrdp'
$script:SysPwsh        = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Log([string]$m,[string]$lvl='INFO',[string]$tgt='both'){
    $ln = "{0} [{1}] {2}" -f (Get-Date -Format o), $lvl, $m
    try {
        if ($tgt -eq 'both' -or $tgt -eq 'enroll') { Add-Content -LiteralPath $script:EnrollLog -Value $ln -ErrorAction SilentlyContinue }
        if ($tgt -eq 'both' -or $tgt -eq 'agent') {
            if ((Test-Path $script:LogPath) -and (Get-Item $script:LogPath).Length -gt 200KB) {
                try { Copy-Item $script:LogPath $script:LogBak -Force -ErrorAction SilentlyContinue } catch {}
                try { Clear-Content $script:LogPath -Force -ErrorAction SilentlyContinue } catch {}
            }
            Add-Content -LiteralPath $script:LogPath -Value $ln -ErrorAction SilentlyContinue
        }
    } catch {}
}

# HTTP helpers with 3 retries + full transcript logging
function Http-Get([string]$url,[int]$timeoutSec=6){
    for ($i=1; $i -le 3; $i++) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            Log "GET $url attempt=$i timeout=$timeoutSec" 'HTTP' 'agent'
            $r = Invoke-RestMethod -Uri $url -Method Get -UseBasicParsing -TimeoutSec $timeoutSec
            $sw.Stop()
            Log "GET-OK $url ms=$($sw.ElapsedMilliseconds)" 'HTTP' 'agent'
            return $r
        } catch {
            $sw.Stop()
            Log "GET-FAIL $url attempt=$i ms=$($sw.ElapsedMilliseconds) err=$($_.Exception.Message)" 'HTTP' 'agent'
            if ($i -lt 3) { Start-Sleep -Milliseconds (400 * $i) }
        }
    }
    return $null
}
function Http-Post([string]$url,$body,[int]$timeoutSec=8){
    $json = $null
    try { $json = ($body | ConvertTo-Json -Depth 8 -Compress) } catch { Log "POST body serialize fail $url $_" 'ERR' 'agent'; return $null }
    for ($i=1; $i -le 3; $i++) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            $snip = if ($json.Length -gt 220) { $json.Substring(0,220) + '...' } else { $json }
            Log "POST $url attempt=$i body=$snip" 'HTTP' 'agent'
            $r = Invoke-RestMethod -Uri $url -Method Post -Body $json -ContentType 'application/json' -UseBasicParsing -TimeoutSec $timeoutSec
            $sw.Stop()
            Log "POST-OK $url ms=$($sw.ElapsedMilliseconds)" 'HTTP' 'agent'
            return $r
        } catch {
            $sw.Stop()
            Log "POST-FAIL $url attempt=$i ms=$($sw.ElapsedMilliseconds) err=$($_.Exception.Message)" 'HTTP' 'agent'
            if ($i -lt 3) { Start-Sleep -Milliseconds (400 * $i) }
        }
    }
    return $null
}

function Normalize-Url([string]$u){
    if (-not $u) { return '' }
    # Collapse double slashes except after scheme (http:// | https://)
    return ($u -replace '(?<!:)/{2,}', '/')
}

function Load-Device {
    if (-not (Test-Path $script:DeviceJson)) { return $null }
    try { return (Get-Content -LiteralPath $script:DeviceJson -Raw | ConvertFrom-Json) } catch { return $null }
}
function Save-Device($obj) {
    try { ($obj | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $script:DeviceJson -Encoding UTF8 -Force } catch { Log "save-device fail $_" 'ERR' }
}

function Ping-Runner([string]$ip){
    if ([string]::IsNullOrWhiteSpace($ip)) { return $null }
    $r = Http-Get ("http://{0}:7331/api/ping" -f $ip) 3
    if ($r -and $r.epoch) { return $r }
    return $null
}

function Scan-Tailscale {
    $ts = 'C:\Program Files\Tailscale\tailscale.exe'
    if (-not (Test-Path $ts)) { Log "tailscale: exe missing" 'DBG'; return @() }
    Log "tailscale: enumerating peers" 'DBG'
    try {
        $j = (& $ts status --json 2>$null | ConvertFrom-Json)
        $ips = @()
        if ($j.Peer) {
            foreach ($p in $j.Peer.PSObject.Properties) {
                if ($p.Value.Online) { $ips += @($p.Value.TailscaleIPs)[0] }
            }
        }
        Log ("tailscale peers online=" + $ips.Count) 'DBG'
        return $ips
    } catch {
        Log "tailscale scan fail $_" 'WARN'
        return @()
    }
}

function Discover-Runner($dev){
    # Order: $Server (arg) → lastRunner → tailscale peers (PRIMARY) → Pages (SECONDARY single-slash) → runnersCache
    if ($Server) {
        Log "discover: try -Server=$Server"
        $p = Ping-Runner $Server
        if ($p) { Log "discover: server-arg OK $Server"; return $Server }
    }
    if ($dev -and $dev.lastRunner) {
        Log "discover: try lastRunner=$($dev.lastRunner)"
        $p = Ping-Runner $dev.lastRunner
        if ($p) { Log "discover: lastRunner OK"; return $dev.lastRunner }
    }
    foreach ($ip in (Scan-Tailscale)) {
        $p = Ping-Runner $ip
        if ($p) { Log "discover: tailscale peer OK $ip"; return $ip }
    }
    if ($dev -and $dev.pagesUrl) {
        $u = Normalize-Url $dev.pagesUrl
        Log "discover: try pages url=$u"
        $s = Http-Get $u 6
        if ($s -and $s.runnerIp) {
            $p = Ping-Runner $s.runnerIp
            if ($p) { Log "discover: pages runnerIp OK $($s.runnerIp)"; return $s.runnerIp }
        }
    }
    if ($dev -and $dev.runnersCache) {
        foreach ($ip in @($dev.runnersCache)) {
            $p = Ping-Runner $ip
            if ($p) { Log "discover: cache OK $ip"; return $ip }
        }
    }
    Log "discover: NO RUNNER FOUND" 'ERR'
    return $null
}

function Update-Cache($dev,[string]$ip){
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

function Get-LogonAge {
    try {
        $ev = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4624} -MaxEvents 20 -ErrorAction SilentlyContinue |
              Where-Object { $_.Message -match 'Logon Type:\s+10' } | Select-Object -First 1
        if ($ev) { return [int]((Get-Date) - $ev.TimeCreated).TotalSeconds }
    } catch {}
    return -1
}

function Get-EnrollTail([int]$n=40){
    try {
        if (-not (Test-Path $script:EnrollLog)) { return '' }
        return ((Get-Content -LiteralPath $script:EnrollLog -Tail $n) -join "`n")
    } catch { return '' }
}

function Register-Protocol {
    Log "register-protocol: HKCU\Software\Classes\ghrdp -> $script:SysPwsh"
    try {
        $cls = 'HKCU:\Software\Classes\ghrdp'
        New-Item -Path $cls -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path $cls -Name '(default)' -Value 'URL:GHRDP Protocol' -Force
        Set-ItemProperty -Path $cls -Name 'URL Protocol' -Value '' -Force
        $cmdKey = "$cls\shell\open\command"
        New-Item -Path $cmdKey -Force -ErrorAction SilentlyContinue | Out-Null
        $cmd = "`"$script:SysPwsh`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script:AgentPath`" -Dispatch `"%1`""
        Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $cmd -Force
        Log "register-protocol: OK cmd=$cmd"
    } catch { Log "register-protocol FAIL $_" 'ERR' }
}

function Register-Task {
    Log "register-task: creating $script:TaskName (AtLogOn+AtStartup)"
    try {
        try { Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
        $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script:AgentPath`" -Loop"
        $act = New-ScheduledTaskAction -Execute $script:SysPwsh -Argument $arg
        $trigA = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $trigB = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(3))
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        $prin = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $script:TaskName -Action $act -Trigger @($trigA,$trigB) -Settings $set -Principal $prin -Force | Out-Null
        Log "register-task: registered"
        try { Start-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop; Log "register-task: started" } catch { Log "register-task start warn $_" 'WARN' }
    } catch { Log "register-task FAIL $_" 'ERR' }
}

function Post-Status($runner,$dev,$stage,[hashtable]$extra){
    if (-not $runner -or -not $dev -or -not $dev.deviceToken) { return }
    $body = [ordered]@{
        deviceId = $dev.deviceId
        dt       = $dev.deviceToken
        stage    = $stage
        build    = $script:Build
        agentHash= (Get-AgentHash)
        regPath  = (Get-RegPath)
        taskOk   = (Get-TaskOk)
        mstscPid = 0
        logonAge = (Get-LogonAge)
        err      = ''
        received = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($extra) { foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] } }
    if ($body.err) { $body.enrollLogTail = (Get-EnrollTail 40) }
    Http-Post ("http://{0}:7331/api/agent-status" -f $runner) $body 6 | Out-Null
}

function Write-Rdp([string]$hostAddr,[string]$user,[hashtable]$opts,[int]$authLvl,[int]$credssp){
    $file = Join-Path $script:AgentDir ("sess-{0}.rdp" -f ([guid]::NewGuid().ToString('N').Substring(0,8)))
    $lines = @(
        "screen mode id:i:2"
        "use multimon:i:0"
        "session bpp:i:32"
        "connection type:i:7"
        "gatewayusagemethod:i:0"
        ("full address:s:{0}" -f $hostAddr)
        ("username:s:{0}" -f $user)
        ("authentication level:i:{0}" -f $authLvl)
        ("enablecredsspsupport:i:{0}" -f $credssp)
        "prompt for credentials:i:0"
        "negotiate security layer:i:1"
        "autoreconnection enabled:i:1"
        "bitmapcachepersistenable:i:1"
        ("redirectclipboard:i:{0}" -f ([int]([bool]$opts.clip)))
        ("redirectprinters:i:{0}"  -f ([int]([bool]$opts.print)))
        ("redirectdrives:i:{0}"    -f ([int]([bool]$opts.drives)))
        ("audiomode:i:{0}"         -f (@{ $true=0; $false=2 }[[bool]$opts.mic]))
        ("audiocapturemode:i:{0}"  -f ([int]([bool]$opts.mic)))
        "redirectcomports:i:0"
        "redirectsmartcards:i:1"
        "redirectposdevices:i:0"
    )
    [System.IO.File]::WriteAllText($file, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    try { Unblock-File -LiteralPath $file -ErrorAction SilentlyContinue } catch {}
    return $file
}

function Ladder-Connect($runner,$dev,$cmd){
    $hostAddr = [string]$cmd.host
    $user     = [string]$cmd.user
    $pass     = [string]$cmd.pass
    $opts     = @{ clip = [bool]$cmd.clip; print = [bool]$cmd.print; drives = [bool]$cmd.drives; mic = [bool]$cmd.mic }
    if (-not $hostAddr -or -not $user -or -not $pass) { Post-Status $runner $dev 'failed' @{ err='missing creds' }; return }
    Log "connect: host=$hostAddr user=$user clip=$($opts.clip) print=$($opts.print) drives=$($opts.drives) mic=$($opts.mic)"

    & cmdkey /generic:("TERMSRV/{0}" -f $hostAddr) /user:$user /pass:$pass 2>$null | Out-Null
    Post-Status $runner $dev 'cmdkey-armed' @{ mstscPid=0 }

    $needRdp = ($opts.print -or $opts.drives -or $opts.mic)
    Post-Status $runner $dev 'L1-launching' @{}
    if (-not $needRdp) {
        $p = Start-Process -FilePath 'mstsc.exe' -ArgumentList ("/v:{0}" -f $hostAddr) -WindowStyle Hidden -PassThru
    } else {
        $rdp = Write-Rdp $hostAddr $user $opts 2 1
        $p = Start-Process -FilePath 'mstsc.exe' -ArgumentList ('"{0}"' -f $rdp) -WindowStyle Hidden -PassThru
    }
    Start-Sleep -Seconds 2
    if ($p -and -not $p.HasExited) {
        Post-Status $runner $dev 'mstsc-alive' @{ mstscPid=$p.Id }
        # Wait up to 8s for LogonType=10
        for ($i=0; $i -lt 8; $i++) {
            Start-Sleep -Seconds 1
            $age = Get-LogonAge
            if ($age -ge 0 -and $age -le 30) { Post-Status $runner $dev 'connected' @{ mstscPid=$p.Id; logonAge=$age }; Log "L1 connected age=$age"; return }
            if ($p.HasExited) { break }
        }
        Log "L1 no logon in 8s, escalating"
    }

    Post-Status $runner $dev 'L2-launching' @{}
    $rdp2 = Write-Rdp $hostAddr $user $opts 2 1
    $p2 = Start-Process -FilePath 'mstsc.exe' -ArgumentList ('"{0}"' -f $rdp2) -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 6
    if ($p2 -and -not $p2.HasExited) {
        $age = Get-LogonAge
        if ($age -ge 0 -and $age -le 30) { Post-Status $runner $dev 'connected' @{ mstscPid=$p2.Id; logonAge=$age }; return }
    }

    Post-Status $runner $dev 'L3-launching' @{}
    try {
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Terminal Server Client' -Name 'PublisherBypassList' -Value '*' -Force -ErrorAction SilentlyContinue
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Terminal Server Client' -Name 'AuthenticationLevelOverride' -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
    } catch {}
    $rdp3 = Write-Rdp $hostAddr $user $opts 0 0
    $p3 = Start-Process -FilePath 'mstsc.exe' -ArgumentList ('"{0}"' -f $rdp3) -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 6
    if ($p3 -and -not $p3.HasExited) {
        $age = Get-LogonAge
        if ($age -ge 0 -and $age -le 30) { Post-Status $runner $dev 'connected' @{ mstscPid=$p3.Id; logonAge=$age }; return }
    }

    Post-Status $runner $dev 'failed' @{ err='ladder-exhausted' }
    Upload-Diag $runner $dev 'ladder-exhausted'
}

function Upload-Diag($runner,$dev,[string]$reason){
    Log "diag-upload: reason=$reason" 'ERR'
    if (-not $runner -or -not $dev -or -not $dev.deviceToken) { return }
    $bundle = @{
        enrollLogTail = (Get-EnrollTail 100)
        agentLogTail  = ''
        regQuery      = (Get-RegPath)
        taskOk        = (Get-TaskOk)
        cmdkey        = ''
        wevtutil      = ''
    }
    try { if (Test-Path $script:LogPath) { $bundle.agentLogTail = ((Get-Content -LiteralPath $script:LogPath -Tail 100) -join "`n") } } catch {}
    try { $bundle.cmdkey = (& cmdkey /list 2>$null | Select-String 'TERMSRV' | Measure-Object).Count } catch {}
    try { $bundle.wevtutil = ((& wevtutil.exe qe Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational /c:5 /rd:true /f:text 2>$null) -join "`n") } catch {}
    Http-Post ("http://{0}:7331/api/diag-upload" -f $runner) @{ deviceId=$dev.deviceId; dt=$dev.deviceToken; reason=$reason; bundle=$bundle } 8 | Out-Null
}

function Self-Heal($runner,$dev){
    Log "self-heal: check"
    if (-not (Get-TaskOk)) { Log "self-heal: task missing, re-register"; Register-Task }
    $reg = Get-RegPath
    if (-not $reg -or ($reg -notlike "*$script:AgentPath*") -or ($reg -notlike "*System32\WindowsPowerShell*")) {
        Log "self-heal: reg drifted, re-register (was=$reg)"
        Register-Protocol
    }
    if ($runner) {
        $h = Http-Get ("http://{0}:7331/api/agent-hash" -f $runner) 4
        if ($h -and $h.sha256) {
            $local = Get-AgentHash
            if ($local -and ($local -ne $h.sha256.ToLower())) {
                Log "self-heal: hash drift local=$local remote=$($h.sha256)"
                try { Invoke-WebRequest -Uri ("http://{0}:7331/api/agent.ps1" -f $runner) -OutFile $script:AgentPath -UseBasicParsing -TimeoutSec 10 } catch { Log "self-heal refresh fail $_" 'ERR' }
            }
        }
    }
}

function Consume-Pending($runner,$dev){
    if (-not (Test-Path $script:PendingPath)) { return }
    try {
        $p = Get-Content -LiteralPath $script:PendingPath -Raw | ConvertFrom-Json
        Remove-Item -LiteralPath $script:PendingPath -Force -ErrorAction SilentlyContinue
        Log "pending consumed: $($p.action)"
        if ($p.action -eq 'rdp') { Ladder-Connect $runner $dev $p }
    } catch { Log "pending parse fail $_" 'ERR' }
}

function Do-Enroll {
    Log "== ENROLL BEGIN Server=$Server PagesUrl=$PagesUrl =="

    # Discover runner
    $dev = Load-Device
    $runner = Discover-Runner $dev
    if (-not $runner) { Log "ENROLL FATAL: no runner discovered" 'ERR'; exit 0 }
    Log "enroll: runner=$runner"

    # Fetch fresh agent.ps1 (self-update path)
    Log "enroll: refreshing agent.ps1 from runner"
    try {
        Invoke-WebRequest -Uri ("http://{0}:7331/api/agent.ps1" -f $runner) -OutFile $script:AgentPath -UseBasicParsing -TimeoutSec 15
        try { Unblock-File -LiteralPath $script:AgentPath -ErrorAction SilentlyContinue } catch {}
        Log "enroll: agent.ps1 refreshed ($((Get-Item $script:AgentPath).Length) bytes)"
    } catch { Log "enroll: agent.ps1 refresh fail (continuing) $_" 'WARN' }

    # Build stable device identity from MachineGuid + username
    $mg = ''
    try { $mg = [string](Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { $mg = [guid]::NewGuid().ToString() }
    $devKey = "{0}-{1}" -f $mg, $env:USERNAME
    if (-not $dev) {
        $dev = [pscustomobject]@{
            deviceId     = ''
            deviceToken  = ''
            runnersCache = @($runner)
            lastRunner   = $runner
            pagesUrl     = (Normalize-Url $PagesUrl)
            enrolledAt   = ''
        }
    }

    # POST /api/device-enroll
    $body = @{ dev = $devKey; name = $env:COMPUTERNAME; os = "$([Environment]::OSVersion.Version)"; deviceIdHint = $dev.deviceId }
    Log "enroll: POST /api/device-enroll dev=$devKey"
    $resp = Http-Post ("http://{0}:7331/api/device-enroll" -f $runner) $body 10
    if (-not $resp -or -not $resp.deviceToken) { Log "ENROLL FATAL: no deviceToken in response" 'ERR'; exit 0 }

    $dev.deviceId    = [string]$resp.deviceId
    $dev.deviceToken = [string]$resp.deviceToken
    if (-not $dev.deviceId) { $dev.deviceId = [guid]::NewGuid().ToString('N') }
    if ($resp.pagesStatusUrl) { $dev.pagesUrl = Normalize-Url $resp.pagesStatusUrl }
    elseif ($resp.pagesUrl)   { $dev.pagesUrl = Normalize-Url $resp.pagesUrl }
    $dev = Update-Cache $dev $runner
    $dev.enrolledAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Device $dev
    Log "enroll: deviceId=$($dev.deviceId) tokenLen=$($dev.deviceToken.Length) pagesUrl=$($dev.pagesUrl)"

    Register-Protocol
    Register-Task

    Log "enroll: POST /api/agent-hello"
    Http-Post ("http://{0}:7331/api/agent-hello" -f $runner) @{ deviceId=$dev.deviceId; dt=$dev.deviceToken; build=$script:Build; regPath=(Get-RegPath); taskOk=(Get-TaskOk) } 6 | Out-Null

    # Kick a detached Loop instance right now (task will also fire at logon)
    try {
        Log "enroll: starting Loop instance detached"
        Start-Process -FilePath $script:SysPwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$script:AgentPath`"",'-Loop') -WindowStyle Hidden | Out-Null
    } catch { Log "enroll: loop-start fail $_" 'WARN' }

    Log "ENROLL-OK deviceId=$($dev.deviceId)"
    exit 0
}

function Poll-Loop {
    Log "== LOOP BEGIN build=$script:Build =="
    $dev = Load-Device
    if (-not $dev -or -not $dev.deviceToken) { Log "LOOP: no device.json — need enrollment" 'ERR'; return }

    $tickHb = [DateTime]::UtcNow.AddSeconds(-100)
    $tickHeal = [DateTime]::UtcNow.AddSeconds(-100)

    while ($true) {
        $runner = Discover-Runner $dev
        if (-not $runner) { Start-Sleep -Seconds 5; continue }
        $dev = Update-Cache $dev $runner

        if (([DateTime]::UtcNow - $tickHeal).TotalSeconds -ge 300) {
            Self-Heal $runner $dev
            $tickHeal = [DateTime]::UtcNow
        }

        Consume-Pending $runner $dev

        # Poll for cmd
        $cmd = Http-Get ("http://{0}:7331/api/client-cmd?device={1}&dt={2}" -f $runner, [uri]::EscapeDataString($dev.deviceId), [uri]::EscapeDataString($dev.deviceToken)) 5
        if ($cmd -and $cmd.action -eq 'rdp' -and $cmd.host) { Ladder-Connect $runner $dev $cmd }

        if (([DateTime]::UtcNow - $tickHb).TotalSeconds -ge 30) {
            Post-Status $runner $dev 'heartbeat' @{ mstscPid = (@(Get-Process mstsc -ErrorAction SilentlyContinue)[0].Id) }
            $tickHb = [DateTime]::UtcNow
        }

        Start-Sleep -Seconds 2
    }
}

function Do-Dispatch([string]$url) {
    Log "== DISPATCH url=$url =="
    try {
        $raw = $url -replace '^ghrdp:(//)?', '' -replace '^connect\??', '' -replace '^/', ''
        $p = @{}
        foreach ($kv in ($raw -split '&')) { $eq = $kv.IndexOf('='); if ($eq -gt 0) { $p[[uri]::UnescapeDataString($kv.Substring(0,$eq)).ToLower()] = [uri]::UnescapeDataString($kv.Substring($eq+1)) } }
        if ($url -match '^ghrdp://enroll') {
            $Script:Server = $p['server']
            Do-Enroll
            return
        }
        # legacy connect: write pending.json for a running loop to consume
        if ($p.host -or $p.server) {
            $obj = @{ action='rdp'; host=$p['host']; server=$p['server']; clip=($p['clip'] -eq '1'); print=($p['print'] -eq '1'); drives=($p['drives'] -eq '1'); mic=($p['mic'] -eq '1') }
            $obj | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:PendingPath -Encoding UTF8 -Force
            Log "dispatch: wrote pending.json"
        }
    } catch { Log "dispatch fail $_" 'ERR' }
}

# --- Entrypoint dispatch ---
try {
    if ($Enroll)         { Do-Enroll; exit 0 }
    if ($Dispatch)       { Do-Dispatch $Dispatch; exit 0 }
    if ($SelfHealOnly)   { $d=Load-Device; if($d){ $r=Discover-Runner $d; Self-Heal $r $d }; exit 0 }
    if ($Loop -or $Poll) { Poll-Loop; exit 0 }
    Log "no mode flag provided — nothing to do (args=$($args -join ' '))" 'WARN'
    exit 0
} catch {
    Log "TOP-LEVEL EXCEPTION $_" 'ERR'
    exit 0
}
