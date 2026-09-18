# ghrdp-install.ps1 v3 (template) — silent installer, no admin required.
# Deploys v3 helper to BOTH legacy path AND new GhrdpLauncher path.
# Registry re-registers HKCU handler with -WindowStyle Hidden.
# Arms 24H2 trust registry keys so mstsc never prompts.
$ErrorActionPreference = 'Continue'

# Kill stuck mstsc / old helper processes
Get-Process mstsc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'GHRDP' -or $_.Id -ne $PID } | Where-Object { $_.Path -and ((Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine -match 'ghrdp-connect') } | Stop-Process -Force -ErrorAction SilentlyContinue

# Decode embedded v3 helper
$b64 = '__HELPER_B64__'
try {
    $bytes = [Convert]::FromBase64String($b64)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
} catch {
    Write-Host ('FATAL: could not decode embedded helper: ' + $_.Exception.Message)
    exit 1
}

# Write to BOTH the legacy path and the v3 path (so all registry variants work)
$oldDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
$oldHelper = Join-Path $oldDir 'ghrdp-connect.ps1'
$newDir = Join-Path $env:LOCALAPPDATA 'GhrdpLauncher'
$newHelper = Join-Path $newDir 'launch.ps1'
$noBom = New-Object System.Text.UTF8Encoding($false)

foreach ($tuple in @(@($oldDir, $oldHelper), @($newDir, $newHelper))) {
    $dir = $tuple[0]; $path = $tuple[1]
    New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null
    [System.IO.File]::WriteAllText($path, $text, $noBom)
    try { Unblock-File -Path $path -ErrorAction SilentlyContinue } catch { }
    Write-Host ('v3 helper: ' + $path + ' (' + (Get-Item -LiteralPath $path).Length + ' bytes)')
}

# Registry: point ghrdp:// at the NEW path with -WindowStyle Hidden
$host2 = 'powershell.exe'
try { $c = Get-Command pwsh.exe -ErrorAction Stop; if ($c) { $host2 = $c.Source } } catch { }
$cmd = ('"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Url "%1"' -f $host2, $newHelper)
$cls = 'HKCU:\Software\Classes\ghrdp'
New-Item -Path $cls -Force | Out-Null
Set-ItemProperty -Path $cls -Name '(default)' -Value 'URL:GHRDP Protocol'
Set-ItemProperty -Path $cls -Name 'URL Protocol' -Value ''
New-Item -Path ($cls + '\DefaultIcon') -Force | Out-Null
Set-ItemProperty -Path ($cls + '\DefaultIcon') -Name '(default)' -Value 'mstsc.exe,0'
New-Item -Path ($cls + '\shell\open\command') -Force | Out-Null
Set-ItemProperty -Path ($cls + '\shell\open\command') -Name '(default)' -Value $cmd

# Arm 24H2 trust: LocalDevices per-host trust + Zone 3 attachment bypass + auth override
try {
    $ld = 'HKCU:\Software\Microsoft\Terminal Server Client\LocalDevices'
    if (-not (Test-Path $ld)) { New-Item -Path $ld -Force | Out-Null }
    # Wildcard host = every RDP target (0xC5 = local devices + drives + printers + audio + serial)
    Set-ItemProperty -Path $ld -Name '*' -Value 0xC5 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Terminal Server Client' -Name 'AuthenticationLevelOverride' -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Terminal Server Client' -Name 'PublisherBypass' -Value 1 -Type DWord -ErrorAction SilentlyContinue
    $z3 = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\3'
    if (-not (Test-Path $z3)) { New-Item -Path $z3 -Force | Out-Null }
    Set-ItemProperty -Path $z3 -Name '1806' -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Write-Host 'trust keys armed (LocalDevices\*=0xC5, AuthLevelOverride=0, Zone3\1806=0)'
} catch { Write-Host ('trust key arm failed: ' + $_.Exception.Message) }

$verify = (& reg.exe query 'HKCU\Software\Classes\ghrdp\shell\open\command' /ve 2>$null) -join ' '
$LASTEXITCODE = 0
Write-Host ('registry verify: ' + $verify)
Write-Host 'GHRDP v3 handler installed. No admin required. Log: %LOCALAPPDATA%\GhrdpLauncher\last.log'
exit 0
