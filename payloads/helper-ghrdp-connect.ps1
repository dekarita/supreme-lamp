param([string]$Url)
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue | Out-Null
$logFile = Join-Path $logDir 'ghrdp-connect.log'
function Write-ConnLog {
    param([string]$Message)
    try { Add-Content -Path $logFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message) } catch { }
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
  if ($k -eq 'user') { $user = $v }
  if ($k -eq 'pass') { $pass = $v }
        }
    }
}
Write-ConnLog ('parsed: ip=' + $ip + ' user=' + $user + ' passLen=' + $pass.Length)
$mode = ''
if ($Url -match 'mode=([a-z]+)') { $mode = $Matches[1] }
if ($mode -eq 'parsec') {
    Write-ConnLog 'parsec mode: auto-discovering local Parsec credential folder (no folder picker)'
    $cands = @()
    if ($env:APPDATA)      { $cands += (Join-Path $env:APPDATA 'Parsec') }
    if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Parsec') }
    if ($env:PROGRAMDATA)  { $cands += (Join-Path $env:PROGRAMDATA 'Parsec') }
    try {
        $hits = Get-ChildItem -Path $env:USERPROFILE -Directory -Recurse -Depth 4 -Filter 'Parsec' -ErrorAction SilentlyContinue | Select-Object -First 5
        foreach ($h in @($hits)) { $cands += [string]$h.FullName }
    } catch { }
    $src = $null; $cfgFile = $null; $binFile = $null
    foreach ($c in $cands) {
        if (-not $c -or -not (Test-Path -LiteralPath $c)) { continue }
        $cf = $null
        $bf = Join-Path $c 'user.bin'
        if (Test-Path -LiteralPath (Join-Path $c 'config.txt'))      { $cf = Join-Path $c 'config.txt' }
        elseif (Test-Path -LiteralPath (Join-Path $c 'config.json')) { $cf = Join-Path $c 'config.json' }
        if ($cf -and (Test-Path -LiteralPath $bf)) { $src = $c; $cfgFile = $cf; $binFile = $bf; break }
    }
    if (-not $src) {
        Write-ConnLog 'parsec push: no Parsec folder with config+user.bin found locally'
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Parsec credential folder not found on this PC. Log in to Parsec here once, then retry.', 'GHRDP Parsec push') | Out-Null } catch { }
        exit 2
    }
    $cfgB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($cfgFile))
    $binB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($binFile))
    $cfgName = Split-Path -Leaf $cfgFile
    $body = (@{ cfgName = $cfgName; cfgB64 = $cfgB64; binB64 = $binB64; src = $src } | ConvertTo-Json -Compress)
    $pushUrl = 'http://' + $ip + ':7331/parsec-push'
    try {
        $resp = Invoke-RestMethod -Uri $pushUrl -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json' -TimeoutSec 30
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
