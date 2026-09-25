const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// [F9i] The web-desktop guidance must be keyed to the VERIFIED reason, never
// to an empty URL alone. Each reason gets its own honest text; 'serve-failed'
// must never read as 'VNC_PASS secret is missing'.
const html = fs.readFileSync('payloads/ui.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const native = scripts.find(script => script.includes('async function nativeStatus()'));
const fqdn = 'vps.example.ts.net';
const SECRETS = 'https://github.com/dekarita/supreme-lamp/settings/secrets/actions';

function page(overrides = {}) {
  const items = new Map();
  const values = new Map();
  const requests = [];
  const opens = [];
  const intervals = [];
  const location = { hostname: fqdn, search: '?key=dashboard-secret', href: '' };
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
    webdeskReason: '', webdeskDetail: '',
    ...overrides
  };
  const window = {
    location, open: (...args) => opens.push(args),
    addEventListener() {}, removeEventListener() {}
  };
  const document = {
    hidden: false, getElementById: node,
    createTextNode: textContent => ({ textContent }),
    createElement: () => ({ style: {}, textContent: '' }),
    addEventListener() {}, removeEventListener() {}
  };
  const fetch = async url => {
    requests.push({ url });
    if (url.includes('/api/config')) return { ok: true, json: async () => ({ creds: { fqdn, user: 'rdpuser', ip: '100.64.0.1' } }) };
    if (url.includes('/api/native-status')) return { ok: true, json: async () => status };
    return { ok: true, json: async () => ({ sha: 'sha' }) };
  };
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  vm.runInNewContext(native, {
    document, window, location, localStorage, fetch, URL, setInterval: fn => intervals.push(fn),
    setTimeout() {}, console
  }, { filename: 'ui-webdesk-reasons.js' });
  return { node, values, requests, status, opens, location, intervals };
}

async function refresh(view) {
  await view.intervals[0](); // config
  await view.intervals[1](); // status
}

test('valid URL: WEB DESKTOP enabled, all VNC_PASS guidance hidden', async () => {
  const view = page();
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, false);
  view.node('btnWebDesk').onclick();
  assert.equal(view.opens[0][0], view.status.webdeskUrl);
  assert.equal(view.node('nrReady').textContent, 'WEB DESKTOP ready');
  assert.equal(view.node('webdeskVncGuidance').style.display, 'none');
  assert.equal(view.node('webdeskVncGuidance').innerHTML, '');
  assert.equal(view.node('webdeskVncAdvisory').style.display, 'none');
});

test('vnc-pass-missing: secrets setup instructions shown', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'vnc-pass-missing' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, true);
  assert.equal(view.node('webdeskVncGuidance').style.display, 'block');
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.match(g, /VNC_PASS secret is missing/);
  assert.match(g, /New repository secret/);
  assert.ok(g.includes(SECRETS), 'guidance must link the secrets settings page');
  assert.equal(view.node('webdeskVncAdvisory').style.display, '');
  assert.match(view.node('webdeskVncAdvisoryText').innerHTML, /settings\/secrets\/actions/);
});

test('serve-failed: honest startup-failure guidance, NEVER missing-secret advice', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'serve-failed', webdeskDetail: 'websockify-bind' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, true);
  assert.equal(view.node('nrReady').textContent, 'web desktop not deployed: serve-failed');
  assert.equal(view.node('webdeskVncGuidance').style.display, 'block');
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /VNC_PASS secret is missing/);
  assert.doesNotMatch(g, /New repository secret/);
  assert.match(g, /NOT a missing VNC_PASS|will not fix this/i);
  assert.match(g, /Re-dispatch/);
  // the specific sub-cause code is mapped to human text
  assert.match(g, /tailnet address on 7333/);
  const a = view.node('webdeskVncAdvisoryText').innerHTML;
  assert.doesNotMatch(a, /New repository secret/);
  assert.match(a, /NOT a missing VNC_PASS/i);
});

test('serve-failed without detail: still honest, no fabricated sub-cause', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'serve-failed', webdeskDetail: '' });
  await refresh(view);
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /VNC_PASS secret is missing/);
  assert.doesNotMatch(g, /tightvnc-install|novnc-assets|websockify-bind|serve-mapping/);
  assert.match(g, /Re-dispatch/);
});

test('vnc-pass-too-short: diagnosed as present-but-short, not missing', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'vnc-pass-too-short' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, true);
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /VNC_PASS secret is missing/);
  assert.match(g, /IS set, but it is shorter than 8 characters/);
  assert.match(g, /edit it, and set a strong value/);
  assert.match(view.node('webdeskVncAdvisoryText').innerHTML, /present but shorter than 8 characters/);
  assert.match(view.node('webdeskVncAdvisoryText').innerHTML, /do not re-add/);
});

test('step-not-run: transient advisory, no secrets instructions (ephemeral)', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: '' });
  await refresh(view);
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /New repository secret/);
  assert.match(g, /has not completed for this run yet/);
});

test('step-not-run on VPS host: operator-deploy guidance, not secrets advice', async () => {
  const view = page({ hostKind: 'vps', fqdn, certBound: true, nlaOn: true, reasonsDisabled: ['no-cmdkey-entry'], webdeskUrl: '', webdeskReason: 'step-not-run' });
  await refresh(view);
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /New repository secret/);
  assert.match(g, /operator-deployed web desktop yet/);
});

test('config-stale: listener-gone message, no secrets advice', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'config-stale', webdeskDetail: 'listener-gone' });
  await refresh(view);
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /New repository secret/);
  assert.match(g, /no longer present/);
  assert.match(g, /Re-dispatch/);
});

test('invalid URL: button disabled, invalid-URL message, never ready', async () => {
  const view = page({ webdeskUrl: 'javascript:alert(1)', webdeskReason: '' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, true);
  assert.notEqual(view.node('nrReady').textContent, 'WEB DESKTOP ready');
  assert.equal(view.node('webdeskUrlVal').textContent, '(invalid URL)');
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /New repository secret/);
  assert.match(g, /not a valid tailnet URL/);
  assert.match(view.node('webdeskVncAdvisoryText').innerHTML, /failed validation/);
});

// [F9n] webdeskUrl acceptance allowlist - the transport is tailnet-HTTP
// websockify on <rdpIp>:7333; the legacy tailnet HTTPS *.ts.net shape stays
// accepted. Everything else (public host, other port, other scheme) is
// rejected client-side even when the server were to publish it.
test('tailnet-HTTP form is accepted and opens (F9n transport)', async () => {
  const url = 'http://100.71.2.3:7333/vnc.html?autoconnect=1&resize=remote';
  const view = page({ webdeskUrl: url, webdeskReason: '' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, false);
  assert.equal(view.node('nrReady').textContent, 'WEB DESKTOP ready');
  view.node('btnWebDesk').onclick();
  assert.equal(view.opens[0][0], url);
  assert.equal(view.opens[0][2], 'noopener');
  assert.equal(view.node('webdeskUrlVal').textContent, '100.71.2.3:7333');
  assert.equal(view.node('webdeskVncGuidance').style.display, 'none');
});

test('public host on 7333 is rejected (no public exposure)', async () => {
  const view = page({ webdeskUrl: 'http://203.0.113.9:7333/vnc.html?autoconnect=1', webdeskReason: '' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, true);
  assert.notEqual(view.node('nrReady').textContent, 'WEB DESKTOP ready');
  assert.equal(view.node('webdeskUrlVal').textContent, '(invalid URL)');
  assert.match(view.node('webdeskVncGuidance').innerHTML, /not a valid tailnet URL/);
});

test('non-100.64/10 tailnet-looking IP and wrong ports are rejected', async () => {
  for (const bad of ['http://10.0.0.5:7333/vnc.html', 'http://100.11.2.3:7333/vnc.html', 'http://100.71.2.3:8443/vnc.html', 'https://vps.example.ts.net:8443/vnc.html', 'http://100.71.2.3:7333@evil.example/vnc.html']) {
    const view = page({ webdeskUrl: bad, webdeskReason: '' });
    await refresh(view);
    assert.equal(view.node('btnWebDesk').disabled, true, 'must reject ' + bad);
    assert.notEqual(view.node('nrReady').textContent, 'WEB DESKTOP ready', 'must not claim ready for ' + bad);
  }
});

test('legacy tailnet HTTPS *.ts.net shape is still accepted', async () => {
  const view = page({ webdeskUrl: 'https://vps.example.ts.net/vnc.html?autoconnect=1&resize=remote', webdeskReason: '' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, false);
  assert.equal(view.node('nrReady').textContent, 'WEB DESKTOP ready');
});

test('F9n detail codes map to text: firewall-rule and tailnet-ip-unavailable', async () => {
  const fw = page({ webdeskUrl: '', webdeskReason: 'serve-failed', webdeskDetail: 'firewall-rule' });
  await refresh(fw);
  assert.match(fw.node('webdeskVncGuidance').innerHTML, /100\.64\.0\.0\/10/);
  assert.match(fw.node('webdeskVncGuidance').innerHTML, /TCP 7333/);
  const ip = page({ webdeskUrl: '', webdeskReason: 'serve-failed', webdeskDetail: 'tailnet-ip-unavailable' });
  await refresh(ip);
  assert.match(ip.node('webdeskVncGuidance').innerHTML, /config\.rdpIp holds no tailnet/);
  assert.doesNotMatch(ip.node('webdeskVncGuidance').innerHTML, /New repository secret/);
});

test('unknown reason: generic guidance, no fabricated missing-secret diagnosis', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'something-entirely-new' });
  await refresh(view);
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /VNC_PASS secret is missing/);
  assert.match(g, /no specific guidance/);
  assert.match(g, /re-dispatch/);
  const a = view.node('webdeskVncAdvisoryText').innerHTML;
  assert.match(a, /reason: something-entirely-new/);
});

test('unknown detail code: never interpolated, no XSS', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'serve-failed', webdeskDetail: '<img src=x onerror=alert(1)>' });
  await refresh(view);
  const g = view.node('webdeskVncGuidance').innerHTML;
  assert.doesNotMatch(g, /<img src=x/);
  assert.doesNotMatch(g, /onerror/);
});
