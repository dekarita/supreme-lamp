# GHRDP STATE (<=60 lines; local-repo remediation; masked secrets first-4)

## Decisions (permanent)
- NLA ON only (UserAuthentication=1); no fPromptForPassword=0, no AuthLvlOverride, no 'authentication level:i:0|3' suppressant, no 'prompt for credentials:i:0', no silent connect.
- No credential stashing / plaintext-password transit by tooling (no cmdkey stash, no /api/rdp-creds pass, no ui.html __PASS__, no ghrdp://&pass=, no /connect-now.bat cmdkey, no creds in /progress|/api/progress|/config).
- No MOTW/Zone.Identifier strip; no SmartScreen/ClickFix/uBlock/publisher-bypass evasion; no PublisherBypassList; no LocalDevices pre-trust arming.
- No C2 persistence: delete ghrdp-agent.ps1 + ghrdp-enroll.ps1 (+ staging cp lines); remove enroll/client-cmd/agent-hello/agent-status/diag-upload/diag-file/agent.ps1/accept.ps1 endpoints + D1 loopback gate; ship idempotent ghrdp-uninstall.ps1.
- No public mirror/index of 3rd-party content; private sync of user's OWN files only.
- No anti-forensics: remove Secure cleanup (log-clear) + Overwrite free space at decommission.
- Migrate off Actions-as-RDP -> VPS; decommission after. No migration now.
- Benign UX: user-run-once cmdkey (typed pw) + cert trust -> auth-level 2 + CredSSP succeeds (zero warnings, no suppression); handler = resolve host + mstsc /v:<host> only.

## Done (branch ghrdp-remediation)
- 1d73ffe7 #1 docs keys purged + mirror-status fields blanked + sw.js CACHE v2.
- 1bafebcb #2 main.yml mirror teardown (input off, rentry pw blank, 3 terminal publishers deleted) + NLA ON.
- c73b67fa worker.js /proxy -> 410.
- 32b5225e #3c config.json staging blanks + Megathread/FMHY bookmark removal.
- 79e785ea #7A ghrdp-server.ps1 creds stripped from all live responses (+ Remove-CredKeys).
- 1a4481b8 #7B ui.html __PASS__/pass= anchor/auto-connect .bat removed (agent-status literal was already 0).
- e2a849c2 #7C Start-GhrdpLoopbackSession throw-on-call; /webdesk-boot + main.yml keepalive callers stubbed.
- 68f5adc  #7D D1 synthetic tailnet-agent gate step deleted; Show-Banner dead pagesBase/mirror URLs stripped.
- 797fb277 #6  docs/MIGRATION.md added (write-only VPS plan + decommission checklist).

## Queue
- 3a/3b/3d/5/6/7A-7D: [DONE] (see git log).
- 8A. [DONE] ece74aa /rentrydiag body -> 404 guard.
- 8B. [DONE] 13bfeb3 /parsec-push body -> 404 guard.
- 8C. [DONE] 1d24bfe dead C2 handler bodies deleted.
- 8C-ext. [DONE] 545e991 /install.bat + /connect-now.bat dead bodies deleted.
- 8D. [DONE] 22134a6 tscon /password heal + password/mirror-keys removed from early banner.
- 8E. [DONE] 5f9835b anti-forensics gone (wevtutil cl loop, PSReadLine wipe, Overwrite-free-space step).
- 8F. [DONE] E-battery green - see Acceptance.
- 8G. [DONE] 4b64b7e main.rs Rust dashboard cred surface stripped: snapshot_payload no pass, api_config strips secrets, HTML template cred row + ghrdp:// URL + .bat one-click + Parsec push panel deleted, JS ghrdpUrl builders + orch iframe fire deleted.
- 8G-ext. [DONE] 17caeab ghrdp-lib.ps1 Publish-SearchPage/Build-StatusObject dead `creds.pass` scrubbed (unreachable past 3b throw but was source-of-truth).

## Ready for §3 (merge to main + push origin main). NO stop flags open.

## Residual flags
- payloads/ghrdp-uninstall.ps1: cmdkey /list + /delete kept for prior-stash cleanup (removes, does not stash) - benign.
- No local Rust toolchain -> cargo check for main.rs deferred to VPS/CI. Edits audited by inspection: raw-string delimiters intact (r##" ... "##;), `for k in [&str;N]` + Map::remove(&str) valid.

## Anchors (re-derive by search)
- main.yml: keepalive-heal (tscon block guard) ~:2087; Cleanup step ~:2224.
- payloads/ghrdp-server.ps1: 404 guard array :253; /webdesk-boot (neutered) :462.
- payloads/main.rs: snapshot_payload creds :133-140; api_config secret-strip :283-300; sec-conn IP/user rows :1066-1069.

## Acceptance
- [x] E5 HEAD grep for secret prefixes: only STATE.md masked ledger.
- [x] E6 client payloads: 0 live cred emissions; 2 rdpPass hits are strip loops (ghrdp-server.ps1:192 Remove-CredKeys, main.rs:292 api_config filter). ghrdp-uninstall.ps1 cmdkey /list + /delete benign.
- [x] E7 mirror OFF (default false, DEPRECATED description).
- [x] E8 (queue #8 greps) 0 live hits; remaining hits are the guard array + remediation comments.
- [x] NLA: UserAuthentication=1; 0 live fPromptForPassword setters.
- [x] Parse: 16/16 payloads/*.ps1; main.yml YAML.
- [~] Rust build for main.rs deferred (no local toolchain); syntax audited.

## Secrets ledger (masked; rotation = user parallel track)
- rentry pw RDP@... blanked in main.yml env. mirror keys fJSJ.../WdX9.../E9RS.../YuKb.../FWXk.../tncr... purged from docs; still in git history + Pages/CDN caches until rewrite/rotation.

## Last delta
- 2026-09-23 queue #8 A-E + 8C-ext + 8G + 8G-ext done (8 remediation commits). Full E-battery now green (E5/E6/E7/E8/NLA + parse + YAML all pass). Ready for §3 merge to main + push. Rust cargo check deferred - no local toolchain; VPS/CI runner will catch any compile issue on first build.
