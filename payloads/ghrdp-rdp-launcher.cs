// ghrdp-rdp-launcher.cs - [F10 s1] PS-free ghrdp://rdp protocol handler.
// Compiled by install.cmd with the in-box .NET Framework csc.exe (C# 5).
// Double-click install only: no script host, no admin, no download, no UAC.
//
// Verb: ghrdp://rdp?server=<*.ts.net fqdn>&user=<name>[&hello=<origin>]
//   (a) if TERMSRV/<fqdn> is absent -> launch an INTERACTIVE cmdkey ONCE
//       (Windows prompts for the password; it is stored by Windows, never
//       seen by this program, this page, or any log)
//   (b) write %TEMP%\ghrdp-<hash>.rdp LOCALLY (local write = no MOTW, so no
//       SmartScreen): full address, username, screen mode id:2 (fullscreen =
//       client native resolution => exact aspect match), clipboard, printers,
//       drives, COM ports, smart cards, POS devices, audio capture,
//       bandwidth autodetect, persistence order, compression.
//       desktopwidth/desktopheight are OMITTED (fullscreen follows client).
//       NEVER embeds a password or any password hash in the .rdp.
//   (c) start mstsc <rdp> visible
//   (d) delete the temp .rdp after mstsc holds it (best-effort)
//   (e) POST /api/handler-hello to the dashboard origin (best-effort beacon;
//       no token, no credentials, never in the URL)
//
// Locks: NLA/CredSSP untouched; no credential material in URIs, .rdp files,
// process command lines, logs or artifacts. Unknown verbs (ghrdp:connect?)
// pass through to a legacy GhrdpHandler.exe beside this executable when present.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace Ghrdp
{
    internal static class RdpLauncher
    {
        private static readonly Regex FqdnRe = new Regex(
            @"^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$", RegexOptions.IgnoreCase);
        private static readonly Regex UserRe = new Regex(@"^[a-z0-9._\-]{1,64}$", RegexOptions.IgnoreCase);
        private static readonly Regex HelloRe = new Regex(
            @"^https?://[a-z0-9\.\-]+(:\d{2,5})?$", RegexOptions.IgnoreCase);
        private static readonly string[] ForbiddenQueryKeys = new string[]
            { "pass", "password", "pwd", "hash", "secret", "token", "cred" };

        [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredEnumerateW(string filter, int flags, out int count, out IntPtr pcred);

        [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
        private static extern bool CredFree(IntPtr buffer);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Credential
        {
            public int Flags;
            public int Type;
            public IntPtr TargetName;
            public IntPtr Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist;
            public int AttributeCount;
            public IntPtr Attributes;
            public IntPtr TargetAlias;
            public IntPtr UserName;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            try { return Run(args); }
            catch { return 1; }
        }

        private static int Run(string[] args)
        {
            if (args == null || args.Length == 0) { return 2; }
            Uri uri;
            try { uri = new Uri(args[0]); }
            catch { return 2; }
            if (!string.Equals(uri.Host, "rdp", StringComparison.OrdinalIgnoreCase)) {
                return ForwardLegacy(args[0]);
            }
            string q = uri.Query;
            if (q.StartsWith("?")) { q = q.Substring(1); }
            string server = GetParam(q, "server");
            string user = GetParam(q, "user");
            string hello = GetParam(q, "hello");
            foreach (string raw in q.Split('&'))
            {
                int eq = raw.IndexOf('=');
                if (eq <= 0) { continue; }
                string k = raw.Substring(0, eq).ToLowerInvariant();
                foreach (string bad in ForbiddenQueryKeys)
                {
                    if (k == bad) { return 2; } // no credential material in URIs, ever
                }
            }
            if (server == null || !FqdnRe.IsMatch(server)) { return 2; }
            if (user == null || !UserRe.IsMatch(user)) { return 2; }
            server = server.ToLowerInvariant();

            // (a) interactive cmdkey ONCE when no stored TERMSRV credential exists.
            string target = "TERMSRV/" + server;
            if (!CredentialStored(target))
            {
                ProcessStartInfo cmd = new ProcessStartInfo(
                    "cmd.exe", "/c cmdkey /generic:" + target + " /user:" + user);
                cmd.UseShellExecute = true; // visible console; Windows prompts once
                using (Process p = Process.Start(cmd)) { if (p != null) { p.WaitForExit(); } }
            }

            // (b) local temp .rdp - no password, no hash, no desktop dimensions.
            string hash = Sha1Hex(server + "|" + user).Substring(0, 16);
            string rdpPath = Path.Combine(Path.GetTempPath(), "ghrdp-" + hash + ".rdp");
            string[] lines = new string[]
            {
                "full address:s:" + server,
                "username:s:" + user,
                "screen mode id:i:2",
                "redirectclipboard:i:1",
                "redirectprinters:i:1",
                "redirectdrives:i:1",
                "drivestoredirect:s:*",
                "devicestoredirect:s:*",
                "redirectcomports:i:1",
                "redirectsmartcards:i:1",
                "redirectposdevices:i:1",
                "audiocapturemode:i:1",
                "bandwidthautodetect:i:1",
                "persistenceorder:i:1",
                "compression:i:1"
            };
            File.WriteAllText(rdpPath, string.Join("\r\n", lines) + "\r\n", new UTF8Encoding(false));

            // (c) visible mstsc with the temp file (fullscreen = client native).
            int exit = 3;
            ProcessStartInfo mi = new ProcessStartInfo("mstsc.exe", "\"" + rdpPath + "\"");
            mi.UseShellExecute = true;
            using (Process mstsc = Process.Start(mi))
            {
                if (mstsc != null)
                {
                    exit = 0;
                    // (d) best-effort cleanup once mstsc has had time to hold it.
                    string keep = Environment.GetEnvironmentVariable("GHRDP_KEEP_RDP");
                    if (!string.Equals(keep, "1", StringComparison.Ordinal))
                    {
                        System.Threading.Thread.Sleep(1500);
                        for (int i = 0; i < 5; i++)
                        {
                            try { File.Delete(rdpPath); break; }
                            catch { System.Threading.Thread.Sleep(500); }
                        }
                    }
                }
            }

            // (e) best-effort handler beacon (JSON body only; nothing secret).
            PostHello(hello);
            return exit;
        }

        private static int ForwardLegacy(string rawUri)
        {
            try
            {
                string exe = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ghrdp", "GhrdpHandler.exe");
                if (File.Exists(exe))
                {
                    ProcessStartInfo psi = new ProcessStartInfo(exe, "\"" + rawUri + "\"");
                    psi.UseShellExecute = false;
                    using (Process p = Process.Start(psi)) { if (p != null) { p.WaitForExit(15000); } }
                    return 0;
                }
            }
            catch { }
            return 3;
        }

        private static string GetParam(string query, string name)
        {
            foreach (string raw in query.Split('&'))
            {
                int eq = raw.IndexOf('=');
                if (eq <= 0) { continue; }
                if (string.Equals(raw.Substring(0, eq), name, StringComparison.OrdinalIgnoreCase))
                {
                    try { return Uri.UnescapeDataString(raw.Substring(eq + 1)); }
                    catch { return null; }
                }
            }
            return null;
        }

        private static bool CredentialStored(string target)
        {
            int count = 0;
            IntPtr list = IntPtr.Zero;
            try
            {
                if (!CredEnumerateW(null, 0, out count, out list) || count <= 0) { return false; }
                int size = Marshal.SizeOf(typeof(Credential));
                for (int i = 0; i < count; i++)
                {
                    IntPtr p = new IntPtr(list.ToInt64() + (long)i * size);
                    Credential c = (Credential)Marshal.PtrToStructure(p, typeof(Credential));
                    string name = Marshal.PtrToStringUni(c.TargetName);
                    if (name != null && string.Equals(name, target, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
                return false;
            }
            catch { return false; }
            finally { if (list != IntPtr.Zero) { try { CredFree(list); } catch { } } }
        }

        private static void PostHello(string helloOrigin)
        {
            if (string.IsNullOrEmpty(helloOrigin) || !HelloRe.IsMatch(helloOrigin)) { return; }
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                    helloOrigin.TrimEnd('/') + "/api/handler-hello");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 3000;
                req.ReadWriteTimeout = 3000;
                byte[] body = Encoding.UTF8.GetBytes(
                    "{\"verb\":\"connect\",\"ok\":true,\"details\":\"rdp-launch\"}");
                using (Stream s = req.GetRequestStream()) { s.Write(body, 0, body.Length); }
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) { }
            }
            catch { }
        }

        private static string Sha1Hex(string text)
        {
            using (SHA1 sha = SHA1.Create())
            {
                byte[] hb = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
                StringBuilder sb = new StringBuilder(hb.Length * 2);
                for (int i = 0; i < hb.Length; i++) { sb.Append(hb[i].ToString("x2")); }
                return sb.ToString();
            }
        }
    }
}
