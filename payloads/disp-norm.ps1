Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
public struct DMX { [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName; public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput; public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName; public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight; public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight; }
public static class DispX { [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern bool EnumDisplaySettings(string n, int m, ref DMX d); [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern int ChangeDisplaySettingsEx(string n, ref DMX d, IntPtr h, int f, IntPtr l); }
'@
$dm = New-Object DMX; $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DMX])
[void][DispX]::EnumDisplaySettings($null, -1, [ref]$dm)
Write-Host ('before orient=' + $dm.dmDisplayOrientation + ' pels=' + $dm.dmPelsWidth + 'x' + $dm.dmPelsHeight)
if ($dm.dmDisplayOrientation -ne 0) {
  $dm.dmDisplayOrientation = 0
  $tw = $dm.dmPelsWidth; $dm.dmPelsWidth = $dm.dmPelsHeight; $dm.dmPelsHeight = $tw
  Write-Host ('change rc=' + [DispX]::ChangeDisplaySettingsEx($null, [ref]$dm, [IntPtr]::Zero, 0, [IntPtr]::Zero))
} else { Write-Host 'already landscape' }
