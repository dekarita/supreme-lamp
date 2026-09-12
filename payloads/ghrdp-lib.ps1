$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
try { [System.Net.ServicePointManager]::Expect100Continue = $false } catch { }
$global:GhrdpEncNoBom = New-Object System.Text.UTF8Encoding($false)
$global:GhrdpGofileHosts = @('store1', 'storena-phx', 'storeeu-par', 'storeap-sgp')
$global:GhrdpLegacyUrl = 'https://rentry.co/myurl0'
$global:GhrdpProg = $null
$global:GhrdpProgPath = ''
$global:GhrdpLastFlush = [datetime]::MinValue.Ticks
$global:GhrdpSpdAll = @{ t = [datetime]::Now.Ticks; b = [long]0 }
$global:GhrdpSpdFile = @{ t = [datetime]::Now.Ticks; b = [long]0 }
$global:GhrdpDoneBytes = [long]0
function Get-RndInt {
    param([int]$Max)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $b = New-Object byte[] 4
    $rng.GetBytes($b)
    $rng.Dispose()
    return [int]([BitConverter]::ToUInt32($b, 0) % [uint32]$Max)
}
function Pick-Char {
    param([string]$Set)
    return [string]$Set[(Get-RndInt -Max $Set.Length)]
}
function New-MirrorPassword {
    param([int]$Length = 40)
    $set = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $arr = New-Object char[] $Length
    for ($i = 0; $i -lt $Length; $i++) { $arr[$i] = [char](Pick-Char -Set $set) }
    return (-join $arr)
}
function Get-SLTime {
    param([datetime]$Utc = (Get-Date).ToUniversalTime())
    return $Utc.AddHours(5).AddMinutes(30).ToString('yyyy-MM-dd HH:mm:ss')
}
function Convert-ToSL {
    param([string]$UtcText)
    try { $dt = [datetime]::SpecifyKind([datetime]::Parse($UtcText), 'Utc'); return (Get-SLTime -Utc $dt) } catch { return [string]$UtcText }
}
function Get-HumanBytes {
    param([long]$Bytes)
    if ($Bytes -lt 1024) { return ([string]$Bytes + ' B') }
    $u = @('KB','MB','GB','TB'); $i = -1; $n = [double]$Bytes
    do { $n = $n / 1024; $i++ } while ($n -ge 1024 -and $i -lt ($u.Count - 1))
    return ('{0:N1} {1}' -f $n, $u[$i])
}
function Read-MirrorCfg {
    param([string]$Path)
    try {
        $b = [System.IO.File]::ReadAllBytes($Path)
        if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
        $t = [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
        return ($t | ConvertFrom-Json)
    } catch { return $null }
}
function Save-MirrorCfg {
    param($Cfg, [string]$Path)
    try { [System.IO.File]::WriteAllText($Path, ($Cfg | ConvertTo-Json -Depth 10), $global:GhrdpEncNoBom) } catch { }
}
function Initialize-MirrorProgress {
    param([string]$Path)
    $global:GhrdpProgPath = $Path
    $now = [datetime]::Now.Ticks
    $global:GhrdpSpdAll = @{ t = $now; b = [long]0 }
    $global:GhrdpSpdFile = @{ t = $now; b = [long]0 }
    $global:GhrdpProg = [ordered]@{
        ts = (Get-Date).ToString('o')
        alive = $false
        mirror = $false
        active = [ordered]@{ name = ''; phase = 'idle'; bytesDone = [long]0; bytesTotal = [long]0; pct = 0; speedBps = [long]0 }
        agg = [ordered]@{ total = 0; done = 0; active = 0; failed = 0; bytesDone = [long]0; bytesTotal = [long]0; overallPct = 0; speedBps = [long]0 }
        telemetry = [ordered]@{ scans = 0; lastScan = ''; roots = @(); seen = 0; skippedJunk = 0; skippedSmall = 0; locked = 0; queued = 0 }
        archives = @()
        files = @()
        log = @()
        speedHistory = @()
    }
    Flush-MirrorProgress -Force
}
function Set-ActiveFile {
    param([string]$Name, [string]$Phase, [long]$Total)
    if (-not $global:GhrdpProg) { return }
    $a = $global:GhrdpProg.active
    $a.name = $Name
    $a.phase = $Phase
    $a.bytesDone = [long]0
    $a.bytesTotal = [long]$Total
    $a.pct = 0
    $a.speedBps = [long]0
    $global:GhrdpSpdFile = @{ t = [datetime]::Now.Ticks; b = [long]0 }
    Flush-MirrorProgress -Force
}
function Tick-MirrorBytes {
    param([long]$Count)
    if (-not $global:GhrdpProg) { return }
    $a = $global:GhrdpProg.active
    $a.bytesDone = [long]$a.bytesDone + [long]$Count
    $global:GhrdpLiveBytes = [long]$global:GhrdpDoneBytes + [long]$a.bytesDone
    Flush-MirrorProgress
}
function Add-MirrorLog {
    param([string]$Message)
    if (-not $global:GhrdpProg) { return }
    $line = (Get-Date -Format 'HH:mm:ss') + ' ' + $Message
    $p = $global:GhrdpProg
    $newLog = @($line) + @($p.log)
    if ($newLog.Count -gt 200) { $newLog = $newLog[0..199] }
    $p.log = $newLog
    Write-Host $line
}
function Flush-MirrorProgress {
    param([switch]$Force)
    $now = [datetime]::Now.Ticks
    if (-not $Force -and (($now - $global:GhrdpLastFlush) -lt 2000000)) { return }
    $global:GhrdpLastFlush = $now
    if (-not $global:GhrdpProgPath -or -not $global:GhrdpProg) { return }
    $p = $global:GhrdpProg
    $p.ts = (Get-Date).ToString('o')
    $dt = ($now - $global:GhrdpSpdAll.t) / 10000000.0
    $liveNow = [long]$global:GhrdpDoneBytes
    if ($p.active) { $liveNow = [long]$global:GhrdpDoneBytes + [long]$p.active.bytesDone }
    $global:GhrdpLiveBytes = $liveNow
    if ($dt -gt 0.5) {
        $inst = [math]::Max(0, [math]::Round(($liveNow - [long]$global:GhrdpSpdAll.b) / $dt))
        $old = [long]$p.agg.speedBps
        $p.agg.speedBps = [long]([math]::Round((0.4 * $inst) + (0.6 * $old)))
        $global:GhrdpSpdAll = @{ t = $now; b = $liveNow }
        $hist = @($p.speedHistory) + @($p.agg.speedBps)
        if ($hist.Count -gt 90) { $hist = $hist[($hist.Count - 90)..($hist.Count - 1)] }
        $p.speedHistory = $hist
    }
    $dta = ($now - $global:GhrdpSpdFile.t) / 10000000.0
    if ($dta -gt 0.5) {
        $p.active.speedBps = [long][math]::Max(0, [math]::Round(([long]$p.active.bytesDone - [long]$global:GhrdpSpdFile.b) / $dta))
        $global:GhrdpSpdFile = @{ t = $now; b = [long]$p.active.bytesDone }
    }
    if ([long]$p.active.bytesTotal -gt 0) {
        $p.active.pct = [math]::Min(100, [math]::Round(100.0 * [long]$p.active.bytesDone / [long]$p.active.bytesTotal, 1))
    } else {
        $p.active.pct = 0
    }
    $p.agg.bytesDone = [long]$global:GhrdpDoneBytes
    $p.agg.overallPct = 0
    if ([int]$p.agg.total -gt 0) {
        $p.agg.overallPct = [math]::Min(100, [math]::Round(100.0 * [int]$p.agg.done / [int]$p.agg.total, 1))
    }
    try {
        $tmp = $global:GhrdpProgPath + '.tmp'
        [System.IO.File]::WriteAllText($tmp, ($p | ConvertTo-Json -Depth 8), $global:GhrdpEncNoBom)
        [System.IO.File]::Copy($tmp, $global:GhrdpProgPath, $true)
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    } catch { }
}
function Invoke-AesEncryptFile {
    param([string]$InPath, [string]$OutPath, [string]$Password)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $salt = New-Object byte[] 16
    $iv = New-Object byte[] 16
    $rng.GetBytes($salt)
    $rng.GetBytes($iv)
    $rng.Dispose()
    $aes = [System.Security.Cryptography.Aes]::Create()
    $aes.KeySize = 256
    $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes($Password, $salt, 100000, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $aes.Key = $kdf.GetBytes(32)
    $kdf.Dispose()
    $aes.IV = $iv
    $inFs = $null
    $outFs = $null
    $cs = $null
    try {
        $outFs = [System.IO.File]::Create($OutPath)
        $outFs.Write($salt, 0, 16)
        $outFs.Write($iv, 0, 16)
        $cs = New-Object System.Security.Cryptography.CryptoStream($outFs, $aes.CreateEncryptor(), [System.Security.Cryptography.CryptoStreamMode]::Write)
        $inFs = [System.IO.File]::Open($InPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $buf = New-Object byte[] 262144
        while ($true) {
            $r = $inFs.Read($buf, 0, $buf.Length)
            if ($r -le 0) { break }
            $cs.Write($buf, 0, $r)
            Tick-MirrorBytes $r
            Flush-MirrorProgress
        }
        $cs.FlushFinalBlock()
    } finally {
        if ($inFs) { $inFs.Dispose() }
        if ($cs) { $cs.Dispose() }
        if ($outFs) { $outFs.Dispose() }
        $aes.Dispose()
    }
}
function Get-GofileHostList {
    $hosts = @()
    try {
        $r = Invoke-WebRequest -Uri 'https://api.gofile.io/servers' -UseBasicParsing -TimeoutSec 15 -Headers @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } -ErrorAction Stop
        $j = $null
        try { $j = ([string]$r.Content | ConvertFrom-Json) } catch { }
        if ($j -and $j.status -eq 'ok' -and $j.data -and $j.data.servers) {
            foreach ($s in $j.data.servers) {
                if ($s.name) { $hosts += [string]$s.name }
            }
        }
    } catch {
        Add-MirrorLog ('[gofile] servers endpoint unavailable ({0}); continuing with direct store hosts' -f $_.Exception.Message)
    }
    if ($hosts.Count -eq 0) {
        $hosts += 'store1'
        $hosts += 'store2'
        $hosts += 'store3'
    }
    foreach ($h in $global:GhrdpGofileHosts) {
        if ($hosts -notcontains $h) { $hosts += $h }
    }
    return @($hosts)
}
function Send-GofileStreamed {
    param([string]$EncPath, [string]$DispName)
    $hosts = Get-GofileHostList
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        foreach ($srv in $hosts) {
            $url = 'https://' + $srv + '.gofile.io/contents/uploadfile'
            Add-MirrorLog ('[gofile] attempt {0} via {1}' -f $attempt, $srv)
            try {
                $boundary = 'ghrdp' + [guid]::NewGuid().ToString('N')
                $iso = [System.Text.Encoding]::GetEncoding('iso-8859-1')
                $head = $iso.GetBytes("--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"$DispName`"`r`nContent-Type: application/octet-stream`r`n`r`n")
                $foot = $iso.GetBytes("`r`n--$boundary--`r`n")
                $req = [System.Net.HttpWebRequest]::Create($url)
                $req.Method = 'POST'
                $req.ContentType = 'multipart/form-data; boundary=' + $boundary
                $req.AllowWriteStreamBuffering = $false
                $req.SendChunked = $true
                $req.Timeout = 900000
                $req.ReadWriteTimeout = 900000
                $req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                $req.Accept = 'application/json, text/plain, */*'
                $req.Headers.Add('Origin', 'https://gofile.io')
                $req.Referer = 'https://gofile.io/'
                $rs = $req.GetRequestStream()
                try {
                    $rs.Write($head, 0, $head.Length)
                    $fs = [System.IO.File]::Open($EncPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                    try {
                        $buf = New-Object byte[] 262144
                        while ($true) {
                            $r = $fs.Read($buf, 0, $buf.Length)
                            if ($r -le 0) { break }
                            $rs.Write($buf, 0, $r)
                            Tick-MirrorBytes $r
                            Flush-MirrorProgress
                        }
                    } finally { $fs.Dispose() }
                    $rs.Write($foot, 0, $foot.Length)
                } finally { $rs.Dispose() }
                $resp = $req.GetResponse()
                try {
                    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
                    $raw = $sr.ReadToEnd()
                    $sr.Dispose()
                } finally { $resp.Dispose() }
                $j = $null
                try { $j = $raw | ConvertFrom-Json } catch { }
                if ($j -and ($j.status -eq 'ok') -and $j.data) {
                    $link = $null
                    if ($j.data.downloadPage) { $link = [string]$j.data.downloadPage }
                    elseif ($j.data.code) { $link = 'https://gofile.io/d/' + $j.data.code }
                    elseif ($j.data.id) { $link = 'https://gofile.io/d/' + $j.data.id }
                    if ($link) {
                        Add-MirrorLog ('[gofile] OK via {0}: {1}' -f $srv, $link)
                        return $link
                    }
                }
                Add-MirrorLog ('[gofile] {0} rejected: {1}' -f $srv, (($raw -replace '\s+', ' ').Trim()))
            } catch {
                Add-MirrorLog ('[gofile] {0} error: {1}' -f $srv, $_.Exception.Message)
            }
        }
        $backoff = [math]::Min(60, [math]::Pow(2, $attempt) * 2)
        Add-MirrorLog ('[gofile] all gofile hosts failed this round; exponential backoff {0}s' -f $backoff)
        Start-Sleep -Seconds $backoff
    }
    return $null
}
function Send-CurlUpload {
    param([string]$EncPath, [string]$DispName)
    $trials = @(
        @{ name = 'gofile-curl'; args = @('-sS', '--max-time', '3600', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', '-H', 'Origin: https://gofile.io', '-H', 'Referer: https://gofile.io/', '-F', ('file=@{0};filename={1}' -f $EncPath, $DispName), 'https://store1.gofile.io/contents/uploadfile') },
        @{ name = '0x0.st'; args = @('-sS', '--max-time', '3600', '-F', ('file=@{0};filename={1}' -f $EncPath, $DispName), 'https://0x0.st') },
        @{ name = 'catbox.moe'; args = @('-sS', '--max-time', '3600', '-F', 'reqtype=fileupload', '-F', ('fileToUpload=@{0};filename={1}' -f $EncPath, $DispName), 'https://catbox.moe/user/api.php') },
        @{ name = 'tmpfiles.org'; args = @('-sS', '--max-time', '3600', '-F', ('file=@{0};filename={1}' -f $EncPath, $DispName), 'https://tmpfiles.org/api/v1/upload') },
        @{ name = 'file.io'; args = @('-sS', '--max-time', '3600', '-F', ('file=@{0};filename={1}' -f $EncPath, $DispName), 'https://file.io/?expires=14d') }
    )
    foreach ($t in $trials) {
        Add-MirrorLog ('[upload] trying fallback host {0}' -f $t.name)
        try {
            $argList = @($t.args)
            $raw = & curl.exe @argList 2>$null
            $LASTEXITCODE = 0
            if ($raw) {
                $raw = ([string]($raw -join '')).Trim()
                $link = $null
                if ($raw -match '^https?://\S+$') { $link = $raw }
                else {
                    $j = $null
                    try { $j = $raw | ConvertFrom-Json } catch { }
                    if ($j) {
                        if ($j.url) { $link = [string]$j.url }
                        elseif ($j.data -and $j.data.url) { $link = [string]$j.data.url }
                        elseif ($j.data -and $j.data.downloadPage) { $link = [string]$j.data.downloadPage }
                        elseif ($j.data -and $j.data.code) { $link = 'https://gofile.io/d/' + [string]$j.data.code }
                        elseif ($j.link) { $link = [string]$j.link }
                    }
                }
                if (($t.name -eq 'tmpfiles.org') -and $link -and ($link -match '^https://tmpfiles\.org/')) {
                    $link = $link -replace '^https://tmpfiles\.org/', 'https://tmpfiles.org/dl/'
                }
                if ($link) {
                    Add-MirrorLog ('[upload] OK via {0}: {1}' -f $t.name, $link)
                    return $link
                }
                Add-MirrorLog ('[upload] {0} unrecognized response: {1}' -f $t.name, $raw.Substring(0, [math]::Min(120, $raw.Length)))
            } else {
                Add-MirrorLog ('[upload] {0} empty response' -f $t.name)
            }
        } catch {
            Add-MirrorLog ('[upload] {0} error: {1}' -f $t.name, $_.Exception.Message)
        }
        Start-Sleep -Seconds 2
    }
    return $null
}
function Send-PreviewCopy {
    param([string]$Path, [string]$DispName, [long]$MaxBytes = 157286400)
    try { if ((Get-Item -LiteralPath $Path).Length -gt $MaxBytes) { return '' } } catch { return '' }
    $trials = @(
        @{ name = 'litter.catbox.moe'; args = @('-sS', '--max-time', '1800', '-F', ('fileToUpload=@{0};filename={1}' -f $Path, $DispName), 'https://litter.catbox.moe/') },
        @{ name = 'catbox.moe'; args = @('-sS', '--max-time', '1800', '-F', 'reqtype=fileupload', '-F', ('fileToUpload=@{0};filename={1}' -f $Path, $DispName), 'https://catbox.moe/user/api.php') },
        @{ name = '0x0.st'; args = @('-sS', '--max-time', '1800', '-F', ('file=@{0};filename={1}' -f $Path, $DispName), 'https://0x0.st') }
    )
    foreach ($t in $trials) {
        try {
            $raw = (& curl.exe @($t.args) 2>$null) -join ''
            $LASTEXITCODE = 0
            $raw = ([string]$raw).Trim()
            if ($raw -match '^https?://\S+$') { Add-MirrorLog ('[preview] preview copy on {0}: {1}' -f $t.name, $raw); return $raw }
        } catch { }
    }
    return ''
}
function Send-AnyUpload {
    param([string]$EncPath, [string]$DispName)
    $link = Send-GofileStreamed -EncPath $EncPath -DispName $DispName
    if (-not $link) {
        Add-MirrorLog '[upload] gofile exhausted; using fallback hosts'
        $link = Send-CurlUpload -EncPath $EncPath -DispName $DispName
    }
    return $link
}
function Get-MirrorDoneMap {
    param([string]$DoneFile)
    $map = @{}
    try {
        if (Test-Path -LiteralPath $DoneFile) {
            $b = [System.IO.File]::ReadAllBytes($DoneFile)
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
            $txt = [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
            foreach ($ln in ($txt -split "`n")) {
                $ln = $ln.Trim("`r").Trim()
                if (-not $ln) { continue }
                $pipe = $ln.IndexOf('|')
                if ($pipe -gt 0) {
                    $sz = [long]0
                    if ([long]::TryParse($ln.Substring(0, $pipe), [ref]$sz)) { $map[$ln.Substring($pipe + 1).ToLower()] = $sz }
                }
            }
        }
    } catch { }
    return $map
}
function Add-MirrorDone {
    param([string]$DoneFile, [string]$Path, [long]$Size)
    try { [System.IO.File]::AppendAllText($DoneFile, ('{0}|{1}' -f $Size, $Path) + "`r`n", $global:GhrdpEncNoBom) } catch { }
}
function Get-MirrorIndexList {
    param([string]$IdxFile)
    $arr = New-Object System.Collections.ArrayList
    try {
        if (Test-Path -LiteralPath $IdxFile) {
            $b = [System.IO.File]::ReadAllBytes($IdxFile)
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
            $j = ([System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)) | ConvertFrom-Json
            foreach ($it in @($j)) { [void]$arr.Add($it) }
        }
    } catch { }
    return , $arr
}
function Save-MirrorIndexList {
    param([string]$IdxFile, $List)
    try {
        $json = ConvertTo-Json -InputObject @($List) -Depth 6
        [System.IO.File]::WriteAllText($IdxFile, $json, $global:GhrdpEncNoBom)
    } catch { }
}
function Get-RunnerEgressIp {
    foreach ($u in @('https://api.ipify.org', 'https://ifconfig.me/ip')) {
        try {
            $r = & curl.exe -s --max-time 10 $u 2>$null
            $LASTEXITCODE = 0
            $ip = ([string]($r -join '')).Trim()
            if ($ip -match '^(\d{1,3}\.){3}\d{1,3}$') { return $ip }
        } catch { }
    }
    return ''
}
function Invoke-LegacyScrape {
    param([string]$Url)
    $result = @{ key = ''; links = @(); ok = $false }
    try {
        $raw = & curl.exe -sL --max-time 10 $Url 2>$null
        $LASTEXITCODE = 0
        $html = [string]($raw -join "`n")
        if (-not $html) { return $result }
        if ($html -match '(?i)LEGACY\s+decrypt\s+key[^A-Za-z0-9]{0,40}([A-Za-z0-9]{16,64})') { $result.key = $Matches[1] }
        elseif ($html -match '(?i)current\s+decrypt\s+key[^A-Za-z0-9]{0,40}([A-Za-z0-9]{16,64})') { $result.key = $Matches[1] }
        elseif ($html -match '(?i)decrypt\s+(?:password|pw|key)[^A-Za-z0-9]{0,40}([A-Za-z0-9]{16,64})') { $result.key = $Matches[1] }
        $links = [regex]::Matches($html, 'https?://(?:gofile\.io/d/[A-Za-z0-9]+|tmpfiles\.org/dl/[A-Za-z0-9/]+|0x0\.st/\S+|catbox\.moe/\S+|litter\.catbox\.moe/\S+|file\.io/\S+)') | ForEach-Object { $_.Value }
        $result.links = @($links | Select-Object -Unique)
        $result.ok = $true
    } catch { }
    return $result
}
function Build-IndexBodyText {
    param($Cfg, $IndexList)
    $sb = New-Object System.Text.StringBuilder
    $encMode = [string]$Cfg.encryptMode
    if (-not $encMode) { $encMode = 'none' }
    $encLabel = if ($encMode -eq 'none') { 'unencrypted' } elseif ($encMode -eq 'media-plain') { 'mixed (media plain, rest AES-256)' } else { 'AES-256 encrypted' }
    $shown = @()
    if ($null -ne $IndexList) { $shown = @($IndexList) }
    $groups = [ordered]@{}
    foreach ($it in @($shown)) {
        $fd = [string]$it.folder
        if (-not $fd) { $fd = '.' }
        if (-not $groups.Contains($fd)) { $groups[$fd] = New-Object System.Collections.ArrayList }
        [void]$groups[$fd].Add($it)
    }
    [void]$sb.AppendLine('# GitHub RDP - mirrored files (live index)')
    [void]$sb.AppendLine('====================================')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine(('Main Rentry (myurl0): ' + $global:GhrdpLegacyUrl))
    if ([string]$Cfg.mirrorIndexUrl) { [void]$sb.AppendLine(('Telegraph: ' + [string]$Cfg.mirrorIndexUrl)) }
    if ([string]$Cfg.rentryNewUrl) { [void]$sb.AppendLine(('Mirror Rentry: ' + [string]$Cfg.rentryNewUrl)) }
    [void]$sb.AppendLine('')
    if ([string]$Cfg.legacyDecryptKey) {
        [void]$sb.AppendLine(('LEGACY decrypt key (files uploaded before this run): ' + [string]$Cfg.legacyDecryptKey))
    }
    if ($encMode -ne 'none') {
        [void]$sb.AppendLine(('Current decrypt key (this run): ' + [string]$Cfg.mirrorKey))
    }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('## FOLDERS - quick overview (no scrolling needed)')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('| # | Folder | Files | Total size |')
    [void]$sb.AppendLine('| ---: | --- | ---: | ---: |')
    $gi = 1
    foreach ($g in $groups.Keys) {
        $items = $groups[$g]
        $bytes = [long]0
        foreach ($it in $items) { $bytes += [long]$it.size }
        [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} |' -f $gi, $g, $items.Count, (Get-HumanBytes $bytes)))
        $gi++
    }
    [void]$sb.AppendLine('')
    foreach ($g in $groups.Keys) {
        $items = $groups[$g]
        [void]$sb.AppendLine(('## Folder: ' + $g))
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('| # | File | Size | Uploaded (SL time) | Enc | Direct link |')
        [void]$sb.AppendLine('| ---: | --- | ---: | --- | :-: | --- |')
        $i = 1
        foreach ($it in $items) {
            $tsl = if ([string]$it.timeSL) { [string]$it.timeSL } else { (Convert-ToSL $it.time) }
            $encStr = if ([string]$it.encrypted -eq 'true') { 'yes' } else { 'no' }
            [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} | {4} | {5} |' -f $i, [string]$it.name, (Get-HumanBytes ([long]$it.size)), $tsl, $encStr, ([string]$it.link)))
            $i++
        }
        [void]$sb.AppendLine('')
    }
    if ($Cfg.legacyLinks -and @($Cfg.legacyLinks).Count -gt 0) {
        [void]$sb.AppendLine('## LEGACY LINKS (older runs)')
        foreach ($l in @($Cfg.legacyLinks)) { [void]$sb.AppendLine(('- ' + [string]$l)) }
        [void]$sb.AppendLine('')
    }
    [void]$sb.AppendLine('## How to decrypt (.ghenc files)')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('Only needed when the file name ends with `.ghenc`. Plain files stream directly on gofile.')
    [void]$sb.AppendLine('1. Download the .ghenc file.')
    [void]$sb.AppendLine('2. Open PowerShell, run the one-liner below; when asked for Password paste the decrypt key above.')
    [void]$sb.AppendLine('3. Output = same file name without .ghenc.')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine(('powershell -c "& { $p=Read-Host ''Password''; $s=[IO.File]::ReadAllBytes($args[0]); $kdf=[Security.Cryptography.Rfc2898DeriveBytes]::new($p,$s[0..15],100000,''SHA256''); $a=[Security.Cryptography.Aes]::Create(); $a.Key=$kdf.GetBytes(32); $a.IV=$s[16..31]; $d=$a.CreateDecryptor(); $ms=[IO.MemoryStream]::new(); $cs=[Security.Cryptography.CryptoStream]::new($ms,$d,''Write''); $cs.Write($s,32,$s.Length-32); $cs.FlushFinalBlock(); [IO.File]::WriteAllBytes(($args[0] -replace ''\.ghenc$'',''''), $ms.ToArray()) }" FILE.ghenc'))
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine(('Runner egress used for uploads: ' + $(if ([string]$Cfg.runnerEgressIp) { [string]$Cfg.runnerEgressIp } else { 'unknown' })))
    return $sb.ToString()
}
function Invoke-TelegraphPost {
    param([string]$Method, [hashtable]$Fields)
    try {
        $json = ConvertTo-Json -InputObject $Fields -Depth 12 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        return (Invoke-RestMethod -Method Post -Uri ('https://api.telegra.ph/' + $Method) -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30)
    } catch {
        Add-MirrorLog ('[telegraph] {0} error: {1}' -f $Method, $_.Exception.Message)
        return $null
    }
}
function Publish-TelegraphIndex {
    param($Cfg, $IndexList)
    $nodes = New-Object System.Collections.ArrayList
    $encMode = [string]$Cfg.encryptMode
    if (-not $encMode) { $encMode = 'none' }
    $encLabel = if ($encMode -eq 'none') { 'unencrypted' } elseif ($encMode -eq 'media-plain') { 'mixed' } else { 'AES-256' }
    $shown = @()
    if ($null -ne $IndexList) { $shown = @($IndexList) }
    $groups = [ordered]@{}
    foreach ($it in @($shown)) {
        $fd = [string]$it.folder
        if (-not $fd) { $fd = '.' }
        if (-not $groups.Contains($fd)) { $groups[$fd] = New-Object System.Collections.ArrayList }
        [void]$groups[$fd].Add($it)
    }
    [void]$nodes.Add(@{ tag = 'h3'; children = @('GHRDP file mirror (' + $encLabel + ')') })
    [void]$nodes.Add(@{ tag = 'p'; children = @('Main Rentry (myurl0): ', @{ tag = 'a'; attrs = @{ href = $global:GhrdpLegacyUrl }; children = @($global:GhrdpLegacyUrl) }) })
    if ([string]$Cfg.legacyDecryptKey) {
        [void]$nodes.Add(@{ tag = 'p'; children = @(('LEGACY decrypt key (older runs): ' + [string]$Cfg.legacyDecryptKey)) })
    }
    if ($encMode -ne 'none') {
        [void]$nodes.Add(@{ tag = 'p'; children = @(('Current decrypt key (this run): ' + [string]$Cfg.mirrorKey)) })
    }
    [void]$nodes.Add(@{ tag = 'h4'; children = @('FOLDERS - quick overview (no scrolling needed)') })
    foreach ($g in $groups.Keys) {
        $items = $groups[$g]
        $bytes = [long]0
        foreach ($it in $items) { $bytes += [long]$it.size }
        [void]$nodes.Add(@{ tag = 'p'; children = @(($g + '  -  ' + $items.Count + ' file(s), ' + (Get-HumanBytes $bytes))) })
    }
    foreach ($g in $groups.Keys) {
        $items = $groups[$g]
        [void]$nodes.Add(@{ tag = 'h4'; children = @('Folder: ' + $g) })
        foreach ($it in $items) {
            $tsl = if ([string]$it.timeSL) { [string]$it.timeSL } else { (Convert-ToSL $it.time) }
            $encStr = if ([string]$it.encrypted -eq 'true') { ' [encrypted]' } else { '' }
            $kids = New-Object System.Collections.ArrayList
            [void]$kids.Add(([string]$it.name + $encStr + '  (' + (Get-HumanBytes ([long]$it.size)) + ', ' + $tsl + ') '))
            if ($it.link) { [void]$kids.Add(@{ tag = 'a'; attrs = @{ href = [string]$it.link }; children = @('download') }) }
            [void]$nodes.Add(@{ tag = 'p'; children = $kids })
        }
    }
    if ($Cfg.legacyLinks -and @($Cfg.legacyLinks).Count -gt 0) {
        [void]$nodes.Add(@{ tag = 'h4'; children = @('LEGACY LINKS (older runs)') })
        foreach ($l in @($Cfg.legacyLinks)) {
            [void]$nodes.Add(@{ tag = 'p'; children = @(@{ tag = 'a'; attrs = @{ href = [string]$l }; children = @([string]$l) }) })
        }
    }
    [void]$nodes.Add(@{ tag = 'h4'; children = @('How to decrypt (.ghenc)') })
    [void]$nodes.Add(@{ tag = 'p'; children = @('Only files ending in .ghenc need decrypt. Download it, then in PowerShell run the one-liner from the myurl0 page; password = the decrypt key above. Output = same name without .ghenc. Plain files stream directly on gofile.') })
    [void]$nodes.Add(@{ tag = 'p'; children = @(('Runner egress used for uploads: ' + $(if ([string]$Cfg.runnerEgressIp) { [string]$Cfg.runnerEgressIp } else { 'unknown' }))) })
    try {
        if (-not $Cfg.telegraphToken) {
            $acc = Invoke-TelegraphPost -Method 'createAccount' -Fields @{ short_name = 'ghrdp'; author_name = 'ghrdp' }
            if ($acc -and $acc.ok) { $Cfg.telegraphToken = [string]$acc.result.access_token }
        }
        if ($Cfg.telegraphToken) {
            if (-not $Cfg.telegraphPath) {
                $pg = Invoke-TelegraphPost -Method 'createPage' -Fields @{ access_token = [string]$Cfg.telegraphToken; title = 'GHRDP file mirror'; content = @($nodes) }
                if ($pg -and $pg.ok) { $Cfg.telegraphPath = [string]$pg.result.path; $Cfg.mirrorIndexUrl = [string]$pg.result.url }
            } else {
                $pg = Invoke-TelegraphPost -Method 'editPage' -Fields @{ access_token = [string]$Cfg.telegraphToken; path = [string]$Cfg.telegraphPath; title = 'GHRDP file mirror'; content = @($nodes) }
                if ($pg -and $pg.ok) { $Cfg.mirrorIndexUrl = [string]$pg.result.url }
            }
        }
    } catch {
        Add-MirrorLog ('[telegraph] error: ' + $_.Exception.Message)
    }
}
function Get-RentryCsrf {
    param([string]$Jar)
    $csrf = ''
    try {
        $homePage = (& curl.exe -sL -c $Jar --max-time 15 'https://rentry.co' 2>$null) -join "`n"
        $LASTEXITCODE = 0
        if ($homePage -match 'name="csrfmiddlewaretoken"\s+value="([^"]+)"') { $csrf = $Matches[1] }
        if (-not $csrf) {
            try {
                $jarLines = Get-Content -LiteralPath $Jar -ErrorAction SilentlyContinue
                foreach ($jl in $jarLines) {
                    if ($jl -match 'csrftoken\s+(\S+)$') { $csrf = $Matches[1]; break }
                }
            } catch { }
        }
    } catch { }
    return $csrf
}
function Edit-RentryPage {
    param([string]$PageCode, [string]$EditCode, [string]$NewText, [string]$EditCookie)
    $editUrl = 'https://rentry.co/' + $PageCode + '/edit'
    $jar = Join-Path $env:TEMP ('ghrdp-jar-' + [guid]::NewGuid().ToString('N') + '.txt')
    $csrf = Get-RentryCsrf -Jar $jar
    if (-not $csrf) {
        Add-MirrorLog ('[rentry] CSRF fetch failed for edit of ' + $PageCode)
        Remove-Item -LiteralPath $jar -Force -ErrorAction SilentlyContinue
        return $false
    }
    $bodyFile = Join-Path $env:TEMP ('ghrdp-edit-' + [guid]::NewGuid().ToString('N') + '.txt')
    [System.IO.File]::WriteAllText($bodyFile, $NewText, $global:GhrdpEncNoBom)
    $eargs = @('-s', '--max-time', '30', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', '-b', $jar, '-e', $editUrl)
    if ($EditCookie) { $eargs += @('-H', ('Cookie: ' + $EditCookie)) }
    $eargs += @('-X', 'POST', $editUrl)
    $eargs += @('--data-urlencode', ('csrfmiddlewaretoken=' + $csrf))
    $eargs += @('--data-urlencode', ('edit_code=' + $EditCode))
    $eargs += @('--data-urlencode', ('text@' + $bodyFile))
    $eargs += @('-L', '-w', "`n%{http_code} %{url_effective}")
    $eout = (& curl.exe @eargs 2>$null) -join "`n"
    $LASTEXITCODE = 0
    Remove-Item -LiteralPath $jar, $bodyFile -Force -ErrorAction SilentlyContinue
    $lastLine = ($eout -split "`n" | Where-Object { $_ -match '^\d{3} https?://' } | Select-Object -Last 1)
    $httpCode = ''; $finalUrl = ''
    if ($lastLine -match '^(\d{3})\s+(\S+)') { $httpCode = $Matches[1]; $finalUrl = $Matches[2] }
    $editOk = ($httpCode -eq '200') -and ($finalUrl -notmatch '/edit$') -and ($finalUrl -match [regex]::Escape($PageCode))
    if ($editOk) {
        Add-MirrorLog ('[rentry] edited ' + $PageCode + ' OK (http ' + $httpCode + ' -> ' + $finalUrl + ')')
        return $true
    }
    Add-MirrorLog ('[rentry] edit ' + $PageCode + ' FAILED (http=' + $httpCode + ' final=' + $finalUrl + ') - edit code wrong or CSRF blocked')
    return $false
}
function Edit-MainRentry {
    param($Cfg, [string]$BodyText, $IndexList = $null)
    $legacyCode = ($global:GhrdpLegacyUrl -replace '^https://rentry\.co/', '')
    $editCode = [string]$Cfg.rentryEditCode
    if (-not $editCode) { $editCode = [string]$env:RENTRY_MAIN_EDIT }
    if (-not $editCode) { Add-MirrorLog '[rentry] no edit code for myurl0 - skipping edit (new page + telegraph carry index)'; return $false }
    $jar = Join-Path $env:TEMP ('ghrdp-jar-' + [guid]::NewGuid().ToString('N') + '.txt')
    $csrf = Get-RentryCsrf -Jar $jar
    if (-not $csrf) { Add-MirrorLog '[rentry] CSRF fetch failed for myurl0'; Remove-Item -LiteralPath $jar -Force -ErrorAction SilentlyContinue; return $false }
    $bf = Join-Path $env:TEMP ('ghrdp-edit-' + [guid]::NewGuid().ToString('N') + '.txt')
    [System.IO.File]::WriteAllText($bf, $BodyText, $global:GhrdpEncNoBom)
    $ok = $false
    $endpoints = @(
        @{ name = 'api/edit'; url = 'https://rentry.co/api/edit'; needsPageCode = $true },
        @{ name = 'form'; url = ('https://rentry.co/' + $legacyCode + '/edit'); needsPageCode = $false }
    )
    foreach ($ep in $endpoints) {
        $a2 = @('-s', '--max-time', '40', '-b', $jar, '-e', 'https://rentry.co/', '-X', 'POST', $ep.url)
        $a2 += @('--data-urlencode', ('csrfmiddlewaretoken=' + $csrf))
        $a2 += @('--data-urlencode', ('edit_code=' + $editCode))
        if ($ep.needsPageCode) { $a2 += @('--data-urlencode', ('url=' + $legacyCode)) }
        $a2 += @('--data-urlencode', ('text@' + $bf))
        if ([string]$Cfg.rentryEditCookie) { $a2 += @('-H', ('Cookie: ' + [string]$Cfg.rentryEditCookie)) }
        $out = (& curl.exe @a2 2>$null) -join "`n"
        $LASTEXITCODE = 0
        Start-Sleep -Seconds 2
        $raw2 = ''
        try { $raw2 = (& curl.exe -sL --max-time 15 ('https://rentry.co/' + $legacyCode + '/raw') 2>$null) -join "`n"; $LASTEXITCODE = 0 } catch { }
        if ($raw2 -match 'live index|mirrored files') {
            $ok = $true
            Add-MirrorLog ('[rentry] myurl0 updated+verified via ' + $ep.name + ' ({0} files listed)' -f @($IndexList).Count)
            break
        }
        Add-MirrorLog ('[rentry] edit via ' + $ep.name + ' NOT verified; head: ' + $out.Substring(0, [math]::Min(120, $out.Length)))
    }
    Remove-Item -LiteralPath $jar, $bf -Force -ErrorAction SilentlyContinue
    if (-not $ok) { Add-MirrorLog '[rentry] myurl0 edit FAILED verification - legacy untouched; index carried by new page + telegraph' }
    return $ok
}
function Publish-SearchPage {
    param($Cfg, $IndexList, [string]$Root)
    $tokFile = Join-Path $Root 'gh-pages-token.txt'
    if (-not (Test-Path -LiteralPath $tokFile)) { Add-MirrorLog '[search] no gh-pages token - skipping web pages'; return }
    $token = ([System.IO.File]::ReadAllText($tokFile)).Trim()
    $repo = [string]$Cfg.repo
    if (-not $repo -or -not $token) { return }
    $tmp = Join-Path $env:TEMP ('ghpages-' + [guid]::NewGuid().ToString('N'))
    $cloneUrl = ('https://x-access-token:' + $token + '@github.com/' + $repo + '.git')
    & git.exe clone --depth 1 $cloneUrl $tmp 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Add-MirrorLog '[search] git clone failed - skipping web pages'; return }
    $docs = Join-Path $tmp 'docs'
    New-Item -ItemType Directory -Path $docs -Force | Out-Null
    $data = @()
    foreach ($it in @($IndexList)) { $data += [ordered]@{ n = [string]$it.name; f = [string]$it.folder; s = [long]$it.size; d = [string]$it.time; dsl = [string]$it.timeSL; e = [string]$it.encrypted; l = [string]$it.link; p = [string]$it.preview; st = [string]$it.status } }
    $json = ConvertTo-Json -InputObject @($data) -Depth 4 -Compress
    $sb2 = New-Object System.Text.StringBuilder
    [void]$sb2.Append('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    [void]$sb2.Append('<title>GHRDP mirror - search</title>')
    [void]$sb2.Append('<style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef3;margin:0;padding:24px}h1{font-size:22px}#q{width:100%;padding:12px 16px;border-radius:12px;border:1px solid #2b3a4a;background:#101820;color:#e8eef3;font-size:15px;outline:none}#q:focus{border-color:#22d3ee}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1e2a36}th{color:#8aa0ad}a{color:#7dd3fc}#cnt{color:#8aa0ad;font-size:12px;margin-top:8px}</style>')
    [void]$sb2.Append('</head><body><h1>GHRDP mirror - live search</h1>')
    [void]$sb2.Append('<input id="q" type="search" placeholder="Type to filter files..." autocomplete="off"><div id="cnt"></div>')
    [void]$sb2.Append('<table><thead><tr><th>File</th><th>Size</th><th>Date</th><th>Enc</th><th>Link</th></tr></thead><tbody id="tb"></tbody></table>')
    [void]$sb2.Append('<script>const DATA=')
    [void]$sb2.Append($json)
    [void]$sb2.Append(';const tb=document.getElementById("tb"),q=document.getElementById("q"),cnt=document.getElementById("cnt");')
    [void]$sb2.Append('function fmt(n){n=+n||0;if(n<1024)return n+" B";var u=["KB","MB","GB","TB"];var i=-1;do{n/=1024;i++;}while(n>=1024&&i<u.length-1);return n.toFixed(1)+" "+u[i]}')
    [void]$sb2.Append('function draw(f){tb.innerHTML=f.map(function(r){return "<tr><td>"+r.n+"</td><td>"+fmt(r.s)+"</td><td>"+r.d+"</td><td>"+(r.e==="true"?"yes":"no")+"</td><td><a href=\""+r.l+"\" target=\"_blank\">open</a></td></tr>"}).join("");cnt.textContent=f.length+" file(s)"}')
    [void]$sb2.Append('q.addEventListener("input",function(){var v=q.value.toLowerCase();draw(DATA.filter(function(r){return r.n.toLowerCase().indexOf(v)!==-1}))});draw(DATA);')
    [void]$sb2.Append('</script></body></html>')
    $searchHtml = $sb2.ToString()
    [System.IO.File]::WriteAllText((Join-Path $docs 'search.html'), $searchHtml, $global:GhrdpEncNoBom)
    $snapshot = [ordered]@{
        ts = (Get-Date).ToUniversalTime().ToString('o')
        runId = [string]$env:GITHUB_RUN_ID
        runUrl = ('https://github.com/' + $repo + '/actions/runs/' + [string]$env:GITHUB_RUN_ID)
        mirror = [bool]$Cfg.mirror
        encryptMode = [string]$Cfg.encryptMode
        mirrorKey = [string]$Cfg.mirrorKey
        legacyDecryptKey = [string]$Cfg.legacyDecryptKey
        mirrorIndexUrl = [string]$Cfg.mirrorIndexUrl
        pagesBase = [string]$Cfg.searchUrl
        dashUrl = ('http://' + [string]$Cfg.rdpIp + ':7331/')
        creds = [ordered]@{ user = [string]$Cfg.rdpUser; pass = [string]$Cfg.rdpPass }
        svc = [ordered]@{ ts = 'see-dash'; rdp = 'see-dash'; ps = 'see-dash'; rust = 'see-dash' }
        files = $data
    }
    $tplPath = Join-Path $Root 'web-index-template.html'
    if (Test-Path -LiteralPath $tplPath) {
        $tpl = [System.IO.File]::ReadAllText($tplPath, [System.Text.Encoding]::UTF8)
        $tpl = $tpl.Replace('__DATA__', (ConvertTo-Json -InputObject $snapshot -Depth 6 -Compress))
        [System.IO.File]::WriteAllText((Join-Path $docs 'index.html'), $tpl, $global:GhrdpEncNoBom)
    }
    $arcPath = Join-Path $docs 'archive.json'
    $sessions = @()
    try { if (Test-Path -LiteralPath $arcPath) { $aj = Get-Content -LiteralPath $arcPath -Raw | ConvertFrom-Json; $sessions = @($aj.sessions) } } catch { }
    $sessions = @($sessions | Where-Object { [string]$_.runId -ne [string]$env:GITHUB_RUN_ID })
    $sessions += [ordered]@{ runId = [string]$env:GITHUB_RUN_ID; startedAt = [string]$Cfg.sessionStartedAt; filesCount = @($data).Count; key = [string]$Cfg.mirrorKey; telegraphUrl = [string]$Cfg.mirrorIndexUrl; files = $data }
    [System.IO.File]::WriteAllText($arcPath, (ConvertTo-Json -InputObject @{ sessions = $sessions; updated = (Get-Date -Format o) } -Depth 6 -Compress), $global:GhrdpEncNoBom)
    & git.exe -C $tmp add docs/search.html docs/index.html docs/archive.json 2>$null | Out-Null
    & git.exe -C $tmp -c user.email=ghrdp@local -c user.name=ghrdp-bot commit -m "update mirror web pages" 2>$null | Out-Null
    & git.exe -C $tmp push origin HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Add-MirrorLog ('[search] web pages pushed: ' + [string]$Cfg.searchUrl) } else { Add-MirrorLog '[search] git push failed (Pages may be off)' }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
function Publish-MirrorRentry {
    param($Cfg, [string]$BodyText, $IndexList = $null)
    $editCode = [string]$Cfg.rentryEditCode
    if (-not $editCode) { $editCode = [string]$env:RENTRY_EDIT_PASSWORD }
    if (-not $editCode) {
        Add-MirrorLog '[rentry] NO edit credential (RENTRY_EDIT_PASSWORD missing) - NO BYPASS: anonymous new-page creation refused. Rentry index skipped this round; Telegraph still published.'
        return $false
    }
    return (Edit-MainRentry -Cfg $Cfg -BodyText $BodyText -IndexList $IndexList)
}
function Publish-AllIndexes {
    param($Cfg, $IndexList)
    try { Publish-TelegraphIndex -Cfg $Cfg -IndexList $IndexList } catch {
        Add-MirrorLog ('[index] telegraph backup failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace)
    }
    try { [void](Publish-GithubPagesData -Cfg $Cfg -IndexList $IndexList) } catch {
        Add-MirrorLog ('[index] pages data.json failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace)
    }
    try {
        $bodyText = Build-IndexBodyText -Cfg $Cfg -IndexList $IndexList
        [void](Publish-MirrorRentry -Cfg $Cfg -BodyText $bodyText -IndexList $IndexList)
    } catch {
        Add-MirrorLog ('[index] rentry myurl0 edit failed: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace)
    }
    try {
        if ($global:GhrdpCfgPath) {
            $Cfg | Add-Member -NotePropertyName lastUpdateSL -NotePropertyValue (Get-SLTime) -Force
            Save-MirrorCfg -Cfg $Cfg -Path $global:GhrdpCfgPath
        }
    } catch { }
}
function Put-GhFile {
    param([string]$Repo, [string]$Path, [string]$Text, [string]$Token)
    $hdr = @{ Authorization = ('Bearer ' + $Token); Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $api = 'https://api.github.com/repos/' + $Repo + '/contents/docs/' + $Path
    $sha = $null
    try { $g = Invoke-RestMethod -Uri $api -Headers $hdr -ErrorAction Stop; $sha = $g.sha } catch { }
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
    $body = @{ message = ('ghrdp: update docs/' + $Path); content = $b64 }
    if ($sha) { $body.sha = $sha }
    Invoke-RestMethod -Uri $api -Headers $hdr -Method Put -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -ErrorAction Stop | Out-Null
}
function Publish-GithubPagesData {
    param($Cfg, $IndexList)
    $token = ''
    try { $token = ([System.IO.File]::ReadAllText('C:\ghrdp\gh-pages-token.txt')).Trim() } catch { }
    if (-not $token) { Add-MirrorLog '[pages] no token - skip data.json'; return $false }
    $files = @()
    foreach ($it in @($IndexList)) { $files += [ordered]@{ n = [string]$it.name; s = [long]$it.size; d = [string]$it.time; dsl = [string]$it.timeSL; e = [string]$it.encrypted; l = [string]$it.link; p = [string]$it.preview; f = [string]$it.folder } }
    $data = [ordered]@{
        ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
        sessionId = [string]$Cfg.sessionId
        mirror = [bool]$Cfg.mirror
        encryptMode = [string]$Cfg.encryptMode
        mirrorKey = [string]$Cfg.mirrorKey
        legacyKey = [string]$Cfg.legacyDecryptKey
        legacyLinks = @($Cfg.legacyLinks)
        telegraph = [string]$Cfg.mirrorIndexUrl
        pagesBase = [string]$Cfg.pagesBase
        files = $files
    }
    Put-GhFile -Repo ([string]$Cfg.repo) -Path 'data.json' -Text ($data | ConvertTo-Json -Depth 6 -Compress) -Token $token
    Add-MirrorLog '[pages] data.json pushed'
    $treeFiles = @()
    foreach ($it in @($IndexList)) { $treeFiles += [ordered]@{ n = [string]$it.name; f = [string]$it.folder; s = [long]$it.size; l = [string]$it.link; p = [string]$it.preview; e = [string]$it.encrypted; t = [string]$it.timeSL } }
    $treeObj = [ordered]@{ updated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'); sessionId = [string]$Cfg.sessionId; live = $true; files = $treeFiles }
    try { Put-GhFile -Repo ([string]$Cfg.repo) -Path 'tree.json' -Text ($treeObj | ConvertTo-Json -Depth 6 -Compress) -Token $token; Add-MirrorLog '[pages] tree.json pushed (explorer live tree)' } catch { Add-MirrorLog ('[pages] tree.json push failed: ' + $_.Exception.Message) }
    $liveFiles = @()
    foreach ($it in @($IndexList)) { $liveFiles += [ordered]@{ n = [string]$it.name; s = [long]$it.size; l = [string]$it.link; p = [string]$it.preview; e = [string]$it.encrypted; f = ([string]$it.folder) } }
    $liveBytes = [long]0
    foreach ($it in @($IndexList)) { $liveBytes += [long]$it.size }
    $live = [ordered]@{ id = ([string]$Cfg.sessionId); date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'); live = $true; filesCount = @($IndexList).Count; bytes = $liveBytes; key = [string]$Cfg.mirrorKey; telegraph = [string]$Cfg.mirrorIndexUrl; rentry = ''; files = $liveFiles }
    try { Put-GhFile -Repo ([string]$Cfg.repo) -Path 'live.json' -Text ($live | ConvertTo-Json -Depth 6 -Compress) -Token $token; Add-MirrorLog '[pages] live.json pushed (search page shows live session)' } catch { Add-MirrorLog ('[pages] live.json push failed: ' + $_.Exception.Message) }
    return $true
}
function Build-StatusObject {
    param($Cfg, $Prog, $Svc)
    $done = 0; $total = 0; $failed = 0; $spd = ''
    if ($Prog -and $Prog.agg) {
        $done = [int]$Prog.agg.done; $total = [int]$Prog.agg.total
        $failed = [int]$Prog.agg.failed; $spd = [string]$Prog.agg.speedBps
    }
    $wStr = 'OFF'
    if ($Prog -and [bool]$Prog.alive) {
        $age = $null
        try { if ($Prog.ts) { $age = [int]((Get-Date) - [datetime]$Prog.ts).TotalSeconds } } catch { }
        if (($null -ne $age) -and ($age -lt 15)) { $wStr = 'ACTIVE' } elseif ($null -ne $age) { $wStr = 'STALE' } else { $wStr = 'STALE' }
    } elseif ($Prog -and $total -gt 0) { $wStr = 'IDLE' }
    $started = $null
    try { if ($Cfg.startedAt) { $started = [datetime]$Cfg.startedAt } } catch { }
    $uptime = '-'; $remaining = '-'
    if ($started) {
        $elapsed = (Get-Date) - $started
        $uptime = [string]([int]$elapsed.TotalHours) + 'h ' + $elapsed.Minutes + 'm'
        $left = [math]::Max(0, 330 - [int]$elapsed.TotalMinutes)
        $remaining = [string]([int]($left / 60)) + 'h ' + [string]($left % 60) + 'm'
    }
    $ip = [string]$Cfg.rdpIp
    $dashUrl = ''
    if ($ip) { $dashUrl = 'http://' + $ip + ':7331/' }
    $runUrl = ''
    try { $runUrl = 'https://github.com/' + $env:GITHUB_REPOSITORY + '/actions/runs/' + $env:GITHUB_RUN_ID } catch { }
    return [ordered]@{
        ts = [long][double]::Parse((Get-Date -UFormat '%s'))
        sessionId = [string]$Cfg.sessionId
        uptime = $uptime; remaining = $remaining
        services = [ordered]@{
            tailscale = [string]$Svc.ts; rdp = [string]$Svc.rdp
            ps = [string]$Svc.ps; rust = [string]$Svc.rust; watcher = $wStr
        }
        mirror = [ordered]@{ done = $done; total = $total; failed = $failed; speed = $spd }
        creds = [ordered]@{ user = [string]$Cfg.rdpUser; pass = [string]$Cfg.rdpPass }
        dashUrl = $dashUrl; runUrl = $runUrl
    }
}
function Publish-StatusJson {
    param($StatusObj, $Repo, $Token)
    if (-not $Token) { return }
    $text = $StatusObj | ConvertTo-Json -Depth 6 -Compress
    $hdr = @{ Authorization = ('Bearer ' + $Token); Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $api = 'https://api.github.com/repos/' + $Repo + '/contents/docs/status.json'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $sha = $null
            try { $g = Invoke-RestMethod -Uri $api -Headers $hdr -ErrorAction Stop; $sha = $g.sha } catch { }
            $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
            $body = @{ message = 'status update'; content = $b64 }
            if ($sha) { $body.sha = $sha }
            Invoke-RestMethod -Uri $api -Headers $hdr -Method Put -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -ErrorAction Stop | Out-Null
            return
        } catch {
            if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
        }
    }
}
