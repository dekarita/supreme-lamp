[CmdletBinding()]
param([string]$Root = '.')
$ErrorActionPreference = 'Stop'
$bad = $false
$files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.ps1' | Where-Object { $_.FullName -notmatch '[\\/](\.git|node_modules)[\\/]' })
if ($files.Count -eq 0) { throw 'D0 FAIL: no PowerShell files found.' }
foreach ($file in $files) {
    $text = [IO.File]::ReadAllText($file.FullName)
    $errors = $null
    [void][System.Management.Automation.PSParser]::Tokenize($text, [ref]$errors)
    $tokens = $null
    $astErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$astErrors)
    foreach ($err in @($errors) + @($astErrors)) {
        if ($null -ne $err) { $bad = $true; Write-Host ('D0 ERROR file=' + $file.Name + ' ' + $err.Message) }
    }
    $sha = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ('D0 FILE ' + $file.Name + ' sha256=' + $sha + ' size=' + $file.Length)
}
if ($bad) { Write-Host 'D0 FAIL'; exit 1 }
Write-Host ('D0 PASS parsed=' + $files.Count + ' PS=' + $PSVersionTable.PSVersion)
exit 0
