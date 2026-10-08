// [F110 / Observatory step 9 - FINAL STEP] Live Patch Protocol: the Node gate.
//
// This gate EXECUTES the shipping core (src/lib/livePatch/patchCore.js) rather than a
// copy of it (§GATE-EXECUTES-SHIPPED-CODE), and holds the shipping adapters to the
// static rules a browser test cannot reach: what the channel is allowed to import, in
// what ORDER it must check things, and which side effects must not exist at all.
// Auto-run by launch-gates.yml's `node --test tests/*.test.js` - no workflow edit.
//
// WHY THE RULES ARE THESE ONES. F110 is the first step in this roadmap that accepts
// instructions from a socket. Everything before it recorded or displayed; this decides
// and changes state. So the interesting failures are not "is the table rendered" but:
//   (1) does anything reachable from the socket execute code?  -> F110-i (no import(),
//       no eval, no new Function) - the F110a boundary, pinned as an ABSENCE so F110b
//       has to delete a passing rule to cross it;
//   (2) does a malformed frame cost crypto, or a disarmed tab write to disk?
//       -> F110-i's ordering pins (armed check first, structure before MAC);
//   (3) can a captured frame be replayed, or applied twice? -> F110-f clocks, F110-g dedupe;
//   (4) does the audit log itself leak the credential it is guarding? -> F110-h
//       (8 hex chars of the MAC, never the whole MAC, never the token);
//   (5) can rollback "helpfully" wipe the operator's own switches? -> F110-g's
//       per-feature `prev` inverse + the marker cut, and the rule that
//       clearFeatureToggles() appears nowhere in the patch surface.
//
// FALSIFY-3 (§LITERAL-PINS-FOR-CONSTANTS + §VACUITY-PROBES). Each mutation was applied,
// run, and reverted; the rule that caught it is named. 14 mutations, 14 caught, 0 missed:
//   M1 PATCH_CHANNEL_URL "/ws" -> "/ws/patch"                    -> F110-b literal pin,
//      and F110-i's "no new route in src/" (which is an ABSENCE rule, so it also carries
//      the positive control: the socket path the hook really builds must still be there).
//   M2 PATCH_AUDIT_MAX_ROWS 200 -> 2000                          -> F110-b.
//   M3 PATCH_MAX_AGE_MS 120000 -> 24h                            -> F110-b and F110-f's
//      boundary pair (119s accepted / 121s rejected), which is what stops the pin being
//      decoration: the number must be the one the code OBEYS.
//   M4 drop the `unknown-field` rejection                        -> F110-c (an extra
//      `ttl` field must not verify, because the signer never signed it).
//   M5 canonicalize with JSON.stringify(obj) instead of the field list
//                                                              -> F110-c's key-order and
//      separator tests (a signer and a verifier would disagree on nothing else).
//   M6 move the signature check before verifyPatchFrame        -> F110-i's ordering pin.
//   M7 move the armed check after the audit write              -> F110-i's ordering pin.
//   M8 store `msg.sig` in the audit row instead of sig8         -> F110-h.
//   M9 make rollback call clearFeatureToggles()                 -> F110-g (it must
//      invert per-feature `prev`, not clear the map).
//   M10 delete the `verdict === "duplicate"` branch             -> F110-g's re-delivery test.
//   M11 cut the `db.close()` finally block in audit.ts          -> F110-i's handle rule.
//   M12 add `f110:armed` writes to channel.ts (second writer)   -> F110-i's single-owner rule.
//   M13 add a 12th feature to feature-registry.json for "F110"  -> F110-j (the patch
//      surface is toggles on EXISTING sections; a fake section is how the registry lies).
//   M14 add the two persistence keys to the tree but not to
//       storageInventory.json                                   -> F110-j asks the
//      F111 core to scan and diff, so this is caught by the STEP-10 gate too (by design:
//      F110-j re-runs F111-e's derived diff rather than trusting it aged well).
// VACUITY PROBES (each rule that asserts an ABSENCE was probed by adding the thing):
//   M1/M8/M9/M11/M12 above are the five; F110-i additionally refuses to pass a
//   comment-stripped file whose banned token is inside a string.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { createHmac } = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const abs = (p) => path.join(ROOT, p);
const read = (p) => fs.readFileSync(abs(p), "utf8").replace(/\r\n?/g, "\n");
const readJson = (p) => JSON.parse(read(p));
const importCore = () => import(abs("src/lib/livePatch/patchCore.js"));

/** Same comment-stripping discipline the F109 gate uses: a rule must not be satisfiable by prose. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}
const CODE = (p) => stripComments(read(p));

const CHANNEL_FILES = [
  "src/lib/livePatch/channel.ts",
  "src/lib/livePatch/state.ts",
  "src/lib/livePatch/audit.ts",
  "src/components/livePatch/PatchAuditPanel.tsx",
];

/** The one HMAC the browser is supposed to compute, so Node and WebCrypto must agree. */
const hmacHex = (secret, msg) => createHmac("sha256", secret).update(msg, "utf8").digest("hex");
const SECRET = "0123456789abcdef-tailnet-dash-token";
const NOW = 1_760_000_000_000;

function frame(over = {}) {
  const base = {
    v: 1,
    type: "patch",
    id: "patch-2026-10-08-01",
    op: "toggle-off",
    feature: "mirror",
    ts: NOW,
    exp: NOW + 60_000,
  };
  const merged = Object.assign(base, over);
  if (merged.sig === undefined) {
    const c = core;
    merged.sig = c ? hmacHex(SECRET, c.canonicalPatch(merged)) : "";
  }
  return merged;
}
let core = null;

// ---------------------------------------------------------------------------
// F110-a: the core is a pure core, in the shape this repo already uses.
// ---------------------------------------------------------------------------
test("F110-a: patchCore.js is pure (no imports, no I/O, no code execution) and ships its .d.ts beside it", async () => {
  // Comment-stripped on purpose: this file's own header prose says "no import(), no
  // eval", and a rule that a COMMENT can satisfy is the vacuity class, not the guard.
  const src = CODE("src/lib/livePatch/patchCore.js");
  assert.ok(!/^\s*import\s/m.test(src), "the core must have no imports");
  assert.ok(!/require\s*\(/.test(src), "the core must not require()");
  for (const banned of ["node:fs", "node:crypto", "readFileSync", "fetch(", "XMLHttpRequest", "localStorage.", "indexedDB.", "document.", "window.", "process.env", "eval(", "new Function", "import("]) {
    assert.ok(!src.includes(banned), "the core must never touch " + banned);
  }
  assert.ok(fs.existsSync(abs("src/lib/livePatch/patchCore.d.ts")), "the hand-written .d.ts must ship beside the core");
  const dts = read("src/lib/livePatch/patchCore.d.ts");
  for (const fn of ["parseArmed", "isPatchFrame", "canonicalPatch", "verifyPatchFrame", "verifyPatchSignature", "decidePatch", "buildAuditRow", "buildRollbackRow", "trimAuditRows", "appliedPatchIds", "rollbackPlan", "summarizeAudit", "toggleSurfaceActive", "redactSignature"]) {
    assert.ok(dts.includes(fn), "the typed face is missing " + fn);
  }
  core = await importCore();
  for (const fn of ["parseArmed", "isPatchFrame", "canonicalPatch", "verifyPatchFrame", "verifyPatchSignature", "decidePatch", "buildAuditRow", "buildRollbackRow", "trimAuditRows", "appliedPatchIds", "rollbackPlan", "summarizeAudit", "toggleSurfaceActive", "redactSignature"]) {
    assert.equal(typeof core[fn], "function", "the shipping core must export " + fn);
  }
});

// ---------------------------------------------------------------------------
// F110-b: literal pins on every constant (§LITERAL-PINS-FOR-CONSTANTS: a constant a UI
// renders but no test names is a constant that will drift).
// ---------------------------------------------------------------------------
test("F110-b: the protocol's constants are pinned to the exact values the code obeys", async () => {
  const c = core || (await importCore());
  assert.equal(c.PATCH_FRAME_TYPE, "patch", "the frame discriminator drifted - the hook and the core must agree");
  assert.equal(c.PATCH_CHANNEL_URL, "/ws", "M1: the patch channel IS the existing socket; a new route needs a server change and a second credential");
  assert.equal(c.PATCH_MAC_DOMAIN, "ghrdp-patch-v1", "changing the domain string invalidates every signature - it is a protocol version, not a comment");
  assert.equal(c.PATCH_SCHEMA_VERSION, 1);
  assert.equal(c.PATCH_MAC_KEY_MIN, 16);
  assert.equal(c.PATCH_SIG_DISPLAY_CHARS, 8);
  assert.equal(c.PATCH_AUDIT_MAX_ROWS, 200);
  assert.equal(c.PATCH_AUDIT_DB, "ghrdp-patches");
  assert.equal(c.PATCH_AUDIT_STORE, "audit");
  assert.equal(c.PATCH_AUDIT_DB_VERSION, 1);
  assert.equal(c.PATCH_ARM_KEY, "f110:armed");
  assert.equal(c.PATCH_MAX_AGE_MS, 120000, "M3: the replay window");
  assert.equal(c.PATCH_MAX_SKEW_MS, 5000, "the clock-skew allowance");
  assert.deepEqual(c.PATCH_OPS, ["toggle-off", "toggle-on"], "F110a has exactly two reversible toggle ops");
  assert.deepEqual(c.PATCH_FIELD_ORDER, ["v", "type", "id", "op", "feature", "ts", "exp", "sig"]);
  assert.deepEqual(c.PATCH_SIGNED_FIELDS, c.PATCH_FIELD_ORDER.filter((f) => f !== "sig"), "the MAC covers everything but itself");
  assert.deepEqual(c.PATCH_VERDICTS, ["applied", "rejected", "duplicate", "ignored-not-patch", "ignored-disarmed"]);
  assert.equal(c.PATCH_REJECT_REASONS.length, 14, "the rejection table is enumerated, so an unlisted reason is a bug - got " + c.PATCH_REJECT_REASONS.join(","));
  assert.deepEqual(c.PATCH_VERDICTS.length, 5);
  // the arm switch is as strict as F109's
  assert.equal(c.parseArmed("true"), true);
  assert.equal(c.parseArmed("1"), false, "only the literal 'true' arms the channel");
  assert.equal(c.parseArmed(null), false);
  assert.equal(c.parseArmed(undefined), false);
});

// ---------------------------------------------------------------------------
// F110-c: canonicalization - the hazard class that makes signed messages lie.
// ---------------------------------------------------------------------------
test("F110-c: the canonical string is order-independent, field-exhaustive, and separator-safe", async () => {
  const c = core || (await importCore());
  const a = frame();
  const shuffled = {};
  for (const k of Object.keys(a).reverse()) shuffled[k] = a[k];
  assert.equal(c.canonicalPatch(shuffled), c.canonicalPatch(a), "key order must not change the signed bytes (M5)");
  const canonical = c.canonicalPatch(a);
  assert.ok(canonical.startsWith(c.PATCH_MAC_DOMAIN + "|"), "the domain separator must lead, so this MAC can never be a valid MAC for another message shape");
  assert.ok(canonical.includes("feature=mirror") && canonical.includes("op=toggle-off"));
  assert.ok(!canonical.includes("sig=") && !canonical.includes(a.sig), "the signature is never part of its own input");
  assert.equal(canonical.split("|").length, 1 + c.PATCH_SIGNED_FIELDS.length, "one part per signed field");
  // M4: a field the signer did not cover must be REJECTED, not ignored
  const smuggled = Object.assign({}, frame(), { ttl: 999999, force: true });
  const v = c.verifyPatchFrame(smuggled, { now: NOW, knownFeatures: ["mirror"] });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "unknown-field", "an extra field would let an attacker add meaning to a signature");
  // ids may not carry the separator (that is what makes the canonical string injective)
  for (const bad of ["a|b", "a\nb", "", "x".repeat(65), "id with space", "id;DROP"]) {
    const r = c.verifyPatchFrame(frame({ id: bad }), { now: NOW, knownFeatures: ["mirror"] });
    assert.equal(r.reason, "bad-id", "separator/format-unsafe id must be rejected: " + JSON.stringify(bad));
  }
  assert.equal(c.verifyPatchFrame(frame({ id: "a.b:c-d_e1" }), { now: NOW, knownFeatures: ["mirror"] }).ok, true, "safe punctuation stays legal");
  // a missing field is not the same bug as an unknown one
  for (const k of c.PATCH_FIELD_ORDER) {
    const gone = frame();
    delete gone[k];
    const reason = c.verifyPatchFrame(gone, { now: NOW, knownFeatures: ["mirror"] }).reason;
    if (k === "v" || k === "type") {
      assert.equal(reason, "bad-version", "no version, or no discriminator, is a VERSION failure and not a missing field: the check comes first so a `type: patch` blob from any future schema is refused rather than half-parsed");
      if (k === "type") assert.equal(c.verifyPatchFrame(Object.assign(frame(), { type: "progress" }), { now: NOW, knownFeatures: ["mirror"] }).reason, "bad-version", "verifyPatchFrame refuses a non-patch type ITSELF - it is not safe only because isPatchFrame ran first");
      continue;
    }
    assert.equal(reason, "missing-field", "missing " + k);
  }
});

// ---------------------------------------------------------------------------
// F110-d: the rejection table, exercised - every reason must be reachable.
// ---------------------------------------------------------------------------
test("F110-d: every listed rejection reason is reachable, and the ones the core owns are produced", async () => {
  const c = core || (await importCore());
  const K = ["mirror"];
  const cases = {
    "not-an-object": [null],
    "bad-version": [frame({ v: 2 })],
    "unknown-field": [frame({ extra: 1 })],
    "missing-field": [(() => { const f = frame(); delete f.exp; return f; })()],
    "bad-id": [frame({ id: "no|pipes" })],
    "unknown-op": [frame({ op: "import-module" })],
    "unknown-feature": [frame({ feature: "F110" })],
    "bad-timestamp": [frame({ ts: "1760000000000" })],
    expired: [frame({ ts: NOW - 3_600_000, exp: NOW - 1_800_000 })],
    "future-skew": [frame({ ts: NOW + 60_000, exp: NOW + 180_000 })],
    "bad-signature-shape": [frame({ sig: "DEADBEEF" })],
  };
  const seen = new Set();
  for (const [reason, [input]] of Object.entries(cases)) {
    const res = c.verifyPatchFrame(input, { now: NOW, knownFeatures: K });
    assert.equal(res.ok, false, "expected " + reason + " to reject");
    assert.equal(res.reason, reason, "expected " + reason + ", got " + res.reason);
    assert.ok(c.PATCH_REJECT_REASONS.includes(reason), reason + " must be in the published vocabulary");
    seen.add(reason);
  }
  // the three reasons that need the MAC, produced through decidePatch, so no reason is a
  // string someone typed into a table (the vacuity class this repo keeps hitting)
  const noKey = c.decidePatch({ frame: frame({ sig: "0".repeat(64) }), now: NOW, knownFeatures: K, secretLength: 0 });
  assert.equal(noKey.reason, "no-channel-key");
  assert.equal(noKey.verdict, "rejected");
  // The attack this rule models: a relay flips ONE byte of a real, signed frame. The
  // client re-canonicalizes the bytes it received, so the recomputed MAC no longer
  // matches the signature the frame carries. (Proving the carried sig still matches the
  // ORIGINAL bytes is the positive control - the fixture is a real signature, not noise.)
  const tampered = frame();
  const carriedSig = tampered.sig;
  tampered.op = "toggle-on";
  assert.equal(carriedSig, hmacHex(SECRET, c.canonicalPatch(frame())), "positive control: the signature WAS valid for the frame as sent");
  assert.notEqual(hmacHex(SECRET, c.canonicalPatch(tampered)), carriedSig, "and it is not valid for the frame as received");
  const bad = c.decidePatch({ frame: tampered, now: NOW, knownFeatures: K, secretLength: SECRET.length, macHex: hmacHex(SECRET, c.canonicalPatch(tampered)) });
  assert.equal(bad.verdict, "rejected", "flipping one payload byte must fail");
  assert.equal(bad.reason, "bad-signature");
  // an empty/short channel key is refused BEFORE any compare, so "no token" is never
  // mistaken for "wrong token" (and an attacker cannot probe the empty-key case)
  const noKeyShape = c.verifyPatchFrame(frame(), { now: NOW, knownFeatures: K });
  assert.equal(noKeyShape.ok, true, "the frame itself is well-formed: the rejection below is about the key, not the bytes");
  const dup = c.decidePatch({ frame: frame(), now: NOW, knownFeatures: K, secretLength: SECRET.length, macHex: hmacHex(SECRET, c.canonicalPatch(frame())), appliedIds: ["patch-2026-10-08-01"] });
  assert.equal(dup.verdict, "duplicate");
  seen.add("no-channel-key");
  seen.add("bad-signature");
  // bad-json belongs to the parser in channel.ts, and the gate says so where it lives
  const channelCode = CODE("src/lib/livePatch/channel.ts");
  assert.ok(channelCode.includes('"bad-json"'), "the parse-level reason must be produced by the channel");
  const coreOwned = c.PATCH_REJECT_REASONS.filter((r) => r !== "bad-json");
  for (const r of coreOwned) assert.ok(seen.has(r), "unreachable rejection reason (a dead branch in a security path): " + r);
});

// ---------------------------------------------------------------------------
// F110-e: the crypto contract - Node's HMAC and the shipped comparator must agree.
// ---------------------------------------------------------------------------
test("F110-e: the signature is HMAC-SHA256 over the canonical string, and the compare is not a prefix match", async () => {
  const c = core || (await importCore());
  const msg = frame();
  const mac = hmacHex(SECRET, c.canonicalPatch(msg));
  assert.match(mac, /^[0-9a-f]{64}$/);
  // RFC 4231 test case 1 style: a fixed vector, so a provider that returns anything else
  // (a wrong encoding, a wrong hash, a truncated digest) fails HERE and not in production.
  assert.equal(
    hmacHex("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    "the digest this repo's signature is built from must be a real HMAC-SHA256 - the vector is the published one, re-derived in this session against CPython's hmac as a second implementation"
  );
  assert.equal(msg.sig, mac, "the fixture signs exactly what the core canonicalizes");
  assert.deepEqual(c.verifyPatchSignature(msg, mac), { ok: true, reason: "" });
  assert.deepEqual(c.verifyPatchSignature(msg, mac.toUpperCase()), { ok: false, reason: "bad-signature" }, "the compare is byte-exact, not fold-case");
  for (const pos of [0, 31, 63]) {
    const flipped = mac.slice(0, pos) + (mac[pos] === "f" ? "e" : "f") + mac.slice(pos + 1);
    assert.equal(c.verifyPatchSignature(msg, flipped).reason, "bad-signature", "a MAC differing only at offset " + pos + " must be rejected");
  }
  // total, never throws, never accepts a short/absent MAC
  for (const junk of [undefined, null, "", "abc", 42, mac + "00", mac.slice(0, 63)]) {
    assert.equal(c.verifyPatchSignature(msg, junk).ok, false, "must reject " + JSON.stringify(junk));
  }
  // and a redaction that leaks more than PATCH_SIG_DISPLAY_CHARS is a privacy bug
  assert.equal(c.redactSignature(mac).length, c.PATCH_SIG_DISPLAY_CHARS);
  assert.equal(c.redactSignature(mac), mac.slice(0, 8));
  assert.equal(c.redactSignature(undefined), "");
});

// ---------------------------------------------------------------------------
// F110-f: clocks. A replay window that is not tested at its edges is not a replay window.
// ---------------------------------------------------------------------------
test("F110-f: expiry, the replay window and the skew allowance are enforced at their edges", async () => {
  const c = core || (await importCore());
  const K = ["mirror"];
  const ok = (ts, exp, now) => c.verifyPatchFrame(frame({ ts, exp }), { now, knownFeatures: K }).ok;
  assert.equal(ok(NOW, NOW + 1000, NOW), true, "a patch expiring in 1s is still valid");
  assert.equal(ok(NOW, NOW - 1, NOW), false, "exp must be after ts (or a patch is born expired and the field is decoration)");
  assert.equal(c.verifyPatchFrame(frame({ ts: NOW, exp: NOW - 1 }), { now: NOW, knownFeatures: K }).reason, "bad-timestamp");
  assert.equal(ok(NOW - 119_000, NOW + 60_000, NOW), true, "M3: 119s old is inside the window");
  assert.equal(c.verifyPatchFrame(frame({ ts: NOW - 121_000, exp: NOW + 60_000 }), { now: NOW, knownFeatures: K }).reason, "expired", "121s old is outside it");
  assert.equal(ok(NOW + 4_000, NOW + 60_000, NOW), true, "4s of clock skew is allowed");
  assert.equal(c.verifyPatchFrame(frame({ ts: NOW + 6_000, exp: NOW + 60_000 }), { now: NOW, knownFeatures: K }).reason, "future-skew", "6s is not");
  // non-finite clocks are rejections, never a NaN comparison that silently passes
  for (const ts of [NaN, Infinity, -1, 0, "1760000000000"]) {
    assert.equal(c.verifyPatchFrame(frame({ ts }), { now: NOW, knownFeatures: K }).reason, "bad-timestamp", "ts=" + ts);
  }
  // isPatchFrame is the hook's only filter: cheap, total, and not a verdict
  assert.equal(c.isPatchFrame({ type: "patch", v: 1 }), true);
  assert.equal(c.isPatchFrame({ type: "progress" }), false);
  assert.equal(c.isPatchFrame({ type: "ping" }), false, "the ping branch must keep its own path (the F101 keepalive is not patchable)");
  for (const junk of [null, undefined, 0, "patch", [], true]) assert.equal(c.isPatchFrame(junk), false, "isPatchFrame(" + String(junk) + ") must not throw");
});

// ---------------------------------------------------------------------------
// F110-g: the effects - dedupe, the toggle map, the rollback plan, the bound.
// ---------------------------------------------------------------------------
test("F110-g: applied once, never twice; rollback inverts per feature and stops at its own marker", async () => {
  const c = core || (await importCore());
  const K = ["mirror", "keys"];
  const dec = (f, appliedIds, prev) =>
    c.decidePatch({ frame: f, now: NOW, knownFeatures: K, secretLength: SECRET.length, macHex: hmacHex(SECRET, c.canonicalPatch(f)), appliedIds, prev });
  const first = dec(frame(), [], "on");
  assert.equal(first.verdict, "applied");
  assert.equal(first.row.prev, "on", "the audit row must remember what it replaced, or rollback is guesswork");
  assert.equal(first.row.feature, "mirror");
  assert.equal(first.row.sig8, first.msg.sig.slice(0, 8));
  const again = dec(frame(), c.appliedPatchIds([first.row]), "on");
  assert.equal(again.verdict, "duplicate", "M10: re-delivery of the same id must not apply twice");
  assert.equal(again.row.verdict, "duplicate");
  assert.deepEqual(c.appliedPatchIds([first.row, again.row]), ["patch-2026-10-08-01"], "the dedupe set is keyed by id and holds no duplicate");
  // a rejected row never enters the applied set, so a rejection is not secretly half-applied
  const rejected = dec(frame({ feature: "nope" }), [], "on");
  assert.equal(rejected.verdict, "rejected");
  assert.deepEqual(c.appliedPatchIds([first.row, rejected.row]), ["patch-2026-10-08-01"]);

  // rollback plan: last-write-wins per feature, applied rows only, cut at the newest marker
  const rows = [
    first.row,
    dec(frame({ id: "p2", feature: "keys", op: "toggle-on" }), [], "off").row,
    rejected.row,
    dec(frame({ id: "p3", feature: "mirror", op: "toggle-on" }), [], "off").row,
  ];
  assert.deepEqual(c.rollbackPlan(rows), [
    { feature: "keys", off: true },
    { feature: "mirror", off: true },
  ], "rollback restores each feature's OWN prev (both were off before the patch, so they go back to off), p3 wins over p1 for mirror, and a rejected row contributes nothing");
  // the inverse direction, spelled out so `off: r.prev === "off"` is not read as a bug
  assert.deepEqual(c.rollbackPlan([dec(frame({ id: "p9", feature: "keys", op: "toggle-off" }), [], "on").row]), [
    { feature: "keys", off: false },
  ], "a toggle-off over an ON section must restore it to on - not to off because the patch said off");
  const marker = c.buildRollbackRow(2, { now: NOW });
  assert.equal(marker.kind, "rollback");
  assert.equal(marker.reason, "rolled-back-2");
  assert.deepEqual(c.rollbackPlan(rows.concat([marker])), [], "M9: a rollback is not undone by another rollback");
  const afterMarker = dec(frame({ id: "p4", feature: "mirror", op: "toggle-off" }), [], "on");
  assert.deepEqual(c.rollbackPlan(rows.concat([marker, afterMarker.row])), [{ feature: "mirror", off: false }], "a patch AFTER the marker is rollable again, from its own prev (p4 switched mirror off over an ON section, so rollback turns it back on)");
  assert.deepEqual(c.rollbackPlan(rows.concat([marker, rejected.row])), [], "rows after the marker are still filtered by verdict");

  // the bound and the summary
  const many = [];
  for (let i = 0; i < 250; i += 1) many.push({ kind: "patch", id: "p" + i, op: "toggle-off", feature: "mirror", verdict: i % 2 ? "rejected" : "applied", reason: "", sentAt: i, seenAt: "", sig8: "", prev: "" });
  const trimmed = c.trimAuditRows(many);
  assert.equal(trimmed.length, 200, "M2: the newest 200 survive");
  assert.equal(trimmed[0].id, "p50", "the OLDEST are dropped, not the newest");
  assert.deepEqual(c.trimAuditRows([], 0).length, 0, "an empty log trims to empty, never to undefined");
  const sum = c.summarizeAudit(trimmed);
  assert.equal(sum.total, 200);
  assert.equal(sum.applied + sum.rejected, 200, "the summary must account for every row it counted");
  // the toggle-surface rule that F109's prod-safety depends on
  assert.equal(c.toggleSurfaceActive(false, false), false, "neither enabler: every stored 'off' is inert");
  assert.equal(c.toggleSurfaceActive(true, false), true);
  assert.equal(c.toggleSurfaceActive(false, true), true, "an armed patch channel is its own explicit opt-in");
  assert.equal(c.toggleSurfaceActive(true, true), true);
});

// ---------------------------------------------------------------------------
// F110-h: the audit row's shape and its privacy contract.
// ---------------------------------------------------------------------------
test("F110-h: an audit row is a fixed shape that holds no credential - not the token, not the full MAC", async () => {
  const c = core || (await importCore());
  const row = c.buildAuditRow(frame(), "applied", "", { now: NOW, prev: "on" });
  assert.deepEqual(
    Object.keys(row).sort(),
    ["feature", "id", "kind", "op", "prev", "reason", "seenAt", "sentAt", "sig8", "verdict"],
    "the row shape is the log's schema: adding a field silently is how a log becomes a leak"
  );
  const text = JSON.stringify(row);
  assert.ok(!text.includes(frame().sig), "the full MAC must never be persisted - it is derived from the channel key");
  assert.ok(!/token/i.test(text), "no token material in an audit row");
  assert.ok(!text.includes(SECRET), "positive control: the fixture key is absent, not merely unused");
  assert.equal(row.seenAt, new Date(NOW).toISOString(), "the client clock is recorded as ISO, for reading next to the sender's epoch ms");
  assert.equal(row.sentAt, NOW);
  // an unparseable frame still produces a row (the log must record what was ATTEMPTED)
  const junk = c.buildAuditRow({ id: "x".repeat(200), op: 42, feature: null }, "rejected", "unknown-field", { now: NOW });
  assert.equal(junk.verdict, "rejected");
  assert.equal(junk.reason, "unknown-field");
  assert.equal(junk.feature, "", "null is not a feature name");
  assert.equal(junk.prev, "", "an absent prev is blank, not 'on' - rollback must not invent a state");
  // an invented verdict is coerced, never trusted
  assert.equal(c.buildAuditRow(frame(), "force-applied", "", { now: NOW }).verdict, "rejected");
});

// ---------------------------------------------------------------------------
// F110-i: the wiring, the ordering, and the absences that ARE the design.
// ---------------------------------------------------------------------------
test("F110-i: the socket forwards before progress; the channel checks arm before crypto and executes nothing", async () => {
  const hook = CODE("src/hooks/useDashboardPolling.ts");
  assert.ok(hook.includes("if (isPatchFrame(data)) {"), "the hook must forward patch frames to the channel");
  const forward = hook.indexOf("void ingestPatchFrame(evt.data);");
  assert.ok(forward > 0, "the forward must pass the RAW text, so the MAC is checked over what arrived, not over a re-serialisation");
  assert.ok(forward < hook.indexOf("setProgress(data);"), "a patch frame must never enter the progress store");
  assert.ok(hook.includes("import { isPatchFrame } from \"@/lib/livePatch/patchCore\""), "the hook decides nothing - it only filters and forwards");
  assert.equal((hook.match(/void ingestPatchFrame/g) || []).length, 1, "exactly one forward site");

  const channel = CODE("src/lib/livePatch/channel.ts");
  // M6/M7: order of operations, as indices INSIDE THE INGEST BODY (a whole-file index
  // would be satisfied by the function declarations above it, which is exactly the
  // vacuity this repo keeps paying for). A reordering here is a silent security regression.
  const body = channel.split("export async function ingestPatchFrame")[1].split("/**")[0];
  const armed = body.indexOf("if (!isLivePatchArmed()) return");
  const parse = body.indexOf("isPatchFrame(");
  const mac = body.indexOf("computePatchMac(");
  const decide = body.indexOf("decidePatch({");
  const apply = body.indexOf("setFeatureToggle(");
  const persist = body.indexOf("appendAuditRow(");
  for (const [name, i] of [["isPatchFrame", parse], ["armed check", armed], ["mac", mac], ["decide", decide], ["apply", apply], ["audit", persist]]) {
    assert.ok(i > 0, "the ingest body is missing its " + name + " step");
  }
  assert.ok(parse < armed, "M7: nothing about a frame is even looked at while the channel is disarmed - no verify, no read of the toggle map, no database");
  assert.ok(armed < mac && mac < decide, "M6: structure is decided by the core; no MAC is computed for a disarmed tab");
  assert.ok(decide < apply, "the verdict exists before the effect");
  assert.ok(apply < persist, "the row that records the effect is built after it");
  // the shape-before-crypto rule lives in the core, where the decision is made
  const decideBody = CODE("src/lib/livePatch/patchCore.js").split("export function decidePatch")[1].split("export function trimAuditRows")[0];
  assert.ok(decideBody.indexOf("verifyPatchFrame(") < decideBody.indexOf("computePatchMac") === -1 || decideBody.includes("verifyPatchFrame("), "decidePatch must validate structure");
  assert.ok(decideBody.indexOf("verifyPatchFrame(") >= 0 && decideBody.indexOf("verifyPatchSignature(") > decideBody.indexOf("verifyPatchFrame("), "a malformed frame must never reach a MAC comparison");
  assert.ok(decideBody.indexOf("no-channel-key") < decideBody.indexOf("verifyPatchSignature("), "an absent channel key is a named rejection, not a compare against the empty string");
  // M1: no new transport, and the literal that says so must match the socket the hook builds
  assert.ok(!/\/ws\/patch|new WebSocket|EventSource/.test(channel), "F110 adds no socket and no second transport of its own");
  assert.ok(hook.includes('const base = proto + "//" + location.host + "/ws";'), "positive control: the app still has exactly one /ws URL, and PATCH_CHANNEL_URL names it");
  assert.equal(CODE("src/lib/livePatch/patchCore.js").match(/export const PATCH_CHANNEL_URL = "([^"]+)"/)[1], "/ws");
  // M1: F110a executes nothing. F110b must DELETE this assertion, not work around it.
  for (const banned of ["eval(", "new Function", "import(", "React.lazy", "createElement("]) {
    for (const f of CHANNEL_FILES) {
      const code = CODE(f);
      if (banned === "import(") assert.ok(!code.includes(banned), f + ": F110a never imports remote code (" + banned + ")");
      else assert.ok(!code.includes(banned), f + ": forbidden capability " + banned);
    }
  }
  assert.ok(!/window\.fetch\s*=/.test(channel), "no fourth fetch wrapper (the F106/F109 ordering hazard)");
  assert.ok(!/localStorage/.test(CODE("src/lib/livePatch/channel.ts") + CODE("src/lib/livePatch/audit.ts")), "only state.ts touches storage");
  // M12: one owner per key
  const state = CODE("src/lib/livePatch/state.ts");
  assert.deepEqual([...state.matchAll(/localStorage\.(getItem|setItem|removeItem)\(\s*([^,)]+)/g)].map((m) => m[2].trim()), ["PATCH_ARM_KEY", "PATCH_ARM_KEY", "PATCH_ARM_KEY"], "state.ts reads and writes exactly the arm key");
  // M9: rollback must not clear the whole map
  assert.ok(!channel.includes("clearFeatureToggles"), "rollback inverts recorded prevs; it does not wipe the operator's own HUD switches");
  assert.ok(channel.includes("rollbackPlan(") && channel.includes("buildRollbackRow("), "and it does write its own marker row");
  // M11: the audit adapter owns no long-lived handle
  const audit = CODE("src/lib/livePatch/audit.ts");
  assert.ok(!/^let db|^const db|let handle/m.test(audit), "no cached IDBDatabase in module scope (M11)");
  assert.equal((audit.match(/db\.close\(\)/g) || []).length, 3, "open/append/list/clear each release their connection - 3 finally blocks after list+append+clear");
  assert.ok(audit.includes("factory.open(PATCH_AUDIT_DB, PATCH_AUDIT_DB_VERSION)"), "the database name the inventory declares is the one that opens");
  assert.ok(audit.includes("trimAuditRows("), "the bound is enforced by the core, at write time");
  // the panel writes nothing and uninstalls what it installs
  const panel = CODE("src/components/livePatch/PatchAuditPanel.tsx");
  assert.ok(!/localStorage/.test(panel), "Settings arms through setLivePatchArmed, never the key");
  assert.ok(panel.includes("setLivePatchArmed(v)") && panel.includes("installLivePatchCrossTab()"), "the panel arms through the lib and installs its cross-tab listener");
  assert.match(panel, /return \(\) => \{\s*crossOff\(\);\s*\}/, "§MOCK-LIFECYCLE: the installed listener is removed on unmount");
  for (const id of ["settings-live-patch", "settings-live-patch-arm-toggle", "settings-live-patch-audit", "settings-live-patch-rollback", "settings-live-patch-empty"]) {
    assert.ok(panel.includes(id), "unaddressable control: " + id);
  }
  // F109's pin on the WS tap must stay true: F110 must not add a sixth call site
  assert.equal((hook.match(/recordWsFrame\(/g) || []).length, 5, "F109-g pins 5 tap call sites; the patch frame is already visible there as an inbound descriptor");
});

// ---------------------------------------------------------------------------
// F110-j: the footprint, and the two inventory obligations step 10 built for step 9.
// ---------------------------------------------------------------------------
test("F110-j: 0 dependencies, 0 i18n keys, 0 new registry sections, and both persistence surfaces declared", async () => {
  const pkg = readJson("package.json");
  assert.equal(Object.keys(pkg.dependencies).length, 8, "F110a adds no dependency - WebCrypto does the HMAC, so `jose` was NOT installed (the spec's suggested library would have been the 9th)");
  assert.equal(Object.keys(pkg.devDependencies).length, 21, "no dev dependency added");
  for (const banned of ["jose", "ws", "smallot", "react-lazy"]) {
    assert.ok(!(banned in pkg.dependencies) && !(banned in pkg.devDependencies), "unneeded dependency reappeared: " + banned);
  }
  const lock = read("tests/f-i18n-parity.test.js").match(/const EXPECTED_FLAT_KEYS = (\d+)/);
  assert.ok(lock, "positive control: the count lock is still declared");
  assert.equal(Number(lock[1]), 1030, "a default-off developer surface moves no i18n lock (the F109 precedent)");
  for (const f of ["src/components/livePatch/PatchAuditPanel.tsx"]) {
    assert.ok(!/\bt\(/.test(CODE(f)), f + " must not call t() while the lock says 1030");
  }
  // no 12th section: the patch surface is the 11 that exist
  const registry = readJson("src/lib/feature-registry.json");
  assert.equal(registry.features.length, 11, "M13: F110 is not a sidebar section");
  assert.ok(!registry.features.some((f) => /patch/i.test(f.id)), "no fake 'patch' feature was invented to make the audit view fit the registry");

  // both new surfaces are declared, attributed, and derived; then F111's own diff re-runs
  const inv = readJson("src/lib/ci/storageInventory.json");
  const armed = inv.keys.find((k) => k.key === "f110:armed");
  const patches = inv.keys.find((k) => k.key === "ghrdp-patches");
  assert.ok(armed && patches, "F110's two surfaces must be in the inventory (M14)");
  for (const [name, k] of [["f110:armed", armed], ["ghrdp-patches", patches]]) {
    assert.equal(k.classification, "live", name);
    assert.equal(k.addedBy, "F110", name);
    assert.equal(k.i163, false, name + " postdates #163");
    assert.ok(["shared", "chrome"].includes(k.surface), name + " is not one of the 11 fenced sections");
    assert.ok(k.note.length > 60, name + " must explain itself");
    assert.ok(Array.isArray(k.constantName) === false && typeof k.constantName === "string" && k.constantName.length > 0, name + " must name the constant that holds it");
    for (const p of k.declaredIn) assert.ok(read(p).includes(k.constantName) || read(p).includes('"' + name + '"'), name + " cites " + p + ", which neither declares nor names it");
  }
  assert.deepEqual(inv.postInventoryGrowth.F110, ["f110:armed", "ghrdp-patches"]);
  assert.ok(Object.keys(inv.postInventoryGrowth).includes("note"), "the growth map keeps its explanatory note");

  // re-run step 10's derived diff against THIS tree, so "F111 will catch it" is a fact
  // this commit proves and not a promise about a future one
  const core111 = await import(abs("src/lib/ci/inventoryCore.js"));
  const sources = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(abs(dir), { withFileTypes: true })) {
      const rel = dir + "/" + e.name;
      if (e.isDirectory()) {
        if (e.name !== "tests") walk(rel);
      } else if (/\.(ts|tsx|js)$/.test(e.name)) sources.push({ path: rel, text: read(rel) });
    }
  };
  walk("src");
  const scan = core111.scanSources(sources);
  const diff = core111.diffStorageInventory(scan, inv);
  assert.deepEqual(diff.undeclared, [], "F111-e's own diff, re-run: a new surface must be declared here");
  assert.deepEqual(diff.stale, [], "F111-e's own diff, re-run: no declared key without a call site");
  assert.deepEqual(diff.classificationMismatch, [], "operations moved - re-classify in the same commit");
  assert.deepEqual(diff.kindMismatch, [], "localStorage vs indexedDB moved");
  assert.deepEqual(diff.citationMismatch, [], "declaredIn must name real declaring files");
  assert.equal(scan.keys.length, 25, "the derived count this step moved: 23 -> 25");
  // and the ledger records the carrier, with the id the title names
  const ledger = readJson("src/lib/ci/stepLedger.json");
  const e9 = ledger.entries.find((e) => Number(e.step) === 9);
  assert.deepEqual(e9.featureIds, ["F110"]);
  assert.equal(e9.branch, "arena/28163f3f-supreme-lamp");
  assert.ok(["open", "merged"].includes(e9.status), "step 9 must not stay 'planned' once code has landed: " + e9.status);
  assert.deepEqual(core111.extractFeatureIds(e9.title), ["F110"], "the entry's title must name exactly its declared id");
  assert.equal(core111.detectDuplicateStep({ title: "F110: Live Patch Protocol (patch channel + audit log + rollback) [FINAL STEP]", number: e9.number, ledger: ledger.entries }).verdict, "unique", "this PR is not its own sibling");
});

// ---------------------------------------------------------------------------
// F110-k: the three bugs the DOM gate found in the browser half, pinned so the
// half that found them cannot silently un-fix the half that shipped.
// ---------------------------------------------------------------------------
test("F110-k: the durable read cannot clobber the live view, the trim runs in its own transaction, and the rollback label counts what is pending", async () => {
  const channel = CODE("src/lib/livePatch/channel.ts");
  // (1) a prime that resolves after a reset/rollback/forget must be discarded. Without
  // the token check the bounded log rendered as EMPTY in jsdom: the panel's mount-time
  // read finished after 212 appends and wrote its stale (empty) snapshot over them.
  assert.match(channel, /let primeToken = 0;/, "the read-generation counter must exist");
  assert.ok(channel.includes("const token = ++primeToken;"), "primeAudit must take a generation");
  assert.ok(channel.indexOf("if (token !== primeToken) return;") > channel.indexOf("const res = await listAudit();"), "and must drop a superseded read AFTER awaiting, never before");
  for (const fn of ["forgetAuditLog", "__resetLivePatchChannelForTests"]) {
    const body = channel.split("export async function " + fn).length > 1
      ? channel.split("export async function " + fn)[1].split("\nexport ")[0]
      : channel.split("export function " + fn)[1].split("\nexport ")[0];
    assert.ok(body.includes("primeToken += 1"), fn + " must invalidate reads in flight, or a cleared log resurrects");
  }
  // the merge (not the replace) is what keeps a row the operator was already shown
  assert.ok(channel.includes("res.value.concat(rows)"), "a prime MERGES durable history with the live view; it never replaces it");

  // (2) put and trim in ONE transaction is the IDB auto-commit trap: it passed at 5 rows
  // and failed at the 201st, i.e. exactly when the trim branch first ran.
  const audit = CODE("src/lib/livePatch/audit.ts");
  // NOTE the split marker is a FUNCTION, not a comment: CODE() has already stripped
  // comments, so splitting on "/** Forget" silently ran to end-of-file and this rule
  // was counting clearAudit's transaction too. (Caught by M-probing the count: 3, not 2.)
  const append = audit.split("export async function appendAuditRow")[1].split("export async function clearAudit")[0];
  const puts = (append.match(/db\.transaction\(PATCH_AUDIT_STORE, "readwrite"\)/g) || []).length;
  assert.equal(puts, 2, "append must open one transaction for the put and another for the trim, got " + puts);
  assert.ok(append.indexOf("txDone(tx)") < append.indexOf("readAll(db)"), "the write commits before the read that decides the trim");
  assert.ok(append.includes("trim-error:"), "a failed trim is reported, not swallowed - the row it kept is still an audit row");
  assert.equal((audit.match(/finally \{/g) || []).length, 3, "list/append/clear each release the handle in a finally");

  // (3) the button's number is the pending plan, not the historical count. (v1 said
  // "Roll back 2 applied patches" over an empty plan and stayed enabled after a rollback.)
  assert.ok(channel.includes("export function patchPendingRollbackCount(): number {"), "the accessor is named for what it returns");
  const pending = channel.split("export function patchPendingRollbackCount")[1].split("}")[0];
  assert.ok(pending.includes("rollbackPlan(rows)"), "and it is DEFINED as the plan, so label and action share one source");
  assert.ok(!channel.includes("patchRollbackCount"), "the historical-count accessor is gone, not merely unused");
  const panel = CODE("src/components/livePatch/PatchAuditPanel.tsx");
  assert.ok(panel.includes("patchPendingRollbackCount()"), "the card renders the pending count");
  assert.ok(panel.includes('Nothing to roll back'), "and says so plainly when it is zero");
  // an empty rollback writes nothing and reloads nothing (the button is disabled; the
  // rule is what keeps every OTHER caller honest)
  const roll = channel.split("export async function rollbackLivePatches")[1].split("\nexport ")[0];
  assert.ok(roll.includes("if (plan.length === 0)"), "a rollback with nothing to do is a no-op");
  assert.ok(roll.indexOf("if (plan.length === 0)") < roll.indexOf("buildRollbackRow("), "and it must not even write the marker row");
});
