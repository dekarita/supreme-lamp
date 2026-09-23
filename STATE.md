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

## Queue
- 3a. [DONE] 3 Publish steps deleted (Pages tools/Explorer/offline SW incl SW-injection); Verify Pages kept; step count 48; Put-GhFile/serviceWorker=0.
- 3b. [DONE] 21 ghrdp-lib.ps1 fns throw-on-call (parses OK); watcher mirror path removed (grep 21 fns=0, heartbeat kept); main.yml Expose(:1090)/keepalive(:1993) try/catch-wrapped.
- 3d. [DONE] $reqBookmarks=@(); Decryptor/Archive/Explorer tool bookmarks removed; kept Mission Control(local+tailnet)/Tailscale Admin/GitHub Actions. (Show-Banner log lines :1923-25 still print dead Pages URLs - log-only, flagged.)
- 5. Delete agent+enroll payloads + cp lines; ship ghrdp-uninstall.ps1; rewrite helper-ghrdp-connect.ps1 -> token->host->mstsc only; stop serving agent payloads.
- 7. Server/ui cleanup: remove C2 endpoints + D1 gate; strip creds from /progress|/api/progress|/config; ui.html __PASS__/&pass=/auto-connect/agent-diag.
- 6. docs/MIGRATION.md + decommission checklist (drop Secure cleanup + Overwrite free space). No migration now.

## Anchors (re-derive by search before each edit; lines shift)
- main.yml: Publish steps ~:1220/:1324/:1349; Verify Pages ~:1312; personalization $reqBookmarks ~:1691; D1 gate; Secure cleanup; Overwrite free space.
- payloads/ghrdp-lib.ps1 neuter list; ghrdp-server.ps1 endpoints; ui.html __PASS__/anchor; delete ghrdp-agent.ps1 + ghrdp-enroll.ps1.

## Acceptance
- [~] E5 no secrets in HEAD: working tree clean; git history pre-branch still holds them (rewrite = separate user decision).
- [ ] E6 payloads clean (after 3b/#5/#7). [~] E7 mirror off + 3 publishers gone + config blanks + Megathread/FMHY gone; 3a/3d/3b remain.
- [x] NLA UserAuth=1, fPromptForPassword absent. Live NLA probe DEFERRED to next runner/VPS.

## Secrets ledger (masked; rotation = user parallel track, NOT confirmed)
- rentry pw RDP@... blanked in main.yml env. mirror keys fJSJ.../WdX9.../E9RS.../YuKb.../FWXk.../tncr... purged from docs working tree; still in git history + Pages/CDN caches until rewrite/rotation.

## Last delta
- 2026-09-23 3d done: mirror + tool bookmarks removed, kept MC/Tailscale/Actions. Next: #5 client rewrite (delete agent+enroll, ship uninstall, rewrite helper, 404 agent routes).
