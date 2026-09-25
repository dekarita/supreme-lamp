# [F10-11 §4.1] LIVE extension-ID resolution for the force-install policies.
#
# No extension ID is ever hardcoded in this repo. Every ID is DISCOVERED at
# build time from a live page (store search page, a live SERP that indexes the
# store detail pages, or the vendor's own repository/site) and then RE-VERIFIED
# by fetching the store detail page for that exact id with the canonical slug in
# its URL and matching a publisher/title marker. A candidate that cannot be
# discovered + verified is reported LOUDLY and skipped - a wrong or guessed ID
# would silently install the wrong extension.
#
# Candidates are classified by the STORE OF THE LINK THEY CAME FROM
# (microsoftedge.microsoft.com vs chromewebstore.google.com), because the two
# stores use different ids for the same extension; the requested store is
# preferred and the other store is only used as a verified fallback (its own
# update URL then applies).
#
# Dot-sourced by BOTH .github/workflows/main.yml (runner provisioning) and
# .github/workflows/autologin-lab.yml (proof matrix F), so the resolver text has
# exactly one definition (launch-gates checks the dot-source in both files).
#
# Contract: Resolve-StoreExtId returns $null or a hashtable
#   @{ id = '<32 chars a-p>'; store = 'edge' | 'cws'; source = '<label>::<url>' }
# Caller picks the update URL via Get-ExtForceListValue.

$script:ExtResolveUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

function Get-ExtPageText {
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 25 -UserAgent $script:ExtResolveUa -ErrorAction Stop
        return [string]$r.Content
    } catch {
        # ::warning:: so the failure is retrievable from the Checks API even when
        # runner logs are unavailable (see F10-13).
        Write-Host ('::warning::[ext] fetch failed: ' + $Url + ' :: ' + $_.Exception.Message)
        return $null
    }
}

function Get-ExtStoreOfUrl {
    param([string]$Url)
    if (-not $Url) { return '' }
    if ($Url -match 'microsoftedge\.microsoft\.com') { return 'edge' }
    if ($Url -match 'chromewebstore\.google\.com|chrome\.google\.com') { return 'cws' }
    return ''
}

function Find-ExtStoreLinks {
    # Every <store-url>/detail/<slug>/<32 a-p id> link on a live page (the slug
    # anchor is what keeps a SERP or vendor-page hit honest), plus - only when the
    # page itself carries the slug and its host is the store - a bare id that the
    # caller will still have to prove on the store detail page.
    param([string]$Text, [string]$Slug)
    $out = New-Object System.Collections.ArrayList
    if ([string]::IsNullOrEmpty($Text)) { return $out }
    $re = 'https?://[A-Za-z0-9.\-]*(?:microsoftedge\.microsoft\.com|chromewebstore\.google\.com|chrome\.google\.com)/[A-Za-z0-9\-/]*detail/' + [regex]::Escape($Slug) + '/([a-p]{32})'
    foreach ($m in [regex]::Matches($Text, $re)) {
        [void]$out.Add(@{ id = $m.Groups[1].Value; url = $m.Value })
    }
    return $out
}

function Resolve-StoreExtId {
    param(
        [string]$Query,
        [string]$Slug,
        [string[]]$Markers,
        [string[]]$VendorPages = @(),
        [string]$Store = 'edge'
    )
    $q = [uri]::EscapeDataString($Query)
    $sources = New-Object System.Collections.ArrayList
    if ($Store -eq 'cws') {
        [void]$sources.Add(@{ label = 'cws-search'; url = ('https://chromewebstore.google.com/search/' + $q) })
    } else {
        [void]$sources.Add(@{ label = 'edge-search'; url = ('https://microsoftedge.microsoft.com/addons/search/' + $q) })
    }
    foreach ($v in $VendorPages) { [void]$sources.Add(@{ label = 'vendor-page'; url = $v }) }
    [void]$sources.Add(@{ label = 'serp'; url = ('https://www.bing.com/search?q=' + [uri]::EscapeDataString('site:microsoftedge.microsoft.com/addons/detail ' + $Query)) })
    [void]$sources.Add(@{ label = 'cws-search'; url = ('https://chromewebstore.google.com/search/' + $q) })

    $cands = New-Object System.Collections.ArrayList
    $seen = @{}
    foreach ($s in $sources) {
        $t = Get-ExtPageText -Url $s.url
        $links = Find-ExtStoreLinks -Text $t -Slug $Slug
        foreach ($l in $links) {
            $st = Get-ExtStoreOfUrl -Url $l.url
            if (-not $st) { continue }
            $k = $st + ':' + $l.id
            if ($seen.ContainsKey($k)) { continue }
            $seen[$k] = $true
            [void]$cands.Add(@{ id = $l.id; store = $st; source = ($s.label + '::' + $l.url) })
        }
        if ($links.Count -eq 0) {
            # Bare-id fallback: page names the slug but the store URL pattern is
            # split across fields. Only usable when the SOURCE host is a store.
            $srcStore = Get-ExtStoreOfUrl -Url $s.url
            if ($srcStore -and $t -and ($t -match [regex]::Escape($Slug))) {
                $m2 = [regex]::Match($t, '([a-p]{32})')
                if ($m2.Success) {
                    $k = $srcStore + ':' + $m2.Groups[1].Value
                    if (-not $seen.ContainsKey($k)) {
                        $seen[$k] = $true
                        [void]$cands.Add(@{ id = $m2.Groups[1].Value; store = $srcStore; source = ($s.label + '::bare-id') })
                    }
                }
            }
            Write-Host ('::warning::[ext] no live store link on ' + $s.label + ' (' + $s.url + '), bytes=' + $(if ($t) { $t.Length } else { 0 }) + ', slug-present=' + [string]($t -and ($t -match [regex]::Escape($Slug))))
        }
    }
    if ($cands.Count -eq 0) {
        Write-Host ('::warning::[ext] live ID discovery FAILED for ' + $Slug + ' - no store link on any live page; entry skipped (never guessed)')
        return $null
    }
    # Preferred store first (Edge forcelist wants Edge ids), other store second.
    $ordered = @($cands | Where-Object { $_.store -eq $Store }) + @($cands | Where-Object { $_.store -ne $Store })
    foreach ($c in $ordered) {
        $detail = if ($c.store -eq 'cws') { 'https://chromewebstore.google.com/detail/' + $Slug + '/' + $c.id } else { 'https://microsoftedge.microsoft.com/addons/detail/' + $Slug + '/' + $c.id }
        $det = Get-ExtPageText -Url $detail
        if (-not $det) {
            Write-Host ('::warning::[ext] detail page unreachable for ' + $Slug + ' id ' + $c.id + ' (' + $detail + ')')
            continue
        }
        $ok = $false
        foreach ($mk in $Markers) { if ($mk -and ($det -match [regex]::Escape($mk))) { $ok = $true; break } }
        if (-not $ok) {
            Write-Host ('::warning::[ext] publisher/title marker missing on ' + $detail + ' - candidate rejected (unverified id)')
            continue
        }
        Write-Host ('[ext] resolved ' + $Slug + ' -> ' + $c.id + ' (store=' + $c.store + ', verified via ' + $detail + ', discovered on ' + $c.source + ')')
        return @{ id = $c.id; store = $c.store; source = $c.source }
    }
    Write-Host ('::warning::[ext] no VERIFIED candidate for ' + $Slug + ' (' + $cands.Count + ' discovered) - entry skipped (never guessed)')
    return $null
}

function Get-ExtForceListValue {
    # "<id>;<update-url>" - the exact ExtensionInstallForcelist value format.
    param($Resolved)
    if (-not $Resolved) { return '' }
    $u = if ($Resolved.store -eq 'cws') { 'https://clients2.google.com/service/update2/crx' } else { 'https://edge.microsoft.com/extensionwebstorebase/v1/crx' }
    return ($Resolved.id + ';' + $u)
}

function Resolve-AmoAddon {
    # [F12-3 §3.2] LIVE Firefox add-on resolution from addons.mozilla.org.
    # The repo carries only the add-on SLUG (a human-readable name) - never an
    # id and never a download URL. Both the extension id (guid) and the current
    # xpi URL come from the AMO API at build time and are verified against live
    # markers (name/summary/author), so a store-side rename can never silently
    # force-install the wrong add-on.
    #
    # Contract: returns $null or
    #   @{ id = '<guid>'; url = '<https://addons.mozilla.org/...xpi>'; source = '<api url>'; name = '<display name>' }
    param(
        [string]$Slug,
        [string[]]$Markers
    )
    $api = 'https://addons.mozilla.org/api/v5/addons/addon/' + $Slug + '/'
    $text = Get-ExtPageText -Url $api
    if (-not $text) {
        Write-Host ('::warning::[amo] API unreachable for ' + $Slug + ' - Firefox entry skipped (never guessed)')
        return $null
    }
    $j = $null
    try { $j = $text | ConvertFrom-Json } catch { }
    if (-not $j) {
        Write-Host ('::warning::[amo] API JSON parse failed for ' + $Slug + ' - entry skipped (never guessed)')
        return $null
    }
    $guid = ([string]$j.guid).Trim()
    $xpi = ''
    try { $xpi = [string]$j.current_version.file.url } catch { }
    $name = ''
    try { $name = [string]$j.name.'en-US' } catch { }
    if (-not $name) { try { $name = [string]$j.name } catch { } }
    $sum = ''
    try { $sum = [string]$j.summary.'en-US' } catch { }
    $author = ''
    try { $author = [string]$j.authors[0].name } catch { }
    $blob = ($name + ' ' + $sum + ' ' + $author + ' ' + [string]$j.slug)
    $verified = $false
    foreach ($mk in $Markers) { if ($mk -and ($blob -match [regex]::Escape($mk))) { $verified = $true; break } }
    if (-not $guid -or ($xpi -notmatch '^https://addons\.mozilla\.org/') -or (-not $verified)) {
        Write-Host ('::warning::[amo] candidate rejected for ' + $Slug + ' (guid=' + $guid + ', xpi-ok=' + [bool]($xpi -match '^https://addons\.mozilla\.org/') + ', marker-ok=' + $verified + ')')
        return $null
    }
    Write-Host ('[amo] resolved ' + $Slug + ' -> guid=' + $guid + ' xpi=' + $xpi + ' (verified live on ' + $api + ')')
    return @{ id = $guid; url = $xpi; source = $api; name = $name }
}
