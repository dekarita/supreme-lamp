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
- 3a. [DONE] 3 Publish steps deleted; step count 48; Put-GhFile/serviceWorker=0.
- 3b. [DONE] 21 ghrdp-lib fns throw-on-call; watcher mirror path removed.
- 3d. [DONE] $reqBookmarks=@(); tool bookmarks removed; kept Mission Control/Tailscale/Actions.
- 5.  [DONE] agent/enroll/launch/accept/acceptance/diag/review deleted; helper token->mstsc; uninstall shipped; server C2 routes 404-guarded; /api/rdp-creds host-only.
- 7A. [DONE] 0 rdpPass/rdpUser inside live response objects (grep classified).
- 7B. [DONE] 0 __PASS__, 0 'pass=', 0 agent-status.
- 7C. [DONE] Start-GhrdpLoopbackSession body begins with throw; 0 live callers.
- 7D. [DONE] 0 'D1 synthetic'; banner retains DASHBOARD + RDP CONNECTION (mstsc/user only) + EMERGENCY STOP.
- 6.  [DONE] docs/MIGRATION.md exists; names Secure-cleanup + Overwrite-free-space removals; write-only.

## Residual flags (out of this branch's scope)
- payloads/ghrdp-server.ps1 /rentrydiag: live rentry.co mirror-publish + mirrorKey leak; #6 target.
- payloads/ghrdp-server.ps1 /parsec-push: live plaintext rdpPass transit into schtasks ONLOGON; #6.
- payloads/ghrdp-server.ps1 dead 404-guarded C2 handler bodies below the guard (/connect-now.bat, /api/client-cmd): unreachable but should be deleted at #6.
- main.yml keepalive: tscon.exe /password: line still transits plaintext RDP password on the tscon command line; #6/follow-up plaintext-transit sweep.
- main.yml ~line 1167: separate inline "---- INDEXES & KEYS ----" banner in an earlier step still prints dead mirror content; #6.
- payloads/ghrdp-uninstall.ps1: cmdkey /list + cmdkey /delete kept for prior-stash cleanup (removes, does not stash) - benign.

## Anchors (re-derive by search before each edit; lines shift)
- main.yml: keepalive branch (tscon/loopback); Show-Banner ~:1809; earlier inline "---- INDEXES & KEYS ----" ~:1167.
- payloads/ghrdp-server.ps1: /rentrydiag ~:213; /parsec-push ~:1380; dead 404-guarded C2 bodies below :287 guard.

## Acceptance
- [x] E5 HEAD grep for secret prefixes: only STATE.md masked ledger; all other files clean.
- [~] E6 shipped client payloads: 0 banned patterns EXCEPT ghrdp-uninstall.ps1 cmdkey /list + /delete (removes prior stashes; benign cleanup).
- [x] E7 mirror off + publishers gone + Megathread/FMHY gone; docs/sw.js CACHE=ghrdp-explorer-v2.
- [x] NLA: main.yml sets UserAuthentication=1; fPromptForPassword appears only in descriptive text (STATE / MIGRATION / #7C neutering comment), 0 live setters. Live NLA probe DEFERRED to next runner/VPS.

## Secrets ledger (masked; rotation = user parallel track, NOT confirmed)
- rentry pw RDP@... blanked in main.yml env. mirror keys fJSJ.../WdX9.../E9RS.../YuKb.../FWXk.../tncr... purged from docs working tree; still in git history + Pages/CDN caches until rewrite/rotation.

## Last delta
- 2026-09-23 #7A/#7B/#7C/#7D + #6 done. #7 queue closed on-branch: server response bodies cred-free; ui.html cred display/anchor/bat gone; loopback function throw + callers stubbed; D1 gate deleted + banner trimmed; migration doc written. Residual flags listed above (rentrydiag, parsec-push, tscon /password, dead 404 bodies, earlier inline banner) tracked for #6/follow-up. Await user instruction on push/PR/merge.
