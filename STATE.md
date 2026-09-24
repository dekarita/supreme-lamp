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
- U1 payloads/ui.html rewritten to native mstsc auto-login; agent enrollment / DIAG / Parsec-push / install.bat helpers removed; POST /api/rdp-token -> ghrdp://connect?server=&port=7331&t=<tok>; MIGRATION.md §1.9.
- 5bf62e0 U2 Phase-1: 404-guard bodies deleted; Remove-CredKeys rebuilds creds={fqdn,user,ip}; helper server= *.ts.net only; bootstrapConfig() 15s poll; docs/AUTOLOGIN.md.
- 5563b0a7 U3 native-status contract: GET /api/native-status {fqdn,certBound,nlaOn,handlerSeenAgeSec,reasonsDisabled}; POST /api/handler-hello writes {ts}; helper fire-and-forgets hello after redeem; ui.html shows Cert/NLA/Handler rows + reasonsDisabled.
- U4 (this commit) 5-probe grid + verb router (install/setup/check/connect) + webdesk button: server /api/native-status adds {webdeskUrl,lastHandlerVerb}; POST /api/handler-hello accepts {verb,ok,details}; helper-ghrdp-connect.ps1 gains install (HKCU no-admin reg), setup (interactive cmdkey, no /pass:), check (MessageBox); ui.html #sec-native-rdp swaps to 5-probe grid (probes 1-4 server, probe 5 localStorage ghrdp_cred_set_<fqdn> <90d) + RUN INSTALL/SETUP/CHECK/AUTO-LOGIN/WEB DESKTOP; AUTO-LOGIN enabled only when all 5 green; WEB DESKTOP enabled only when webdeskUrl set; MIGRATION.md §1.10 (Guacamole VPS, tailnet-only).

## Queue (production maintenance)
- G1. Secret rotation (USER-driven, out of band): rentry pw, 6 mirror codes, TS auth keys, rdpuser pw, dashToken, GH PATs. Checklist = MIGRATION.md sec 1.8.
- G2. Git history rewrite (USER-gated on 'history-rewrite-go'): git-filter-repo preferred, BFG alt. Plan = MIGRATION.md sec 4. Runs AFTER G1.
- G3. VPS provision: user runs payloads\Provision-GhrdpVps.ps1 on target host (winget TS install, tailnet join, rdpuser interactive-pw, NLA=1, cert bind, tailnet-only fw). Client cmdkey once per sec 1.4. Guacamole + config.webdeskUrl per §1.10 (unlocks WEB DESKTOP button).
- G4. Actions decommission: after G3 verified via live client NLA-probe AND G1 done. Checklist = MIGRATION.md sec 2 (13 items).

## Migration P1-P3 (bundled in 478d015b, live on main)
- P1 payloads\Enable-RdpTlsCertificate.ps1 (tailscale cert -> LocalMachine\My -> SetSSLCertificateSHA1Hash + reg fallback; NLA=1 re-assert; idempotent; PS7+).
- P2 helper-ghrdp-connect.ps1 + server /api/rdp-creds refuse non-*.ts.net; response fields host + fqdn (dropped hostip); no IP fallback.
- P3 /api/rdp-creds POST-only (GET -> 410 Gone); Global\GHRDP-<fqdn> named mutex; startup stale-cred sweep (log-only); JSONL audit at %LOCALAPPDATA%\ghrdp\ghrdp-connect.log.

## Residual flags
- payloads/ghrdp-uninstall.ps1 cmdkey /list + /delete kept for prior-stash cleanup (removes, does not stash - benign).
- Rust main.rs edits audited by inspection; no local toolchain for cargo check (deferred to VPS/CI).
- Runner workflow CANCELLED 2026-09-23 by user before M1-M3 push (zero race). Re-dispatch not planned; G4 permanently disables.
- U4 probe 5 (CREDENTIAL) is per-browser localStorage; server NEVER learns which PCs stored TERMSRV cred. Sticks 90d; user re-runs SETUP after that.

## Anchors (re-derive by search)
- main.yml: keepalive-heal (tscon block guard) ~:2087; Cleanup step ~:2224.
- payloads/ghrdp-server.ps1: LastHandlerVerb init ~:22-27; 404 guard array :269; /api/rdp-creds POST-only+FQDN-guard ~:284; /api/native-status ~:351-395 (webdeskUrl + lastHandlerVerb U4); /api/handler-hello ~:396-437 (parses {verb,ok,details}); /webdesk-boot (neutered) :505.
- payloads/main.rs: snapshot_payload creds :133-140; api_config secret-strip :283-300; sec-conn IP/user rows :1066-1069.
- payloads/helper-ghrdp-connect.ps1: URL/verb parse ~:47-72; Send-Hello ~:81-96; install verb ~:99-127; setup verb ~:130-167; check verb ~:170-210; connect verb ~:213-282; per-host mutex ~:262.
- payloads/Enable-RdpTlsCertificate.ps1: tailscale cert -> LocalMachine\My ~:45; SetSSLCertificateSHA1Hash ~:78.
- payloads/Provision-GhrdpVps.ps1: preflight ~:48; TS install ~:60; FQDN resolve ~:76; rdpuser ~:85; NLA ~:98; cert delegate ~:105; tailnet-only fw ~:112.
- payloads/ui.html: sec-native-rdp ~:310-360 (Target FQDN + 5-probe grid + lastVerbRow + 5-button row + fallback copies); nativeStatus() + recomputeButtons ~:828-935; verb button handlers ~:940-985; AUTO-LOGIN token flow ~:990-1020; nav link :257.

## Acceptance
- [x] E5 secret prefixes: only STATE.md masked ledger + MIGRATION.md sec 4.2 STEP 3 grep-example.
- [x] E6 client payloads: 0 live cred emissions.
- [x] E7 mirror OFF (default false, DEPRECATED description).
- [x] E8 P1-P3 markers present in HEAD.
- [x] NLA=1 present; 0 live fPromptForPassword=0 setters.
- [x] Parse: 17/17 payloads/*.ps1 (Provision-GhrdpVps.ps1 parse-OK).
- [x] U4 greps: 0 hits for cmdkey /pass:, ghrdp://&pass=, Unblock-File, Zone.Identifier in touched files.
- [~] Rust build for main.rs deferred (no local toolchain).

## Secrets ledger (masked; rotation = G1)
- rentry pw RDP@... blanked in main.yml env. Mirror keys fJSJ.../WdX9.../E9RS.../YuKb.../FWXk.../tncr... purged from docs HEAD; still in pre-remediation git history + Pages caches until G2.

## Last delta
- 2026-09-24 U4: 5-probe grid + verb router (install/setup/check) + webdesk button. Server /api/native-status now emits {webdeskUrl,lastHandlerVerb}; POST /api/handler-hello accepts {verb,ok,details} (in-memory map; disk still tracks ts). helper-ghrdp-connect.ps1 becomes a verb router (install=HKCU reg, setup=interactive cmdkey in spawned console, check=MessageBox, connect=unchanged); no /pass: anywhere, no plaintext password ever crosses this script. ui.html #sec-native-rdp swaps rows->5-probe grid (probes 1-4 server, probe 5 localStorage 90d marker set optimistically on RUN SETUP click); AUTO-LOGIN enabled only when all 5 green; WEB DESKTOP disabled until VPS provisions Guacamole per §1.10. MIGRATION.md §1.10 added (tailscale serve --bg, tailnet-only, decommission line). Diff sizing ~+300/-40 across 5 files.
