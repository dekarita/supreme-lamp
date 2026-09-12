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
$proc = $null
try {
    $proc = Start-Process mstsc.exe -ArgumentList "/v:$ip" -PassThru
    Write-ConnLog ('mstsc started pid=' + $proc.Id)
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
