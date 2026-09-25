const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// [F9k] Fail-closed secrets framework contracts:
//  - main.yml Tailscale-up step: Emit-SecretHalt, classified reasons, keys
//    link, paired logs, redaction, NO interactive sign-in fallback, key value
//    never in a Write-Host line.
//  - cascade guards: one '# [F9k-guard]' per ghrdp-lib.ps1 dot-source.
//  - ui.html: second conditional yellow box for ts-authkey-missing/-invalid
//    with the clickable keys link + the 5 regeneration steps.
//  - ghrdp-server.ps1: /api/native-status exposes tsReason + tsAuthAdminUrl.
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const lines = wf.split('\n');
const tsStart = lines.findIndex(l => /^      - name: Tailscale up \(TS_AUTHKEY fail-closed/.test(l));
const tsEnd = lines.findIndex((l, i) => i > tsStart && /^      - name: Wait for Tailscale connected/.test(l));
assert.ok(tsStart > 0 && tsEnd > tsStart, 'fail-closed Tailscale up step not found');
const tsStep = lines.slice(tsStart, tsEnd).join('\n');
const KEYS = 'https://login.tailscale.com/admin/settings/keys';

test('Tailscale-up step carries the F9k halt framework', () => {
  assert.match(tsStep, /function Emit-SecretHalt/);
  assert.match(tsStep, /function ConvertTo-Redacted/);
  for (const r of ['ts-authkey-missing', 'ts-authkey-invalid', 'ts-authkey-ratelimited', 'ts-authkey-unknown']) {
    assert.ok(tsStep.includes(r), 'missing reason ' + r);
  }
  assert.ok(tsStep.includes(KEYS), 'admin keys URL missing');
  assert.match(tsStep, /::error::/);
  assert.match(tsStep, /GITHUB_STEP_SUMMARY|Add-Content -Path \$S/);
  assert.match(tsStep, /NotePropertyName tsReason/);
  // 5-step regeneration procedure (reusable key, 90 days, copy, set, re-dispatch)
  assert.match(tsStep, /Reusable = ON and Expiry = 90 days/);
  assert.match(tsStep, /Set repo secret TS_AUTHKEY/);
  assert.match(tsStep, /Re-dispatch/);
  // paired stdout/stderr log files
  assert.match(tsStep, /ts-up\.log/);
  assert.match(tsStep, /ts-up\.err/);
});

test('no interactive sign-in fallback and the raw key is never printed', () => {
  assert.doesNotMatch(tsStep, /SIGN-IN LINK|falling back to interactive|ts-up-manual/);
  for (const l of tsStep.split('\n')) {
    if (/Write-Host/.test(l)) {
      assert.ok(!/\$env:TS_AUTHKEY(?![\w])/.test(l.replace(/\$env:TS_AUTHKEY, \$env:VNC_PASS/, '')),
        'Write-Host line may not reference the key value: ' + l.trim());
    }
  }
  // classification follows the spec pattern sets
  assert.match(tsStep, /invalid\|expired\|revoked\|not a valid'\) \{ \$reason = 'ts-authkey-invalid'/);
  assert.match(tsStep, /rate\|limit'\) \{ \$reason = 'ts-authkey-ratelimited'/);
});

test('one # [F9k-guard] cascade guard per ghrdp-lib.ps1 dot-source', () => {
  const guards = wf.match(/# \[F9k-guard\]/g) || [];
  const dotsrc = wf.match(/\. \(Join-Path \$root 'ghrdp-lib\.ps1'\)/g) || [];
  assert.ok(dotsrc.length >= 1, 'expected at least one dot-source');
  assert.equal(guards.length, dotsrc.length, 'guard count must equal dot-source count');
  for (const l of lines) {
    if (l.includes("# [F9k-guard]") && !/ ::/.test(l)) assert.match(l, /^\s+# \[F9k-guard\] cascade guard/);
  }
});

test('launch-gates enforce the F9k additions', () => {
  const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
  assert.match(gates, /F9k secret-halt \+ cascade gates/);
  assert.match(gates, /admin\/settings\/keys/);
  assert.match(gates, /settings\/secrets\/actions/);
  assert.match(gates, /# \[F9k-guard\]/);
});

test('server exposes tsReason + tsAuthAdminUrl', () => {
  const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
  assert.match(srv, /tsReason = \$tsr/);
  assert.match(srv, /tsAuthAdminUrl = \$tsAdmin/);
  assert.match(srv, /login\.tailscale\.com\/admin\/settings\/keys/);
});

// ---- UI harness (same approach as webdesk-reasons.test.js) ----
const html = fs.readFileSync('payloads/ui.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const native = scripts.find(s => s.includes('async function nativeStatus()'));
const fqdn = 'vps.example.ts.net';
const SECRETS = 'https://github.com/dekarita/supreme-lamp/settings/secrets/actions';

function page(overrides = {}) {
  const items = new Map();
  const intervals = [];
  const node = id => {
    if (!items.has(id)) {
      items.set(id, {
        id, style: {}, textContent: '', innerHTML: '', disabled: true, checked: false, children: [],
        attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        appendChild(v) { this.children.push(v); }
      });
    }
    return items.get(id);
  };
  const status = {
    hostKind: 'ephemeral', fqdn, certBound: true, nlaOn: true,
    reasonsDisabled: [], advisory: [], probeReasons: {},
    webdeskUrl: 'https://vps.example.ts.net/vnc.html?autoconnect=1&resize=remote',
    webdeskReason: '', webdeskDetail: '', tsReason: '',
    tsAuthAdminUrl: KEYS,
    ...overrides
  };
  const document = {
    hidden: false, getElementById: node,
    createTextNode: textContent => ({ textContent }),
    createElement: () => ({ style: {}, textContent: '' }),
    addEventListener() {}, removeEventListener() {}
  };
  const window = { location: { hostname: fqdn, search: '?key=x', href: '' }, open() {}, addEventListener() {}, removeEventListener() {} };
  const fetch = async url => {
    if (url.includes('/api/config')) return { ok: true, json: async () => ({ creds: { fqdn, user: 'rdpuser', ip: '100.64.0.1' } }) };
    if (url.includes('/api/native-status')) return { ok: true, json: async () => status };
    return { ok: true, json: async () => ({ sha: 'sha' }) };
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.runInNewContext(native, {
    document, window, location: window.location, localStorage, fetch, URL,
    setInterval: fn => intervals.push(fn), setTimeout() {}, console
  }, { filename: 'ui-ts-framework.js' });
  return { node, intervals };
}

async function refresh(view) {
  await view.intervals[0]();
  await view.intervals[1]();
}

test('ts-authkey-missing: keys box with link + 5 regen steps shown', async () => {
  const view = page({ tsReason: 'ts-authkey-missing' });
  await refresh(view);
  const g = view.node('tsAuthGuidance');
  assert.equal(g.style.display, 'block');
  assert.match(g.innerHTML, /secret is missing/);
  assert.ok(g.innerHTML.includes(KEYS), 'box must link the admin keys page');
  assert.match(g.innerHTML, /Generate auth key/);
  assert.match(g.innerHTML, /90 days/);
  assert.match(g.innerHTML, /tskey-auth/);
  assert.ok(g.innerHTML.includes(SECRETS), 'box must link the secrets settings page');
  assert.match(g.innerHTML, /Re-dispatch/);
  assert.equal(view.node('tsAuthAdvisory').style.display, '');
  assert.match(view.node('tsAuthAdvisoryText').innerHTML, /<code>TS_AUTHKEY<\/code> secret missing/);
});

test('ts-authkey-invalid: diagnosed as rejected, not missing', async () => {
  const view = page({ tsReason: 'ts-authkey-invalid' });
  await refresh(view);
  const g = view.node('tsAuthGuidance');
  assert.equal(g.style.display, 'block');
  assert.match(g.innerHTML, /invalid, expired or revoked/);
  assert.doesNotMatch(g.innerHTML, /secret is missing\./);
  assert.ok(g.innerHTML.includes(KEYS));
});

test('ts-authkey value in webdeskReason also lights the box', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'ts-authkey-invalid', tsReason: '' });
  await refresh(view);
  assert.equal(view.node('tsAuthGuidance').style.display, 'block');
});

test('no tsReason: box hidden (and existing boxes unaffected)', async () => {
  const view = page();
  await refresh(view);
  assert.equal(view.node('tsAuthGuidance').style.display, 'none');
  assert.equal(view.node('tsAuthGuidance').innerHTML, '');
  assert.equal(view.node('tsAuthAdvisory').style.display, 'none');
  assert.equal(view.node('nrReady').textContent, 'WEB DESKTOP ready');
});

test('unrelated ts reasons (ratelimited/unknown) do not show the regen box', async () => {
  for (const r of ['ts-authkey-ratelimited', 'ts-authkey-unknown']) {
    const view = page({ tsReason: r });
    await refresh(view);
    assert.equal(view.node('tsAuthGuidance').style.display, 'none', r);
  }
});
