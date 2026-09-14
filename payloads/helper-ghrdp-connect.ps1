param([string]$Url)
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue | Out-Null
$logFile = Join-Path $logDir 'ghrdp-connect.log'
function Write-ConnLog { param([string]$Message) try { Add-Content -Path $logFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message) } catch { } }
$cacheFile = Join-Path $logDir 'last-url.txt'
if (([string]$Url -notmatch 'ghrdp://') -and (Test-Path -LiteralPath $cacheFile)) {
    try { $Url = ([System.IO.File]::ReadAllText($cacheFile)).Trim(); Write-ConnLog 'using cached url from last successful connect' } catch { }
}
Write-ConnLog ('--- connect requested: ' + $Url)
$ip = [string]::Empty
$user = [string]::Empty
$pass = [string]::Empty
if ($Url -match 'ghrdp://(.+)$') {
    $qs = $Matches[1]
    foreach ($kv in ($qs -split '&')) {
        $eq = $kv.IndexOf('=')
        if ($eq -gt 0) {
  $k = [uri]::UnescapeDataString($kv.Substring(0, $eq))
  $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
  if ($k -eq 'ip') { $ip = $v }
  if ($k -eq 'user' -or $k -eq 'u') { $user = $v }
  if ($k -eq 'pass' -or $k -eq 'p') { $pass = $v }
        }
    }
}
function Expand-B64U { param([string]$S) $s = ([string]$S).Replace('-', '+').Replace('_', '/'); switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } 1 { return $null } }; try { return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) } catch { return $null } }
if ($user -like 'b64u:*') { $du = Expand-B64U $user.Substring(5); if ($null -ne $du) { $user = $du } }
if ($pass -like 'b64u:*') { $dp = Expand-B64U $pass.Substring(5); if ($null -ne $dp) { $pass = $dp } }
Write-ConnLog ('parsed: ip=' + $ip + ' user=' + $user + ' passLen=' + $pass.Length)
if ($ip) { try { [System.IO.File]::WriteAllText($cacheFile, [string]$Url) } catch { } }
if ($ip -and ((-not $user) -or (-not $pass))) {
    Write-ConnLog 'creds missing from URL - trying /api/config on runner (7331 then 7332)'
    foreach ($cfgPort in @(7331, 7332)) {
        try {
            $cj = Invoke-RestMethod -Uri ('http://' + $ip + ':' + $cfgPort + '/api/config') -TimeoutSec 8 -ErrorAction Stop
            if ($cj.rdpUser -and $cj.rdpPass) { $user = [string]$cj.rdpUser; $pass = [string]$cj.rdpPass; Write-ConnLog ('creds fetched from :' + $cfgPort); break }
        } catch { Write-ConnLog ('creds fetch failed :' + $cfgPort + ' ' + $_.Exception.Message) }
    }
}
# ==== Parsec exact-path modes (top block owns BOTH; NO other path is ever read) ====
$script:ParsecExact = Join-Path $env:APPDATA 'Parsec'   # = C:\Users\<You>\AppData\Roaming\Parsec
$port = '7331'
if ($Url -match 'port=(\d+)') { $port = $Matches[1] }
if ($Url -match 'mode=parsecdir') {
    Write-ConnLog ('parsecdir: opening Windows Explorer at EXACT path: ' + $script:ParsecExact)
    if (-not (Test-Path -LiteralPath $script:ParsecExact)) { try { New-Item -ItemType Directory -Path $script:ParsecExact -Force | Out-Null } catch { } }
    $opened = $false
    try { Invoke-Item -LiteralPath $script:ParsecExact; $opened = $true } catch { Write-ConnLog ('parsecdir Invoke-Item failed: ' + $_.Exception.Message) }
    if (-not $opened) {
        try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $script:ParsecExact + '"'); $opened = $true } catch { Write-ConnLog ('parsecdir explorer.exe failed: ' + $_.Exception.Message) }
    }
    if ($opened) { Write-ConnLog ('parsecdir: Explorer opened at EXACT path: ' + $script:ParsecExact) } else { Write-ConnLog 'parsecdir: FAILED to open Explorer' }
    exit 0
}
if ($Url -match 'mode=parsec(?![a-z])') {
    Write-ConnLog ('parsec: reading ONLY from EXACT path: ' + $script:ParsecExact)
    if (-not (Test-Path -LiteralPath $script:ParsecExact)) {
        Write-ConnLog 'parsec: EXACT path missing - Parsec not installed/logged-in on this PC'
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Parsec folder not found at:' + [Environment]::NewLine + $script:ParsecExact + [Environment]::NewLine + 'Install/login Parsec first, then retry.', 'GHRDP Parsec push') | Out-Null } catch { }
        exit 1
    }
    $cfgFile = $null
    foreach ($cn in @('config.txt','config.json')) { $p = Join-Path $script:ParsecExact $cn; if (Test-Path -LiteralPath $p) { $cfgFile = $p; break } }
    $userBin = Join-Path $script:ParsecExact 'user.bin'
    if (-not $cfgFile -and -not (Test-Path -LiteralPath $userBin)) {
        Write-ConnLog 'parsec: no config/user.bin in EXACT path - not logged in yet'
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('No Parsec login files at:' + [Environment]::NewLine + $script:ParsecExact + [Environment]::NewLine + 'Open Parsec and log in first, then retry.', 'GHRDP Parsec push') | Out-Null } catch { }
        exit 1
    }
    $cfgName = if ($cfgFile) { Split-Path -Leaf $cfgFile } else { '' }
    $cfgB64  = if ($cfgFile) { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($cfgFile)) } else { '' }
    $binB64  = if (Test-Path -LiteralPath $userBin) { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($userBin)) } else { '' }
    $hkPath  = Join-Path $script:ParsecExact 'hotkey.json'
    $hkB64   = if (Test-Path -LiteralPath $hkPath) { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($hkPath)) } else { '' }
    $body = (@{ cfgName = $cfgName; cfgB64 = $cfgB64; binB64 = $binB64; hkB64 = $hkB64; src = $env:COMPUTERNAME } | ConvertTo-Json -Compress)
    try {
        $resp = Invoke-RestMethod -Uri ('http://' + $ip + ':' + $port + '/parsec-push') -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 90
        Write-ConnLog ('parsec push OK: ' + ($resp | ConvertTo-Json -Compress))
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(('Parsec credentials pushed to runner: ' + [string]$resp.dest), 'GHRDP Parsec push') | Out-Null } catch { }
        exit 0
    } catch {
        Write-ConnLog ('parsec push FAILED: ' + $_.Exception.Message)
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(('Parsec push failed: ' + $_.Exception.Message), 'GHRDP Parsec push') | Out-Null } catch { }
        exit 3
    }
}
if ([string]::IsNullOrEmpty($ip)) {
    Write-ConnLog 'ERROR: missing ip parameter'
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show('ghrdp link is missing the ip parameter', 'GHRDP connector') | Out-Null
    } catch { }
    exit 1
}
if ([string]::IsNullOrEmpty($user) -or [string]::IsNullOrEmpty($pass)) {
    Write-ConnLog 'ERROR: creds unavailable (not in URL, cache, or /api/config) - refusing degraded connect'
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(('Could not get RDP credentials for ' + $ip + ' (not in link, cache, or runner :7331/:7332 /api/config). Is the runner dashboard running?'), 'GHRDP connector') | Out-Null
    } catch { }
    exit 1
}
$target = 'TERMSRV/' + $ip
$storeOut = (& cmdkey.exe "/generic:$target" "/user:$user" "/pass:$pass" 2>&1) -join ' '
$LASTEXITCODE = 0
Write-ConnLog ('cmdkey store target=' + $target + ' user=' + $user + ' -> ' + $storeOut)
$creds = (& cmdkey.exe /list 2>$null) -join "`n"
$LASTEXITCODE = 0
if ($creds -notlike "*$target*") {
    Write-ConnLog ('WARNING: credential ' + $target + ' not visible in cmdkey /list yet (continuing anyway)')
} else {
    Write-ConnLog ('credential verified in Credential Manager: ' + $target)
}
Start-Sleep -Milliseconds 500
Write-ConnLog '500ms delay complete (Windows Credential Manager sync before mstsc)'
$rdpPath = Join-Path $logDir 'ghrdp-session.rdp'
$rdpLines = @(
'screen mode id:i:2',
'enablecredsspsupport:i:0',
'authentication level:i:2',
'negotiate security layer:i:0',
'prompt for credentials:i:1',
'full address:s:' + $ip,
'username:s:' + $user,
'gatewayusagemethod:i:4',
'remoteapplicationmode:i:0',
'audiocapturemode:i:1',
'audiomode:i:0',
'redirectclipboard:i:1',
'connect type:i:6'
)
[System.IO.File]::WriteAllText($rdpPath, ($rdpLines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-ConnLog ('wrote CredSSP-disabled rdp: ' + $rdpPath)
$proc = $null
try {
    $proc = Start-Process mstsc.exe -ArgumentList $rdpPath -PassThru
    Write-ConnLog ('mstsc started with CredSSP-disabled .rdp pid=' + $proc.Id)
} catch {
    Write-ConnLog ('mstsc start failed: ' + $_.Exception.Message)
    & cmdkey.exe "/delete:$target" 2>$null | Out-Null
    $LASTEXITCODE = 0
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(('Could not start mstsc.exe: ' + $_.Exception.Message), 'GHRDP connector') | Out-Null
    } catch { }
    exit 1
}
try {
    $proc.WaitForExit()
    Write-ConnLog 'mstsc exited'
} catch {
    Write-ConnLog ('WaitForExit error: ' + $_.Exception.Message)
}
$delOut = (& cmdkey.exe "/delete:$target" 2>&1) -join ' '
$LASTEXITCODE = 0
Write-ConnLog ('cmdkey delete target=' + $target + ' -> ' + $delOut)
Write-ConnLog 'connect session finished'
exit 0
