# PROJECT CONTEXT v2 (CANONICAL)

One page of locked decisions, kept in sync with `STATE.md` (the running
ledger) and `docs/MIRROR-HOSTS.md` (the mirror contract). When a rule here
changes, the operator's override is named inline with its date; nothing else
may weaken a locked rule.

Provenance note (2026-09-29): this canonical page was created in the F50/F51
session. Rules 1-7 below were lifted verbatim from the `STATE.md` "Decisions
(permanent, locked architecture)" block; Rule 5 carries the operator override
issued with the F50/F51 brief.

## Section 6 - Locked rules (permanent architecture)

1. NLA=1 only; no fPromptForPassword=0, no AuthLvlOverride, no client
   'authentication level:i=0|3', no 'prompt for credentials:i=0'.
2. F27/F28 exception: dash-authorized single-use 60s ticket + direct tailnet
   source may return credentials to CredWrite; the SAME sanctioned store path
   backs the F28 ghrdp://recred one-click recovery verb (fresh ticket ->
   CredWrite OVERWRITE -> mstsc, no typing/clipboard). All other
   transit/store locks remain (no password URLs/logs/artifacts).
3. No MOTW/Zone.Identifier strip; no SmartScreen/ClickFix/uBlock/
   publisher-bypass evasion; no LocalDevices pre-trust arming.
4. No C2 persistence (agent/enroll/launch/accept/diag endpoints stay 404); no
   public mirror/index of third-party content; no anti-forensics.
5. **Mirror is default-OFF, EXCEPT for the `Downloads` root which is
   Always-ON (Auto-upload).**
   - Operator override, 2026-09-29 (F50/F51 brief, §0): the previous form of
     this rule read "Mirror is default-OFF" with no exception. The override is
     scoped to a watched root whose leaf name is `Downloads` ONLY: any file
     that lands there is queued for mirror upload automatically, with no
     `mirror_enable` dispatch input and no F49 ConfirmModal.
   - Every other root (Desktop, Documents, Temp, RDP-Storage, torrent save
     paths) keeps the full default-OFF + opt-in contract.
   - The on-disk `config.json` is never touched by the auto-upload path: the
     enable happens on a per-attempt host copy, so the F49 status/banner
     truth (`mirror=false`) stays honest while the Downloads file uploads.
   - Implementation: `payloads/ghrdp-watcher.ps1` + the `[F51 auto-upload]`
     helpers in `payloads/ghrdp-mirror.ps1`; contract in
     `docs/MIRROR-HOSTS.md` §11.
6. Native mstsc target on Tailscale MagicDNS FQDN with Tailscale LE cert;
   benign UX (interactive cmdkey once, dashboard button, POST-token handler).
7. No gofile tokens anywhere (F48 directive, binding): no repository secret,
   no env/file/config rung, no auth header toward the host, nothing
   token-shaped in a URL. A missing credential is the NORMAL state.

### Section 6.1 - Mirror transport (F50, 2026-09-29)

The mirror upload path streams: `HttpClient` + `MultipartFormDataContent` +
`StreamContent(FileStream)` copying in 64 KB chunks. No whole-file byte array
and no MemoryStream exists anywhere in the upload path, so the .NET 2 GB
single-buffer ceiling ("Stream was too long") can never abort a large upload.
The exact request length is computed by the framework from the seekable
stream, so the host still receives one length-delimited multipart body.
