# ghrdp-agent-media.ps1 - in-session media loop (plan Phase 1.1, second loop).
#
# Owns the WebRTC-first path: DDA/GDI capture, H.264 encode, cursor capture and
# input injection, publishing to the session-0 broker over localhost UDP. Hosted
# by ghrdp-agent.ps1 as a separate process so that a failure here cannot stop the
# warm MJPEG fallback the desktop is actually served from.
#
# Everything in this file runs inside the interactive session. It can never run
# in session 0: there is no desktop to capture and SendInput goes nowhere.

param(
    [string]$Root = 'C:\ghrdp'
)

$ErrorActionPreference = 'Continue'
$dir = Join-Path $Root 'webdesk'
New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null

$agentErr = Join-Path $dir 'agent-error.txt'
$agentStatus = Join-Path $dir 'agent-status.json'
$mediaStatus = Join-Path $dir 'agent-media.json'
$agentOk = Join-Path $Root 'agent-ok.txt'

function Get-EnvInt {
    param([string]$Name, [int]$Default)
    $v = [Environment]::GetEnvironmentVariable($Name)
    if (-not $v) { return $Default }
    try { return [int]$v } catch { return $Default }
}

$warmFps = Get-EnvInt 'GHRDP_WARM_FPS' 5
$agentRxPort = Get-EnvInt 'GHRDP_AGENT_RX_PORT' 7411
$brokerRxPort = Get-EnvInt 'GHRDP_BROKER_RX_PORT' 7412

function Write-MediaStatus {
    param([hashtable]$Fields)
    try {
        $obj = [ordered]@{
            updatedUtc = (Get-Date).ToUniversalTime().ToString('o')
            pid        = $PID
        }
        foreach ($k in $Fields.Keys) { $obj[$k] = $Fields[$k] }
        [System.IO.File]::WriteAllText($mediaStatus, ($obj | ConvertTo-Json -Compress))
    } catch { }
}

try {
    $srcDir = $PSScriptRoot
    $present = @(
        (Join-Path $srcDir 'GhrdpIpc.cs'),
        (Join-Path $srcDir 'GhrdpDda.cs')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if ($present.Count -eq 0) {
        throw "agent sources not found next to $PSCommandPath"
    }
    Add-Type -Path $present -ErrorAction Stop

    $ipc = New-Object Ghrdp.InSession.IpcEndpoint($agentRxPort, $brokerRxPort)
    $ipc.Start()

    $note = ''
    $surface = [Ghrdp.InSession.Capturer]::Select([ref]$note)
    if ($null -eq $surface) {
        Write-MediaStatus @{
            pipeline    = 'degraded'
            captureMode = 'none'
            captureNote = $note
            error       = 'no capture surface'
        }
        throw "no capture surface: $note"
    }

    $agent = New-Object Ghrdp.InSession.DdaAgent($ipc, $surface, $Root)
    $agent.Start()

    Write-MediaStatus @{
        pipeline      = 'starting'
        captureMode   = $note
        width         = $agent.Width
        height        = $agent.Height
        encoderName   = $agent.EncoderName
        encoderOn     = $agent.EncoderAvailable
        agentRxPort   = $agentRxPort
        brokerRxPort  = $brokerRxPort
    }

    # HELLO proves the loopback is alive. The broker does not treat the pipeline
    # as ready until the first STATS report actually arrives.
    $hello = @{ agent = '1.0'; pid = $PID; warmFps = $warmFps } | ConvertTo-Json -Compress
    $ipc.Send([Ghrdp.InSession.MsgType]::Hello, [Ghrdp.InSession.MsgFlags]::None,
        [System.Text.Encoding]::UTF8.GetBytes($hello))

    $lastStats = Get-Date
    $lastHello = Get-Date
    $lastPath = $null
    $lastInputDrain = Get-Date

    while ($true) {
        $now = Get-Date

        # Drain broker -> agent control traffic. The pull queue exists because a
        # PowerShell host cannot handle a C# event raised on the receive thread.
        $msg = $null
        $drained = 0
        while ($ipc.TryDequeue([ref]$msg) -and $drained -lt 256) {
            $drained++
            switch ($msg.Kind) {
                ([Ghrdp.InSession.ReceivedKind]::Ladder) {
                    $rung = New-Object Ghrdp.InSession.Rung
                    $rung.Tier = $msg.Ladder.Tier
                    $rung.Quality = $msg.Ladder.Quality
                    $rung.Scale = $msg.Ladder.Scale
                    $rung.FpsCap = $msg.Ladder.FpsCap
                    $rung.Path = $msg.Ladder.Path
                    $agent.SetRung($rung)
                    $lastPath = $msg.Ladder.Path
                }
                ([Ghrdp.InSession.ReceivedKind]::KeyframeReq) {
                    $agent.RequestKeyframe($msg.Keyframe.Reason)
                }
                ([Ghrdp.InSession.ReceivedKind]::Input) {
                    # Input never traverses the frame pipeline: it is injected
                    # here and acknowledged immediately, so click-to-pixel stays
                    # measurable even while video is stalled.
                    $agent.InjectInput($msg.Input)
                }
                default { }
            }
        }

        $agent.SendCursor()

        if (($now - $lastStats).TotalMilliseconds -ge 1000) {
            $agent.SendStats()
            $lastStats = $now
            Write-MediaStatus @{
                pipeline      = 'running'
                captureMode   = $note
                width         = $agent.Width
                height        = $agent.Height
                encoderName   = $agent.EncoderName
                encoderOn     = $agent.EncoderAvailable
                captureFrames = $agent.CaptureFrames
                encodeFrames  = $agent.EncodeFrames
                dropped       = $agent.Dropped
                keyframes     = $agent.Keyframes
                sceneCuts     = $agent.SceneCuts
                inputInjected = $agent.InputInjected
                inputAcks     = $agent.InputAcksSent
                brokerPath    = $lastPath
                ipcMalformed  = $ipc.MalformedDatagrams
                ipcInboxDepth = $ipc.InboxDepth
            }
        }

        # Re-announce: if the broker restarts it has to rediscover this process,
        # and a HELLO is cheap.
        if (($now - $lastHello).TotalSeconds -ge 10) {
            $ipc.Send([Ghrdp.InSession.MsgType]::Hello, [Ghrdp.InSession.MsgFlags]::None,
                [System.Text.Encoding]::UTF8.GetBytes($hello))
            $lastHello = $now
        }

        Start-Sleep -Milliseconds 5
    }
} catch {
    try {
        [System.IO.File]::WriteAllText($agentErr,
            ((Get-Date -Format o) + "`r`n" + $_.Exception.Message + "`r`n" + $_.ScriptStackTrace))
    } catch { }
    try {
        Write-MediaStatus @{ pipeline = 'failed'; error = $_.Exception.Message }
    } catch { }
}
