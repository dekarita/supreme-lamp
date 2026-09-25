// F10 s6: autologin-lab.yml proof-matrix contract. The reserved lab repo
// (dekarita/ghrdp-lab) is unreachable from CI tooling, so the lab lives in
// this repository and must run the SAME payload code as main.yml.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const labPath = path.join(root, '.github', 'workflows', 'autologin-lab.yml');
const lab = fs.readFileSync(labPath, 'utf8');

test('autologin-lab: workflow shape and triggers', () => {
  assert.match(lab, /runs-on:\s*windows-latest/);
  assert.match(lab, /workflow_dispatch/);
  assert.match(lab, /branches:\s*\[arena\/01a0d7e5-supreme-lamp,\s*main\]/);
  assert.match(lab, /payloads\/ghrdp-rdp-launcher\.cs/);
  assert.match(lab, /payloads\/install\.cmd/);
  assert.match(lab, /timeout-minutes:/);
  // lab must be push-triggered on payload changes so it gates the PR
  assert.match(lab, /push:/);
});

test('autologin-lab: proof cells (a)-(g) all present', () => {
  // (a) install + handler + cmdkey prompt probe
  assert.match(lab, /A\) install\.cmd double-click/);
  assert.match(lab, /cmdkey\.exe \/generic:TERMSRV\/lab-rdp\.test\.ts\.net/);
  assert.match(lab, /prompt-monitor/);
  assert.match(lab, /seen-procs/);
  // (b) .rdp redirects + mstsc cmdline evidence
  assert.match(lab, /B\/C\) launcher verb/);
  assert.match(lab, /GHRDP_KEEP_RDP/);
  assert.match(lab, /redirectclipboard:i:1/);
  assert.match(lab, /redirectsmartcards:i:1/);
  assert.match(lab, /mstsc-cmdline/);
  // (c) fullscreen structure
  assert.match(lab, /screen mode id:i:2/);
  assert.match(lab, /desktopwidth\|desktopheight/);
  assert.match(lab, /screenshot-pending-live-client/);
  // (d) rdpLogonAgeSec plumbing
  assert.match(lab, /D\/E\) server harness/);
  assert.match(lab, /rdpLogonAgeSec/);
  assert.match(lab, /LogonType = 10/);
  // (e) ping plumbing + optional live tailscale ping
  assert.match(lab, /ping-probe\.json/);
  assert.match(lab, /pingPath relay not surfaced/);
  assert.match(lab, /e-live\)/);
  assert.match(lab, /secrets\.TS_AUTHKEY/);
  // (f) Edge policy enforcement via the shared provisioner
  assert.match(lab, /F\) Edge policy/);
  assert.match(lab, /Provision-BrowserPolicy\.ps1/);
  assert.match(lab, /ExtensionInstallForcelist/);
  assert.match(lab, /ManagedBookmarks/);
  // (g) matrix assembly
  assert.match(lab, /G\) assemble proof matrix/);
  assert.match(lab, /GITHUB_STEP_SUMMARY/);
  assert.match(lab, /upload-artifact@v4/);
});

test('autologin-lab: fail-closed cells (throws, not cosmetic logs)', () => {
  const throws = lab.match(/throw /g) || [];
  assert.ok(throws.length >= 12, `expected >=12 hard failures, saw ${throws.length}`);
  // launcher exit code must be checked
  assert.match(lab, /launcher exit=\$code \(expected 0\)/);
  // prompts!=0 must fail the lab
  assert.match(lab, /prompts != 0/);
  // creds must be proven gated
  assert.match(lab, /creds leaked via ungated \/api\/config/);
});

test('autologin-lab: locks - no NLA weakening, exe launch, fixture-only creds', () => {
  assert.doesNotMatch(lab, /DisableCredSSP|Enable-WSMan|AllowUnencrypted|Set-ExecutionPolicy\s+Unrestricted/i);
  // launcher must be started as the compiled exe, never via PowerShell wrapper,
  // and waited on by PID only (Start-Process -Wait would hang on the mstsc child tree)
  assert.match(lab, /Start-Process -FilePath \$exe -ArgumentList \$uri -PassThru/);
  assert.doesNotMatch(lab, /Start-Process -FilePath \$exe -ArgumentList \$uri -Wait/);
  assert.match(lab, /\$p\.WaitForExit\(30000\)/);
  assert.match(lab, /\$p2\.WaitForExit\(20000\)/);
  // every /pass: usage is the documented synthetic fixture
  for (const line of lab.split('\n')) {
    if (line.includes('/pass:')) {
      assert.match(line, /Lab-Fixture-Passw0rd!/);
    }
  }
  assert.doesNotMatch(lab, /tskey-[A-Za-z0-9]/); // no literal tailscale keys
  assert.doesNotMatch(lab, /ghrdp:\/\/[^\s"']*[?&]pass=/i); // no creds in URIs
  // no .rdp credential material asserted
  assert.doesNotMatch(lab, /Password\s*s:/);
});

test('autologin-lab: forbidden bookmark strings appear only inside guards', () => {
  const lines = lab.split('\n').filter((l) => /fmhy|megathread|torrent/i.test(l));
  assert.ok(lines.length >= 1, 'expected a guard against piracy bookmarks');
  for (const l of lines) {
    assert.match(l, /throw 'piracy-index bookmark present'/);
  }
});
