# Provision-BrowserPolicy.ps1 - [F10 s4] runner browser provisioning.
# Called by main.yml AND by the autologin lab so both run THE SAME code.
#
# - Extension IDs are resolved at BUILD time from the LIVE Edge Add-ons /
#   Chrome Web Store pages (never hardcoded from memory). Unresolvable IDs
#   fail the run (fail-closed) with a re-dispatch hint.
# - Managed bookmarks policy = exactly {Mission Control, docs/AUTOLOGIN.md
#   repo page, Tailscale admin DNS}. Piracy indexes are refused by gate.
# - Edge forcelist is fail-closed; Chrome/Firefox are best-effort mirrors.
param(
    [Parameter(Mandatory = $true)][string]$MissionControlUrl,
    [string]$Repo = 'dekarita/supreme-lamp',
    [string]$ChromeMissionControlUrl = ''
)
$ErrorActionPreference = 'Stop'
if (-not $ChromeMissionControlUrl) { $ChromeMissionControlUrl = $MissionControlUrl }

function Get-StoreExtensionId {
    param(
        [ValidateSet('edge', 'chrome')][string]$Store,
        [string]$Query,
        [string[]]$SlugHints
    )
    $q = [uri]::EscapeDataString($Query)
    if ($Store -eq 'edge') {
        $candidates = @(
            ('https://microsoftedge.microsoft.com/addons/search/' + $q),
            ('https://microsoftedge.microsoft.com/addons/search/' + $q + '?form=QBRE')
        )
        $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
    } else {
        $candidates = @(
            ('https://chromewebstore.google.com/search/' + $q),
            ('https://chrome.google.com/webstore/search/' + $q)
        )
        $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
    $rx = [regex]('/detail/[a-z0-9][a-z0-9\-]*/([a-z]{32})')
    $found = @{}
    foreach ($url in $candidates) {
        $html = ''
        for ($attempt = 1; $attempt -le 2; $attempt++) {
            try {
                $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 45 -MaximumRedirection 5 -Headers @{ 'User-Agent' = $ua }
                $html = [string]$r.Content
                if ($html) { break }
            } catch {
                $html = ''
                Start-Sleep -Seconds 2
            }
        }
        if (-not $html) { continue }
        foreach ($m in $rx.Matches($html)) {
            $id = $m.Groups[1].Value
            if ($id -notmatch '^[a-p]{32}$') { continue }
            $seg = $m.Value.ToLowerInvariant()
            $hintOk = $true
            foreach ($h in $SlugHints) { if ($seg -notlike ('*' + $h + '*')) { $hintOk = $false; break } }
            if ($hintOk -and -not $found.ContainsKey($id)) { $found[$id] = $seg }
        }
        if ($found.Count -gt 0) { break }
    }
    if ($found.Count -eq 0) {
        Write-Host ('::error title=Extension ID resolution failed::' + $Store + ' store did not return a /detail/<slug>/<32-char> id for "' + $Query + '". Re-dispatch once (transient store outage); IDs are never hardcoded.')
        throw ('STORE-ID-RESOLVE-FAILED store=' + $Store + ' query=' + $Query)
    }
    $idOut = @($found.Keys)[0]
    Write-Host ('[browser] resolved ' + $Query + ' on ' + $Store + ' -> ' + $idOut + ' (live store, build time)')
    return $idOut
}

# ---- live store resolution (build time; fail-closed) ----
$ublockEdge  = Get-StoreExtensionId -Store edge   -Query 'uBlock Origin' -SlugHints @('ublock')
$darkEdge    = Get-StoreExtensionId -Store edge   -Query 'Dark Reader'   -SlugHints @('dark-reader', 'darkreader')
$ublockChrome = Get-StoreExtensionId -Store chrome -Query 'uBlock Origin' -SlugHints @('ublock')
$darkChrome   = Get-StoreExtensionId -Store chrome -Query 'Dark Reader'   -SlugHints @('dark-reader', 'darkreader')

# ---- mandated managed bookmarks set (no other entries) ----
$managed = @(
    @{ name = 'Mission Control';    url = $MissionControlUrl },
    @{ name = 'docs/AUTOLOGIN.md';  url = ('https://github.com/' + $Repo + '/blob/main/docs/AUTOLOGIN.md') },
    @{ name = 'Tailscale admin DNS'; url = 'https://login.tailscale.com/admin/dns' }
)
$managedJson = ConvertTo-Json -InputObject $managed -Depth 5 -Compress

# ---- Edge: forcelist (fail-closed) + ManagedBookmarks policy ----
$edgePol = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
New-Item -Path $edgePol -Force -ErrorAction Stop | Out-Null
$extPath = Join-Path $edgePol 'ExtensionInstallForcelist'
New-Item -Path $extPath -Force -ErrorAction Stop | Out-Null
Set-ItemProperty -Path $extPath -Name '1' -Value ($ublockEdge + ';https://edge.microsoft.com/extensionwebstorebase/v1/crx') -ErrorAction Stop
Set-ItemProperty -Path $extPath -Name '2' -Value ($darkEdge + ';https://edge.microsoft.com/extensionwebstorebase/v1/crx') -ErrorAction Stop
Write-Host ('[edge] forced extensions (live IDs): uBlock Origin=' + $ublockEdge + ' Dark Reader=' + $darkEdge)
foreach ($polPath in @('HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge')) {
    try {
        New-Item -Path $polPath -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path $polPath -Name 'ManagedBookmarks' -Value $managedJson -ErrorAction Stop
        Write-Host ('[edge] ManagedBookmarks set at ' + $polPath)
    } catch {
        Write-Host ('::error title=ManagedBookmarks write failed::' + $polPath + ': ' + $_.Exception.Message)
        throw
    }
}

# ---- Chrome: best-effort mirror with Chrome-Web-Store-resolved IDs ----
try {
    $chromePol = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
    New-Item -Path $chromePol -Force -ErrorAction Stop | Out-Null
    $chromeExt = Join-Path $chromePol 'ExtensionInstallForcelist'
    New-Item -Path $chromeExt -Force -ErrorAction Stop | Out-Null
    Set-ItemProperty -Path $chromeExt -Name '1' -Value ($ublockChrome + ';https://clients2.google.com/service/update2/crx') -ErrorAction Stop
    Set-ItemProperty -Path $chromeExt -Name '2' -Value ($darkChrome + ';https://clients2.google.com/service/update2/crx') -ErrorAction Stop
    $chromeManaged = @(
        @{ name = 'Mission Control';    url = $ChromeMissionControlUrl },
        @{ name = 'docs/AUTOLOGIN.md';  url = ('https://github.com/' + $Repo + '/blob/main/docs/AUTOLOGIN.md') },
        @{ name = 'Tailscale admin DNS'; url = 'https://login.tailscale.com/admin/dns' }
    )
    $chromeManagedJson = ConvertTo-Json -InputObject $chromeManaged -Depth 5 -Compress
    foreach ($cpol in @('HKLM:\SOFTWARE\Policies\Google\Chrome', 'HKCU:\SOFTWARE\Policies\Google\Chrome')) {
        New-Item -Path $cpol -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path $cpol -Name 'ManagedBookmarks' -Value $chromeManagedJson -ErrorAction Stop
    }
    Write-Host ('[chrome] forced extensions (live IDs): uBlock Origin=' + $ublockChrome + ' Dark Reader=' + $darkChrome)
} catch {
    Write-Host ('[chrome] policy write failed (best-effort): ' + $_.Exception.Message)
}

# ---- Firefox: best-effort distribution policy (slug-resolved XPI URLs) ----
$ff = 'C:\Program Files\Mozilla Firefox'
if (Test-Path $ff) {
    try {
        $dist = Join-Path $ff 'distribution'
        New-Item -ItemType Directory -Path $dist -Force -ErrorAction SilentlyContinue | Out-Null
        $bm = @()
        foreach ($b in $managed) { $bm += @{ URL = [string]$b.url; Title = [string]$b.name; Placement = 'toolbar' } }
        $bm[0].URL = $MissionControlUrl
        $pol = [ordered]@{ policies = [ordered]@{
            Bookmarks = $bm
            ExtensionSettings = [ordered]@{
                'uBlock0@raymondhill.net' = @{ installation_mode = 'force_installed'; install_url = 'https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi' }
                'addon@darkreader.org'    = @{ installation_mode = 'force_installed'; install_url = 'https://addons.mozilla.org/firefox/downloads/latest/darkreader/latest.xpi' }
            }
        } }
        [System.IO.File]::WriteAllText((Join-Path $dist 'policies.json'), (ConvertTo-Json -InputObject $pol -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
        $okFF = $false
        try { $null = Get-Content -LiteralPath (Join-Path $dist 'policies.json') -Raw | ConvertFrom-Json; $okFF = $true } catch { }
        Write-Host ('[firefox] policies.json written with extensions + mandated bookmarks (valid=' + $okFF + ')')
    } catch {
        Write-Host ('[firefox] policies failed (best-effort): ' + $_.Exception.Message)
    }
} else {
    Write-Host '[firefox] not installed; skipping'
}
Write-Host '[browser] policy provisioning complete'
exit 0
