// [F10 s5] setup-time optimization contract: caches, event-waits, merged
// steps, Pages-deploy skip, and the backgrounded cert-bind + join ordering.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/main.yml'), 'utf8');

test('F10 s5: all four setup caches are wired (TightVNC, noVNC, cargo, pip)', () => {
  const cacheSteps = wf.match(/uses: actions\/cache@v4/g) || [];
  assert.ok(cacheSteps.length >= 4, `expected >=4 cache steps, got ${cacheSteps.length}`);
  assert.ok(wf.includes('path: .cache/tightvnc'));
  assert.ok(wf.includes('key: tightvnc-2.8.85-gpl-setup-64bit-msi'));
  assert.ok(wf.includes('path: .cache/novnc'));
  assert.ok(wf.includes('key: novnc-depth1-v1'));
  assert.ok(wf.includes('ghrdp-rust/target'));
  assert.ok(wf.includes('key: cargo-ghrdp-dash-'));
  assert.ok(wf.includes('~/AppData/Local/pip/Cache'));
  assert.ok(wf.includes('key: pip-cache-websockify-vncdotool'));
  // consumers must actually hit the caches
  assert.ok(wf.includes('TightVNC MSI cache hit'));
  assert.ok(wf.includes('noVNC cache hit'));
});

test('F10 s5: fixed setup sleeps became event-waits', () => {
  // Install step waits for the binary instead of sleeping 5s blind.
  assert.ok(wf.includes('exe present='),
    'Install Tailscale must event-wait for the installed binary');
  // Both F9b MagicDNS auto-enable reads poll for the ts.net name.
  const eventWaits = (wf.match(/instead of a fixed 5s sleep/g) || []).length;
  assert.ok(eventWaits >= 2, `expected >=2 F9b event-waits, got ${eventWaits}`);
  // The blind sleep directly after msiexec must be gone.
  assert.ok(!/Start-Process msiexec\.exe -Wait[^\n]*\n\s*Start-Sleep -Seconds 5/.test(wf),
    'msiexec still followed by a fixed 5s sleep');
});

test('F10 s5: adjacent steps merged, job start time preserved', () => {
  assert.ok(!wf.includes('- name: Record job start time'),
    'Record job start time must be merged into the auto-deploy step');
  assert.ok(wf.includes('JOB_STARTED_AT='), 'JOB_STARTED_AT write must survive the merge');
  assert.ok(wf.includes('- name: Write webdesk capture engine + webdesk UI (payloads → stage)'),
    'adjacent webdesk staging steps must be merged');
  assert.ok(!/- name: Write webdesk UI \(payloads → stage\)/.test(wf));
});

test('F10 s5: Pages deploy is skipped when docs content is unchanged', () => {
  assert.ok(wf.includes('pages deploy skipped - docs unchanged'),
    'Publish-StatusToGhPages must compare semantically and skip');
  assert.ok(wf.includes('$strip = @('), 'volatile-key strip list missing');
  for (const k of ["'ts'", "'runId'", "'speedBps'"]) {
    assert.ok(wf.includes(k), `volatile key ${k} missing from strip list`);
  }
});

test('F10 s5: cert bind backgrounds out and is joined before the dashboard', () => {
  assert.ok(wf.includes('cert-bind-bg.ps1'), 'detached cert-bind script missing');
  assert.ok(wf.includes('cert-bind.result.json'), 'cert-bind result file missing');
  const join = wf.indexOf('- name: Wait for background cert bind (event-wait)');
  const dash = wf.indexOf('- name: Start Mission Control dashboard EARLY');
  const cert = wf.indexOf('- name: Bind tailnet LE cert to RDP-Tcp (U5b)');
  assert.ok(cert >= 0 && join > cert, 'join step must come after the cert-bind launch');
  assert.ok(join >= 0 && dash > join, 'join step must come BEFORE the dashboard start');
  // Foreground still owns the F9a halt (fail-closed MagicDNS gate).
  const certStep = wf.slice(cert, wf.indexOf('- name: Optimize Tailscale path'));
  assert.ok(certStep.includes('MagicDNS is OFF - workflow halted by design'),
    'F9a halt must stay in the foreground cert-bind step');
  // The overlap window must include the web-desktop phases.
  const webdesk = wf.indexOf('- name: Web desktop (noVNC');
  assert.ok(webdesk > cert && webdesk < join,
    'web-desktop deploy must run while the background cert bind is in flight');
  // Soft failures keep pre-F10 semantics; only a missing result hard-fails.
  assert.ok(certStep.includes('background cert bind failed to start'));
  const joinStep = wf.slice(join, dash);
  assert.ok(joinStep.includes('produced no result'), 'join must fail closed on a missing result');
});
