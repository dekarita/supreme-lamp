# ghrdp-pub2.ps1 — GHRDP Web Desktop capture engine (interactive session)
# Windows PowerShell 5.1 / .NET Framework only. Runs as scheduled task GhrdpWebDesk.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ---- Single-instance gate (Global\ spans sessions; Local\ = per-session dupes) ----
$script:Mutex = New-Object System.Threading.Mutex($false, 'Global\GhrdpWebDeskSingle')
if (-not $script:Mutex.WaitOne(0)) { try { $script:Mutex.Dispose() } catch { }; exit 0 }

# ---- Paths ----
$root       = 'C:\ghrdp\webdesk'
$framePath  = Join-Path $root 'frame.jpg'
$frameTmp   = Join-Path $root 'frame.pub.tmp.jpg'
$tsFile     = Join-Path $root 'frame-ts.txt'
$inputFile  = Join-Path $root 'input.ndjson'
$capFailFile= Join-Path $root 'webdesk-capture-fail.txt'
$wsClients  = Join-Path $root 'ws-clients.txt'
$ctlFile    = Join-Path $root 'ctl.json'
try { if (-not (Test-Path -LiteralPath $ctlFile) -or ([System.IO.File]::ReadAllText($ctlFile).Trim().Length -eq 0)) { [System.IO.File]::WriteAllText($ctlFile, '{"q":35,"scale":0.5}') } } catch { }
New-Item -ItemType Directory -Path $root -Force -ErrorAction SilentlyContinue | Out-Null

# ---- P/Invoke: SendInput (mouse + keyboard) ----
if (-not ([System.Management.Automation.PSTypeName]'GhrdpInput').Type) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GhrdpInput {
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT {
        public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUT_UNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT {
        public uint type; public INPUT_UNION u; }
    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
'@
}
$MEF_MOVE=0x0001;$MEF_LD=0x0002;$MEF_LU=0x0004;$MEF_RD=0x0008;$MEF_RU=0x0010
$MEF_WHEEL=0x0800;$MEF_ABS=0x8000;$MEF_VDESK=0x4000
$IT_MOUSE=0;$IT_KBD=1;$KEF_UP=0x0002;$KEF_UNICODE=0x0004
$INPUT_SIZE = [System.Runtime.InteropServices.Marshal]::SizeOf([type][GhrdpInput+INPUT])

function Send-MouseEvent {
    param([uint32]$Flags,[int]$Dx=0,[int]$Dy=0,[uint32]$MouseData=0)
    $mi = New-Object GhrdpInput+MOUSEINPUT
    $mi.dx = $Dx; $mi.dy = $Dy; $mi.mouseData = $MouseData
    $mi.dwFlags = $Flags; $mi.time = 0; $mi.dwExtraInfo = [IntPtr]::Zero
    $u = New-Object GhrdpInput+INPUT_UNION; $u.mi = $mi
    $inp = New-Object GhrdpInput+INPUT; $inp.type = $IT_MOUSE; $inp.u = $u
    $arr = New-Object 'GhrdpInput+INPUT[]' 1; $arr[0] = $inp
    [void][GhrdpInput]::SendInput(1, $arr, $INPUT_SIZE)
}
function Send-KeyEvent {
    param([System.UInt16]$Vk,[bool]$KeyUp)
    $ki = New-Object GhrdpInput+KEYBDINPUT
    $ki.wVk = $Vk; $ki.wScan = 0
    if ($KeyUp) { $ki.dwFlags = [uint32]$KEF_UP } else { $ki.dwFlags = [uint32]0 }
    $ki.time = 0; $ki.dwExtraInfo = [IntPtr]::Zero
    $u = New-Object GhrdpInput+INPUT_UNION; $u.ki = $ki
    $inp = New-Object GhrdpInput+INPUT; $inp.type = $IT_KBD; $inp.u = $u
    $arr = New-Object 'GhrdpInput+INPUT[]' 1; $arr[0] = $inp
    [void][GhrdpInput]::SendInput(1, $arr, $INPUT_SIZE)
}
function Send-UnicodeChar {
    param([System.UInt16]$CharCode)
    $ki1 = New-Object GhrdpInput+KEYBDINPUT
    $ki1.wVk = [System.UInt16]0; $ki1.wScan = $CharCode
    $ki1.dwFlags = [uint32]$KEF_UNICODE; $ki1.time = 0; $ki1.dwExtraInfo = [IntPtr]::Zero
    $u1 = New-Object GhrdpInput+INPUT_UNION; $u1.ki = $ki1
    $inp1 = New-Object GhrdpInput+INPUT; $inp1.type = $IT_KBD; $inp1.u = $u1
    $ki2 = New-Object GhrdpInput+KEYBDINPUT
    $ki2.wVk = [System.UInt16]0; $ki2.wScan = $CharCode
    $ki2.dwFlags = [uint32]($KEF_UNICODE -bor $KEF_UP); $ki2.time = 0; $ki2.dwExtraInfo = [IntPtr]::Zero
    $u2 = New-Object GhrdpInput+INPUT_UNION; $u2.ki = $ki2
    $inp2 = New-Object GhrdpInput+INPUT; $inp2.type = $IT_KBD; $inp2.u = $u2
    $arr = New-Object 'GhrdpInput+INPUT[]' 2; $arr[0] = $inp1; $arr[1] = $inp2
    [void][GhrdpInput]::SendInput(2, $arr, $INPUT_SIZE)
}

$jpegEncoder = $null
foreach ($enc in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {
    if ($enc.MimeType -eq 'image/jpeg') { $jpegEncoder = $enc; break }
}
$curQ = [long]35; $curScale = 0.5
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $curQ)

try { [System.IO.File]::WriteAllText((Join-Path 'C:\ghrdp' 'webdesk-version.txt'), ('ghrdp-pub2 v3.0 pid=' + $PID + ' at=' + ((Get-Date).ToUniversalTime().ToString('o')))) } catch { }

function Get-WsClientCount {
    if (-not (Test-Path -LiteralPath $wsClients)) { return 1 }
    try { $raw = ([System.IO.File]::ReadAllText($wsClients)).Trim(); $n = 0
        if ([int]::TryParse($raw, [ref]$n)) { return [Math]::Max(0, $n) } } catch { }
    return 1
}
function Process-InputBatch {
    if (-not (Test-Path -LiteralPath $inputFile)) { return }
        $procFile = Join-Path $root ('input.proc.' + [guid]::NewGuid().ToString('N') + '.ndjson')
    $lines = @()
    try { Move-Item -LiteralPath $inputFile -Destination $procFile -Force -ErrorAction Stop
        $lines = @([System.IO.File]::ReadAllLines($procFile))
        Remove-Item -LiteralPath $procFile -Force -ErrorAction SilentlyContinue } catch { return }
    foreach ($ln in $lines) {
        if (-not $ln) { continue }
        $ev = $null; try { $ev = $ln | ConvertFrom-Json } catch { continue }
        if (-not $ev) { continue }
        switch ([string]$ev.t) {
            'm'  { $nx=[double]$ev.nx; $ny=[double]$ev.ny
                   if ($nx -lt 0) { $nx=0 } elseif ($nx -gt 1) { $nx=1 }
                   if ($ny -lt 0) { $ny=0 } elseif ($ny -gt 1) { $ny=1 }
                   Send-MouseEvent -Flags ([uint32]($MEF_MOVE -bor $MEF_ABS -bor $MEF_VDESK)) -Dx ([int]($nx*65535)) -Dy ([int]($ny*65535)) }
            'ld' { Send-MouseEvent -Flags ([uint32]$MEF_LD) }
            'lu' { Send-MouseEvent -Flags ([uint32]$MEF_LU) }
            'rd' { Send-MouseEvent -Flags ([uint32]$MEF_RD) }
            'ru' { Send-MouseEvent -Flags ([uint32]$MEF_RU) }
            'w'  { $d=[int]$ev.d; if ($d -eq 0) { $d = -1 }
                   Send-MouseEvent -Flags ([uint32]$MEF_WHEEL) -MouseData ([uint32]($d*120)) }
            'kd' { Send-KeyEvent -Vk ([System.UInt16][int]$ev.vk) -KeyUp:$false }
            'ku' { Send-KeyEvent -Vk ([System.UInt16][int]$ev.vk) -KeyUp:$true }
            'k'  { $ch=[string]$ev.ch; if ($ch.Length -gt 0) {
                       Send-UnicodeChar -CharCode ([System.UInt16][int][char]$ch[0]) } }
        }
    }
    try { $ap = 'C:\ghrdp\webdesk\input-applied.txt'; $n2 = 0; if (Test-Path -LiteralPath $ap) { try { $n2 = [int]([System.IO.File]::ReadAllText($ap).Trim()) } catch { } }; [System.IO.File]::WriteAllText($ap, ([string]($n2 + $lines.Count))) } catch { }
}

try {
    while ($true) { $capSw = [System.Diagnostics.Stopwatch]::StartNew()
        try { Process-InputBatch } catch { }
        [void](Get-WsClientCount)
        try {
            if (Test-Path -LiteralPath $ctlFile) {
                $ctl = [System.IO.File]::ReadAllText($ctlFile) | ConvertFrom-Json
                $nq = [long]$ctl.q; $ns = [double]$ctl.scale
                if ($null -eq $nq -or $nq -le 0 -or $nq -gt 100) { $nq = 35 }
                if ($null -eq $ns -or $ns -le 0 -or $ns -gt 1) { $ns = 0.5 }
                if ($nq -ne $curQ -or [Math]::Abs($ns - $curScale) -gt 0.001) {
                    $curQ = $nq; $curScale = $ns
                    $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $curQ)
                }
            }
        } catch { }
        $pri0 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        if ($pri0.Height -gt $pri0.Width) { Start-Sleep -Milliseconds 1000; continue }
        $bmp=$null;$g=$null;$scaled=$null;$sg=$null
        try {
            $pri = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bmp = New-Object System.Drawing.Bitmap ($pri.Width, $pri.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $g   = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
            $sw = [int][Math]::Max(1,[Math]::Floor($pri.Width * $curScale))
            $sh = [int][Math]::Max(1,[Math]::Floor($pri.Height * $curScale))
            $scaled = New-Object System.Drawing.Bitmap ($sw, $sh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $sg = [System.Drawing.Graphics]::FromImage($scaled)
            $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
            $sg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
            $sg.DrawImage($bmp, 0, 0, $sw, $sh)
            $scaled.Save($frameTmp, $jpegEncoder, $encParams)
            Move-Item -LiteralPath $frameTmp -Destination $framePath -Force -ErrorAction Stop
            [System.IO.File]::WriteAllText($tsFile, (Get-Date).ToUniversalTime().ToString('o'))
            if (Test-Path -LiteralPath $capFailFile) { Remove-Item -LiteralPath $capFailFile -Force -ErrorAction SilentlyContinue }
        } catch {
            try { [System.IO.File]::WriteAllText($capFailFile, ((Get-Date).ToUniversalTime().ToString('o')) + ' ' + $_.Exception.Message) } catch { }
        } finally {
            if ($sg)     { try { $sg.Dispose() }     catch { } }
            if ($scaled) { try { $scaled.Dispose() } catch { } }
            if ($g)      { try { $g.Dispose() }      catch { } }
            if ($bmp)    { try { $bmp.Dispose() }    catch { } }
        }
        $capSw.Stop()
        $elapsed = [int]$capSw.ElapsedMilliseconds
        $sleep = [Math]::Max(5, 33 - $elapsed)
        try { [IO.File]::WriteAllText((Join-Path $root 'frame-timing.txt'), ('{0}ms q={1} scale={2}' -f $elapsed, $curQ, $curScale)) } catch { }
        Start-Sleep -Milliseconds $sleep
    }
} finally {
    try { $encParams.Dispose() } catch { }
    try { $script:Mutex.ReleaseMutex() } catch { }
    try { $script:Mutex.Dispose() } catch { }
}
