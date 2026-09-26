// [F23] FIX THE CIPHER-PROBE BUG THAT HALTS EVERY RUN.
// Run: node --test tests/f23-cipher-probe.test.js
//
// Ground truth (2026-09-26 run): F21 passed NLA=1/cert/credssp but
// `Get-TlsCipherSuite | Select-Object -ExpandProperty Name` threw
// "Property 'Name' cannot be found" (pwsh7 object-shape quirk) => empty
// $suites => FALSE schannel-cipher-weak => the whole run halted on a healthy
// host. The fix is a 3-layer probe: L1 cmdlet per-object Name extraction
// (direct property / PSObject bag / Format-List parse), L2 registry Functions
// fallback, L3 BOTH-empty => PROBE failure => ::warning:: +
// credsspStatus='ok-with-cipher-warn' + proceed (NEVER throw). A real weak
// config (suites enumerated, zero AES_256_GCM/CHACHA20_POLY1305) still throws.
//
// These tests (1) pin the shipped main.yml/ui.html structure and (2) run a
// faithful JS mirror of the shipped decision ladder against fixtures:
// objects WITHOUT a readable Name => extractor [] => warn path chosen;
// weak-only suites => throw path chosen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');

function f21Step(src) {
  const lines = src.split('\n');
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && /name: CredSSP\/NLA handshake verification.*F21/.test(lines[i])) { start = i; continue; }
    if (start >= 0 && /^      - name: /.test(lines[i])) { end = i; break; }
  }
  assert.ok(start > 0, 'F21 verification step not found');
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

// cipher branch = section (4) up to the NLA reassert comment
function cipherBranch(step) {
  const body = step.split('# (4) Schannel cipher suites')[1];
  assert.ok(body, 'cipher section (4) not found');
  return body.split('# NLA reassert')[0];
}

// L3 probe-failure block, delimited by the F23 markers
function l3Block(step) {
  const body = step.split('[F23 L3 probe-failure begin]')[1];
  assert.ok(body, 'L3 probe-failure begin marker not found');
  return body.split('[F23 L3 probe-failure end]')[0];
}

// ---------------------------------------------------------------------------
// Faithful JS mirror of the shipped 3-layer probe + verdict ladder.
// Fixture shape mirrors pwsh objects: .Name may be absent/throwing (the quirk),
// __psprops mirrors PSObject.Properties, __formatList mirrors Format-List text.
// ---------------------------------------------------------------------------
function extractNamesL1(objects) {
  const out = [];
  for (const o of objects) {
    let nm = '';
    // (a) direct property read, guarded: try { if ($null -ne $o.Name) ... } catch { }
    try { if (o && o.Name != null && String(o.Name) !== '') nm = String(o.Name); } catch { /* quirk */ }
    // (b) $o.PSObject.Properties['Name'].Value
    if (!nm && o && o.__psprops && Object.prototype.hasOwnProperty.call(o.__psprops, 'Name') && o.__psprops.Name != null) nm = String(o.__psprops.Name);
    // (c) Format-List parse: a 'Name : <value>' line
    if (!nm && o && typeof o.__formatList === 'string') {
      for (const ln of o.__formatList.split(/\r?\n/)) {
        const m = ln.match(/^\s*Name\s*:\s*(\S.*?)\s*$/);
        if (m) { nm = m[1]; break; }
      }
    }
    if (nm) out.push(nm);
  }
  return out;
}

function cipherProbe({ cmdletObjects = [], registryFunctions = [] }) {
  // L1: cmdlet enumeration
  let suites = extractNamesL1(cmdletObjects);
  // L2: registry fallback - Functions values (REG_MULTI_SZ array or one
  // comma-joined string), split on ',' exactly like the shipped probe.
  if (suites.length === 0) {
    for (const fn of registryFunctions) {
      const toks = [fn].flat().join(',').split(',').map(x => x.trim()).filter(Boolean);
      if (toks.length > 0) { suites = toks; break; }
    }
  }
  // L3: BOTH empty => PROBE failure => warn, never throw
  if (suites.length === 0) return { verdict: 'warn', status: 'ok-with-cipher-warn', detail: 'cipher-probe-failed' };
  const strong = suites.filter(s => /AES_256_GCM|CHACHA20_POLY1305/.test(s));
  if (strong.length > 0) return { verdict: 'ok', suites: strong };
  return { verdict: 'throw', reason: 'schannel-cipher-weak', suites };
}

// the pwsh7 quirk, as fixtures: Name absent, Name getter throws, PSObject bag
// without Name, Format-List text without a Name line - ALL yield no token.
const quirkyObjects = [
  { Enabled: true },
  { get Name() { throw new Error("Property 'Name' cannot be found"); }, Enabled: true },
  { __psprops: { Enabled: true }, __formatList: '\nEnabled : True\n\n' },
];

test('F23-1 probe-failure path: fixtures WITHOUT a readable Name => extractor [] => WARN chosen, never throw', () => {
  // --- mirror: L1 extractor returns [] on the quirk fixtures ----------------
  assert.deepEqual(extractNamesL1(quirkyObjects), [], 'extractor must return [] when no Name is readable');
  // L1 empty + registry empty => L3 warn (the 2026-09-26 false-halt scenario)
  const warned = cipherProbe({ cmdletObjects: quirkyObjects, registryFunctions: [] });
  assert.equal(warned.verdict, 'warn');
  assert.equal(warned.status, 'ok-with-cipher-warn');
  assert.equal(warned.detail, 'cipher-probe-failed');
  assert.notEqual(warned.verdict, 'throw', 'a probe failure is NOT a weak-config verdict');
  // L1 empty + registry NON-empty => L2 rescues the probe (no warn, no throw)
  const rescued = cipherProbe({ cmdletObjects: quirkyObjects, registryFunctions: [['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_RSA_WITH_3DES_EDE_CBC_SHA']] });
  assert.equal(rescued.verdict, 'ok', 'registry Functions fallback must rescue an empty L1');

  // --- shipped main.yml: the 3-layer structure is really there --------------
  const step = f21Step(wf);
  const cipher = cipherBranch(step);
  // L1: cmdlet with all three Name-read strategies
  assert.match(cipher, /foreach \(\$o in @\(Get-TlsCipherSuite -ErrorAction Stop\)\)/, 'L1 must enumerate cmdlet objects per-object');
  assert.match(cipher, /try \{ if \(\$null -ne \$o\.Name\) \{ \$nm = \[string\]\$o\.Name \} \} catch \{ \}/, 'L1(a) direct property read in try/catch missing');
  assert.match(cipher, /\$o\.PSObject\.Properties\['Name'\]/, 'L1(b) PSObject bag read missing');
  assert.match(cipher, /Format-List \| Out-String\) -split/, 'L1(c) Format-List parse missing');
  // the brittle one-liner that caused the false halt must be GONE from the repo
  assert.ok(!wf.includes('Get-TlsCipherSuite -ErrorAction Stop | Select-Object -ExpandProperty Name'), 'brittle ExpandProperty one-liner survived');
  // L2: registry fallback with BOTH keys, Functions value, comma split
  assert.ok(cipher.includes('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Cryptography\\Configuration\\Local\\SSL\\00010002'), 'L2 local SSL key missing');
  assert.ok(cipher.includes('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Cryptography\\Configuration\\SSL\\00010002'), 'L2 policy SSL key missing');
  assert.ok(cipher.includes("-Name 'Functions'"), 'L2 must read the Functions value');
  assert.ok(cipher.includes("-split ','"), 'L2 must split Functions on comma');
  // L3: warn + stamp, and the probe-failure block contains NEITHER throw NOR failReasons
  const l3 = l3Block(step);
  assert.ok(l3.includes('::warning::[F21] cipher probe could not enumerate (cmdlet+registry failed); Windows defaults include AES-256-GCM; proceeding with warning'), 'exact ::warning:: text missing');
  assert.ok(l3.includes("Write-CredsspStatus -Status 'ok-with-cipher-warn' -Detail 'cipher-probe-failed'"), 'L3 must stamp ok-with-cipher-warn/cipher-probe-failed');
  assert.ok(!l3.includes('throw'), 'probe-failure path must NOT throw');
  assert.ok(!l3.includes('failReasons +='), 'probe-failure path must NOT add a failReason');
  // the all-clear path re-stamps the warn status (never downgrades to plain ok)
  const okPath = step.split('if ($failReasons.Count -eq 0) {')[1].split('exit 0')[0];
  assert.ok(okPath.includes('$cipherProbeFailed'), 'success path must branch on the probe-failure flag');
  assert.ok(okPath.includes("Write-CredsspStatus -Status 'ok-with-cipher-warn' -Detail 'cipher-probe-failed'"), 'success path must stamp ok-with-cipher-warn when the probe failed');

  // --- shipped ui.html: warn status renders OK and never blocks AUTO-LOGIN --
  assert.ok(ui.includes("cs==='ok-with-cipher-warn'"), 'status row must accept ok-with-cipher-warn');
  assert.ok(ui.includes('OK (cipher probe warn)'), 'status row must render OK (cipher probe warn)');
  assert.ok(ui.includes("rl.credsspStatus==='ok-with-cipher-warn'"), 'AUTO-LOGIN/listener gates must accept ok-with-cipher-warn');
  assert.ok(ui.includes('window.__listenerOk=!!(rl&&rl.listening===true&&rl.fwRule===true&&rl.certOk===true&&rl.nla===true&&credsspOk)'), '__listenerOk contract unchanged');
});

test('F23-2 weak-only fixtures => THROW path chosen; strong suites => ok; determinants unchanged', () => {
  // --- mirror: suites enumerated, zero strong => throw verdict --------------
  const weakOnly = [
    { Name: 'TLS_RSA_WITH_AES_128_CBC_SHA256' },
    { Name: 'TLS_RSA_WITH_AES_256_CBC_SHA' },   // AES_256_CBC, NOT AES_256_GCM
    { Name: 'TLS_RSA_WITH_3DES_EDE_CBC_SHA' },
  ];
  const weak = cipherProbe({ cmdletObjects: weakOnly });
  assert.equal(weak.verdict, 'throw', 'enumerated-but-weak suites must choose the throw path');
  assert.equal(weak.reason, 'schannel-cipher-weak');
  // registry-only enumeration is judged the same way (L2 tokens, zero strong)
  const weakReg = cipherProbe({ cmdletObjects: quirkyObjects, registryFunctions: ['TLS_RSA_WITH_AES_256_CBC_SHA,TLS_RSA_WITH_3DES_EDE_CBC_SHA'] });
  assert.equal(weakReg.verdict, 'throw', 'a weak registry Functions list must also throw');
  // strong suites => ok (both GCM and ChaCha20 recognized)
  const strong = cipherProbe({ cmdletObjects: [{ Name: 'TLS_AES_128_GCM_SHA256' }, { Name: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384' }] });
  assert.equal(strong.verdict, 'ok');
  const chacha = cipherProbe({ cmdletObjects: [{ __psprops: { Name: 'TLS_CHACHA20_POLY1305_SHA256' } }] });
  assert.equal(chacha.verdict, 'ok', 'PSObject-bag Name read must feed the strong check');
  const flParsed = cipherProbe({ cmdletObjects: [{ __formatList: '\nName : TLS_AES_256_GCM_SHA384\nEnabled : True\n\n' }] });
  assert.equal(flParsed.verdict, 'ok', 'Format-List parsed Name must feed the strong check');

  // --- shipped main.yml: the weak verdict still feeds failReasons => throw --
  const step = f21Step(wf);
  const cipher = cipherBranch(step);
  assert.ok(cipher.includes("failReasons += ('schannel-cipher-weak"), 'weak-config verdict must still feed failReasons');
  assert.ok(cipher.includes("'AES_256_GCM|CHACHA20_POLY1305'"), 'strong-suite match pattern missing');
  assert.match(step, /throw \('F21 CredSSP\/NLA loud-fail: ' \+ \$failText\)/, 'the loud-fail throw must remain for real failures');
  // handshake determinants stay loud-fail (unchanged by F23)
  for (const tok of ["failReasons += ('nla-off", "failReasons += ('cert-untrusted", "failReasons += ('credssp-policy-mismatch"]) {
    assert.ok(step.includes(tok), 'determinant no longer feeds failReasons: ' + tok);
  }
});
