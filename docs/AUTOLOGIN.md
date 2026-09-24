# GHRDP launch path — web desktop primary, native shortcut fallback

Primary click is WEB DESKTOP on the dashboard. Nothing is installed on
the client, and the page does not launch a script host.

The one-time cmdkey below is VPS-only. An Actions runner advertises a
new hostname every run, so a stored TERMSRV entry cannot be one-time
there.

> Placeholders — replace before running:
> - `<FQDN>` — the VPS MagicDNS name (`*.ts.net`) from the dashboard
>   Target FQDN row. Not the tailnet IP.
> - `<RDPUSER>` — the RDP account name (default: `rdpuser`).

## Step 1 — open WEB DESKTOP

Use the primary button. It opens the tailnet URL the host already
serves. NLA on the Windows listener stays on. This repo does not write
a gateway password.

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
