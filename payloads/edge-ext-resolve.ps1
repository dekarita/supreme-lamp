# [F10-11 §4.1] LIVE extension-ID resolution for the force-install policies.
#
# No extension ID is ever hardcoded in this repo. Every ID is DISCOVERED at
# build time from a live page (the store search page, a live SERP that indexes
# the store detail pages, or the vendor's own repository page) and then
# RE-VERIFIED by fetching the store detail page for that exact id with the
# canonical slug in its URL and matching a publisher/title marker. A candidate
# that cannot be discovered + verified is reported LOUDLY and skipped - a wrong
# or guessed ID would silently install the wrong extension.
#
# Dot-sourced by BOTH .github/workflows/main.yml (runner provisioning) and
# .github/workflows/autologin-lab.yml (proof matrix F), so the resolver text has
# exactly one definition (launch-gates checks the dot-source in both files).
#
# Callback/return contract: Resolve-StoreExtId returns $null or a hashtable
#   @{ id = '<32 chars a-p>'; store = 'edge' | 'cws'; source = '<label>::<url>' }
# The caller picks the update URL: edge -> edge.microsoft.com/extensionwebstorebase
# /v1/crx, cws -> clients2.google.com/service/update2/crx.

$script:ExtResolveUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

function Get-ExtPageText {
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 25 -UserAgent $script:ExtResolveUa -ErrorAction Stop
        return [string]$r.Content
    } catch {
        Write-Host ('[ext] fetch failed: ' + $Url + ' :: ' + $_.Exception.Message)
        return $null
    }
}

function Find-ExtIdInText {
    param([string]$Text, [string]$Slug)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    # /detail/<slug>/<32 chars a-p> - the canonical store URL shape for both
    # front-ends; the slug anchor is what keeps a SERP hit honest.
    $m = [regex]::Match($Text, '/detail/' + [regex]::Escape($Slug) + '/([a-p]{32})')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
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

    $id = ''; $src = ''
    foreach ($s in $sources) {
        $t = Get-ExtPageText -Url $s.url
        $id = Find-ExtIdInText -Text $t -Slug $Slug
        if ($id) { $src = ($s.label + '::' + $s.url); Write-Host ('[ext] ' + $Slug + ' candidate ' + $id + ' discovered on ' + $src); break }
    }
    if (-not $id) {
        Write-Host ('::warning::[ext] live ID discovery FAILED for ' + $Slug + ' - no store link on any live page; entry skipped (never guessed)')
        return $null
    }
    $detail = if ($src -like 'cws-search*') { 'https://chromewebstore.google.com/detail/' + $Slug + '/' + $id } else { 'https://microsoftedge.microsoft.com/addons/detail/' + $Slug + '/' + $id }
    $det = Get-ExtPageText -Url $detail
    if (-not $det) {
        Write-Host ('::warning::[ext] detail page unreachable for ' + $Slug + ' id ' + $id + ' - entry skipped (unverified)')
        return $null
    }
    $ok = $false
    foreach ($mk in $Markers) { if ($mk -and ($det -match [regex]::Escape($mk))) { $ok = $true; break } }
    if (-not $ok) {
        Write-Host ('::warning::[ext] publisher/title marker missing on ' + $detail + ' - entry skipped (unverified id)')
        return $null
    }
    Write-Host ('[ext] resolved ' + $Slug + ' -> ' + $id + ' (store=' + $(if ($src -like 'cws-search*') { 'cws' } else { 'edge' }) + ', live-verified via ' + $src + ')')
    return @{ id = $id; store = $(if ($src -like 'cws-search*') { 'cws' } else { 'edge' }); source = $src }
}

function Get-ExtForceListValue {
    # "<id>;<update-url>" - the exact ExtensionInstallForcelist value format.
    param($Resolved)
    if (-not $Resolved) { return '' }
    $u = if ($Resolved.store -eq 'cws') { 'https://clients2.google.com/service/update2/crx' } else { 'https://edge.microsoft.com/extensionwebstorebase/v1/crx' }
    return ($Resolved.id + ';' + $u)
}
