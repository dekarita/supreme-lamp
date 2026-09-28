param(
    [string]$Root = 'C:\ghrdp',
    [int]$MaxMinutes = 340
)
$ErrorActionPreference = 'Continue'
$libPath = Join-Path $Root 'ghrdp-lib.ps1'
if (-not (Test-Path -LiteralPath $libPath)) { exit 1 }
. $libPath
# [F46] mirror host contract + attempt policy. Dot-sourced, never copied, so the
# watcher, the server (Diagnose probe) and the Explorer uploader share ONE
# implementation. A missing module is reported as a labeled reason per file -
# it can never fall back to the old bare five-try loop.
$global:GhrdpMirrorModulePath = Join-Path $Root 'ghrdp-mirror.ps1'
$mirrorModuleOk = $false
if (Test-Path -LiteralPath $global:GhrdpMirrorModulePath) {
    try {
        . $global:GhrdpMirrorModulePath
        $mirrorModuleOk = [bool](Get-Command Invoke-F46MirrorAttempt -ErrorAction SilentlyContinue)
    } catch {
        $mirrorModuleOk = $false
    }
}
$global:GhrdpCfgPath = Join-Path $Root 'config.json'
function Resolve-RealProfile {
    param([string]$User)
    try {
        if ($env:USERNAME -and ($env:USERNAME -ieq $User) -and $env:USERPROFILE -and (Test-Path -LiteralPath $env:USERPROFILE)) {
  return [string]$env:USERPROFILE
        }
    } catch { }
    try {
        $keys = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction SilentlyContinue
        foreach ($k in $keys) {
  $img = (Get-ItemProperty -Path $k.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
  if ($img) {
      $leaf = Split-Path -Leaf ([string]$img)
      if ($leaf -ieq $User) { return [string]$img }
      if ($leaf.Length -gt $User.Length -and $leaf.ToLower().StartsWith(($User + '.').ToLower())) { return [string]$img }
  }
        }
    } catch { }
    try {
        $dirs = Get-ChildItem 'C:\Users' -Directory -Filter ($User + '*') -ErrorAction SilentlyContinue
        foreach ($d in @($dirs)) { if ($d.Name -ieq $User) { return $d.FullName } }
        if ($dirs -and (@($dirs).Count -gt 0)) { return @($dirs)[0].FullName }
    } catch { }
    return $null
}
function Test-MirrorJunk {
    param([System.IO.FileInfo]$File)
    $low = ([string]$File.Name).ToLower()
    if ($low -eq 'desktop.ini' -or $low -eq 'thumbs.db') { return $true }
    if ($low -like 'ntuser.dat*') { return $true }
    if ($File.Name.StartsWith('~$')) { return $true }
    if ($low -eq 'wmsetup.log' -or $low -eq 'msedge_installer.log' -or $low -eq 'chrome_installer.log') { return $true }
    if ($low -like 'notifyicongenerated*.png') { return $true }
    if ($low -eq 'lockfile') { return $true }
    $badExt = @('.tmp', '.temp', '.partial', '.part', '.crdownload', '.download', '.opdownload', '.pid', '.lock', '.lck', '.swp', '.etl', '.json', '.log', '.ini', '.dat', '.db-journal', '.db-wal', '.!qb', '.!ut', '.aria2', '.wkdownload')
    $ext = [System.IO.Path]::GetExtension($low)
    if ($badExt -contains $ext) { return $true }
    if ($low.EndsWith('.ghenc')) { return $true }
    $exactJunk = @('messages.json', 'verified_contents.json', 'manifest.json', 'preferences.json', 'local state')
    if ($exactJunk -contains $low) { return $true }
    if ($low -match '^(config|progress|mirror-index|package|package-lock|tsconfig|manifest|settings|preferences|bookmarks|cookies|history|favicons|login data|web data|local state)') { return $true }
    $dir = ([string]$File.DirectoryName).ToLower()
    if ($dir -match '\\(appdata|\.cache|\.config|\.local|cache|logs|temp\\[a-f0-9\-]{20,}|\.git)\\') { return $true }
    if ($dir -match '\\(scoped_dir|crx_install)\\') { return $true }
    if ($dir -match '\\appdata\\local\\temp\\[a-f0-9\-]{20,}\\') { return $true }
    return $false
}
function Get-ExtraRoots {
param([string]$UserName)
$out = New-Object System.Collections.ArrayList
$prof = Resolve-RealProfile -User $UserName
if ($prof) {
$ini = Join-Path $prof 'AppData\Local\qBittorrent\qBittorrent.ini'
if (Test-Path -LiteralPath $ini) {
foreach ($ln in (Get-Content -LiteralPath $ini -ErrorAction SilentlyContinue)) {
if ($ln -match '^\s*SavePath\s*=\s*(.+)$') {
$p = $Matches[1].Trim()
if ($p -and (Test-Path -LiteralPath $p)) { [void]$out.Add($p) }
}
}
}
foreach ($cand in @(
(Join-Path $prof 'Downloads'),
(Join-Path $prof 'Downloads\qBittorrent'),
(Join-Path $prof 'Torrents'),
'D:\RDP-Storage',
'C:\Torrents'
)) { if (Test-Path -LiteralPath $cand) { [void]$out.Add($cand) } }
}
return @($out | Select-Object -Unique)
}
function Get-WatcherRoots {
    param([string]$UserName)
    $list = New-Object System.Collections.ArrayList
    $prof = Resolve-RealProfile -User $UserName
    if (-not $prof) { return @() }
    $shell = $null
    try { $shell = New-Object -ComObject Shell.Application } catch { }
    if ($shell) {
        foreach ($cs in @('shell:Downloads', 'shell:desktop', 'shell:Documents')) {
  $p = $null
  try { $p = [string]$shell.NameSpace($cs).Self.Path } catch { }
  if ($p -and (Test-Path -LiteralPath $p)) { [void]$list.Add($p) }
        }
    }
    foreach ($sub in @('Downloads', 'Desktop', 'Documents')) {
        $p = Join-Path $prof $sub
        if (Test-Path -LiteralPath $p) { [void]$list.Add($p) }
    }
    $tmp = ''
    try { $tmp = [string]$env:TEMP } catch { }
    if (-not $tmp) { $tmp = Join-Path $prof 'AppData\Local\Temp' }
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { [void]$list.Add($tmp) }
    if (Test-Path -LiteralPath 'D:\RDP-Storage') { [void]$list.Add('D:\RDP-Storage') }
    $seen = @{}
    $out = New-Object System.Collections.ArrayList
    foreach ($r in $list) {
        $k = ([string]$r).ToLower()
        if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; [void]$out.Add([string]$r) }
    }
    return @($out)
}
function Update-BrowserBookmarks {
    param([string]$TelegraphUrl)
    try {
        $marker = Join-Path $Root 'bookmark-url.txt'
        $last = ''
        if (Test-Path -LiteralPath $marker) { $last = ([System.IO.File]::ReadAllText($marker)).Trim() }
        if (($last -eq [string]$TelegraphUrl) -and $last) { return }
        $cfg2 = Read-MirrorCfg -Path (Join-Path $Root 'config.json')
        $ip = ''
        $repo = ''
        if ($cfg2) {
  $ip = [string]$cfg2.rdpIp
  $repo = [string]$cfg2.repo
        }
        $children = @(
  @{ name = 'Mission Control (PS 7331)'; url = 'http://127.0.0.1:7331' },
  @{ name = 'Mission Control (Rust 7332)'; url = 'http://127.0.0.1:7332' }
        )
        if ($ip) { $children += @{ name = 'Mission Control (tailnet)'; url = ('http://' + $ip + ':7332') } }
        $children += @(
  @{ name = 'qBittorrent Web UI'; url = 'http://127.0.0.1:8080' },
  @{ name = 'FMHY Torrenting'; url = 'https://fmhy.net/torrenting' },
  @{ name = 'Tailscale Admin'; url = 'https://login.tailscale.com/admin/machines' }
        )
        if ($TelegraphUrl) { $children += @{ name = 'GitHub RDP Mirror (Telegraph)'; url = $TelegraphUrl } }
        if ($repo) { $children += @{ name = 'GitHub Actions'; url = ('https://github.com/' + $repo + '/actions') } }
        $favsJson = ConvertTo-Json -InputObject @(@{ toplevel_name = 'GHRDP'; children = $children }) -Depth 6 -Compress
        foreach ($polPath in @('HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge')) {
  try {
      New-Item -Path $polPath -Force -ErrorAction SilentlyContinue | Out-Null
      Set-ItemProperty -Path $polPath -Name 'ManagedFavorites' -Value $favsJson -ErrorAction SilentlyContinue
  } catch { }
        }
        try { Get-Process -Name msedge, firefox -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
        try { & gpupdate.exe /force 2>$null | Out-Null; $LASTEXITCODE = 0 } catch { }
        [System.IO.File]::WriteAllText($marker, [string]$TelegraphUrl, $global:GhrdpEncNoBom)
        Add-MirrorLog ('[bookmarks] Edge + Firefox updated (telegraph=' + [string]$TelegraphUrl + ')')
    } catch {
        Add-MirrorLog ('[bookmarks] update failed: ' + $_.Exception.Message)
    }
}
function Invoke-FirstRunUserSetup {
    param([string]$UserName)
    try {
        $prof = Resolve-RealProfile -User $UserName
        if (-not $prof) { return }
        $marker = Join-Path $prof 'AppData\Local\ghrdp-firstrun.done'
        if (Test-Path -LiteralPath $marker) { return }
        $themePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
        New-Item -Path $themePath -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path $themePath -Name 'AppsUseLightTheme' -Value 0 -Type DWord -ErrorAction SilentlyContinue
        Set-ItemProperty -Path $themePath -Name 'SystemUsesLightTheme' -Value 0 -Type DWord -ErrorAction SilentlyContinue
        $dwmPath = 'HKCU:\Software\Microsoft\Windows\DWM'
        New-Item -Path $dwmPath -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path $dwmPath -Name 'AccentColor' -Value 0xff4cc2ff -Type DWord -ErrorAction SilentlyContinue
        Set-ItemProperty -Path $dwmPath -Name 'AccentColorInactive' -Value 0xff2a6f8f -Type DWord -ErrorAction SilentlyContinue
        foreach ($cand in @((Join-Path $env:ProgramFiles 'Parsec\parsecd.exe'), (Join-Path $env:ProgramFiles 'Parsec\parsec.exe'))) {
  if (Test-Path -LiteralPath $cand) {
      $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
      New-Item -Path $runPath -Force -ErrorAction SilentlyContinue | Out-Null
      Set-ItemProperty -Path $runPath -Name 'Parsec' -Value ('"{0}"' -f $cand) -ErrorAction SilentlyContinue
      break
  }
        }
        $startupDir = Join-Path $prof 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
        New-Item -ItemType Directory -Path $startupDir -Force -ErrorAction SilentlyContinue | Out-Null
        $lnk = Join-Path $startupDir 'GHRDP Watcher.lnk'
        if (-not (Test-Path -LiteralPath $lnk)) {
  $pwshExe = 'powershell.exe'
  try { $c = Get-Command pwsh.exe -ErrorAction Stop; if ($c) { $pwshExe = $c.Source } } catch { }
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = $pwshExe
  $sc.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\ghrdp\ghrdp-watcher.ps1"'
  $sc.WorkingDirectory = 'C:\ghrdp'
  $sc.WindowStyle = 7
  $sc.Save()
        }
        New-Item -ItemType File -Path $marker -Force -ErrorAction SilentlyContinue | Out-Null
        Add-MirrorLog '[watcher] first-run user setup applied (dark mode, accent, Parsec autolaunch, startup shortcut)'
    } catch { }
}
$mutex = $null
$owned = $false
try {
    $mutex = New-Object System.Threading.Mutex($false, 'Local\GhrdpWatcherSingleInstance')
    $owned = $mutex.WaitOne(0)
} catch {
    $owned = $true
}
if (-not $owned) {
    try { if ($mutex) { $mutex.Dispose() } } catch { }
    exit 0
}
try {
    $cfg = Read-MirrorCfg -Path (Join-Path $Root 'config.json')
    if (-not $cfg) { exit 0 }
    $userName = [string]$cfg.rdpUser
    $progPath = Join-Path $Root 'progress.json'
    $doneFile = Join-Path $Root 'mirror-done.txt'
    $idxFile = Join-Path $Root 'mirror-index.json'
    $encDir = Join-Path $Root 'enc'
    New-Item -ItemType Directory -Path $encDir -Force -ErrorAction SilentlyContinue | Out-Null
    Initialize-MirrorProgress -Path $progPath
    $prog = $global:GhrdpProg
    $prog.mirror = [bool]$cfg.mirror
    $prog.alive = $true
    $telemetry = $prog.telemetry
    $telemetry.roots = @()
    Flush-MirrorProgress -Force
    function Get-RdpSessionState {
        param([string]$User)
        try {
            $out = & quser.exe 2>$null
            $LASTEXITCODE = 0
            if ($out) {
                foreach ($line in @($out)) {
                    $parts = $line.Trim() -split '\s+'
                    if ($parts.Count -ge 4 -and ($parts[0] -eq $User -or $parts[0] -eq ('>'+$User))) {
                        if ($parts -contains 'Active') { return $true }
                    }
                }
            }
        } catch { }
        try {
            $s = Get-CimInstance Win32_LogonSession -Filter "LogonType = 10" -ErrorAction SilentlyContinue
            if ($s) { return $true }
        } catch { }
        try { $est = Get-NetTCPConnection -LocalPort 3389 -State Established -ErrorAction SilentlyContinue; if ($est) { return $true } } catch { }
        return $false
    }
    if (-not [string]$cfg.sessionStartedAt) {
        if (-not (Get-RdpSessionState -User $userName)) {
            Write-Host '[watcher] no interactive RDP logon yet - session clock stays unset'
            exit 0
        }
        $cfg.sessionStartedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $cfg.watcherDeadline = ((Get-Date).AddMinutes($MaxMinutes)).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Save-MirrorCfg -Cfg $cfg -Path (Join-Path $Root 'config.json')
        Add-MirrorLog ('[watcher] RDP logon confirmed via quser - sessionStartedAt stamped at ' + $cfg.sessionStartedAt)
    }
    Add-MirrorLog '[watcher] watcher started (single instance; heartbeat every 5s)'
    if ($mirrorModuleOk) {
        Add-MirrorLog ('[mirror] policy loaded: fail-fast=' + (@($script:F46FailFastStatuses) -join ',') + ' transient=' + (@($script:F46TransientPhases) -join ',') + ' maxAttempts=' + [int]$script:F46MaxAttempts)
    } else {
        Add-MirrorLog '[mirror] ghrdp-mirror.ps1 NOT loaded - every upload attempt will be reported as phase=parse (staging bug)'
    }
    if (-not [string]$cfg.runnerEgressIp) {
        $eg = Get-RunnerEgressIp
        if ($eg) {
  $cfg.runnerEgressIp = $eg
  Save-MirrorCfg -Cfg $cfg -Path (Join-Path $Root 'config.json')
  Add-MirrorLog ('[net] runner egress IP: ' + $eg)
        } else {
  Add-MirrorLog '[net] runner egress IP lookup failed - uploads still run on the runner'
        }
    } else {
        Add-MirrorLog ('[net] runner egress IP: ' + [string]$cfg.runnerEgressIp)
    }
    # [remediation] legacy rentry scrape removed (mirror path disabled per remediation)
    $egress = [string]$cfg.runnerEgressIp
    Invoke-FirstRunUserSetup -UserName $userName
    # [remediation] initial mirror index publish + mirror bookmark update removed (mirror path disabled)
    $minBytes = 512
    $scanSeconds = 10
    # [F46 §2] the fixed-tries counter is replaced by the policy ledger:
    # per-file attempt records, a terminal set and a per-file due time.
    $mirrorAttempts = @{}
    $mirrorTerminal = @{}
    $mirrorNextAt = @{}
    $mirrorDiagLimit = 200
    # [F49] the last runtime opt-in marker already ledgered (marker `at` stamp).
    $script:F49LastOptInAt = ''
    $mirrorPolicyMax = 5
    if ($mirrorModuleOk) {
        try { $mirrorPolicyMax = [int]$script:F46MaxAttempts } catch { $mirrorPolicyMax = 5 }
    }
    $mirrorAttemptLog = New-Object System.Collections.ArrayList
    $enqueued = @{}
    $incompleteExt = @('.!qb', '.!ut', '.aria2', '.wkdownload', '.part0', '.part1', '.part2', '.part3', '.part4', '.part5', '.part6', '.part7', '.part8', '.part9')
    $idx = Get-MirrorIndexList -IdxFile $idxFile
    if ($null -eq $idx) { $idx = New-Object System.Collections.ArrayList }
    $doneMap = Get-MirrorDoneMap -DoneFile $doneFile
    $deadline = (Get-Date).AddMinutes($MaxMinutes)
    while ((Get-Date) -lt $deadline) {
        try {
  $fullPass = $false
  # [F49] runtime opt-in flags (dashboard ConfirmModal -> POST /api/mirror/
  # enable|disable). The server already wrote config.json + the beacon; these
  # flags apply the SAME change to the watcher's in-memory config (config.json
  # is loaded once at start) and ledger it. Flag files are the channel, so no
  # read-modify-write race with the watcher's own config saves is possible.
  $f49EnFlag = Join-Path $Root 'mirror-enable.flag'
  if (Test-Path -LiteralPath $f49EnFlag) {
      Remove-Item -LiteralPath $f49EnFlag -Force -ErrorAction SilentlyContinue
      $f49Disk = $null
      try { $f49Disk = Read-MirrorCfg -Path (Join-Path $Root 'config.json') } catch { $f49Disk = $null }
      if ($f49Disk) {
          try { $cfg.mirror = [bool]$f49Disk.mirror } catch { try { $cfg.mirror = $true } catch { } }
          try { $cfg.mirrorHosts = @($f49Disk.mirrorHosts) } catch { }
          try {
              if ($cfg.PSObject.Properties['mirrorRuntimeOptIn']) { $cfg.mirrorRuntimeOptIn = $f49Disk.mirrorRuntimeOptIn }
              else { $cfg | Add-Member -MemberType NoteProperty -Name 'mirrorRuntimeOptIn' -Value $f49Disk.mirrorRuntimeOptIn -Force }
          } catch { }
      } else {
          try { $cfg.mirror = $true } catch { }
      }
      Save-MirrorCfg -Cfg $cfg -Path (Join-Path $Root 'config.json')
  }
  $f49DisFlag = Join-Path $Root 'mirror-disable.flag'
  if (Test-Path -LiteralPath $f49DisFlag) {
      Remove-Item -LiteralPath $f49DisFlag -Force -ErrorAction SilentlyContinue
      try { $cfg.mirror = $false } catch { }
      try { foreach ($f49h in @($cfg.mirrorHosts)) { $f49h.enabled = $false } } catch { }
      try { if ($cfg.PSObject.Properties['mirrorRuntimeOptIn']) { $cfg.PSObject.Properties.Remove('mirrorRuntimeOptIn') } } catch { }
      Save-MirrorCfg -Cfg $cfg -Path (Join-Path $Root 'config.json')
      $f49Off = ''
      try { $f49Off = Format-F49OptOutLedger } catch { $f49Off = '' }
      if (-not $f49Off) { $f49Off = '[mirror] RUNTIME OPT-IN: cleared by dashboard (mirror=false, hosts disabled)' }
      Add-MirrorLog $f49Off
  }
  # [F49] the §3 ledger line: one line per runtime opt-in marker, emitted when
  # the worker applies it (first pass after the click, or first pass after a
  # watcher start when the operator enabled before the watcher ran).
  $f49Marker = $null
  try { if ($cfg.PSObject.Properties['mirrorRuntimeOptIn']) { $f49Marker = $cfg.mirrorRuntimeOptIn } } catch { }
  $f49At = ''
  try { if ($f49Marker -and $f49Marker.PSObject.Properties['at']) { $f49At = [string]$f49Marker.at } } catch { }
  if ($f49Marker -and $f49At -and ($f49At -ne [string]$script:F49LastOptInAt)) {
      $script:F49LastOptInAt = $f49At
      $f49Line = ''
      try { $f49Line = Format-F49OptInLedger -Marker $f49Marker -HostId 'gofile' } catch { $f49Line = '' }
      if (-not $f49Line) { $f49Line = ('[mirror] RUNTIME OPT-IN: enabled=true scope=this-run source=runtime host=gofile at=' + $f49At) }
      Add-MirrorLog $f49Line
  }
  $flushFlag = Join-Path $Root 'flush.flag'
  if (Test-Path -LiteralPath $flushFlag) {
      Remove-Item -LiteralPath $flushFlag -Force -ErrorAction SilentlyContinue
      $fullPass = $true
      $script:GhrdpStable = @{}
      $enqueued = @{}
      $mirrorTerminal = @{}
      $mirrorNextAt = @{}
      $mirrorAttempts = @{}
      Add-MirrorLog '[mirror] flush requested: attempt ledger reset (fresh attempt 1 per file, policy reapplied)'
      if (-not [bool]$cfg.mirror) {
          $cfg.mirror = $true
          Save-MirrorCfg -Cfg $cfg -Path (Join-Path $Root 'config.json')
          Add-MirrorLog '[watcher] mirror ENABLED by flush request (Upload everything now button)'
      }
      $roots = @((Get-WatcherRoots -UserName $userName) + (Get-ExtraRoots -UserName $userName) | Select-Object -Unique)
      $telemetry.roots = @($roots)
      Add-MirrorLog '[watcher] full pass requested (upload everything now)'
  }
  if (@(Get-ChildItem -Path (Join-Path $Root 'enc') -File -ErrorAction SilentlyContinue).Count -gt 0) { Add-MirrorLog '[watcher] stale .ghenc leftovers found in enc dir - cleaning' ; Remove-Item -LiteralPath (Join-Path $Root 'enc\*') -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath (Join-Path $Root 'emergency.flag')) { $fullPass = $true }
  $prog.alive = $true
  $telemetry.scans = [int]$telemetry.scans + 1
  $telemetry.lastScan = (Get-Date -Format o)
  $roots = @((Get-WatcherRoots -UserName $userName) + (Get-ExtraRoots -UserName $userName) | Select-Object -Unique)
  $telemetry.roots = @($roots)
  $queue = New-Object System.Collections.ArrayList
  if (-not $script:GhrdpStable) { $script:GhrdpStable = @{} }
  $nowT = Get-Date
  $busyFolders = @{}
  foreach ($r in $roots) {
      if (-not (Test-Path -LiteralPath $r)) { continue }
      $found0 = $null
      try { $found0 = Get-ChildItem -LiteralPath $r -File -Recurse -ErrorAction SilentlyContinue } catch { }
      foreach ($f0 in @($found0)) {
          if (-not $f0) { continue }
          $low0 = ([string]$f0.Name).ToLower()
          $inc = $false
          foreach ($ie in $incompleteExt) { if ($low0.EndsWith($ie)) { $inc = $true; break } }
          $k0 = ([string]$f0.FullName).ToLower()
          $growing = $false
          if ($script:GhrdpStable.ContainsKey($k0)) { if ([long]$script:GhrdpStable[$k0].size -ne [long]$f0.Length) { $growing = $true } }
          if ($inc -or $growing) {
              $d0 = [string]$f0.DirectoryName
              while ($d0 -and ($d0.Length -ge ([string]$r).Length)) { $busyFolders[$d0.ToLower()] = $true; $pp = Split-Path $d0 -Parent; if (-not $pp -or $pp -eq $d0) { break }; $d0 = $pp }
          }
      }
  }
  foreach ($r in $roots) {
      if (-not (Test-Path -LiteralPath $r)) { continue }
      $found = $null
      try { $found = Get-ChildItem -LiteralPath $r -File -Recurse -ErrorAction SilentlyContinue } catch { }
      foreach ($f in @($found)) {
          if (-not $f) { continue }
          $key = ([string]$f.FullName).ToLower()
          if ($key.StartsWith($Root.ToLower())) { continue }
          if ($doneMap.ContainsKey($key)) { continue }
          if ($mirrorTerminal.ContainsKey($key)) { continue }
          $telemetry.seen = [int]$telemetry.seen + 1
          if (Test-MirrorJunk -File $f) { $telemetry.skippedJunk = [int]$telemetry.skippedJunk + 1; continue }
          if ([long]$f.Length -lt $minBytes) { $telemetry.skippedSmall = [int]$telemetry.skippedSmall + 1; continue }
          $hn = [string]$f.Name
          $ishidden = $false
          foreach ($hp in @($cfg.hiddenFiles)) { if ($hn -like $hp) { $ishidden = $true; break } }
          if ($ishidden) { continue }
          $dd = ([string]$f.DirectoryName).ToLower()
          $inBusy = $false
          while ($dd -and ($dd.Length -ge ([string]$r).Length)) { if ($busyFolders.ContainsKey($dd)) { $inBusy = $true; break }; $pp2 = Split-Path $dd -Parent; if (-not $pp2 -or $pp2 -eq $dd) { break }; $dd = $pp2 }
          if ($inBusy) { $telemetry.locked = [int]$telemetry.locked + 1; continue }
          if (-not $enqueued.ContainsKey($key)) {
              if (-not $fullPass) {
                  $prev = $null
                  if ($script:GhrdpStable.ContainsKey($key)) { $prev = $script:GhrdpStable[$key] }
                  if ($null -eq $prev) { $script:GhrdpStable[$key] = @{ size = [long]$f.Length; t = $nowT }; continue }
                  if ([long]$prev.size -ne [long]$f.Length) { $script:GhrdpStable[$key] = @{ size = [long]$f.Length; t = $nowT }; continue }
                  if (($nowT - [datetime]$prev.t).TotalSeconds -lt 15) { continue }
              }
              $enqueued[$key] = [long]$f.Length
              $prog.agg.total = [int]$prog.agg.total + 1
              $prog.agg.bytesTotal = [long]$prog.agg.bytesTotal + [long]$f.Length
          }
          [void]$queue.Add($f)
      }
  }
  $queue = [System.Collections.ArrayList]@($queue | Sort-Object LastWriteTime)
  $telemetry.queued = [int]$queue.Count
  if (@($queue).Count -gt 0) { Add-MirrorLog ('[watcher] queue={0} mirror={1} (click "Upload everything now" to bypass stability gate)' -f @($queue).Count, [bool]$cfg.mirror) }
  $prog.agg.active = [int]$queue.Count
  if ((@($queue).Count -gt 0) -or ($telemetry.seen -gt 0) -or (($beat2 = ($telemetry.scans % 6)) -eq 0)) {
  Add-MirrorLog ('[watcher] scan #{0}: seen={1} queued={2} mirror={3} roots={4}' -f $telemetry.scans, $telemetry.seen, @($queue).Count, [bool]$cfg.mirror, @($roots).Count)
  }
  if ((-not [bool]$cfg.mirror) -and (@($queue).Count -gt 0)) {
  Add-MirrorLog ('[watcher] MIRROR IS OFF - {0} file(s) tracked but NOT uploaded. Click "Upload everything now" or re-run with mirror=true.' -f @($queue).Count)
  }
  Flush-MirrorProgress -Force
  if ([bool]$cfg.mirror -and (@($queue).Count -gt 0)) {
      $encryptMode = [string]$cfg.encryptMode
      if (-not $encryptMode) { $encryptMode = 'none' }
      $mediaExt = @('.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mp3', '.flac', '.wav', '.aac', '.ogg', '.wma', '.m4a', '.opus')
      # [F46 §1/§2] ONE host decision per scan + the attempt ledger. An attempt
      # only happens when its own policy backoff is due: the fixed ~10s cadence
      # that produced five instant failures in the same second is gone.
      $mirrorHosts = @()
      $mirrorHost = $null
      if ($mirrorModuleOk) {
          try { $mirrorHosts = @(Get-F46Hosts -Cfg $cfg) } catch { $mirrorHosts = @() }
          try { $mirrorHost = Select-F46UploadHost -Hosts $mirrorHosts } catch { $mirrorHost = $null }
          try {
              $prog.mirrorHosts = @($mirrorHosts | ForEach-Object { [ordered]@{ id = [string]$_.id; enabled = [bool]$_.enabled; apiRoot = [string]$_.apiRoot; maxFileBytes = [long]$_.maxFileBytes; blockedExtensions = @($_.blockedExtensions) } })
          } catch { }
      }
      $prog.encryptMode = $encryptMode
      # [F47 §3] the per-run AES-256 key is read ONCE per scan and is only ever
      # used as key material: it goes into the redaction set for every log line
      # and attempt record, and never into a URL, artifact or progress field.
      $mirrorKeyText = ''
      try { $mirrorKeyText = ([string]$cfg.mirrorKey).Trim() } catch { $mirrorKeyText = '' }
      $mirrorEncAlg = ''
      # [F48 §1.3] authMode is set by the attempt/probe RESULT only:
      # 'guest' until the host answers 401/403 ('requires-account').
      $mirrorAuthMode = 'guest'
      foreach ($f in @($queue)) {
          $key = ([string]$f.FullName).ToLower()
          if ($mirrorTerminal.ContainsKey($key)) { continue }
          # [F46 §2] backoff gate: no network attempt before the policy due time.
          if ($mirrorNextAt.ContainsKey($key)) {
              $dueAt = [datetime]$mirrorNextAt[$key]
              if ((Get-Date) -lt $dueAt) {
                  $waitSec = [int][math]::Max(0, ($dueAt - (Get-Date)).TotalSeconds)
                  $prev = @($mirrorAttempts[$key])
                  $lastRec = $null
                  if (@($prev).Count -gt 0) { $lastRec = $prev[@($prev).Count - 1] }
                  $waitMsg = ('backoff window open (' + $waitSec + 's until attempt ' + (1 + @($prev).Count) + ' of ' + [int]$mirrorPolicyMax + ')')
                  $entryW = [ordered]@{
                      name = [string]$f.Name
                      folder = '.'
                      size = [long]$f.Length
                      phase = 'queued'
                      pct = 0
                      status = 'pending'
                      link = ''
                      encrypted = 'False'
                      host = $(if ($mirrorHost) { [string]$mirrorHost.id } else { '-' })
                      error = $(if ($lastRec) { ((Format-F46Reason -Phase ([string]$lastRec.phase) -Status ([string]$lastRec.status) -Message ([string]$lastRec.msg)) + ' | ' + $waitMsg) } else { $waitMsg })
                      attempts = @($prev)
                  }
                  $newFilesW = @($entryW) + @($prog.files)
                  if ($newFilesW.Count -gt 60) { $newFilesW = $newFilesW[0..59] }
                  $prog.files = $newFilesW
                  Flush-MirrorProgress -Force
                  continue
              }
          }
          $fExt = [System.IO.Path]::GetExtension(([string]$f.Name).ToLower())
          $shouldEncrypt = $false
          if ($encryptMode -eq 'all') { $shouldEncrypt = $true }
          elseif ($encryptMode -eq 'media-plain') { $shouldEncrypt = -not ($mediaExt -contains $fExt) }
          $relFolder = '.'
          foreach ($rr in $roots) {
              $fs = [string]$f.FullName
              $rrs = ([string]$rr).TrimEnd('\')
              if ($fs.StartsWith($rrs + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
                  $df = [System.IO.Path]::GetDirectoryName($fs.Substring($rrs.Length + 1))
                  if ($df) { $relFolder = $df }
                  break
              }
          }
          $prevAttempts = @($mirrorAttempts[$key])
          $attemptNo = @($prevAttempts).Count + 1
          $entry = [ordered]@{
              name = [string]$f.Name
              folder = $relFolder
              size = [long]$f.Length
              phase = $(if ($shouldEncrypt) { 'encrypt' } else { 'upload' })
              pct = 0
              status = 'active'
              link = ''
              encrypted = 'False'
              host = $(if ($mirrorHost) { [string]$mirrorHost.id } else { '-' })
              attempts = @($prevAttempts)
          }
          $newFiles = @($entry) + @($prog.files)
          if ($newFiles.Count -gt 60) { $newFiles = $newFiles[0..59] }
          $prog.files = $newFiles
          $uploadPath = $f.FullName
          $uploadLen = [long]$f.Length
          $dispName = [string]$f.Name
          $encPath = $null
          $encApplied = $false
          $uploadMime = ''
          if ($shouldEncrypt) {
              # [F47 §3] AES-256 HONEST MODE: the documented encryption is now
              # REAL. The per-run 32-byte key comes from config mirrorKey (the
              # one place it lives; never logged, never in a URL or artifact).
              # The ciphertext is stamped application/x-ghrdp-mirror so the
              # legacy Explorer/decrypt path recognises it. If the key is
              # missing or no AES-256 encryptor can be constructed, the attempt
              # is ONE labeled fail-fast reason - never a plaintext upload
              # behind an "encrypted" claim.
              $encErr = ''
              $encRes = $null
              if (-not (Test-Path -LiteralPath $f.FullName)) {
                  $encErr = 'source vanished before encryption'
              } elseif (-not $mirrorModuleOk) {
                  $encErr = 'ghrdp-mirror.ps1 is missing on this runner - the AES-256 encryptor is unavailable (staging bug); refusing to upload plaintext'
              } elseif (-not $mirrorKeyText) {
                  $encErr = 'mirror_encrypt was requested but config mirrorKey holds no per-run 32-byte key (dispatch main.yml with mirror_enable=true + mirror_encrypt=true); refusing to upload plaintext'
              } else {
                  $encDir = Join-Path $Root 'enc'
                  try { New-Item -ItemType Directory -Path $encDir -Force -ErrorAction SilentlyContinue | Out-Null } catch { }
                  $encPath = Join-Path $encDir (([string]$f.Name) + [string]$script:F46GofileContract.encryptedSuffix)
                  try {
                      $encRes = Invoke-F46EncryptFile -Path ([string]$f.FullName) -OutPath $encPath -KeyBase64 $mirrorKeyText
                  } catch {
                      $encRes = @{ ok = $false; alg = ''; bytes = 0; message = ('encryptor threw: ' + $_.Exception.Message) }
                  }
                  if (-not $encRes -or -not [bool]$encRes.ok) {
                      $encErr = $(if ($encRes -and $encRes.message) { [string]$encRes.message } else { 'AES-256 encryptor unavailable on this runner; refusing to upload plaintext' })
                  }
              }
              if ($encErr) {
                  Add-MirrorLog ('[mirror] attempt {0} host={1} phase=encrypt status=- msg={2} ms=0' -f $attemptNo, [string]$entry['host'], $encErr)
                  $entry['phase'] = 'encrypt'
                  $entry['status'] = 'failed'
                  $entry['error'] = ('phase=encrypt status=- msg=' + $encErr)
                  $entry['encrypted'] = 'False'
                  $mirrorTerminal[$key] = $true
                  $prog.agg.failed = [int]$prog.agg.failed + 1
                  try { if ($encPath -and (Test-Path -LiteralPath $encPath)) { Remove-Item -LiteralPath $encPath -Force -ErrorAction SilentlyContinue } } catch { }
                  Flush-MirrorProgress -Force
                  continue
              }
              $encApplied = $true
              $uploadPath = $encPath
              $uploadLen = [long]$encRes.bytes
              $dispName = (([string]$f.Name) + [string]$script:F46GofileContract.encryptedSuffix)
              $uploadMime = [string]$script:F46GofileContract.encryptedMime
              # The key is named, never printed: only algorithm + sizes are logged.
              Add-MirrorLog ('[mirror] encrypted {0} -> {1} bytes alg={2} mime={3} key=redacted(32B, config mirrorKey)' -f $f.Name, $uploadLen, [string]$encRes.alg, $uploadMime)
          } else {
              if (-not (Test-Path -LiteralPath $f.FullName)) {
                  Add-MirrorLog ('[mirror] VANISHED {0} (file disappeared before upload)' -f $f.Name)
                  $entry['phase'] = 'skipped'
                  $entry['status'] = 'vanished'
                  $entry['error'] = 'file vanished before processing'
                  $prog.agg.total = [math]::Max(0, [int]$prog.agg.total - 1)
                  $prog.agg.bytesTotal = [math]::Max(0, [long]$prog.agg.bytesTotal - [long]$f.Length)
                  Flush-MirrorProgress -Force
                  continue
              }
          }
          Set-ActiveFile -Name $f.Name -Phase 'upload' -Total $uploadLen
          Add-MirrorLog ('[mirror] uploading {0} ({1} bytes, display={2}, encrypted={3}, host={4}, attempt={5}/{6})' -f $f.Name, $uploadLen, $dispName, $encApplied, [string]$entry['host'], $attemptNo, [int]$mirrorPolicyMax)
          if (-not $mirrorModuleOk) {
              # A staging bug is a labeled reason, never five blind retries.
              $modMsg = 'ghrdp-mirror.ps1 is missing on this runner - the attempt cannot be classified (staging bug; no retry loop started)'
              Add-MirrorLog ('[mirror] attempt {0} host={1} phase=parse status=- msg={2} ms=0' -f $attemptNo, '-', $modMsg)
              $entry['phase'] = 'parse'
              $entry['status'] = 'failed'
              $entry['error'] = ('phase=parse status=- msg=' + $modMsg)
              $mirrorTerminal[$key] = $true
              $prog.agg.failed = [int]$prog.agg.failed + 1
              Flush-MirrorProgress -Force
              continue
          }
          # [F48 §0] token-less guest mode: no credential is read anywhere -
          # the attempt below is always the unauthenticated guest multipart.
          $res = $null
          try {
              $res = Invoke-F46MirrorAttempt -HostCfg $mirrorHost -Path $uploadPath -Name $dispName -Size $uploadLen -AttemptNo $attemptNo -EncryptRequested $shouldEncrypt -Encrypted $encApplied -ContentType $uploadMime
          } catch {
              $res = @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = ('mirror attempt threw: ' + $_.Exception.Message); retryAfterMs = $null; record = $null; fileId = ''; code = ''; downloadPage = ''; directUrl = '' }
          }
          if ($null -eq $res) { $res = @{ ok = $false; phase = 'parse'; httpStatus = $null; hostMessage = 'mirror attempt returned nothing'; retryAfterMs = $null; record = $null; fileId = ''; code = ''; downloadPage = ''; directUrl = '' } }
          try { if ($res.authMode) { $mirrorAuthMode = [string]$res.authMode } } catch { }
          $fullMsg = Protect-F46SecretText -Text ([string]$res.hostMessage) -Secrets @($mirrorKeyText)
          $phaseNow = [string]$res.phase
          $statusNow = '-'
          if ($null -ne $res.httpStatus) { if ([string]$res.httpStatus) { $statusNow = [string]$res.httpStatus } }
          $attemptRec = $res.record
          if ($attemptRec) {
              $attemptRec['msg'] = $fullMsg
              [void]$mirrorAttemptLog.Add($attemptRec)
              if (-not $mirrorAttempts.ContainsKey($key)) { $mirrorAttempts[$key] = New-Object System.Collections.ArrayList }
              [void]$mirrorAttempts[$key].Add($attemptRec)
              $entry['attempts'] = @($mirrorAttempts[$key])
              Add-MirrorLog (Format-F46AttemptLine -Attempt $attemptRec)
          }
          if ($encApplied) { try { $mirrorEncAlg = [string]$encRes.alg } catch { $mirrorEncAlg = 'AES-256' } }
          # [F47 §3] the local ciphertext is a transport artifact only: it is
          # deleted as soon as the attempt is classified, success or failure.
          try { if ($encPath -and (Test-Path -LiteralPath $encPath)) { Remove-Item -LiteralPath $encPath -Force -ErrorAction SilentlyContinue } } catch { }
          $link = $null
          if ([bool]$res.ok) {
              $link = [string]$res.directUrl
              if (-not $link) { $link = [string]$res.downloadPage }
          }
          if ($link) {
              $previewLink = ''
              $prevExt = [System.IO.Path]::GetExtension(([string]$f.Name).ToLower())
              $previewable = @('.png','.jpg','.jpeg','.gif','.webp','.bmp','.mp3','.flac','.wav','.aac','.ogg','.m4a','.mp4','.mkv','.webm','.mov','.avi') -contains $prevExt
              try { Add-MirrorDone -DoneFile $doneFile -Path $key -Size ([long]$f.Length) } catch { Add-MirrorLog ('[mirror] guarded step done-map failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              try { $doneMap[$key] = [long]$f.Length } catch { Add-MirrorLog ('[mirror] guarded step done-cache failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              try { $global:GhrdpDoneBytes = [long]$global:GhrdpDoneBytes + [long]$f.Length } catch { Add-MirrorLog ('[mirror] guarded step bytes failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              try {
                  $tsl = (Get-Date).AddHours(5).AddMinutes(30).ToString('yyyy-MM-dd HH:mm:ss')
                  if ($null -ne $link) { [void]$idx.Add(@{ name = [string]$f.Name; folder = $relFolder; size = [long]$f.Length; time = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); timeSL = $tsl; link = [string]$link; fileId = [string]$res.fileId; code = [string]$res.code; preview = [string]$previewLink; encrypted = [string]$encApplied; decrypt = (([string]$cfg.pagesBase) + '/decrypt.html#key=' + [string]$cfg.mirrorKey) }) }
              } catch { Add-MirrorLog ('[mirror] guarded step index-append failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              try { Save-MirrorIndexList -IdxFile $idxFile -List $idx } catch { Add-MirrorLog ('[mirror] guarded step save-index failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              # [remediation] mirror index publish removed (lib fn neutered)
              # [remediation] mirror pages-data publish removed (lib fn neutered)
              try { Save-MirrorCfg -Cfg $cfg -Path (Join-Path $Root 'config.json') } catch { Add-MirrorLog ('[mirror] guarded step save-config failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              try { if ([string]$cfg.mirrorIndexUrl) { Update-BrowserBookmarks -TelegraphUrl ([string]$cfg.mirrorIndexUrl) } } catch { Add-MirrorLog ('[mirror] guarded step bookmarks failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              try {
                  $entry['phase'] = 'done'
                  $entry['status'] = 'done'
                  $entry['pct'] = 100
                  $entry['link'] = [string]$link
                  $entry['encrypted'] = [string]$encApplied
                  if ($entry.Contains('error')) { $entry.Remove('error') }
                  $prog.agg.done = [int]$prog.agg.done + 1
                  $prog.active.name = ''
                  $prog.active.phase = 'idle'
                  $prog.active.pct = 0
                  $prog.active.bytesDone = [long]0
                  $prog.active.bytesTotal = [long]0
                  $prog.active.speedBps = [long]0
              } catch { Add-MirrorLog ('[mirror] guarded step entry-update failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace) }
              Add-MirrorLog ('[mirror] OK {0} -> {1} via runner egress {2} (host={3}, encrypted={4})' -f $f.Name, $link, $(if ($egress) { $egress } else { 'unknown' }), [string]$entry['host'], $encApplied)
          } else {
              # [F46 §1/§2] the reason IS the product: host + phase + status +
              # the complete host message, persisted for the UI and the artifact.
              $entry['error'] = (Format-F46Reason -Phase $phaseNow -Status $res.httpStatus -Message $fullMsg)
              $maxFor = [int](Get-F46MaxAttempts -Phase $phaseNow -Status $res.httpStatus)
              $retryable = (Test-F46TransientPhase -Phase $phaseNow -Status $res.httpStatus) -and ($attemptNo -lt $maxFor)
              if ($retryable) {
                  $delay = [int](Get-F46BackoffMs -Attempt ($attemptNo - 1) -RetryAfterMs $res.retryAfterMs)
                  if ($delay -lt 1) { $delay = 1 }
                  $mirrorNextAt[$key] = (Get-Date).AddMilliseconds($delay)
                  $entry['phase'] = 'queued'
                  $entry['status'] = 'pending'
                  $entry['retryInMs'] = $delay
                  Add-MirrorLog ('[mirror] attempt {0} retryable host={1} phase={2} status={3} next-in-ms={4} (policy: {5} of {6} allowed)' -f $attemptNo, [string]$entry['host'], $phaseNow, $statusNow, $delay, $attemptNo, $maxFor)
              } else {
                  $entry['phase'] = 'failed'
                  $entry['status'] = 'failed'
                  $mirrorTerminal[$key] = $true
                  $prog.agg.failed = [int]$prog.agg.failed + 1
                  Add-MirrorLog (Format-F46FailureSummary -HostId ([string]$entry['host']) -Phase $phaseNow -Status $statusNow -Attempts $attemptNo -Message $fullMsg)
              }
          }
          Flush-MirrorProgress -Force
      }
      # Attempt table for the mirror-diag artifact + the Diagnose output.
      try {
          $diagAttempts = @($mirrorAttemptLog)
          if ($diagAttempts.Count -gt $mirrorDiagLimit) { $diagAttempts = $diagAttempts[($diagAttempts.Count - $mirrorDiagLimit)..($diagAttempts.Count - 1)] }
          # [F49] the runtime opt-in marker rides mirrorDiag so /diag carries
          # the same opt-in record the ledger line was stamped from.
          $f49OptInDiag = $null
          try { if ($cfg.PSObject.Properties['mirrorRuntimeOptIn'] -and $cfg.mirrorRuntimeOptIn) { $f49OptInDiag = $cfg.mirrorRuntimeOptIn } } catch { }
          $prog.mirrorDiag = [ordered]@{ attempts = @($diagAttempts); terminalFiles = @($mirrorTerminal.Keys); hosts = @($prog.mirrorHosts); encryptMode = $encryptMode; encAlg = $mirrorEncAlg; authMode = $mirrorAuthMode; keyBytes = $(if ($mirrorKeyText) { 32 } else { 0 }); optIn = $f49OptInDiag }
      } catch { }
  } else {
      if (-not [bool]$cfg.mirror) {
          if (@($queue).Count -gt 0) {
              Add-MirrorLog ('[watcher] mirror disabled; {0} file(s) tracked but NOT uploaded' -f @($queue).Count)
          }
      }
  }
  $hflag = Join-Path $Root 'hidden.flag'
  if (Test-Path -LiteralPath $hflag) {
      $hl = @(Get-Content -LiteralPath $hflag -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
      if ($hl.Count) {
          $cfg.hiddenFiles = @(@($cfg.hiddenFiles) + $hl | Select-Object -Unique)
          Save-MirrorCfg -Cfg $cfg -Path (Join-Path $Root 'config.json')
          Remove-Item -LiteralPath $hflag -Force -ErrorAction SilentlyContinue
          Add-MirrorLog ('[hide] permanently hidden ' + $hl.Count + ' pattern(s)')
      }
  }
  if ((-not $script:GhrdpLastLinkCheck) -or ((Get-Date) - $script:GhrdpLastLinkCheck).TotalMinutes -ge 10) {
      $script:GhrdpLastLinkCheck = Get-Date
      foreach ($it in @($idx)) {
          if ([string]$it.status -eq 'done' -and [string]$it.link -match 'gofile\.io') {
              $code = 0
              # [F46] no spoofed User-Agent: a plain HEAD-style GET with curl defaults.
try { $code = [int](& curl.exe -o NUL -s -w '%{http_code}' --max-time 10 ([string]$it.link) 2>$null); $LASTEXITCODE = 0 } catch { }
              if ($code -eq 404 -or $code -eq 410) { $it.status = 'expired'; Add-MirrorLog ('[link] EXPIRED on host: ' + [string]$it.name) }
          }
      }
      Save-MirrorIndexList -IdxFile $idxFile -List $idx
  }
  $prog.agg.active = 0
  Flush-MirrorProgress -Force
        } catch {
  Add-MirrorLog ('[watcher] loop error: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace)
        }
        $slept = 0
        while ($slept -lt $scanSeconds) {
  Start-Sleep -Seconds 5
  $slept = $slept + 5
  $prog.alive = $true
  Flush-MirrorProgress -Force
  if (Test-Path -LiteralPath (Join-Path $Root 'flush.flag')) { break }
  if (Test-Path -LiteralPath (Join-Path $Root 'emergency.flag')) { break }
        }
    }
    $prog.alive = $false
    Flush-MirrorProgress -Force
    Add-MirrorLog '[watcher] watcher stopping (time limit)'
} catch {
    Write-Host ('[watcher] FATAL: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace)
} finally {
    try { if ($owned -and $mutex) { [void]$mutex.ReleaseMutex() } } catch { }
    try { if ($mutex) { $mutex.Dispose() } } catch { }
}
