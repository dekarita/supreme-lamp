#!/usr/bin/env node
// [F92 §7.2] Smoke gate for main.yml: read the /api/f92-selftest
// application/health+json body and turn every `fail` check into a
// ::error:: annotation + non-zero exit. `warn` (JS-rendered sites, fixture
// drift) never blocks - the F92 contract is "red cell names the fix", and
// nightly drift must not fail a deploy.
// [F62 lesson] runs with the repo as cwd; reads ONLY the file passed to it.
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
let bad = 0;
const checks = d && d.checks ? d.checks : {};
for (const [k, arr] of Object.entries(checks)) {
  for (const c of Array.isArray(arr) ? arr : [arr]) {
    if (c && c.status === 'fail') {
      console.error(`::error title=${k}::${c.output || 'no detail'}`);
      bad++;
    }
  }
}
if (bad) {
  console.error(`F92 self-test: ${bad} failing check(s); overall=${d && d.status}`);
  process.exit(1);
}
console.log(`All ${Object.keys(checks).length} subsystems not failing (overall=${d && d.status}).`);
