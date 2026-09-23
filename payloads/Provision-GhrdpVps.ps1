#requires -Version 7.0
#requires -RunAsAdministrator
<#
.SYNOPSIS
    Idempotent one-shot bootstrap for a permanent GHRDP VPS (native mstsc target).
.DESCRIPTION
    Locked architecture (see docs/MIGRATION.md, §3 STATE.md, and NLA discipline):
      NLA ON (UserAuthentication=1); no AuthenticationLevelOverride; no
      fPromptForPassword=0; no `authentication level:i:0|3` client RDP suppressant;
      no credential stashing / no plaintext creds on any command line; no MOTW /
      SmartScreen bypass; no publisher-trust arming; no anti-forensics.

    Steps (all safe to re-run):
      1. Preflight (OS, admin, PS7).
      2. Install Tailscale (winget), join tailnet (interactive OR $env:TS_AUTHKEY).
      3. Resolve MagicDNS FQDN; fail-hard if not *.ts.net.
      4. Create local `rdpuser` (interactive password only via Read-Host -AsSecureString).
      5. Enable RDP + NLA=1.
      6. Delegate to sibling Enable-RdpTlsCertificate.ps1 for LE cert bind.
      7. Firewall: allow TCP/3389 on Tailscale interface only; disable default
         'Remote Desktop' inbound rules that expose the port broadly.
      8. Verify NLA + emit client-side one-time cmdkey line to stdout.
.PARAMETER TargetUser
    Local account created and granted RDP. Default: rdpuser. Password is prompted
    interactively; never accepted on the command line.
.PARAMETER TailscaleHostname
    Hostname advertised to tailnet. Default: ghrdp-vps.
.EXAMPLE
    # Interactive tailnet auth + interactive password:
    pwsh -ExecutionPolicy Bypass -File .\payloads\Provision-GhrdpVps.ps1

    # Unattended tailnet auth (still interactive password):
    $env:TS_AUTHKEY = 'tskey-auth-...'; .\payloads\Provision-GhrdpVps.ps1
.NOTES
    Re-run after LE renewal (~90d) to re-bind fresh cert via Enable-RdpTlsCertificate.ps1.
#>

[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9_-]{3,20}$')]
    [string]$TargetUser = 'rdpuser',
    [ValidatePattern('^[a-zA-Z0-9-]{1,63}$')]
    [string]$TailscaleHostname = 'ghrdp-vps'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---- 1. Preflight -------------------------------------------------------------
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7+ required.' }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Must run as Administrator.'
}
$os = (Get-CimInstance Win32_OperatingSystem).Caption
if ($os -notmatch 'Windows (10|11|Server)') { throw "Unsupported OS: $os" }
Write-Host "[preflight] OS=$os, PS=$($PSVersionTable.PSVersion), admin=OK"

# ---- 2. Install / verify Tailscale -------------------------------------------
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    Write-Host '[tailscale] installing via winget...'
    & winget install --silent --accept-source-agreements --accept-package-agreements --id Tailscale.Tailscale
    if ($LASTEXITCODE -ne 0) { throw "winget install Tailscale failed (exit $LASTEXITCODE)." }
    $tsPath = "$env:ProgramFiles\Tailscale"
    if (Test-Path $tsPath) { $env:Path = "$env:Path;$tsPath" }
}
$state = & tailscale status --json 2>$null | ConvertFrom-Json
if (-not $state -or $state.BackendState -ne 'Running') {
    if ($env:TS_AUTHKEY) {
        Write-Host '[tailscale] joining tailnet via $env:TS_AUTHKEY...'
        & tailscale up --authkey $env:TS_AUTHKEY --hostname $TailscaleHostname --accept-dns=false --accept-routes=false
    } else {
        Write-Host '[tailscale] interactive auth (browser prompt will open)...'
        & tailscale up --hostname $TailscaleHostname --accept-dns=false --accept-routes=false
    }
    if ($LASTEXITCODE -ne 0) { throw "tailscale up failed (exit $LASTEXITCODE)." }
    $state = & tailscale status --json | ConvertFrom-Json
}

# ---- 3. Resolve MagicDNS FQDN (fail-hard on non-.ts.net) ---------------------
$fqdn = $state.Self.DNSName
if ($fqdn) { $fqdn = $fqdn.TrimEnd('.') }
if (-not $fqdn -or $fqdn -notmatch '\.ts\.net$') { throw "MagicDNS FQDN unavailable or not *.ts.net: '$fqdn'. Enable HTTPS in tailnet admin (DNS -> Enable HTTPS)." }
Write-Host "[tailscale] FQDN=$fqdn"

# ---- 4. Create local RDP user (interactive password only) --------------------
if (-not (Get-LocalUser -Name $TargetUser -ErrorAction SilentlyContinue)) {
    Write-Host "[user] creating local account '$TargetUser'..."
    $pw = Read-Host -Prompt "Password for '$TargetUser' (typed once, not logged, not stored anywhere)" -AsSecureString
    New-LocalUser -Name $TargetUser -Password $pw -FullName $TargetUser -Description 'GHRDP interactive RDP user (created by Provision-GhrdpVps.ps1)' -AccountNeverExpires | Out-Null
    Remove-Variable pw
    [System.GC]::Collect()
}
if (-not (Get-LocalGroupMember -Group 'Remote Desktop Users' -Member $TargetUser -ErrorAction SilentlyContinue)) {
    Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $TargetUser
}
Write-Host "[user] $TargetUser ready in 'Remote Desktop Users'"

# ---- 5. Enable RDP + NLA (locked-arch discipline) ----------------------------
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0 -Type DWord
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 1 -Type DWord
# Explicit non-actions per locked architecture:
#   - Do NOT set fPromptForPassword=0.
#   - Do NOT set HKCU:\...\AuthenticationLevelOverride.
#   - Do NOT touch MOTW, Zone.Identifier, publisher-trust, LocalDevices arming.
Write-Host '[rdp] fDenyTSConnections=0, UserAuthentication=1 (NLA ON)'

# ---- 6. Bind Tailscale LE cert to RDP-Tcp listener ---------------------------
$certScript = Join-Path $PSScriptRoot 'Enable-RdpTlsCertificate.ps1'
if (-not (Test-Path $certScript)) { throw "Sibling script missing: $certScript" }
Write-Host "[cert] delegating to $certScript ..."
& $certScript
if ($LASTEXITCODE -ne 0) { throw "Enable-RdpTlsCertificate.ps1 failed (exit $LASTEXITCODE)." }

# ---- 7. Firewall: tailnet-only on 3389 ---------------------------------------
$tsAlias = (Get-NetIPInterface -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -match '^Tailscale' } | Select-Object -First 1).InterfaceAlias
if (-not $tsAlias) { throw 'Tailscale interface not found; is tailscaled running?' }
if (-not (Get-NetFirewallRule -DisplayName 'GHRDP-RDP-Tailnet' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'GHRDP-RDP-Tailnet' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 -InterfaceAlias $tsAlias -Profile Any | Out-Null
    Write-Host "[fw] created inbound allow: TCP/3389 on $tsAlias"
}
Get-NetFirewallRule -DisplayName 'Remote Desktop*' -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' -and $_.DisplayName -ne 'GHRDP-RDP-Tailnet' } | ForEach-Object {
    Set-NetFirewallRule -Name $_.Name -Enabled False
    Write-Host "[fw] disabled default rule '$($_.DisplayName)'"
}

# ---- 8. Verify & emit client-side one-time cmdkey line -----------------------
$ua = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication).UserAuthentication
if ($ua -ne 1) { throw "NLA verification failed: UserAuthentication=$ua" }
Restart-Service -Name TermService -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "PROVISIONING OK -- fqdn=$fqdn, user=$TargetUser, NLA=1, cert bound, firewall tailnet-only."
Write-Host ''
Write-Host 'CLIENT ONE-TIME SETUP (run on your workstation, ONCE, interactively):'
Write-Host "    cmdkey /generic:TERMSRV/$fqdn /user:$TargetUser"
Write-Host '  cmdkey will prompt for the password interactively. Do NOT use /pass:'
Write-Host '  on the command line -- plaintext would land in wmic/ETW/EDR.'
Write-Host ''
Write-Host "Then: mstsc /v:$fqdn        (zero prompts, zero warnings, NLA + CredSSP)."
