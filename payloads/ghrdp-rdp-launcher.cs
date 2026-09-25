// ghrdp-rdp-launcher.cs  [F10-1]  PS-FREE Windows auto-login protocol launcher.
// Compiled on the CLIENT PC by install.cmd with the in-box .NET Framework 4.x
// csc (C# 5 - keep syntax C#5: no interpolation, no nameof, no ?./?.[]).
// Registers nothing itself; install.cmd writes HKCU\Software\Classes\ghrdp.
//
// Verb:  ghrdp://rdp?server=<fqdn>&user=<user>
//   1. If TERMSRV/<fqdn> is absent from the user's Credential Manager, launch
//      INTERACTIVE cmdkey ONCE (Windows itself prompts for the password -
//      this process never sees, reads, or writes any password or hash).
//   2. Write %TEMP%\ghrdp-<sha1-16>.rdp LOCALLY (local write = no MOTW, no
//      SmartScreen prompt) with fullscreen (screen mode id:i:2) + redirection
//      directives. NO password/hash lines, NO desktopwidth/desktopheight
//      (fullscreen follows the client's native resolution = exact aspect).
//   3. Start mstsc <rdp> visible; delete the temp .rdp best-effort after
//      mstsc has loaded it; POST /api/handler-hello telemetry (no creds).
//
// NLA/CredSSP stay at Windows defaults: this file deliberately OMITS
// 'authentication level', 'prompt for credentials', and 'enablecredsspsupport'.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static class GhrdpRdpLauncher
{
    private static readonly Regex FqdnRe = new Regex(
        @"^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex UserRe = new Regex(
        @"^[A-Za-z0-9_\-\.\\]{1,104}$", RegexOptions.CultureInvariant);

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
                    System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out v))
                { sb.Append((char)v); i += 2; }
                else { sb.Append(c); }
            }
            else { sb.Append(c); }
        }
        return sb.ToString();
    }

    private static bool HasCredEntry(string fqdn)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmdkey.exe", "/list");
            psi.RedirectStandardOutput = true;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process p = Process.Start(psi);
            string outp = p.StandardOutput.ReadToEnd();
            p.WaitForExit(15000);
            return outp.IndexOf("TERMSRV/" + fqdn, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch { return false; }
    }

    private static void EnsureCredEntry(string fqdn, string user)
    {
        // Interactive, exactly once: /pass with no value makes cmdkey itself
        // prompt "Type the password:" in its own console window.
        try
        {
            Process p = Process.Start("cmdkey.exe",
                "/generic:TERMSRV/" + fqdn + " /user:" + user + " /pass");
            if (p != null) { p.WaitForExit(240000); }
        }
        catch { }
    }

    private static void Hello(string fqdn, string verb, bool ok, string details)
    {
        try
        {
            string body = "{\"verb\":\"" + verb + "\",\"ok\":" + (ok ? "true" : "false") +
                ",\"details\":\"" + details.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                "http://" + fqdn + ":7331/api/handler-hello");
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

    // [F10-10] Telemetry must never wedge the launcher: DNS/proxy stalls can
    // outlive HttpWebRequest.Timeout, so the POST runs on a background thread
    // with a hard 5s join. The beacon is advisory (the dashboard reads it best
    // effort) - a dead or unreachable target is a no-op, never a hang.
    private static void HelloBounded(string fqdn, string verb, bool ok, string details)
    {
        System.Threading.Thread t = new System.Threading.Thread(
            delegate() { Hello(fqdn, verb, ok, details); });
        t.IsBackground = true;
        t.Start();
        t.Join(5000);
    }

    private static int Main(string[] args)
    {
        string uri = string.Join(" ", args).Trim().Trim('"');
        int qi = uri.IndexOf("rdp?", StringComparison.OrdinalIgnoreCase);
        if (qi < 0) { return 2; }
        string server = "", user = "";
        foreach (string pair in uri.Substring(qi + 4).Split('&', ';'))
        {
            int eq = pair.IndexOf('=');
            if (eq < 1) { continue; }
            string k = pair.Substring(0, eq).Trim().ToLowerInvariant();
            string v = Decode(pair.Substring(eq + 1).Trim());
            if (k == "server") { server = v; }
            else if (k == "user") { user = v; }
        }
        if (!FqdnRe.IsMatch(server) || !UserRe.IsMatch(user)) { return 3; }

        bool had = HasCredEntry(server);
        if (!had) { EnsureCredEntry(server, user); }
        bool keyNow = had || HasCredEntry(server);

        string hash;
        using (SHA1 sha = SHA1.Create())
        {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(server + "|" + user));
            StringBuilder hx = new StringBuilder();
            for (int i = 0; i < 8; i++) { hx.Append(h[i].ToString("x2")); }
            hash = hx.ToString();
        }
        string rdp = Path.Combine(Path.GetTempPath(), "ghrdp-" + hash + ".rdp");
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
        try { Process.Start("mstsc.exe", "\"" + rdp + "\""); }
        catch { HelloBounded(server, "rdp-launch", false, "mstsc-start-failed"); return 4; }

        HelloBounded(server, "rdp-launch", true,
            "server=" + server + " user=" + user + " credEntry=" + (had ? "present" : (keyNow ? "created" : "skipped")));

        if (Environment.GetEnvironmentVariable("GHRDP_LAB_KEEP_RDP") != "1")
        {
            System.Threading.Thread.Sleep(8000);
            for (int i = 0; i < 6; i++)
            {
                try { File.Delete(rdp); break; }
                catch { System.Threading.Thread.Sleep(5000); }
            }
        }
        return 0;
    }
}
