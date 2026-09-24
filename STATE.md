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
- 5bf62e0 U2 Phase-1 landed: (a) ghrdp-server.ps1 +4 endpoints in 404-guard + bodies deleted; Remove-CredKeys rebuilds creds={fqdn,user,ip} & strips rentry/dashToken. (b) helper-ghrdp-connect.ps1 server= *.ts.net only. (c) ui.html launchProto -> window.location.href; bootstrapConfig() polls /api/config every 15s. (d) main.yml mirror + TightVNC + qBittorrent removed. (e) docs/AUTOLOGIN.md created.
- 5563b0a U3 native-status contract landed: (a) ghrdp-server.ps1 GET /api/native-status {fqdn,certBound,nlaOn,handlerSeenAgeSec,reasonsDisabled}; POST /api/handler-hello writes {ts}. Both dash-token+tailnet gated. (b) ui.html sec-native-rdp Cert/NLA/Handler rows + reasonsDisabled row; nativeStatus() 15s poll. (c) helper-ghrdp-connect.ps1 fire-and-forget hello beacon after redeem.
- U4 UX completion (this commit): (a) ghrdp-server.ps1 /api/native-status +webdeskUrl + lastHandlerVerb {verb,ok,details,ts}; /api/handler-hello body may carry {verb,ok,details}. (b) helper-ghrdp-connect.ps1 verb router: install (HKCU\Software\Classes\ghrdp reg + copy to %LOCALAPPDATA%\ghrdp\), setup (interactive cmdkey /generic:TERMSRV/<fqdn> /user:<user>; NO /pass:), check (reg + cmdkey + tailscale status; local MessageBox result), connect (unchanged). Send-Hello helper unifies beacon; all verbs POST verb+ok+details. (c) ui.html sec-native-rdp: 5-probe grid (FQDN/Cert/NLA/Handler/Credential, credential local via localStorage 90d), Last-handler-action row, one-click actions bar (RUN INSTALL/SETUP/CHECK/AUTO-LOGIN/WEB DESKTOP). AUTO-LOGIN enabled only when all 5 probes ✅; WEB DESKTOP enabled only when webdeskUrl non-empty. (d) docs/MIGRATION.md sec 1.10 (Guacamole via tailscale serve, decommission). No cred stashing tool-side (setup uses interactive cmdkey only); no /pass:; NLA/cert never toggled off; no Unblock-File; no secrets in URLs/logs.

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
- payloads/ui.html: sec-native-rdp block ~:310-355 (Target FQDN + 5-probe rows Cert/NLA/Handler/Credential + reasonsDisabled + last-handler + one-click actions bar RUN INSTALL/SETUP/CHECK/AUTO-LOGIN/WEB DESKTOP); nativeStatus() + button wiring IIFE ~:828-905; token-flow IIFE ~:906-940 (POST /api/rdp-token -> ghrdp://connect?server=&port=7331&t=<tok>).
- payloads/ghrdp-server.ps1: /api/native-status ~:346-410 (fqdn, certBound, nlaOn, handlerSeenAgeSec, webdeskUrl, reasonsDisabled, lastHandlerVerb); /api/handler-hello ~:411-435 (accepts {verb,ok,details}). Both dash-token+tailnet gated via routing Test-ClientAllowed.
- payloads/helper-ghrdp-connect.ps1: verb router ~:57-135 (install/setup/check/connect); Send-Hello helper ~:75-82 unifies POST /api/handler-hello.

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
- 2026-09-24 U3 LANDED as 5563b0a (native-status contract + handler-hello beacon; rebased over 2 status-update commits then pushed). U4 UX completion applied on top: /api/native-status now returns webdeskUrl + lastHandlerVerb {verb,ok,details,ts}; /api/handler-hello now accepts {verb,ok,details}; helper-ghrdp-connect.ps1 routes install/setup/check verbs (HKCU reg-add + %LOCALAPPDATA%\ghrdp\ copy; interactive cmdkey, no /pass:; local MessageBox check summary); ui.html sec-native-rdp shows 5-probe grid (FQDN/Cert/NLA/Handler/Credential) + one-click actions bar (RUN INSTALL/SETUP/CHECK/AUTO-LOGIN/WEB DESKTOP). AUTO-LOGIN enabled only when all 5 probes ✅; WEB DESKTOP enabled only when config.webdeskUrl non-empty. docs/MIGRATION.md sec 1.10 (Guacamole via tailscale serve, decommission) added. Next: gh workflow run + live redeem test after VPS G3 provisioning.
- 2026-09-24 U1 closed: payloads/ui.html rewritten (1108->833 lines, -275). New sec-native-rdp section replaces removed agent enrollment / DIAG / installer / Parsec-push surface. Native flow only: POST /api/rdp-token -> ghrdp://connect?server=&port=7331&t=<tok>; handler POST-redeems /api/rdp-creds, gets *.ts.net FQDN, runs mstsc /v:<fqdn> against stored TERMSRV cmdkey cred. Zero plaintext in URL/UI/logs. Matches shipped P2/P3 handler contract (helper-ghrdp-connect.ps1:3). MIGRATION.md sec 1.9 added.
