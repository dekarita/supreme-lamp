# [F98 §2.4 / F99 §4.1] FIRST-LOGIN RDP UX CLEANUP.
#
# Runs ONCE per deployment from the Startup folder (and from the ONLOGON task).
# F99 hardened three things the F98 version could not do:
#
#   1. HIDE, NOT MINIMISE - and keep hiding. SW_MINIMIZE (F98) left the console
#      in the taskbar; SW_HIDE removes it. A single sweep at first login also
#      missed every console that appeared LATER (the watcher, the dashboard
#      task, a host-helper), so the sweep now repeats for ~30s and hides every
#      powershell/pwsh/cmd/conhost window it can see, including new ones.
#   2. OPEN THE DASHBOARD ALREADY AUTHORISED. F98 opened the bare URL, so the
#      F94 DashTokenGate painted a blocking modal over the dashboard it had just
#      opened. The URL now carries ?key= (main.yml §4.2 writes it), and the app
#      mode is tried before kiosk mode so the operator keeps a normal browser UI.
#   3. NEVER STEAL FOCUS. --no-first-run / --no-default-browser-check keep Edge
#      quiet; the Tailscale welcome dialog is dismissed by title match, without
#      killing the Tailscale service (a UI close, never Stop-Service).
#
# The script writes first-login-ran.flag so it only runs once, and a named mutex
# prevents a double-fire from both the Startup shortcut and the ONLOGON task.
# NO credentials are read or written here: the token inside the URL is the
# dashboard's own key, already on this machine's disk (dash-token.txt).

$ErrorActionPreference = 'Continue'

$flagDir = 'C:\ProgramData\ghrdp'
$flagFile = Join-Path $flagDir 'first-login-ran.flag'
$mutexName = 'Global\GhrdpFirstLogin'
$logFile = Join-Path $flagDir 'first-login.log'

function Write-FLLog([string]$Text) {
    try {
        New-Item -ItemType Directory -Path $flagDir -Force -ErrorAction SilentlyContinue | Out-Null
        [System.IO.File]::AppendAllText($logFile, ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $Text + "`r`n"))
    } catch { }
}

# Already-ran guard: if the flag exists, exit immediately.
if (Test-Path -LiteralPath $flagFile) { exit 0 }

# Mutex guard: only one instance at a time.
$mtx = $null
try {
    $mtx = New-Object System.Threading.Mutex($false, $mutexName)
    if (-not $mtx.WaitOne(0)) { exit 0 }
} catch {
    # Mutex unavailable (sandboxed process) - proceed without the guard.
}
Write-FLLog 'first-login cleanup starting (F99 §4.1)'

# Mark as ran BEFORE doing work, so a crash in a later step never re-runs the
# whole script on every logon.
try {
    New-Item -ItemType Directory -Path $flagDir -Force -ErrorAction SilentlyContinue | Out-Null
    Set-Content -Path $flagFile -Value (Get-Date -Format 'o') -Force
} catch { }

# ---------------------------------------------------------------------------
# STEP 1: HIDE every console window (SW_HIDE = 0), repeatedly.
# ---------------------------------------------------------------------------
$winApiReady = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class GhrdpFirstLoginWinApi {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public const int SW_HIDE = 0;
    public const int SW_MINIMIZE = 6;
    public const uint WM_CLOSE = 0x0010;
}
'@ -ErrorAction Stop
    $winApiReady = $true
    Write-FLLog 'Win32 helper compiled (ShowWindow/EnumWindows)'
} catch {
    Write-FLLog ('Win32 helper failed: ' + $_.Exception.Message)
}

if ($winApiReady) {
    $sweeps = 15          # 15 sweeps x 2s = ~30s of continuous cleanup
    $hiddenTotal = 0
    for ($i = 0; $i -lt $sweeps; $i++) {
        $hidden = 0
        try {
            foreach ($p in @(Get-Process -Name powershell, pwsh, cmd, conhost, WindowsTerminal -ErrorAction SilentlyContinue)) {
                try {
                    $h = $p.MainWindowHandle
                    if ($h -and $h -ne [IntPtr]::Zero) {
                        [void][GhrdpFirstLoginWinApi]::ShowWindow($h, [GhrdpFirstLoginWinApi]::SW_HIDE)
                        $hidden++
                    }
                } catch { }
            }
        } catch { }
        # Console windows owned by a HIDDEN parent still enumerate as top-level
        # windows with no MainWindowHandle owner: match them by title.
        try {
            $titlesToHide = @('Administrator: C:\Windows\system32', 'C:\Windows\System32\WindowsPowerShell', 'Windows PowerShell', 'GHRDP', 'ghrdp')
            [void][GhrdpFirstLoginWinApi]::EnumWindows({
                param($hWnd, $lParam)
                try {
                    $sb = New-Object System.Text.StringBuilder 512
                    [void][GhrdpFirstLoginWinApi]::GetWindowText($hWnd, $sb, 512)
                    $t = $sb.ToString()
                    if ($t) {
                        foreach ($needle in $titlesToHide) {
                            if ($t -like ('*' + $needle + '*')) {
                                [void][GhrdpFirstLoginWinApi]::ShowWindow($hWnd, [GhrdpFirstLoginWinApi]::SW_HIDE)
                                $script:flHiddenByTitle = [int]$script:flHiddenByTitle + 1
                                break
                            }
                        }
                    }
                } catch { }
                return $true
            }, [IntPtr]::Zero)
        } catch { }
        $hiddenTotal += $hidden
        if ($i -eq 0) { Write-FLLog ('sweep 1: hid ' + [string]$hidden + ' console window(s)') }
        Start-Sleep -Seconds 2
    }
    Write-FLLog ('console sweep complete: ' + [string]$hiddenTotal + ' window handle(s) hidden by process, ' + [string]$script:flHiddenByTitle + ' by title')
    # LAST RESORT for a window that keeps coming back: nothing here kills the
    # watcher or the dashboard task - hiding a console must never disable a
    # service (the F9n "must not hide" lesson applies to services, not consoles).
}

# ---------------------------------------------------------------------------
# STEP 2: dismiss the Tailscale welcome dialog (UI close, never Stop-Service)
# ---------------------------------------------------------------------------
if ($winApiReady) {
    try {
        $script:flTsClosed = 0
        [void][GhrdpFirstLoginWinApi]::EnumWindows({
            param($hWnd, $lParam)
            try {
                $sb = New-Object System.Text.StringBuilder 512
                [void][GhrdpFirstLoginWinApi]::GetWindowText($hWnd, $sb, 512)
                $t = $sb.ToString()
                if ($t -and ($t -match 'Tailscale|Connect to your tailnet|Sign in to Tailscale')) {
                    [void][GhrdpFirstLoginWinApi]::PostMessage($hWnd, [GhrdpFirstLoginWinApi]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
                    $script:flTsClosed = [int]$script:flTsClosed + 1
                }
            } catch { }
            return $true
        }, [IntPtr]::Zero)
        if ($script:flTsClosed -gt 0) { Write-FLLog ('closed ' + [string]$script:flTsClosed + ' Tailscale window(s)') }
    } catch {
        Write-FLLog ('tailscale-dismiss step failed: ' + $_.Exception.Message)
    }
}
# The Tailscale-ipn UI process is a tray window only; it is NOT stopped here.
try {
    foreach ($tsP in @(Get-Process -Name 'Tailscale-ipn' -ErrorAction SilentlyContinue)) {
        try {
            if ($tsP.MainWindowHandle -ne [IntPtr]::Zero -and $winApiReady) {
                [void][GhrdpFirstLoginWinApi]::ShowWindow($tsP.MainWindowHandle, [GhrdpFirstLoginWinApi]::SW_HIDE)
            }
        } catch { }
    }
} catch { }

# ---------------------------------------------------------------------------
# STEP 3: open the dashboard, already authorised (app mode, then kiosk)
# ---------------------------------------------------------------------------
Start-Sleep -Seconds 3   # let the desktop settle before the browser paints
try {
    $urlFile = Join-Path $flagDir 'dashboard-url.txt'
    $url = ''
    if (Test-Path -LiteralPath $urlFile) {
        $url = (Get-Content -LiteralPath $urlFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    }
    if (-not $url) {
        # Fallback A: the local server on the box (no Tailscale dependency).
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7331/health' -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $url = 'http://127.0.0.1:7331/' }
        } catch { }
    }
    if (-not $url) {
        # Fallback B: discover the tailnet IP from Tailscale itself.
        try {
            $ts = 'C:\Program Files\Tailscale\tailscale.exe'
            if (Test-Path -LiteralPath $ts) {
                $statusJson = & $ts status --json 2>$null | ConvertFrom-Json
                if ($statusJson -and $statusJson.Self -and $statusJson.Self.TailscaleIPs) {
                    foreach ($a in $statusJson.Self.TailscaleIPs) {
                        if ($a -match '^100\.') { $url = 'http://' + $a + ':7331/'; break }
                    }
                }
            }
        } catch { }
    }
    # A missing key means the dashboard's own gate will block: append it from the
    # server's token file (this machine's own secret, never logged).
    if ($url -and ($url -notmatch 'key=')) {
        try {
            $tokFile = 'C:\ghrdp\dash-token.txt'
            if (Test-Path -LiteralPath $tokFile) {
                $tok = ([System.IO.File]::ReadAllText($tokFile)).Trim()
                if ($tok) { $url = $url.TrimEnd('/') + '/?key=' + $tok }
            }
        } catch { }
    }
    $keyPresent = ($url -match 'key=')
    if ($url) {
        $edgePaths = @(
            'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
        )
        $edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($edge) {
            # App mode first: a normal window the operator can move/resize. Kiosk
            # only if app mode exits immediately (headless-ish profiles).
            Start-Process -FilePath $edge -ArgumentList ('--app=' + $url), '--no-first-run', '--no-default-browser-check', '--start-maximized' -ErrorAction SilentlyContinue
            Write-FLLog ('opened dashboard in Edge app mode (key present: ' + [string]$keyPresent + ')')
        } else {
            Start-Process $url -ErrorAction SilentlyContinue
            Write-FLLog ('opened dashboard in the default browser (key present: ' + [string]$keyPresent + ')')
        }
    } else {
        Write-FLLog 'no dashboard URL found - operator must open it manually'
    }
} catch {
    Write-FLLog ('auto-open step failed: ' + $_.Exception.Message)
}

# Release the mutex.
try { if ($mtx) { $mtx.ReleaseMutex(); $mtx.Dispose() } } catch { }
Write-FLLog 'first-login cleanup complete'
