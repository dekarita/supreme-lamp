// [F110b / maintenance step M1] Ed25519 patch signatures: the Node gate.
//
// This gate EXECUTES the shipping core (src/lib/livePatch/signatureCore.js) and the
// shipping operator signer (scripts/f110b-sign-patch.mjs) rather than copies of them
// (§GATE-EXECUTES-SHIPPED-CODE), and holds the shipping adapters to the static rules a
// browser test cannot reach. Auto-run by launch-gates.yml's `node --test tests/*.test.js`
// - no workflow edit, no new lane.
//
// WHY THESE RULES. F110b is not "add crypto", it is "add crypto without weakening what
// shipped". The interesting failures are therefore:
//   (1) does an UNPINNED build (today's build) accept an asymmetric frame?  -> F110b-e
//       enumerates the whole matrix, and F110b-i proves the consequence in a runtime
//       whose Ed25519 verify is measurably broken;
//   (2) does pinning a key leave the shared-secret path open?               -> F110b-e
//       (`legacy-mac-refused`), because "the strongest key in the repo protects nothing"
//       is the failure mode nobody sees in review;
//   (3) can a v1 MAC be replayed as a v2 signature?                         -> F110b-d
//       (different domain separator, so the bytes can never coincide);
//   (4) does the v2 path fork the audit row, the replay window, or the v1 body?
//                                                                          -> F110b-b/g
//   (5) does the doc claim an emitter that does not exist?                  -> F110b-h
//       (§GREP-CHECK-DESIGN-BEFORE-SHIP, as a gate rather than a promise).
//
// MEASURED IN THIS SESSION, and re-measured on every run by F110b-i: on node v22.22.3
// `crypto.subtle.sign({name:"Ed25519"})` reproduces RFC 8032's published vectors, while
// `crypto.subtle.verify({name:"Ed25519"})` returns FALSE for them. Node's own
// `crypto.verify` returns true for the same signatures. So the shipped verifier's
// fail-closed shape is not a style choice: in a runtime like this one it is the only
// reason a broken verify does not become an accepted patch.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createPublicKey, generateKeyPairSync, sign: nodeSign, verify: nodeVerify, webcrypto } = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const abs = (p) => path.join(ROOT, p);
const read = (p) => fs.readFileSync(abs(p), "utf8").replace(/\r\n?/g, "\n");
const readJson = (p) => JSON.parse(read(p));
const importSig = () => import(abs("src/lib/livePatch/signatureCore.js"));
const importV1 = () => import(abs("src/lib/livePatch/patchCore.js"));

/** Same comment-stripping discipline the F109/F110 gates use: prose must not satisfy a rule. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}
const CODE = (p) => stripComments(read(p));

const NEW_FILES = [
  "src/lib/livePatch/signatureCore.js",
  "src/lib/livePatch/keys.ts",
  "src/lib/livePatch/signature.ts",
  "src/components/livePatch/PatchAuditPanel.tsx",
  "src/lib/livePatch/channel.ts",
  "scripts/f110b-sign-patch.mjs",
];

const NOW = 1_760_000_000_000;
/** RFC 8032 §7.1 test vectors - published, so a fake provider cannot satisfy them. */
const RFC = [
  {
    sk: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    pk: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    msg: "",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    sk: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    pk: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    msg: "72",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
];
const hex = (h) => Buffer.from(h, "hex");
const PKCS8_PREFIX = hex("302e020100300506032b657004220420");
const SPKI_PREFIX = hex("302a300506032b6570032100");
const spkiOf = (pkHex) => Buffer.concat([SPKI_PREFIX, hex(pkHex)]);

let sigCore = null;
let v1Core = null;
let keypair = null;

/** A fresh operator keypair, and its pin in the shape keys.ts expects. */
function operatorKey() {
  if (keypair) return keypair;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  keypair = {
    privateKey,
    publicKey,
    pin: spki.subarray(spki.length - 32).toString("base64"),
    pkcs8B64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
  return keypair;
}

function v2Frame(over = {}) {
  const c = sigCore;
  const base = {
    v: c.PATCH_SCHEMA_VERSION_V2,
    sigAlg: c.PATCH_SIG_ALG,
    type: "patch",
    id: "patch-2026-10-08-b1",
    op: "toggle-off",
    feature: "mirror",
    ts: NOW,
    exp: NOW + 60_000,
  };
  const merged = Object.assign(base, over);
  if (merged.sig === undefined) {
    const canonical = c.canonicalPatchV2(merged);
    merged.sig = nodeSign(null, Buffer.from(canonical, "utf8"), operatorKey().privateKey).toString("base64");
  }
  return merged;
}

/** node:crypto as the second implementation: the browser's verifier is held to it. */
function nodeVerifyB64(canonical, sigB64, pinB64) {
  const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pinB64, "base64")]), format: "der", type: "spki" });
  return nodeVerify(null, Buffer.from(canonical, "utf8"), pub, Buffer.from(sigB64, "base64"));
}

// ---------------------------------------------------------------------------
// F110b-a: the new core is a pure core, in the shape this repo already uses.
// ---------------------------------------------------------------------------
test("F110b-a: signatureCore.js is pure (no imports, no I/O, no code execution) and ships its .d.ts beside it", async () => {
  const src = CODE("src/lib/livePatch/signatureCore.js");
  assert.ok(!/^\s*import\s/m.test(src), "the core must have no imports (patchCore's rule, applied to its sibling)");
  assert.ok(!/require\s*\(/.test(src), "the core must not require()");
  for (const banned of ["node:fs", "node:crypto", "readFileSync", "fetch(", "XMLHttpRequest", "localStorage.", "indexedDB.", "document.", "window.", "process.env", "eval(", "new Function", "import(", "atob", "Buffer."]) {
    assert.ok(!src.includes(banned), "the core must never touch " + banned);
  }
  assert.ok(fs.existsSync(abs("src/lib/livePatch/signatureCore.d.ts")), "the hand-written .d.ts must ship beside the core");
  const dts = read("src/lib/livePatch/signatureCore.d.ts");
  const fns = ["isV2PatchFrame", "frameSignatureScheme", "base64ToBytes", "bytesToBase64", "parsePinnedPublicKey", "pinFingerprint", "canonicalPatchV2", "verifyPatchV2Frame", "signatureGate", "decidePatchV2"];
  for (const fn of fns) {
    assert.ok(dts.includes(fn), "the typed face is missing " + fn);
  }
  sigCore = await importSig();
  v1Core = await importV1();
  for (const fn of fns) assert.equal(typeof sigCore[fn], "function", "the shipping core must export " + fn);
  // no private key material in the browser half, and no second crypto implementation
  for (const f of ["src/lib/livePatch/keys.ts", "src/lib/livePatch/signature.ts"]) {
    const code = CODE(f);
    assert.ok(!/privateKey|pkcs8.*=.*"[A-Za-z0-9+/]{20,}"/.test(code.replace(/privateKeyPkcs8B64/g, "")), f + " must hold no key material of its own");
  }
});

// ---------------------------------------------------------------------------
// F110b-b: literal pins, and the two cores must AGREE where they overlap.
// ---------------------------------------------------------------------------
test("F110b-b: the v2 constants are pinned, and patchCore's v1 constants did not move", async () => {
  const c = sigCore || (await importSig());
  const v1 = v1Core || (await importV1());
  assert.equal(c.PATCH_SIG_ALG, "ed25519");
  assert.equal(c.PATCH_SIG_ALG_FIELD, "sigAlg");
  assert.equal(c.PATCH_SCHEMA_VERSION_V2, 2);
  assert.equal(c.PATCH_SIG_DOMAIN_V2, "ghrdp-patch-v2", "the domain is a protocol version, not a comment");
  assert.deepEqual(c.PATCH_V2_FIELD_ORDER, ["v", "sigAlg", "type", "id", "op", "feature", "ts", "exp", "sig"]);
  assert.deepEqual(c.PATCH_V2_SIGNED_FIELDS, c.PATCH_V2_FIELD_ORDER.filter((f) => f !== "sig"), "the signature covers everything but itself");
  assert.equal(c.PATCH_ED25519_PUBLIC_KEY_BYTES, 32);
  assert.equal(c.PATCH_ED25519_SIGNATURE_BYTES, 64);
  assert.equal(c.PATCH_ED25519_PUBLIC_KEY_B64_LEN, 44, "32 raw bytes, standard base64");
  assert.equal(c.PATCH_ED25519_SIGNATURE_B64_LEN, 88, "64 bytes, standard base64");
  assert.deepEqual(c.PATCH_SIG_SCHEMES, ["hmac-v1", "ed25519", "unknown"]);
  assert.deepEqual(c.PATCH_V2_ONLY_REJECT_REASONS, ["no-signer-pin", "legacy-mac-refused", "unknown-sig-alg", "sig-crypto-unavailable"]);
  assert.deepEqual(c.SIGNER_PIN_REASONS, ["", "empty", "bad-base64", "bad-length"]);

  // the two cores are separate files on purpose (a core has no imports), so the shared
  // numbers are pinned by equality here instead of by a shared constant
  assert.equal(c.PATCH_V2_MAX_AGE_MS, v1.PATCH_MAX_AGE_MS, "the v2 replay window must equal v1's - widening it for the 'new' scheme would be a silent downgrade");
  assert.equal(c.PATCH_V2_MAX_SKEW_MS, v1.PATCH_MAX_SKEW_MS, "the skew allowance must equal v1's");
  assert.deepEqual(c.PATCH_V2_SIGNED_FIELDS, ["v", "sigAlg"].concat(v1.PATCH_SIGNED_FIELDS.slice(1)), "v2 signs exactly v1's fields plus the algorithm name");
  assert.notEqual(c.PATCH_SIG_DOMAIN_V2, v1.PATCH_MAC_DOMAIN, "the domain separators must differ or a v1 MAC is a v2 signature");

  // NON-REGRESS: F110a's core did not move
  assert.equal(v1.PATCH_SCHEMA_VERSION, 1, "v1 is still v1");
  assert.equal(v1.PATCH_MAC_DOMAIN, "ghrdp-patch-v1");
  assert.equal(v1.PATCH_REJECT_REASONS.length, 14, "the v1 rejection table is still 14 - the four v2 reasons live in the v2 core");
  const v1src = CODE("src/lib/livePatch/patchCore.js");
  for (const token of ["ed25519", "sigAlg", "PATCH_SIG_DOMAIN_V2", "signatureCore"]) {
    assert.ok(!v1src.toLowerCase().includes(token.toLowerCase()), "patchCore.js must not learn about v2: " + token);
  }
});

// ---------------------------------------------------------------------------
// F110b-c: the base64 codec and the pin parser. A wrong-length decode is a silent
// no-op, so both are probed at their edges with a real key as the positive control.
// ---------------------------------------------------------------------------
test("F110b-c: base64 is strict, and only a 32-byte raw Ed25519 key is a pin", async () => {
  const c = sigCore || (await importSig());
  const k = operatorKey();
  // positive control: a real pin parses, round-trips, and fingerprints to 8 chars
  const ok = c.parsePinnedPublicKey(k.pin);
  assert.equal(ok.ok, true, "a real generated pin must parse");
  assert.equal(ok.b64, k.pin);
  assert.equal(c.bytesToBase64(c.base64ToBytes(k.pin).bytes), k.pin, "the codec round-trips a real key");
  assert.equal(c.pinFingerprint(k.pin).length, 8);
  // positive control for the url-safe case below: this 32-byte value's STANDARD base64
  // is a valid pin, so the refusal is about the alphabet and not about the bytes
  assert.equal(c.parsePinnedPublicKey("/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v4=").ok, true);
  assert.equal(c.pinFingerprint(undefined), "");
  // whitespace is trimmed, not rejected (an operator pastes with a newline)
  assert.equal(c.parsePinnedPublicKey("  " + k.pin + "\n").ok, true);
  // and every wrong shape is a NAMED refusal, never a throw and never ok
  const cases = [
    ["", "empty"],
    ["   ", "empty"],
    [null, "empty"],
    [42, "empty"],
    // §GATE-SELF-TEST: this case was originally `k.pin` with +/ swapped for -_ , which
    // silently became a NO-OP whenever the freshly generated key contained neither
    // character (about 1 run in 4) - a flaky gate is a gate that passes by luck. The
    // input is now a fixed 32-byte value whose base64 contains BOTH + and /.
    ["/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v4=".replace(/\+/g, "-").replace(/\//g, "_"), "bad-base64"], // url-safe alphabet
    ["not base64 at all", "bad-base64"],
    [Buffer.alloc(31, 1).toString("base64"), "bad-length"],
    [Buffer.alloc(33, 1).toString("base64"), "bad-length"],
    [Buffer.alloc(64, 1).toString("base64"), "bad-length"], // a signature is not a key
    ["AAAA", "bad-length"],
  ];
  for (const [input, reason] of cases) {
    const r = c.parsePinnedPublicKey(input);
    assert.equal(r.ok, false, "must refuse " + JSON.stringify(input));
    assert.equal(r.reason, reason, "expected " + reason + " for " + JSON.stringify(input));
    assert.equal(r.b64, "", "a refused pin must not leak a half-parsed value");
    assert.ok(c.SIGNER_PIN_REASONS.includes(reason) || reason === "empty", "unlisted pin reason: " + reason);
  }
  // the decoder itself: padding bits must be zero, and lengths must match
  assert.equal(c.base64ToBytes("QQ==").bytes.length, 1);
  assert.equal(c.base64ToBytes("QQ==").bytes[0], 65);
  assert.equal(c.base64ToBytes("QR==").ok, false, "non-zero padding bits are not canonical base64");
  assert.equal(c.base64ToBytes("QQ=").ok, false, "bad padding length");
  assert.equal(c.base64ToBytes("Q").ok, false);
  assert.deepEqual(c.base64ToBytes("").bytes, null);
  assert.equal(c.bytesToBase64([]), "");
  assert.equal(c.bytesToBase64([65]), "QQ==", "the encoder is the decoder's inverse at 1 byte");
  assert.equal(c.bytesToBase64([65, 66]), "QUI=");
  assert.equal(c.bytesToBase64([65, 66, 67]), "QUJD");
  // a 64-byte signature decodes to exactly 64 bytes (the shape check the frame relies on)
  const sigBytes = c.base64ToBytes(v2Frame().sig).bytes;
  assert.equal(sigBytes.length, c.PATCH_ED25519_SIGNATURE_BYTES);
});

// ---------------------------------------------------------------------------
// F110b-d: canonicalization, and the domain separation that keeps v1 and v2 apart.
// ---------------------------------------------------------------------------
test("F110b-d: the v2 canonical string is order-independent, signs sigAlg, and can never equal a v1 MAC input", async () => {
  const c = sigCore || (await importSig());
  const v1 = v1Core || (await importV1());
  const a = v2Frame();
  const shuffled = {};
  for (const kk of Object.keys(a).reverse()) shuffled[kk] = a[kk];
  assert.equal(c.canonicalPatchV2(shuffled), c.canonicalPatchV2(a), "key order must not change the signed bytes");
  const canonical = c.canonicalPatchV2(a);
  assert.ok(canonical.startsWith(c.PATCH_SIG_DOMAIN_V2 + "|"), "the domain separator must lead");
  assert.ok(canonical.includes("sigAlg=ed25519"), "the algorithm name is signed, so a valid frame cannot be re-labelled");
  assert.ok(canonical.includes("feature=mirror") && canonical.includes("op=toggle-off"));
  assert.ok(!canonical.includes("sig=") && !canonical.includes(a.sig), "the signature is never part of its own input");
  assert.equal(canonical.split("|").length, 1 + c.PATCH_V2_SIGNED_FIELDS.length);
  assert.equal(c.canonicalPatchV2(null), "");
  // domain separation, as an executable claim rather than a comment: the SAME payload
  // canonicalizes differently under v1 and v2, so neither authenticator is the other's
  const asV1 = { v: 1, type: "patch", id: a.id, op: a.op, feature: a.feature, ts: a.ts, exp: a.exp, sig: a.sig };
  assert.notEqual(v1.canonicalPatch(asV1), canonical);
  assert.notEqual(v1.PATCH_MAC_DOMAIN, c.PATCH_SIG_DOMAIN_V2);
  // a smuggled field is refused (the signer never covered it), exactly as in v1
  assert.equal(c.verifyPatchV2Frame(Object.assign({}, a, { ttl: 999999 }), { now: NOW, knownFeatures: ["mirror"] }).reason, "unknown-field");
  // and the structural reasons are spelled the way the audit log already spells them
  for (const bad of [
    [Object.assign({}, a, { v: 1 }), "bad-version"],
    [Object.assign({}, a, { type: "progress" }), "bad-version"],
    [Object.assign({}, a, { sigAlg: "rsa-pss" }), "unknown-sig-alg"],
    [Object.assign({}, a, { id: "a|b" }), "bad-id"],
    [Object.assign({}, a, { op: "import-module" }), "unknown-op"],
    [Object.assign({}, a, { feature: "F110b" }), "unknown-feature"],
    [Object.assign({}, a, { ts: "1760000000000" }), "bad-timestamp"],
    [Object.assign({}, a, { exp: a.ts }), "bad-timestamp"],
    [Object.assign({}, a, { ts: NOW - 3_600_000, exp: NOW - 1_800_000 }), "expired"],
    [Object.assign({}, a, { ts: NOW - 200_000, exp: NOW - 100_000 }), "expired"],
    [Object.assign({}, a, { ts: NOW + 60_000, exp: NOW + 120_000 }), "future-skew"],
    [Object.assign({}, a, { sig: "AA==" }), "bad-signature-shape"],
    [Object.assign({}, a, { sig: Buffer.alloc(63, 1).toString("base64") }), "bad-signature-shape"],
  ]) {
    const r = c.verifyPatchV2Frame(bad[0], { now: NOW, knownFeatures: ["mirror"] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, bad[1], "expected " + bad[1]);
  }
  const missing = Object.assign({}, a);
  delete missing.exp;
  assert.equal(c.verifyPatchV2Frame(missing, { now: NOW, knownFeatures: ["mirror"] }).reason, "missing-field");
  assert.equal(c.verifyPatchV2Frame(null, { now: NOW }).reason, "not-an-object");
  // clocks are enforced at their edges (a replay window untested at the edge is decoration)
  const at = (ts, exp, now) => c.verifyPatchV2Frame(v2Frame({ ts, exp }), { now, knownFeatures: ["mirror"] }).ok;
  assert.equal(at(NOW, NOW + 1000, NOW), true);
  assert.equal(at(NOW - 119_000, NOW + 1000, NOW), true, "119s old is inside the window");
  // M6: `exp` must not be decoration. A RECENT ts with an exp already in the past is only
  // catchable by the `exp < now` check - the age check sees a 1s-old frame and waves it
  // through, which is exactly the mutation that this gate used to miss.
  assert.equal(at(NOW - 1000, NOW - 500, NOW), false, "exp in the past is expired however fresh ts is");
  assert.equal(c.verifyPatchV2Frame(v2Frame({ ts: NOW - 1000, exp: NOW - 500 }), { now: NOW, knownFeatures: ["mirror"] }).reason, "expired");
  assert.equal(at(NOW - 121_000, NOW + 1000, NOW), false, "121s old is outside it");
  assert.equal(at(NOW + 5000, NOW + 60_000, NOW), true, "5s of skew is allowed");
  assert.equal(at(NOW + 5001, NOW + 60_000, NOW), false, "5.001s is not");
});

// ---------------------------------------------------------------------------
// F110b-e: THE MATRIX. Every cell, enumerated - this is the step's security claim.
// ---------------------------------------------------------------------------
test("F110b-e: the pin matrix fails closed in every cell, and pinning retires the shared-secret path", async () => {
  const c = sigCore || (await importSig());
  const v2 = v2Frame();
  const v1Frame = { v: 1, type: "patch", id: "p", op: "toggle-off", feature: "mirror", ts: NOW, exp: NOW + 1, sig: "0".repeat(64) };
  const cells = [
    // [pinOk, frame, action, scheme, reason]
    [false, v1Frame, "v1", "hmac-v1", ""],
    [false, v2, "refuse", "ed25519", "no-signer-pin"],
    [false, Object.assign({}, v1Frame, { sigAlg: "ed25519" }), "refuse", "unknown", "unknown-sig-alg"],
    [false, Object.assign({}, v2, { v: 3 }), "refuse", "unknown", "unknown-sig-alg"],
    [false, null, "refuse", "unknown", "unknown-sig-alg"],
    [true, v1Frame, "refuse", "hmac-v1", "legacy-mac-refused"],
    [true, v2, "v2", "ed25519", ""],
    [true, Object.assign({}, v2, { sigAlg: "rsa-pss" }), "refuse", "unknown", "unknown-sig-alg"],
  ];
  for (const [pinOk, frame, action, scheme, reason] of cells) {
    const g = c.signatureGate({ frame, pinOk });
    assert.equal(g.action, action, "pinOk=" + pinOk + " scheme=" + scheme + " must be " + action);
    assert.equal(g.scheme, scheme);
    assert.equal(g.reason, reason);
  }
  // the two cells that matter most, spelled out as their own assertions so a mutation
  // of either is named by a failing line rather than by a table diff
  assert.equal(c.signatureGate({ frame: v2, pinOk: false }).reason, "no-signer-pin", "an UNPINNED build must never accept an asymmetric frame");
  assert.equal(c.signatureGate({ frame: v1Frame, pinOk: true }).reason, "legacy-mac-refused", "a PINNED build must never fall back to the shared-secret MAC");
  // decidePatchV2 refuses without a pin even when handed a verified signature
  const decided = c.decidePatchV2({ frame: v2, now: NOW, knownFeatures: ["mirror"], pinOk: false, sigVerified: { ok: true, reason: "" } });
  assert.equal(decided.verdict, "rejected");
  assert.equal(decided.reason, "no-signer-pin", "a verified signature does not substitute for a pinned key");
  assert.equal(decided.msg, undefined, "and a refusal hands back no message to apply");
  // a missing verify result is a refusal, not an accept (the adapter cannot skip crypto)
  assert.equal(c.decidePatchV2({ frame: v2, now: NOW, knownFeatures: ["mirror"], pinOk: true }).reason, "bad-signature");
  assert.equal(c.decidePatchV2({ frame: v2, now: NOW, knownFeatures: ["mirror"], pinOk: true, sigVerified: null }).reason, "bad-signature");
  // a runtime with no Ed25519 is distinguishable from an attacker in the audit log
  assert.equal(
    c.decidePatchV2({ frame: v2, now: NOW, knownFeatures: ["mirror"], pinOk: true, sigVerified: { ok: false, reason: "crypto-unavailable" } }).reason,
    "sig-crypto-unavailable"
  );
});

// ---------------------------------------------------------------------------
// F110b-f: real Ed25519. node:crypto signs, the SHIPPING core decides, and the
// published RFC 8032 vectors keep the primitive honest.
// ---------------------------------------------------------------------------
test("F110b-f: a real Ed25519 signature applies, and a tampered, mis-keyed, expired or re-delivered one does not", async () => {
  const c = sigCore || (await importSig());
  const k = operatorKey();
  assert.equal(nodeVerifyB64(c.canonicalPatchV2(v2Frame()), v2Frame().sig, k.pin), true, "positive control: the fixture signature is real");

  const decide = (frame, over = {}) => {
    const structural = c.verifyPatchV2Frame(frame, { now: over.now || NOW, knownFeatures: over.knownFeatures || ["mirror", "keys"] });
    const check = structural.ok
      ? { ok: nodeVerifyB64(c.canonicalPatchV2(structural.msg), structural.msg.sig, over.pin === undefined ? k.pin : over.pin), reason: "" }
      : null;
    return c.decidePatchV2(Object.assign({ frame, now: NOW, knownFeatures: ["mirror", "keys"], pinOk: true, sigVerified: check }, over));
  };

  assert.deepEqual(decide(v2Frame()).verdict, "applied");
  // tamper: flip the op the signature covered
  const tampered = v2Frame();
  tampered.op = "toggle-on";
  assert.equal(decide(tampered).reason, "bad-signature", "flipping one covered byte must fail");
  // tamper: an UNSIGNED field cannot be flipped either, because it is not in the schema
  assert.equal(decide(Object.assign({}, v2Frame(), { feature2: "keys" })).reason, "unknown-field");
  // wrong key: a valid signature from a different operator keypair
  const other = generateKeyPairSync("ed25519");
  const otherSpki = other.publicKey.export({ type: "spki", format: "der" });
  const otherPin = otherSpki.subarray(otherSpki.length - 32).toString("base64");
  assert.equal(decide(v2Frame(), { pin: otherPin }).reason, "bad-signature", "the pin is the authority, not the signature's shape");
  // expired, and a re-delivery
  assert.equal(decide(v2Frame({ ts: NOW - 3_600_000, exp: NOW - 1_800_000 })).reason, "expired");
  const dup = decide(v2Frame(), { appliedIds: ["patch-2026-10-08-b1"] });
  assert.equal(dup.verdict, "duplicate");
  assert.equal(dup.reason, "already-applied");
  // structure before crypto: a malformed frame reports its STRUCTURAL reason, and the
  // adapter never ran the verifier for it (the node lane pins the adapter's order too)
  assert.equal(decide(Object.assign({}, v2Frame(), { feature: "F110b" })).reason, "unknown-feature");
  // and the primitive itself, against the published vectors (a fake provider dies here)
  for (const v of RFC) {
    const priv = { key: Buffer.concat([PKCS8_PREFIX, hex(v.sk)]), format: "der", type: "pkcs8" };
    const pub = createPublicKey({ key: spkiOf(v.pk), format: "der", type: "spki" });
    const msg = Buffer.from(v.msg, "hex");
    assert.equal(nodeSign(null, msg, require("node:crypto").createPrivateKey(priv)).toString("hex"), v.sig, "RFC 8032 vector must reproduce");
    assert.equal(nodeVerify(null, msg, pub, hex(v.sig)), true, "RFC 8032 vector must verify");
  }
});

// ---------------------------------------------------------------------------
// F110b-g: the adapter. Order of operations, one row builder, no new transport, and
// the v1 body F110 shipped left alone.
// ---------------------------------------------------------------------------
test("F110b-g: the channel routes before crypto, keeps one audit row builder, and leaves the v1 body untouched", async () => {
  const channel = CODE("src/lib/livePatch/channel.ts");
  const core = CODE("src/lib/livePatch/signatureCore.js");

  // the pin gate sits inside the ingest body, after the arm check and before the MAC
  const body = channel.split("export async function ingestPatchFrame")[1].split("/**")[0];
  const parse = body.indexOf("isPatchFrame(");
  const armed = body.indexOf("if (!isLivePatchArmed()) return");
  const gate = body.indexOf("signatureGate({");
  const mac = body.indexOf("computePatchMac(");
  const decide = body.indexOf("decidePatch({");
  for (const [name, i] of [["isPatchFrame", parse], ["armed check", armed], ["pin gate", gate], ["mac", mac], ["decide", decide]]) {
    assert.ok(i > 0, "the ingest body is missing its " + name + " step");
  }
  assert.ok(armed < gate, "the pin gate runs only for an armed channel - nothing is decided for a disarmed tab");
  assert.ok(gate < mac, "the pin gate runs BEFORE any crypto: an unpinned build does no verification work at all");
  assert.ok(gate < decide, "and before the v1 decision");
  // the two new branches leave the body immediately (they are separate functions, so the
  // v1 order pins below keep pointing at the v1 path)
  assert.ok(body.indexOf('gate.action === "refuse"') > gate && body.indexOf('gate.action === "v2"') > gate);
  assert.ok(body.indexOf("ingestRefusedPatch(") > gate && body.indexOf("ingestEd25519Patch(") > gate);

  // the v1 path is exactly where F110-i left it
  const apply = body.indexOf("setFeatureToggle(");
  const persist = body.indexOf("appendAuditRow(");
  assert.ok(mac < decide && decide < apply && apply < persist, "the v1 order pins still hold in the v1 body");

  // the v2 helper's own order: structure -> signature -> decide -> apply -> persist
  const v2body = channel.split("async function ingestEd25519Patch")[1].split("\n}")[0];
  const s1 = v2body.indexOf("verifyPatchV2Frame(");
  const s2 = v2body.indexOf("verifyPatchSignatureEd25519(");
  const s3 = v2body.indexOf("decidePatchV2({");
  const s4 = v2body.indexOf("setFeatureToggle(");
  const s5 = v2body.indexOf("buildAuditRow(");
  for (const [name, i] of [["structure", s1], ["signature", s2], ["decide", s3], ["apply", s4], ["row", s5]]) {
    assert.ok(i > 0, "the v2 helper is missing its " + name + " step");
  }
  assert.ok(s1 < s2, "a malformed v2 frame must never cost an Ed25519 verification");
  assert.ok(s2 < s3 && s3 < s4 && s4 < s5, "signature before verdict, verdict before effect, effect before the row");
  // M23 closed a loophole here: this rule used to be `indexOf("structural.ok") < s2`,
  // which an index of -1 satisfies - i.e. DELETING the condition passed the gate. Pin
  // the condition literally instead (§VACUITY-PROBES: an absence rule must be probed).
  const cond = v2body.indexOf("const check = structural.ok");
  assert.ok(cond > 0, "the crypto call must be gated on the structural result");
  assert.ok(cond < s2, "and that gate precedes the call");
  // ONE row builder for both schemes: the audit log's columns cannot fork
  assert.ok(v2body.includes("buildAuditRow("), "the v2 path must reuse patchCore's row builder");
  assert.ok(!/kind:\s*"patch"/.test(v2body), "no second audit-row shape in the v2 path");
  assert.ok(!core.includes("buildAuditRow"), "and the v2 core must not grow its own");

  // the refusal path is audited, not dropped, and applies nothing
  const refused = channel.split("async function ingestRefusedPatch")[1].split("\n}")[0];
  assert.ok(refused.includes('"rejected"'), "a refusal is recorded with the rejected verdict");
  assert.ok(refused.includes("buildAuditRow("), "and as a real audit row");
  assert.ok(!refused.includes("setFeatureToggle("), "a refusal must never touch the toggle map");

  // no new transport, no new storage, no code execution - F110's rules, re-applied to the new files
  for (const f of NEW_FILES) {
    const code = CODE(f);
    for (const banned of ["eval(", "new Function", "React.lazy"]) assert.ok(!code.includes(banned), f + ": forbidden capability " + banned);
    if (/\.(ts|tsx)$/.test(f)) assert.ok(!code.includes("import("), f + ": no dynamic import in the patch surface");
    assert.ok(!/\/ws\/patch|new WebSocket|EventSource/.test(code), f + ": F110b adds no transport");
  }
  for (const f of ["src/lib/livePatch/keys.ts", "src/lib/livePatch/signature.ts", "src/lib/livePatch/signatureCore.js"]) {
    assert.ok(!/localStorage|indexedDB|sessionStorage/.test(CODE(f)), f + ": no new persistence surface (F111's inventory is still 25)");
  }
  // the shipped verifier fails closed on every failure mode
  const sig = CODE("src/lib/livePatch/signature.ts");
  assert.ok(sig.includes('return { ok: false, reason: "crypto-unavailable" };'), "a missing subtle answers ok:false");
  const verifyFn = sig.split("export async function webCryptoVerifyEd25519")[1].split("let signatureProvider")[0];
  assert.ok(!/return \{ ok: true/.test(verifyFn.split("} catch {")[1] || ""), "the catch path must never answer ok:true");
  assert.ok(verifyFn.includes("ok === true ? { ok: true"), "only a real `true` from subtle.verify is accepted");
  assert.ok(sig.includes("export function setPatchSignatureProvider"), "the provider seam exists (tests, and hosts without Ed25519)");
  assert.ok(sig.includes("export function isDefaultSignatureProviderActive"), "and is assertable");
  // the pin has exactly the three sources the doc names, and refuses a conflict
  const keys = CODE("src/lib/livePatch/keys.ts");
  assert.equal((keys.match(/distinct\.length > 1/g) || []).length, 1, "two disagreeing sources are refused, not ranked");
  assert.ok(keys.includes('reason: "pin-conflict"'), "and the refusal is named");
  assert.match(keys, /export const PATCH_PUBLIC_KEY_B64 = "";/, "the pin ships EMPTY - inventing a key would create a trust anchor with no private key behind it");
  assert.ok(!keys.includes("fetch("), "the pin is never fetched: a pin that can be changed at runtime is not a pin");
});

// ---------------------------------------------------------------------------
// F110b-h: the footprint, and the doc's claims grep-checked against the tree.
// ---------------------------------------------------------------------------
test("F110b-h: 0 dependencies, 0 i18n keys, 24 storage surfaces, and the doc claims no emitter that does not exist", async () => {
  const pkg = readJson("package.json");
  assert.equal(Object.keys(pkg.dependencies).length, 8, "F110b adds no dependency - WebCrypto/node:crypto do the Ed25519");
  assert.equal(Object.keys(pkg.devDependencies).length, 21, "no dev dependency added");
  for (const banned of ["jose", "tweetnacl", "ed25519", "libsodium", "noble"]) {
    assert.ok(!(banned in pkg.dependencies) && !(banned in pkg.devDependencies), "unneeded crypto dependency appeared: " + banned);
  }
  const lock = read("tests/f-i18n-parity.test.js").match(/const EXPECTED_FLAT_KEYS = (\d+)/);
  assert.equal(Number(lock[1]), 1074, "a default-off developer surface moves no i18n lock (moved for #211/#212/#216 and again for R-GLASS #213/#214)");
  assert.ok(!/\bt\(/.test(CODE("src/components/livePatch/PatchAuditPanel.tsx")), "the panel stays English-only while the lock says 1074");

  // no new persistence: F111's derived diff, re-run against THIS tree
  const inv = readJson("src/lib/ci/storageInventory.json");
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
  assert.deepEqual(diff.undeclared, [], "a new surface must be declared");
  assert.deepEqual(diff.stale, [], "no declared key without a call site");
  // [M4] 25 at F110b; M4 deleted the ghrdp-dash-token dead read, so 24. F110b itself adds no surface.
  assert.equal(scan.keys.length, 24, "F110b adds no storage surface: 24 after M4 removed the dead read");

  // the panel tells the operator which scheme this build accepts (§EMPTY-STATE-HANDLING)
  const panel = CODE("src/components/livePatch/PatchAuditPanel.tsx");
  for (const id of ["settings-live-patch-signer", "settings-live-patch-signer-chip"]) {
    assert.ok(panel.includes(id), "unaddressable control: " + id);
  }
  assert.ok(panel.includes("no-signer-pin") && panel.includes("legacy-mac-refused"), "the card names both refusals instead of implying every signed frame applies");
  assert.ok(panel.includes("signerPinStatus()"), "and reads the pin through the lib");

  // §GREP-CHECK-DESIGN-BEFORE-SHIP, as a gate: the doc's two production claims must be
  // true of the tree on every run, so the doc cannot age into a promise.
  const server = read("payloads/ghrdp-server.ps1");
  assert.equal((server.match(/"type"\s*:\s*"patch"|patchFrame|SendPatch|livePatch/g) || []).length, 0, "the /ws server still has no patch emitter");
  assert.equal((server.match(/Send-F99WsText /g) || []).length, 6, "1 definition + 5 send sites (diagInit, hello-ack, echo, diag2, ping)");
  assert.ok(server.includes("function Invoke-F99WebSocketUpgrade"), "positive control: /ws is served from this file");
  const handlerDir = fs.readdirSync(abs("payloads/ghrdp-handler")).sort();
  assert.deepEqual(handlerDir, ["GhrdpHandler.csproj", "Program.cs"], "the handler is a .NET console app, not a server");
  assert.ok(read("payloads/ghrdp-handler/Program.cs").includes("ghrdp:connect?rid="), "positive control: it is the desktop URI handler");
  const doc = read("docs/F110B-SIGNING.md");
  assert.ok(doc.includes("There is no patch emitter"), "the doc must say the emitter does not exist");
  assert.ok(doc.includes("payloads/ghrdp-server.ps1"), "and must name the file that owns /ws");
  assert.ok(doc.includes("ghrdp:connect?rid="), "and must say what the handler really is");
  assert.ok(doc.includes("do not pin a key in production yet"), "and must tell the operator not to pin before an emitter exists");
  assert.ok(doc.includes("sig-crypto-unavailable"), "and must explain the broken-verify refusal");
  assert.ok(!/window\.__ghrdpPatchChannel|PatchSurfaceBoundary|useLivePatch\.ts/.test(doc), "no invented API surface in the doc (the four claims step 9 dropped after grep)");

  // the ledger/growth invariants step 10 built are untouched by a maintenance step
  assert.deepEqual(inv.postInventoryGrowth.F110, ["f110:armed", "ghrdp-patches"]);
  const registry = readJson("src/lib/feature-registry.json");
  assert.equal(registry.features.length, 11, "no 12th section was invented for the signature surface");
});

// ---------------------------------------------------------------------------
// F110b-i: the operator's tool, executed, and the runtime fact the design rests on.
// ---------------------------------------------------------------------------
test("F110b-i: the shipped signer signs a frame the shipped core accepts, and a broken WebCrypto verify fails closed", async () => {
  const c = sigCore || (await importSig());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f110b-"));
  const keyPath = path.join(tmp, "signer.pem");
  const script = abs("scripts/f110b-sign-patch.mjs");

  // 1. genkey: prints a pin the shipped parser accepts, and writes outside the repo only
  const gen = execFileSync(process.execPath, [script, "--genkey", keyPath], { encoding: "utf8" });
  const pin = (gen.match(/\n  ([A-Za-z0-9+/]{43}=)\n/) || [])[1];
  assert.ok(pin, "genkey must print a 44-char pin");
  assert.equal(c.parsePinnedPublicKey(pin).ok, true, "the pin the operator is told to commit must parse with the shipped parser");
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600, "the private key file is 0600");
  let refusedInRepo = "";
  try {
    execFileSync(process.execPath, [script, "--genkey", abs("leaked-key.pem")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    refusedInRepo = String(e.status);
  }
  assert.equal(refusedInRepo, "1", "genkey must refuse to write a private key inside the work tree");
  assert.ok(!fs.existsSync(abs("leaked-key.pem")), "and must not have written one");

  // 2. sign: the frame the operator would broadcast verifies against its own pin
  const out = execFileSync(process.execPath, [script, "--key", keyPath, "--feature", "keys", "--op", "toggle-off", "--id", "f110b-gate-1", "--ttl", "60000"], { encoding: "utf8" });
  const frameLine = out.split("\n").find((l) => l.startsWith("{"));
  assert.ok(frameLine, "the signer must print the wire frame");
  const frame = JSON.parse(frameLine);
  const structural = c.verifyPatchV2Frame(frame, { knownFeatures: ["keys"] });
  assert.equal(structural.ok, true, "the signed frame must satisfy the shipped structural verifier: " + structural.reason);
  fs.writeFileSync(path.join(tmp, "f.json"), frameLine);
  const ok = execFileSync(process.execPath, [script, "--verify", path.join(tmp, "f.json"), "--pin", pin], { encoding: "utf8" });
  assert.ok(ok.includes("VERIFY: PASS"), "the signer and the verifier agree on the bytes");
  // the canonical string the tool signs is the one the core produces (no second implementation)
  const canonicalOut = execFileSync(process.execPath, [script, "--canonical", path.join(tmp, "f.json")], { encoding: "utf8" }).trim();
  assert.equal(canonicalOut, c.canonicalPatchV2(frame), "the tool canonicalizes by importing the shipping core");
  // a wrong pin fails, and the exit code says so
  const wrongPin = Buffer.alloc(32, 7).toString("base64");
  let code = 0;
  try {
    execFileSync(process.execPath, [script, "--verify", path.join(tmp, "f.json"), "--pin", wrongPin], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2, "a wrong pin must exit 2");

  // 3. the runtime fact. Measured, not asserted from memory: node's WEBCRYPTO Ed25519
  // verify is the broken half on this build, while its sign is correct. If a future
  // node fixes it, this test still passes - it asserts the SHIPPED consequence either way.
  const subtle = webcrypto.subtle;
  const v = RFC[0];
  const priv = await subtle.importKey("pkcs8", Buffer.concat([PKCS8_PREFIX, hex(v.sk)]), { name: "Ed25519" }, false, ["sign"]);
  const produced = Buffer.from(await subtle.sign({ name: "Ed25519" }, priv, Buffer.from(v.msg, "hex"))).toString("hex");
  assert.equal(produced, v.sig, "subtle.sign reproduces RFC 8032 vector 1 - the primitive is present");
  const pub = await subtle.importKey("raw", hex(v.pk), { name: "Ed25519" }, false, ["verify"]);
  const webcryptoVerifyWorks = await subtle.verify({ name: "Ed25519" }, pub, Buffer.from(v.msg, "hex"), hex(v.sig));
  assert.equal(typeof webcryptoVerifyWorks, "boolean", "subtle.verify must at least answer a boolean");
  assert.equal(
    nodeVerify(null, Buffer.from(v.msg, "hex"), createPublicKey({ key: spkiOf(v.pk), format: "der", type: "spki" }), hex(v.sig)),
    true,
    "node:crypto verifies the same vector - so a `false` above is the webcrypto binding, not the signature"
  );
  if (!webcryptoVerifyWorks) {
    process.stdout.write("# F110b-i: node " + process.version + " webcrypto Ed25519 verify returns false for RFC 8032 vector 1 (sign is correct) - fail-closed is load-bearing here\n");
  }
  // and the decision the client would reach in such a runtime, through the shipping core:
  // a genuine, validly signed frame is REFUSED, and named as a support gap
  const live = v2Frame();
  const decided = c.decidePatchV2({
    frame: live,
    now: NOW,
    knownFeatures: ["mirror"],
    pinOk: true,
    sigVerified: webcryptoVerifyWorks
      ? { ok: nodeVerifyB64(c.canonicalPatchV2(live), live.sig, operatorKey().pin), reason: "" }
      : { ok: false, reason: "crypto-unavailable" },
  });
  if (webcryptoVerifyWorks) assert.equal(decided.verdict, "applied", "a working verifier applies the frame");
  else {
    assert.equal(decided.verdict, "rejected", "a broken verifier must refuse, never accept");
    assert.equal(decided.reason, "sig-crypto-unavailable", "and must not blame the operator's key");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
