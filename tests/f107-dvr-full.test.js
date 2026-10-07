"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const core = () => import(path.join(root, "src/lib/dvr/full-core.js"));
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("F107-a: structural diffs roundtrip without content or attributes values", async () => {
  const { mutationDiff, validDiff, safeRoute } = await core();
  assert.equal(safeRoute("#/collector?token=SECRET"), "#/collector");
  assert.equal(safeRoute("#/collector"), "#/collector");
  const top = { nodeType: 1, parentNode: null, childNodes: [] };
  const child = { nodeType: 1, parentNode: top, childNodes: [], tagName: "DIV" };
  top.childNodes.push(child);
  const text = { nodeType: 3, parentNode: child, textContent: "secret" };
  child.childNodes.push(text);
  const diff = mutationDiff({ target: text, type: "characterData", oldValue: "old secret" }, top);
  assert.deepEqual(diff, { path: [0], type: "characterData" });
  assert.equal(validDiff(JSON.parse(JSON.stringify(diff))), true);
  assert.equal(JSON.stringify(diff).includes("secret"), false);
  assert.deepEqual(mutationDiff({ target: child, type: "attributes", attributeName: "title", oldValue: "private" }, top),
    { path: [0], type: "attributes", attribute: "title" });
  assert.equal(validDiff({ path: [-1], type: "childList" }), false);
});

test("F107-b: v2 bundle, 5MB cap and 30-day retention execute shipped core", async () => {
  const { buildFullBundle, appendBounded, sizeOf, MAX_SESSION_BYTES, RETENTION_MS, isExpired } = await core();
  const session = { id: "a", createdAt: 1000, updatedAt: 1000, target: { route: "#/", lang: "si", ui: "v2" }, features: ["collector"], timeline: [] };
  const one = appendBounded(session, { kind: "click", at: 1100 });
  const bundle = JSON.parse(JSON.stringify(buildFullBundle(one.session)));
  assert.equal(bundle.format, "mcrec"); assert.equal(bundle.version, 2);
  assert.deepEqual(bundle.timeline, [{ kind: "click", at: 1100 }]);
  assert.equal(bundle.storage.maxBytes, MAX_SESSION_BYTES);
  assert.deepEqual(bundle.features, ["collector"]);
  assert.equal(appendBounded(session, { kind: "screenshot", at: 1, image: "x".repeat(MAX_SESSION_BYTES) }).accepted, false);
  let bounded = session;
  for (let i = 0; i < 8; i++) bounded = appendBounded(bounded, { kind: "screenshot", at: i, image: "x".repeat(800_000) }).session;
  assert.ok(sizeOf(buildFullBundle(bounded)) <= MAX_SESSION_BYTES);
  assert.ok(bounded.timeline.length < 8 && bounded.timeline.at(-1).at === 7);
  assert.equal(isExpired(session, 1000 + RETENTION_MS), false);
  assert.equal(isExpired(session, 1000 + RETENTION_MS + 1), true);
});

test("F107-c: source wires shipped observer to #root, click to screenshot, local persistence to IndexedDB, and no upload", () => {
  const full = read("src/lib/dvr/full.ts"), mutation = read("src/lib/dvr/mutations.ts"), screen = read("src/lib/dvr/screenshots.ts"), storage = read("src/lib/dvr/storage.ts");
  assert.match(full, /getElementById\("root"\)/);
  assert.match(full, /observeMutations\(root, diff => append\(/);
  assert.match(full, /captureThumbnail\(root\)/);
  assert.match(code(read("src/lib/dvr.ts")), /recordFullClick\(/);
  assert.match(mutation, /observer\.observe\(root, \{ subtree: true/);
  assert.match(storage, /indexedDB\.open\(DB, 1\)/);
  assert.match(full, /saveSession\(captured\)/);
  assert.match(screen, /html2canvas\(root,/);
  assert.match(read("src/components/domain/DvrFab.tsx"), /startFullDvr\(\)/);
  for (const name of ["full.ts", "mutations.ts", "screenshots.ts", "storage.ts", "export.ts"]) {
    const body = code(read("src/lib/dvr/" + name));
    assert.doesNotMatch(body, /\b(fetch\(|sendBeacon\(|XMLHttpRequest|WebSocket|\/api\/diag-upload)/, name + " cannot upload");
  }
  assert.doesNotMatch(code(read("src/components/dvr/SessionListModal.tsx")), /\b(fetch\(|sendBeacon\(|XMLHttpRequest|WebSocket)/, "session UI cannot upload");
});
