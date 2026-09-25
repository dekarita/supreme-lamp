const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// [F9o] TightVNC password-application ladder + real auth probe contracts:
//  L1 ALWAYS direct msiexec (mangler removed) with the full property list +
//     REINSTALL pair when the uninstall key exists.
//  L2 restart + SecurityTypes=VncAuth + Password blob length >= 8.
//  L3 vncdotool probe vs 127.0.0.1::5900 (exit 0 = verified), redacted.
//  L4 probe fail => uninstall + fresh msiexec + re-probe.
//  L5 still fail => LABELED degrade (WARNING + none-tailnet-only) or
//     fail-closed vnc-auth-unverifiable.
//  Self-test requires the mode-matching probe (vnc-auth verdict).
//  Server + UI expose webdeskAuth ('vnc' | 'none-tailnet-only').
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const lines = wf.split('\n');

function lineIndex(pred, from = 0) {
  for (let i = from; i < lines.length; i++) if (pred(lines[i])) return i;
  return -1;
}

const webdeskStart = lineIndex(l => /^      - name: Web desktop \(noVNC/.test(l));
const selftestStart = lineIndex(l => /^      - name: Web desktop self-test/.test(l));
const nextStepAfterSelftest = lineIndex(l => /^      - name: Start Mission Control/.test(l), selftestStart + 1);
assert.ok(webdeskStart > 0 && selftestStart > webdeskStart && nextStepAfterSelftest > selftestStart);
const webdesk = lines.slice(webdeskStart, selftestStart).join('\n');
const selftest = lines.slice(selftestStart, nextStepAfterSelftest).join('\n');
const webdeskCode = webdesk.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const selftestCode = selftest.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const WARN = 'VNC password gate could not be applied; access limited to tailnet firewall 100.64.0.0/10; rotate VNC_PASS and re-dispatch to restore the gate';

test('F9o L1: direct msiexec with the full property list; mangler removed', () => {
  assert.doesNotMatch(webdeskCode, /choco install tightvnc/);
  assert.ok(webdesk.includes('tightvnc-2.8.85-gpl-setup-64bit.msi'), 'MSI download missing');
  for (const prop of ['ADDLOCAL=Server', 'SERVER_REGISTER_AS_SERVICE=1', 'SERVER_ADD_FIREWALL_EXCEPTION=0',
    'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=1', 'SET_PASSWORD=1', 'VALUE_OF_PASSWORD=',
    'SET_USECONTROLAUTHENTICATION=1', 'VALUE_OF_USECONTROLAUTHENTICATION=1', 'SET_CONTROLPASSWORD=1', 'VALUE_OF_CONTROLPASSWORD=']) {
    assert.ok(webdesk.includes(prop), 'L1 property missing: ' + prop);
  }
  assert.ok(webdesk.includes('REINSTALL=Server'), 'REINSTALL=Server missing');
  assert.ok(webdesk.includes('REINSTALLMODE=omus'), 'REINSTALLMODE=omus missing');
  assert.match(webdesk, /DisplayName -like '\*TightVNC\*'/);
  assert.match(webdesk, /function Install-TightVncMsi/);
});

test('F9o L2: restart + SecurityTypes pin + Password blob verification', () => {
  assert.match(webdesk, /Restart-Service -Name 'tvnserver'/);
  assert.match(webdesk, /SecurityTypes' -Value 'VncAuth'/);
  assert.match(webdesk, /Password blob length=/);
  assert.match(webdesk, /\$pwdLen -ge 8/);
  assert.doesNotMatch(webdesk, /Write-Host.*\$pwdBlob[^.L]/);
});

test('F9o L3/L4: vncdotool auth probe with redaction + fresh-reinstall retry', () => {
  assert.match(webdesk, /pip install.*vncdotool/);
  assert.match(webdesk, /function Invoke-VncAuthProbe/);
  assert.ok(webdesk.includes('127.0.0.1::5900'), 'probe must target 127.0.0.1::5900');
  assert.ok(webdesk.includes("'capture'"), 'probe must capture a frame');
  assert.match(webdesk, /\.Replace\(\$Password, '\[redacted\]'\)/);
  assert.match(webdesk, /vnc-auth-probe tag=.*exit=/);
  assert.ok(webdesk.includes("Invoke-VncAuthProbe -Password $vp -Tag 'l3'"), 'L3 probe call missing');
  assert.ok(webdesk.includes('choco uninstall tightvnc'), 'L4 uninstall missing');
  assert.ok(webdesk.includes("Invoke-VncAuthProbe -Password $vp -Tag 'l4'"), 'L4 re-probe missing');
  assert.ok(webdesk.includes('-ForceFresh $true'), 'L4 must force a fresh plain-/i install');
});

test('F9o L5: labeled degrade (WARNING + stamp) or fail-closed unverifiable', () => {
  assert.ok(webdesk.includes(WARN), 'L5 WARNING string missing');
  assert.match(webdesk, /::warning::VNC password gate could not be applied/);
  assert.match(webdesk, /### WARNING: VNC password gate could not be applied/);
  assert.match(webdesk, /\$webdeskAuth = 'none-tailnet-only'/);
  assert.match(webdesk, /\$webdeskAuth = 'vnc'/);
  assert.ok(webdesk.includes("Invoke-VncAuthProbe -Password '' -Tag 'l5-none'"), 'L5 no-password probe missing');
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'vnc-auth-unverifiable'/);
  const failIdx = webdesk.indexOf("'vnc-auth-unverifiable'");
  assert.match(webdesk.slice(failIdx, failIdx + 300), /\bthrow\b/, 'unverifiable path must throw');
  assert.match(webdesk, /Set-WebdeskCfg \$webdeskUrl '' '' \$webdeskAuth/);
  assert.match(webdesk, /vncprobe-codes\.txt/);
  assert.match(webdesk, /tightvnc-tail\.txt/);
  assert.match(webdesk, /PasswordBlobLength=/);
});

test('F9o self-test: HTTP marker AND mode-matching VNC probe (vnc-auth verdict)', () => {
  assert.match(selftest, /VNC_PASS: \$\{\{ secrets\.VNC_PASS \}\}/);
  assert.match(selftest, /\$vpSelf = \[string\]\$env:VNC_PASS/);
  assert.match(selftest, /function Invoke-VncAuthProbe/);
  assert.ok(selftest.includes('127.0.0.1::5900'));
  assert.match(selftest, /webdeskAuth/);
  assert.match(selftest, /none-tailnet-only/);
  assert.ok(selftest.includes("$verdictOverride = 'vnc-auth'"), 'vnc-auth override missing');
  assert.ok(selftest.includes("$verdict = 'vnc-auth'"), 'vnc-auth verdict missing');
  assert.match(selftest, /selftest-vnc/);
  assert.match(selftest, /vncprobe-codes\.txt/);
  assert.match(selftest, /tightvnc-tail\.txt/);
  // PASS requires BOTH legs; FAIL text names both.
  assert.match(selftest, /noVNC marker \+ VNC probe exit 0/);
  assert.match(selftest, /HTTP marker \+ mode-matching VNC probe/);
});

test('F9o: the two Invoke-VncAuthProbe copies are byte-identical', () => {
  const copies = wf.match(/^          function Invoke-VncAuthProbe\(.*?^          \}\n/gms) || [];
  assert.equal(copies.length, 2, 'expected exactly two Invoke-VncAuthProbe copies');
  assert.equal(copies[0], copies[1], 'probe copies must be identical');
});

test('F9o server: native-status exposes allowlisted webdeskAuth', () => {
  const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
  assert.match(srv, /webdeskAuth = \$wda/);
  assert.match(srv, /'vnc', 'none-tailnet-only'/);
  assert.match(srv, /if \(-not \$wd\) \{ \$wda = '' \}/);
});

test('F9o UI: VNC auth mode row + degraded advisory + new detail text', () => {
  const ui = fs.readFileSync('payloads/ui.html', 'utf8');
  assert.match(ui, /VNC auth mode/);
  assert.match(ui, /id="webdeskAuthVal"/);
  assert.match(ui, /id="webdeskAuthAdvisory"/);
  assert.match(ui, /'vnc-auth-unverifiable':'VNC authentication could not be verified/);
  assert.ok(ui.includes(WARN), 'UI advisory must carry the rotate+re-dispatch instruction');
  // WEB DESKTOP button logic (F10-3): opens openUrl, which must be DERIVED
  // from the validated webdeskUrl and adds autoconnect+compression=6 (§2.3);
  // a non-root path passes through untouched.
  assert.match(ui, /var openUrl=webdeskUrl;/);
  assert.match(ui, /u2\.search='autoconnect=true&compression=6'/);
  // [F11 §2.2] opens a NAMED window (no noopener - the cred shim needs its
  // opener); the password is delivered by postMessage, never the URL.
  assert.match(ui, /window\.open\(openUrl,'ghrdp-webdesk'\)/);
});

test('F9o gates: launch-gates enforce the ladder', () => {
  const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
  assert.match(gates, /F9o TightVNC password-ladder gates/);
  assert.match(gates, /choco install tightvnc/);
  assert.match(gates, /REINSTALLMODE=omus/);
  assert.match(gates, /Invoke-VncAuthProbe/);
  assert.match(gates, /VNC password gate could not be applied/);
  assert.match(gates, /vnc-auth-unverifiable/);
  assert.match(gates, /VNC auth mode/);
});

// ---- UI behavior harness (same approach as webdesk-reasons.test.js) ----
const html = fs.readFileSync('payloads/ui.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const native = scripts.find(s => s.includes('async function nativeStatus()'));
const fqdn = 'vps.example.ts.net';
const tailUrl = 'http://100.89.1.7:7333/vnc.html?autoconnect=1&resize=remote';

function page(overrides = {}) {
  const items = new Map();
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
    webdeskUrl: tailUrl, webdeskReason: '', webdeskDetail: '', webdeskAuth: 'vnc',
    ...overrides
  };
  const window = { location: { hostname: fqdn, search: '?key=x', href: '' }, open() {}, addEventListener() {}, removeEventListener() {} };
  const document = {
    hidden: false, getElementById: node,
    createTextNode: textContent => ({ textContent }),
    createElement: () => ({ style: {}, textContent: '' }),
    addEventListener() {}, removeEventListener() {}
  };
  const fetch = async url => {
    if (url.includes('/api/config')) return { ok: true, json: async () => ({ creds: { fqdn, user: 'rdpuser', ip: '100.64.0.1' } }) };
    if (url.includes('/api/native-status')) return { ok: true, json: async () => status };
    return { ok: true, json: async () => ({ sha: 'sha' }) };
  };
  const intervals = [];
  vm.runInNewContext(native, {
    document, window, location: window.location, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch, URL, setInterval: fn => intervals.push(fn), setTimeout() {}, console
  }, { filename: 'ui-f9o-auth.js' });
  return { node, intervals };
}

async function refresh(view) {
  await view.intervals[0]();
  await view.intervals[1]();
}

test('F9o UI: vnc mode shows verified row, no advisory, button enabled', async () => {
  const view = page({ webdeskAuth: 'vnc' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, false);
  assert.match(view.node('webdeskAuthVal').textContent, /vnc \(password gate verified\)/);
  assert.equal(view.node('webdeskAuthAdvisory').style.display, 'none');
});

test('F9o UI: degraded mode shows yellow advisory with rotate+re-dispatch', async () => {
  const view = page({ webdeskAuth: 'none-tailnet-only' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, false, 'WEB DESKTOP stays enabled in degraded mode');
  assert.match(view.node('webdeskAuthVal').textContent, /none-tailnet-only/);
  assert.equal(view.node('webdeskAuthAdvisory').style.display, '');
  assert.ok(view.node('webdeskAuthAdvisoryText').textContent.includes('rotate VNC_PASS and re-dispatch'));
  assert.ok(view.node('webdeskAuthAdvisoryText').textContent.includes('100.64.0.0/10'));
});

test('F9o UI: no URL hides the advisory and marks auth not deployed', async () => {
  const view = page({ webdeskUrl: '', webdeskReason: 'serve-failed', webdeskDetail: 'vnc-auth-unverifiable', webdeskAuth: '' });
  await refresh(view);
  assert.equal(view.node('btnWebDesk').disabled, true);
  assert.equal(view.node('webdeskAuthAdvisory').style.display, 'none');
  assert.equal(view.node('webdeskAuthVal').textContent, '(not deployed)');
  assert.match(view.node('webdeskVncGuidance').innerHTML, /could not be verified in either mode/);
});
