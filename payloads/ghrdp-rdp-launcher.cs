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
//        [F28 §3] FALLBACK GAP CLOSED: a cmdkey prompt that closes WITHOUT a
//        stored entry (stored=false) never proceeds silently to mstsc. The
//        ticket redemption is retried ONCE; if that also fails, mstsc is
//        launched ONLY WITH the visible native credential prompt and the
//        'fallback-mstsc-native-prompt' beacon is emitted immediately before
//        the launch. CredentialFallbackDecision() is the single decision
//        function for every path (proven side-effect-free by
//        --fallback-selftest).
//     4. Write %TEMP%\ghrdp-<sha1-8>.rdp LOCALLY (local write = no MOTW, no
//        SmartScreen prompt) with fullscreen (screen mode id:i:2) + redirection
//        directives. NO password/hash lines, NO desktopwidth/desktopheight
//        (fullscreen follows the client's native resolution = exact aspect).
//     5. Start mstsc VISIBLE, WaitForExit(2000): still running => beacon
//        'mstsc-started pid=N'; already exited => MessageBox with the exit code
//        + the last 5 log lines (a silently dying mstsc is impossible).
//   ghrdp://recred?server=<fqdn>&user=<user>&t=<ticket>
//     [F28 §2] ONE-CLICK RECOVERY (the dashboard's FIX & RECONNECT button).
//     Same target validation + DNS guard as the rdp verb, then redeem the
//     fresh single-use ticket and OVERWRITE the stored TERMSRV entry through
//     CredWrite (DOMAIN_PASSWORD, plus the GENERIC entry when one exists) -
//     exactly the F27 store path, no typing and no clipboard. Beacon chain:
//     recred-redeemed -> credwrite-ok -> rdp-written -> mstsc-started. A
//     failed redemption is retried ONCE and then falls back to the native
//     credential prompt (never a silent launch). The verb accepts the SAME
//     t-only ticket contract: any credential-ish parameter is refused.
//   ghrdp-rdp-launcher.exe --fallback-selftest
//     [F28 §3] LAB/CI ONLY harness (never reachable from a ghrdp:// URI):
//     runs CredentialFallbackDecision through the full matrix (stored=true =>
//     mstsc; stored=false + retry-redeem-ok => mstsc; stored=false + retry
//     failed => native-prompt, with and without a ticket) and writes one
//     'decision=' line per case to GHRDP_LAB_OUT (default: the JSONL log). It
//     never shows a dialog, never calls cmdkey and never starts mstsc.
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
// [F28 §2] 2.5.0.0: the recred verb (one-click recovery: fresh ticket ->
// CredWrite overwrite -> mstsc) plus the closed fallback gap: a cmdkey prompt
// that stored nothing can no longer reach a silent mstsc - the ticket is
// retried once and the launch then carries the native credential prompt with
// the 'fallback-mstsc-native-prompt' beacon.
[assembly: AssemblyVersion("2.5.0.0")]
[assembly: AssemblyFileVersion("2.5.0.0")]
[assembly: AssemblyTitle("ghrdp-rdp-launcher")]

internal static class GhrdpRdpLauncher
{
    private const string Ver = "2.5.0.0";
    private const string Stamp = "ghrdp-rdp-launcher " + Ver + " (F28 recred+fallback-gap)";
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

    // [F28 §3] LAB/CI ONLY: '--fallback-selftest' is not a URI verb (a
    // ghrdp:// URI can never produce it) and it is a PURE decision matrix - no
    // I/O, no dialog, no cmdkey, no mstsc - so it proves the shipped
    // fallback-gap rule without a credential store. Cases: stored=true (no
    // prompt needed), stored=false + retry-redeem-ok (the retry recovered),
    // stored=false with the retry failing with and without a ticket (both MUST
    // end in the native-prompt path - the closed gap).
    private static bool IsFallbackSelfTest(string[] args)
    {
        return args != null && args.Length > 0 && args[0] == "--fallback-selftest";
    }

    private static int FallbackSelfTestMain()
    {
        bool[] storeMissing = new bool[] { false, true, true, true };
        bool[] ticketPresent = new bool[] { false, true, true, false };
        bool[] retryOk = new bool[] { false, false, true, false };
        string[] expected = new string[] { "mstsc", "native-prompt", "mstsc", "native-prompt" };
        StringBuilder sb = new StringBuilder();
        string outPath = Environment.GetEnvironmentVariable("GHRDP_LAB_OUT");
        if (string.IsNullOrEmpty(outPath)) { outPath = Path.Combine(Path.GetTempPath(), "ghrdp-fallback-selftest.txt"); }
        for (int i = 0; i < expected.Length; i++)
        {
            string decision = CredentialFallbackDecision(storeMissing[i], ticketPresent[i], retryOk[i]);
            string line = "case=" + i +
                " storeMissing=" + (storeMissing[i] ? "true" : "false") +
                " ticketPresent=" + (ticketPresent[i] ? "true" : "false") +
                " retryRedeemOk=" + (retryOk[i] ? "true" : "false") +
                " decision=" + decision + " expected=" + expected[i] +
                " nativePrompt=" + (decision == "native-prompt" ? "true" : "false") +
                " beacon=" + (decision == "native-prompt" ? "fallback-mstsc-native-prompt" : "(none)") +
                " verdict=" + (decision == expected[i] ? "pass" : "FAIL") +
                " mstscLaunched=0 cmdkeyCalled=0";
            sb.AppendLine(line);
            LogJson("fallback-selftest", "fallback-selftest", line);
        }
        try { File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false)); } catch { }
        LogJson("fallback-selftest", "fallback-selftest", "matrix written to " + outPath +
            " verdicts=" + (sb.ToString().IndexOf("verdict=FAIL") < 0 ? "all-pass" : "SEE-FAIL"));
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

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);
    // [F30 §2.1 purge-begin] Enumerate + delete EVERY existing TERMSRV entry for
    // THIS fqdn before the fresh write (command-line ground truth 2026-09-26:
    // 100+ stale cmdkey entries exist as a MIX of "Domain:" (type 2) and
    // "LegacyGeneric:" (type 1) targets for old tailnet IPs - mstsc then
    // reuses a stale one and the host rejects it). CredEnumerate is filtered to
    // "TERMSRV/*", and only an EXACT "TERMSRV/<fqdn>" target (case-insensitive)
    // of type 2/1 is deleted: nothing here reads, exports or touches another
    // host's credential, and no credential value is ever logged.
    [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDelete(string target, uint type, uint flags);
    private static int PurgeStaleTermsvr(string fqdn)
    {
        string want = "TERMSRV/" + fqdn;
        int purged = 0;
        IntPtr array = IntPtr.Zero;
        uint count = 0;
        try
        {
            // No entries at all (ERROR_NOT_FOUND) is the normal first-launch case.
            if (!CredEnumerate("TERMSRV/*", 0, out count, out array)) { return 0; }
            for (uint i = 0; i < count; i++)
            {
                IntPtr item = Marshal.ReadIntPtr(array, (int)i * IntPtr.Size);
                if (item == IntPtr.Zero) { continue; }
                Credential c = (Credential)Marshal.PtrToStructure(item, typeof(Credential));
                string target = (c.TargetName == null) ? "" : c.TargetName;
                if (!target.Equals(want, StringComparison.OrdinalIgnoreCase)) { continue; }
                // CRED_TYPE_DOMAIN_PASSWORD (2) + the legacy CRED_TYPE_GENERIC
                // (1) cmdkey /generic created. Any other type is left alone.
                if (c.Type != 2 && c.Type != 1) { continue; }
                if (CredDelete(target, c.Type, 0)) { purged++; }
            }
        }
        catch { }
        finally { if (array != IntPtr.Zero) { CredFree(array); } }
        return purged;
    }
    private static string PurgeBeacon(int purged)
    {
        return "purged " + purged + " stale entries, wrote new as Domain";
    }
    // [F30 §2.1 purge-end]

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
    private static int WriteCredential(string fqdn, string user, string pass)
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
            // [F30 §2.1] Is a legacy GENERIC entry present? Decide BEFORE the
            // purge, because the purge DELETES it (a stale value must never be
            // refreshed or kept) - and its fresh twin is re-created below.
            IntPtr old = IntPtr.Zero;
            bool genericPresent = CredRead(c.TargetName, 1, 0, out old);
            int readError = Marshal.GetLastWin32Error();
            if (old != IntPtr.Zero) { CredFree(old); }
            if (!genericPresent && readError != 1168) // ERROR_NOT_FOUND is the only expected miss
            { throw new InvalidOperationException("credwrite-legacy-inspection-failed"); }
            // [F30 §2.1] PURGE BEFORE WRITE: every existing TERMSRV/<fqdn> entry
            // (Domain type 2 AND LegacyGeneric type 1) is deleted through
            // CredDelete, so no stale value can survive into this connection.
            int purged = PurgeStaleTermsvr(fqdn);
            if (!CredWrite(ref c, 0))
            { throw new InvalidOperationException("credwrite-failed code=" + Marshal.GetLastWin32Error()); }
            // The pre-F27 interactive /generic created a separate type-1 entry.
            // CredWrite keys by (target,type): writing type 2 cannot replace it,
            // so when one existed it is RE-CREATED from the fresh blob (never
            // refreshed from the stale one the purge just removed).
            if (genericPresent)
            {
                c.Type = 1; // existing CRED_TYPE_GENERIC compatibility entry
                if (!CredWrite(ref c, 0))
                { throw new InvalidOperationException("credwrite-legacy-failed code=" + Marshal.GetLastWin32Error()); }
            }
            return purged;
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
        return RedeemAndStoreStep(uri, server, user, host, port, "ticket-redeemed");
    }
    // [F28 §2] redeemStep names the FIRST beacon of the handoff chain: the
    // one-click recovery verb reports 'recred-redeemed' so the dashboard can
    // tell a recovery redemption from a first-launch redemption.
    private static string RedeemAndStoreStep(string uri, string server, string user, string host, int port, string redeemStep)
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
            HandoffStep(host, port, redeemStep, true);
            int purgedCreds = 0;
            try { purgedCreds = WriteCredential(server, user, pass); }
            catch { HandoffStep(host, port, "credwrite-failed", false); throw; }
            HandoffStep(host, port, "credwrite-ok", true);
            // [F30 §2.1] The purge count is VISIBLE evidence: "purged 0 stale
            // entries, wrote new as Domain" on a clean PC, "purged 2 ..." when
            // the Domain + LegacyGeneric twins for this fqdn both existed.
            LogJson("handoff", "rdp", PurgeBeacon(purgedCreds));
            HandoffStep(host, port, PurgeBeacon(purgedCreds), true);
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
    // [F28 §3 fallback-gap-begin] The ONE decision every launch path uses.
    // storeMissing: the credential step ended WITHOUT a stored TERMSRV entry
    //   (a cmdkey prompt that closed storing nothing, or a failed first
    //   redemption). retryOk: the single retry redemption SUCCEEDED (CredWrite
    //   overwrite already emitted credwrite-ok). A "native-prompt" verdict
    //   means: emit the fallback-mstsc-native-prompt beacon immediately before
    //   starting mstsc WITH the visible native credential prompt. No path may
    //   launch mstsc with a known-absent credential without that beacon.
    // Pure function (no I/O) so --fallback-selftest can prove the whole table.
    private static string CredentialFallbackDecision(bool storeMissing, bool ticketPresent, bool retryOk)
    {
        if (!storeMissing) { return "mstsc"; }
        if (ticketPresent && retryOk) { return "mstsc"; }
        return "native-prompt";
    }
    // [F28 §3 fallback-gap-end]
    // [F27 handoff-end]

    // [F28 §3] Outcome contract: "stored" (TERMSRV entry verified), "missing"
    // (a prompt ran and closed with nothing stored - the caller must NOT go
    // straight to mstsc), "abort" (timeout / could not start - already handled
    // visibly, the caller returns without launching anything).
    private static string CmdkeyStep(string server, string user, string host, int port, bool forcePrompt = false)
    {
        if (!forcePrompt && HasCredEntry(server))
        {
            LogJson("cmdkey", "rdp", "TERMSRV/" + server + " already present (cmdkey /list parse) - no prompt");
            HelloBounded(host, port, "rdp", true, "cmdkey-stored=true");
            return "stored";
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
            return "abort";
        }
        bool stored = HasCredEntry(server);
        LogJson("cmdkey", "rdp", "prompt exited code=" + p.ExitCode +
            " verify(TERMSRV/" + server + ")=" + (stored ? "stored" : "absent"));
        HelloBounded(host, port, "rdp", stored, "cmdkey-stored=" + (stored ? "true" : "false"));
        if (!stored)
        {
            // [F28 §3] The old path showed "OK opens mstsc anyway". That is the
            // gap: mstsc then ran with a KNOWN-ABSENT credential (or a stale
            // one) and the 0x904/0x6A poison class came back. The caller now
            // retries the ticket redemption once and otherwise launches ONLY
            // with the native credential prompt (+ its beacon).
            LogJson("error", "rdp", "credential not stored - mstsc must NOT start silently; the caller retries the ticket once, else the native-prompt path runs");
            ShowBox("ghrdp: credential not stored",
                "The cmdkey prompt closed without a stored TERMSRV/" + server + " entry.\n\n" +
                "mstsc is NOT started into an empty credential. The launcher retries the" +
                " one-time ticket once; if that fails, mstsc opens WITH its own visible" +
                " password prompt instead.\n\nlog: " + LogPath());
            return "missing";
        }
        return "stored";
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

    // [F28 §3] nativePrompt=true is the closed-gap launch: the credential store
    // is known to hold nothing usable for this target (the retry redemption
    // failed too), so mstsc is started WITH its own visible credential prompt
    // (/prompt never suppresses or automates anything) and the
    // 'fallback-mstsc-native-prompt' beacon is emitted IMMEDIATELY BEFORE the
    // launch - a silent launch with a known-absent credential is impossible.
    private static int MstscStep(string server, string user, string host, int port, bool nativePrompt = false)
    {
        string rdp = Path.Combine(Path.GetTempPath(), "ghrdp-" + Sha1Hex8(server + "|" + user) + ".rdp");
        string[] lines = RdpLines(server, user);
        File.WriteAllLines(rdp, lines);   // local write: no MOTW, no SmartScreen
        long bytes = 0;
        try { bytes = new FileInfo(rdp).Length; } catch { }
        LogJson("rdp", "rdp", "wrote " + rdp + " (" + bytes + " bytes, " + lines.Length +
            " directives, no credential lines)");

        HandoffStep(host, port, "rdp-written", true);
        if (nativePrompt)
        {
            // No stored credential is known-good: the user types it into WINDOWS'
            // OWN prompt (this process never sees it), and the beacon names the
            // reason before the window exists.
            LogJson("mstsc", "rdp", "native credential prompt path: no stored TERMSRV/" + server +
                " entry could be established (ticket retry failed); mstsc starts with /prompt");
            HandoffStep(host, port, "fallback-mstsc-native-prompt", false);
        }
        ProcessStartInfo msi = new ProcessStartInfo("mstsc.exe", nativePrompt ? ("\"" + rdp + "\" /prompt") : ("\"" + rdp + "\""));
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

        // [F28 §2] 'recred' (one-click recovery) shares every target validation
        // below; only the redemption/fallback policy differs.
        if (verb != "rdp" && verb != "recred")
        {
            LogJson("error", verb, "unknown verb '" + verb + "' - no rdp/recred/check work done");
            ShowBox("ghrdp launcher: unknown verb",
                "verb '" + (verb.Length == 0 ? "(none)" : verb) + "' is none of 'rdp', 'recred' or 'check'.\n\n" +
                "Use:  ghrdp://rdp?server=<fqdn>&user=<user>\n   or  ghrdp://recred?server=<fqdn>&user=<user>&t=<ticket>\n" +
                "   or  ghrdp://check\n   or  ghrdp://check?server=<fqdn>\n\n" +
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

        if (verb == "recred") { return RecredStep(uri, server, user, host, port); }

        string fallback = RedeemAndStore(uri, server, user, host, port);
        if (fallback == null) { return MstscStep(server, user, host, port); }

        HandoffStep(host, port, FallbackBeacon(fallback), false);
        // A ticket-less link (the legacy interactive path) must not force a
        // prompt when a TERMSRV entry is already present.
        bool forcePrompt = (fallback != "ticket-missing");
        string storeOutcome;
        if (forcePrompt) { storeOutcome = CmdkeyStep(server, user, host, port, true); }
        else { storeOutcome = CmdkeyStep(server, user, host, port); }
        if (storeOutcome == "abort") { return 1; }   // the timeout already produced its MessageBox
        if (storeOutcome == "stored") { return MstscStep(server, user, host, port); }

        // [F28 §3] stored=false: retry the ONE-TIME ticket redemption ONCE
        // (a fresh CredWrite overwrite is the only sanctioned silent store
        // path), then decide between the normal launch and the visible native
        // credential prompt. Nothing here ever launches mstsc silently with a
        // known-absent credential.
        bool ticketPresent = (TicketFromUri(uri).Length > 0);
        bool retryOk = false;
        if (ticketPresent)
        {
            LogJson("cmdkey", "rdp", "no TERMSRV entry after the prompt - retrying the one-time ticket redemption ONCE (F28 fallback-gap)");
            string retry = RedeemAndStore(uri, server, user, host, port);
            retryOk = (retry == null);
            if (!retryOk) { LogJson("error", "rdp", "ticket retry failed (" + retry + ") - native credential prompt path next"); }
        }
        string decision = CredentialFallbackDecision(true, ticketPresent, retryOk);
        LogJson("cmdkey", "rdp", "fallback decision=" + decision +
            " (stored=false ticketPresent=" + (ticketPresent ? "true" : "false") +
            " retryRedeemOk=" + (retryOk ? "true" : "false") + ")");
        if (decision == "native-prompt") { return MstscStep(server, user, host, port, true); }
        return MstscStep(server, user, host, port);
    }

    // [F28 §2] ONE-CLICK RECOVERY (ghrdp://recred). The dashboard mints a
    // fresh single-use 60s ticket from the same bearer-gated endpoint as the
    // first launch; this verb redeems it and OVERWRITES the stored TERMSRV
    // entry through CredWrite (type 2 + the legacy type-1 entry when present) -
    // no typing, no clipboard, no credential beyond the ticket ever in a URL.
    // A first redemption failure is retried ONCE (tickets are single-use, so
    // the dashboard issues a brand new one for the click); if both fail the
    // launch falls back to the visible native credential prompt.
    private static int RecredStep(string uri, string server, string user, string host, int port)
    {
        LogJson("recred", "rdp", "one-click recovery: redeem a fresh ticket and overwrite TERMSRV/" + server +
            " via CredWrite (no typing, no clipboard)");
        bool ticketPresent = (TicketFromUri(uri).Length > 0);
        string first = RedeemAndStoreStep(uri, server, user, host, port, "recred-redeemed");
        if (first == null) { return MstscStep(server, user, host, port); }
        HandoffStep(host, port, FallbackBeacon(first), false);
        bool retryOk = false;
        if (ticketPresent)
        {
            LogJson("recred", "rdp", "recovery redemption failed (" + first + ") - retrying ONCE");
            string second = RedeemAndStore(uri, server, user, host, port);
            retryOk = (second == null);
            if (!retryOk) { LogJson("error", "recred", "retry failed (" + second + ") - native credential prompt path next"); }
        }
        string decision = CredentialFallbackDecision(true, ticketPresent, retryOk);
        LogJson("recred", "rdp", "recovery fallback decision=" + decision +
            " (ticketPresent=" + (ticketPresent ? "true" : "false") + " retryRedeemOk=" + (retryOk ? "true" : "false") + ")");
        if (decision == "native-prompt") { return MstscStep(server, user, host, port, true); }
        return MstscStep(server, user, host, port);
    }

    private static int Main(string[] args)
    {
        // [F19 §5] LAB/CI-ONLY: '--dns-selftest' is not a URI verb (a ghrdp://
        // URI can never produce it) and it is a pure argument check - no I/O -
        // so the 'invoked' beacon below is still the first work of every real
        // invocation.
        if (IsDnsSelfTest(args)) { return DnsSelfTestMain(args); }
        // [F28 §3] LAB/CI-ONLY: '--fallback-selftest' is not a URI verb and is a
        // pure argument check - no I/O - so the 'invoked' beacon below is still
        // the first work of every real invocation.
        if (IsFallbackSelfTest(args)) { return FallbackSelfTestMain(); }

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
