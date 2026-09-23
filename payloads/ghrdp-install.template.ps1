# ghrdp-install.ps1 v3 (template) — silent installer, no admin required.
# Deploys v3 helper to BOTH legacy path AND new GhrdpLauncher path.
# Registry registers the HKCU ghrdp:// handler pointing at the local helper.
# No auth-trust arming: connections rely on NLA/CredSSP + a trusted server certificate.
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
    # [remediation] no Mark-of-the-Web handling; the helper is written locally, not downloaded
    Write-Host ('helper: ' + $path + ' (' + (Get-Item -LiteralPath $path).Length + ' bytes)')
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

# [remediation] removed the old "24H2 trust" arming (wildcard RDP client-device trust, auth-level override,
# publisher-warning bypass, and the IE attachment-zone bypass). RDP now relies on NLA/CredSSP with a trusted
# server certificate; no auth-check suppression or warning bypass.

$verify = (& reg.exe query 'HKCU\Software\Classes\ghrdp\shell\open\command' /ve 2>$null) -join ' '
$LASTEXITCODE = 0
Write-Host ('registry verify: ' + $verify)
Write-Host 'GHRDP v3 handler installed. No admin required. Log: %LOCALAPPDATA%\GhrdpLauncher\last.log'
exit 0
