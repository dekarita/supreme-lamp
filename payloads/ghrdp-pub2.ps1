# ghrdp-pub2.ps1 — GHRDP Web Desktop capture engine (interactive session)
# Windows PowerShell 5.1 / .NET Framework only. Runs as scheduled task GhrdpWebDesk.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ---- Display orientation self-heal (rotated console => grey portrait frames) ----
try {
    if (-not ([System.Management.Automation.PSTypeName]'GhrdpDisp').Type) {
        Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
public struct DM2 { public const int N=32; public const int F=32;
 [MarshalAs(UnmanagedType.ByValTStr, SizeConst=N)] public string dmDeviceName;
 public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
 public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
 public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
 [MarshalAs(UnmanagedType.ByValTStr, SizeConst=F)] public string dmFormName;
 public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
 public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent;
 public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2;
 public int dmPanningWidth; public int dmPanningHeight; }
public static class GhrdpDisp {
 [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern bool EnumDisplaySettings(string n, int m, ref DM2 d);
 [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern int ChangeDisplaySettingsEx(string n, ref DM2 d, IntPtr h, int f, IntPtr l);
}
'@
    }
    $dmx = New-Object DM2
    $dmx.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DM2])
    if ([GhrdpDisp]::EnumDisplaySettings($null, -1, [ref]$dmx)) {
        if ($dmx.dmDisplayOrientation -ne 0) {
            $dmx.dmDisplayOrientation = 0
            $tw = $dmx.dmPelsWidth; $dmx.dmPelsWidth = $dmx.dmPelsHeight; $dmx.dmPelsHeight = $tw
            [void][GhrdpDisp]::ChangeDisplaySettingsEx($null, [ref]$dmx, [IntPtr]::Zero, 0, [IntPtr]::Zero)
        }
    }
} catch { }
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
$IT_MOUSE=0;$IT_KBD=1;$KEF_UP=0x0002
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
    param([ushort]$Vk,[bool]$KeyUp)
    $ki = New-Object GhrdpInput+KEYBDINPUT
    $ki.wVk = $Vk; $ki.wScan = 0
    if ($KeyUp) { $ki.dwFlags = [uint32]$KEF_UP } else { $ki.dwFlags = [uint32]0 }
    $ki.time = 0; $ki.dwExtraInfo = [IntPtr]::Zero
    $u = New-Object GhrdpInput+INPUT_UNION; $u.ki = $ki
    $inp = New-Object GhrdpInput+INPUT; $inp.type = $IT_KBD; $inp.u = $u
    $arr = New-Object 'GhrdpInput+INPUT[]' 1; $arr[0] = $inp
    [void][GhrdpInput]::SendInput(1, $arr, $INPUT_SIZE)
}

$jpegEncoder = $null
foreach ($enc in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {
    if ($enc.MimeType -eq 'image/jpeg') { $jpegEncoder = $enc; break }
}
$curQ = [long]35; $curScale = 0.5
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $curQ)

try { [System.IO.File]::WriteAllText((Join-Path 'C:\ghrdp' 'webdesk-version.txt'), ('ghrdp-pub2 v2.2 pid=' + $PID + ' at=' + ((Get-Date).ToUniversalTime().ToString('o')))) } catch { }

function Get-WsClientCount {
    if (-not (Test-Path -LiteralPath $wsClients)) { return 1 }
    try { $raw = ([System.IO.File]::ReadAllText($wsClients)).Trim(); $n = 0
        if ([int]::TryParse($raw, [ref]$n)) { return [Math]::Max(0, $n) } } catch { }
    return 1
}
function Process-InputBatch {
    if (-not (Test-Path -LiteralPath $inputFile)) { return }
    $lines = @()
    try { $lines = @([System.IO.File]::ReadAllLines($inputFile))
        Remove-Item -LiteralPath $inputFile -Force -ErrorAction SilentlyContinue } catch { return }
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
            'kd' { Send-KeyEvent -Vk ([ushort][int]$ev.vk) -KeyUp:$false }
            'ku' { Send-KeyEvent -Vk ([ushort][int]$ev.vk) -KeyUp:$true }
            'k'  { $ch=[string]$ev.ch; if ($ch.Length -gt 0) {
                       $vk = [ushort][int][char]$ch[0]
                       Send-KeyEvent -Vk $vk -KeyUp:$false
                       Send-KeyEvent -Vk $vk -KeyUp:$true } }
        }
    }
    try { $ap = 'C:\ghrdp\webdesk\input-applied.txt'; $n2 = 0; if (Test-Path -LiteralPath $ap) { try { $n2 = [int]([System.IO.File]::ReadAllText($ap).Trim()) } catch { } }; [System.IO.File]::WriteAllText($ap, ([string]($n2 + $lines.Count))) } catch { }
}

try {
    while ($true) {
        try { Process-InputBatch } catch { }
        [void](Get-WsClientCount)
        try {
            if (Test-Path -LiteralPath $ctlFile) {
                $ctl = [System.IO.File]::ReadAllText($ctlFile) | ConvertFrom-Json
                $nq = [long]$ctl.q; $ns = [double]$ctl.scale
                if ($nq -ne $curQ -or [Math]::Abs($ns - $curScale) -gt 0.001) {
                    $curQ = $nq; $curScale = $ns
                    $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $curQ)
                }
            }
        } catch { }
        $bmp=$null;$g=$null;$scaled=$null;$sg=$null
        try {
            $pri = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bmp = New-Object System.Drawing.Bitmap ($pri.Width, $pri.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $g   = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
            $sw = [int][Math]::Max(1,[Math]::Floor($pri.Width * $curScale))
            $sh = [int][Math]::Max(1,[Math]::Floor($pri.Height * $curScale))
            $scaled = New-Object System.Drawing.Bitmap ($sw, $sh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $sg = [System.Drawing.Graphics]::FromImage($scaled)
            $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
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
        Start-Sleep -Milliseconds 100
    }
} finally {
    try { $encParams.Dispose() } catch { }
    try { $script:Mutex.ReleaseMutex() } catch { }
    try { $script:Mutex.Dispose() } catch { }
}
