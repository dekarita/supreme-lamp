// ghrdp-rdp-launcher.cs  [F15]  FAIL-VISIBLE Windows auto-login protocol launcher.
// Compiled on the CLIENT PC by install.cmd with the in-box .NET Framework 4.x
// csc (C# 5 - keep syntax C#5: no interpolation, no nameof, no ?./?.[]).
// Registers nothing itself; install.cmd writes HKCU\Software\Classes\ghrdp.
//
// Verbs:
//   ghrdp://rdp?server=<fqdn>&user=<user>[&port=<1-65535>][&ip=<tailnet-ipv4>]
//     1. Beacon FIRST (JSONL log line + POST /api/handler-hello, details
//        'invoked') before any other work, so a dashboard sees the click even
//        if everything below fails. The beacon carries the exe version stamp
//        ("exe" field) so /api/native-status can flag an outdated client
//        launcher [F19 §2].
//     2. [F17 §3] CLIENT-DNS GUARD: resolve <fqdn>; if resolution fails or the
//        name does not resolve to a tailnet address (100.64.0.0/10, or the
//        fd7a:115c:a1e0::/48 tailnet ULA IPv6), show the "DNS stale/blocked -
//        flushdns or check Tailscale" MessageBox, beacon ok:false, and NEVER
//        launch mstsc into a dead or poisoned name (mstsc 0x904/0x7 class).
//        [F19 §2] If the caller passed ip=<tailnet-ipv4> (the dashboard does;
//        an address is NOT a credential) and that address answers on 3389
//        while the NAME does not resolve, the diagnosis is exact - "Your
//        Tailscale DNS is off..." with the one-line fix, beacon ok:false
//        details='client-dns-off'. The mstsc target STAYS the FQDN; the IP is
//        used for DIAGNOSIS ONLY (cert-name trust).
//        [F19 §2] A URL carrying any credential-ish parameter
//        (pass|password|passwd|pwd|token|key|secret|apikey|authkey|cred...) is
//        REFUSED outright - beacon ok:false details='cred-param-rejected' and
//        no cmdkey/mstsc work (this launcher never accepts secrets in a URL).
//     3. F27: redeem t, overwrite TERMSRV via CredWrite; on redemption failure ONLY,
//        use the legacy interactive fallback below. If TERMSRV/<fqdn> is absent from the user's Credential Manager, launch
//        INTERACTIVE cmdkey ONCE in a VISIBLE Normal window (Windows itself
//        prompts for the password - this process never sees, reads, or writes
//        any password or hash), WaitForExit(180000), then VERIFY the entry with
//        a cmdkey /list parse.
//     4. Write %TEMP%\ghrdp-<sha1-8>.rdp LOCALLY (local write = no MOTW, no
//        SmartScreen prompt) with fullscreen (screen mode id:i:2) + redirection
//        directives. NO password/hash lines, NO desktopwidth/desktopheight
//        (fullscreen follows the client's native resolution = exact aspect).
//     5. Start mstsc VISIBLE, WaitForExit(2000): still running => beacon
//        'mstsc-started pid=N'; already exited => MessageBox with the exit code
//        + the last 5 log lines (a silently dying mstsc is impossible).
//   ghrdp://check[?server=<fqdn>]
//     install-time / user-triggered self test: MessageBox with the registered
//     reg command, TERMSRV presence, the log path and the exe version stamp.
//   ghrdp-rdp-launcher.exe --dns-selftest [<fqdn> <ip>]
//     [F19 §5] LAB/CI ONLY harness (never reachable from a ghrdp:// URI): runs
//     the DNS-guard DECISION matrix with injected resolver/TCP results
//     (GHRDP_LAB_DNS_RESULT=fail|notailnet|ok, GHRDP_LAB_TCP_RESULT=open|closed)
//     and writes one 'decision=' line per case to GHRDP_LAB_OUT (default: the
//     JSONL log). It never shows a dialog, never calls cmdkey and never starts
//     mstsc - so a headless CI runner can prove the guard logic itself.
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
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// [F20 §2] 2.4.0.0: the immediate-mstsc-exit dialog now points at the
// dashboard's evidence-based 0x904/0x7 fallback (CONNECTION DIAGNOSTICS ->
// "if mstsc still fails") instead of leaving the user with a bare exit code.
[assembly: AssemblyVersion("2.4.0.0")]
[assembly: AssemblyFileVersion("2.4.0.0")]
[assembly: AssemblyTitle("ghrdp-rdp-launcher")]

internal static class GhrdpRdpLauncher
{
    private const string Ver = "2.4.0.0";
    private const string Stamp = "ghrdp-rdp-launcher " + Ver + " (F27 ticket-CredWrite)";
    private const int DefaultPort = 7331;
    // [F19 §2] the RDP TCP port used ONLY for the client-DNS diagnosis probe
    // (the mstsc target itself always stays the MagicDNS FQDN).
    private const int RdpPort = 3389;
    private const int DiagConnectMs = 2000;
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
        // [F19 §2] a credential-ish QUERY PARAM is REFUSED before any work, and
        // its value must never reach the log even in the refusal line.
        r = Regex.Replace(r, @"(?i)\b(pass|password|passwd|pwd|token|key|secret|apikey|authkey|cred)\s*=\s*[^\s&""]+", "$1=[redacted]");
        r = Regex.Replace(r, @"(?i)([?&;](?:t|%74)=)[^&;\s]+", "$1[redacted]");
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
            // [F19 §2] the beacon carries the exe version stamp: the server
            // compares it against config.launcherVersion (the repo constant)
            // and flags an outdated client launcher. Version string only -
            // never a credential, path or user.
            string body = "{\"verb\":\"" + J(verb) + "\",\"ok\":" + (ok ? "true" : "false") +
                ",\"details\":\"" + J(Redact(details)) + "\",\"exe\":\"" + J(Stamp) + "\"}";
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
    // [F17 §3] CLIENT-DNS GUARD: never launch mstsc into a dead or poisoned
    // name (the mstsc 0x904 / 0x7 transport failure class). The MagicDNS FQDN
    // must RESOLVE, and to a TAILNET address only: 100.64.0.0/10 IPv4, or the
    // fd7a:115c:a1e0::/48 Tailscale ULA IPv6. Resolver failure, zero
    // addresses, or a public/other address => reason string; null = safe.
    // GHRDP_LAB_DNS_ALLOW_LOOPBACK=1 is the documented LAB-ONLY relaxation
    // (headless CI runners reach the launcher through a hosts-file loopback
    // alias); production never sets it.
    // ------------------------------------------------------------------
    private static bool IsTailnetAddress(IPAddress a)
    {
        byte[] b;
        try { b = a.GetAddressBytes(); } catch { return false; }
        return b.Length == 4 && b[0] == 100 && b[1] >= 64 && b[1] <= 127;
    }

    private static string DnsGuardReason(string server)
    {
        // [F19 §5] LAB/CI-ONLY injection so the guard decision can be unit
        // tested headlessly. It REPLACES the resolver result for this call;
        // production never sets it and always resolves for real.
        string labDns = Environment.GetEnvironmentVariable("GHRDP_LAB_DNS_RESULT");
        if (labDns == "fail")
        {
            LogJson("dns-guard", "rdp", "GHRDP_LAB_DNS_RESULT=fail: resolver result injected (lab-only switch, never a production default)");
            return "DNS resolution failed: " + server + " (injected lab resolver result). Run ipconfig /flushdns and confirm Tailscale connected.";
        }
        if (labDns == "notailnet")
        {
            LogJson("dns-guard", "rdp", "GHRDP_LAB_DNS_RESULT=notailnet: resolver result injected (lab-only switch, never a production default)");
            return "DNS returned non-tailnet IP: 203.0.113.9 (injected lab resolver result). Flush DNS and retry. (every answer must be in 100.64.0.0/10)";
        }
        if (labDns == "ok")
        {
            LogJson("dns-guard", "rdp", "GHRDP_LAB_DNS_RESULT=ok: resolver result injected as tailnet-valid (lab-only switch, never a production default)");
            return null;
        }
        IPAddress[] addrs;
        try { addrs = Dns.GetHostAddresses(server); }
        catch (Exception ex) { return "DNS resolution failed: " + server + " (" + ex.GetType().Name + "). Run ipconfig /flushdns and confirm Tailscale connected."; }
        if (addrs == null || addrs.Length == 0) { return "DNS resolution failed: " + server + ". Run ipconfig /flushdns and confirm Tailscale connected."; }
        bool allTailnet = true;
        bool allLoopback = true;
        StringBuilder rejected = new StringBuilder();
        foreach (IPAddress a in addrs)
        {
            if (!IsTailnetAddress(a))
            {
                allTailnet = false;
                if (rejected.Length > 0) { rejected.Append(", "); }
                rejected.Append(a.ToString());
            }
            if (!IPAddress.IsLoopback(a)) { allLoopback = false; }
        }
        if (allTailnet) { return null; }
        string lab = Environment.GetEnvironmentVariable("GHRDP_LAB_DNS_ALLOW_LOOPBACK");
        if (lab == "1" && allLoopback)
        {
            LogJson("warn", "rdp", "GHRDP_LAB_DNS_ALLOW_LOOPBACK=1: loopback hosts-alias accepted for " + server + " (lab-only switch, never a production default)");
            return null;
        }
        return "DNS returned non-tailnet IP: " + rejected.ToString() + ". Flush DNS and retry. (every answer must be in 100.64.0.0/10)";
    }

    // ------------------------------------------------------------------
    // [F19 §2] CLIENT-DNS-OFF DIAGNOSIS (IP is not a credential).
    // The dashboard appends &ip=<runner tailnet IPv4> to the ghrdp://rdp URL.
    // When the NAME does not resolve but that ADDRESS answers on 3389, the
    // client resolver is the fault - not the runner, not the credential - and
    // the user gets the exact one-line fix. The mstsc target stays the FQDN.
    // ------------------------------------------------------------------
    private static string TailnetIpFromUri(string uri)
    {
        if (string.IsNullOrEmpty(uri)) { return ""; }
        int q = uri.IndexOf('?');
        if (q < 0) { return ""; }
        foreach (string pair in uri.Substring(q + 1).Split('&', ';'))
        {
            int eq = pair.IndexOf('=');
            if (eq < 1) { continue; }
            if (pair.Substring(0, eq).Trim().ToLowerInvariant() != "ip") { continue; }
            string v = Decode(pair.Substring(eq + 1).Trim());
            IPAddress parsed;
            if (!IPAddress.TryParse(v, out parsed)) { return ""; }
            if (!IsTailnetAddress(parsed)) { return ""; }
            return v;   // only a well-formed 100.64.0.0/10 dotted quad survives
        }
        return "";
    }

    // [F19 §2] REFUSAL: a ghrdp:// URL may NEVER carry a secret. Any
    // credential-ish parameter name is rejected before cmdkey/mstsc, and the
    // value is redacted out of the log by Redact().
    private static readonly Regex CredParamRe = new Regex(
        @"(^|(?<=[?&;]))(pass|password|passwd|pwd|token|key|secret|apikey|authkey|cred|creds)(?==)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static string CredentialParamName(string uri)
    {
        if (string.IsNullOrEmpty(uri)) { return ""; }
        int q = uri.IndexOf('?');
        if (q < 0) { return ""; }
        foreach (string pair in uri.Substring(q + 1).Split('&', ';'))
        {
            int eq = pair.IndexOf('=');
            if (eq < 1) { continue; }
            string k = Decode(pair.Substring(0, eq)).Trim();
            if (CredParamRe.IsMatch("?" + k + "=")) { return k.ToLowerInvariant(); }
        }
        return "";
    }

    // Is the tailnet address reachable on the RDP port? DIAGNOSIS ONLY - a
    // positive answer never becomes the mstsc target (cert-name trust).
    // GHRDP_LAB_TCP_RESULT=open|closed is the documented LAB-ONLY injection
    // (headless runners cannot open a real RDP socket); production never sets
    // it and always performs the real bounded TCP connect.
    private static bool IpReachable(string ip, int port)
    {
        if (string.IsNullOrEmpty(ip)) { return false; }
        string lab = Environment.GetEnvironmentVariable("GHRDP_LAB_TCP_RESULT");
        if (lab == "open") { LogJson("dns-guard", "rdp", "GHRDP_LAB_TCP_RESULT=open: TCP probe injected as reachable for " + ip + ":" + port + " (lab-only switch, never a production default)"); return true; }
        if (lab == "closed") { LogJson("dns-guard", "rdp", "GHRDP_LAB_TCP_RESULT=closed: TCP probe injected as unreachable for " + ip + ":" + port + " (lab-only switch, never a production default)"); return false; }
        System.Net.Sockets.TcpClient c = null;
        try
        {
            c = new System.Net.Sockets.TcpClient();
            IAsyncResult ar = c.BeginConnect(ip, port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(DiagConnectMs, false)) { return false; }
            c.EndConnect(ar);
            return c.Connected;
        }
        catch { return false; }
        finally { try { if (c != null) { c.Close(); } } catch { } }
    }

    // [F19 §2] The DECISION - pure, no I/O, so the lab harness can drive every
    // case with injected results:
    //   "mstsc"           - the name resolved to tailnet addresses: launch.
    //   "client-dns-off"  - name unreachable BUT the tailnet IP answers on the
    //                       RDP port: client Tailscale DNS is off. ONE fix.
    //   "dns-fail"        - anything else: the F17 DNS stale/blocked box.
    private static string DnsDecision(string dnsReason, string ip, bool ipReachable)
    {
        if (dnsReason == null) { return "mstsc"; }
        if (!string.IsNullOrEmpty(ip) && ipReachable) { return "client-dns-off"; }
        return "dns-fail";
    }

    private static string ClientDnsOffText(string server, string ip, string dnsProblem)
    {
        return "Your Tailscale DNS is off. Run once: tailscale set --accept-dns=true" +
            " (or tray -> Use Tailscale DNS), then ipconfig /flushdns, then retry." +
            "\n\nDiagnosis: the name " + server + " does NOT resolve on this PC," +
            " but the tailnet address " + ip + ":" + RdpPort + " IS reachable." +
            "\nSo the runner and the network are fine - only this PC's DNS view of the" +
            " tailnet is missing (Tailscale -> Use Tailscale DNS, or" +
            " `tailscale set --accept-dns=true` once, then `ipconfig /flushdns`)." +
            "\n\nResolver detail: " + dnsProblem +
            "\n\nmstsc was NOT started. mstsc will still target " + server +
            " (the certificate name) - never the IP." +
            "\n\nlog: " + LogPath();
    }

    // [F19 §5] LAB/CI-ONLY harness: run the guard decision matrix with injected
    // resolver/TCP results. No dialog, no cmdkey, no mstsc, no real network.
    private static bool IsDnsSelfTest(string[] args)
    {
        return args != null && args.Length > 0 && args[0] == "--dns-selftest";
    }

    private static int DnsSelfTestMain(string[] args)
    {
        string server = args.Length > 1 ? args[1] : "lab-target.dekarita.tailnet-lab.ts.net";
        string ip = args.Length > 2 ? args[2] : "100.64.0.7";
        string[,] cases = new string[,] {
            { "fail",     "open",   ip,  "client-dns-off" },
            { "fail",     "closed", ip,  "dns-fail" },
            { "ok",       "open",   ip,  "mstsc" },
            { "fail",     "open",   "",  "dns-fail" },
            { "notailnet","open",   ip,  "client-dns-off" }
        };
        StringBuilder sb = new StringBuilder();
        string outPath = Environment.GetEnvironmentVariable("GHRDP_LAB_OUT");
        if (string.IsNullOrEmpty(outPath)) { outPath = Path.Combine(Path.GetTempPath(), "ghrdp-dns-selftest.txt"); }
        for (int i = 0; i < cases.GetLength(0); i++)
        {
            string injDns = cases[i, 0];
            string injTcp = cases[i, 1];
            string caseIp = cases[i, 2];
            string expected = cases[i, 3];
            Environment.SetEnvironmentVariable("GHRDP_LAB_DNS_RESULT", injDns);
            Environment.SetEnvironmentVariable("GHRDP_LAB_TCP_RESULT", injTcp);
            string dnsReason = DnsGuardReason(server);
            bool reach = (dnsReason != null) && IpReachable(caseIp, RdpPort);
            string decision = DnsDecision(dnsReason, caseIp, reach);
            string line = "case=" + i + " injectedDns=" + injDns + " injectedTcp=" + injTcp +
                " ip=" + (caseIp.Length == 0 ? "(none)" : caseIp) +
                " decision=" + decision + " expected=" + expected +
                " verdict=" + (decision == expected ? "pass" : "FAIL") +
                " mstscLaunched=0 cmdkeyCalled=0";
            sb.AppendLine(line);
            LogJson("dns-selftest", "dns-selftest", line);
        }
        Environment.SetEnvironmentVariable("GHRDP_LAB_DNS_RESULT", null);
        Environment.SetEnvironmentVariable("GHRDP_LAB_TCP_RESULT", null);
        try { File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false)); } catch { }
        LogJson("dns-selftest", "dns-selftest", "matrix written to " + outPath + " verdicts=" + (sb.ToString().IndexOf("FAIL") < 0 ? "all-pass" : "SEE-FAIL"));
        return sb.ToString().IndexOf("verdict=FAIL") < 0 ? 0 : 1;
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
    // [F27 handoff-begin] Store API only; no credential UI interaction.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    private static string TicketFromUri(string uri)
    {
        string found = "";
        int q = uri.IndexOf('?');
        if (q < 0) { return found; }
        foreach (string pair in uri.Substring(q + 1).Split('&', ';'))
        {
            int eq = pair.IndexOf('=');
            if (eq < 1 || Decode(pair.Substring(0, eq)).ToLowerInvariant() != "t") { continue; }
            if (found.Length != 0) { return ""; }
            found = Decode(pair.Substring(eq + 1));
        }
        return Regex.IsMatch(found, "^[0-9a-f]{32}$") ? found : "";
    }
    private static void HandoffStep(string host, int port, string step, bool ok)
    {
        LogJson("handoff", "rdp", step);
        HelloBounded(host, port, "rdp", ok, step);
    }
    private static void WriteCredential(string fqdn, string user, string pass)
    {
        byte[] blob = Encoding.Unicode.GetBytes(pass);
        IntPtr buffer = IntPtr.Zero;
        try
        {
            buffer = Marshal.AllocHGlobal(blob.Length);
            Marshal.Copy(blob, 0, buffer, blob.Length);
            Credential c = new Credential();
            c.Type = 2; // CRED_TYPE_DOMAIN_PASSWORD
            c.TargetName = "TERMSRV/" + fqdn;
            c.UserName = user;
            c.CredentialBlobSize = (uint)blob.Length;
            c.CredentialBlob = buffer;
            c.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE, current user's store
            if (!CredWrite(ref c, 0))
            { throw new InvalidOperationException("credwrite-failed code=" + Marshal.GetLastWin32Error()); }
        }
        finally
        {
            if (buffer != IntPtr.Zero)
            {
                for (int n = 0; n < blob.Length; n++) { Marshal.WriteByte(buffer, n, 0); }
                Marshal.FreeHGlobal(buffer);
            }
            Array.Clear(blob, 0, blob.Length);
        }
    }
    // Only redemption errors permit interactive fallback. A bad reply or
    // failed CredWrite aborts, rather than using a potentially poisoned entry.
    private static string RedeemAndStore(string uri, string server, string user, string host, int port)
    {
        string ticket = TicketFromUri(uri);
        if (ticket.Length == 0) { return "ticket-missing"; }
        if (port != DefaultPort) { throw new InvalidOperationException("ticket-port-invalid"); }
        byte[] requestBody = Encoding.UTF8.GetBytes("{\"token\":\"" + ticket + "\"}");
        byte[] responseBody = new byte[16384];
        Dictionary<string, object> reply = null;
        string json = null;
        string pass = null;
        try
        {
            // Pin the socket destination to a freshly validated tailnet IP.
            // Disable OS proxies AND redirects: neither may receive the ticket.
            IPAddress address = null;
            foreach (IPAddress a in Dns.GetHostAddresses(server))
            { if (IsTailnetAddress(a)) { address = a; break; } }
            if (address == null) { return "unreachable"; }
            string authority = address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6
                ? "[" + address.ToString() + "]" : address.ToString();
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://" + authority + ":" + DefaultPort + "/api/rdp-creds");
            req.Host = server + ":" + DefaultPort;
            req.Proxy = null;
            req.AllowAutoRedirect = false;
            req.Timeout = 8000; req.ReadWriteTimeout = 8000;
            req.Method = "POST"; req.ContentType = "application/json";
            req.ContentLength = requestBody.Length;
            int length = 0;
            try
            {
                using (Stream output = req.GetRequestStream()) { output.Write(requestBody, 0, requestBody.Length); }
                using (HttpWebResponse response = (HttpWebResponse)req.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK) { throw new InvalidOperationException("redeem-status-invalid"); }
                    using (Stream input = response.GetResponseStream())
                    {
                        int n;
                        while (length < responseBody.Length && (n = input.Read(responseBody, length, responseBody.Length - length)) > 0) { length += n; }
                        if (length == responseBody.Length) { throw new InvalidOperationException("redeem-response-too-large"); }
                    }
                }
            }
            catch (WebException ex)
            {
                using (HttpWebResponse response = ex.Response as HttpWebResponse)
                {
                    if (response != null && response.StatusCode == HttpStatusCode.Unauthorized) { return "ticket-invalid-or-expired"; }
                    if (response != null) { throw new InvalidOperationException("redeem-rejected"); }
                }
                return "unreachable";
            }
            json = Encoding.UTF8.GetString(responseBody, 0, length);
            reply = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            if (reply == null || !reply.ContainsKey("fqdn") || !reply.ContainsKey("user") || !reply.ContainsKey("pass") ||
                !(reply["pass"] is string) || (string)reply["fqdn"] != server || (string)reply["user"] != user)
            { throw new InvalidOperationException("redeem-target-mismatch"); }
            pass = (string)reply["pass"];
            if (pass.Length == 0 || Encoding.Unicode.GetByteCount(pass) > 2560)
            { throw new InvalidOperationException("redeem-credential-invalid"); }
            HandoffStep(host, port, "ticket-redeemed", true);
            try { WriteCredential(server, user, pass); }
            catch { HandoffStep(host, port, "credwrite-failed", false); throw; }
            HandoffStep(host, port, "credwrite-ok", true);
            return null;
        }
        finally
        {
            Array.Clear(requestBody, 0, requestBody.Length);
            Array.Clear(responseBody, 0, responseBody.Length);
            if (reply != null) { reply.Clear(); }
            // .NET immutable strings may have GC copies: release immediately;
            // never promise deterministic erasure of managed-runtime copies.
            pass = null; json = null; ticket = null;
        }
    }
    private static string FallbackBeacon(string reason) { return "fallback-cmdkey reason=" + reason; }
    // [F27 handoff-end]

    private static int CmdkeyStep(string server, string user, string host, int port)
    {
        if (HasCredEntry(server))
        {
            LogJson("cmdkey", "rdp", "TERMSRV/" + server + " already present (cmdkey /list parse) - no prompt");
            HelloBounded(host, port, "rdp", true, "cmdkey-stored=true");
            return 0;
        }
        ProcessStartInfo psi = new ProcessStartInfo("cmdkey.exe",
            "/generic:TERMSRV/" + server + " /user:" + user);
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
    private static string[] RdpLines(string server, string user)
    {
        return new string[] {
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
    }

    private static int MstscStep(string server, string user, string host, int port)
    {
        string rdp = Path.Combine(Path.GetTempPath(), "ghrdp-" + Sha1Hex8(server + "|" + user) + ".rdp");
        string[] lines = RdpLines(server, user);
        File.WriteAllLines(rdp, lines);   // local write: no MOTW, no SmartScreen
        long bytes = 0;
        try { bytes = new FileInfo(rdp).Length; } catch { }
        LogJson("rdp", "rdp", "wrote " + rdp + " (" + bytes + " bytes, " + lines.Length +
            " directives, no credential lines)");

        HandoffStep(host, port, "rdp-written", true);
        ProcessStartInfo msi = new ProcessStartInfo("mstsc.exe", "\"" + rdp + "\"");
        msi.UseShellExecute = true;
        msi.WindowStyle = ProcessWindowStyle.Normal;   // the client window is the visible surface
        Process m = Process.Start(msi);
        if (m == null) { throw new InvalidOperationException("mstsc.exe did not start"); }
        LogJson("mstsc", "rdp", "started pid=" + m.Id + " rdp=" + rdp);
        if (m.WaitForExit(2000))
        {
            int code = m.ExitCode;
            // [F20 §2] the exit code is logged in BOTH forms (mstsc reports the
            // 0x904/0x7 class in hex), and the dialog now sends the user to the
            // dashboard's evidence-based fallback: export the client + runner
            // event logs and map the failure from them - never guess, and never
            // weaken NLA, CredSSP or certificate validation to "make it work".
            LogJson("error", "rdp", "mstsc exited within 2s, code=" + code + " (0x" +
                code.ToString("X", CultureInfo.InvariantCulture) + ")");
            HelloBounded(host, port, "rdp", false, "mstsc-exited=" + code);
            ShowBox("ghrdp: mstsc exited immediately",
                "mstsc exit code " + code + " (0x" + code.ToString("X", CultureInfo.InvariantCulture) + ")" +
                "\n\nsee dashboard -> CONNECTION DIAGNOSTICS -> \"if mstsc still fails\" and send the exports" +
                "\n\nlast 5 log lines (" + LogPath() + "):\n\n" + TailLines(5));
            return 4;
        }
        HandoffStep(host, port, "mstsc-started", true);

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
    private static int DoWork(string uri, string verb, string host, int port)
    {
        // [F19 §2] REFUSAL FIRST: no ghrdp:// URL may carry a credential. The
        // launcher never needs one (Windows/cmdkey owns the only password
        // surface), so ANY credential-ish parameter aborts before the verb
        // dispatch - no cmdkey, no mstsc, no .rdp.
        string credParam = CredentialParamName(uri);
        if (credParam.Length > 0)
        {
            LogJson("error", verb, "cred-param-rejected: URL carried a credential-ish parameter '" + credParam + "' (value redacted) - no cmdkey/mstsc work");
            HelloBounded(host, port, verb, false, "cred-param-rejected");
            ShowBox("ghrdp launcher: refused credential in URL",
                "This launcher accepts only a short-lived t ticket, never a password or key inside a URL" +
                " (parameter '" + credParam + "').\n\nNothing was stored and mstsc was NOT started." +
                "\n\nUse:  ghrdp://rdp?server=<fqdn>&user=<user>\n" +
                "Windows prompts for the password itself (cmdkey, once per PC)." +
                "\n\nlog: " + LogPath());
            return 6;
        }

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

        // [F17 §3] DNS guard BEFORE any credential or mstsc work: the exact
        // failure behind mstsc Error 0x904 / extended 0x7 was a target name
        // the client PC could not resolve at all (Tailscale down / MagicDNS
        // off / stale resolver cache). mstsc must never be launched into it.
        string dnsProblem = DnsGuardReason(server);
        // [F19 §2] IP-based diagnosis (never a launch target): the dashboard's
        // &ip= tailnet address + the RDP port decide WHICH failure this is.
        string dnsIp = TailnetIpFromUri(uri);
        bool dnsIpReachable = (dnsProblem != null) && IpReachable(dnsIp, RdpPort);
        string dnsDecision = DnsDecision(dnsProblem, dnsIp, dnsIpReachable);
        if (dnsDecision == "client-dns-off")
        {
            LogJson("error", verb, "client-dns-off: name did not resolve but the tailnet IP is reachable on " + RdpPort +
                " - client Tailscale DNS is off; fix: tailscale set --accept-dns=true; server=" + server + " ip=" + dnsIp);
            HelloBounded(host, port, verb, false, "client-dns-off");
            ShowBox("Tailscale DNS is off",
                ClientDnsOffText(server, dnsIp, dnsProblem));
            return 5;
        }
        if (dnsProblem != null)
        {
            LogJson("error", verb, "dns-guard blocked launch: " + dnsProblem + " server=" + server);
            HelloBounded(host, port, verb, false, "dns-guard: " + dnsProblem);
            string boxTitle = dnsProblem.IndexOf("non-tailnet") >= 0 ? "ghrdp: DNS returned non-tailnet IP" : "ghrdp: DNS resolution failed";
            ShowBox(boxTitle,
                "DNS stale/blocked - flushdns or check Tailscale.\n\n" +
                dnsProblem + "\n\n" +
                "FQDN: " + server + "\n" +
                "Run ipconfig /flushdns and confirm Tailscale connected.\n\n" +
                "mstsc was NOT started.\n\n" +
                "log: " + LogPath());
            return 5;
        }
        string resolvedLog = "";
        try
        {
            IPAddress[] okAddrs = Dns.GetHostAddresses(server);
            if (okAddrs != null)
            {
                foreach (IPAddress a in okAddrs)
                {
                    if (IsTailnetAddress(a))
                    {
                        if (resolvedLog.Length > 0) { resolvedLog += ","; }
                        resolvedLog += a.ToString();
                    }
                }
            }
        }
        catch { resolvedLog = "(ok)"; }
        // The guard's ALLOW decision is logged too: a fail-visible log must
        // show why the launch was permitted (tailnet address(es) found), not
        // only why it was blocked ([F17/R] cell asserts "dns-guard ok").
        LogJson("rdp", verb, "DNS resolved " + server + " -> " + resolvedLog + " (dns-guard ok)");

        string fallback = RedeemAndStore(uri, server, user, host, port);
        if (fallback != null)
        {
            HandoffStep(host, port, FallbackBeacon(fallback), false);
            int rc = CmdkeyStep(server, user, host, port);
            if (rc != 0) { return rc; }
        }     // a timed-out prompt already produced its MessageBox
        return MstscStep(server, user, host, port);
    }

    private static int Main(string[] args)
    {
        // [F19 §5] LAB/CI-ONLY: '--dns-selftest' is not a URI verb (a ghrdp://
        // URI can never produce it) and it is a pure argument check - no I/O -
        // so the 'invoked' beacon below is still the first work of every real
        // invocation.
        if (IsDnsSelfTest(args)) { return DnsSelfTestMain(args); }

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
        LogJson("invoked", verb, "protocol invocation log=" + LogPath());
        HelloBounded(beaconHost, port, verb, true, "invoked");

        // [F15 §1.4] global catch: an escaping exception is reported through the
        // SAME two surfaces (log + MessageBox + beacon) - never a silent exit.
        try
        {
            return DoWork(uri, verb, beaconHost, port);
        }
        catch (Exception ex)
        {
            LogJson("error", verb, "unhandled " + ex.GetType().Name);
            HelloBounded(beaconHost, port, verb, false, ex.GetType().Name);
            ShowBox("ghrdp launcher error",
                ex.GetType().Name + " (details withheld)\n\n" + Stamp + "\nlog: " + LogPath());
            return 1;
        }
    }
}
