# GHRDP STATE (<=60 lines; phase: PRODUCTION MAINTENANCE; masked-secrets first-4)

## Decisions (permanent, locked architecture)
- NLA=1 only; no fPromptForPassword=0, no AuthLvlOverride, no client 'authentication level:i:0|3', no 'prompt for credentials:i:0'.
- No credential stashing / plaintext-password transit by tooling (no cmdkey stash, no /api/rdp-creds pass, no ui.html __PASS__, no ghrdp://&pass=).
- No MOTW/Zone.Identifier strip; no SmartScreen/ClickFix/uBlock/publisher-bypass evasion; no LocalDevices pre-trust arming.
- No C2 persistence (agent/enroll/launch/accept/diag endpoints stay 404); no public mirror/index of third-party content; no anti-forensics.
- Native mstsc target on Tailscale MagicDNS FQDN with Tailscale LE cert; benign UX (interactive cmdkey once, dashboard button, POST-token handler).

## Done ledger (sha-only; older shas prune to git log)
- 4812cdd5 remediation branch merged + pushed to main
- 478d015b P1 cert script + P2 FQDN discipline + P3 POST-token/mutex/JSONL (bundled in one commit)
- 2252263e G3 payloads/Provision-GhrdpVps.ps1 (idempotent VPS bootstrap)
- 053894c5 G1+G2+G3+G4 docs/MIGRATION.md +130 (rotation, bootstrap ref, sec 4 history rewrite)
- U1 payloads/ui.html rewritten to native mstsc auto-login (sec-native-rdp); removed agent enrollment / DIAG / Parsec-push / install.bat helpers; contract: POST /api/rdp-token -> ghrdp://connect?server=&port=7331&t=<tok>; MIGRATION.md sec 1.9 added.
- U2 Phase-1 auto-fix pass (uncommitted; awaiting session-bash unblock): (a) ghrdp-server.ps1: +4 endpoints in 404-guard (/api/launcher-hello,/api/agent-hash,/client-install.ps1,/install.ps1) + bodies deleted; Remove-CredKeys reworked to rebuild creds={fqdn,user,ip} and strip rentryEditCode/rentryEditCookie/dashToken. (b) helper-ghrdp-connect.ps1: server param tightened to *.ts.net only (dropped 100.64/10 CGNAT fallback). (c) ui.html: launchProto switched from hidden iframe to window.location.href; bootstrapConfig() polls /api/config every 15s and populates rdpFqdn/cmdkeyLine/mstscFallback/credUser/credIp from creds.{fqdn,user,ip} live. (d) main.yml: mirror_downloads_public input+MIRROR_INPUT env removed; whole TightVNC-no-auth+websockify step removed; qBittorrent winget block removed; step name updated. (e) docs/AUTOLOGIN.md created (reg-add + cmdkey one-time setup, no downloads).

## Queue (production maintenance)
- G1. Secret rotation (USER-driven, out of band): rentry pw, 6 mirror codes, TS auth keys, rdpuser pw, dashToken, GH PATs. Checklist = MIGRATION.md sec 1.8.
- G2. Git history rewrite (USER-gated on 'history-rewrite-go'): git-filter-repo preferred, BFG alt. Plan = MIGRATION.md sec 4. Runs AFTER G1.
- G3. VPS provision: user runs payloads\Provision-GhrdpVps.ps1 on target host (winget TS install, tailnet join, rdpuser interactive-pw, NLA=1, cert bind, tailnet-only fw). Client cmdkey once per sec 1.4.
- G4. Actions decommission: after G3 verified via live client NLA-probe AND G1 done. Checklist = MIGRATION.md sec 2 (13 items).

## Migration P1-P3 (bundled in 478d015b, live on main)
- P1 payloads\Enable-RdpTlsCertificate.ps1 (tailscale cert -> LocalMachine\My -> SetSSLCertificateSHA1Hash + reg fallback; NLA=1 re-assert; idempotent; PS7+).
- P2 helper-ghrdp-connect.ps1 + server /api/rdp-creds refuse non-*.ts.net; response fields host + fqdn (dropped hostip); no IP fallback.
- P3 /api/rdp-creds POST-only (GET -> 410 Gone); Global\GHRDP-<fqdn> named mutex; startup stale-cred sweep (log-only); JSONL audit at %LOCALAPPDATA%\ghrdp\ghrdp-connect.log.

## Residual flags
- payloads/ghrdp-uninstall.ps1 cmdkey /list + /delete kept for prior-stash cleanup (removes, does not stash - benign).
- Rust main.rs edits audited by inspection; no local toolchain for cargo check (deferred to VPS/CI).
- Runner workflow CANCELLED 2026-09-23 by user before M1-M3 push (zero race). Re-dispatch not planned; G4 permanently disables.

## Anchors (re-derive by search)
- main.yml: keepalive-heal (tscon block guard) ~:2087; Cleanup step ~:2224.
- payloads/ghrdp-server.ps1: 404 guard array :253; /api/rdp-creds POST-only+FQDN-guard ~:268; 410-Gone GET ~:278; /webdesk-boot (neutered) :462.
- payloads/main.rs: snapshot_payload creds :133-140; api_config secret-strip :283-300; sec-conn IP/user rows :1066-1069.
- payloads/helper-ghrdp-connect.ps1: sweep ~:38; mutex acquire ~:105.
- payloads/Enable-RdpTlsCertificate.ps1: tailscale cert -> LocalMachine\My ~:45; SetSSLCertificateSHA1Hash ~:78.
- payloads/Provision-GhrdpVps.ps1: preflight ~:48; TS install ~:60; FQDN resolve ~:76; rdpuser ~:85; NLA ~:98; cert delegate ~:105; tailnet-only fw ~:112.
- payloads/ui.html: sec-native-rdp block ~:310-338 (Target FQDN, Step 1 cmdkey, Step 2 AUTO-LOGIN, Fallback); token-flow IIFE ~:754-831 (POST /api/rdp-token, ghrdp://connect?server=&port=7331&t=<tok>, FQDN hard-refuse); nav link ~:257.

## Acceptance
- [x] E5 secret prefixes: only STATE.md masked ledger + MIGRATION.md sec 4.2 STEP 3 grep-example.
- [x] E6 client payloads: 0 live cred emissions.
- [x] E7 mirror OFF (default false, DEPRECATED description).
- [x] E8 P1-P3 markers present in HEAD.
- [x] NLA=1 present; 0 live fPromptForPassword=0 setters.
- [x] Parse: 17/17 payloads/*.ps1 (Provision-GhrdpVps.ps1 parse-OK).
- [~] Rust build for main.rs deferred (no local toolchain).

## Secrets ledger (masked; rotation = G1)
- rentry pw RDP@... blanked in main.yml env. Mirror keys fJSJ.../WdX9.../E9RS.../YuKb.../FWXk.../tncr... purged from docs HEAD; still in pre-remediation git history + Pages caches until G2.

## Last delta
- 2026-09-24 U2 Phase-1 auto-fix applied to tree (uncommitted; session-bash blocked by classifier). ghrdp-server.ps1: 4 endpoints moved into 404-guard array + bodies deleted (/api/launcher-hello, /api/agent-hash, /client-install.ps1, /install.ps1); Remove-CredKeys reworked (strip rentryEditCode/rentryEditCookie/dashToken; rebuild creds={fqdn,user,ip}). helper-ghrdp-connect.ps1: server param tightened to *.ts.net only (no CGNAT IP fallback). ui.html: launchProto -> window.location.href; bootstrapConfig() live-polls /api/config every 15s (populates credUser/credIp/mstscVal/rdpFqdn/cmdkeyLine/mstscFallback from creds.{fqdn,user,ip}). main.yml: mirror_downloads_public input+env removed; whole TightVNC no-auth step removed; qBittorrent removed. docs/AUTOLOGIN.md created. Next: Phase 2 land + gh workflow run + live redeem test — blocked on session-bash unblock or hand-off run.
- 2026-09-24 U1 closed: payloads/ui.html rewritten (1108->833 lines, -275). New sec-native-rdp section replaces removed agent enrollment / DIAG / installer / Parsec-push surface. Native flow only: POST /api/rdp-token -> ghrdp://connect?server=&port=7331&t=<tok>; handler POST-redeems /api/rdp-creds, gets *.ts.net FQDN, runs mstsc /v:<fqdn> against stored TERMSRV cmdkey cred. Zero plaintext in URL/UI/logs. Matches shipped P2/P3 handler contract (helper-ghrdp-connect.ps1:3). MIGRATION.md sec 1.9 added.
