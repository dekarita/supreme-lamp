# GHRDP Migration & Decommission

**Write-only document. Do not execute the steps below from this session.** This file
is the plan the user (or a future maintainer) follows to move off Actions-as-RDP onto
a real VPS/self-hosted host and then decommission the current workflow safely.

## 1. Migration target: VPS / self-hosted Windows host

The goal is a benign one-click RDP UX with **NLA on**, a trusted certificate, and
private file sync — no C2, no mirror, no plaintext credential transit.

### 1.1 Host requirements

- Windows 10/11 Pro or Windows Server 2019+.
- Static local user account for RDP (not `Administrator`); strong password (user
  supplies out-of-band, never checked into the repo).
- Public IP or tailnet ingress; no direct Internet exposure of TCP/3389.

### 1.2 NLA / RDP configuration (NLA ON only)

Apply and keep applied:

- `HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp` →
  `UserAuthentication = 1` (NLA on).
- Do **not** set `fPromptForPassword = 0`.
- Do **not** set `HKCU:\Software\Microsoft\Terminal Server Client\Servers\<host>\AuthenticationLevelOverride`.
- Do **not** ship a client-side `authentication level:i:0` or
  `authentication level:i:3` in any `.rdp` file to suppress the CredSSP warning.
- Do **not** set `prompt for credentials:i:0` in any `.rdp` file.

### 1.3 Trusted certificate (silences the CredSSP warning honestly)

Because the host is reached exclusively over Tailscale MagicDNS
(`<node>.<tailnet>.ts.net`), the cheapest legitimate path is a
Tailscale-issued Let's Encrypt certificate — publicly chained, no CA to
stand up, no client-side trust manipulation.

- Prerequisite: HTTPS enabled in the tailnet (Tailscale admin console → DNS
  → "Enable HTTPS…"). One-time toggle per tailnet.
- Prerequisite: **MagicDNS ON — required, gated (F9)**. Until MagicDNS is
  enabled the workflow halts by design at the *Wait for Tailscale connected*,
  *Bind tailnet LE cert*, and *Stage files + write config.json* steps:
  `Self.DNSName` must be a non-empty `*.ts.net` name or the run fails. Fix:
  [Enable MagicDNS now (Tailscale admin → DNS)](https://login.tailscale.com/admin/dns) —
  toggle **MagicDNS** ON, Save, then re-run the workflow. Runs stay halted
  until enabled; the tailnet IP is never substituted. Optional unattended
  enable (F9b): set the repo secrets `TS_API_TOKEN` + `TS_TAILNET_NAME` and
  each gate first POSTs
  `https://api.tailscale.com/api/v2/tailnet/${TS_TAILNET_NAME}/dns/preferences`
  with `{"magicDNSEnabled":true}` (token in the `Authorization` header only,
  never a URL parameter, never printed) before halting.
- **[U5b] On an ephemeral GitHub Actions runner the workflow now binds the
  cert automatically on every run** — the step
  *"Bind tailnet LE cert to RDP-Tcp (U5b)"* runs right after
  *"Wait for Tailscale connected"*. It reads the MagicDNS FQDN from
  `tailscale status --json`, re-asserts `UserAuthentication = 1`,
  runs `tailscale cert --cert-file --key-file <fqdn>`, imports the
  resulting PEM as a PFX into `LocalMachine\My` with
  `PersistKeySet|MachineKeySet`, grants `NETWORK SERVICE` read on the
  private key, and binds the thumbprint on `RDP-Tcp` via WMI
  `Win32_TSGeneralSetting.SetSSLCertificateSHA1Hash` (with a registry
  fallback to `HKLM:\...\RDP-Tcp\SSLCertificateSHA1Hash`). The step
  logs the thumbprint only — never the private key, never any password,
  never anything that could be replayed. `TermService` is restarted so
  the new cert takes effect. Idempotent: safe to re-run every workflow
  invocation, and idempotent on LE renewal.
- On a persistent VPS (see §1.7), run once (elevated, PowerShell 7+):
  `payloads\Enable-RdpTlsCertificate.ps1` — same logic as the workflow
  step, wrapped as a standalone script. Re-run when the LE cert renews
  (~every 90 days). Idempotent.
- Result: `mstsc /v:<fqdn>` succeeds at auth-level 2 + CredSSP verification
  with zero warnings. No client-side `Trusted Root` import, no self-signed
  cert, no `AuthenticationLevelOverride`, no `authentication level:i:*`
  suppression, no MOTW / SmartScreen bypass.
- FALLBACK (only if `tailscale cert` is unavailable on the host): generate
  a self-signed cert with a long expiry, export the public part, and
  import once into each client's `Cert:\CurrentUser\Root`. Same
  zero-warning outcome, one manual step per client. Use only as a bridge.

### 1.4 User-run-once cmdkey (typed password, benign UX)

- The USER runs, once, on their own PC:
  `cmdkey /generic:TERMSRV/<node>.<tailnet>.ts.net /user:<user>`
  cmdkey then prompts interactively for the password. Do NOT use `/pass:`
  on the command line — that puts the plaintext in the process command line
  where it is visible to `wmic`, `Get-CimInstance Win32_Process`, ETW, and
  any local Sysmon / EDR.
- The target MUST be `TERMSRV/<fqdn>.ts.net`, matching (a) the MagicDNS name
  the handler passes to `mstsc /v:`, and (b) the CN on the LE cert bound on
  the RDP-Tcp listener. A `TERMSRV/<ip>` target will NOT match and Windows
  will fall back to NTLM / prompt, defeating the silent-auth goal.
- Windows stores the credential in the current user's Credential Manager;
  it is used silently on future `mstsc /v:<fqdn>.ts.net` launches, without
  any tooling in this repo ever touching the plaintext.
- Tooling in this repo MUST NOT run cmdkey on the user's behalf, MUST NOT
  transit the password over the network, MUST NOT prompt for it in a
  browser page, and MUST NOT bake it into a `.bat` file or `ghrdp://` URL.
- The VPS one-click path uses the compiled `payloads/ghrdp-handler/` EXE
  (§1.9). It POST-redeems a short-lived rid, requires a `*.ts.net` FQDN
  equal to the user's locally pinned VPS, then calls `mstsc /v:<fqdn>`.
  The older PowerShell helper is not installed by the dashboard; it remains
  compatible with the FQDN-only redemption response.

### 1.4.1 Launch path (D primary, E fallback)

- Primary one-click is WEB DESKTOP for every host, including ephemeral
  runners. The page opens the tailnet URL. It does not launch a script
  host and it does not install a client component.
- Gateway passwords are user-managed on the host. Tooling must not stash
  them, and must not put them in a URL, a log, or the page. NLA and
  CredSSP stay on.
- Native AUTO-LOGIN is secondary and VPS-only (`hostKind=vps`): the user
  runs interactive `cmdkey` once and registers the compiled handler locally.
  A copyable `mstsc /v:<fqdn>` shortcut remains the handler-free fallback.
  Ephemeral hosts never offer a one-time native login promise.
- Lab login (gateway to loopback RDP, stored cred, NLA) is not measured
  in this landing. No PASS is claimed. SAC enforce and WDAC remain
  limitations for any future local binary; they are not bypassed.

### 1.5 Private file sync (replaces the public mirror)

Pick ONE of the three based on the user's preference; all three keep files private
to the user only:

- **Tailscale Share** — expose a specific folder on the host to the user's tailnet
  identity only. No public URL, no third-party paste, no index.
- **Syncthing** — device-to-device folder sync between the host and the user's PC.
- **OneDrive personal** — sign in as the USER's Microsoft account on the host,
  drop files under `%OneDrive%\<subfolder>`.

Absolutely no rentry.co, no telegra.ph, no GitHub Pages index of the user's files,
no encryption-key publication, no shared decrypt link.

### 1.6 Firewall

- Only tailnet ingress (Tailscale MagicDNS name) reaches TCP/3389.
- Deny public Internet access to 3389 in the host firewall AND at any upstream
  router / cloud NSG.
- Optional: also restrict 3389 to Tailscale interface only via a rule matching
  the `Tailscale` network profile.

### 1.7 Permanent Windows VPS provisioning (`Provision-GhrdpVps.ps1`)

Run **on the VPS console, elevated, with PowerShell 7+**. Do not use an
active RDP session: `TermService` must restart after certificate binding.
The script configures *native RDP*; it does NOT install/start the dashboard,
noVNC/TightVNC, or a file-sync agent. Deploy those separately before
claiming a production migration or decommissioning Actions (§2). CI run
`36047443590` passed static contracts, PowerShell parsing, and an isolated
Windows ACL smoke test; **no VPS or client RDP login was tested**.

- Requires Windows 10/11 Pro or Windows Server, installs Tailscale via winget
  if needed and joins interactively. Optional `$env:TS_AUTHKEY` is read only
  when joining; it is put briefly in an admin-only temp file and passed as
  `--auth-key file:<path>`, **not** as an argv value; the temp file is removed
  in `finally`. Tailscale documents the `file:` option. After joining it
  retries `tailscale status --json` 10 times (~50 seconds) for transient DNS
  blips and refuses an empty/non-`*.ts.net` `Self.DNSName` or missing
  100.64.0.0/10 address. The workflow's stage gate already has its own
  ten-attempt, five-second F9g DNS retry before the MagicDNS halt.
- Creates/retains exactly one static local `rdpuser` (no username override),
  prompts for a new account password with `Read-Host -AsSecureString` only
  when the account is first created, and adds it to the Remote Desktop Users
  built-in group. Rotate an existing account's password separately (§1.8).
- Forces RDP-Tcp `UserAuthentication=1` (NLA/CredSSP) and `SecurityLayer=2`
  (TLS-only). Calls `Enable-RdpTlsCertificate.ps1 -Fqdn <exact MagicDNS
  name>`, which runs `tailscale cert`, verifies leaf DNS name, expiry,
  private key and LE trust chain, imports the PFX into `LocalMachine\My`,
  grants NETWORK SERVICE read on the persisted key (CNG or legacy RSA), and
  binds the hash by WMI/registry with read-back verification. PEM files are
  restricted to SYSTEM and Administrators. No client certificate-warning
  override, no NLA-off fallback, no credential stashing.
- Disables default inbound Remote Desktop rules, refuses a remaining explicit
  inbound TCP/3389 allow rule, replaces its own rule on each run and opens
  **only** TCP/3389 from `100.64.0.0/10` on the Tailscale interface to the
  host's Tailscale IPv4. Only after cert/firewall setup does it enable RDP,
  restart TermService (failure is fatal) and check policy again. The VPS
  operator must ALSO block public 3389 in the cloud NSG/router and inspect
  other broad inbound firewall rules; this script cannot control the NSG.
- Restricts `C:\ghrdp` and the files it writes to SYSTEM/Administrators;
  writes `hostKind=vps` to `hostKind.txt` and `config.json` along with
  `dnsName`, `rdpIp`, and `rdpUser`. `rdpPass` and old mirror secrets are
  removed from VPS config; `mirror=false`. On first run a random 32-byte
  dashboard token is generated in protected `dash-token.txt` and copied to
  protected config (required by the dashboard); re-runs preserve it.
  Transfer it from the VPS **privately** into a password manager; never
  print it to logs, put it in chat, or commit it. Follow §1.8 for rotation.
  An absent web desktop URL remains empty (`step-not-run`); this script
  does not claim a web desktop was deployed.

Invoke (from an elevated PowerShell 7 console on the VPS):

    pwsh -File .\payloads\Provision-GhrdpVps.ps1

To join with an optional auth key without putting it on a command line,
get the value privately, then prompt for it in the current shell:

    $env:TS_AUTHKEY = Read-Host 'Tailscale auth key (local, masked)' -MaskInput
    pwsh -File .\payloads\Provision-GhrdpVps.ps1

Before running, enable **HTTPS** in the tailnet and **MagicDNS** under
[DNS settings](https://login.tailscale.com/admin/dns). If MagicDNS is OFF,
enable it, Save, and re-run. The workflow's three DNS gates likewise halt by
design. With the optional `TS_API_TOKEN` + `TS_TAILNET_NAME` repository secrets,
the workflow may POST the MagicDNS preference via the Tailscale API; it never
places the token in a URL. This is separate from VPS provisioning.

When the operator has manually deployed a private dashboard and a protected
web desktop, verified `/api/native-status` (`fqdn`, `certBound`, `nlaOn`,
`hostKind=vps`, non-empty `webdeskUrl`), confirmed a real client NLA login
and seen the Windows desktop via WEB DESKTOP, §2 may be considered — never
before. See `docs/AUTOLOGIN.md` for the user-run client steps.

### 1.8 Secret rotation (execute BEFORE decommission and BEFORE §4)

Every value below is compromised (lived in workflow env, push logs,
Pages caches, or pre-remediation git history) and must be rotated out
of band.

- [ ] **Rentry admin password (`RDP@...`)**. Log into `rentry.co`,
      delete the mirror paste, generate a fresh strong password, store
      in a password manager. Do NOT recreate the mirror; it is retired.
- [ ] **6 Rentry mirror edit codes** (masked prefixes in `STATE.md`
      `Secrets ledger`; original values from private records). Log in,
      delete each paste, discard each code. Do NOT recreate.
- [ ] **Tailscale auth keys**. In the admin console at
      `https://login.tailscale.com/admin/settings/keys`, revoke every
      current key. Generate ONE reusable auth key for VPS bootstrap,
      expiry ≤7 days, tagged `tag:ghrdp-vps`. Delete after §1.7
      succeeds.
- [ ] **`rdpuser` password**. §1.7 prompts interactively for a fresh strong
      password *when creating the account*. If `rdpuser` already exists,
      change its password privately before using the VPS.
- [ ] **`dashToken`**. §1.7 generates 32 random bytes when missing and stores
      them in protected `C:\ghrdp\dash-token.txt` and `config.json`;
      re-runs preserve the value. Rotate any existing/burned token out of
      band, update both VPS files while the dashboard is stopped, restart it,
      and store the new value in a password manager. Never commit or log it.
- [ ] **GitHub PATs scoping this repo** during Actions-as-RDP
      operation. Rotate under `https://github.com/settings/tokens`.

### 1.9 Dashboard native auto-login button contract (U1 repair)

The native section in `payloads/ui.html` shows WEB DESKTOP for all hosts and
shows AUTO-LOGIN **only** when `/api/native-status` says `hostKind=vps`.
Readiness requires the `*.ts.net` FQDN, bound RDP certificate, NLA, and a
*user confirmation* that they have already run §1.4 cmdkey on this PC.
Copying a line does not mark the credential as present. The client confirmation
is keyed to the FQDN in localStorage; no credential is stored there. The
server cannot inspect the client's Credential Manager and does not claim to.
The raw `mstsc /v:<fqdn>` command remains a copy-only fallback.

The approved VPS button contract is:

1. `POST /api/rdp-token` with the dashboard token in an `Authorization: Bearer`
   header. The server rejects missing/incorrect credentials (including callers
   on the tailnet), non-VPS hosts and invalid `config.dnsName`; the response is
   `{ "rid": "<random-32-hex>", "ttl": 60 }`. The rid is single-use/in-memory.
   The UI does not put the dashboard token into this request's URL.
2. The browser dispatches **only** `ghrdp:connect?rid=<rid>`. No host,
   username, password, dashboard token or script-host command is in the URI.
3. The user-installed **compiled** `GhrdpHandler.exe` (source in
   `payloads/ghrdp-handler/`, win-x64 build artifact in launch-gates) reads
   its locally pinned VPS FQDN, and POSTs `{ "token": "<rid>" }` to
   `http://<fqdn>:7331/api/rdp-creds` across the private encrypted tailnet.
   Redirects are disabled; no token is logged. The server returns only
   `{ "fqdn": "<fqdn>" }`. It never returns a credential.
4. The executable checks that the response is exactly a valid `*.ts.net`
   FQDN equal to the pinned host, then starts `mstsc /v:<fqdn>` without a
   password argument. Windows supplies the user's §1.4 Credential Manager
   entry, with NLA/CredSSP and the listener's trusted LE certificate intact.

First-time handler registration is a **user action** on the client per
`docs/AUTOLOGIN.md`; no page installs it, suppresses Windows warnings, or
claims that protocol/browser prompts cannot occur. The legacy PowerShell
helper is not the primary handler, but still accepts the FQDN-only response
for existing callers. Handler telemetry is advisory, never a readiness gate.

WEB DESKTOP opens only a non-empty, valid tailnet `https://*.ts.net` URL from
`config.webdeskUrl`; an empty URL disables it and displays reason-specific
guidance from the VERIFIED `webdeskReason` (never from an empty URL alone):
the GitHub Actions secrets link for `VNC_PASS` appears ONLY for
`vnc-pass-missing`; `vnc-pass-too-short` says the secret is present and must
be updated; `serve-failed` gives an honest host-side startup/serve-failure
message (with the fixed `webdeskDetail` sub-cause mapped to text) and
explicitly says NOT to re-add the secret; `config-stale`, `step-not-run` and
`invalid-webdesk-url` each have their own text (see [F9i] in §1.10).
Browser tests run via `node --test tests/ui-native.test.js
tests/webdesk-reasons.test.js tests/workflow-webdesk.test.js`; CI also
parses PowerShell scripts and self-tests/publishes the compiled handler.
None of these tests establishes a successful live RDP login on the user's
Windows PC.

### 1.10 Web desktop (noVNC + TightVNC via `tailscale serve`)

The dashboard's WEB DESKTOP button is enabled only when
`config.webdeskUrl` is set.

- **[F9h] `VNC_PASS` missing = FAIL-CLOSED (halt by design).** The step
  *checks the secret before running a single install command*. If
  `VNC_PASS` is unset the workflow **fails**: it emits a `::error::`
  annotation, writes a Step Summary card with a direct link to
  [repository Actions secrets](https://github.com/dekarita/supreme-lamp/settings/secrets/actions)
  (New repository secret → name `VNC_PASS` → strong value → Add secret →
  re-dispatch), clears `config.webdeskUrl`, records
  `config.webdeskReason = 'vnc-pass-missing'` plus
  `config.vncPassAdminUrl` on `C:\ghrdp\config.json`, and then `throw`s.
  This deliberately reverses the earlier behaviour, where a missing
  secret produced a *successful* run with the web desktop silently
  absent. Rationale: a run that reports green while a promised component
  can never start is worse than a red run. Fix takes ~30 seconds and the
  run is re-dispatched, not repaired.
- **[U5c] Ephemeral GitHub Actions runner**: the workflow now provisions
  the web desktop automatically on every run, but *only* when repo
  secret `VNC_PASS` is present and ≥ 8 characters. Step
  *"Web desktop (noVNC + TightVNC, tailnet-only via tailscale serve)"*
  installs TightVNC in service mode with the VNC and control passwords
  set to `VNC_PASS` (via msiexec `ADDLOCAL=Server SET_PASSWORD=1
  VALUE_OF_PASSWORD=…`; the password is never echoed to logs or the
  step summary), binds VNC to loopback only (`LoopbackOnly=1`,
  `AllowLoopback=1`, `AcceptRfbConnections=1`), starts websockify on
  `127.0.0.1:7333` serving the noVNC static UI (cloned to
  `C:\ghrdp\novnc`), exposes that with `tailscale serve --bg
  http://127.0.0.1:7333` (plaintext HTTP target - tailscaled terminates
  tailnet TLS itself; an `https://` target would 502 on every hit),
  resolves the serve URL from
  `tailscale serve status --json`, and writes it as
  `config.webdeskUrl = https://<fqdn>.ts.net/vnc.html?autoconnect=1&resize=remote`.
  The dashboard's next `/api/native-status` poll picks it up and enables
  WEB DESKTOP. **Never exposes VNC on 0.0.0.0**, **never disables VNC
  authentication**, **never publishes on Tailscale Funnel**. Empty
  `VNC_PASS` **fails the run** (see [F9h] above); a *present but short*
  `VNC_PASS` (< 8 chars) still skips the step cleanly as a loud
  non-fatal skip and leaves WEB DESKTOP disabled with
  `config.webdeskReason = 'vnc-pass-too-short'` (a PRESENT-but-short
  secret is never reported as missing - the dashboard's advice for that
  reason is to update the existing secret, not to add one).
- **[F9i] Web-desktop root-cause fix + fail-closed serve paths + reason-
  driven dashboard guidance.**
  - *Root cause of the `serve-failed` runs:* the websockify launcher used
    `Start-Process -RedirectStandardOutput $wsLog -RedirectStandardError
    $wsLog` - the SAME file for stdout and stderr. Windows opens each
    redirect target exclusively, so `Start-Process` threw before python
    ever started; websockify never bound `127.0.0.1:7333` and every run
    degraded to `webdeskReason='serve-failed'` while the step itself
    reported green. Fix: two separate files
    (`C:\ghrdp\webdesk\websockify.log` / `websockify.err.log`). websockify
    never receives the VNC password, so neither log can carry it.
  - *Fail-closed serve paths:* the four startup-failure exits
    (TightVNC install, noVNC assets, websockify bind, serve mapping) now
    `throw` instead of `exit 0` - a green run with a dead web desktop is a
    false-LIVE (same rationale as F9h). Each records a fixed, secret-free
    `config.webdeskDetail` sub-cause code
    (`tightvnc-install` | `novnc-assets` | `websockify-bind` |
    `serve-mapping`) so the dashboard and Step Summary name the exact
    failure; installer arguments and exception text are still withheld
    (they may carry the secret). The serve-mapping check re-reads
    `tailscale serve status --json` once after a 5s settle before
    halting, so slow registration cannot false-fail.
  - *Self-test fail-closed:* a self-test FAIL still clears
    `config.webdeskUrl` and records `serve-failed` +
    `webdeskDetail='self-test-failed'`, and now also halts the run by
    design.
  - *Dashboard honesty:* `payloads/ui.html` renders web-desktop guidance
    from the VERIFIED `webdeskReason` (via `/api/native-status`, which now
    also exposes `webdeskDetail` and the F9h `vncPassAdminUrl`), never
    from an empty URL alone. `vnc-pass-missing` shows the GitHub Secrets
    `VNC_PASS` setup steps; `vnc-pass-too-short` says the secret IS
    present and must be updated; `serve-failed` gives an honest
    host-side startup/serve-failure message (with the mapped sub-cause)
    and explicitly says NOT to re-add the secret; `config-stale`,
    `step-not-run` and `invalid-webdesk-url` each have their own text.
    WEB DESKTOP stays the primary ephemeral action and stays enabled only
    for a valid configured tailnet HTTPS URL.
- **[F9j] serve-mapping hardening + URL normalization + loopback auto-heal.**
  A run whose websockify bound fine still failed with
  `webdeskReason='serve-failed'` / `webdeskDetail='serve-mapping'`, and the
  step logged **nothing** about why. Three gaps, all fixed:
  - *Swallowed serve failure:* `tailscale serve --bg …` output went only to
    a `RUNNER_TEMP` file and its exit code was discarded, so a failed serve
    was undiagnosable. Now the exit code is printed, the command is retried
    once in explicit-`443` form, and — before the fail-closed `throw` — the
    serve log tail, `tailscale serve status`, `serve status --json`, and
    `tailscale status` are all printed (secret-free: `VNC_PASS` is never
    passed to tailscale).
  - *False-LIVE URL:* current Tailscale keys `serve status --json` Web entries
    as `'<host>.ts.net:<port>'`, so the old raw-key URL carried `:443`. The
    dashboard's URL validator rejects any explicit port (`!desk.port`), so a
    green run left the WEB DESKTOP button dead. The URL is now derived only
    from a VERIFIED mapping, the host is re-validated against the `*.ts.net`
    pattern, and the default port is normalized away (a mapping on any
    non-default port is treated as NO mapping, never advertised).
  - *Auto-heal bind:* the staged watcher's websockify restart used an
    all-interfaces bind on 7333, exposing the bridge on the Tailscale
    interface without tailnet TLS (bypassing the serve mapping). It now
    rebinds `127.0.0.1:7333` and serves the noVNC assets again.
  - *Tests:* `tests/workflow-webdesk.test.js` F9j block pins the exit-code
    print, the explicit-443 retry, the no-raw-key-URL / port / host-anchor
    rules, the fail-closed diagnostics, and the loopback-only auto-heal.
- **[F9k] `tailscale serve` syntax fix + fail-closed serve logic** —
  **SUPERSEDED by [F9l] below.** The two-form attempt (primary = the whole
  mapping passed as ONE concatenated argv token, `tailscale serve '--bg
  http://127.0.0.1:7333'`; fallback = the pre-1.52 positional form
  `tailscale serve --bg 443 http://127.0.0.1:7333`) is dead on the live
  runner CLI (Tailscale 1.52+): the one-token blob produced a usage dump
  (exit 2) and the positional form produced `Error: invalid argument
  format` (exit 1). Kept as history only — the shipped behaviour is the
  [F9l] cascade below.
- **[F9l] post-1.52 `tailscale serve` syntax + version-tolerant VERIFIED
  cascade (supersedes F9k; upgraded by [F9m] below, which fixes its
  diagnostics and target coverage).** The web-desktop step logs the CLI version and
  then tries, in order:
  1. `tailscale serve --bg http://127.0.0.1:7333` (post-1.52: URL target,
     listen port defaults to https/443),
  2. `tailscale serve --bg --https=443 http://127.0.0.1:7333` (post-1.52:
     explicit https listen port),
  3. `tailscale serve --bg 7333` (post-1.52: port-number target),
  4. `tailscale serve --bg 443 http://127.0.0.1:7333` (pre-1.52 legacy form,
     kept for older runner CLIs; on 1.52+ it simply prints its exit code).
  After each attempt the serve mapping is read back through the F9j
  `Get-WebdeskServeUrl` helper; the first form that yields a REAL
  `https://<node>.<tailnet>.ts.net` mapping wins and the cascade stops. If
  no form verifies, the unchanged single fail-closed `serve-mapping` block
  runs: secret-free diagnostics (serve log tail, `serve status`,
  `serve status --json`, `tailscale status`), one 5s-settle re-read, one
  `config.webdeskReason='serve-failed'` / `webdeskDetail='serve-mapping'`
  stamp on `config.json`, then a `throw`. No URL is ever fabricated, every
  attempt's exit code is printed (F9j contract), and `VNC_PASS` is never
  passed to tailscale.
  - *Tests:* `tests/workflow-webdesk.test.js` pins the exit-code print, the
    legacy-`443` literal, the verified-mapping URL rules, the fail-closed
    diagnostics, and the loopback-only auto-heal.
- **[F9m] serve root-cause instrumentation + documented-form cascade.**
  The F9l live run (Tailscale 1.102.4) returned `exit 1` for all four forms
  and the only captured text was `Error: invalid argument format | try
  \`tailscale serve --help\` for usage info`. Two gaps were fixed:
  - *Blind diagnostics:* F9l reused ONE log file across attempts, so only the
    last attempt's output survived and the first three failures were
    invisible. Every attempt's combined stdout+stderr is now captured,
    redacted and printed to the run log (and appended to the transcript file
    that the fail-closed diagnostics still read), so the next run names each
    failure precisely instead of repeating one tail line. The CLI version and
    the CLI's own `serve --help` usage text are logged up-front too.
  - *Red-herring message:* the CLI source
    (`cmd/tailscale/cli/serve_v2.go` `validateArgs`, verified at tag
    v1.102.4) emits that string in exactly two cases: `--tun` with more than
    one positional, and **exactly two positionals whose last is not the
    literal `off`**. The modern CLI accepts ONE positional target, so the
    pre-1.52 legacy pair (`443 http://127.0.0.1:7333`) can never work on
    1.52+ and its error was masking the real (still unknown) cause of the
    first attempts' failures.
  - *Documented targets that had never been tried:* the cascade now covers
    the documented `--yes` (non-interactive — CI has no TTY) and partial-URL
    (`localhost:7333`) forms, in addition to the URL/port/explicit-port and
    legacy forms.
  - *Last resort:* if every documented form fails, the step attempts the
    CLI's own raw-config path (`tailscale serve set-raw` with an
    `ipn.ServeConfig` JSON built from `Self.DNSName`), then re-reads the
    mapping through `Get-WebdeskServeUrl`. It is still only an attempt: a
    wrong schema yields no mapping, so no URL can ever be fabricated and the
    single fail-closed `serve-mapping` block still halts the run.
  - *Actionable hint:* serve's HTTPS modes call `enableFeatureInteractive`
    first, and tailnet HTTPS certificate provisioning is a SEPARATE toggle
    from MagicDNS (admin console → DNS → HTTPS Certificates). When the
    captured output indicates an HTTPS/certificate problem, the step logs the
    hint and writes it to the Step Summary.
- **Persistent Windows VPS (post-§1.7)**: §1.7 does NOT provision a web
  desktop. The operator must separately deploy authenticated TightVNC
  bound to loopback, websockify/noVNC on loopback, and `tailscale serve`
  (tailnet HTTPS, **not** Funnel); verify the gateway requires a VNC password
  before setting the protected VPS `config.webdeskUrl`. No local client
  installation is required. This VPS web gateway has **not** been deployed
  or tested in this session; do not claim Proof C or disable Actions yet.

**Security posture (bright lines)**:
- Credentials are ALWAYS required (VNC password). The prior banned
  posture — *no-auth VNC on any interface, even tailnet-gated* — remains
  banned.
- Exposure is ALWAYS tailnet-only via `tailscale serve`. No public port,
  no funnel, no anonymous reverse proxy.
- On Actions the VNC password is supplied by the repository secret to the
  installer; the installer-error message is withheld because it might contain
  that value. On a VPS it must be configured locally by the operator. Neither
  path logs the password or includes it in `config.webdeskUrl`.

Decommission note: uninstalling TightVNC is `choco uninstall tightvnc -y`
(or the vendor uninstaller) followed by `tailscale serve reset`.
Clearing `config.webdeskUrl` disables the button on the next poll;
removing TightVNC + resetting serve closes the tailnet listener.

## 2. Decommission checklist (Actions-as-RDP teardown)

> Prerequisites: §1.7 VPS provisioned and client NLA-probe verified;
> §1.8 secret rotation complete. §4 covers history rewrite separately.
> Do NOT disable the Actions workflow until the VPS is
> production-verified from the client.

Execute in order, one at a time. Nothing here runs automatically.

- [ ] **Rotate `dashToken` and RDP creds before decommission** — assume both are
      compromised (they lived in workflow env + logs). Change the RDP account
      password on the runner-side reference material, regenerate the dash token,
      and stop using any prior value.
- [ ] **Rotate mirror keys and rentry.co edit codes** — the current values are in
      the git history of this branch's ancestors and in any Pages/CDN cache; a
      simple removal from HEAD does not invalidate them. Replace with new keys
      only after point 4 below, if the mirror is ever revived (it should not be).
- [ ] **Remove the "Secure cleanup (wipe profiles/storage, clear logs…)" step** —
      any workflow step whose script clears Security/System event logs, wipes
      profile directories to hide artifacts, or drops audit trails. That is
      anti-forensics; there is no legitimate reason to clear a runner's event
      log at end-of-run.
- [ ] **Remove the "Overwrite free space" step** — likewise anti-forensics. Free
      space overwrite on ephemeral runner storage does not protect the user; it
      only frustrates incident investigation.
- [ ] **End Actions-as-RDP** — set the workflow to no longer bring up
      Tailscale + start `ghrdp-server.ps1` on the runner. Either delete
      `.github/workflows/main.yml` outright, or reduce it to a benign CI check.
- [ ] **Delete the runner-side C2 dead handler bodies** in `payloads/ghrdp-server.ps1`
      below the 404-guard: `/install.bat`, `/connect-now.bat`, `/api/client-cmd`,
      and other C2 handler bodies whose paths are already 404-guarded. Also
      stop staging the legacy PowerShell installer/helper assets in `main.yml`
      once Actions is decommissioned; the new dashboard has no script-host
      installation link. Unreachable bodies and staged installers should not
      remain in shipped source.
- [ ] **Delete `/rentrydiag` and `/parsec-push` handlers** in
      `payloads/ghrdp-server.ps1` — the former POSTs a run's decrypt key to a
      public rentry.co paste (live mirror-publish path); the latter arms a
      `schtasks /Create /SC ONLOGON` with the plaintext RDP password on the
      command line (live persistence + plaintext transit).
- [ ] **Delete the `tscon /password:` line** in `main.yml` keepalive branch
      (plaintext RDP password on the tscon command line).
- [ ] **Delete `Start-GhrdpLoopbackSession`** from `payloads/ghrdp-lib.ps1`
      entirely once no callers remain in git history matters — currently it is
      neutered (throw-on-call) but the file still ships.
- [ ] **Publish nothing to `docs/` or GitHub Pages from this workflow** — Pages
      publishing steps are already removed (#3a). Verify no fresh publisher is
      re-introduced.
- [ ] **Purge the "verify-ghrdp probe tool"** noted as residual in `STATE.md`.
- [ ] **Rewrite git history OR abandon the branch** — decide with the user
      whether the secrets in pre-remediation commits need `git filter-repo`
      / BFG, or whether the branch is simply deleted after migration.
- [ ] **Live NLA probe on the new VPS** — from the client PC, confirm
      `mstsc /v:<vps>` produces zero CredSSP warnings and completes NLA
      handshake at auth-level 2 before decommissioning the Actions path.

## 3. What must NOT return

Under no circumstance should the new host or its associated tooling:

- Turn NLA off, or override `AuthenticationLevelOverride`, or bake
  `authentication level:i:0|3` / `prompt for credentials:i:0` into `.rdp` files.
- Stash cmdkey credentials for the user, transit plaintext passwords over the
  wire (headers, JSON body, URL, .bat file, HTML page, banner text), or bake
  passwords into `ghrdp://` URLs.
- Strip Mark-of-the-Web / Zone.Identifier from any downloaded file, bypass
  SmartScreen, install publisher-trust entries, or pre-arm LocalDevices.
- Ship a C2-shaped persistence path (agent enroll, launch, accept, acceptance,
  diag upload, device registration, self-heal loop).
- Publicly mirror or index third-party content, or the user's own content, or
  any decrypt key.
- Clear event logs, wipe profiles, or overwrite free space to hide activity.

## 4. Git history rewrite (one-time; force-push gated on user confirmation)

Old secrets still live in commits ancestral to `main`, in Pages / CDN
caches, and in any clone or fork taken before remediation. Removing
them from `HEAD` does NOT invalidate them. §1.8 rotation is the
primary defense; this rewrite is defense-in-depth.

The standing "never force-push" rule is overridden ONLY for this
specific one-time rewrite, ONLY on this personal repository, ONLY
AFTER §1.8 rotation, and ONLY AFTER the user explicitly types
`history-rewrite-go` in the working session. It does NOT generalize.

### 4.1 Preparation

- [ ] Confirm §1.8 is complete for every leaked value.
- [ ] Full backup: `git clone --mirror <repo-path> ghrdp-backup.git`.
- [ ] Notify every clone / fork holder that history will be rewritten;
      they will need to re-clone.
- [ ] Choose a dedicated maintenance window.

### 4.2 Purge with `git-filter-repo` (preferred)

`git-filter-repo` is faster and safer than BFG for literal-string
purge. Install with `pipx install git-filter-repo`.

STEP 1. Prepare `replacements.txt` OUT OF BAND (never commit, never
paste into a PR / issue / this doc):

    <exact-leaked-string-1>==>REDACTED
    <exact-leaked-string-2>==>REDACTED
    ...

Take the exact strings from your private records. `STATE.md`
`Secrets ledger` has only masked prefixes; the full values are yours.

STEP 2. Rewrite on a fresh clone (NEVER on your working checkout):

    git clone --no-local <repo-path> ghrdp-rewrite
    cd ghrdp-rewrite
    git filter-repo --replace-text ../replacements.txt

STEP 3. Verify no live secrets remain (must return zero hits):

    git grep -nE "RDP@|fJSJ|WdX9|E9RS|YuKb|FWXk|tncr" $(git rev-list --all)

STEP 4. **USER CONFIRMATION GATE**. Do NOT proceed to STEP 5 until you
explicitly type `history-rewrite-go`.

STEP 5. Force-push (destructive; the one-time override):

    git remote add origin <remote-url>
    git push --force-with-lease --all origin
    git push --force-with-lease --tags origin

STEP 6. Post-rewrite:

- [ ] Purge GitHub Pages cache (Settings → Pages → unpublish, then
      re-publish, or delete the deployment).
- [ ] Every clone / fork holder re-clones. Old clones retain leaked
      strings in reflogs and loose objects until GC.
- [ ] Delete `ghrdp-backup.git` after ≥30 days of verified operation.
- [ ] Shred `replacements.txt` (`Remove-Item -Force`).

### 4.3 BFG alternative (only if `git-filter-repo` unavailable)

BFG requires a `--mirror` bare clone:

    git clone --mirror <repo-path> ghrdp-rewrite.git
    java -jar bfg.jar --replace-text ../replacements.txt --no-blob-protection ghrdp-rewrite.git
    cd ghrdp-rewrite.git
    git reflog expire --expire=now --all
    git gc --prune=now --aggressive

The STEP 4 confirmation gate and STEP 6 post-rewrite items apply
identically.
