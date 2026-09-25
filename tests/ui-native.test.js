const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('payloads/ui.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const native = scripts.find(script => script.includes('async function nativeStatus()'));
const fqdn = 'vps.example.ts.net';
const rid = '0123456789abcdef0123456789abcdef';

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
        id, style: {}, textContent: '', disabled: true, checked: false, children: [],
        attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        appendChild(v) { this.children.push(v); }
      });
    }
    return items.get(id);
  };
  const status = {
    hostKind: 'vps', fqdn, certBound: true, nlaOn: true,
    reasonsDisabled: ['no-cmdkey-entry'], advisory: [], probeReasons: {},
    webdeskUrl: 'https://vps.example.ts.net/vnc.html?autoconnect=1',
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
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/api/config')) return { ok: true, json: async () => ({ creds: { fqdn, user: 'rdpuser', ip: '100.64.0.1' } }) };
    if (url.includes('/api/native-status')) return { ok: true, json: async () => status };
    if (url.includes('/api/rdp-token')) return { ok: true, json: async () => ({ rid, ttl: 60 }) };
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
  }, { filename: 'ui-native.js' });
  return { node, values, requests, status, opens, location, intervals };
}

async function refresh(view) {
  await view.intervals[0](); // config
  await view.intervals[1](); // status
}

test('all inline scripts parse; forbidden UI surfaces are absent', () => {
  assert.ok(native);
  for (const script of scripts) new vm.Script(script);
  assert.doesNotMatch(html, /enroll|agent[- ]?diag|\/api\/client-status|\/api\/agent|\/api\/enroll|showEnrollOverlay|agentPillPaint|LocalDevices|AuthenticationLevelOverride|__PASS__|ghrdp:\/\/.*pass=|install\.bat|install\.ps1|parsec-push/i);
  // [F12-1] execution tokens only (see tests/f10-autologin.test.js).
  assert.doesNotMatch(html, /powershell\.exe|-ExecutionPolicy|Invoke-Expression|-EncodedCommand|\bmshta\b|\bwscript\b|\bcscript\b/i);
  assert.match(html, /id="autoLoginNative"/);
  assert.match(html, /id="webdeskVncAdvisory"[\s\S]*?settings\/secrets\/actions/);
  assert.doesNotMatch(html, /ghrdp\.credSet/);
});

test('VPS: explicit cmdkey confirmation gates native click and bearer redemption', async () => {
  const view = page();
  await refresh(view);
  assert.equal(view.node('autoLoginNative').disabled, true);
  assert.equal(view.node('nrVpsShortcutRow').style.display, '');
  assert.equal(view.node('nrEphemeralRow').style.display, 'none');
  assert.match(view.node('cmdkeyLine').textContent, /cmdkey \/generic:TERMSRV\/vps\.example\.ts\.net \/user:rdpuser/);
  view.node('nrCmdkeyConfirmed').checked = true;
  view.node('nrCmdkeyConfirmed').onchange();
  await refresh(view);
  assert.equal(view.node('autoLoginNative').disabled, false);
  view.node('autoLoginNative').onclick({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const post = view.requests.find(req => req.url.includes('/api/rdp-token'));
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers.Authorization, 'Bearer dashboard-secret');
  assert.doesNotMatch(post.url, /key=|token=/);
  assert.equal(view.location.href, `ghrdp:connect?rid=${rid}`);
  view.node('nrCmdkeyConfirmed').checked = false;
  view.node('nrCmdkeyConfirmed').onchange();
  await refresh(view);
  assert.equal(view.node('autoLoginNative').disabled, true);
});

test('ephemeral: only web desktop opens; missing or unsafe URL disables it', async () => {
  const view = page({ hostKind: 'ephemeral', reasonsDisabled: [] });
  await refresh(view);
  assert.equal(view.node('nrVpsShortcutRow').style.display, 'none');
  assert.equal(view.node('autoLoginNative').disabled, true);
  assert.equal(view.node('btnWebDesk').disabled, false);
  view.node('btnWebDesk').onclick();
  assert.equal(view.opens[0][0], view.status.webdeskUrl);
  // [F11-2] the webdesk launch keeps window.opener: the noVNC cred shim
  // accepts the password handoff ONLY from the opener at the exact origin and
  // drops its own opener handle after the one handoff.
  assert.notEqual(view.opens[0][2], 'noopener');
  const absent = page({ hostKind: 'ephemeral', reasonsDisabled: [], webdeskUrl: '', webdeskReason: 'vnc-pass-missing' });
  await refresh(absent);
  assert.equal(absent.node('btnWebDesk').disabled, true);
  assert.equal(absent.node('webdeskVncAdvisory').style.display, '');
  const unsafe = page({ hostKind: 'ephemeral', reasonsDisabled: [], webdeskUrl: 'javascript:alert(1)' });
  await refresh(unsafe);
  assert.equal(unsafe.node('btnWebDesk').disabled, true);
  assert.notEqual(unsafe.node('nrReady').textContent, 'WEB DESKTOP ready');
});
