// [F45 S4] Windows PowerShell 5.1 compatibility gate for the Explorer server core.
//
// Run: node --test tests/f45-s4-fx-ps51.test.js
//
// Why this file exists. The shipped server is executed by powershell.exe 5.1 on
// the operator host, and tests/f45-s4-fx-server.ps1 executes it for real on the
// Windows lane. Three consecutive CI runs failed there on 5.1-only behaviour
// that no Node-side audit had pinned, each costing a full Windows round trip:
//
//   1. a non-ASCII literal inside a BOM-less .ps1 is decoded as ANSI by 5.1, so
//      the Sinhala stable-id vector hashed to the wrong digest;
//   2. `$json | ConvertFrom-Json` sends a TOP-LEVEL JSON array through the
//      pipeline as a SINGLE object on 5.1, so a 6-vector fixture counted as 1
//      (PowerShell/PowerShell#3424 - only 7.x enumerates);
//   3. binding a read-only automatic variable throws before the function body
//      runs ("Cannot overwrite variable Host"), which is exactly what a
//      parameter or a `foreach` loop variable named $host/$Error does.
//
// Every rule below is mechanical, so the ubuntu lane catches the whole class in
// one second instead of three Windows runs. This is a static gate; the executed
// proof is tests/f45-s4-fx-server.ps1 (Windows lane) and the JS source contract
// is tests/f45-s4-fx-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const serverSrc = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const suiteSrc = fs.readFileSync('tests/f45-s4-fx-server.ps1', 'utf8');
const contractSrc = fs.readFileSync('src/tests/smoke/fx-server-contract.test.ts', 'utf8');
const fixtureSrc = fs.readFileSync('src/components/explorer/data/fixtures/stable-id-vectors.json', 'utf8');

const BEGIN = '# [F45 S4 fx-core-begin]';
const END = '# [F45 S4 fx-core-end]';
const beginAt = serverSrc.indexOf(BEGIN);
const endAt = serverSrc.indexOf(END, beginAt);
assert.ok(beginAt >= 0 && endAt > beginAt, 'the Explorer core region markers are missing');
const region = serverSrc.slice(beginAt, endAt);
const glue = serverSrc.slice(
  serverSrc.indexOf('# [F45 S4 fx-route-begin]'),
  serverSrc.indexOf('# [F45 S4 fx-route-end]')
);

// 5.1 automatic variables that are read-only when assigned, bound as a
// parameter, or used as a loop variable. `$null = <cmd>` is the repo's discard
// idiom, so $null is deliberately absent from this list.
const READ_ONLY = [
  'host', 'pid', 'error', 'pshome', 'home', 'shellid', 'executioncontext',
  'pwd', 'args', 'input', 'myinvocation', 'psboundparameters', 'psscriptroot',
  'pscommandpath', 'true', 'false', 'matches', 'psitem', 'psversiontable',
];

// Split PowerShell into "code with comments and literal bodies blanked out" plus
// the literal bodies themselves, so no scan below trips over prose or over a
// comment that quotes a forbidden construct. Offsets are preserved, so a hit
// still maps to its real line number.
function scan(text) {
  const code = text.split('');
  const strings = [];
  const blank = (from, to) => { for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      const nl = text.indexOf('\n', i);
      blank(i, nl < 0 ? text.length : nl);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === '@' && (text[i + 1] === "'" || text[i + 1] === '"')) {
      const term = '@' + text[i + 1];
      const close = text.indexOf(term, i + 2);
      const stop = close < 0 ? text.length : close;
      strings.push({ raw: text.slice(i + 2, stop), at: i, here: true });
      blank(i + 2, stop);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let body = '';
      while (j < text.length) {
        if (text[j] === '`' && c === '"') { body += text[j + 1] === undefined ? '' : text[j + 1]; j += 2; continue; }
        if (text[j] === c) {
          if (text[j + 1] === c) { body += c; j += 2; continue; }   // '' / "" escape
          break;
        }
        body += text[j];
        j += 1;
      }
      strings.push({ raw: body, at: i, here: false });
      blank(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return { code: code.join(''), strings };
}

const regionScan = scan(region);
const glueScan = scan(glue);
const suiteScan = scan(suiteSrc);

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// Declared parameter names of every param(...) block in the given code.
function paramNames(code) {
  const names = [];
  const re = /param\s*\(/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    for (const raw of code.slice(m.index + m[0].length, end).split(',')) {
      const nm = raw.split('=')[0].match(/\$([A-Za-z_][\w-]*)/);
      if (nm) names.push({ name: nm[1].toLowerCase(), at: m.index });
    }
    re.lastIndex = end;
  }
  return names;
}

function loopVariables(code) {
  const found = [];
  for (const m of code.matchAll(/foreach\s*\(\s*\$([A-Za-z_][\w-]*)\s+in\b/gi)) found.push({ name: m[1].toLowerCase(), at: m.index });
  for (const m of code.matchAll(/for\s*\(\s*\$([A-Za-z_][\w-]*)\s*=/gi)) found.push({ name: m[1].toLowerCase(), at: m.index });
  return found;
}

function assignments(code) {
  const found = [];
  for (const m of code.matchAll(/(^|[^\w$])\$([A-Za-z_][\w-]*)\s*(?:\+=|-=|\+\+|=)(?!=)/g)) found.push({ name: m[2].toLowerCase(), at: m.index + m[1].length });
  return found;
}

test('F45-S4-PS1-1 nothing in the Explorer server binds a 5.1 read-only automatic variable', () => {
  for (const [label, s] of [['the core region', regionScan], ['the route glue', glueScan]]) {
    const offenders = [
      ...paramNames(s.code).map((p) => ['parameter', p]),
      ...loopVariables(s.code).map((p) => ['loop variable', p]),
      ...assignments(s.code).map((p) => ['assignment', p]),
    ].filter(([, p]) => READ_ONLY.includes(p.name));
    assert.deepEqual(
      offenders.map(([kind, p]) => `${kind} $${p.name} at line ${lineOf(s.code, p.at)} in ${label}`),
      [],
      `${label} binds a variable Windows PowerShell 5.1 refuses to overwrite`
    );
  }
});

test('F45-S4-PS1-2 the two renamed parameters keep their 5.1-safe names everywhere', () => {
  // $Error and $Host cannot be bound, so New-FxErrorResponse declares -Message
  // and Add-FxUploadJobs declares -HostId. A stale CALL site fails at the call,
  // not at the declaration, so pin both directions (the call is what threw in
  // run 3, and a stale call in the route glue was found only by this audit).
  assert.match(region, /function New-FxErrorResponse \{[\s\S]*?param\([^)]*\$Message/, 'New-FxErrorResponse declares -Message');
  assert.match(region, /function Add-FxUploadJobs \{[\s\S]*?param\([^)]*\$HostId/, 'Add-FxUploadJobs declares -HostId');
  for (const [label, s] of [['region', regionScan], ['glue', glueScan], ['proof', suiteScan]]) {
    for (const stale of s.code.matchAll(/\B-Error\b(?!Action|Variable|Record)/g)) {
      assert.fail(`the ${label} still passes -Error (line ${lineOf(s.code, stale.index)}) - the parameter is -Message`);
    }
    for (const stale of s.code.matchAll(/\B-Host\b(?!Id|Name)\s/g)) {
      assert.fail(`the ${label} still passes -Host (line ${lineOf(s.code, stale.index)}) - the parameter is -HostId`);
    }
  }
  assert.ok((region + glue + suiteSrc).includes("-HostId 'gofile'"), 'the proof queues to gofile through -HostId');
});

test('F45-S4-PS1-3 the region uses no PowerShell-7-only syntax', () => {
  const code = regionScan.code + glueScan.code + suiteScan.code;
  const banned = [
    [/\?\?/, 'the null-coalescing operator ?? is PowerShell 7+'],
    [/-AsHashtable\b/, 'ConvertFrom-Json -AsHashtable is PowerShell 6+'],
    [/-AsArray\b/, 'ConvertTo-Json -AsArray is PowerShell 6+'],
    [/-Parallel\b/, 'ForEach-Object -Parallel is PowerShell 7+'],
    [/PSStyle/, '$PSStyle is PowerShell 7+'],
    [/Join-String\b/, 'Join-String is PowerShell 6.2+'],
    [/-AsByteStream\b/, 'Get-Content -AsByteStream is PowerShell 6+'],
    [/Test-Json\b/, 'Test-Json is PowerShell 6.1+'],
    [/System\.Text\.Json/, 'System.Text.Json is not in the .NET Framework the server runs on'],
    [/ToHexString\b/, '[Convert]::ToHexString is .NET 5+; the region builds hex by hand'],
    [/utf8NoBOM/, '-Encoding utf8NoBOM is PowerShell 6+; the region uses UTF8Encoding($false)'],
    [/\.Where\s*\(/, '.Where() is missing on PSCustomObject in 5.1; use Where-Object'],
    [/\.ForEach\s*\(/, '.ForEach() has the same 5.1 gap; use ForEach-Object'],
    [/Sort-Object[^\n]*-Stable/, 'Sort-Object -Stable is PowerShell 6+'],
  ];
  for (const [re, why] of banned) {
    const hit = code.match(re);
    assert.equal(hit, null, `${why} (found at line ${hit ? lineOf(code, code.indexOf(hit[0])) : '?'})`);
  }
  assert.ok(/New-Object System\.Text\.UTF8Encoding\(\$false\)|System\.Text\.UTF8Encoding\(\$false\)/.test(code), 'the no-BOM encoder is used');
  assert.ok(/SHA1\]::Create\(\)/.test(region), 'stable ids use SHA1.Create() (present on 5.1)');
});

test('F45-S4-PS1-4 the JSON reads cannot hit the 5.1 top-level-array trap', () => {
  // `$json | ConvertFrom-Json` hands a top-level array to the caller as ONE
  // object on 5.1. The proof therefore converts a VARIABLE (never a pipeline
  // member) and enumerates the array member explicitly.
  assert.equal(/\|\s*ConvertFrom-Json/.test(suiteScan.code), false, 'the proof must not pipe into ConvertFrom-Json');
  assert.ok(suiteSrc.includes('$vectorDoc = ConvertFrom-Json ([IO.File]::ReadAllText($vectorPath))'), 'the fixture is read as text and converted from a variable');
  assert.ok(suiteSrc.includes('$vectors = @($vectorDoc.vectors)'), 'the vectors array is enumerated explicitly');
  assert.ok(suiteSrc.includes('@($seenIds | Select-Object -Unique).Count -eq $vectors.Count'), 'the uniqueness check is array-wrapped');
});

test('F45-S4-PS1-5 the proof script is pure ASCII and so are the region literals', () => {
  // 5.1 decodes a BOM-less .ps1 as ANSI, so any non-ASCII inside a string is
  // mojibake before the script runs. Repo precedent allows non-ASCII in
  // COMMENTS; the executed proof is stricter and stays pure ASCII.
  assert.equal(Buffer.from(suiteSrc, 'utf8').some((b) => b > 0x7f), false, 'tests/f45-s4-fx-server.ps1 must stay ASCII');
  assert.notEqual(suiteSrc.charCodeAt(0), 0xfeff, 'the proof must not rely on a BOM');
  const badStrings = regionScan.strings.filter((s) => /[^\x00-\x7f]/.test(s.raw));
  assert.deepEqual(
    badStrings.map((s) => `line ${lineOf(region, s.at)}: ${s.raw.slice(0, 40)}`),
    [],
    'an Explorer string literal contains non-ASCII (5.1 would read it as ANSI)'
  );
  assert.notEqual(Buffer.from(serverSrc, 'utf8')[0], 0xef, 'the server file must not grow a BOM');
});

test('F45-S4-PS1-9 a stored timestamp is validated, never re-formatted', () => {
  // Re-formatting a stored ISO string (e.g. to 7 fractional digits) makes a
  // re-normalized document differ from its own input: the epoch fallback is
  // millisecond-precision, so migration stopped being idempotent and every read
  // of an untouched file rewrote its mtime. Only a real [datetime] is formatted.
  const m = region.match(/function ConvertTo-FxIso \{\n([\s\S]*?)\n\}/);
  assert.ok(m, 'ConvertTo-FxIso is defined in the region');
  const body = m[1];
  const from = body.indexOf('$s = [string]$Value');
  const to = body.indexOf('return $s');
  assert.ok(from > 0 && to > from, 'the string branch returns the stored text verbatim');
  assert.equal(/\.ToString\(/.test(body.slice(from, to)), false, 'a stored ISO string must not be re-formatted');
  assert.ok(/ToString\('o'\)/.test(body), 'a [datetime] value is still formatted');
});

test('F45-S4-PS1-8 array members are read through Get-FxRows, never through @(Get-FxMember ...)', () => {
  // PowerShell drops an EMPTY array on return, so `@(Get-FxMember $o 'roots')`
  // is a one-element array containing $null - a normalizer then fabricates a row
  // (this is what produced a phantom Temp root and broke migration idempotency).
  // Get-FxRows turns "missing or empty" into zero rows, and every call site must
  // keep the @() wrapper because a bare call would unroll a single row into a
  // scalar: that is why the wrapper is asserted here, not just the call.
  const code = regionScan.code + glueScan.code;
  const bareMember = [...code.matchAll(/(^|[^@])\(\s*Get-FxMember\s+[^\n]*'(?:files|roots|jobs|gofileHosts|entries)'/g)];
  assert.deepEqual(bareMember.map((m) => `@(Get-FxMember ...) at line ${lineOf(code, m.index)}`), [], 'array members must be read through Get-FxRows');
  const bareRows = [...code.matchAll(/(^|[^@])\(\s*Get-FxRows\b/g)];
  assert.deepEqual(bareRows.map((m) => `bare Get-FxRows at line ${lineOf(code, m.index)}`), [], 'every Get-FxRows call must be wrapped in @( )');
  assert.ok(code.includes('@(Get-FxRows '), 'the region still iterates its arrays');
  assert.match(region, /function Get-FxRows \{/, 'the helper exists in the region');
});

test('F45-S4-PS1-7 no property-syntax write adds a key to an ordered document', () => {
  // On 5.1, `$ordered.NewKey = 1` throws "The property cannot be found on this
  // object" while the indexer form adds it (PowerShell 7 allows both). Every
  // document the region writes - $out, $result, $summary - is an [ordered]
  // literal, so each dot-write must name a key that literal already declares.
  // The only dot-writes that are not documents are real .NET objects.
  const NET_OBJECTS = new Set(['client', 'fs', 'msg', 'stream', 'listener']);
  const inits = new Map();
  for (const m of region.matchAll(/\$([A-Za-z_]\w*)\s*=\s*\[ordered\]@\{/g)) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (; i < region.length; i++) {
      if (region[i] === '{') depth += 1;
      else if (region[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const keys = new Set([...region.slice(m.index, end).matchAll(/(?:^|[\s;{])([A-Za-z_]\w*)\s*=/g)].map((k) => k[1]));
    const seen = inits.get(m[1]) || new Set();
    for (const k of keys) seen.add(k);
    inits.set(m[1], seen);
  }
  const offenders = [];
  for (const s of [regionScan, glueScan]) {
    for (const m of s.code.matchAll(/\$([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=(?!=)/g)) {
      const [, variable, prop] = m;
      if (NET_OBJECTS.has(variable)) continue;
      const keys = inits.get(variable);
      if (!keys || !keys.has(prop)) offenders.push(`$${variable}.${prop} at line ${lineOf(s.code, m.index)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a dot-write would add a key to an ordered document, which Windows PowerShell 5.1 refuses'
  );
});

test('F45-S4-PS1-6 the shared vector fixture keeps the shape both runtimes read', () => {
  const doc = JSON.parse(fixtureSrc);
  assert.equal(Array.isArray(doc), false, 'the fixture root must be an object: a top-level array is the 5.1 trap');
  assert.equal(doc.schemaVersion, 1);
  const vectors = doc.vectors;
  assert.ok(Array.isArray(vectors) && vectors.length >= 5, 'the fixture carries at least five vectors');
  assert.ok(vectors.filter((v) => /[^\x00-\x7f]/.test(v.path)).length >= 2, 'at least two vectors are non-ASCII');
  const ids = new Set();
  for (const v of vectors) {
    const id = crypto.createHash('sha1').update(Buffer.from(v.root + v.path, 'utf8')).digest('hex');
    assert.equal(v.id, id, `${v.root}${v.path} must hash to its recorded id`);
    assert.equal(ids.has(v.id), false, 'ids are unique');
    ids.add(v.id);
  }
  // both runtimes must read THIS file: the Windows proof and the vitest contract
  assert.ok(suiteSrc.includes('stable-id-vectors.json'), 'the Windows proof reads the fixture');
  assert.ok(contractSrc.includes('stable-id-vectors.json'), 'the vitest contract reads the fixture');
});
