#Requires -Version 7.0
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Provision a permanent Windows RDP host, never an ephemeral runner.
.DESCRIPTION
    Creates only the static local account rdpuser. Joins Tailscale, pins the
    MagicDNS FQDN, binds its Tailscale LE certificate, requires NLA/CredSSP
    and TLS, and permits inbound TCP/3389 only from 100.64.0.0/10 on the
    Tailscale interface. This script does not install a browser gateway or
    start the dashboard. Run from the VPS console, not over active RDP:
    TermService is restarted after binding a renewed certificate.
    Password entry is interactive; no password is copied into config or argv.
.PARAMETER TailscaleHostname
    Desired Tailscale node name (default ghrdp-vps).
.EXAMPLE
    pwsh -File .\payloads\Provision-GhrdpVps.ps1
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9-]{1,63}$')]
    [string]$TailscaleHostname = 'ghrdp-vps'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$TargetUser = 'rdpuser'
$Root = 'C:\ghrdp'
$rdpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$enc = [System.Text.UTF8Encoding]::new($false)
$fqdnPattern = '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$'

function Protect-Path([string]$Path, [bool]$Directory = $false) {
    # No inherited Users access to dashboard secrets on a persistent VPS.
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $sddl = if ($Directory) { 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' }
            else { 'D:P(A;;FA;;;SY)(A;;FA;;;BA)' }
    $acl.SetSecurityDescriptorSddlForm($sddl)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}
function Read-TailscaleState {
    try {
        $raw = & tailscale status --json 2>$null
        if ($LASTEXITCODE -eq 0 -and $raw) { return ($raw | ConvertFrom-Json -ErrorAction Stop) }
    } catch { }
    return $null
}

# ---- 1. Preflight ------------------------------------------------------------
$os = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption
if ($os -notmatch 'Windows (10|11|Server)' -or $os -match 'Windows (10|11) Home') {
    throw "Windows Pro or Server required: $os"
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue) -and
    -not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    throw 'Install Tailscale manually; winget and tailscale are both unavailable.'
}
$certScript = Join-Path $PSScriptRoot 'Enable-RdpTlsCertificate.ps1'
if (-not (Test-Path -LiteralPath $certScript)) { throw 'Enable-RdpTlsCertificate.ps1 must be alongside this script.' }
Write-Host '[preflight] permanent host, elevated PowerShell 7, certificate helper present'

# ---- 2. Join tailnet without putting the auth key in process arguments ------
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    & winget install --silent --accept-source-agreements --accept-package-agreements --id Tailscale.Tailscale
    if ($LASTEXITCODE -ne 0) { throw 'winget install Tailscale failed.' }
    $tsPath = Join-Path $env:ProgramFiles 'Tailscale'
    if (Test-Path -LiteralPath $tsPath) { $env:Path = "$env:Path;$tsPath" }
}
$state = Read-TailscaleState
if (-not $state -or $state.BackendState -ne 'Running') {
    if ($env:TS_AUTHKEY) {
        $keyFile = New-TemporaryFile
        try {
            Protect-Path -Path $keyFile.FullName
            [System.IO.File]::WriteAllText($keyFile.FullName, $env:TS_AUTHKEY, $enc)
            & tailscale up --auth-key ("file:" + $keyFile.FullName) --hostname $TailscaleHostname --accept-dns=true --accept-routes=false
            if ($LASTEXITCODE -ne 0) { throw 'tailscale up failed; check tailnet key and node approval.' }
        } finally {
            Remove-Item -LiteralPath $keyFile.FullName -Force -ErrorAction SilentlyContinue
        }
    } else {
        & tailscale up --hostname $TailscaleHostname --accept-dns=true --accept-routes=false
        if ($LASTEXITCODE -ne 0) { throw 'tailscale up failed; complete interactive tailnet authorization.' }
    }
}
# Absorb transient CLI/DNS blips following tailscale up (10 reads, ~50 s).
for ($attempt = 1; $attempt -le 10; $attempt++) {
    $state = Read-TailscaleState
    if ($state -and $state.BackendState -eq 'Running' -and
        ([string]$state.Self.DNSName).TrimEnd('.') -match $fqdnPattern) { break }
    if ($attempt -lt 10) { Start-Sleep -Seconds 5 }
}
if (-not $state -or $state.BackendState -ne 'Running') { throw 'Tailscale did not become connected.' }
$fqdn = ([string]$state.Self.DNSName).TrimEnd('.')
if ($fqdn -notmatch $fqdnPattern) {
    throw 'MagicDNS is required: enable it at https://login.tailscale.com/admin/dns and re-run.'
}
$tsIp = ''
foreach ($addr in @($state.Self.TailscaleIPs)) {
    $parsed = $null
    if ([System.Net.IPAddress]::TryParse([string]$addr, [ref]$parsed)) {
        $parts = $parsed.GetAddressBytes()
        if ($parts.Length -eq 4 -and $parts[0] -eq 100 -and $parts[1] -ge 64 -and $parts[1] -le 127) {
            $tsIp = [string]$addr; break
        }
    }
}
if (-not $tsIp) { throw 'No 100.64.0.0/10 Tailscale IPv4 address; RDP firewall will not be opened.' }
Write-Host "[tailscale] FQDN=$fqdn, private IP=$tsIp"

# ---- 3. Static local account; only the user supplies its password -----------
$localUser = Get-LocalUser -Name $TargetUser -ErrorAction SilentlyContinue
if (-not $localUser) {
    $pw = Read-Host -Prompt "Choose a new password for local $TargetUser" -AsSecureString
    try {
        New-LocalUser -Name $TargetUser -Password $pw -FullName $TargetUser -AccountNeverExpires | Out-Null
    } finally { Remove-Variable pw -ErrorAction SilentlyContinue }
} elseif (-not $localUser.Enabled) {
    Enable-LocalUser -Name $TargetUser -ErrorAction Stop
}
$rdpGroup = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-555')).Translate(
    [System.Security.Principal.NTAccount]).Value.Split('\')[-1]
if (-not (Get-LocalGroupMember -Group $rdpGroup -Member $TargetUser -ErrorAction SilentlyContinue)) {
    Add-LocalGroupMember -Group $rdpGroup -Member $TargetUser
}
Write-Host "[user] static local $TargetUser ready for RDP"

# ---- 4. NLA enforces CredSSP; TLS-only security layer, no client overrides --
Set-ItemProperty -Path $rdpKey -Name UserAuthentication -Value 1 -Type DWord
Set-ItemProperty -Path $rdpKey -Name SecurityLayer -Value 2 -Type DWord
if ((Get-ItemProperty -Path $rdpKey -Name UserAuthentication).UserAuthentication -ne 1 -or
    (Get-ItemProperty -Path $rdpKey -Name SecurityLayer).SecurityLayer -ne 2) {
    throw 'NLA/CredSSP or TLS-only listener policy could not be enforced.'
}

# ---- 5. Acquire and bind the cert for EXACTLY this node's MagicDNS FQDN ----
& $certScript -Fqdn $fqdn
if (-not $?) { throw 'Tailscale certificate binding failed.' }

# ---- 6. Host firewall: IPv4 tailnet source AND Tailscale destination only ---
$tsNic = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -eq $tsIp -and $_.InterfaceAlias -match '^Tailscale' } |
    Select-Object -First 1
if (-not $tsNic) { throw 'Tailscale IPv4 interface not found; refusing to open TCP/3389.' }
$tsAlias = [string]$tsNic.InterfaceAlias
Get-NetFirewallRule -DisplayName 'Remote Desktop*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Direction -eq 'Inbound' } |
    Set-NetFirewallRule -Enabled False -ErrorAction Stop
Get-NetFirewallRule -DisplayName 'GHRDP-RDP-Tailnet' -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction Stop
$other3389 = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction Stop |
    Where-Object {
        $rule = $_
        $ports = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
        @($ports | Where-Object { [string]$_.Protocol -in @('TCP','6','Any') -and @($_.LocalPort) -contains '3389' }).Count -gt 0
    })
if ($other3389.Count) { throw 'Another inbound TCP/3389 allow rule remains; remove it before provisioning RDP.' }
New-NetFirewallRule -Name 'GHRDP-RDP-Tailnet' -DisplayName 'GHRDP-RDP-Tailnet' -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 3389 -LocalAddress $tsIp `
    -RemoteAddress '100.64.0.0/10' -InterfaceAlias $tsAlias -Profile Any | Out-Null
$allow = Get-NetFirewallRule -Name 'GHRDP-RDP-Tailnet' -ErrorAction Stop
$remote = @($allow | Get-NetFirewallAddressFilter).RemoteAddress
$port = @($allow | Get-NetFirewallPortFilter).LocalPort
$iface = @($allow | Get-NetFirewallInterfaceFilter).InterfaceAlias
if ([string]$allow.Enabled -ne 'True' -or $remote -notcontains '100.64.0.0/10' -or
    $port -notcontains '3389' -or $iface -notcontains $tsAlias) {
    throw 'Tailnet-only firewall verification failed; do not expose public TCP/3389.'
}
# For NEW hosts RDP opens only after the certificate and scoped firewall exist.
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0 -Type DWord
Restart-Service -Name TermService -Force -ErrorAction Stop
if ((Get-Service -Name TermService).Status -ne 'Running') { throw 'TermService did not restart after certificate binding.' }
if ((Get-ItemProperty -Path $rdpKey -Name UserAuthentication).UserAuthentication -ne 1 -or
    (Get-ItemProperty -Path $rdpKey -Name SecurityLayer).SecurityLayer -ne 2) {
    throw 'Listener policy changed after TermService restart.'
}

# ---- 7. Persist VPS identity + DNS in config; no RDP password is stored ----
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Protect-Path -Path $Root -Directory $true
$tokenPath = Join-Path $Root 'dash-token.txt'
if (Test-Path -LiteralPath $tokenPath) {
    Protect-Path -Path $tokenPath
    $dashToken = [System.IO.File]::ReadAllText($tokenPath).Trim()
    if ($dashToken -notmatch '^[a-zA-Z0-9_-]{32,128}$') { throw 'Existing dash-token.txt is missing/weak; rotate it locally before proceeding.' }
} else {
    $dashToken = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    [System.IO.File]::WriteAllText($tokenPath, $dashToken, $enc)
    Protect-Path -Path $tokenPath
}
$cfgPath = Join-Path $Root 'config.json'
if (Test-Path -LiteralPath $cfgPath) {
    Protect-Path -Path $cfgPath
    $cfg = [System.IO.File]::ReadAllText($cfgPath) | ConvertFrom-Json -ErrorAction Stop
} else { $cfg = [pscustomobject]@{} }
foreach ($secret in @('rdpPass','mirrorKey','legacyDecryptKey','rentryEditCode','rentryEditCookie')) {
    if ($cfg.PSObject.Properties[$secret]) { $cfg.PSObject.Properties.Remove($secret) }
}
foreach ($item in @{
    hostKind = 'vps'; dnsName = $fqdn; rdpIp = $tsIp; rdpUser = $TargetUser;
    dashToken = $dashToken; mirror = $false
}.GetEnumerator()) {
    $cfg | Add-Member -NotePropertyName $item.Key -NotePropertyValue $item.Value -Force
}
if (-not $cfg.PSObject.Properties['webdeskUrl']) { $cfg | Add-Member -NotePropertyName webdeskUrl -NotePropertyValue '' }
if (-not $cfg.webdeskUrl) { $cfg | Add-Member -NotePropertyName webdeskReason -NotePropertyValue 'step-not-run' -Force }
$tmpCfg = Join-Path $Root ('config-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    [System.IO.File]::WriteAllText($tmpCfg, ($cfg | ConvertTo-Json -Depth 10), $enc)
    Protect-Path -Path $tmpCfg
    [System.IO.File]::Move($tmpCfg, $cfgPath, $true)
} finally { Remove-Item -LiteralPath $tmpCfg -Force -ErrorAction SilentlyContinue }
[System.IO.File]::WriteAllText((Join-Path $Root 'hostKind.txt'), "vps`r`n", $enc)
Protect-Path -Path (Join-Path $Root 'hostKind.txt')

Write-Host "PROVISIONING OK: fqdn=$fqdn; NLA=1; TLS-only; cert bound; RDP ingress $tsIp from 100.64.0.0/10 only."
Write-Host "Run on YOUR client once: cmdkey /generic:TERMSRV/$fqdn /user:$TargetUser (password typed at the prompt)."
Write-Host "Fallback: mstsc /v:$fqdn. Store the dashboard token from $tokenPath in a password manager using a private channel."
Write-Host 'No WEB DESKTOP or dashboard service was installed here; configure/verify those separately before decommissioning Actions.'
