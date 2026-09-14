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
$mode = [string]::Empty
$portH = [string]::Empty
$urlH = [string]::Empty
$keyH = [string]::Empty
$clip = 1; $mic = 0; $print = 0; $drives = 0
if ($Url -match 'ghrdp://(.+)$') {
    $qs = $Matches[1]
    if ($qs -match '\?') {
        $qi = $qs.IndexOf('?')
        $pp = $qs.Substring(0, $qi)
        if ($pp -and ($pp -notmatch '=')) { $mode = $pp; $qs = $qs.Substring($qi + 1) }
    }
    foreach ($kv in ($qs -split '&')) {
        $eq = $kv.IndexOf('=')
        if ($eq -gt 0) {
  $k = [uri]::UnescapeDataString($kv.Substring(0, $eq))
  $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
  if ($k -eq 'ip') { $ip = $v }
  if ($k -eq 'user' -or $k -eq 'u') { $user = $v }
  if ($k -eq 'pass' -or $k -eq 'p') { $pass = $v }
  if ($k -eq 'mode') { $mode = $v }
  if ($k -eq 'port') { $portH = $v }
  if ($k -eq 'url') { $urlH = $v }
  if ($k -eq 'key') { $keyH = $v }
  if ($k -eq 'clip') { $clip = [int]$v }
  if ($k -eq 'mic') { $mic = [int]$v }
  if ($k -eq 'print') { $print = [int]$v }
  if ($k -eq 'drives') { $drives = [int]$v }
        }
    }
}
function Expand-B64U { param([string]$S) $s = ([string]$S).Replace('-', '+').Replace('_', '/'); switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } 1 { return $null } }; try { return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) } catch { return $null } }
if ($user -like 'b64u:*') { $du = Expand-B64U $user.Substring(5); if ($null -ne $du) { $user = $du } }
if ($pass -like 'b64u:*') { $dp = Expand-B64U $pass.Substring(5); if ($null -ne $dp) { $pass = $dp } }
Write-ConnLog ('parsed: ip=' + $ip + ' user=' + $user + ' passLen=' + $pass.Length)
if ($mode -eq 'install') {
    $isrc = $null
    if ($Url -match 'src=([^&]+)') { $isrc = [uri]::UnescapeDataString($Matches[1]) }
    if (-not $isrc -and $ip) { $isrc = 'http://' + $ip + ':7331/install.ps1' }
    if (-not $isrc) { Write-ConnLog 'ERROR: install mode missing src and ip'; try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Install link is missing src/ip parameters', 'GHRDP connector') | Out-Null } catch { }; exit 1 }
    $tmp = Join-Path $env:TEMP ('ghrdp-install-' + [guid]::NewGuid().ToString('N') + '.ps1')
    try { Invoke-WebRequest -Uri $isrc -OutFile $tmp -UseBasicParsing -TimeoutSec 90 -ErrorAction Stop } catch { Write-ConnLog ('install download failed: ' + $_.Exception.Message); try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(('Installer download failed: ' + $_.Exception.Message), 'GHRDP connector') | Out-Null } catch { }; exit 1 }
    Write-ConnLog ('installer downloaded to ' + $tmp + ' - launching silent reinstall')
    try { Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $tmp + '"')) } catch { Write-ConnLog ('install launch failed: ' + $_.Exception.Message) }
    exit 0
}
if ($mode -eq 'parsec-push') {
    $src = Join-Path $env:APPDATA 'Parsec'
    Write-ConnLog ('parsec-push mode: reading ONLY from EXACT path: ' + $src)
    $cfgFile = $null
    foreach ($cn in @('config.txt','config.json')) { $p = Join-Path $src $cn; if (Test-Path -LiteralPath $p) { $cfgFile = $p; break } }
    $binFile = Join-Path $src 'user.bin'
    if ((-not $cfgFile) -or (-not (Test-Path -LiteralPath $binFile))) {
        Write-ConnLog 'parsec-push: config or user.bin missing in %APPDATA%\Parsec'
        try { Start-Process explorer.exe -ArgumentList ('"' + $src + '"') } catch { }
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Parsec login files not found. Open Parsec and log in first, then click play again. The Parsec folder is now open in Explorer.', 'GHRDP Parsec') | Out-Null } catch { }
        exit 1
    }
    $body = (@{ cfgName = (Split-Path -Leaf $cfgFile); cfgB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($cfgFile)); binB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($binFile)); src = $env:COMPUTERNAME } | ConvertTo-Json -Compress)
    $portUse = if ($portH) { $portH } else { '7331' }
    $ok = $false
    try {
        $r = Invoke-RestMethod -Uri ('http://' + $ip + ':' + $portUse + '/parsec-push') -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json' -TimeoutSec 30
        $ok = $true
        Write-ConnLog ('parsec-push OK: ' + ($r | ConvertTo-Json -Compress))
    } catch { Write-ConnLog ('parsec-push failed: ' + $_.Exception.Message) }
    try { Start-Process explorer.exe -ArgumentList ('"' + $src + '"') } catch { }
    try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($(if ($ok) { 'Parsec login uploaded to the RDP runner successfully. The Parsec folder is open in Explorer.' } else { 'Upload failed - is the runner dashboard reachable?' }), 'GHRDP Parsec') | Out-Null } catch { }
    exit 0
}
if ($mode -eq 'decrypt') {
    Write-ConnLog ('decrypt mode: url len=' + ([string]$urlH).Length)
    $dl = Join-Path $env:TEMP ('ghrdp-' + [guid]::NewGuid().ToString('N') + '.ghenc')
    try { & curl.exe -fL --max-time 600 -o $dl $urlH 2>$null; $LASTEXITCODE = 0 } catch { }
    if (-not (Test-Path -LiteralPath $dl)) { try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Download failed - check the link.', 'GHRDP decrypt') | Out-Null } catch { }; exit 1 }
    $outFile = $dl -replace '\.ghenc$', ''
    $env:GHRDP_KEY = $keyH; $env:GHRDP_IN = $dl; $env:GHRDP_OUT = $outFile
    try {
        & powershell.exe -NoProfile -Command { $p=$env:GHRDP_KEY; $s=[IO.File]::ReadAllBytes($env:GHRDP_IN); $kdf=[Security.Cryptography.Rfc2898DeriveBytes]::new($p,$s[0..15],100000,[Security.Cryptography.HashAlgorithmName]::SHA256); $a=[Security.Cryptography.Aes]::Create(); $a.Key=$kdf.GetBytes(32); $a.IV=$s[16..31]; $d=$a.CreateDecryptor(); $m=[IO.MemoryStream]::new(); $c=[Security.Cryptography.CryptoStream]::new($m,$d,[Security.Cryptography.CryptoStreamMode]::Write); $c.Write($s,32,$s.Length-32); $c.FlushFinalBlock(); [IO.File]::WriteAllBytes($env:GHRDP_OUT,$m.ToArray()) }
        $LASTEXITCODE = 0
    } catch { Write-ConnLog ('decrypt failed: ' + $_.Exception.Message) }
    try { Start-Process explorer.exe -ArgumentList ('/select,"' + $outFile + '"') } catch { }
    try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Decrypt finished - decrypted file selected in Explorer.', 'GHRDP decrypt') | Out-Null } catch { }
    Remove-Item -LiteralPath $dl -Force -ErrorAction SilentlyContinue
    exit 0
}
if ($ip -and ($Url -notmatch 'mode=')) { try { [System.IO.File]::WriteAllText($cacheFile, [string]$Url) } catch { } }
if ($ip -and ((-not $user) -or (-not $pass)) -and ($Url -notmatch 'mode=')) {
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
& cmdkey.exe "/delete:$target" 2>$null | Out-Null
$LASTEXITCODE = 0
Write-ConnLog ('stale credential cleared for target=' + $target)
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
$tsClient = 'HKCU:\Software\Microsoft\Terminal Server Client'
try {
    New-Item -Path $tsClient -Force -ErrorAction SilentlyContinue | Out-Null
    Set-ItemProperty -Path $tsClient -Name 'PublisherBypass' -Value 1 -Type DWord -ErrorAction SilentlyContinue
    $srv = Join-Path $tsClient ('Servers\' + $ip)
    New-Item -Path $srv -Force -ErrorAction SilentlyContinue | Out-Null
    Set-ItemProperty -Path $srv -Name 'Username' -Value $user -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $srv -Name 'AuthenticationLevelOverride' -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Write-ConnLog ('consent bypass set for server=' + $ip)
} catch { Write-ConnLog ('consent bypass failed: ' + $_.Exception.Message) }
Start-Sleep -Milliseconds 500
Write-ConnLog '500ms delay complete (Windows Credential Manager sync before mstsc)'
$rdpPath = Join-Path $logDir ('ghrdp-' + [guid]::NewGuid().ToString('N') + '.rdp')
$rdpLines = @(
'screen mode id:i:2',
'enablecredsspsupport:i:1',
'authentication level:i:0',
'negotiate security layer:i:1',
'prompt for credentials:i:0',
'promptcredentialonce:i:0',
'full address:s:' + $ip,
'username:s:' + $user,
'gatewayusagemethod:i:4',
'remoteapplicationmode:i:0',
'audiocapturemode:i:' + $mic,
'audiomode:i:' + $(if ($mic) { 0 } else { 1 }),
('redirectclipboard:i:' + $clip),
('redirectprinters:i:' + $print),
('redirectdrives:i:' + $drives),
'redirectcomports:i:0',
'redirectsmartcards:i:0',
'redirectposdevices:i:0',
'connect type:i:6'
)
[System.IO.File]::WriteAllText($rdpPath, ($rdpLines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-ConnLog ('wrote CredSSP-disabled rdp: ' + $rdpPath + ' clip=' + $clip + ' mic=' + $mic + ' print=' + $print + ' drives=' + $drives)
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
Start-Sleep -Seconds 6
if ($proc.HasExited) {
    $code = $proc.ExitCode
    Write-ConnLog ('mstsc exited early code=' + $code)
    $diag = @('=== mstsc EARLY EXIT code=' + $code + ' ===', '--- RDP client event log (last 5) ---')
    try { $diag += (& wevtutil.exe qe Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational /c:5 /rd:true /f:text 2>$null) } catch { }
    $diag += '--- Security 4624/4625 (last 5) ---'
    try { $diag += (& wevtutil.exe qe Security /q:"*[System[(EventID=4624 or EventID=4625)]]" /c:5 /rd:true /f:text 2>$null) } catch { }
    [System.IO.File]::WriteAllText((Join-Path $logDir 'mstsc-exit-diag.txt'), ($diag -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-ConnLog 'diag written to mstsc-exit-diag.txt - relaunching mstsc once'
    try { $proc = Start-Process mstsc.exe -ArgumentList $rdpPath -PassThru; Write-ConnLog ('mstsc relaunched pid=' + $proc.Id) } catch { Write-ConnLog ('relaunch failed: ' + $_.Exception.Message) }
    try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(('mstsc closed immediately (code ' + $code + '). Relaunched once - evidence in ' + $logDir + '\mstsc-exit-diag.txt'), 'GHRDP connector') | Out-Null } catch { }
} else {
    Write-ConnLog 'mstsc running - auto-logon expected via saved credential'
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
Remove-Item -LiteralPath $rdpPath -Force -ErrorAction SilentlyContinue
Write-ConnLog 'connect session finished; creds removed'
exit 0
