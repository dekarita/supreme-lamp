# GHRDP STATE (<=60 lines; phase: PRODUCTION MAINTENANCE; masked-secrets first-4)

## Decisions (permanent, locked architecture)
- NLA=1 only; no fPromptForPassword=0, no AuthLvlOverride, no client 'authentication level:i:0|3', no 'prompt for credentials:i:0'.
- No credential stashing / plaintext-password transit by tooling (no cmdkey stash, no /api/rdp-creds pass, no ui.html __PASS__, no ghrdp://&pass=).
- No MOTW/Zone.Identifier strip; no SmartScreen/ClickFix/uBlock/publisher-bypass evasion; no LocalDevices pre-trust arming.
- No C2 persistence (agent/enroll/launch/accept/diag endpoints stay 404); no public mirror/index of third-party content; no anti-forensics.
- Native mstsc target on Tailscale MagicDNS FQDN with Tailscale LE cert; benign UX (interactive cmdkey once, dashboard button, POST-token handler).

## Done ledger (sha-only; older shas prune to git log)
- U1 repair (launch-gates run 36045997362 PASS; live client NOT verified): restored VPS-only AUTO-LOGIN button, explicit cmdkey confirmation, rid-only URI, validated WEB DESKTOP URL + linked missing-secret advisory, zero E-battery UI matches; server requires dashboard bearer for 60s single-use rid, returns only FQDN; pinned compiled .NET handler built and self-tested on Windows CI. User must install binary on client; no real RDP connection claimed.
- G3 native hardening (session branch; Windows CI/live VPS pending): provisioning locks static rdpuser, NLA+TLS-only/CredSSP, exact-FQDN LE cert+key ACL, IPv4 tailnet-only TCP/3389, protected config+token and hostKind=vps; certBound checks exact name/expiry; missing VNC_PASS clears URL and halts, install failures withhold secret-bearing exception text. F9g stage DNS retry was already present. VPS dashboard/web gateway still require user deployment and live validation; do NOT decommission Actions.
- F9h main.yml web-desktop step: VNC_PASS missing is now FAIL-CLOSED. Guard runs BEFORE any install command; writes ::error:: annotation + Step Summary card with a direct link to /settings/secrets/actions, stamps config.json webdeskReason='vnc-pass-missing' + vncPassAdminUrl, then throws (run fails by design). Supersedes the old loud `exit 0` skip, which reported a green run with the web desktop permanently absent. Short-but-present VNC_PASS (<8 chars) is unchanged: loud non-fatal skip. Belt block retained (also throws) so the two F8 launch-gate markers stay in the step region.
- F9f launch-gates: admin-link count >= 3 in main.yml + every Self.DNSName step must validate *.ts.net (no gate passes on empty/non-ts.net name); D/E + F8 gates kept untouched.
- F9a main.yml: all 3 MagicDNS gates (ts-connect, cert-bind, stage) append 'halted by design' + [Enable MagicDNS now](admin/dns) + re-run line to GITHUB_STEP_SUMMARY, echo to log, throw with URL; 15-min HOLDs removed (halt immediate; re-dispatch after enabling).
- F9b main.yml: opt-in auto-enable - TS_API_TOKEN+TS_TAILNET_NAME env (secrets) -> POST api.tailscale.com/api/v2/tailnet/<name>/dns/preferences {"magicDNSEnabled":true} (Bearer header, token never printed), sleep 5, re-read Self.DNSName; secrets absent -> silent skip.
- F9c ghrdp-server.ps1 /api/native-status: +magicDnsAdminUrl field; probeReasons.fqdn text carries the admin URL (feeds the fqdn reasonsDisabled rendering).
- F9d ui.html: fqdn reason linkified via <a target=_blank rel=noopener> (uses s.magicDnsAdminUrl); ephemeral+fqdn-missing yellow advisory row 'workflow halted until MagicDNS enabled - open the admin link, enable, re-dispatch'; row hidden once fqdn ok.
- F9e MIGRATION.md sec 1.3+1.7: admin link, DNS->MagicDNS toggle path (ON, Save, re-run), optional API one-liner (TS_API_TOKEN+TS_TAILNET_NAME), halt-by-design statement.
- Prior: 4812cdd5 remediation merged; 478d015b P1-P3 (cert script, FQDN discipline, POST-token/mutex/JSONL); 2252263e G3 provision; 053894c5 MIGRATION rewrite.
- Prior: U1-U4 native-mstsc rewrite (ui/server/helper, AUTO-LOGIN contract); F6-F8 certBound honesty, hostKind reasons, advisory rows, webdesk honesty + self-test; PR#9 F9 HOLD variant superseded by F9a halt-by-design.

## Queue (production maintenance)
- G1. Secret rotation (USER-driven, out of band): checklist = MIGRATION.md sec 1.8.
- G2. Git history rewrite (USER-gated 'history-rewrite-go'): plan = MIGRATION.md sec 4. Runs AFTER G1.
- G3. VPS provision: user runs payloads\Provision-GhrdpVps.ps1 (MIGRATION sec 1.7). Client cmdkey once per sec 1.4.
- G4. Actions decommission after G3 verified live AND G1 done: checklist = MIGRATION.md sec 2 (13 items).

## Residual flags
- ghrdp-uninstall.ps1 cmdkey /list+/delete kept for prior-stash cleanup (removes, never stashes).
- Rust main.rs audited by inspection; no local cargo toolchain (deferred to CI).
- Main.yml runs 2026-09-23/24 cancelled by user pre-F9-verify; re-dispatch per F9 verify loop (MIGRATION 1.3).

## Anchors (re-derive by search)
- main.yml: MagicDNS gates ~:316/:355/:845; Cleanup ~:2535. main.yml F9h VNC_PASS guard ~:1055 (belt ~:1078), inside web-desktop step ~:1029. ghrdp-server.ps1: native-status ~:356; 404 guard :253. payloads/main.rs: api_config secret-strip ~:283. helper: mutex ~:105. MIGRATION.md: web desktop ~:285 (F9h bullet ~:290).
