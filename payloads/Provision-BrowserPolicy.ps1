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
    $qPlus = $q -replace '%20', '+'
    if ($Store -eq 'edge') {
        $candidates = @(
            ('https://microsoftedge.microsoft.com/addons/search/' + $q),
            ('https://microsoftedge.microsoft.com/addons/search/' + $q + '?form=QBRE'),
            ('https://microsoftedge.microsoft.com/addons/search/' + $qPlus)
        )
        $detailBase = 'https://microsoftedge.microsoft.com/addons/detail/'
        $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
    } else {
        $candidates = @(
            ('https://chromewebstore.google.com/search/' + $q),
            ('https://chromewebstore.google.com/search/' + $qPlus),
            ('https://chrome.google.com/webstore/search/' + $q)
        )
        $detailBase = 'https://chromewebstore.google.com/detail/'
        $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
    # slug-only detail probes (a redirect to <slug>/<id> yields the live ID from the final URI)
    foreach ($h in $SlugHints) {
        $candidates += ($detailBase + $h)
    }
    $rx = [regex]('/detail/[a-z0-9][a-z0-9\-]*/([a-z]{32})')
    $rxUri = [regex]('/addons/detail/[a-z0-9][a-z0-9\-]*/([a-p]{32})')
    $found = @{}
    $lastStat = 'no-candidate-attempted'
    $html = ''
    $hdrs = @{
        'User-Agent'      = $ua
        'Accept'          = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        'Accept-Language' = 'en-US,en;q=0.9'
    }
    foreach ($url in $candidates) {
        $html = ''
        $finalUri = ''
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 45 -MaximumRedirection 5 -Headers $hdrs
                $html = [string]$r.Content
                try { $finalUri = [string]$r.BaseResponse.RequestMessage.RequestUri.AbsoluteUri } catch {
                    try { $finalUri = [string]$r.BaseResponse.ResponseUri.AbsoluteUri } catch { }
                }
                $lastStat = 'ok http=' + [int]$r.StatusCode + ' len=' + $html.Length + ' final=' + $finalUri
                if ($html) { break }
            } catch {
                $errMsg = [string]$_.Exception.Message
                if ($errMsg.Length -gt 160) { $errMsg = $errMsg.Substring(0, 160) }
                $errMsg = $errMsg -replace '[\r\n]+', ' '
                $lastStat = 'ERR ' + $url + ' try' + $attempt + ': ' + $errMsg
                $html = ''
                Start-Sleep -Seconds 3
            }
        }
        # 1) redirect/landing URL itself may already carry the ID
        if ($finalUri) {
            $mU = $rxUri.Match($finalUri)
            if ($mU.Success) {
                $seg = $mU.Value.ToLowerInvariant()
                $hintOk = $true
                foreach ($h in $SlugHints) { if ($seg -notlike ('*' + $h + '*')) { $hintOk = $false; break } }
                if ($hintOk -and -not $found.ContainsKey($mU.Groups[1].Value)) { $found[$mU.Groups[1].Value] = $seg }
            }
        }
        # 2) body scan (server-rendered links, embedded state JSON, any ID near a slug hint)
        if ($html) {
            foreach ($m in $rx.Matches($html)) {
                $id = $m.Groups[1].Value
                if ($id -notmatch '^[a-p]{32}$') { continue }
                $seg = $m.Value.ToLowerInvariant()
                $hintOk = $true
                foreach ($h in $SlugHints) { if ($seg -notlike ('*' + $h + '*')) { $hintOk = $false; break } }
                if ($hintOk -and -not $found.ContainsKey($id)) { $found[$id] = $seg }
            }
            # embedded state: any 32-char a-p ID token whose +-400-char window
            # contains one of the slug hints (case-insensitive) and a slug/id-ish key
            if ($found.Count -eq 0) {
                $rxId = [regex]('([a-p]{32})')
                foreach ($m in $rxId.Matches($html)) {
                    if ($m.Length -ne 32) { continue }
                    $id = $m.Value
                    # reject substrings of a longer a-p run (truncated/shifted ids)
                    $preOk = ($m.Index -eq 0) -or (-not ([string]$html[$m.Index - 1] -match '[a-p]'))
                    $postIdx = $m.Index + 32
                    $postOk = ($postIdx -ge $html.Length) -or (-not ([string]$html[$postIdx] -match '[a-p]'))
                    if (-not ($preOk -and $postOk)) { continue }
                    $lo = [Math]::Max(0, $m.Index - 400)
                    $hi = [Math]::Min($html.Length, $m.Index + $m.Length + 400)
                    $win = $html.Substring($lo, $hi - $lo).ToLowerInvariant()
                    $hintOk = $false
                    foreach ($h in $SlugHints) { if ($win.Contains($h)) { $hintOk = $true; break } }
                    if ($hintOk -and -not $found.ContainsKey($id)) { $found[$id] = 'state:' + $id }
                }
            }
        }
        if ($found.Count -gt 0) { break }
    }
    if ($found.Count -eq 0) {
        $hits = 0
        $idTokens = 0
        try {
            if ($html) {
                $hits = [regex]::Matches($html, '/addons/detail/').Count
                $idTokens = [regex]::Matches($html, '[a-p]{32}').Count
            }
        } catch { }
        $samp = ''
        if ($html -and $html.Length -gt 0) { $samp = $html.Substring(0, [Math]::Min(1200, $html.Length)) -replace '[\r\n]+', ' ' }
        $diag = 'STORE-DIAG store=' + $Store + ' query=' + $Query + ' last=' + $lastStat + ' len=' + $html.Length + ' detailHits=' + $hits + ' id32Tokens=' + $idTokens + ' sample=' + $samp
        try { [System.IO.File]::AppendAllText((Join-Path $env:RUNNER_TEMP 'store-diag.txt'), ($diag + "`r`n`r`n")) } catch { }
        Write-Host ('::error title=Extension ID resolution failed::' + $Store + ' "' + $Query + '" last=' + $lastStat + ' detailHits=' + $hits + ' id32Tokens=' + $idTokens + ' - see store-diag.txt artifact')
        if ($samp) { Write-Host ('[store-sample] ' + $samp.Substring(0, [Math]::Min(700, $samp.Length))) }
        throw ('STORE-ID-RESOLVE-FAILED store=' + $Store + ' query=' + $Query + ' last=' + $lastStat)
    }
    $idOut = @($found.Keys)[0]
    Write-Host ('[browser] resolved ' + $Query + ' on ' + $Store + ' -> ' + $idOut + ' seg=' + $found[$idOut] + ' (live store, build time)')
    return $idOut
}

# ---- live store resolution (build time) ----
# Edge = fail-closed (force-install contract + launch-gates). Chrome = best-effort
# (its search page is client-rendered; if the live ID cannot be resolved the
# Chrome forcelist is skipped and the run continues - never hardcoded).
$ublockEdge  = Get-StoreExtensionId -Store edge   -Query 'uBlock Origin' -SlugHints @('ublock')
$darkEdge    = Get-StoreExtensionId -Store edge   -Query 'Dark Reader'   -SlugHints @('dark-reader', 'darkreader')
$ublockChrome = ''
$darkChrome   = ''
try {
    $ublockChrome = Get-StoreExtensionId -Store chrome -Query 'uBlock Origin' -SlugHints @('ublock')
    $darkChrome   = Get-StoreExtensionId -Store chrome -Query 'Dark Reader'   -SlugHints @('dark-reader', 'darkreader')
} catch {
    Write-Host ('[browser] chrome store resolution failed (best-effort, forcelist skipped): ' + $_.Exception.Message)
    $ublockChrome = ''
    $darkChrome = ''
}

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
    if ($ublockChrome -and $darkChrome) {
        $chromeExt = Join-Path $chromePol 'ExtensionInstallForcelist'
        New-Item -Path $chromeExt -Force -ErrorAction Stop | Out-Null
        Set-ItemProperty -Path $chromeExt -Name '1' -Value ($ublockChrome + ';https://clients2.google.com/service/update2/crx') -ErrorAction Stop
        Set-ItemProperty -Path $chromeExt -Name '2' -Value ($darkChrome + ';https://clients2.google.com/service/update2/crx') -ErrorAction Stop
        Write-Host ('[chrome] forced extensions (live IDs): uBlock Origin=' + $ublockChrome + ' Dark Reader=' + $darkChrome)
    } else {
        Write-Host '[chrome] ExtensionInstallForcelist skipped (live IDs unresolved - best-effort; never hardcoded)'
    }
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
