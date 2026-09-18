[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Runner)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ip = $null
if (-not [Net.IPAddress]::TryParse($Runner, [ref]$ip)) { throw 'Enter the current runner Tailscale IPv4 address.' }
$b = $ip.GetAddressBytes()
if ($b.Length -ne 4 -or $b[0] -ne 100 -or $b[1] -lt 64 -or $b[1] -gt 127) { throw 'Runner must be in 100.64.0.0/10.' }
$Runner = $ip.ToString()
$base = 'http://' + $Runner + ':7331'
$secret = Read-Host 'Dashboard key (hidden; do not paste it into shared output)' -AsSecureString
$DashKey = (New-Object Net.NetworkCredential('', $secret)).Password
function Fetch-Checked([string]$endpoint, [string]$name) {
    $path = Join-Path (Get-Location).Path $name
    $tmp = $path + '.new'
    try {
        Invoke-WebRequest -Uri ($base + $endpoint + '?key=' + [uri]::EscapeDataString($DashKey)) -UseBasicParsing -OutFile $tmp -TimeoutSec 10
        $errors = $null
        $source = [IO.File]::ReadAllText($tmp)
        [void][System.Management.Automation.PSParser]::Tokenize($source, [ref]$errors)
        $tokens = $null
        $astErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$astErrors)
        if (-not $source.Trim() -or $source.TrimStart().StartsWith('<') -or @($errors).Count -gt 0 -or @($astErrors).Count -gt 0) { throw ('Remote diagnostic script rejected: ' + $name) }
        Copy-Item -LiteralPath $tmp -Destination $path -Force
        Unblock-File -LiteralPath $path
        Write-Host ('FETCH CHECKED ' + $name + ' sha256=' + (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() + ' size=' + (Get-Item -LiteralPath $path).Length)
    } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
try {
    Fetch-Checked '/api/diag.ps1' 'ghrdp-diag.ps1'
    & .\ghrdp-diag.ps1 -Runner $Runner
    Fetch-Checked '/api/acceptance.ps1' 'ghrdp-acceptance.ps1'
    & .\ghrdp-acceptance.ps1 -DashKey $DashKey -Runner $Runner
} finally { $DashKey = $null; $secret = $null }
# Supplied server diagnostics/acceptance sources are absent from the prompt.
# Their exit behavior and E1-E8 coverage MUST be audited before accepting their verdict.
