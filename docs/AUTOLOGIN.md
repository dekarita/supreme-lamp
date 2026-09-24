# GHRDP native auto-login (VPS only)

WEB DESKTOP is the primary dashboard action for both VPS and ephemeral hosts.
Native AUTO-LOGIN is offered **only** when the server reports `hostKind=vps`
and its FQDN, certificate and NLA checks pass. The fallback is a normal
`mstsc /v:<fqdn>` shortcut. The user performs both one-time steps below on
their own Windows PC; nothing installs or stores a credential from the page.

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
