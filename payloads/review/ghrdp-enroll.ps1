[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Server)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'E0-input'
$dir = Join-Path $env:LOCALAPPDATA 'GhrdpAgent'
$local = Join-Path $dir 'agent.ps1'
$tmp = Join-Path $dir ('agent-' + [guid]::NewGuid().ToString('N') + '.new')
$log = Join-Path $dir 'enroll.log'
$base = ''
function Note([string]$text) {
    Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' [BOOTSTRAP] ' + $text)
}
function Safe-Tail([string]$path) {
    if (Test-Path -LiteralPath $path) {
        Get-Content -LiteralPath $path -Tail 40 | ForEach-Object {
            $s = [string]$_
            $s = $s -replace '(?i)([?&](?:dt|key|token|t|pass|password|p)=)[^\s&]+', '$1[REDACTED]'
            $s = $s -replace '(?i)("(?:dt|deviceToken|dashToken|pass|password)"\s*:\s*")[^"]*', '$1[REDACTED]'
            $s = $s -replace '(?i)(/pass:)[^\s]+', '$1[REDACTED]'
            Write-Host $s
        }
    } else { Write-Host '(missing)' }
}
function Http-Matrix {
    foreach ($path in @('/api/ping', '/api/agent-hash', '/api/agent.ps1', '/api/enroll.ps1', '/api/diag.ps1', '/api/acceptance.ps1', '/api/accept.ps1', '/api/agent-status?probe=1')) {
        try {
            $r = Invoke-WebRequest -Uri ($base + $path) -UseBasicParsing -TimeoutSec 2
            Write-Host ('GET ' + $path + ' => ' + [int]$r.StatusCode)
        } catch {
            $code = 'transport-error'
            if ($_.Exception.Response) { $code = [string][int]$_.Exception.Response.StatusCode }
            Write-Host ('GET ' + $path + ' => ' + $code)
        }
    }
    Write-Host 'POST-only routes not tested with HEAD or GET; D1 tests them with POST.'
}
try {
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($Server, [ref]$ip)) { throw 'Server must be a Tailscale IPv4 address.' }
    $b = $ip.GetAddressBytes()
    if ($b.Length -ne 4 -or $b[0] -ne 100 -or $b[1] -lt 64 -or $b[1] -gt 127) { throw 'Server is outside 100.64.0.0/10.' }
    $Server = $ip.ToString()
    $base = 'http://' + $Server + ':7331'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Note ('begin server=' + $Server)
    $stage = 'E0-download'
    $hash = Invoke-RestMethod -Uri ($base + '/api/agent-hash') -TimeoutSec 5
    Invoke-WebRequest -Uri ($base + '/api/agent.ps1') -UseBasicParsing -OutFile $tmp -TimeoutSec 15
    $stage = 'E1-remote-parse'
    $errors = $null
    $text = [IO.File]::ReadAllText($tmp)
    [void][System.Management.Automation.PSParser]::Tokenize($text, [ref]$errors)
    $tokens = $null
    $astErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$astErrors)
    if ([string]::IsNullOrWhiteSpace($text) -or @($errors).Count -gt 0 -or @($astErrors).Count -gt 0) {
        Note 'REMOTE UNPARSEABLE - keeping local'
        throw 'REMOTE UNPARSEABLE - keeping local'
    }
    $stage = 'E2-remote-hash'
    $sha = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $tmp).Length
    if ($hash.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $sha -ne [string]$hash.sha256 -or $size -ne [long]$hash.size) { throw 'Remote hash/size mismatch; keeping local.' }
    $again = Invoke-RestMethod -Uri ($base + '/api/agent-hash') -TimeoutSec 5
    if ($sha -ne [string]$again.sha256 -or $size -ne [long]$again.size) { throw 'Remote changed during enrollment; keeping local.' }
    $stage = 'E2-install'
    if (Test-Path -LiteralPath $local) {
        [IO.File]::Replace($tmp, $local, ($local + '.bak'), $true)
    } else { [IO.File]::Move($tmp, $local) }
    Unblock-File -LiteralPath $local
    Note ('installed sha256=' + $sha + ' size=' + $size)
    $sys = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $sys)) { throw 'System32 Windows PowerShell missing.' }
    $stage = 'D2-enroll-launch'
    $started = [DateTime]::UtcNow
    $argsLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + [char]34 + $local + [char]34 + ' -Enroll -Server ' + $Server
    $proc = Start-Process -FilePath $sys -ArgumentList $argsLine -WindowStyle Hidden -PassThru
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $ok = $false
    $device = $null
    $loopCount = 0
    $stage = 'D2-device-loop-probe'
    while ($watch.Elapsed.TotalSeconds -lt 20) {
        try {
            $devicePath = Join-Path $dir 'device.json'
            if (Test-Path -LiteralPath $devicePath) {
                $device = Get-Content -LiteralPath $devicePath -Raw | ConvertFrom-Json
                $fresh = [DateTime]::Parse([string]$device.enrolledAt).ToUniversalTime() -ge $started
                if ($fresh -and $device.deviceId -and $device.deviceToken) {
                    $remaining = [Math]::Floor(20 - $watch.Elapsed.TotalSeconds)
                    if ($remaining -lt 1) { break }
                    $probe = Invoke-RestMethod -Uri ($base + '/api/agent-status?probe=1') -TimeoutSec ([Math]::Min(2, $remaining))
                    $items = @($probe)
                    if ($probe.PSObject.Properties['devices']) { $items = @($probe.devices) }
                    $seen = @($items | Where-Object { $_.deviceId -eq $device.deviceId -and $_.seen -eq $true -and $null -ne $_.ageSeconds -and $_.ageSeconds -ge 0 -and $_.ageSeconds -le 20 }).Count -gt 0
                    $loopCount = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -OperationTimeoutSec 1 | Where-Object {
                        $_.CommandLine -and $_.CommandLine.Contains($local) -and $_.CommandLine -match '(?i)(?:^|\s)-(Loop|Poll)(?:\s|$)'
                    }).Count
                    if ($seen -and $loopCount -eq 1 -and $watch.Elapsed.TotalSeconds -le 20) { $ok = $true; break }
                }
            }
        } catch { }
        if ($watch.Elapsed.TotalSeconds -lt 19.75) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ok) { throw 'Fresh device + exactly one loop + fresh matching probe not confirmed within 20 seconds.' }
    Write-Host ('ENROLL PASS deviceId=' + $device.deviceId)
    Write-Host ('loopProcs=' + $loopCount + ' probe.seen=true sha256=' + $sha + ' size=' + $size)
    exit 0
} catch {
    Write-Host ('ENROLL FAIL stage=' + $stage) -ForegroundColor Red
    if (Test-Path -LiteralPath $dir) { try { Note ('FAIL stage=' + $stage) } catch { } }
    Write-Host '--- enroll.log tail 40 (secrets redacted) ---'
    Safe-Tail $log
    Write-Host '--- HTTP matrix ---'
    if ($base) { Http-Matrix } else { Write-Host '(invalid server; no network requests made)' }
    Write-Host '--- PSVersionTable ---'
    $PSVersionTable | Out-String | Write-Host
    exit 1
} finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
