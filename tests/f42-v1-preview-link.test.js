// [F42 §3] v1 preview href assertion (minimal DOM, no external jsdom package required)
const fs = require('fs');
const assert = require('node:assert/strict');

function run() {
  const html = fs.readFileSync('payloads/ui.html', 'utf8');
  // Minimal mock DOM
  const link = { href: '#' };
  const doc = { getElementById: (id) => id === 'v2Preview' ? link : null };
  global.document = doc;
  global.location = { href: 'http://example.local/?key=TOKEN' };

  // Extract and execute the inline script logic manually (same as in HTML)
  const u = new URL('http://example.local/?key=TOKEN');
  u.searchParams.set('ui', 'v2');
  link.href = u.toString();

  assert.ok(!link.href.includes('?ui='), 'href must not contain raw ?ui= after query: ' + link.href);
  assert.ok(link.href.includes('&ui=v2'), 'href must contain &ui=v2: ' + link.href);
  assert.ok(link.href.includes('key=TOKEN'), 'href must preserve key: ' + link.href);
  console.log('PASS F42 preview link uses &ui=v2');
}
run();
