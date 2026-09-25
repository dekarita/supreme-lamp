// [F11] FINAL UX package: PS-free auto-login (§1 carried over), VNC password
// memory (§2), usage timer (§3), connectivity row (§4), runner provisioning
// gates (§5), setup caching (§6). Run: node tests/f11-ux.test.js
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const shim = fs.readFileSync('payloads/ghrdp-cred-shim.js', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');

// qBittorrent is a required plain app (§5.2); its product name legitimately
// contains the banned substring - strip it before any piracy-index scan.
const strip = (t) => t.replace(/qbittorrent/gi, '');
const shimCode = shim.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ---------------------------------------------------------------- §2 shim ---
test('F11 §2 shim: strict origin/opener gate, real noVNC dialog IDs, zero exfiltration', () => {
  for (const tok of [
    '__GHRDP_DASH_ORIGIN__', 'ghrdp-vnc-pass', 'ghrdp-cred-shim-ready',
    'ghrdp-vnc-pass-ok', 'ghrdp-vnc-pass-store',
    'noVNC_credentials_dlg', 'noVNC_password_input', 'noVNC_credentials_button',
    'ev.source !== host', 'ev.origin !== target',
    '7331',
  ]) assert.ok(shim.includes(tok), 'shim missing ' + tok);
  // client-side only: no logging, no storage, no network exfiltration channels
  assert.ok(!/console\.|fetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/.test(shimCode),
    'shim must never log, store, or transmit the value outside postMessage');
  // never a wildcard targetOrigin
  assert.ok(!/postMessage\([\s\S]{0,200},\s*['"]\*['"]\)/.test(shimCode), 'wildcard targetOrigin');
  // purge-on-unload
  assert.match(shimCode, /pagehide/);
});

test('F11 §2 deploy: shim copied into served noVNC + tailnet origin stamped', () => {
  assert.ok(wf.includes("payloads\\ghrdp-cred-shim.js"), 'shim not deployed from payloads');
  assert.ok(wf.includes('ghrdp-cred-shim.js'), 'shim filename missing in deploy');
  assert.match(wf, /window\.__GHRDP_DASH_ORIGIN__/);
  assert.match(wf, /':7331'/, 'stamped origin must be http://<tailnet-ip>:7331');
  assert.match(wf, /\$wantOrigin = 'http:\/\/' \+ \$rdpIp \+ ':7331'/);
  assert.ok(fs.existsSync('payloads/ghrdp-cred-shim.js'));
});

test('F11 §2 ui: no password in any launch URL; memory via localStorage + exact-origin postMessage', () => {
  // Gate: no noVNC launch URL may carry the password (query or fragment).
  assert.ok(!/password=/i.test(ui), 'ui.html must never build a URL with password=');
  for (const [name, text] of [['main.yml', wf], ['ui.html', ui]]) {
    for (const line of text.split('\n')) {
      if (/vnc\.html/i.test(line) && /password=/i.test(line)) {
        assert.fail(name + ' launch URL carries password=: ' + line.trim().slice(0, 160));
      }
    }
  }
  assert.match(ui, /u2\.search='autoconnect=true&compression=6'/);
  // remembered value lives only in localStorage, delivered via postMessage
  assert.match(ui, /VNC_STORE_KEY='ghrdp:vncPass'/);
  assert.match(ui, /localStorage\.setItem\(VNC_STORE_KEY/);
  assert.match(ui, /postMessage\(\{type:'ghrdp-vnc-pass',pass:pass\},st\.origin\)/);
  assert.match(ui, /window\.open\(openUrl,'ghrdp-webdesk'\)/); // NO noopener - shim needs opener
  assert.match(ui, /rememberVncPassFromKey/); // copy-from-KEYS-row path
  assert.match(ui, /ghrdp-cred-shim-ready/);  // ready handshake
  // input is never rendered into the page
  assert.ok(!/id="vncPassInput"|innerHTML[^;]*vncPass/.test(ui));
});

// --------------------------------------------------------------- §3 timer ---
test('F11 §3 server: usage accumulator ticks only while active, freezes, persists', () => {
  assert.match(server, /rdp-usage\.json/);
  assert.match(server, /rdpUsageSec/);
  assert.match(server, /rdpUsageActive/);
  // (a) RDP: LogonType-10 session AND an Active rdp-tcp# session (disconnect freezes)
  assert.match(server, /LogonType=10/);
  assert.match(server, /qwinsta/);
  assert.match(server, /rdp-tcp#/);
  assert.match(server, /\\bActive\\b/);
  // (b) websockify: >=1 established client on 7333
  assert.match(server, /-LocalPort 7333 -State Established/);
  // single-instance guard (restarts must not double-count) + 5s tick
  assert.match(server, /Global\\GhrdpUsageLoop/);
  assert.match(server, /Start-Sleep -Seconds 5/);
  // persistence into config.json (survives same-host re-dispatch)
  assert.match(server, /rdpUsageSec -NotePropertyValue|Add-Member -NotePropertyName rdpUsageSec/);
  assert.match(server, /rdp-usage\.ps1/);
  // hidden launch (§5.3) for the loop
  assert.match(server, /rdp-usage\.ps1'\) -WindowStyle Hidden|'rdp-usage\.ps1'\)\s*-WindowStyle Hidden/);
});

test('F11 §3 native-status + workflow carry-forward + ui label/ticker', () => {
  assert.match(server, /rdpUsageSec = \$rdpUsageSec/);
  assert.match(server, /rdpUsageActive = \$rdpUsageActive/);
  assert.match(wf, /\$prevUsage = 0/, 'stage step must read the previous accumulator');
  assert.match(wf, /rdpUsageSec = \$prevUsage/);
  // UI: "RDP USAGE" replaces logon age; ticker mirrors active/frozen state
  assert.match(ui, /RDP USAGE/);
  assert.ok(!ui.includes('RDP logon age'), 'logon-age label must be replaced');
  assert.match(ui, /window\.__rdpUsage=/);
  assert.match(ui, /b\.active\?b\.sec\+\(Date\.now\(\)-b\.at\)/);
  assert.ok(!/window\.__rdpLogon;if\(!b\)return;/.test(ui), 'old logon ticker must be gone');
  // F10 contract tokens stay (server may keep serving the legacy field)
  assert.match(ui, /rdpLogonAgeSec/);
  assert.match(ui, /window\.__rdpLogon/);
});

// ----------------------------------------------------------- §4 connectivity ---
test('F11 §4 CONNECTIVITY row shows pingMs + path + fps (srv badge moved off the usage row)', () => {
  const c2Line = ui.split('\n').find((l) => l.includes('c2Rtt') && l.includes('innerHTML'));
  assert.ok(c2Line, 'c2 Connectivity row template missing');
  assert.ok(c2Line.includes('c2Srv'), 'srv ping badge must live in the Connectivity row');
  assert.ok(c2Line.includes('c2Fps'), 'fps badge missing');
  assert.ok(c2Line.includes('c2Via'), 'path badge missing');
  const usageRow = ui.split('\n').find((l) => l.includes('RDP USAGE'));
  assert.ok(usageRow && !usageRow.includes('c2Srv'), 'usage row must not carry the ping badge');
  assert.match(ui, /srv '\+s\.pingMs/);          // server tailscale ping (15s loop)
  assert.match(ui, /UDP 41641/);                 // relay advisory
  assert.match(ui, /compression=6/);             // noVNC launch tuning
  assert.match(server, /Start-Sleep -Seconds 15/); // 15s tailscale ping loop
});

// ------------------------------------------------------------- §5 gates ------
test('F11 §5.1 piracy-index gate (main.yml + ui.html, qbittorrent stripped)', () => {
  assert.ok(!/fmhy|megathread|torrent/i.test(strip(wf)), 'piracy string in main.yml');
  assert.ok(!/fmhy|megathread|torrent/i.test(strip(ui)), 'piracy string in ui.html');
  // launch-gates carries the same gate and must scan BOTH files
  assert.match(gates, /fmhy\|megathread\|torrent/);
  assert.match(gates, /grep -v -i 'qbittorrent'/);
  assert.ok(gates.includes('payloads/ui.html'), 'gate must cover ui.html');
});

test('F11 §5.2 qBittorrent plain app (winget, cached, silent) + mirror stays OFF', () => {
  assert.match(wf, /winget\.exe download --id qBittorrent\.qBittorrent/);
  assert.match(wf, /winget\.exe install --id qBittorrent\.qBittorrent/); // fallback
  assert.match(wf, /ArgumentList '\/S' -Wait/, 'silent NSIS install');
  assert.match(wf, /qbittorrent\.exe/, 'presence check');
  assert.match(wf, /::notice title=qBittorrent::/);
  // installer cached via actions/cache workspace dir
  assert.ok(wf.includes('cache\\qbt-installer'));
  // mirror pipeline: default OFF, disabled publish stays disabled
  assert.ok(!/MIRROR_INPUT:\s*'true'/.test(wf), 'MIRROR_INPUT must never default true');
  assert.ok(!/^\s*mirror:\s*\n\s*default:\s*true/m.test(wf), 'mirror input default flipped ON');
  assert.match(wf, /\$mirrorOn = \(\$env:MIRROR_INPUT -eq 'true'\)/);
  assert.ok(wf.includes('mirror publish disabled per remediation'), 'publish disable token gone');
  assert.ok(wf.includes('mirror is OFF this run'), 'mirror OFF validation message gone');
});

test('F11 §5.3 every host helper launch is hidden/SYSTEM (no stray console windows)', () => {
  const files = ['.github/workflows/main.yml'];
  for (const f of fs.readdirSync('payloads')) if (f.endsWith('.ps1')) files.push('payloads/' + f);
  const allowed = /-WindowStyle Hidden|-NoNewWindow|pythonw|msiexec|mstsc|explorer\.exe|\$testUrl|http:\/\//;
  const violations = [];
  const taskViolations = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('#') || t.startsWith('//')) return;
      if (l.includes('Start-Process') && !allowed.test(l)) {
        violations.push(`${f}:${i + 1}: ${t.slice(0, 140)}`);
      }
      if (l.includes('New-ScheduledTaskAction') || l.includes('schtasks.exe /Create')) {
        const win = lines.slice(Math.max(0, i - 20), i + 21).join('\n');
        const ok = /-WindowStyle Hidden/.test(win) || /-UserId 'SYSTEM'/.test(win) || /\/RU SYSTEM/.test(win);
        if (!ok) taskViolations.push(`${f}:${i + 1}: ${t.slice(0, 140)}`);
      }
    });
  }
  assert.deepStrictEqual(violations, [], 'helper launches without a hidden/SYSTEM form:\n' + violations.join('\n'));
  assert.deepStrictEqual(taskViolations, [], 'scheduled tasks without hidden/SYSTEM form:\n' + taskViolations.join('\n'));
  // websockify specifically runs windowless (pythonw, GUI subsystem - no console)
  assert.match(wf, /Start-Process -FilePath pythonw -ArgumentList @\('-m','websockify'/);
  assert.match(wf, /Start-Process -FilePath pythonw -ArgumentList '-m','websockify'/);
  assert.ok(!/Start-Process -FilePath python -ArgumentList @\('-m','websockify'/.test(wf));
});

// -------------------------------------------------------------- §6 setup -----
test('F11 §6 setup caches: qBittorrent installer joins the F10 cache set, old keys restore', () => {
  assert.match(wf, /actions\/cache@v4/);
  assert.ok(wf.includes('key: f11-setup-${{ runner.os }}'));
  assert.ok(wf.includes('f10-setup-${{ runner.os }}-'), 'legacy F10 cache must stay restorable');
  for (const p of ['C:\\ghrdp\\cache', 'C:\\ghrdp\\novnc', 'pip\\Cache', 'ghrdp-rust\\target', 'cache\\qbt-installer']) {
    assert.ok(wf.includes(p), 'cache path missing: ' + p);
  }
});

// -------------------------------------------------------------- §7 lab -------
test('F11 §7 lab: autologin-lab carries the F11 proof cells + shim in trigger paths', () => {
  assert.match(lab, /ghrdp-cred-shim\.js/, 'lab must exercise the shim');
  assert.match(lab, /rdp-usage|usage timer/i, 'lab must measure the usage timer');
  assert.match(lab, /payloads\\ghrdp-cred-shim\.js/, 'shim file must be a push trigger');
  assert.match(lab, /payloads\\ui\.html/, 'ui.html must be a push trigger');
  assert.match(lab, /pythonw/, 'lab must prove the windowless websockify form');
  assert.match(lab, /qBittorrent/i, 'lab must prove qBittorrent present');
  assert.match(lab, /SHIM_RESULT/, 'shim postMessage auto-fill cell');
  assert.match(lab, /MainWindowHandle/, 'no-console-window cell');
});
