// [F42 §1] server query normalization unit
const fs = require('fs');
const assert = require('node:assert/strict');

function parseQuery(rawTarget) {
  // Replicates Get-RequestParts after F42 edit
  const qAt = rawTarget.indexOf('?');
  if (qAt < 0) return {};
  const rawQuery = rawTarget.substring(qAt + 1).replace(/\?/g, '&');
  const query = {};
  for (const part of rawQuery.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = decodeURIComponent(part.substring(0, eq)).toLowerCase();
      const v = decodeURIComponent(part.substring(eq + 1));
      query[k] = v;
    }
  }
  return query;
}

function test(name, fn) {
  try { fn(); console.log('PASS', name); } catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; }
}

test('double-? parses ui=v2', () => {
  assert.deepStrictEqual(parseQuery('/?key=TOKEN?ui=v2'), { key: 'TOKEN', ui: 'v2' });
});

test('ampersand form parses ui=v2', () => {
  assert.deepStrictEqual(parseQuery('/?key=TOKEN&ui=v2'), { key: 'TOKEN', ui: 'v2' });
});

test('encoded value preserved', () => {
  const q = parseQuery('/?key=hello%20world&ui=v2');
  assert.strictEqual(q.key, 'hello world');
  assert.strictEqual(q.ui, 'v2');
});

test('key cleanliness after second ?', () => {
  const q = parseQuery('/?key=A?ui=v2');
  assert.strictEqual(q.key, 'A');
  assert.strictEqual(q.ui, 'v2');
});

test('source contains normalization replace', () => {
  const src = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
  assert.ok(src.includes("-replace '\\?', '&'"), 'missing F42 query replace');
});
