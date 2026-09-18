# ghrdp-agent.ps1 — persistent pull-model RDP agent (build 20260918001)
# Runs as: powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File agent.ps1 [-Poll | -Dispatch <url> | -Enroll <src>]
[CmdletBinding()]
param(
  [string]$Dispatch,
  [string]$Enroll,
  [switch]$Poll,
  [switch]$SelfHealOnly
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'
$script:Build          = 20260918001
$script:AgentDir       = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
$script:AgentPath      = Join-Path $script:AgentDir  'agent.ps1'
$script:DeviceJson     = Join-Path $script:AgentDir  'device.json'
$script:LogPath        = Join-Path $script:AgentDir  'agent.log'
$script:LogBak         = "$script:LogPath.1"
$script:TaskName       = 'GhrdpAgent'
$script:ProtoName      = 'ghrdp'
$script:SysPwsh        = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:HttpTimeout    = 5

if (-not (Test-Path $script:AgentDir)) { New-Item -ItemType Directory -Path $script:AgentDir -Force | Out-Null }

function Write-Log([string]$msg,[string]$lvl='INFO'){
  try{
    if((Test-Path $script:LogPath) -and (Get-Item $script:LogPath).Length -gt 200KB){
      Copy-Item $script:LogPath $script:LogBak -Force
      Clear-Content $script:LogPath -Force
    }
    "[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'),$lvl,$msg | Add-Content $script:LogPath
  }catch{}
}

function Load-Device{
  if(-not (Test-Path $script:DeviceJson)){ return $null }
  try{ Get-Content $script:DeviceJson -Raw | ConvertFrom-Json }catch{ $null }
}
function Save-Device($obj){
  try{ ($obj | ConvertTo-Json -Depth 6) | Set-Content $script:DeviceJson -Encoding UTF8 -Force }catch{ Write-Log "save-device fail: $_" 'ERR' }
}

function Try-GetJson([string]$url,[int]$timeout=$script:HttpTimeout){
  try{
    $r = Invoke-RestMethod -Uri $url -Method Get -UseBasicParsing -TimeoutSec $timeout
    return $r
  }catch{ return $null }
}
function Try-PostJson([string]$url,$body,[int]$timeout=$script:HttpTimeout){
  try{
    $json = $body | ConvertTo-Json -Depth 8 -Compress
    return Invoke-RestMethod -Uri $url -Method Post -Body $json -ContentType 'application/json' -UseBasicParsing -TimeoutSec $timeout
  }catch{ return $null }
}

function Ping-Runner([string]$ip){
  if([string]::IsNullOrWhiteSpace($ip)){ return $null }
  $r = Try-GetJson ("http://{0}:7331/api/ping" -f $ip) 3
  if($r -and $r.ok){ return $r }
  return $null
}

function Discover-Runner($dev){
  # 1) lastRunner
  if($dev.lastRunner){ $p = Ping-Runner $dev.lastRunner; if($p){ Write-Log "discover: lastRunner=$($dev.lastRunner)"; return $dev.lastRunner } }
  # 2) runnersCache
  foreach($ip in @($dev.runnersCache)){
    if(-not $ip){ continue }
    $p = Ping-Runner $ip; if($p){ Write-Log "discover: cache=$ip"; return $ip }
  }
  # 3) Pages status.json
  if($dev.pagesUrl){
    $s = Try-GetJson $dev.pagesUrl 5
    if($s -and $s.runnerIp){
      $p = Ping-Runner $s.runnerIp
      if($p){ Write-Log "discover: pages=$($s.runnerIp)"; return $s.runnerIp }
    }
  }
  # 4) tailscale peers
  try{
    $ts = & tailscale status --json 2>$null | Out-String
    if($ts){
      $tj = $ts | ConvertFrom-Json
      foreach($peer in $tj.Peer.PSObject.Properties.Value){
        if($peer.Online -and $peer.TailscaleIPs){
          foreach($ip in $peer.TailscaleIPs){
            $p = Ping-Runner $ip
            if($p){ Write-Log "discover: tailscale=$ip"; return $ip }
          }
        }
      }
    }
  }catch{}
  return $null
}

function Update-RunnerCache($dev,[string]$ip){
  if(-not $ip){ return $dev }
  $dev.lastRunner = $ip
  $c = @($dev.runnersCache) | Where-Object { $_ -and $_ -ne $ip }
  $dev.runnersCache = @(,$ip) + $c | Select-Object -First 6
  Save-Device $dev
  return $dev
}

function Post-Status($runner,$dev,$cmdId,[hashtable]$fields){
  if(-not $runner -or -not $dev){ return }
  $body = @{
    deviceId = $dev.deviceId
    dt       = $dev.deviceToken
    cmdId    = $cmdId
    build    = $script:Build
    regPath  = (Get-RegProtoCommand)
    taskOk   = (Task-Exists)
  }
  foreach($k in $fields.Keys){ $body[$k] = $fields[$k] }
  [void](Try-PostJson ("http://{0}:7331/api/client-status" -f $runner) $body 4)
}

function Get-LogonAge{
  try{
    $sess = & quser 2>$null | Out-String
    if($sess -match 'rdp'){ return 0 } else { return -1 }
  }catch{ return -1 }
}

function Get-MstscPid{
  $p = Get-Process mstsc -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1
  if($p){ return $p.Id } else { return 0 }
}

function Write-RdpFile([string]$host_,[string]$user,[hashtable]$opts,[int]$authLvl,[int]$credssp){
  $file = Join-Path $script:AgentDir ("connect-{0}.rdp" -f ([guid]::NewGuid().ToString('N').Substring(0,8)))
  $lines = @(
    "screen mode id:i:2",
    "use multimon:i:0",
    "session bpp:i:32",
    "connection type:i:7",
    ("full address:s:{0}" -f $host_),
    ("username:s:{0}" -f $user),
    ("authentication level:i:{0}" -f $authLvl),
    ("enablecredsspsupport:i:{0}" -f $credssp),
    "prompt for credentials:i:0",
    "negotiate security layer:i:1",
    ("redirectclipboard:i:{0}" -f ([int]([bool]$opts.clip))),
    ("redirectprinters:i:{0}"  -f ([int]([bool]$opts.print))),
    ("redirectdrives:i:{0}"    -f ([int]([bool]$opts.drives))),
    ("audiomode:i:{0}"         -f (@{ $true=0; $false=2 }[[bool]$opts.mic])),
    ("audiocapturemode:i:{0}"  -f ([int]([bool]$opts.mic)))
  )
  $lines | Set-Content $file -Encoding ASCII -Force
  try{ Unblock-File $file }catch{}
  return $file
}

function Set-PublisherBypass{
  try{
    $k = 'HKCU:\Software\Microsoft\Terminal Server Client\LocalDevices'
    if(-not (Test-Path $k)){ New-Item -Path $k -Force | Out-Null }
    Set-ItemProperty -Path $k -Name '*' -Value 0x4C -Type DWord -Force
  }catch{ Write-Log "PublisherBypass fail: $_" 'WARN' }
}

function Store-Cred([string]$host_,[string]$user,[string]$pass){
  & cmdkey.exe /generic:("TERMSRV/{0}" -f $host_) /user:$user /pass:$pass 2>&1 | Out-Null
}

function Wait-Connected([int]$pidNum,[int]$sec){
  $end = (Get-Date).AddSeconds($sec)
  while((Get-Date) -lt $end){
    $p = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
    if(-not $p){ return @{ ok=$false; reason='mstsc-exited' } }
    if((Get-LogonAge) -ge 0){ return @{ ok=$true; reason='logon' } }
    Start-Sleep -Milliseconds 500
  }
  return @{ ok=$false; reason='timeout' }
}

function Ladder-Connect($runner,$dev,$cmd){
  $host_  = $cmd.host
  $user   = $cmd.user
  $pass   = $cmd.pass
  $opts   = @{ clip=$cmd.clip; mic=$cmd.mic; print=$cmd.print; drives=$cmd.drives }
  $needRdp = ($opts.print -or $opts.drives -or $opts.mic)
  Store-Cred $host_ $user $pass

  # L1 — mstsc /v (clipboard-only, no .rdp) when no extra redirections
  if(-not $needRdp){
    Post-Status $runner $dev $cmd.cmdId @{ stage='L1-launching' }
    $p = Start-Process -FilePath 'mstsc.exe' -ArgumentList ("/v:{0}" -f $host_) -WindowStyle Hidden -PassThru
    $r = Wait-Connected $p.Id 8
    if($r.ok){ Post-Status $runner $dev $cmd.cmdId @{ stage='connected'; mstscPid=$p.Id; logonAge=0 }; Write-Log "L1 connected pid=$($p.Id)"; return $true }
    Write-Log "L1 fail: $($r.reason); trying L2"
    Post-Status $runner $dev $cmd.cmdId @{ stage='L1-failed'; err=$r.reason }
    try{ Stop-Process -Id $p.Id -Force }catch{}
  }

  # L2 — .rdp with auth=2 credssp=1 full redirections
  Post-Status $runner $dev $cmd.cmdId @{ stage='L2-launching' }
  $rdp = Write-RdpFile $host_ $user $opts 2 1
  $p2 = Start-Process -FilePath 'mstsc.exe' -ArgumentList ('"{0}"' -f $rdp) -WindowStyle Hidden -PassThru
  $r2 = Wait-Connected $p2.Id 8
  if($r2.ok){ Post-Status $runner $dev $cmd.cmdId @{ stage='connected'; mstscPid=$p2.Id; logonAge=0 }; Write-Log "L2 connected pid=$($p2.Id)"; return $true }
  Write-Log "L2 fail: $($r2.reason); trying L3"
  Post-Status $runner $dev $cmd.cmdId @{ stage='L2-failed'; err=$r2.reason }
  try{ Stop-Process -Id $p2.Id -Force }catch{}

  # L3 — auth=0 credssp=0 + PublisherBypass
  Set-PublisherBypass
  Post-Status $runner $dev $cmd.cmdId @{ stage='L3-launching' }
  $rdp3 = Write-RdpFile $host_ $user $opts 0 0
  $p3 = Start-Process -FilePath 'mstsc.exe' -ArgumentList ('"{0}"' -f $rdp3) -WindowStyle Hidden -PassThru
  $r3 = Wait-Connected $p3.Id 10
  if($r3.ok){ Post-Status $runner $dev $cmd.cmdId @{ stage='connected'; mstscPid=$p3.Id; logonAge=0 }; Write-Log "L3 connected pid=$($p3.Id)"; return $true }

  Post-Status $runner $dev $cmd.cmdId @{ stage='failed'; err=$r3.reason }
  Write-Log "L3 fail: $($r3.reason); uploading diag" 'ERR'
  Upload-Diag $runner $dev "ladder-exhausted"
  return $false
}

function Upload-Diag($runner,$dev,[string]$reason){
  if(-not $runner -or -not $dev){ return }
  $tail = ''; if(Test-Path $script:LogPath){ $tail = (Get-Content $script:LogPath -Tail 100) -join "`n" }
  $reg  = ''; try{ $reg = & reg.exe query "HKCU\Software\Classes\ghrdp" /s 2>&1 | Out-String }catch{}
  $tstate = ''; try{ $tstate = (Get-ScheduledTask -TaskName $script:TaskName -EA SilentlyContinue | ConvertTo-Json -Depth 3) }catch{}
  $wev = ''; try{ $wev = & wevtutil qe Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational /c:5 /rd:true /f:text 2>&1 | Out-String }catch{}
  $ck = 0; try{ $ck = (& cmdkey /list 2>&1 | Select-String 'TERMSRV/').Count }catch{}
  $body = @{
    deviceId = $dev.deviceId
    dt       = $dev.deviceToken
    reason   = $reason
    bundle   = @{ agentLog=$tail; regQuery=$reg; taskState=$tstate; mstscExit=''; wevtutil=$wev; cmdkeyCount=$ck }
  }
  [void](Try-PostJson ("http://{0}:7331/api/diag-upload" -f $runner) $body 8)
}

function Task-Exists{
  try{ [bool](Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) }catch{ $false }
}

function Get-RegProtoCommand{
  try{
    (Get-ItemProperty "HKCU:\Software\Classes\$script:ProtoName\shell\open\command" -Name '(default)' -EA SilentlyContinue).'(default)'
  }catch{ '' }
}

function Register-Protocol{
  $cmd = ('"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Dispatch "%1"' -f $script:SysPwsh,$script:AgentPath)
  $base = "HKCU:\Software\Classes\$script:ProtoName"
  New-Item -Path $base -Force | Out-Null
  Set-ItemProperty -Path $base -Name '(default)' -Value ("URL:{0} Protocol" -f $script:ProtoName) -Force
  Set-ItemProperty -Path $base -Name 'URL Protocol' -Value '' -Force
  New-Item -Path "$base\shell\open\command" -Force | Out-Null
  Set-ItemProperty -Path "$base\shell\open\command" -Name '(default)' -Value $cmd -Force
  Write-Log "protocol registered: $cmd"
}

function Register-Task{
  try{
    $a = New-ScheduledTaskAction -Execute $script:SysPwsh -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Poll' -f $script:AgentPath)
    $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden
    $p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $script:TaskName -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
    Write-Log "scheduled task registered"
  }catch{ Write-Log "task register fail: $_" 'ERR' }
}

function Self-Heal($runner,$dev){
  if(-not (Task-Exists)){ Write-Log "self-heal: task missing" 'WARN'; Register-Task }
  $reg = Get-RegProtoCommand
  if($reg -notmatch [regex]::Escape($script:SysPwsh)){ Write-Log "self-heal: reg drifted" 'WARN'; Register-Protocol }
  try{
    $h = Try-GetJson ("http://{0}:7331/api/agent-hash" -f $runner) 4
    if($h -and $h.sha256 -and (Test-Path $script:AgentPath)){
      $local = (Get-FileHash $script:AgentPath -Algorithm SHA256).Hash.ToLower()
      if($local -ne $h.sha256.ToLower()){
        Write-Log "self-heal: hash drift local=$local remote=$($h.sha256)" 'WARN'
        try{
          Invoke-WebRequest -Uri ("http://{0}:7331/api/agent.ps1" -f $runner) -OutFile $script:AgentPath -UseBasicParsing -TimeoutSec 8
          Write-Log "agent.ps1 refreshed from runner"
        }catch{ Write-Log "refresh fail: $_" 'ERR' }
      }
    }
  }catch{}
  # Clean old ghrdp-connect.ps1
  $old = Join-Path $script:AgentDir 'ghrdp-connect.ps1'
  if(Test-Path $old){ Remove-Item $old -Force -EA SilentlyContinue; Write-Log "cleaned legacy ghrdp-connect.ps1" }
}

function Do-Enroll([string]$src){
  Write-Log "enroll: src=$src"
  if(-not (Test-Path $script:AgentDir)){ New-Item -ItemType Directory -Path $script:AgentDir -Force | Out-Null }
  try{
    Invoke-WebRequest -Uri "$src/api/agent.ps1" -OutFile $script:AgentPath -UseBasicParsing -TimeoutSec 10
  }catch{ Write-Log "enroll fetch fail: $_" 'ERR' }

  $dev = Load-Device
  if(-not $dev){
    $dev = [pscustomobject]@{
      deviceId     = [guid]::NewGuid().ToString()
      deviceToken  = ''
      runnersCache = @()
      lastRunner   = ''
      pagesUrl     = ''
    }
  }
  if(-not $dev.pagesUrl){
    # Derive pagesUrl from src if it contains github.io, otherwise leave for server response
    $dev.pagesUrl = ''
  }
  $body = @{ deviceId=$dev.deviceId; name=$env:COMPUTERNAME; os=[System.Environment]::OSVersion.Version.ToString() }
  $host_ = ([uri]$src).Host
  $resp = Try-PostJson ("http://{0}:7331/api/device-enroll" -f $host_) $body 8
  if($resp -and $resp.deviceToken){
    $dev.deviceToken = $resp.deviceToken
    if($resp.runnerIp){ $dev.lastRunner = $resp.runnerIp; $dev.runnersCache = @($resp.runnerIp) }
    if($resp.pagesUrl){ $dev.pagesUrl = $resp.pagesUrl }
    Save-Device $dev
    Write-Log "enroll ok deviceId=$($dev.deviceId)"
  }else{ Write-Log "enroll response missing token" 'ERR' }
  Register-Protocol
  Register-Task
}

function Dispatch-Url([string]$url){
  Write-Log "dispatch: $url"
  try{
    $u = [uri]$url
    $path = $u.Host + $u.AbsolutePath
    $qs = @{}; foreach($p in ($u.Query.TrimStart('?') -split '&')){ if($p){ $kv = $p -split '=',2; $qs[$kv[0]] = [uri]::UnescapeDataString($kv[1]) } }
    switch -Regex ($path){
      '^enroll'  { Do-Enroll ($qs.src); return }
      '^connect' {
        # legacy one-shot fallback: server= & token=
        $dev = Load-Device
        if($dev -and $qs.server){
          $dev = Update-RunnerCache $dev $qs.server
          Start-Sleep -Seconds 1
          # trigger a poll cycle
          Poll-Loop -Once
        }
        return
      }
      default { Write-Log "dispatch: unknown $path" 'WARN' }
    }
  }catch{ Write-Log "dispatch parse fail: $_" 'ERR' }
}

function Poll-Loop{
  param([switch]$Once)
  $dev = Load-Device
  if(-not $dev -or -not $dev.deviceToken){ Write-Log "poll: not enrolled" 'ERR'; return }
  $lastHeal = Get-Date; $lastBeat = Get-Date 0
  while($true){
    $runner = Discover-Runner $dev
    if($runner){
      $dev = Update-RunnerCache $dev $runner
      $url = "http://{0}:7331/api/client-cmd?device={1}&dt={2}" -f $runner,$dev.deviceId,$dev.deviceToken
      $cmd = Try-GetJson $url 4
      if($cmd -and $cmd.action -eq 'rdp' -and $cmd.host){
        Write-Log "cmd received cmdId=$($cmd.cmdId) host=$($cmd.host)"
        try{ Ladder-Connect $runner $dev $cmd | Out-Null }catch{ Write-Log "ladder exc: $_" 'ERR' }
      }
      if(((Get-Date) - $lastBeat).TotalSeconds -ge 30){
        Post-Status $runner $dev '' @{ stage='heartbeat'; mstscPid=(Get-MstscPid); logonAge=(Get-LogonAge); runnersCacheAge=([int]((Get-Date) - (Get-Item $script:DeviceJson).LastWriteTime).TotalSeconds) }
        $lastBeat = Get-Date
      }
      if(((Get-Date) - $lastHeal).TotalMinutes -ge 5){ Self-Heal $runner $dev; $lastHeal = Get-Date }
    }else{
      Write-Log "poll: no runner discovered" 'WARN'
    }
    if($Once){ return }
    Start-Sleep -Seconds 2
  }
}

# ---- entry point ----
try{
  if($Enroll){ Do-Enroll $Enroll; exit 0 }
  if($Dispatch){ Dispatch-Url $Dispatch; exit 0 }
  if($SelfHealOnly){ $dev = Load-Device; if($dev){ $r = Discover-Runner $dev; if($r){ Self-Heal $r $dev } }; exit 0 }
  Poll-Loop
}catch{
  Write-Log "top-level exc: $_" 'ERR'
  exit 0
}
