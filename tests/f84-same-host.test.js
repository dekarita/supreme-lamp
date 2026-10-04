// [F84 §2.2] www/bare hostname tolerance. Pins the shipped Test-F78SameHost
// helper + every call site, and proves the cross-domain case is STILL refused
// by mirroring the shipped algorithm (strip ^www. on both sides, exact compare).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const START = SERVER.indexOf("if ($path -eq '/api/f58/sources' -or $path -eq '/api/lab/inspect')");
const END = SERVER.indexOf('# [remediation] C2 / agent-payload / .bat endpoints removed', START);
assert.ok(START > 0 && END > START, 'F78 block not found');
const BLOCK = SERVER.slice(START, END);

// The shipped rule, mirrored 1:1 (PowerShell `-replace '^www\.', ''` == JS).
const sameHost = (allowed, actual) => {
  const a = String(allowed).trim().toLowerCase().replace(/^www\./, '');
  const b = String(actual).trim().toLowerCase().replace(/^www\./, '');
  if (!a || !b) return false;
  return a === b;
};

test('F84-SAMEHOST: www and bare forms of one site are the same host', () => {
  assert.equal(sameHost('openculture.com', 'www.openculture.com'), true);
  assert.equal(sameHost('www.openculture.com', 'openculture.com'), true);
  assert.equal(sameHost('WWW.Openculture.COM', 'openculture.com'), true);
  assert.equal(sameHost('openculture.com', 'openculture.com'), true);
});

test('F84-SAMEHOST: a different domain is still refused (no suffix/wildcard match)', () => {
  assert.equal(sameHost('openculture.com', 'youtube.com'), false);
  assert.equal(sameHost('openculture.com', 'www.youtube.com'), false);
  assert.equal(sameHost('openculture.com', 'notopenculture.com'), false);
  assert.equal(sameHost('openculture.com', 'evil-openculture.com'), false);
  assert.equal(sameHost('', 'openculture.com'), false);
});

test('F84-SAMEHOST: the helper ships with the www-strip compare', () => {
  assert.ok(BLOCK.includes('function Test-F78SameHost'), 'Test-F78SameHost missing');
  assert.ok(BLOCK.includes("$a = ([string]$Allowed).Trim().ToLowerInvariant() -replace '^www\\.', ''"), 'allowed-side strip missing');
  assert.ok(BLOCK.includes("$b = ([string]$Actual).Trim().ToLowerInvariant() -replace '^www\\.', ''"), 'actual-side strip missing');
  assert.ok(BLOCK.includes('return $a -eq $b'), 'exact compare after strip missing');
});

test('F84-SAMEHOST: all three fences use the tolerant compare', () => {
  assert.ok(BLOCK.includes('Test-F78SameHost -Allowed $ExpectedHost -Actual $f78Uri.Host'), 'SecureFetch host fence not tolerant');
  assert.ok(BLOCK.includes('Test-F78SameHost -Allowed $f78Host -Actual $f78SLink.Host'), 'sitemap <loc> fence not tolerant');
  assert.ok(BLOCK.includes('Test-F78SameHost -Allowed $f78Host -Actual $f78LinkHost'), 'href fence not tolerant');
});

test('F84-SAMEHOST: the strict equality fences are gone', () => {
  assert.ok(!BLOCK.includes("$f78Uri.Host.ToLowerInvariant() -ne $ExpectedHost"), 'strict SecureFetch compare survives');
  assert.ok(!BLOCK.includes("$f78SLink.Host.ToLowerInvariant() -ne $f78Host"), 'strict sitemap compare survives');
  assert.ok(!BLOCK.includes('if ($f78LinkHost -ne $f78Host)'), 'strict href compare survives');
});

test('F84-SAMEHOST: the canonical hostname is stored on save and hydrated on boot', () => {
  assert.ok(BLOCK.includes('canonicalHostname = $f78CanonicalHost'), 'canonicalHostname not stored on the row');
  assert.ok(BLOCK.includes('$script:F78AllowHosts[$f78CanonicalHost] = $true'), 'canonical host not allowlisted');
  assert.ok(BLOCK.includes("if ($f81Src.canonicalHostname) { $script:F78AllowHosts[[string]$f81Src.canonicalHostname] = $true }"), 'hydrate of canonical host missing');
});
