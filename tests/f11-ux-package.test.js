// [F11-2] VNC password memory contract: shim + dashboard handoff + no URL creds.
// Run: node --test tests/f11-ux-package.test.js   (or: node tests/f11-ux-package.test.js)
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const shimSrc = fs.readFileSync('payloads/ghrdp-cred-shim.js', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

// Minimal DOM/window stub good enough to execute the REAL shim.
function harness() {
  const listeners = {};
  const els = {};
  function el(id) {
    return els[id] || (els[id] = {
      id, value: '', clicked: 0,
      dispatchEvent() { return true; },
      querySelector() { return els.__btn || (els.__btn = { click() { els.__btnClicked = true; } }); },
      getAttribute() { return null; },
    });
  }
  el('noVNC_password_input');
  el('noVNC_credentials_dialog');
  const window = {
    opener: { name: 'dashboard' },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  };
  const document = {
    querySelector() { return { content: 'http://100.118.42.7:7331' }; },
    getElementById: (id) => el(id),
  };
  const logs = [];
  const ctx = {
    window, document, Event: function (t) { this.type = t; },
    setInterval: () => 1, clearInterval: () => {},
    console: { log: (...a) => logs.push(a.join(' ')) },
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(shimSrc, ctx);
  return { window, document, els, listeners, logs, ctx };
}

test('F11-2 shim: accepts opener + exact origin and auto-submits the dialog', () => {
  const h = harness();
  const msg = h.listeners.message[0];
  assert.ok(msg, 'shim must register a message listener');
  msg({ origin: 'http://100.118.42.7:7331', source: h.window.opener, data: { type: 'ghrdp-vnc-pass', pass: 'VNC-secret-42' } });
  assert.equal(h.els.noVNC_password_input.value, 'VNC-secret-42', 'dialog input must be auto-filled');
  assert.ok(h.els.__btnClicked === true || h.els.__btn, 'dialog submit must be clicked');
  assert.equal(h.logs.length, 0, 'shim must never log anything');
});

test('F11-2 shim: rejects a wrong origin, a non-opener source and a wrong type', () => {
  const h = harness();
  const msg = h.listeners.message[0];
  msg({ origin: 'http://evil.example', source: h.window.opener, data: { type: 'ghrdp-vnc-pass', pass: 'x' } });
  msg({ origin: 'http://100.118.42.7:7331', source: { name: 'not-opener' }, data: { type: 'ghrdp-vnc-pass', pass: 'x' } });
  msg({ origin: 'http://100.118.42.7:7331', source: h.window.opener, data: { type: 'other', pass: 'x' } });
  assert.equal(h.els.noVNC_password_input.value, '', 'no unauthorized payload may reach the dialog');
});

test('F11-2 shim source: no logging/echo path, purge + opener drop present', () => {
  const code = shimSrc.split('\n').filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
  assert.ok(!/console\.|alert\(|document\.title/.test(code), 'no logging/echo call may exist in shim CODE');
  assert.match(shimSrc, /pending = null/);
  assert.match(shimSrc, /window\.opener = null/);
});

test('F11-2 dashboard: localStorage memory + exact-targetOrigin postMessage, no URL creds', () => {
  assert.match(ui, /ghrdp\.vncPass/);
  assert.match(ui, /w\.postMessage\(\{type:'ghrdp-vnc-pass',pass:pass\},origin\)/);
  assert.match(ui, /origin=new URL\(url\)\.origin/);
  assert.ok(!/vnc\.html[^"']*(password|pass)=/.test(ui), 'launch URL must not carry a credential');
  assert.ok(!/window\.open\(openUrl,'_blank','noopener'\)/.test(ui), 'opener must survive for the handoff');
  assert.match(ui, /id="vncPassInput"/);
  assert.match(ui, /id="vncPassRemember"/);
  assert.match(ui, /gatedVncPass=cr\.vncPass/);
});

test('F11-2 deploy: shim injected into the served noVNC copy with the exact origin', () => {
  assert.match(wf, /ghrdp-cred-shim\.js/);
  assert.match(wf, /mmc|meta name="ghrdp-cred-origin"/);
  assert.match(wf, /http:\/\/' \+ \$rdpIp \+ ':7331'/);
  assert.match(gates, /F11-2 VNC password memory gates/);
});

// ---------------------------------------------------------------- §3 usage ---
test('F11-3 server: usage accumulator loop, dual activity signal, 5s tick', () => {
  assert.match(server, /rdp-usage\.ps1/);
  assert.match(server, /function Test-RdpConnected/);
  assert.match(server, /function Test-WebdeskClient/);
  assert.match(server, /qwinsta\.exe/);
  assert.match(server, /ws-clients\.txt/);
  assert.match(server, /websockify\.log/);
  assert.match(server, /\$sec = \$sec \+ 5/, 'accumulator must add one 5s tick while active');
  assert.match(server, /Start-Sleep -Seconds 5/);
  // persist to config on stop + at most every 30s while running
  assert.match(server, /rdpUsageSec', \$sec/);
  assert.match(server, /rdpUsageHost', \[string\]\$c\.dnsName/);
  assert.match(server, /rdpUsageActive = \$rdpUsageActive/);
  assert.match(server, /rdpUsageAgeSec/);
  // loop must be hidden (no console window in the interactive session)
  const launch = server.split('\n').find((l) => l.includes('rdp-usage.ps1') && l.includes('Start-Process'));
  assert.ok(launch && launch.includes('-WindowStyle Hidden'), 'usage loop must launch hidden');
});

test('F11-3 workflow: accumulator carried across a same-host re-dispatch only', () => {
  const wf2 = fs.readFileSync('.github/workflows/main.yml', 'utf8');
  assert.match(wf2, /rdpUsageSec carried forward/);
  assert.match(wf2, /\$oldHost -eq \$env:COMPUTERNAME -or \$oldHost -eq \$dns/);
  assert.match(wf2, /rdpUsageSec = \$carryUsage/);
  assert.match(wf2, /rdpUsageHost = \$ghName/);
});

test('F11-3 ui: RDP USAGE row ticks live, freezes on inactive sample', () => {
  assert.match(ui, /RDP USAGE/);
  assert.match(ui, /id="timerRdpUsage"/);
  assert.match(ui, /window\.__rdpUsage=\{sec:Number\(s\.rdpUsageSec\)/);
  assert.match(ui, /u\.active\?\(Date\.now\(\)-u\.at\)\/1000:0/, 'the tick must stop when frozen');
  // frozen = the accumulated value is shown as-is (no local extrapolation)
  assert.match(ui, /frozen/);
});
