// [F15] Fail-visible launcher contract: no silent hangs, no silent crashes.
// Run: node --test tests/f15-fail-visible.test.js
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const installCmd = fs.readFileSync('payloads/install.cmd', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');

// executable lines only for the hidden-window / forbidden-config scans: the
// bans (and the omitted .rdp directives) may be NAMED in comments.
const code = launcher.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// Extract Main's body with a brace scan (strings in Main carry no braces).
function mainBody(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /private static int Main\(/.test(l));
  assert.ok(start > 0, 'Main not found');
  let depth = 0, seen = false, out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth > 0) seen = true;
    if (seen && depth === 0) break;
  }
  return out.join('\n');
}

test('F15-1 launcher: no hidden-window flag can ever wrap cmdkey or mstsc', () => {
  assert.ok(!/CreateNoWindow|WindowStyle\.Hidden/.test(code),
    'a hidden-window process flag survives in launcher code');
  // a naming comment may not sit next to the credential/client code either
  const lines = launcher.split('\n');
  for (let n = 0; n < lines.length; n++) {
    if (!/CreateNoWindow|WindowStyle\.Hidden/.test(lines[n])) continue;
    for (let i = Math.max(0, n - 4); i <= Math.min(lines.length - 1, n + 4); i++) {
      if (/cmdkey|mstsc/i.test(lines[i]) && !/^\s*\/\//.test(lines[i])) {
        assert.fail('hidden-window flag named adjacent to cmdkey/mstsc at line ' + (n + 1));
      }
    }
  }
  // the credential prompt and the client are launched VISIBLY.
  assert.match(code, /psi\.UseShellExecute = true;/);
  assert.match(code, /psi\.WindowStyle = ProcessWindowStyle\.Normal;/);
  assert.match(code, /psi\.WorkingDirectory = Environment\.SystemDirectory;/);
  assert.match(code, /CmdkeyTimeoutMs = 180000;/);
  assert.match(code, /WaitForExit\(waitMs\)/);
  assert.ok(code.includes('/pass\")'), 'the valueless /pass form must stay');
  assert.ok(!code.includes('/pass:'), 'cmdkey must never receive a password value');
  assert.match(code, /new ProcessStartInfo\("cmdkey\.exe", "\/list"\)/);
  assert.match(code, /msi\.WindowStyle = ProcessWindowStyle\.Normal;/);
  assert.match(code, /m\.WaitForExit\(2000\)/);
});

test('F15-1 Main: the invoked log line + beacon are the FIRST work in the process', () => {
  const main = mainBody(launcher);
  assert.match(main, /hello-before-work/);
  assert.match(main, /LogJson\("invoked"/);
  assert.match(main, /HelloBounded\(beaconHost, port, verb, true, "invoked"\)/);
  // [F15 §1.1+§7] the beacon host is the URL server arg CLAMPED to a *.ts.net
  // FQDN - pure string validation, so the beacon still precedes all work.
  assert.match(main, /string beaconHost = FqdnRe\.IsMatch\(server\) \? server : "";/);
  assert.match(main, /DoWork\(uri, verb, beaconHost, port\)/);
  const beacon = main.split('\n').findIndex((l) => l.includes('LogJson("invoked"'));
  const work = main.split('\n').findIndex((l) => /DoWork\(|CmdkeyStep\(|MstscStep\(|RunCheck\(|File\./.test(l));
  assert.ok(beacon > 0 && work > 0, 'beacon/work markers missing');
  assert.ok(beacon < work, 'cmdkey/mstsc/file work runs before the beacon');
  // the beacon POST target comes from the URL args and every failure is caught
  assert.match(launcher, /int DefaultPort = 7331;/);
  assert.match(launcher, /ParseQuery\(uri, out server, out user, out portRaw\)/);
  assert.match(launcher, /catch \{ \}/);
});

test('F15-1 global catch: one visible-surface primitive, logged before it shows', () => {
  const main = mainBody(launcher);
  assert.strictEqual((launcher.match(/MessageBox\.Show\(/g) || []).length, 1);
  assert.match(main, /catch \(Exception ex\)/);
  assert.match(main, /ShowBox\("ghrdp launcher error"/);
  assert.match(main, /ex\.GetType\(\)\.Name/);
  // every dialog is JSONL-logged BEFORE it is shown, and the only suppression
  // is the lab-named headless switch (production always shows the dialog).
  assert.match(launcher, /private static void ShowBox\(/);
  assert.match(launcher, /LogJson\("msgbox", "", title \+ " :: " \+ text\);/);
  assert.match(launcher, /GHRDP_LAB_NOMSG/);
  for (const m of launcher.match(/NOMSG/g) || []) assert.ok(m === 'NOMSG');
  assert.ok(!/NOMSG/.test(code.replace(/GHRDP_LAB_NOMSG/g, '')),
    'an unnamed headless dialog switch appeared');
  // every failure surface a user can hit is present with its own text
  for (const t of ['cmdkey prompt timed out', 'credential not stored', 'mstsc exited immediately',
                   'invalid target', 'unknown verb', 'ghrdp launcher check']) {
    assert.ok(launcher.includes(t), 'missing visible surface: ' + t);
  }
});

test('F15-1 log: %LOCALAPPDATA% JSONL with redaction, mstsc exit diagnosis', () => {
  assert.match(launcher, /ghrdp-launcher\.log/);
  assert.match(launcher, /File\.AppendAllText\(LogPath\(\)/);
  assert.match(launcher, /\[redacted\]/);
  assert.match(launcher, /mstsc-exited=/);
  assert.match(launcher, /TailLines\(5\)/);
  assert.match(launcher, /cmdkey-shown/);
  assert.match(launcher, /cmdkey-stored=/);
  assert.match(launcher, /mstsc-started pid=/);
  assert.match(launcher, /check-shown/);
  // telemetry stays bounded (F10-10 contract kept)
  assert.match(launcher, /t\.Join\(5000\)/);
  assert.match(launcher, /IsBackground = true/);
});

test('F15-2 install.cmd: ghrdp://check self test proves the exe runs at install time', () => {
  assert.match(installCmd, /start "" "%EXE%" "ghrdp:\/\/check"/);
  assert.match(installCmd, /if no MessageBox appeared, Defender or policy blocked the exe/i);
  assert.match(installCmd, /ghrdp-launcher\.log/);
  assert.match(installCmd, /MUST appear/);
});

test('F15-3 ui: beacon row, 45s stall verdict and [RUN CHECK]', () => {
  assert.match(ui, /id="winBeacon"/);
  assert.match(ui, /id="winBeaconStall"/);
  assert.match(ui, /BEACON_STALL_MS=45000/);
  assert.match(ui, /det==='invoked'/);
  assert.match(ui, /launcher stalled at: /);
  const BS = String.fromCharCode(92);
  assert.ok(ui.includes("LAUNCHER_LOG='%LOCALAPPDATA%" + BS + BS + 'ghrdp' + BS + BS + "ghrdp-launcher.log'"), 'the stall row must name the exact launcher log path');
  assert.match(ui, /id="btnRunCheck"/);
  assert.match(ui, /'ghrdp:\/\/check'/);
  // the row renders {verb, details, ok, age} from the last beacon
  assert.match(ui, /window\.__beacon=\{verb:s\.lastHandlerVerb\.verb,details:s\.lastHandlerVerb\.details,ok:s\.lastHandlerVerb\.ok,ts:hv\}/);
  assert.match(ui, /verb='\+\(b\.verb\|\|'\?'\)\+' details=/);
  assert.match(ui, /setInterval\(paintBeacon,1000\)/);
  // the F12-1 20s stale-registration watch is untouched
  assert.match(ui, /__helloWatchArmedAt/);
  assert.match(ui, /\},20000\);/);
});

test('F15-4 launch-gates carry the F15 block (and keep F10/F12/F14)', () => {
  assert.match(gates, /F15 fail-visible launcher gates/);
  assert.match(gates, /CreateNoWindow\|WindowStyle\\\.Hidden/);
  assert.match(gates, /hidden-window flag adjacent to cmdkey\/mstsc/);
  assert.match(gates, /hello-before-work/);
  assert.match(gates, /ShowBox\("ghrdp launcher error"/);
  assert.match(gates, /start "" "%EXE%" "ghrdp:\/\/check"/);
  assert.match(gates, /F15 gates PASS/);
  for (const kept of ['F10 gates PASS', 'F11-2 gates PASS', 'F12 gates PASS', 'F14 gates PASS']) {
    assert.ok(gates.includes(kept), 'an existing gate block disappeared: ' + kept);
  }
});

test('F15-5 lab: fail-visible cell asserts the REAL beacon sequence', () => {
  assert.match(lab, /P: fail-visible launcher \(beacon sequence, check verb, cmdkey timeout\)/);
  assert.match(lab, /handler-hello-listener\.py/);
  // [F17 §3] supersedes the plain 127.0.0.1 mapping: the launcher's DNS guard
  // requires the target to resolve into 100.64/10, so the lab maps the target
  // to a LOCAL tailnet-range address (and keeps 127.0.0.1 only for the
  // deliberately stale name the guard must block).
  assert.match(lab, /LAB_TARGET_FQDN/);
  assert.match(lab, /100\.64\.123\.45/);
  assert.match(lab, /127\.0\.0\.1 " \+ \$stale/);
  assert.match(lab, /GHRDP_LAB_CMDKEY_TIMEOUT_MS/);
  assert.match(lab, /P_result=pass/);
  assert.match(lab, /cmdkey-shown/);
  assert.match(lab, /mstsc-started pid=/);
  assert.match(lab, /msgbox/);
});
