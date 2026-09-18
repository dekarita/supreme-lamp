# ghrdp-launch.ps1 — protocol handler for ghrdp:// URLs
# Fetches RDP creds via single-use token, stores with cmdkey, launches mstsc
param([string]$Url)

$logDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'ghrdp-connect.log'

function Write-Log {
    param([string]$Msg)
    try { [System.IO.File]::AppendAllText($logFile, ('[{0}] {1}{2}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Msg, "`r`n")) } catch { }
}

Write-Log ('invoked: ' + $Url)

$raw = $Url -replace '^ghrdp://?', ''
$params = @{}
foreach ($kv in ($raw -split '&')) {
    $eq = $kv.IndexOf('=')
    if ($eq -gt 0) {
        $params[[uri]::UnescapeDataString($kv.Substring(0, $eq))] = [uri]::UnescapeDataString($kv.Substring($eq + 1))
    }
}

$server = $params['server']
$port = if ($params['port']) { $params['port'] } else { '7331' }
$token = $params['token']

if (-not $server -or -not $token) {
    Write-Log 'ERROR: missing server or token in URL'
    exit 1
}

$uri = ('http://{0}:{1}/api/rdp-creds?token={2}' -f $server, $port, [uri]::EscapeDataString($token))
Write-Log ('fetching creds: ' + $uri)

$creds = $null
try {
    $creds = Invoke-RestMethod -Uri $uri -TimeoutSec 10 -ErrorAction Stop
} catch {
    Write-Log ('ERROR: cred fetch failed: ' + $_.Exception.Message)
    exit 2
}

if (-not $creds -or -not $creds.host -or -not $creds.user) {
    Write-Log 'ERROR: invalid creds response'
    exit 3
}

$rdpHost = [string]$creds.host
$rdpUser = [string]$creds.user
$rdpPass = [string]$creds.pass

Write-Log ('creds OK: ' + $rdpUser + '@' + $rdpHost)

$target = 'TERMSRV/' + $rdpHost
& cmdkey /generic:$target /user:$rdpUser /pass:$rdpPass >$null 2>&1
Write-Log ('cmdkey stored: ' + $target)

$clip = ($params['clip'] -eq '1')
$mic = ($params['mic'] -eq '1')
$prn = ($params['print'] -eq '1')
$drv = ($params['drives'] -eq '1')

$rdpFile = Join-Path $logDir ('ghrdp-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.rdp')
$lines = @(
    ('full address:s:' + $rdpHost)
    ('username:s:' + $rdpUser)
    'screen mode id:i:2'
    'desktopwidth:i:1920'
    'desktopheight:i:1080'
    'session bpp:i:32'
    'compression:i:1'
    'keyboardhook:i:2'
    'audiomode:i:0'
    ('audiocapturemode:i:' + $(if ($mic) { '1' } else { '0' }))
    'videoplaybackmode:i:1'
    'connection type:i:7'
    'networkautodetect:i:1'
    'bandwidthautodetect:i:1'
    'displayconnectionbar:i:1'
    'disable wallpaper:i:0'
    'allow font smoothing:i:1'
    'allow desktop composition:i:1'
    'disable full window drag:i:0'
    'disable menu anims:i:0'
    'disable themes:i:0'
    'disable cursor setting:i:0'
    'bitmapcachepersistenable:i:1'
    'autoreconnection enabled:i:1'
    'authentication level:i:0'
    'prompt for credentials:i:0'
    'negotiate security layer:i:1'
    ('redirectclipboard:i:' + $(if ($clip) { '1' } else { '0' }))
    ('redirectprinters:i:' + $(if ($prn) { '1' } else { '0' }))
    ('drivestoredirect:s:' + $(if ($drv) { '*' } else { '' }))
)

[System.IO.File]::WriteAllText($rdpFile, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Log ('rdp file: ' + $rdpFile)

Start-Process 'mstsc.exe' -ArgumentList ('"' + $rdpFile + '"')
Write-Log 'mstsc launched'

Start-Job -ScriptBlock {
    param($f, $t, $l)
    Start-Sleep -Seconds 15
    try { Remove-Item -LiteralPath $f -Force } catch { }
    & cmdkey /delete:$t >$null 2>&1
    try { [System.IO.File]::AppendAllText($l, ('[{0}] cleanup: rdp+cmdkey removed{1}' -f (Get-Date -Format 'HH:mm:ss.fff'), "`r`n")) } catch { }
} -ArgumentList $rdpFile, $target, $logFile | Out-Null

Write-Log 'cleanup scheduled (15s)'
