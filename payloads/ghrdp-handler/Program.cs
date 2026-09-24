using System.Diagnostics;
using System.Net.Http;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace GhrdpHandler;

internal static class Program
{
    // The URI deliberately carries only a short-lived, single-use rid. The
    // dashboard cannot select a target; installation pins the API/TERMSRV FQDN.
    private static readonly Regex RidPattern = new(@"\Aghrdp:connect\?rid=([0-9a-f]{32})\z",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex FqdnPattern = new(
        @"\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.ts\.net\z",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private static bool ValidFqdn(string? value) =>
        value is { Length: > 0 and <= 253 } && FqdnPattern.IsMatch(value);

    private static string? ParseRid(string uri)
    {
        Match match = RidPattern.Match(uri);
        return match.Success ? match.Groups[1].Value.ToLowerInvariant() : null;
    }

    private static string ConfigPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ghrdp", "handler-fqdn.txt");

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (args is ["--self-test"]) return SelfTest();
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            if (args is ["--install", var fqdn])
            {
                Install(fqdn);
                Console.WriteLine("Protocol handler registered for the pinned VPS FQDN.");
                return 0;
            }
            if (args is [var uri] && ParseRid(uri) is { } rid)
            {
                await ConnectAsync(rid);
                return 0;
            }
            throw new ArgumentException("Expected --install <vps-fqdn>.ts.net or a ghrdp:connect URI.");
        }
        catch (Exception ex)
        {
            // Never print the URI, rid, server response, credential or command line.
            Console.Error.WriteLine($"GHRDP handler failed ({ex.GetType().Name}). Use the manual mstsc fallback.");
            return 1;
        }
    }

    [SupportedOSPlatform("windows")]
    private static void Install(string fqdn)
    {
        if (!ValidFqdn(fqdn)) throw new ArgumentException("A MagicDNS VPS FQDN is required.");
        string exe = Environment.ProcessPath ?? throw new InvalidOperationException();
        if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Install from the published Windows executable.");
        Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
        // Only the public node name is saved, never a password, token or key.
        File.WriteAllText(ConfigPath, fqdn.ToLowerInvariant() + Environment.NewLine, Encoding.UTF8);
        using RegistryKey root = Registry.CurrentUser.CreateSubKey(@"Software\Classes\ghrdp")
            ?? throw new InvalidOperationException();
        root.SetValue(null, "URL:ghrdp Protocol");
        root.SetValue("URL Protocol", "");
        using RegistryKey command = root.CreateSubKey(@"shell\open\command")
            ?? throw new InvalidOperationException();
        command.SetValue(null, $"\"{exe}\" \"%1\"");
    }

    [SupportedOSPlatform("windows")]
    private static async Task ConnectAsync(string rid)
    {
        string server = File.ReadAllText(ConfigPath, Encoding.UTF8).Trim();
        if (!ValidFqdn(server)) throw new InvalidDataException("Invalid pinned FQDN.");

        // TCP/7331 is available only on the private Tailscale network: WireGuard
        // encrypts this HTTP request. Never redirect the bearer to another host.
        using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false };
        using var client = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(6),
            MaxResponseContentBufferSize = 1024
        };
        using var request = new HttpRequestMessage(HttpMethod.Post,
            new Uri($"http://{server}:7331/api/rdp-creds"));
        request.Content = new StringContent(JsonSerializer.Serialize(new { token = rid }),
            Encoding.UTF8, "application/json");
        using HttpResponseMessage response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        string json = await response.Content.ReadAsStringAsync();
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement data = document.RootElement;
        if (data.ValueKind != JsonValueKind.Object || data.EnumerateObject().Count() != 1 ||
            !data.TryGetProperty("fqdn", out JsonElement field) || field.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Expected an FQDN-only response.");
        string? target = field.GetString();
        if (!ValidFqdn(target) || !string.Equals(target, server, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Server name differs from the pinned VPS.");

        // The password stays in Windows Credential Manager, where the USER ran
        // cmdkey interactively. No process here reads or supplies credentials.
        var start = new ProcessStartInfo("mstsc.exe") { UseShellExecute = false };
        start.ArgumentList.Add("/v:" + target);
        using Process process = Process.Start(start) ?? throw new InvalidOperationException();
    }

    private static int SelfTest()
    {
        if (!ValidFqdn("vps.example.ts.net") || ValidFqdn("100.64.0.1") ||
            ValidFqdn("vps.evil.test") || ValidFqdn("-bad.example.ts.net") ||
            ParseRid("ghrdp:connect?rid=0123456789abcdef0123456789abcdef") is null ||
            ParseRid("ghrdp:connect?rid=0123456789abcdef0123456789abcdef&pass=foo") is not null ||
            ParseRid("ghrdp:connect?server=evil.ts.net&rid=0123456789abcdef0123456789abcdef") is not null)
            throw new InvalidOperationException("Handler self-test failed.");
        Console.WriteLine("Handler self-test OK");
        return 0;
    }
}
