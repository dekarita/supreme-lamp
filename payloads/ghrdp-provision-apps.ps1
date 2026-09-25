# ghrdp-provision-apps.ps1  [F12-3 §3.1/§3.4]
#
# Shared provisioning helpers that BOTH .github/workflows/main.yml (real
# provisioning) and .github/workflows/autologin-lab.yml (proof matrix cells K/L)
# dot-source, so the lab exercises the exact code the runner ships - the same
# single-definition pattern as payloads/edge-ext-resolve.ps1 (launch-gates F10
# enforces the dot-source in both workflows).
#
# Nothing here touches the mirror pipeline, torrent indexes, download
# automation or a torrent Web UI:  §3.4 is only about pointing the file type
# .torrent and the magnet: protocol at the PLAIN, already-installed app.

function Get-ForcedEntryCount {
    # [F12-3 §3.1] Policy READBACK: the number of numbered values a browser's
    # ExtensionInstallForcelist key actually holds (what edge://policy and
    # chrome://policy render). -1 = key unreadable.
    param([string]$Path)
    try { return @((Get-Item -LiteralPath $Path -ErrorAction Stop).GetValueNames() | Where-Object { $_ -match '^\d+$' }).Count } catch { return -1 }
}

function Test-ForcedEntryShape {
    # "<32 chars a-p>;<update url>" is the only shape a browser accepts.
    param([string]$Value)
    return [bool]($Value -match '^[a-p]{32};https://[A-Za-z0-9.\-/]+$')
}

function Get-QbittorrentProgId {
    # [F12-3 §3.4] The ProgId is DISCOVERED from the installed shell
    # registration - never a hardcoded vendor string. Any HKCR ProgId whose
    # shell\open\command runs qbittorrent.exe is a candidate; a candidate whose
    # name mentions the file type wins.
    param([string]$ExeName = 'qbittorrent.exe')
    $found = ''
    foreach ($k in @(Get-ChildItem 'Registry::HKEY_CLASSES_ROOT' -ErrorAction SilentlyContinue)) {
        $n = ''
        try { $n = [string]$k.PSChildName } catch { }
        if (-not $n -or ($n -notmatch '^[Qq]\.?[Bb]ittorrent')) { continue }
        $cmd = ''
        try { $cmd = [string](Get-ItemProperty -LiteralPath ($k.PSPath + '\shell\open\command') -ErrorAction Stop).'(default)' } catch { }
        if ($cmd -and ($cmd -match [regex]::Escape($ExeName))) {
            $found = $n
            if ($n -match 'torrent') { break }
        }
    }
    return $found
}

function Set-QbittorrentDefaultHandler {
    # Writes the two user-visible defaults and reads them back:
    #   HKCR\.torrent                       (default) = <ProgId>
    #   HKCR\.torrent\OpenWithProgids       <ProgId>  = <empty>
    #   HKCR\magnet                         URL Protocol (default)
    #   HKCR\magnet\shell\open\command      (default) = "<qbittorrent.exe>" "%1"
    # Returns @{ ok; progId; torrent; magnet; error } - the caller decides
    # whether a mismatch is fatal (main.yml: advisory; lab: assert).
    param(
        [string]$ExePath,
        [string]$ExeName = 'qbittorrent.exe'
    )
    $res = @{ ok = $false; progId = ''; torrent = ''; magnet = ''; error = '' }
    try {
        if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) { $res.error = 'exe-not-found'; return $res }
        $progId = Get-QbittorrentProgId -ExeName $ExeName
        if (-not $progId) { $res.error = 'progid-not-found'; return $res }
        $res.progId = $progId
        $torKey = 'Registry::HKEY_CLASSES_ROOT\.torrent'
        New-Item -Path $torKey -Force -ErrorAction SilentlyContinue | Out-Null
        Set-Item -LiteralPath $torKey -Value $progId -ErrorAction Stop
        New-Item -Path ($torKey + '\OpenWithProgids') -Force -ErrorAction SilentlyContinue | Out-Null
        try { New-ItemProperty -Path ($torKey + '\OpenWithProgids') -Name $progId -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null } catch { }
        New-Item -Path 'Registry::HKEY_CLASSES_ROOT\magnet' -Force -ErrorAction SilentlyContinue | Out-Null
        try { New-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\magnet' -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null } catch { }
        New-Item -Path 'Registry::HKEY_CLASSES_ROOT\magnet\shell\open\command' -Force -ErrorAction SilentlyContinue | Out-Null
        Set-Item -LiteralPath 'Registry::HKEY_CLASSES_ROOT\magnet\shell\open\command' -Value ('"' + $ExePath + '" "%1"') -ErrorAction Stop
        try { $res.torrent = [string](Get-Item -LiteralPath $torKey -ErrorAction Stop).GetValue('') } catch { }
        try { $res.magnet = [string](Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\magnet\shell\open\command' -ErrorAction Stop).'(default)' } catch { }
        $res.ok = ($res.torrent -eq $progId) -and ($res.magnet -match [regex]::Escape($ExeName))
        if (-not $res.ok) { $res.error = 'readback-mismatch' }
    } catch {
        $res.error = $_.Exception.Message
    }
    return $res
}
