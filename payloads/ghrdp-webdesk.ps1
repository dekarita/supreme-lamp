$ErrorActionPreference = 'Continue'
$root = 'C:\ghrdp'
$dir = Join-Path $root 'webdesk'
New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null
$alive = Join-Path $dir 'webdesk-alive.txt'
$errFile = Join-Path $dir 'webdesk-error.txt'
try { Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue } catch { }
$mtx = $null
try { $mtx = New-Object System.Threading.Mutex($false, 'GhrdpWebDeskSingle'); if (-not $mtx.WaitOne(0)) { exit 0 } } catch { }
try {
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
$codec = @([System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]35)
$scale = 0.6
$sw = [int]($vs.Width * $scale); $sh = [int]($vs.Height * $scale)
$small = New-Object System.Drawing.Bitmap $sw, $sh
$gsmall = [System.Drawing.Graphics]::FromImage($small)
$framePath = Join-Path $dir 'frame.jpg'
$tmpPath = Join-Path $dir 'frame.tmp.jpg'
$tsPath = Join-Path $dir 'frame-ts.txt'
$inPath = Join-Path $dir 'input.ndjson'
$clipSet = Join-Path $dir 'clip-set.json'
$clipGetFlag = Join-Path $dir 'clip-get.flag'
$clipTxt = Join-Path $dir 'clip.txt'
function Send-Mouse { param([double]$nx, [double]$ny, [uint32]$flags, [int32]$wheel) [void][Inp]::Mouse($nx, $ny, $flags, $wheel) }
function Send-KeyChar { param([string]$ch) $c = [int][char]$ch[0]; [void][Inp]::Key(0, $c, 4); [void][Inp]::Key(0, $c, 6) }
function Send-KeyVk { param([int]$vk, [bool]$up) if ($up) { [void][Inp]::Key($vk, 0, 2) } else { [void][Inp]::Key($vk, 0, 0) } }
while ($true) {
    try {
        try { [System.IO.File]::WriteAllText($alive, (Get-Date).ToUniversalTime().ToString('o')) } catch { }
        $gfx.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
        $gsmall.DrawImage($bmp, 0, 0, $sw, $sh)
        $small.Save($tmpPath, $codec, $ep)
        Move-Item -LiteralPath $tmpPath -Destination $framePath -Force
        [System.IO.File]::WriteAllText($tsPath, (Get-Date).ToUniversalTime().ToString('o'))
    } catch { }
    if (Test-Path -LiteralPath $inPath) {
        $lines = @()
        try { $lines = @([System.IO.File]::ReadAllLines($inPath)); Remove-Item -LiteralPath $inPath -Force } catch { }
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
        try { $j = Get-Content -LiteralPath $clipSet -Raw | ConvertFrom-Json; Set-Clipboard -Value ([string]$j.text); Remove-Item -LiteralPath $clipSet -Force } catch { }
    }
    if (Test-Path -LiteralPath $clipGetFlag) {
        try { $t = ''; try { $t = Get-Clipboard -Raw } catch { }; [System.IO.File]::WriteAllText($clipTxt, $t); Remove-Item -LiteralPath $clipGetFlag -Force } catch { }
    }
    Start-Sleep -Milliseconds 66
}
} catch {
    try { [System.IO.File]::WriteAllText($errFile, ((Get-Date -Format o) + "`r`n" + $_.Exception.Message + "`r`n" + $_.ScriptStackTrace)) } catch { }
}
