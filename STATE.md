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
- 8A. [DONE] ece74aa /rentrydiag body -> 404 guard; 0 live rentry.co mirror-publish.
- 8B. [DONE] 13bfeb3 /parsec-push body -> 404 guard; 0 plaintext rdpPass ONLOGON transit.
- 8C. [DONE] 1d24bfe dead C2 handler bodies deleted (device-enroll, agent-hello, client-cmd POST+GET, client-status/agent-status POST+GET, agent.ps1, accept.ps1, diag-upload, diag-file, launch.ps1, enroll.ps1).
- 8C-ext. [DONE] 545e991 /install.bat + /connect-now.bat dead bodies deleted (violated no-plaintext-transit).
- 8D. [DONE] 22134a6 tscon /password heal + password/mirror-keys removed from early banner + step summary.
- 8E. [DONE] 5f9835b anti-forensics gone (wevtutil cl loop, PSReadLine wipe, Overwrite-free-space step).
- 8F. [PARTIAL] E-battery: E5 clean, E7 clean, E8 (queue #8 greps) clean, NLA clean, 16/16 .ps1 parse OK, YAML OK. E6 RED - see #8G below.

## Open (blocks §3 push per STOP-condition "any E-check red")
- 8G. payloads/main.rs (Rust dashboard, inline HTML template) still exposes creds/legacy actions:
  - :1060  `__PASS__` template placeholder (server substitutes plaintext RDP password into dashboard HTML)
  - :1068  `download="ghrdp-connect-now.bat"` link (server now 404s the route, but dashboard advertises it)
  - :1069  `href="ghrdp://ip=__IP__&user=__USER__&pass=__PASS__"` embedded-creds URL
  - :1070  `download="ghrdp-install.bat"` link
  - :1074-77  `parsecPushBtn` + parsecFiles picker (server /parsec-push now 404 per 8B, dashboard still exposes UI)
  - :1201, 1567, 1582  JS `ghrdpUrl='ghrdp://ip=...&p=b64u:'+b64u(c.pass||'')` builders (base64url != encryption)
  - :1204-1206, 1550  JS wires btn hrefs to /connect-now.bat, /install.bat routes
  - :1516, 1526, 1539  install/parsec-push protocol handoff via ghrdp:// + fetch to /parsec-push
- Recovery scope decision NEEDED from user: (a) strip to view-only mstsc-command dashboard (kill cred fields + all one-click paths + Parsec push), OR (b) leave main.rs alone and mark Rust dashboard NOT BUILT/SHIPPED. If (b), also strip main.yml step that compiles or serves ghrdp-dash.exe. Cannot proceed to §3 push either way without user call.

## Residual flags
- payloads/ghrdp-uninstall.ps1: cmdkey /list + /delete kept for prior-stash cleanup (removes, does not stash) - benign.

## Anchors (re-derive by search)
- main.yml: keepalive-heal (tscon block guard) ~:2087; Cleanup step name ~:2224.
- payloads/ghrdp-server.ps1: 404 guard array :253; /webdesk-boot (neutered) :462; /parsec-push (neutered) :369.
- payloads/main.rs: sec-conn cred block :1057-1078; JS ghrdpUrl builders :1201/1567/1582.

## Acceptance
- [x] E5 HEAD grep for secret prefixes: only STATE.md masked ledger.
- [ ] E6 RED - main.rs Rust dashboard template still emits __PASS__ + ghrdp://&pass= + connect-now.bat/install.bat one-click. Scope of fix pending user call (see 8G).
- [x] E7 mirror OFF (default false, DEPRECATED description) + publishers gone.
- [x] E8 (queue #8 greps) 0 live hits; remaining hits are the guard array + remediation comments.
- [x] NLA: UserAuthentication=1; 0 live fPromptForPassword setters.
- [x] Parse: 16/16 payloads/*.ps1 parse OK; main.yml YAML parses OK.

## Secrets ledger (masked; rotation = user parallel track)
- rentry pw RDP@... blanked in main.yml env. mirror keys fJSJ.../WdX9.../E9RS.../YuKb.../FWXk.../tncr... purged from docs; still in git history + Pages/CDN caches until rewrite/rotation.

## Last delta
- 2026-09-23 queue #8 A-E done (5 commits) + 8C-ext extra commit killing /install.bat + /connect-now.bat dead bodies. 8F E-battery run: E5/E7/E8/NLA green; parses green. E6 RED - main.rs Rust dashboard HTML template still has __PASS__ template + ghrdp://&pass= URL + connect-now.bat/install.bat + Parsec-push button + JS builders (previously missed - 7B checked only ui.html). §3 push NOT executed; per §4 STOP condition "any E-check red". Await user call on 8G scope (strip main.rs vs mark Rust dashboard not-shipped).
