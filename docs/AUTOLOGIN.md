# GHRDP native auto-login (VPS only)

## 0. WINDOWS AUTO-LOGIN redirect (F10, zero script host)

The dashboard button **[WINDOWS AUTO-LOGIN]** fires
`ghrdp://rdp?server=<*.ts.net>&user=<name>&hello=<dashboard-origin>` - no
password, hash, or token ever travels in the URI. The handler ships in this
repo as `payloads/ghrdp-rdp-launcher.cs` plus `payloads/install.cmd`:

1. Double-click `install.cmd` once on your Windows PC (keep it next to the
   `.cs` file). It compiles the launcher with the **in-box** .NET Framework
   `csc.exe` into `%LOCALAPPDATA%\ghrdp\` and registers the **current-user**
   `ghrdp:` protocol. No download, no admin/UAC, no script host.
2. On the first click, if `TERMSRV/<fqdn>` is absent, the launcher opens an
   interactive `cmdkey` window - Windows prompts for the password once and
   stores it itself. Later clicks are fully silent (NLA/CredSSP unchanged).
3. The launcher writes a **local** `%TEMP%\ghrdp-<hash>.rdp` (local write: no
   Mark-of-the-Web, no SmartScreen) containing fullscreen
   (`screen mode id:2`, width/height omitted = client native resolution) and
   clipboard/printers/drives/COM/smart-card/POS/audio redirection. It never
   contains a password or hash; `mstsc` consumes it, and it is deleted
   best-effort right after.
4. The launcher POSTs `/api/handler-hello` so the dashboard can show the
   handler as seen. If the handler is absent, the dashboard shows the
   copy-once `install.cmd` path and points to **WEB DESKTOP** as the
   zero-install path.

Latency expectations: direct tailnet path should stay **under ~80 ms**
browser RTT; the CONNECTIVITY row shows the runner-side `tailscale ping`
(`pingMs` + `path direct|relay`). A `relay` path means direct WireGuard is
not established - check the client firewall for UDP 41641 before anything
else. noVNC opens with `compression=6`, the TightVNC server polls with
`PollUnderCursor=0` + `CompareFB=1`, and the generated `.rdp` uses
`bandwidthautodetect:i:1`.

Credentials (Windows user + password, VNC password) are shown masked
(last 4) with copy buttons in the KEYS section, served **only** to requests
carrying the dashboard token via `/api/config`. No other endpoint returns
them; none of them ever appear in URLs, logs, summaries, or artifacts.

WEB DESKTOP is the primary dashboard action for both VPS and ephemeral hosts.
Native AUTO-LOGIN is offered **only** when the server reports `hostKind=vps`
and its FQDN, certificate and NLA checks pass. The fallback is a normal
`mstsc /v:<fqdn>` shortcut. VPS provisioning alone does not deploy the web
gateway or dashboard service; the operator must do that separately before
WEB DESKTOP can open. The user performs both one-time steps below on their
own Windows PC; nothing installs or stores a credential from the page.

## 1. Store the credential interactively

Replace `<fqdn>` with the exact `*.ts.net` name from the VPS dashboard:

```text
cmdkey /generic:TERMSRV/<fqdn> /user:rdpuser
```

Windows prompts for the password. Never add `/pass:` or type a password in
the dashboard. The Credential Manager entry must match the VPS name and
RDP-Tcp Let's Encrypt certificate. In the dashboard, tick **I ran cmdkey**
only *after* running it; copying the line does not create a credential.
The tick is a local assertion, not a test of Credential Manager.

## 2. Register the compiled protocol handler (optional)

Download the `ghrdp-handler-win-x64` artifact from a successful
**launch-gates** run for the reviewed revision. Keep `GhrdpHandler.exe` in a
stable location on your PC, inspect its provenance, then run it yourself:

```text
GhrdpHandler.exe --install <fqdn>
```

This registers `ghrdp:` **for the current Windows user only** and saves
only the pinned public VPS FQDN under `%LOCALAPPDATA%\ghrdp\handler-fqdn.txt`.
It does not copy or unblock the executable, remove Mark-of-the-Web, bypass
SmartScreen, change browser permissions, or touch credentials. If Windows
blocks an untrusted executable, **do not bypass the warning**; use the manual
`mstsc` fallback until a trusted/signed handler is available. Keep the EXE
at the registered path. The first browser protocol dispatch may also ask for
confirmation; that is a browser safety prompt, not an RDP credential prompt.

The old script-based handler does **not** support the new rid-only URI;
installing this compiled handler replaces its `ghrdp:` registration. The
button never launches a script host.

## 3. Connect

Click **AUTO-LOGIN (VPS only)** on the authenticated dashboard. The click:

1. Sends the dashboard token in the `Authorization: Bearer` header of a POST
   to `/api/rdp-token` (not in this request's URL). The VPS requires this
   header even for callers already inside the tailnet and returns a random
   60-second single-use `rid`.
2. Dispatches `ghrdp:connect?rid=<rid>` to the local EXE. The URI contains
   no host, username, password, or dashboard token. The EXE never logs it.
3. POSTs `{"token":"<rid>"}` to the *pinned* `http://<fqdn>:7331/api/rdp-creds`
   over the encrypted private Tailscale network; redirects are forbidden.
   The server returns only `{"fqdn":"<fqdn>"}`. The EXE rejects a different
   host or a non-`*.ts.net` FQDN, then opens `mstsc /v:<fqdn>`.
4. Windows consumes the stored `TERMSRV/<fqdn>` credential. NLA/CredSSP
   remain enabled and the server's LE certificate must match. The page
   cannot prove that mstsc authenticated; verify the first connection.

If the handler is absent, use the dashboard's copyable `mstsc /v:<fqdn>`
command instead. Rejected/expired rid? Click again for a fresh one; a rid
cannot be reused. A token issued before a server restart also expires.

## Verification and cleanup

Run `cmdkey /list` locally and verify a `TERMSRV/<fqdn>` target under the
correct Windows user. Check the VPS certificate and NLA status in the
browser; then manually test `mstsc /v:<fqdn>` before relying on the button.
The Windows build in `launch-gates` parses the server scripts and runs the
compiled handler's local FQDN/URI self-tests; only a live client can prove
that Credential Manager, browser protocol dispatch and RDP actually work.

To remove access on your PC, delete the current-user `ghrdp:` protocol key,
`%LOCALAPPDATA%\ghrdp\handler-fqdn.txt`, and your own TERMSRV entry with
`cmdkey /delete:TERMSRV/<fqdn>` if no longer needed. Do not put a password
into the deletion command.
