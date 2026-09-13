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
$port = '7331'
if ($Url -match 'port=(\d+)') { $port = $Matches[1] }
if ($Url -match 'mode=parsec' -or $Url -match 'parsec-push') {
    Write-ConnLog 'parsec-push mode: locating local Parsec session files'
    $cands = @((Join-Path $env:APPDATA 'Parsec'), (Join-Path $env:LOCALAPPDATA 'Parsec'), 'C:\ProgramData\Parsec')
    $src = $null; $cfgName = $null
    foreach ($c in $cands) {
        if (Test-Path -LiteralPath (Join-Path $c 'user.bin')) {
            if (Test-Path -LiteralPath (Join-Path $c 'config.txt')) { $cfgName = 'config.txt' }
            elseif (Test-Path -LiteralPath (Join-Path $c 'config.json')) { $cfgName = 'config.json' }
            if ($cfgName) { $src = $c; break }
        }
    }
    if (-not $src) {
        Write-ConnLog 'ERROR: no local Parsec session (user.bin + config) found'
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Parsec session not found on this PC. Log in to Parsec here first, then retry.', 'GHRDP Parsec push') | Out-Null } catch { }
        exit 2
    }
    $cfgB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $src $cfgName)))
    $userB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $src 'user.bin')))
    $body = (@{ configName = $cfgName; configB64 = $cfgB64; userB64 = $userB64; host = $env:COMPUTERNAME } | ConvertTo-Json -Compress)
    try {
        $resp = Invoke-RestMethod -Uri ('http://' + $ip + ':' + $port + '/parsec-session') -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 90
        Write-ConnLog ('parsec push OK: ' + ($resp | ConvertTo-Json -Compress))
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(('Parsec session pushed to runner OK.' + [Environment]::NewLine + [string]$resp.message), 'GHRDP Parsec push') | Out-Null } catch { }
    } catch {
        Write-ConnLog ('parsec push FAILED: ' + $_.Exception.Message)
        try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(('Parsec push failed: ' + $_.Exception.Message), 'GHRDP Parsec push') | Out-Null } catch { }
        exit 3
    }
    exit 0
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
