// [F58 §4] Node lab: the CUSTOM SOURCE REGISTRY descriptor loader measured against
// the FROZEN F56 schema. The loader is not re-implemented here - the shipped rule
// core (src/search/custom-source-core.js, [F58-core-*] markers) is extracted and
// executed in a vm, exactly like the F53/F46 labs do for the shipped PS/HTML
// surfaces, so this file proves the real code and not a copy of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_PATH = 'docs/f56/schema.json';
const SCHEMA_SHA256 = 'c33601d94e55bab77cf940918c2949430ba5db19faf3314049f6dedb882336c8';

function loadCore() {
  const src = fs.readFileSync('src/search/custom-source-core.js', 'utf8').replace(/\r\n?/g, '\n');
  const begin = src.indexOf('/* [F58-core-begin] */');
  const end = src.indexOf('/* [F58-core-end] */');
  assert.ok(begin >= 0 && end > begin, 'the shipped core markers are missing');
  // runInThisContext (not a fresh context): the shipped core keeps the host
  // intrinsics, so the arrays it returns are real host arrays and the assertions
  // below compare values instead of realms.
  new vm.Script(src.slice(begin, end) + '\n;globalThis.__F58_CORE = F58;').runInThisContext();
  return globalThis.__F58_CORE;
}

const F58 = loadCore();
const schemaRaw = fs.readFileSync(SCHEMA_PATH, 'utf8');
const schema = JSON.parse(schemaRaw);

test('F58-SCHEMA-FROZEN: docs/f56/schema.json is byte-identical to the freeze', () => {
  const digest = crypto.createHash('sha256').update(schemaRaw).digest('hex');
  assert.equal(digest, SCHEMA_SHA256, 'the frozen F56 schema changed (out of F58 scope)');
  assert.equal(schema.additionalProperties, false, 'the freeze must keep rejecting extra fields');
  assert.equal(schema.required.length, 16);
  assert.deepEqual(F58.F56_REQUIRED, schema.required, 'the loader must require exactly the frozen 16');
  assert.deepEqual(F58.F58_REQUIRED, ['addedAt', 'source', 'enableState'], 'F58 adds exactly three fields');
  assert.ok(!schemaRaw.includes('enableState'), 'the freeze was not edited to make room for F58');
  assert.ok(!schemaRaw.includes('addedAt'), 'the freeze was not edited to make room for F58');
});

test('F58-SCHEMA-ENUMS: every enum/pattern the loader pins is the schema value', () => {
  const p = schema.properties;
  assert.deepEqual(F58.CATEGORIES, p.category.enum);
  assert.deepEqual(F58.TRANSPORT_MODES, p.transportModes.items.enum);
  assert.deepEqual(F58.LICENCE_TAGS, p.licenceTag.oneOf[0].enum);
  assert.deepEqual(F58.LICENCE_TAGS, p.licenceTag.oneOf[1].properties.allowedTags.items.enum);
  assert.deepEqual(Object.keys(F58.CATEGORY_TO_F56).sort(), ['code-hosting', 'own-storage-nas', 'public-archive', 'vendor-download']);
  const baseUrlRe = new RegExp(p.baseUrl.pattern);
  const idRe = new RegExp(p.id.pattern);
  const hostRe = new RegExp(p.allowedDomains.items.pattern);
  for (const presetId of F58.presetIds()) {
    const r = F58.instantiate(presetId, { addedAt: '2026-09-30T00:00:00Z', source: 'ab'.repeat(32) });
    assert.ok(r.ok, presetId + ' preset must validate: ' + r.errors.join('; '));
    assert.match(r.draft.baseUrl, baseUrlRe, presetId + ' baseUrl vs frozen pattern');
    assert.match(r.draft.id, idRe, presetId + ' id vs frozen pattern');
    for (const d of r.draft.allowedDomains) assert.match(d, hostRe, presetId + ' domain ' + d + ' vs frozen pattern');
    assert.equal(r.draft.redirectPolicy.requireHttps, true);
    assert.equal(r.requireAllowlisted, true, presetId + ' must pin requireAllowlisted');
    assert.deepEqual(r.pinnedAllowlist, r.draft.allowedDomains, presetId + ' allowlist is the pinned preset list');
    assert.ok(r.pinnedAllowlist.every((d) => !d.includes('*')), presetId + ' wildcards are rejected by the freeze');
  }
});

function githubFixture() {
  return F58.instantiate('code-hosting/github', { addedAt: '2026-09-30T00:00:00Z', source: 'ab'.repeat(32), enableState: 'permanent' }).draft;
}
const EXT = { addedAt: '2026-09-30T00:00:00Z', source: 'ab'.repeat(32), enableState: 'permanent' };

test('F58-LOADER-ACCEPT: a conforming descriptor + extension passes', () => {
  const res = F58.validate(githubFixture(), EXT);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});

test('F58-LOADER-REQUIRED: dropping any frozen field is refused (16 cells)', () => {
  for (const field of schema.required) {
    const d = githubFixture();
    delete d[field];
    const r = F58.validate(d, EXT);
    assert.equal(r.ok, false, field + ' must be required');
    assert.ok(r.coreErrors.some((e) => e.includes(field)), field + ': ' + r.coreErrors.join('; '));
  }
});

test('F58-LOADER-REJECTS: the frozen loader constraints are carried, not decorated', () => {
  const cases = [];
  const mk = (mut) => { const d = githubFixture(); mut(d); return d; };
  cases.push(['HTTP base URL', mk((d) => { d.baseUrl = 'http://api.github.com'; })]);
  cases.push(['IP-literal source', mk((d) => { d.baseUrl = 'https://100.64.1.7/sources'; })]);
  cases.push(['userinfo in base URL', mk((d) => { d.baseUrl = 'https://u:p@api.github.com'; })]);
  cases.push(['wildcard domain', mk((d) => { d.allowedDomains = ['*.githubusercontent.com']; })]);
  cases.push(['uppercase domain', mk((d) => { d.allowedDomains = ['GitHub.com']; })]);
  cases.push(['duplicate domains', mk((d) => { d.allowedDomains = ['github.com', 'github.com']; })]);
  cases.push(['empty allowlist', mk((d) => { d.allowedDomains = []; })]);
  cases.push(['unknown category', mk((d) => { d.category = 'warez'; })]);
  cases.push(['unknown licence tag', mk((d) => { d.licenceTag = 'pirated'; })]);
  cases.push(['unknown transport', mk((d) => { d.transportModes = ['ftp']; })]);
  cases.push(['missing robots check', mk((d) => { delete d.robotsCheck; })]);
  cases.push(['robots allow-on-disallow', mk((d) => { d.robotsCheck.onDisallow = 'allow'; })]);
  cases.push(['missing rate limit', mk((d) => { delete d.rateLimit; })]);
  cases.push(['unbounded timeout', mk((d) => { d.timeout = { connect: 10, request: 0 }; })]);
  cases.push(['missing content-length rule', mk((d) => { d.downloadContract = { artifactFields: ['url'], contentLengthRequired: false }; })]);
  cases.push(['extra field in the core', mk((d) => { d.proxy = 'http://evil'; })]);
  cases.push(['headers on the query template', mk((d) => { d.queryTemplate.headers = { Authorization: 'Bearer x' }; })]);
  cases.push(['executable parser code', mk((d) => { d.parseContract.resultSelector = "(r) => fetch(r.url)"; })]);
  cases.push(['unknown id shape', mk((d) => { d.id = 'GitHub_Releases'; })]);
  for (const [label, d] of cases) {
    const r = F58.validate(d, EXT);
    assert.equal(r.ok, false, 'must reject: ' + label + ' (' + r.errors.join('; ') + ')');
  }
  const banned = schema['x-f56-loader-constraints'].theLoaderMustReject;
  for (const need of ['HTTP base URLs or artifact URLs', 'IP-literal source URLs', 'arbitrary request headers', 'executable parser code', 'unbounded timeouts', 'missing robots checks', 'missing rate-limit configuration', 'missing content-length behavior for downloadable artifacts', 'redirects outside the adapter allowlist']) {
    assert.ok(banned.includes(need), 'the freeze must still carry: ' + need);
  }
});

test('F58-EXTENSION: the three F58 fields are mandatory and typed (4 cells)', () => {
  const d = githubFixture();
  for (const f of F58.F58_REQUIRED) {
    const ext = Object.assign({}, EXT);
    delete ext[f];
    assert.ok(F58.validate(d, ext).extensionErrors.some((e) => e.includes(f)), f + ' required');
  }
  assert.ok(F58.validate(d, Object.assign({}, EXT, { enableState: 'temporary' })).extensionErrors.length > 0, 'enableState enum');
  assert.ok(F58.validate(d, Object.assign({}, EXT, { source: 'operator-identity-name' })).extensionErrors.length > 0, 'source must be a hash, never an identity');
  assert.ok(F58.validate(d, Object.assign({}, EXT, { addedAt: 'yesterday' })).extensionErrors.length > 0, 'addedAt must be ISO-8601');
  assert.ok(F58.validate(d, Object.assign({}, EXT, { enableState: 'paused' })).ok, 'paused is legal (permanent is the default)');
});

test('F58-SEEDS: every shipped preset seed validates against the loader', () => {
  const dir = 'payloads/user-sources';
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('preset.') && f.endsWith('.json'));
  assert.ok(files.length >= 4, 'expected the four code-hosting seeds, found ' + files.join(','));
  for (const f of files) {
    const row = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const r = F58.validate(row.descriptor, row.f58);
    assert.ok(r.ok, f + ': ' + r.errors.join('; '));
    assert.equal(row.descriptor.redirectPolicy.requireAllowlisted, true, f + ' must pin the redirect allowlist');
    assert.deepEqual(row.pinnedAllowlist, row.descriptor.allowedDomains, f + ' allowlist matches the core preset');
    assert.ok(row.descriptor.allowedDomains.includes(new URL(row.descriptor.baseUrl).hostname), f + ' baseUrl host is inside its own allowlist');
    assert.equal(row.descriptor.rateLimit.concurrency, 1, f + ' hard concurrency');
    assert.equal(row.descriptor.rateLimit.requestsPerMinute, 60, f + ' hard rpm');
    assert.equal(row.descriptor.timeout.request, 30, f + ' hard timeout');
  }
});

test('F58-REDIRECT: cross-domain follow is blocked (allowlist + https + no IP)', () => {
  const d = githubFixture();
  assert.equal(F58.redirectAllowed(d, 'https://objects.githubusercontent.com/x.zip').ok, true);
  assert.equal(F58.redirectAllowed(d, 'https://mirror.example.org/x.zip').ok, false);
  assert.match(F58.redirectAllowed(d, 'https://mirror.example.org/x.zip').reason, /redirect-off-allowlist/);
  assert.match(F58.redirectAllowed(d, 'http://github.com/x.zip').reason, /redirect-not-https/);
  assert.match(F58.redirectAllowed(d, 'https://100.64.1.7/x.zip').reason, /redirect-target-ip-literal/);
  assert.match(F58.redirectAllowed(d, '').reason, /redirect-target-missing/);
  // a subdomain that merely ENDS with an allowlisted host is not allowed
  assert.match(F58.redirectAllowed(d, 'https://github.com.evil.test/x.zip').reason, /redirect-off-allowlist/);
});

test('F58-RATELIMIT: hard defaults are applied, and the clamp is visible', () => {
  assert.deepEqual({ c: F58.HARD.concurrency, rpm: F58.HARD.requestsPerMinute, to: F58.HARD.requestTimeoutSec, o: F58.HARD.overridable }, { c: 1, rpm: 60, to: 30, o: false });
  const d = githubFixture();
  d.rateLimit = { requestsPerMinute: 5000, burst: 20, concurrency: 8, retryAfter: 'ignore', backoff: 'none' };
  d.timeout = { connect: 600, request: 600 };
  const res = F58.enforceRateLimit(d);
  assert.equal(res.value.rateLimit.concurrency, 1);
  assert.equal(res.value.rateLimit.requestsPerMinute, 60);
  assert.equal(res.value.timeout.request, 30);
  assert.equal(res.overridable, false);
  assert.ok(res.violations.length >= 4, 'every clamp is reported: ' + res.violations.join('; '));
  assert.ok(F58.validate(res.value, EXT).ok, 'the clamped descriptor is still schema-clean');
});

test('F58-FANOUT: registry unlimited, one search capped at 8 sources', () => {
  const entries = [];
  for (let i = 0; i < 12; i++) {
    entries.push({ descriptor: { id: 'src-' + i }, f58: { addedAt: EXT.addedAt, source: EXT.source, enableState: i === 11 ? 'paused' : 'permanent' }, status: i === 10 ? { fetchDisabledReason: 'provenance-incomplete: sha256' } : {} });
  }
  const plan = F58.planFanOut(entries);
  assert.equal(plan.cap, 8);
  assert.equal(plan.selected.length, 8);
  // paused + fetch-disabled rows never fan out, so 12 rows -> 10 eligible -> 8 + 2 dropped
  assert.deepEqual(plan.dropped, ['src-8', 'src-9']);
  assert.ok(!plan.selected.includes('src-11') && !plan.selected.includes('src-10'));
});

test('F58-PROVENANCE: PROVENANCE-6 is fail-closed for executables (9 cells)', () => {
  const full = { fileName: 'app.exe', byteSize: 1048576, publisher: 'Acme', sha256: 'a'.repeat(64), signatureStatus: 'verified', releasePageUrl: 'https://github.com/acme/acme/releases/tag/v1' };
  assert.equal(F58.evaluateProvenance('app.exe', full).fetchEnabled, true);
  const expectedLabels = { fileName: 'filename', byteSize: 'byte size', publisher: 'publisher', sha256: 'sha256', signatureStatus: 'signature status', releasePageUrl: 'release-page URL' };
  for (const f of F58.PROVENANCE_FIELDS) {
    const rec = Object.assign({}, full);
    delete rec[f];
    const r = F58.evaluateProvenance('app.exe', rec);
    assert.equal(r.fetchEnabled, false, f + ' missing must disable fetch');
    assert.match(r.reason, /^provenance-incomplete: /);
    assert.ok(r.reason.includes(expectedLabels[f]), f + ' named in: ' + r.reason);
  }
  // an empty string is as absent as the key itself
  const blank = Object.assign({}, full, { publisher: '   ' });
  assert.match(F58.evaluateProvenance('app.exe', blank).reason, /publisher/);
  // malformed evidence counts as absent: a truncated sha, an http release page
  assert.match(F58.evaluateProvenance('app.exe', Object.assign({}, full, { sha256: 'deadbeef' })).reason, /sha256/);
  assert.match(F58.evaluateProvenance('app.exe', Object.assign({}, full, { releasePageUrl: 'http://acme.test/r' })).reason, /release-page URL/);
  // signature status: unverifiable is its own labeled refusal
  for (const sig of ['unverified', 'unsigned']) {
    const r = F58.evaluateProvenance('setup.msi', Object.assign({}, full, { fileName: 'setup.msi', signatureStatus: sig }));
    assert.equal(r.fetchEnabled, false, sig + ' must disable fetch');
    assert.match(r.reason, new RegExp('^signature-unverifiable: ' + sig));
  }
  assert.match(F58.evaluateProvenance('disk.iso', Object.assign({}, full, { signatureStatus: 'mystery' })).reason, /signature-unverifiable/);
  // every executable extension is covered; a non-executable never needs the six
  for (const ext of ['.exe', '.msi', '.dmg', '.iso', '.zip']) {
    assert.equal(F58.evaluateProvenance('payload' + ext, {}).fetchEnabled, false, ext + ' must require the six');
  }
  assert.equal(F58.evaluateProvenance('book.epub', {}).applies, false);
});
