# GHRDP native auto-login

## 0. PS-free WINDOWS AUTO-LOGIN (primary path, F10+)

One-time, on your own Windows PC — **no script host, no admin, no binary
download**:

1. Copy `payloads\install.cmd` and `payloads\ghrdp-rdp-launcher.cs` from the
   repo into one folder (use "Download raw file" in the GitHub UI, twice).
2. Double-click `install.cmd`. It compiles the launcher with the in-box
   .NET Framework 4.x C# compiler (`csc.exe` — part of Windows) and registers
   the `ghrdp://` protocol under HKCU only. No UAC prompt appears.
3. On Mission Control, press **WINDOWS AUTO-LOGIN**. mstsc opens fullscreen
   (your monitor's native resolution, exact aspect) with drive, clipboard,
   printer, COM, smart-card, POS and microphone redirection, bitmap cache and
   bandwidth autodetect.
4. The FIRST time for a new `<fqdn>`, Windows itself asks once for the
   password (interactive `cmdkey` window). After that there are **0 prompts**.
   Neither the page nor the launcher ever sees the password; the temporary
   `.rdp` file is written locally (no MOTW, no SmartScreen) and deleted
   after mstsc loads it. It never contains a password or hash. NLA and
   CredSSP stay at Windows defaults.

### 0.1 If Windows asked "Open Windows PowerShell?" (stale registration, F12)

A pre-F2 install registered `ghrdp://` at the old **script host**. Your PC keeps
that HKCU value until something overwrites it, so Windows shows the old prompt
even though the server side is clean. `install.cmd` (F12-1) now:

* prints the handler value **BEFORE** it touches anything,
* writes `HKCU\Software\Classes\ghrdp\shell\open\command` = `"<exe>" "%1"`,
* prints the value **AFTER**, and
* verifies the readback points at the compiled launcher (non-zero exit + a
  message otherwise).

Mission Control also watches for the launcher's `/api/handler-hello` beacon for
**20 s after the click**: no beacon -> notice *"If Windows offered to open
PowerShell, your PC has a stale ghrdp registration - run `install.cmd` once"*
plus the copy-once install text. An HKCU registration always wins over an old
machine-wide (HKLM) entry for your user, so one run is enough.

### 0.2 Why a password can never be embedded in the .rdp (fallback B)

mstsc accepts a password in an `.rdp` file only as a `password 51:b:` blob that
is **DPAPI-encrypted with the CLIENT machine's key** (`CryptProtectData`, user
scope). A file generated on the server (or in CI) therefore can never carry a
usable password — the blob would be undecryptable on your PC, and a plaintext
password is refused by NLA/CredSSP. That is a property of mstsc, not a policy
choice, so this repository never embeds a password anywhere: not in `.rdp`
files, not in URLs, not in query strings, logs, artifacts or step summaries.

**Fallback B (measured, not preferred).** If you cannot run `install.cmd`, the
dashboard's KEYS row gives you the `mstsc /v:<fqdn>` fallback line to paste
locally: mstsc then prompts once for the credential (or uses the one you stored
once with `cmdkey /generic:TERMSRV/<fqdn> /user:<user> /pass`). Expect exactly
one extra interactive prompt for path B versus **0** for path A after the first
connection; path A stays primary.

If the button reports a missing handler, the install hint with the file path
appears under it; **WEB DESKTOP** remains the zero-install path.
Expected latency: **< 80 ms round-trip on a direct WireGuard path**. The
CONNECTIVITY row shows the server-side `tailscale ping` to your PC
(ms + `direct` | `relay`). On `relay` (DERP) an advisory appears:
"direct WireGuard not established - check client firewall UDP 41641" —
allow outbound UDP 41641 on your PC's firewall/router.

## 1. Legacy path (VPS compiled handler, pre-F10)

WEB DESKTOP is the primary dashboard action for both VPS and ephemeral hosts.
Native AUTO-LOGIN is offered **only** when the server reports `hostKind=vps`
and its FQDN, certificate and NLA checks pass. The fallback is a normal
`mstsc /v:<fqdn>` shortcut. VPS provisioning alone does not deploy the web
gateway or dashboard service; the operator must do that separately before
WEB DESKTOP can open. The user performs both one-time steps below on their
own Windows PC; nothing installs or stores a credential from the page.

### 1.1 Store the credential interactively

Replace `<fqdn>` with the exact `*.ts.net` name from the VPS dashboard:

```text
cmdkey /generic:TERMSRV/<fqdn> /user:rdpuser
```

Windows prompts for the password. Never add `/pass:` or type a password in
the dashboard. The Credential Manager entry must match the VPS name and
RDP-Tcp Let's Encrypt certificate. In the dashboard, tick **I ran cmdkey**
only *after* running it; copying the line does not create a credential.
The tick is a local assertion, not a test of Credential Manager.

### 1.2 Register the compiled protocol handler (optional)

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

## 2. Dashboard credentials and runner browser policy (F10+)

**Credential rows (gated).** Mission Control's *Indexes & keys* section shows
the Windows user, the Windows password and the VNC password. They are served
**only** by the dash-token-gated `/api/config` `creds` block to a
token-authenticated or in-tailnet dashboard request; the screen shows a
last-4 mask and the copy button copies the real value. Bare loopback (host-side
self-tests) never receives them. They are never placed in URLs, logs, workflow
summaries, artifacts or pull requests. `VNC_PASS` is stamped into the host
config at dispatch for exactly this purpose and is never printed.

**Extensions (enforced).** When Edge first starts on the runner, uBlock Origin
and Dark Reader are force-installed via
`HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist`. The
extension IDs are **resolved at build time from live store pages** by
`payloads/edge-ext-resolve.ps1` (store search page -> vendor page -> SERP ->
store search page, then a detail-page publisher/title check) and never carried
in the repository; an ID that cannot be discovered *and* verified is skipped
with a loud warning rather than guessed. `edge://policy` is the source of
truth on the runner.

**Bookmarks (managed).** `ManagedFavorites` contains exactly Mission Control,
the `docs/AUTOLOGIN.md` page and the Tailscale admin DNS page. No third-party
index, torrent or piracy site is ever added (launch-gates fails the build if
such a string appears in the workflow).

## 4. F12 close-out behaviour (provisioning, VNC memory, timers)

**Cert bind is fail-closed.** The `Bind tailnet LE cert to RDP-Tcp` step runs
**only after** the MagicDNS gate (it consumes the `TS_MAGICDNS_FQDN` value that
step proved), retries `tailscale cert` **3 times, 10 s apart**, and every failure
path (fetch, PFX import, registry fallback, thumbprint mismatch) now throws with
`reason cert-not-bound` plus the error text in the step summary — a green run can
no longer report `cert bound = NO`. On success the summary carries the
`Thumbprint:` line. `/api/native-status` is unchanged.

**All-browser provisioning.** Edge and Chrome get uBlock Origin + Dark Reader
through `ExtensionInstallForcelist`; Firefox (when installed) gets the same two
extensions via `distribution\policies.json`, where **both** the add-on id
(`guid`) and the xpi URL are resolved live from the AMO API at build time
(`Resolve-AmoAddon`) — no extension id and no download URL is carried in this
repo, and an unresolvable slug is skipped loudly instead of guessed. After the
writes, the workflow reads the policy keys back (`Get-ForcedEntryCount`) and
checks each value has the browser-accepted `<32-char id>;<update url>` shape;
the lab (cell K) additionally launches Edge so the forced extensions are really
unpacked into a profile. Managed bookmarks stay at exactly Mission Control,
`docs/AUTOLOGIN.md` and the Tailscale admin DNS page — repository automation
never adds index/torrent bookmarks.

**qBittorrent.** Installed as a **plain cached app** (`winget`, installer reused
from the cache dir) and set as the default handler for `.torrent` and `magnet:`.
The ProgId is *discovered* from the installed shell registration
(`payloads/ghrdp-provision-apps.ps1`), then `HKCR\.torrent` and
`HKCR\magnet\shell\open\command` are written and read back. There is **no**
download automation, no index, no mirror and no torrent Web UI anywhere in the
pipeline (launch-gates fails the build if any of that reappears).

**VNC password memory.** The dashboard stores the VNC password on
`remember`/first entry and hands it to the noVNC tab with a
`postMessage(..., exact-origin)`; the shim injected into the served `vnc.html`
accepts it only from `window.opener` at that exact origin, fills the Credentials
dialog, retries **5 × 500 ms**, then purges the variable and drops the opener.
The password never appears in a URL (`password=` is gated out), a log or an
artifact; websockify logs stay clean.

**Timers, latency, clean session.** RDP USAGE accumulates server-side (5 s tick)
while an RDP session or a webdesk client is attached, freezes within 20 s after
both drop and resumes on reconnect (lab cell I). noVNC runs with
`compression=6`, TightVNC gets `PollUnderCursor`/`PollForeground`/`CompareFB`
plus a `PreferZlib` write for builds that honour it, and every host helper is
launched hidden under a SYSTEM scheduled task — zero console windows in the
interactive session.
