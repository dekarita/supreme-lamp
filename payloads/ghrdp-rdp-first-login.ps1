# [F98 §2.4 / P4] FIRST-LOGIN RDP UX CLEANUP.
#
# Runs ONCE per deployment from the Startup folder (or ONLOGON task). Its
# three jobs, in the order the operator will feel them:
#
#   1. MINIMIZE PowerShell windows - the "Administrator: C:\Windows\sy..."
#      window fills the RDP desktop on first login. Unprofessional.
#
#   2. DISMISS Tailscale welcome dialog - the "Connect to your tailnet
#      devices" popup distracts first-time users.
#
#   3. AUTO-OPEN the dashboard in Edge kiosk mode - the operator should
#      not have to hunt for the URL.
#
# The script writes an "already-ran.flag" so it only runs once. The mutex
# prevents a double-fire from both Startup and the ONLOGON task.

$ErrorActionPreference = 'Continue'

$flagDir = 'C:\ProgramData\ghrdp'
$flagFile = Join-Path $flagDir 'first-login-ran.flag'
$mutexName = 'Global\GhrdpFirstLogin'

# Already-ran guard: if the flag exists, exit immediately.
if (Test-Path -LiteralPath $flagFile) {
    exit 0
}

# Mutex guard: only one instance at a time.
$mtx = $null
try {
    $mtx = New-Object System.Threading.Mutex($false, $mutexName)
    if (-not $mtx.WaitOne(0)) {
        exit 0
    }
} catch {
    # Mutex unavailable (sandboxed process) - proceed without guard.
}

# Mark as ran BEFORE doing work, so a crash on step 2 does not re-run step 1.
try {
    New-Item -ItemType Directory -Path $flagDir -Force -ErrorAction SilentlyContinue | Out-Null
    Set-Content -Path $flagFile -Value (Get-Date -Format 'o') -Force
} catch { }

# -----------------------------------------------------------------------
# STEP 1: MINIMIZE PowerShell / CMD windows (Win32 ShowWindow SW_MINIMIZE=6)
# -----------------------------------------------------------------------
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class GhrdpWindowHelper {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
}
'@ -ErrorAction Stop

    $procs = @()
    try { $procs += Get-Process -Name powershell, pwsh, cmd, conhost -ErrorAction SilentlyContinue } catch { }
    $minimized = 0
    foreach ($p in $procs) {
        try {
            $h = $p.MainWindowHandle
            if ($h -and $h -ne [IntPtr]::Zero) {
                # SW_MINIMIZE = 6
                [GhrdpWindowHelper]::ShowWindow($h, 6) | Out-Null
                $minimized++
            }
        } catch { }
    }
    Write-Host ('[F98] minimized ' + $minimized + ' console windows')
} catch {
    Write-Host ('[F98] minimize step failed: ' + $_.Exception.Message)
}

# -----------------------------------------------------------------------
# STEP 2: DISMISS Tailscale welcome dialog
# -----------------------------------------------------------------------
try {
    # Send ESC to any Tailscale welcome window (class name varies by version).
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class GhrdpFindWindow {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public const uint WM_CLOSE = 0x0010;
}
'@ -ErrorAction Stop

    # Try to find and close Tailscale welcome windows by title substring.
    $tailscaleClosed = 0
    [GhrdpFindWindow]::EnumWindows({
        param($hWnd, $lParam)
        try {
            $sb = New-Object System.Text.StringBuilder 256
            [GhrdpFindWindow]::GetClassName($hWnd, $sb, 256) | Out-Null
            $cls = $sb.ToString()
            # Tailscale UI uses various window classes; close anything with
            # "Tailscale" in the title bar.
            $titleSb = New-Object System.Text.StringBuilder 256
            [GhrdpWindowHelper]::GetWindowText($hWnd, $titleSb, 256) | Out-Null
            $title = $titleSb.ToString()
            if ($title -match 'Tailscale|Connect to your tailnet') {
                [GhrdpFindWindow]::PostMessage($hWnd, [GhrdpFindWindow]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
                $script:tailscaleClosed++
            }
        } catch { }
        return $true
    }, [IntPtr]::Zero)
    if ($tailscaleClosed -gt 0) {
        Write-Host ('[F98] closed ' + $tailscaleClosed + ' Tailscale window(s)')
    }
} catch {
    Write-Host ('[F98] tailscale-dismiss step failed: ' + $_.Exception.Message)
}

# -----------------------------------------------------------------------
# STEP 3: AUTO-OPEN dashboard in Edge (kiosk/app mode)
# -----------------------------------------------------------------------
Start-Sleep -Seconds 3  # let the desktop settle
try {
    $urlFile = Join-Path $flagDir 'dashboard-url.txt'
    $url = ''
    if (Test-Path -LiteralPath $urlFile) {
        $url = (Get-Content -LiteralPath $urlFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    }
    if (-not $url) {
        # Fallback: try to discover the tailnet IP from Tailscale status.
        try {
            $ts = 'C:\Program Files\Tailscale\tailscale.exe'
            if (Test-Path -LiteralPath $ts) {
                $statusJson = & $ts status --json 2>$null | ConvertFrom-Json
                if ($statusJson -and $statusJson.Self -and $statusJson.Self.TailscaleIPs) {
                    foreach ($a in $statusJson.Self.TailscaleIPs) {
                        if ($a -match '^100\.') { $url = 'http://' + $a + ':7333/'; break }
                    }
                }
            }
        } catch { }
    }
    if ($url) {
        # Open in Edge app mode (borderless, focused, professional).
        $edgePaths = @(
            'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
        )
        $edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($edge) {
            Start-Process -FilePath $edge -ArgumentList ('--app=' + $url) -ErrorAction SilentlyContinue
            Write-Host ('[F98] opened dashboard in Edge app mode: ' + $url)
        } else {
            # Fallback: open in default browser.
            Start-Process $url -ErrorAction SilentlyContinue
            Write-Host ('[F98] opened dashboard in default browser: ' + $url)
        }
    } else {
        Write-Host '[F98] no dashboard URL found - operator must open it manually'
    }
} catch {
    Write-Host ('[F98] auto-open step failed: ' + $_.Exception.Message)
}

# Release the mutex.
try { if ($mtx) { $mtx.ReleaseMutex(); $mtx.Dispose() } } catch { }
