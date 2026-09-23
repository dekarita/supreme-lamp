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

- Issue a real TLS certificate for the RDP-Tcp listener (public CA if the host is
  reachable by name; internal CA if tailnet-only). Bind via `Set-RDCertificate` or
  the RD Session Host Configuration UI.
- Install the CA root into the CLIENT PC's `Cert:\CurrentUser\Root` (per user) or
  `Cert:\LocalMachine\Root` (per machine) so the client trusts the server cert.
- Result: `mstsc /v:<host>` succeeds at auth-level 2 + CredSSP verification with
  zero warnings, no suppression flags needed.

### 1.4 User-run-once cmdkey (typed password, benign UX)

- The USER runs, once, on their own PC:
  `cmdkey /generic:TERMSRV/<host> /user:<user> /pass:<their-typed-password>`
- This stores the credential in the current user's Windows Credential Manager;
  Windows uses it silently on future `mstsc /v:<host>` launches.
- Tooling in this repo must NOT run cmdkey on the user's behalf, must NOT transit
  the password over the network, must NOT prompt for it in a browser page, and
  must NOT bake it into a `.bat` or `ghrdp://` URL.
- The remediated one-click handler (`payloads/ghrdp-handler.ps1`) resolves the
  host from a short-lived server token and calls `mstsc /v:<host>` only.

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

## 2. Decommission checklist (Actions-as-RDP teardown)

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
