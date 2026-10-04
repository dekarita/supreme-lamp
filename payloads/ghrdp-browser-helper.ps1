<#
 [F86 §A.2 TIER 3] The persistent browser-opener helper.

 WHY: on a runner where ghrdp-server runs in session 0 (a service / a scheduled
 runner), a direct process spawn inherits session 0, so no window can reach
 the operator's desktop. The F81 scheduled task was the only rung that could
 reach the interactive session, and it fails silently when no interactive
 logon exists - which is exactly why this helper exists.

 The ladder in payloads/ghrdp-server.ps1 spawns THIS file once per process
 (Start-F86BrowserHelper) and then talks to it over a named pipe:
   ghrdp-server  --(url)-->  named pipe  -->  helper  -->  browser
 The helper launches the browser in whichever desktop context IT owns (a helper
 started by an interactive ghrdp-server runs in that interactive session - the
 exact case where Tier 3 works and the F81 task could not) and answers
 `OK <pid>` or `ERR <reason>` so the server can report the real outcome instead
 of a hopeful 200.

 Safety: the pipe carries exactly one line per connection; only https:// URLs
 are accepted; the browser is launched with an argument array (never a command
 string) so a URL can never become a shell command. No credentials, no cookies,
 no headers - this file has no network code at all.

 Usage (by the server, never by the operator):
   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden `
     -File ghrdp-browser-helper.ps1 -PipeName ghrdp-browser-opener-f86
#>
[CmdletBinding()]
param(
    [string]$PipeName = 'ghrdp-browser-opener-f86',
    [int]$IdleSeconds = 1800
)

$ErrorActionPreference = 'Continue'

function Resolve-F86HelperBrowser {
    foreach ($name in @('msedge', 'chrome', 'firefox')) {
        $found = ''
        try {
            $cmd = Get-Command ($name + '.exe') -ErrorAction SilentlyContinue
            if ($cmd -and $cmd.Source) { $found = [string]$cmd.Source }
        } catch { $found = '' }
        if ($found -and (Test-Path -LiteralPath $found)) { return $found }
    }
    $pf = ''
    $pf86 = ''
    $local = ''
    try { $pf = [string]$env:ProgramFiles } catch { $pf = '' }
    try { $pf86 = [string]${env:ProgramFiles(x86)} } catch { $pf86 = '' }
    try { $local = [string]$env:LOCALAPPDATA } catch { $local = '' }
    foreach ($guess in @(
        "$pf\Microsoft\Edge\Application\msedge.exe",
        "$pf86\Microsoft\Edge\Application\msedge.exe",
        "$local\Microsoft\Edge\Application\msedge.exe",
        "$pf\Google\Chrome\Application\chrome.exe",
        "$pf86\Google\Chrome\Application\chrome.exe",
        "$local\Google\Chrome\Application\chrome.exe"
    )) {
        if ($guess -and (Test-Path -LiteralPath $guess)) { return $guess }
    }
    return ''
}

$browserPath = Resolve-F86HelperBrowser
$deadline = (Get-Date).AddSeconds($IdleSeconds)
while ((Get-Date) -lt $deadline) {
    $pipe = $null
    try {
        $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($PipeName, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous)
        $pipe.WaitForConnection()
        $reader = New-Object System.IO.StreamReader($pipe)
        $url = [string]$reader.ReadLine()
        $reply = 'ERR invalid-url'
        if ($url -and $url.StartsWith('https://')) {
            if (-not $browserPath) {
                $reply = 'ERR no-browser'
            } else {
                try {
                    $proc = Start-Process -FilePath $browserPath -ArgumentList @('--new-window', $url) -PassThru -ErrorAction Stop
                    if ($proc -and $proc.Id -gt 0) { $reply = 'OK ' + [string]$proc.Id } else { $reply = 'ERR no-pid' }
                } catch {
                    $reply = 'ERR ' + [string]$_.Exception.Message
                }
            }
        }
        $writer = New-Object System.IO.StreamWriter($pipe)
        $writer.AutoFlush = $true
        $writer.WriteLine($reply)
    } catch {
    } finally {
        if ($pipe) { try { $pipe.Dispose() } catch { } }
    }
}
