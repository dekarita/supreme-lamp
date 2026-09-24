# GHRDP native mstsc auto-login — one-time client setup

Two commands, per client PC, once ever. Paste in an **interactive**
Windows PowerShell window (not `Win + R`). No downloads, no elevation,
no installer.

> Placeholders — replace before running:
> - `<HELPER>` — absolute path to `helper-ghrdp-connect.ps1` on your
>   PC (fetch it from the repo and save it somewhere stable, e.g.
>   `C:\ghrdp\helper-ghrdp-connect.ps1`; **do not** put it in
>   `%TEMP%`).
> - `<FQDN>` — the VPS's Tailscale MagicDNS name (e.g.
>   `myhost.tail1234.ts.net`). Get it from Tailscale admin or the
>   dashboard's *Target FQDN* row.
> - `<RDPUSER>` — the RDP account name provisioned by
>   `payloads/Provision-GhrdpVps.ps1` (default: `rdpuser`). Get it
>   from `/api/config` → `creds.user`.

## Step 1 — register the `ghrdp://` protocol handler (HKCU, no admin)

```powershell
reg add "HKCU\Software\Classes\ghrdp" /ve /d "URL:GHRDP" /f
reg add "HKCU\Software\Classes\ghrdp" /v "URL Protocol" /d "" /f
reg add "HKCU\Software\Classes\ghrdp\shell\open\command" /ve /d "\"powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"<HELPER>\" -Url \"%1\"" /f
```

This binds `ghrdp://…` links to `helper-ghrdp-connect.ps1`. The
handler parses the URL, POSTs `/api/rdp-creds` to redeem the
one-time token for the server's MagicDNS FQDN, and launches
`mstsc /v:<fqdn>`.

The handler never reads, writes, or deletes credentials, never
downloads anything, never touches `LocalDevices` or any
authentication-suppression flag, and never runs `mstsc` hidden.

## Step 2 — store the RDP credential in Windows Credential Manager

```powershell
cmdkey /generic:TERMSRV/<FQDN> /user:<RDPUSER>
```

`cmdkey` **prompts interactively** for the password — do not use
`/pass:` on the command line (that leaks the plaintext to WMI /
`Get-CimInstance Win32_Process` / ETW / any local Sysmon or EDR).

Windows stores the credential per user, silently supplies it on
future `mstsc /v:<FQDN>` launches, and the LE cert bound on the
RDP-Tcp listener (from `payloads/Enable-RdpTlsCertificate.ps1`)
satisfies CredSSP without warning. Result: zero prompts, zero
warnings, NLA + CredSSP stay ON.

## Verification

```powershell
cmdkey /list
# expect a row: Target: LegacyGeneric:target=TERMSRV/<FQDN>
#                Type: Generic
#                User: <RDPUSER>
```

Click AUTO-LOGIN on the dashboard: mstsc opens directly on the
remote desktop. Handler log (append-only JSONL):

```
%LOCALAPPDATA%\ghrdp\ghrdp-connect.log
```

## Removal

```powershell
cmdkey /delete:LegacyGeneric:target=TERMSRV/<FQDN>
reg delete "HKCU\Software\Classes\ghrdp" /f
```

## What NOT to do

- Do **not** write the password on the `cmdkey` command line
  (`/pass:` — leaks plaintext to process command line).
- Do **not** bake credentials into a `.rdp` file, a `.bat`, a
  `ghrdp://…&pass=…` URL, an HTTP header, or an HTML input field.
- Do **not** disable NLA (`UserAuthentication=1` stays ON), set
  `fPromptForPassword=0`, set
  `HKCU\...\Terminal Server Client\Servers\<host>\AuthenticationLevelOverride`,
  or ship any `.rdp` with `authentication level:i:0|3` or
  `prompt for credentials:i:0`.
- Do **not** strip Mark-of-the-Web / Zone.Identifier from the
  helper file, install publisher-trust entries, or pre-arm
  `LocalDevices`.
- Do **not** put the helper in `%TEMP%` (auto-cleaned; breaks the
  handler silently).
