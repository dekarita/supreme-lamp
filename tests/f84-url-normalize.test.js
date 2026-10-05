// [F84 §2.1] Server-pin for the AddSiteQuick URL normalisation. The shipped
// normalizeUrl()/isInsecureHttp() are EXTRACTED from the component source and
// executed in a vm - this tests the real function, not a copy of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SRC = fs.readFileSync('src/components/search/AddSiteQuick.tsx', 'utf8');
const EN = JSON.parse(fs.readFileSync('src/i18n/en.json', 'utf8'));
const SI = JSON.parse(fs.readFileSync('src/i18n/si.json', 'utf8'));
const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');

function shipped(name) {
  const start = SRC.indexOf('export function ' + name + '(');
  assert.ok(start > 0, name + ' missing from AddSiteQuick.tsx');
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) {
        return SRC.slice(start, i + 1)
          .replace('export function', 'function')
          // strip the TS annotations so the shipped body runs in the vm (the
          // logic itself is untouched)
          .replace(/\(([^)]*)\)\s*:\s*[A-Za-z<>\[\]]+\s*\{/, '($1) {')
          .replace(/:\s*(string|boolean|number)\b/g, '');
      }
    }
  }
  assert.fail(name + ' body never closed');
}

const box = {};
vm.createContext(box);
vm.runInContext(shipped('normalizeUrl') + '\n' + shipped('isInsecureHttp'), box);
const normalizeUrl = box.normalizeUrl;
const isInsecureHttp = box.isInsecureHttp;

test('F84-NORM: bare domain and www host get https:// prepended', () => {
  assert.equal(normalizeUrl('openculture.com'), 'https://openculture.com');
  assert.equal(normalizeUrl('www.openculture.com'), 'https://www.openculture.com');
  assert.equal(normalizeUrl('  openculture.com/ebooks  '), 'https://openculture.com/ebooks');
});

test('F84-NORM: path-only input is rebased onto https://', () => {
  assert.equal(normalizeUrl('/ebooks/1342'), 'https://ebooks/1342');
  assert.equal(normalizeUrl('///details/x'), 'https://details/x');
});

test('F84-NORM: an explicit scheme is preserved (never silently rewritten)', () => {
  assert.equal(normalizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com');
  assert.equal(normalizeUrl(''), '');
});

test('F84-NORM: isInsecureHttp only fires for an explicit http://', () => {
  assert.equal(isInsecureHttp('http://example.com'), true);
  assert.equal(isInsecureHttp('http://example.com/x'), true);
  assert.equal(isInsecureHttp('https://example.com'), false);
  assert.equal(isInsecureHttp('openculture.com'), false);
});

test('F84-NORM: the httpsOnly + autoHttps + probeFailed keys exist in en AND si', () => {
  for (const cat of [EN, SI]) {
    assert.equal(typeof cat.addSite.autoHttps, 'string');
    assert.equal(typeof cat.addSite.httpsOnly, 'string');
    assert.equal(typeof cat.addSite.probeFailed, 'string');
  }
  assert.equal(SI.addSite.httpsOnly.trim().length > 0, true);
});

test('F84-NORM: blur + save both normalise, and the server probes HTTPS on save', () => {
  assert.ok(SRC.includes('onBlur={() => {'), 'blur normalisation missing');
  assert.ok(SRC.includes('const normalized = normalizeUrl(url);'), 'save normalisation missing');
  assert.ok(SRC.includes('setUrlError("addSite.httpsOnly")'), 'insecure-http refusal missing');
  assert.ok(SRC.includes('data-testid="add-site-auto-https"'), 'autoHttps hint missing');
  assert.ok(SERVER.includes("$f78FieldErrors['url'] = 'addSite.probeFailed'"), 'server probe refusal missing');
  // [F93 §1.2 SUPERSEDES the F84 HEAD/5s pins - rewritten in place, never
  // deleted]: a HEAD is what Cloudflare-class CDNs refuse first, and 5s was
  // too tight for a redirect ladder. The probe is now GET, 10s-bounded, and
  // follows up to 10 redirects (the F93 pin test owns the 2xx/3xx acceptance).
  assert.ok(SERVER.includes("$f78ProbeReq.Method = 'GET'"), 'server probe is not a GET request');
  assert.ok(SERVER.includes('$f78ProbeReq.Timeout = 10000'), 'server probe is not 10s-bounded');
  assert.ok(SERVER.includes('$f78ProbeReq.MaximumAutomaticRedirections = 10'), 'server probe does not follow redirects');
});
