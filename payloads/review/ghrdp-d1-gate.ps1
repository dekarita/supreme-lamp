[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'D1-config'
try {
    $config = Get-Content -LiteralPath 'C:\ghrdp\config.json' -Raw | ConvertFrom-Json
    $dash = (Get-Content -LiteralPath 'C:\ghrdp\dash-token.txt' -Raw).Trim()
    if (-not $dash) { throw 'Missing dashboard key.' }
    Write-Host ('::add-mask::' + $dash)
    $addr = $null
    if (-not [Net.IPAddress]::TryParse([string]$config.rdpIp, [ref]$addr)) { throw 'Invalid runner IP.' }
    $b = $addr.GetAddressBytes()
    if ($b.Length -ne 4 -or $b[0] -ne 100 -or $b[1] -lt 64 -or $b[1] -gt 127) { throw 'Runner IP is not in 100.64.0.0/10.' }
    $base = 'http://' + $addr.ToString() + ':7331'
    $key = [uri]::EscapeDataString($dash)
    Write-Host ('D1 base=' + $base + ' auth=dash-key (redacted)')
    function Url([string]$path) {
        $separator = '?'
        if ($path.Contains('?')) { $separator = '&' }
        return $base + $path + $separator + 'key=' + $key
    }
    function Get-Api([string]$path) { Invoke-RestMethod -Uri (Url $path) -TimeoutSec 5 }
    function Post-Api([string]$path, $body) {
        Invoke-RestMethod -Uri (Url $path) -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 5
    }
    $stage = 'D1-ping'
    $ping = Get-Api '/api/ping'
    if ($ping.ok -ne $true -or [string]$ping.ip -ne $addr.ToString() -or -not $ping.epoch) { throw 'Ping contract failed.' }
    $stage = 'D1-payloads'
    foreach ($path in @('/api/enroll.ps1', '/api/diag.ps1', '/api/acceptance.ps1', '/api/accept.ps1', '/api/agent.ps1')) {
        $r = Invoke-WebRequest -Uri (Url $path) -UseBasicParsing -TimeoutSec 5
        $source = [string]$r.Content
        $errors = $null
        [void][System.Management.Automation.PSParser]::Tokenize($source, [ref]$errors)
        if ($r.StatusCode -ne 200 -or -not $source.Trim() -or $source.TrimStart().StartsWith('<') -or @($errors).Count -gt 0) { throw ('Invalid script at ' + $path) }
        Write-Host ('D1 GET ' + $path + ' HTTP=200 parse=clean')
    }
    $stage = 'D1-staged-sha'
    $remote = Get-Api '/api/agent-hash'
    $path = 'C:\ghrdp\ghrdp-agent.ps1'
    $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $path).Length
    $download = Join-Path $env:TEMP ('ghrdp-d1-' + [guid]::NewGuid().ToString('N') + '.ps1')
    try {
        Invoke-WebRequest -Uri (Url '/api/agent.ps1') -UseBasicParsing -OutFile $download -TimeoutSec 5
        $wireSha = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sha -ne [string]$remote.sha256 -or $sha -ne $wireSha -or $size -ne [long]$remote.size) { throw 'Staged/hash-endpoint/download mismatch.' }
    } finally { Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue }
    Write-Host ('D1 staged sha256=' + $sha + ' size=' + $size)
    $stage = 'D1-device-enroll'
    $id = 'ci-' + [guid]::NewGuid().ToString('N')
    $dev = Post-Api '/api/device-enroll' @{ dev=$id; name='CI SYNTHETIC - NOT A CLIENT'; os='Windows CI'; deviceIdHint='' }
    if (-not $dev.deviceId -or -not $dev.deviceToken) { throw 'Enrollment response missing identity.' }
    Write-Host ('::add-mask::' + $dev.deviceToken)
    $stage = 'D1-bad-token'
    $rejected = $false
    try {
        Invoke-RestMethod -Uri ($base + '/api/agent-hello') -Method Post -ContentType 'application/json' -Body (@{deviceId=$dev.deviceId; dt='invalid-ci-token'; build='ci-synthetic'; regPath=''; taskOk=$false} | ConvertTo-Json -Compress) -TimeoutSec 5 | Out-Null
    } catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $rejected = $true } else { throw } }
    if (-not $rejected) { throw 'Bad device token was not rejected with 401.' }
    $stage = 'D1-agent-hello'
    $hello = Post-Api '/api/agent-hello' @{deviceId=$dev.deviceId; dt=$dev.deviceToken; build='ci-synthetic'; regPath=''; taskOk=$false}
    if (-not $hello.ack) { throw 'Hello not acknowledged.' }
    $stage = 'D1-client-cmd'
    $queue = Post-Api '/api/client-cmd' @{deviceId=$dev.deviceId; action='rdp'; clip=$true; mic=$false; print=$false; drives=$false}
    if (-not $queue.queued -or -not $queue.cmdId) { throw 'Queue not acknowledged.' }
    $pollPath = '/api/client-cmd?device=' + [uri]::EscapeDataString($dev.deviceId) + '&dt=' + [uri]::EscapeDataString($dev.deviceToken)
    $cmd = Get-Api $pollPath
    if ($cmd.cmdId -ne $queue.cmdId -or $cmd.action -ne 'rdp' -or -not $cmd.host -or -not $cmd.user -or -not $cmd.pass) { throw 'Command contract failed.' }
    $cmd = $null
    $repeat = Get-Api $pollPath
    if ($repeat.cmdId) { throw 'Command was not single-use.' }
    $stage = 'D1-agent-status'
    $ack = Post-Api '/api/agent-status' @{deviceId=$dev.deviceId; dt=$dev.deviceToken; cmdId=$queue.cmdId; stage='ci-synthetic'; mstscPid=0; logonAge=-1; err=''; build='ci-synthetic'; regPath=''; taskOk=$false; enrollLogTail=''}
    if (-not $ack.ack) { throw 'Status not acknowledged.' }
    $status = Get-Api ('/api/agent-status?device=' + [uri]::EscapeDataString($dev.deviceId))
    if ($status.seen -ne $true -or $status.stage -ne 'ci-synthetic') { throw 'Status readback failed.' }
    Write-Host 'D1 PASS synthetic API transport only; not an RDP acceptance result.'
    exit 0
} catch {
    $code = 'none'
    if ($_.Exception.Response) { $code = [string][int]$_.Exception.Response.StatusCode }
    Write-Host ('D1 FAIL stage=' + $stage + ' HTTP=' + $code + ' exception=' + $_.Exception.GetType().Name)
    exit 1
}
