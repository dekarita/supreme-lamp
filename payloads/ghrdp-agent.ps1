# ghrdp-agent.ps1 - in-session agent supervisor (plan Phase 1.1).
#
# Runs in the interactive session, launched by the same ONLOGON task that starts
# the legacy worker. Two independent loops serve the desktop:
#
#   1. the WebRTC-first media loop (DDA/GDI capture -> H.264 -> localhost UDP),
#      hosted by ghrdp-agent-media.ps1 in its own process; and
#   2. the warm MJPEG fallback loop (CopyFromScreen -> JPEG -> frame.jpg), which
#      is the legacy path kept intact.
#
# They are separate processes on purpose. A crash, a hang, or a failed encoder in
# the media loop must not be able to stop the loop that actually serves the
# desktop. If the media loop never comes up, the fallback keeps serving
# /webdesk-frame and the pipeline reports itself degraded - it does not fail hard
# (plan Step 3.4).
#
# Repo conventions apply: $ErrorActionPreference = Continue, per-operation
# try/catch, and *-ok.txt / *-error.txt sentinels.

$ErrorActionPreference = 'Continue'
$root = 'C:\ghrdp'
$dir = Join-Path $root 'webdesk'
New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null

$alive = Join-Path $dir 'webdesk-alive.txt'
$errFile = Join-Path $dir 'webdesk-error.txt'
$agentErr = Join-Path $dir 'agent-error.txt'
$agentStatus = Join-Path $dir 'agent-status.json'
$agentOk = Join-Path $root 'agent-ok.txt'
$inPath = Join-Path $dir 'input.ndjson'

try { Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue } catch { }
try { Remove-Item -LiteralPath $agentErr -Force -ErrorAction SilentlyContinue } catch { }

# Warm fallback rate. The legacy loop ran at a 66 ms sleep (~15 fps ceiling).
# This is deliberately lower: the fallback has to be warm enough that a switch is
# a visibility toggle rather than a pipeline start, but it must not compete with
# the primary pipeline for capture or CPU.
$warmFps = 5
if ($env:GHRDP_WARM_FPS) { try { $warmFps = [int]$env:GHRDP_WARM_FPS } catch { $warmFps = 5 } }
if ($warmFps -lt 1) { $warmFps = 1 }
if ($warmFps -gt 30) { $warmFps = 30 }
$warmIntervalMs = [int](1000 / $warmFps)

# Localhost-only IPC. The broker (session 0) listens on the broker port; this
# session listens on the agent port. Neither side is ever bound to the tailnet.
$agentRxPort = 7411
$brokerRxPort = 7412
if ($env:GHRDP_AGENT_RX_PORT) { try { $agentRxPort = [int]$env:GHRDP_AGENT_RX_PORT } catch { } }
if ($env:GHRDP_BROKER_RX_PORT) { try { $brokerRxPort = [int]$env:GHRDP_BROKER_RX_PORT } catch { } }

$mtx = $null
try {
    $mtx = New-Object System.Threading.Mutex($false, 'GhrdpAgentSingle')
    if (-not $mtx.WaitOne(0)) { exit 0 }
} catch { }

function Write-AgentStatus {
    param([hashtable]$Fields)
    try {
        # Whole-file rewrite, never read-modify-write: both the broker and
        # /webdesk-probe read this file, and read-modify-write races on Windows.
        $obj = [ordered]@{
            updatedUtc   = (Get-Date).ToUniversalTime().ToString('o')
            pid          = $PID
            warmFps      = $warmFps
            agentRxPort  = $agentRxPort
            brokerRxPort = $brokerRxPort
        }
        foreach ($k in $Fields.Keys) { $obj[$k] = $Fields[$k] }
        [System.IO.File]::WriteAllText($agentStatus, ($obj | ConvertTo-Json -Compress))
    } catch { }
}

# ---------------------------------------------------------------------------
# The warm MJPEG fallback loop.
#
# This is the legacy capture loop, kept intact: same 0.6 scale, same quality 35,
# same frame.jpg + frame-ts.txt contract, same input.ndjson drain. It is the
# floor the whole design rests on, so it is deliberately not refactored.
# ---------------------------------------------------------------------------
function Start-WarmFallbackLoop {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class Inp{
[StructLayout(LayoutKind.Sequential)]struct MI{public int dx;public int dy;public uint mouseData;public uint dwFlags;public uint time;public IntPtr dwExtra;}
[StructLayout(LayoutKind.Sequential)]struct KI{public ushort wVk;public ushort wScan;public uint dwFlags;public uint time;public IntPtr dwExtra;}
[StructLayout(LayoutKind.Explicit)]struct INPUT{[FieldOffset(0)]public int type;[FieldOffset(8)]public MI mi;[FieldOffset(8)]public KI ki;}
[DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint n,INPUT[] inp,int cbSize);
public static void Mouse(double nx,double ny,uint flags,int wheel){
INPUT i=new INPUT();i.type=0;
i.mi.dx=(int)(nx*65535);i.mi.dy=(int)(ny*65535);
i.mi.dwFlags=flags|0x8000|0x4000;
if(wheel!=0){i.mi.mouseData=(uint)(wheel*120);i.mi.dwFlags|=0x800;}
SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)));}
public static void Key(ushort vk,ushort scan,uint flags){
INPUT i=new INPUT();i.type=1;
i.ki.wVk=vk;i.ki.wScan=scan;i.ki.dwFlags=flags;
SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)));}
}
'@

    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $codec = @([System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) |
        Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, [long]35)

    $scale = 0.6
    $sw = [int]($vs.Width * $scale); $sh = [int]($vs.Height * $scale)
    $small = New-Object System.Drawing.Bitmap $sw, $sh
    $gsmall = [System.Drawing.Graphics]::FromImage($small)

    $framePath = Join-Path $dir 'frame.jpg'
    $tmpPath = Join-Path $dir 'frame.tmp.jpg'
    $tsPath = Join-Path $dir 'frame-ts.txt'
    $clipSet = Join-Path $dir 'clip-set.json'
    $clipGetFlag = Join-Path $dir 'clip-get.flag'
    $clipTxt = Join-Path $dir 'clip.txt'

    $lastSupervise = Get-Date

    while ($true) {
        try {
            [System.IO.File]::WriteAllText($alive, (Get-Date).ToUniversalTime().ToString('o'))
        } catch { }

        try {
            $gfx.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
            $gsmall.DrawImage($bmp, 0, 0, $sw, $sh)
            $small.Save($tmpPath, $codec, $ep)
            # Move-Item over the destination is what makes the write atomic for
            # readers: nobody observes a half-written frame.jpg.
            Move-Item -LiteralPath $tmpPath -Destination $framePath -Force
            [System.IO.File]::WriteAllText($tsPath, (Get-Date).ToUniversalTime().ToString('o'))
        } catch { }

        # The input.ndjson contract stays valid throughout, so the fallback input
        # path is unaffected by whether the WebRTC pipeline came up.
        if (Test-Path -LiteralPath $inPath) {
            $lines = @()
            try {
                $lines = @([System.IO.File]::ReadAllLines($inPath))
                Remove-Item -LiteralPath $inPath -Force
            } catch { }
            foreach ($ln in $lines) {
                if (-not $ln) { continue }
                try {
                    $ev = $ln | ConvertFrom-Json
                    switch ($ev.t) {
                        'm'  { Send-Mouse -nx $ev.nx -ny $ev.ny -flags 1 -wheel 0 }
                        'ld' { Send-Mouse -nx $ev.nx -ny $ev.ny -flags 2 -wheel 0 }
                        'lu' { Send-Mouse -nx $ev.nx -ny $ev.ny -flags 4 -wheel 0 }
                        'rd' { Send-Mouse -nx $ev.nx -ny $ev.ny -flags 8 -wheel 0 }
                        'ru' { Send-Mouse -nx $ev.nx -ny $ev.ny -flags 16 -wheel 0 }
                        'w'  { Send-Mouse -nx $ev.nx -ny $ev.ny -flags 1 -wheel $ev.d }
                        'k'  { Send-KeyChar $ev.ch }
                        'kd' { Send-KeyVk -vk $ev.vk -up $false }
                        'ku' { Send-KeyVk -vk $ev.vk -up $true }
                    }
                } catch { }
            }
        }

        if (Test-Path -LiteralPath $clipSet) {
            try {
                $j = Get-Content -LiteralPath $clipSet -Raw | ConvertFrom-Json
                Set-Clipboard -Value ([string]$j.text)
                Remove-Item -LiteralPath $clipSet -Force
            } catch { }
        }
        if (Test-Path -LiteralPath $clipGetFlag) {
            try {
                $t = ''
                try { $t = Get-Clipboard -Raw } catch { }
                [System.IO.File]::WriteAllText($clipTxt, $t)
                Remove-Item -LiteralPath $clipGetFlag -Force
            } catch { }
        }

        # Supervise the media process from here rather than from a second thread:
        # this loop is the one that must keep running, so it is the right place to
        # notice that the other one died. Restarts are bounded, because a media
        # loop that keeps dying means the honest answer is to stay on the
        # fallback and report it.
        if (((Get-Date) - $lastSupervise).TotalSeconds -ge 5) {
            $lastSupervise = Get-Date
            try {
                $dead = ($null -eq $mediaProc) -or $mediaProc.HasExited
                if ($dead -and $mediaRestarts -lt $maxRestarts -and $mediaScript) {
                    if ($mediaProc -and $mediaProc.HasExited) { $mediaRestarts++ }
                    if ($mediaRestarts -lt $maxRestarts) {
                        $mediaProc = Start-Process -FilePath $pwshPath -ArgumentList $mediaArgs -PassThru
                        Write-AgentStatus @{
                            pipeline      = 'warm'
                            mediaJob      = $mediaProc.Id
                            mediaRestarts = $mediaRestarts
                        }
                    } else {
                        Write-AgentStatus @{
                            pipeline      = 'warm'
                            mediaJob      = $null
                            mediaRestarts = $mediaRestarts
                            mediaError    = 'media loop exceeded restart budget; staying on MJPEG'
                        }
                    }
                }
            } catch { }
        }

        Start-Sleep -Milliseconds $warmIntervalMs
    }
}

# ---------------------------------------------------------------------------
# Start the media loop as its own process.
# ---------------------------------------------------------------------------
$mediaScript = Join-Path $PSScriptRoot 'ghrdp-agent-media.ps1'
$mediaProc = $null
$mediaRestarts = 0
$maxRestarts = 3
$pwshPath = 'powershell.exe'
$mediaArgs = @()

try {
    if (-not (Test-Path -LiteralPath $mediaScript)) {
        throw "media loop script not found: $mediaScript"
    }
    try {
        $c = Get-Command powershell.exe -ErrorAction Stop
        if ($c) { $pwshPath = $c.Source }
    } catch { }
    $mediaArgs = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', $mediaScript, '-Root', $root
    )
    $mediaProc = Start-Process -FilePath $pwshPath -ArgumentList $mediaArgs -PassThru
    Write-AgentStatus @{ pipeline = 'warm'; mediaJob = $mediaProc.Id; mediaRestarts = 0 }
} catch {
    # A media loop that will not start is the expected degraded case: the
    # fallback still runs, so the desktop is still usable.
    $mediaScript = $null
    Write-AgentStatus @{ pipeline = 'warm'; mediaJob = $null; mediaError = $_.Exception.Message }
}

try {
    Start-WarmFallbackLoop
} catch {
    try {
        [System.IO.File]::WriteAllText($errFile,
            ((Get-Date -Format o) + "`r`n" + $_.Exception.Message + "`r`n" + $_.ScriptStackTrace))
    } catch { }
}
