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
- On the RDP HOST, run (elevated, PowerShell 7+):
  `payloads\Enable-RdpTlsCertificate.ps1`
  It fetches the cert via `tailscale cert <fqdn>`, imports into
  `LocalMachine\My` with `PersistKeySet|MachineKeySet`, grants
  `NETWORK SERVICE` read on the private key, binds the thumbprint on the
  `RDP-Tcp` listener (`Win32_TSGeneralSetting.SetSSLCertificateSHA1Hash`
  with `HKLM:\...\RDP-Tcp\SSLCertificateSHA1Hash` registry fallback), and
  re-asserts `UserAuthentication = 1` (NLA ON, no suppression).
- Restart the listener for the new cert to take effect:
  `Restart-Service TermService -Force` (kicks active sessions — schedule).
- Re-run the script when the LE cert renews (~every 90 days). Idempotent.
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
- The remediated one-click handler (`payloads/helper-ghrdp-connect.ps1`)
  resolves the FQDN from a short-lived server token and calls
  `mstsc /v:<fqdn>.ts.net` only. As of P2 it hard-refuses any resolved
  value that is not a `*.ts.net` FQDN (no IP fallback, no `server=`
  fallback).

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

### 1.7 Full VPS bootstrap (`Provision-GhrdpVps.ps1`)

`payloads/Provision-GhrdpVps.ps1` chains §1.1 through §1.6 idempotently:
winget-installs Tailscale, joins the tailnet (interactive OR
`$env:TS_AUTHKEY`; never `--authkey=` on the command line), hard-fails
if the resolved MagicDNS FQDN is not `*.ts.net`, creates the `rdpuser`
account with an interactively-typed password
(`Read-Host -AsSecureString`), sets `UserAuthentication = 1` and
`fDenyTSConnections = 0`, delegates to `Enable-RdpTlsCertificate.ps1`
(§1.3) for the LE cert bind, and creates a firewall rule allowing
inbound TCP/3389 on the Tailscale interface only while disabling the
default 'Remote Desktop' inbound rules. Explicit non-actions per
discipline: no `AuthenticationLevelOverride`, no `fPromptForPassword = 0`,
no MOTW / Zone.Identifier strip, no publisher-trust arming, no
credential stash. Re-run every ~90 days to bind a fresh LE cert.

Invoke (elevated, PowerShell 7+):

    pwsh -ExecutionPolicy Bypass -File .\payloads\Provision-GhrdpVps.ps1

Unattended tailnet auth (still interactive password):

    $env:TS_AUTHKEY = 'tskey-auth-...'
    pwsh -ExecutionPolicy Bypass -File .\payloads\Provision-GhrdpVps.ps1

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
- [ ] **`rdpuser` password**. Choose a fresh strong password at §1.7
      provision time (the script prompts interactively).
- [ ] **`dashToken`**. Generate a fresh random 32+ byte value; store
      the VPS side in the `ghrdp-server.ps1` config and the dashboard
      side in a password manager. Never commit.
- [ ] **GitHub PATs scoping this repo** during Actions-as-RDP
      operation. Rotate under `https://github.com/settings/tokens`.

### 1.9 Dashboard native auto-login button contract (U1)

`payloads/ui.html` exposes a single native RDP entry point in
`#sec-native-rdp`. This is the ONLY sanctioned dashboard-driven RDP
launch path; the previous agent-enrollment / DIAG / Parsec-push /
`install.bat` surface is removed.

Client-side flow (button `#autoLoginNative`):

1. `POST http://<runner>:7331/api/rdp-token` (dashboard `key` query
   only when the dashboard is auth-guarded; no body).
2. Server issues `{ token, ttl:60 }`, single-use, in-memory only.
3. UI fires the URI `ghrdp://connect?server=<runner-host>&port=7331&t=<token>`
   via a hidden `<iframe>` (no `window.open`, no navigation).
4. Local `ghrdp://` handler (`payloads/helper-ghrdp-connect.ps1`)
   parses `server` + `t`, POSTs `/api/rdp-creds` with
   `{ "token": "<t>" }`, receives `{ host, fqdn }` — server enforces
   `*.ts.net` (P2 discipline), any other value returns HTTP 409.
5. Handler runs `mstsc /v:<fqdn>`. Windows LSA silently supplies the
   per-user `TERMSRV/<fqdn>` credential stored by §1.4 cmdkey.
6. Handler NEVER reads, writes, or deletes the stored credential; it
   only resolves an FQDN and launches `mstsc`.

Banned in this section and its script — presence is a bug:

- Any `ghrdp://` URI with a `pass=`, `password=`, `user=`, `key=`, or
  literal credential parameter.
- A `credPass` / `__PASS__` UI element, or a plaintext-password
  display of any kind.
- References to `/api/enroll.ps1`, `/api/agent.ps1`, `/api/client-status`,
  `/api/agent-status`, `/api/client-cmd`, `/api/agent-hello`, or
  `showEnrollOverlay` — the endpoints are 404-guarded server-side; UI
  references would falsely imply live paths.
- `install.bat` or `install.ps1` download anchors and any
  auto-executing installer helper.
- LocalDevices arming, `AuthenticationLevelOverride`, MOTW /
  Zone.Identifier strip, or publisher-trust arming (§3 bans them
  system-wide).
- File uploads from the dashboard to the runner (`/parsec-push` is
  404; no re-introduction).

Fallback shown in the same section — always visible:

- The literal `mstsc /v:<fqdn>` command line, for clients that have
  no handler installed. Silent auth still applies once §1.4 cmdkey
  is complete.

FQDN sourcing:

- The server substitutes `__IP__` -> `cfg.rdpIp` when serving `/`.
  Under P2 discipline `cfg.rdpIp` is a MagicDNS FQDN (`*.ts.net`);
  before VPS provision (§1.7) it may be blank or a stale IP. The UI
  hard-refuses anything not matching `^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$`
  and disables the AUTO-LOGIN button, so an unprovisioned dashboard
  never emits a bad `mstsc` target.

Readiness snapshot (`/api/native-status`, U3):

- The UI additionally polls `GET /api/native-status` every 15s (dash-
  token + tailnet gated via the shared routing entry). The response
  is `{ fqdn, certBound, nlaOn, handlerSeenAgeSec, reasonsDisabled }`.
  `certBound` reads the `RDP-Tcp` `SSLCertificateSHA1Hash` registry
  value on the host; `nlaOn` reads `UserAuthentication == 1`;
  `handlerSeenAgeSec` is the age of the last `POST /api/handler-hello`
  the ghrdp:// handler fired on invoke.
- `reasonsDisabled` names anything failing: `fqdn-not-tsnet`,
  `cert-not-bound`, `nla-off`, `handler-not-seen`. The UI shows each
  as a plain-English row and disables AUTO-LOGIN whenever the list is
  non-empty. Client-side cred presence is NOT transmitted; the server
  never learns whether a given PC has the TERMSRV cred stored.
- `POST /api/handler-hello` records only `{ ts }` to
  `handler-hello-last.json`. No IP, user, or credential fields are
  written or transmitted.

Verification (E-battery greps for banned patterns; must return zero):

    git grep -nE "enroll|agentPill|/api/client-status|/api/agent|/api/enroll|showEnrollOverlay|LocalDevices|AuthenticationLevelOverride|__PASS__|install\.bat|install\.ps1|parsec-push" -- payloads/ui.html
    git grep -nE "ghrdp://.*pass=|&pass=|/api/client-cmd|fPromptForPassword" -- payloads/ui.html

(Comment-line matches noting removed items are acceptable and expected;
only live code references are bugs.)

### 1.10 Web desktop (Apache Guacamole via `tailscale serve`)

The dashboard's WEB DESKTOP button is enabled only when
`config.webdeskUrl` is set. On an ephemeral GitHub Actions runner it
stays disabled (no persistent host). On the VPS (post-§1.7) install
Guacamole and expose it tailnet-only:

    # As root on the VPS (Ubuntu 22.04+ example):
    apt-get update
    apt-get install -y guacd tomcat10 tomcat10-common guacamole-tomcat
    # Guacamole stores its own RDP host mapping in
    #   /etc/guacamole/user-mapping.xml
    # The RDP hostname there is <fqdn>.ts.net; the RDP password is entered
    # once by the operator on the host, not stashed by our tooling.
    systemctl enable --now guacd tomcat10
    # Expose ONLY on the tailnet (no public port):
    tailscale serve --bg https://127.0.0.1:8080

Then set `config.webdeskUrl` on the ghrdp-server host to the
`tailscale serve` URL that command printed (`https://<fqdn>.ts.net/`).
The dashboard's next `/api/native-status` poll picks it up and enables
WEB DESKTOP. Nothing here stashes the RDP password on the operator's
PC or in dashboard state.

Decommission note: uninstalling Guacamole is `apt-get remove
--purge guacd tomcat10 guacamole-tomcat && tailscale serve reset`.
Clearing `config.webdeskUrl` disables the button on the next poll;
running the two removes above closes the tailnet listener.

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
      and other C2 handler bodies whose paths are already 404-guarded. Bodies are
      unreachable but should not sit in shipped source.
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
