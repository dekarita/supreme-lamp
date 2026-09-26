// ghrdp-rdp-launcher.cs  [F15]  FAIL-VISIBLE Windows auto-login protocol launcher.
// Compiled on the CLIENT PC by install.cmd with the in-box .NET Framework 4.x
// csc (C# 5 - keep syntax C#5: no interpolation, no nameof, no ?./?.[]).
// Registers nothing itself; install.cmd writes HKCU\Software\Classes\ghrdp.
//
// Verbs:
//   ghrdp://rdp?server=<fqdn>&user=<user>[&port=<1-65535>]
//     1. Beacon FIRST (JSONL log line + POST /api/handler-hello, details
//        'invoked') before any other work, so a dashboard sees the click even
//        if everything below fails.
//     2. If TERMSRV/<fqdn> is absent from the user's Credential Manager, launch
//        INTERACTIVE cmdkey ONCE in a VISIBLE Normal window (Windows itself
//        prompts for the password - this process never sees, reads, or writes
//        any password or hash), WaitForExit(180000), then VERIFY the entry with
//        a cmdkey /list parse.
//     3. Write %TEMP%\ghrdp-<sha1-8>.rdp LOCALLY (local write = no MOTW, no
//        SmartScreen prompt) with fullscreen (screen mode id:i:2) + redirection
//        directives. NO password/hash lines, NO desktopwidth/desktopheight
//        (fullscreen follows the client's native resolution = exact aspect).
//     4. Start mstsc VISIBLE, WaitForExit(2000): still running => beacon
//        'mstsc-started pid=N'; already exited => MessageBox with the exit code
//        + the last 5 log lines (a silently dying mstsc is impossible).
//   ghrdp://check[?server=<fqdn>]
//     install-time / user-triggered self test: MessageBox with the registered
//     reg command, TERMSRV presence, the log path and the exe version stamp.
//
// FAIL-VISIBLE CONTRACT (F15 §1.4): every exit path ends in a visible surface -
// an mstsc window, the visible cmdkey console, or a MessageBox - and every one
// of them is JSONL-logged. There is NO windowless/hidden process flag anywhere
// in this file: the credential prompt and mstsc must never be hidden.
// Telemetry is best effort: a dead beacon target never blocks or hides a
// failure (bounded background POST, 5s join).
//
// Log: %LOCALAPPDATA%\ghrdp\ghrdp-launcher.log (JSONL, token/password strings
// redacted). NLA/CredSSP stay at Windows defaults: this file deliberately
// OMITS 'authentication level', 'prompt for credentials', and
// 'enablecredsspsupport'.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[assembly: AssemblyVersion("2.1.0.0")]
[assembly: AssemblyFileVersion("2.1.0.0")]
[assembly: AssemblyTitle("ghrdp-rdp-launcher")]

internal static class GhrdpRdpLauncher
{
    private const string Ver = "2.1.0.0";
    private const string Stamp = "ghrdp-rdp-launcher " + Ver + " (F17 dns-guard)";
    private const int DefaultPort = 7331;
    // [F15 §1.2] mandated bound for the interactive credential prompt. The
    // lab-only GHRDP_LAB_CMDKEY_TIMEOUT_MS switch may only SHORTEN it (a
    // headless runner cannot type a password); production always uses 180000.
    private const int CmdkeyTimeoutMs = 180000;
    private static readonly Regex FqdnRe = new Regex(
        @"^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex UserRe = new Regex(
        @"^[A-Za-z0-9_\-\.\\]{1,104}$", RegexOptions.CultureInvariant);
    private static string logPathCache;

    // ------------------------------------------------------------------
    // [F15 §1.6] JSONL log with token/password redaction.
    // ------------------------------------------------------------------
    private static string LogPath()
    {
        if (logPathCache != null) { return logPathCache; }
        string dir = null;
        try { dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ghrdp"); }
        catch { }
        if (string.IsNullOrEmpty(dir)) { dir = Path.Combine(Path.GetTempPath(), "ghrdp"); }
        try { Directory.CreateDirectory(dir); } catch { }
        logPathCache = Path.Combine(dir, "ghrdp-launcher.log");
        return logPathCache;
    }

    private static string Redact(string s)
    {
        if (s == null) { return ""; }
        string r = Regex.Replace(s,
            @"(?i)(password|passwd|pwd|secret|token|apikey|authkey)\s*[=:]\s*[^\s&\""]+",
            "$1=[redacted]");
        // '/pass' with a VALUE must never survive into the log (this tooling
        // always uses the valueless form so Windows does the prompting).
        r = Regex.Replace(r, @"/pass\s*:\s*\S+", "/pass=[redacted]");
        r = Regex.Replace(r, @"(?i)(tskey-[A-Za-z0-9_\-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)", "[redacted]");
        return r;
    }

    private static string J(string s)
    {
        if (s == null) { return ""; }
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
    }

    private static void LogJson(string level, string verb, string details)
    {
        try
        {
            int pid = -1;
            try { pid = Process.GetCurrentProcess().Id; } catch { }
            string line = "{\"ts\":\"" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) +
                "\",\"level\":\"" + J(level) + "\",\"verb\":\"" + J(verb) + "\",\"details\":\"" +
                J(Redact(details)) + "\",\"exe\":\"" + Stamp + "\",\"pid\":" + pid + "}";
            File.AppendAllText(LogPath(), line + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { }
    }

    private static string TailLines(int n)
    {
        try
        {
            string[] all = File.ReadAllLines(LogPath());
            int start = all.Length > n ? all.Length - n : 0;
            StringBuilder sb = new StringBuilder();
            for (int i = start; i < all.Length; i++) { sb.AppendLine(all[i]); }
            return sb.ToString();
        }
        catch (Exception ex) { return "(log unreadable: " + ex.GetType().Name + ")"; }
    }

    // ------------------------------------------------------------------
    // [F15 §1.4] The single visible-surface primitive: everything the launcher
    // wants the user to see goes through here and is logged FIRST, so the log
    // always names the dialog even if MessageBox itself fails. The only
    // suppression is the lab switch (headless runners cannot click OK);
    // production always shows the dialog.
    // ------------------------------------------------------------------
    private static void ShowBox(string title, string text)
    {
        LogJson("msgbox", "", title + " :: " + text);
        if (Environment.GetEnvironmentVariable("GHRDP_LAB_NOMSG") == "1")
        {
            LogJson("msgbox-suppressed", "", "GHRDP_LAB_NOMSG=1 (lab only - production always shows this dialog)");
            return;
        }
        try
        {
            System.Windows.Forms.MessageBox.Show(text, title,
                System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            LogJson("error", "", "MessageBox itself failed: " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    // ------------------------------------------------------------------
    // Telemetry: bounded POST (never a wedge) - see [F10-10].
    // ------------------------------------------------------------------
    private static void HelloBounded(string host, int port, string verb, bool ok, string details)
    {
        if (string.IsNullOrEmpty(host)) { return; }   // §1.5: POST only with a server arg
        Thread t = new Thread(delegate() { Hello(host, port, verb, ok, details); });
        t.IsBackground = true;
        t.Start();
        t.Join(5000);
    }

    private static void Hello(string host, int port, string verb, bool ok, string details)
    {
        try
        {
            string body = "{\"verb\":\"" + J(verb) + "\",\"ok\":" + (ok ? "true" : "false") +
                ",\"details\":\"" + J(Redact(details)) + "\"}";
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                "http://" + host + ":" + port + "/api/handler-hello");
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            req.KeepAlive = false;
            req.Proxy = null;   // no proxy autodetect stall inside the launcher
            byte[] buf = Encoding.UTF8.GetBytes(body);
            req.ContentLength = buf.Length;
            using (Stream s = req.GetRequestStream()) { s.Write(buf, 0, buf.Length); }
            using (req.GetResponse()) { }
        }
        catch { }
    }

    // ------------------------------------------------------------------
    // URI parsing (no I/O, no process work: safe before the first beacon).
    // ------------------------------------------------------------------
    private static string JoinArgs(string[] args)
    {
        if (args == null || args.Length == 0) { return ""; }
        return string.Join(" ", args).Trim().Trim('"');
    }

    private static string PickVerb(string uri)
    {
        if (string.IsNullOrEmpty(uri)) { return ""; }
        string rest = uri;
        int sep = rest.IndexOf("://", StringComparison.Ordinal);
        if (sep >= 0) { rest = rest.Substring(sep + 3); }
        int q = rest.IndexOf('?');
        if (q >= 0) { rest = rest.Substring(0, q); }
        return rest.Trim('/', ' ').ToLowerInvariant();
    }

    private static void ParseQuery(string uri, out string server, out string user, out string portRaw)
    {
        server = ""; user = ""; portRaw = "";
        int q = uri == null ? -1 : uri.IndexOf('?');
        if (q < 0) { return; }
        foreach (string pair in uri.Substring(q + 1).Split('&', ';'))
        {
            int eq = pair.IndexOf('=');
            if (eq < 1) { continue; }
            string k = pair.Substring(0, eq).Trim().ToLowerInvariant();
            string v = Decode(pair.Substring(eq + 1).Trim());
            if (k == "server") { server = v; }
            else if (k == "user") { user = v; }
            else if (k == "port") { portRaw = v; }
        }
    }

    private static int PickPort(string portRaw)
    {
        int p;
        if (!string.IsNullOrEmpty(portRaw) &&
            int.TryParse(portRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out p) &&
            p >= 1 && p <= 65535) { return p; }
        return DefaultPort;
    }

    private static string Decode(string s)
    {
        if (s == null) { return ""; }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '+') { sb.Append(' '); }
            else if (c == '%' && i + 2 < s.Length)
            {
                int v;
                if (int.TryParse(s.Substring(i + 1, 2),
                    NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v))
                { sb.Append((char)v); i += 2; }
                else { sb.Append(c); }
            }
            else { sb.Append(c); }
        }
        return sb.ToString();
    }

    // ------------------------------------------------------------------
    // Credential Manager READ-ONLY probe: cmdkey /list, stdout captured,
    // bounded. Never prompts, never writes.
    // ------------------------------------------------------------------
    private static bool HasCredEntry(string fqdn)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmdkey.exe", "/list");
            psi.UseShellExecute = false;             // capture stdout
            psi.RedirectStandardOutput = true;
            Process p = Process.Start(psi);
            if (p == null) { return false; }
            string outp = p.StandardOutput.ReadToEnd();
            p.WaitForExit(15000);
            return outp.IndexOf("TERMSRV/" + fqdn, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch { return false; }
    }

    private static string RegCommand()
    {
        try
        {
            using (Microsoft.Win32.RegistryKey k =
                Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\ghrdp\shell\open\command"))
            {
                if (k != null)
                {
                    object v = k.GetValue("");
                    if (v != null) { return Convert.ToString(v); }
                }
            }
            return "(not registered - run install.cmd)";
        }
        catch (Exception ex) { return "(unreadable: " + ex.GetType().Name + ")"; }
    }

    // ------------------------------------------------------------------
    // [F15 §1.5] ghrdp://check - verb self test, no server required: the user
    // (or install.cmd) must SEE a MessageBox proving the exe runs.
    // ------------------------------------------------------------------
    private static int RunCheck(string uri, string host, int port)
    {
        string server; string user; string portRaw;
        ParseQuery(uri, out server, out user, out portRaw);
        string cred = "(no server arg)";
        if (FqdnRe.IsMatch(server))
        {
            cred = HasCredEntry(server)
                ? "present (TERMSRV/" + server + ")"
                : "absent (Windows will prompt once on the first rdp launch)";
        }
        string reg = RegCommand();
        string text = Stamp + "\n\n" +
            "reg  HKCU\\Software\\Classes\\ghrdp\\shell\\open\\command\n     " + reg + "\n\n" +
            "TERMSRV credential: " + cred + "\n\n" +
            "log: " + LogPath() + "\n\n" +
            "You are reading this dialog, so the exe RAN. If it never appears, Defender" +
            " or policy blocked the exe - read the log above.";
        LogJson("check", "check", "reg=" + reg + " cred=" + cred);
        HelloBounded(host, port, "check", true, "check-shown");
        ShowBox("ghrdp launcher check", text);
        return 0;
    }

    // ------------------------------------------------------------------
    // [F15 §1.2] The credential step. cmdkey itself owns the only window that
    // can ask for the password; it is created VISIBLE, in Normal style, with
    // the system directory as CWD, and we NEVER touch stdout/stderr of it.
    // ------------------------------------------------------------------
    private static int CmdkeyStep(string server, string user, string host, int port)
    {
        if (HasCredEntry(server))
        {
            LogJson("cmdkey", "rdp", "TERMSRV/" + server + " already present (cmdkey /list parse) - no prompt");
            HelloBounded(host, port, "rdp", true, "cmdkey-stored=true");
            return 0;
        }
        ProcessStartInfo psi = new ProcessStartInfo("cmdkey.exe",
            "/generic:TERMSRV/" + server + " /user:" + user + " /pass");
        psi.UseShellExecute = true;                    // cmdkey gets its own console
        psi.WindowStyle = ProcessWindowStyle.Normal;   // NEVER hidden
        psi.WorkingDirectory = Environment.SystemDirectory;
        LogJson("cmdkey", "rdp", "interactive cmdkey prompt shown (generic TERMSRV/" + server + ", user " + user + ")");
        HelloBounded(host, port, "rdp", true, "cmdkey-shown");
        Process p = Process.Start(psi);
        if (p == null) { throw new InvalidOperationException("cmdkey.exe did not start"); }
        int waitMs = CmdkeyTimeoutMs;
        string labMs = Environment.GetEnvironmentVariable("GHRDP_LAB_CMDKEY_TIMEOUT_MS");
        int parsedMs;
        if (!string.IsNullOrEmpty(labMs) &&
            int.TryParse(labMs, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedMs) &&
            parsedMs >= 1000 && parsedMs < CmdkeyTimeoutMs)
        {
            waitMs = parsedMs;
            LogJson("cmdkey", "rdp", "lab-only prompt bound active: " + waitMs + "ms (production = " + CmdkeyTimeoutMs + "ms)");
        }
        if (!p.WaitForExit(waitMs))
        {
            try { p.Kill(); } catch { }
            LogJson("error", "rdp", "cmdkey prompt timed out after 180s - killed, mstsc NOT started");
            HelloBounded(host, port, "rdp", false, "cmdkey-timeout");
            ShowBox("ghrdp: cmdkey prompt timed out",
                "cmdkey prompt timed out\n\nThe Windows password prompt stayed open for 180 seconds" +
                " (or never appeared at all).\nNothing was stored and mstsc was NOT started.\n\n" +
                "log: " + LogPath());
            return 1;
        }
        bool stored = HasCredEntry(server);
        LogJson("cmdkey", "rdp", "prompt exited code=" + p.ExitCode +
            " verify(TERMSRV/" + server + ")=" + (stored ? "stored" : "absent"));
        HelloBounded(host, port, "rdp", stored, "cmdkey-stored=" + (stored ? "true" : "false"));
        if (!stored)
        {
            ShowBox("ghrdp: credential not stored",
                "The cmdkey prompt closed without a stored TERMSRV/" + server + " entry.\n\n" +
                "OK opens mstsc anyway - mstsc will then ask for the password itself" +
                " (its own visible prompt).\n\nlog: " + LogPath());
        }
        return 0;
    }

    private static string Sha1Hex8(string s)
    {
        using (SHA1 sha = SHA1.Create())
        {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
            StringBuilder hx = new StringBuilder();
            for (int i = 0; i < 8; i++) { hx.Append(h[i].ToString("x2")); }
            return hx.ToString();
        }
    }

    // ------------------------------------------------------------------
    // [F15 §1.3] .rdp write + VISIBLE mstsc; an immediate exit is a visible
    // failure (exit code + last log lines), never a silent nothing.
    // ------------------------------------------------------------------
    private static int MstscStep(string server, string user, string host, int port)
    {
        string rdp = Path.Combine(Path.GetTempPath(), "ghrdp-" + Sha1Hex8(server + "|" + user) + ".rdp");
        string[] lines = new string[] {
            "full address:s:" + server,
            "username:s:" + user,
            "screen mode id:i:2",          // fullscreen = client native resolution (exact aspect)
            "redirectclipboard:i:1",
            "redirectprinters:i:1",
            "redirectdrives:i:1",
            "drivestoredirect:s:*",
            "devicestoredirect:s:*",
            "redirectcomports:i:1",
            "redirectsmartcards:i:1",
            "redirectposdevices:i:1",
            "audiocapturemode:i:1",
            "audiomode:i:0",
            "bandwidthautodetect:i:1",
            "networkautodetect:i:1",
            "connection type:i:7",
            "compression:i:1",
            "bitmapcachepersistenable:i:1",
            "autoreconnection enabled:i:1"
        };
        File.WriteAllLines(rdp, lines);   // local write: no MOTW, no SmartScreen
        long bytes = 0;
        try { bytes = new FileInfo(rdp).Length; } catch { }
        LogJson("rdp", "rdp", "wrote " + rdp + " (" + bytes + " bytes, " + lines.Length +
            " directives, no credential lines)");

        ProcessStartInfo msi = new ProcessStartInfo("mstsc.exe", "\"" + rdp + "\"");
        msi.UseShellExecute = true;
        msi.WindowStyle = ProcessWindowStyle.Normal;   // the client window is the visible surface
        Process m = Process.Start(msi);
        if (m == null) { throw new InvalidOperationException("mstsc.exe did not start"); }
        LogJson("mstsc", "rdp", "started pid=" + m.Id + " rdp=" + rdp);
        if (m.WaitForExit(2000))
        {
            int code = m.ExitCode;
            LogJson("error", "rdp", "mstsc exited within 2s, code=" + code);
            HelloBounded(host, port, "rdp", false, "mstsc-exited=" + code);
            ShowBox("ghrdp: mstsc exited immediately",
                "mstsc exit code " + code + "\n\nlast 5 log lines (" + LogPath() + "):\n\n" + TailLines(5));
            return 4;
        }
        HelloBounded(host, port, "rdp", true, "mstsc-started pid=" + m.Id);

        if (Environment.GetEnvironmentVariable("GHRDP_LAB_KEEP_RDP") != "1")
        {
            Thread.Sleep(8000);
            for (int i = 0; i < 6; i++)
            {
                try { File.Delete(rdp); break; }
                catch { Thread.Sleep(5000); }
            }
        }
        return 0;
    }

    // ------------------------------------------------------------------
    // Work: everything that touches cmdkey/mstsc/disk lives here, strictly
    // AFTER Main's first instruction (the 'invoked' log + beacon).
    // 'host' is the ALREADY-CLAMPED beacon host ("" when the URL server arg is
    // not a *.ts.net FQDN); the rdp target itself is re-parsed and validated
    // below, so a bad target still ends in a MessageBox, never silence.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // [F17 §3] CLIENT-DNS GUARD. Before mstsc - and before any credential
    // prompt - the FQDN must resolve to a Tailscale CGNAT address
    // (100.64/10). A stale or blocked name (client tailscale down, stale node
    // from a previous dispatch, flushdns needed) used to surface inside mstsc
    // as Error 0x904 / Extended 0x7 with no actionable text; now the launcher
    // says exactly what to run, beacons ok:false, and never launches mstsc
    // into a dead name.
    // ------------------------------------------------------------------
    private static bool DnsGuard(string fqdn, string host, int port, out string why)
    {
        why = "";
        try
        {
            IPAddress[] addrs = Dns.GetHostAddresses(fqdn);
            bool tailnet = false;
            string first = "";
            foreach (IPAddress a in addrs)
            {
                if (a.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) { continue; }
                if (first.Length == 0) { first = a.ToString(); }
                byte[] b = a.GetAddressBytes();
                if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) { tailnet = true; }
            }
            if (tailnet) { return true; }
            why = (first.Length == 0) ? "no IPv4 address returned" : "resolves to " + first + " (not in 100.64/10)";
        }
        catch (Exception ex)
        {
            why = "unresolvable (" + ex.GetType().Name + ")";
        }
        LogJson("error", "rdp", "dns-guard: " + why + " for " + fqdn);
        HelloBounded(host, port, "rdp", false, "dns-guard: " + why);
        ShowBox("GHRDP - RDP not launched",
            "DNS stale/blocked - flushdns or check tailscale.\n\n" +
            "name:   " + fqdn + "\nreason: " + why + "\n\n" +
            "On THIS PC run:\n  ipconfig /flushdns\n  tailscale status\n" +
            "(the RDP host must appear as a peer, and the name must match the current run).\n\n" +
            "mstsc was NOT started - never launching into a dead name.\n\nlog: " + LogPath());
        return false;
    }

    private static int DoWork(string uri, string verb, string host, int port)
    {
        if (verb == "check") { return RunCheck(uri, host, port); }

        if (verb != "rdp")
        {
            LogJson("error", verb, "unknown verb '" + verb + "' - no rdp/check work done");
            ShowBox("ghrdp launcher: unknown verb",
                "verb '" + (verb.Length == 0 ? "(none)" : verb) + "' is neither 'rdp' nor 'check'.\n\n" +
                "Use:  ghrdp://rdp?server=<fqdn>&user=<user>\n   or  ghrdp://check\n   or  ghrdp://check?server=<fqdn>\n\n" +
                "log: " + LogPath());
            return 2;
        }

        string server; string user; string portRaw;
        ParseQuery(uri, out server, out user, out portRaw);
        if (!FqdnRe.IsMatch(server) || !UserRe.IsMatch(user))
        {
            LogJson("error", verb, "invalid target server='" + Redact(server) + "' user='" + Redact(user) + "'");
            HelloBounded(host, port, verb, false, "invalid-target");
            ShowBox("ghrdp launcher: invalid target",
                "server must be a *.ts.net FQDN (got '" + server + "') and user must be a plain account name.\n\n" +
                "log: " + LogPath());
            return 3;
        }

        // [F17 §3] client DNS guard: a dead or stale name must fail HERE with
        // actionable text (and an ok:false beacon), not inside mstsc as
        // Error 0x904 / Extended 0x7. Runs before the credential prompt so a
        // user is never asked for a password against a name mstsc cannot use.
        string dnsWhy;
        if (!DnsGuard(server, host, port, out dnsWhy)) { return 4; }

        int rc = CmdkeyStep(server, user, host, port);
        if (rc != 0) { return rc; }     // a timed-out prompt already produced its MessageBox
        return MstscStep(server, user, host, port);
    }

    private static int Main(string[] args)
    {
        // [F15 §1.1 hello-before-work] FIRST instruction of the process: JSONL
        // log line + POST /api/handler-hello {verb, ok:true, details:'invoked'} -
        // BEFORE any cmdkey/mstsc/file work, and with every POST failure caught.
        string uri = JoinArgs(args);
        string verb = PickVerb(uri);
        string server; string user; string portRaw;
        ParseQuery(uri, out server, out user, out portRaw);
        int port = PickPort(portRaw);
        // [F15 §1.1 + §7] The beacon target is the URL server arg, but ONLY when
        // it is a legitimate *.ts.net FQDN: an arbitrary URI (any web page can
        // fire ghrdp://) must not turn the launcher into a POST-to-anywhere
        // primitive. Pure string check - no I/O - so the beacon still goes out
        // before any cmdkey/mstsc/file work.
        string beaconHost = FqdnRe.IsMatch(server) ? server : "";
        LogJson("invoked", verb, "uri=" + Redact(uri) + " log=" + LogPath());
        HelloBounded(beaconHost, port, verb, true, "invoked");

        // [F15 §1.4] global catch: an escaping exception is reported through the
        // SAME two surfaces (log + MessageBox + beacon) - never a silent exit.
        try
        {
            return DoWork(uri, verb, beaconHost, port);
        }
        catch (Exception ex)
        {
            LogJson("error", verb, "unhandled " + ex.GetType().Name + ": " + ex.Message);
            HelloBounded(beaconHost, port, verb, false, ex.GetType().Name);
            ShowBox("ghrdp launcher error",
                ex.GetType().Name + ": " + ex.Message + "\n\n" + Stamp + "\nlog: " + LogPath());
            return 1;
        }
    }
}
