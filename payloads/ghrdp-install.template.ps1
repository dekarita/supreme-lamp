$ErrorActionPreference = 'Continue'
$dir = Join-Path $env:LOCALAPPDATA 'ghrdp'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$helper = Join-Path $dir 'ghrdp-connect.ps1'
$b64 = '__HELPER_B64__'
try {
    $bytes = [Convert]::FromBase64String($b64)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    [System.IO.File]::WriteAllText($helper, $text, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    Write-Host ('ERROR: could not decode the embedded helper: ' + $_.Exception.Message)
    exit 1
}
if (-not (Test-Path -LiteralPath $helper)) {
    Write-Host 'ERROR: helper file was not written'
    exit 1
}
Write-Host ('helper installed: ' + $helper + ' (' + (Get-Item -LiteralPath $helper).Length + ' bytes)')
$host2 = 'powershell.exe'
try { $c = Get-Command pwsh.exe -ErrorAction Stop; if ($c) { $host2 = $c.Source } } catch { }
$cmd = ('"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Url "%1"' -f $host2, $helper)
$cls = 'HKCU:\Software\Classes\ghrdp'
New-Item -Path $cls -Force | Out-Null
Set-ItemProperty -Path $cls -Name '(default)' -Value 'URL:GHRDP Protocol'
Set-ItemProperty -Path $cls -Name 'URL Protocol' -Value ''
New-Item -Path ($cls + '\DefaultIcon') -Force | Out-Null
Set-ItemProperty -Path ($cls + '\DefaultIcon') -Name '(default)' -Value 'mstsc.exe,0'
New-Item -Path ($cls + '\shell\open\command') -Force | Out-Null
Set-ItemProperty -Path ($cls + '\shell\open\command') -Name '(default)' -Value $cmd
$verify = (& reg.exe query 'HKCU\Software\Classes\ghrdp' /ve 2>$null) -join ' '
$LASTEXITCODE = 0
Write-Host ('registry verification: ' + $verify)
Write-Host 'ghrdp:// protocol installed for the current user.'
exit 0
