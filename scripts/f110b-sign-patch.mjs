#!/usr/bin/env node
// [F110b / maintenance step M1] The operator's patch signer.
//
// WHY THIS FILE EXISTS. The dashboard half of F110b verifies an Ed25519 signature
// against a pinned public key; somebody has to hold the matching private key and
// produce frames with it. That somebody is the operator, off-box - never the
// browser, never the repo. This script is the smallest honest version of that:
// it generates a keypair on request, signs a v2 frame, and verifies one, and it
// canonicalizes by IMPORTING the shipping core (src/lib/livePatch/signatureCore.js)
// so the signer and the verifier cannot drift apart on the bytes they sign.
//
// WHAT IT CANNOT DO: broadcast. There is no patch emitter in this repo - the `/ws`
// server is payloads/ghrdp-server.ps1 (F99's upgrade lane, which pushes diag and
// ping frames only) and payloads/ghrdp-handler/ is the Windows `ghrdp:connect`
// URI handler. Until a broadcaster exists, a signed frame is delivered by hand
// (see docs/F110B-SIGNING.md §4). Zero dependencies: node:crypto only.
//
// Usage:
//   node scripts/f110b-sign-patch.mjs --genkey <path.pem>
//   node scripts/f110b-sign-patch.mjs --key <path.pem> --feature <id> --op toggle-off|toggle-on [--id <id>] [--ttl <ms>]
//   node scripts/f110b-sign-patch.mjs --verify <frame.json> --pin <base64-public-key>
//   node scripts/f110b-sign-patch.mjs --canonical <frame.json>
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PATCH_ED25519_SIGNATURE_BYTES,
  PATCH_SIG_ALG,
  PATCH_SCHEMA_VERSION_V2,
  canonicalPatchV2,
  parsePinnedPublicKey,
  pinFingerprint,
  verifyPatchV2Frame,
} from "../src/lib/livePatch/signatureCore.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function fail(msg) {
  process.stderr.write("f110b: " + msg + "\n");
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail("--" + name + " needs a value");
  return v;
}

const has = (name) => process.argv.indexOf("--" + name) >= 0;

/** The 32 raw public bytes of an Ed25519 key: SPKI minus its 12-byte RFC 8410 header. */
function rawPublicKeyBytes(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  if (raw.length !== 32) fail("unexpected SPKI shape: " + spki.length + " bytes");
  return Buffer.from(raw);
}

function knownFeatures() {
  try {
    const reg = JSON.parse(readFileSync(join(ROOT, "src/lib/feature-registry.json"), "utf8"));
    return reg.features.map((f) => f.id);
  } catch {
    return [];
  }
}

/** Refuse to write a private key inside the repo: a committed key is a breach, not a config. */
function assertOutsideRepo(target) {
  let dir = dirname(resolve(target));
  for (;;) {
    try {
      readFileSync(join(dir, ".git"), "utf8");
      fail("refusing to write a private key inside a git work tree: " + target);
    } catch (e) {
      if (e && e.code === "EISDIR") fail("refusing to write a private key inside a git work tree: " + target);
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function doGenkey() {
  const out = arg("genkey");
  if (!out) fail("--genkey needs a destination path for the PKCS#8 PEM");
  assertOutsideRepo(out);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(out, pem, { mode: 0o600 });
  try {
    chmodSync(out, 0o600);
  } catch {
    /* windows: the mode is advisory */
  }
  const pin = rawPublicKeyBytes(publicKey).toString("base64");
  const parsed = parsePinnedPublicKey(pin);
  if (!parsed.ok) fail("generated a pin the verifier would refuse (" + parsed.reason + ") - that is a bug, report it");
  process.stdout.write(
    [
      "private key (PKCS#8 PEM, mode 0600): " + resolve(out),
      "  keep it off this machine's repo, off Pages, and out of any CI variable that a",
      "  workflow can print. Losing it means re-pinning; leaking it means anyone can patch.",
      "",
      "public pin (44 chars of standard base64):",
      "  " + pin,
      "  fingerprint: " + pinFingerprint(pin) + "…",
      "",
      "pin it in ONE of these two places (not both with different values - that is",
      "refused as pin-conflict):",
      "  build variable:  VITE_PATCH_PUBLIC_KEY=" + pin + " pnpm build",
      "  or source:       PATCH_PUBLIC_KEY_B64 in src/lib/livePatch/keys.ts",
      "",
      "pinning changes behaviour immediately: v1 HMAC frames start being refused as",
      "legacy-mac-refused. Do not pin until you can sign (see --key below).",
      "",
    ].join("\n")
  );
}

function loadPrivateKey(pemPath) {
  let pem;
  try {
    pem = readFileSync(pemPath, "utf8");
  } catch (e) {
    fail("cannot read the private key: " + e.message);
  }
  try {
    return createPrivateKey({ key: pem, format: "pem" });
  } catch (e) {
    fail("not a readable PEM private key: " + e.name);
  }
}

function doSign() {
  const keyPath = arg("key");
  const feature = arg("feature");
  const op = arg("op");
  if (!keyPath) fail("--key <path.pem> is required to sign");
  if (!feature) fail("--feature <id> is required (one of the 11 registry ids)");
  if (["toggle-off", "toggle-on"].indexOf(op) < 0) fail('--op must be "toggle-off" or "toggle-on"');
  const ids = knownFeatures();
  if (ids.length > 0 && ids.indexOf(feature) < 0) {
    fail("unknown feature '" + feature + "'. Known: " + ids.join(", "));
  }
  const now = Date.now();
  const ttl = Number(arg("ttl", "60000"));
  if (!Number.isFinite(ttl) || ttl <= 0) fail("--ttl must be a positive number of ms");
  // The replay window the client enforces is 120s (PATCH_V2_MAX_AGE_MS); a longer ttl
  // only widens how long a captured frame stays replayable, so warn instead of hiding it.
  const frame = {
    v: PATCH_SCHEMA_VERSION_V2,
    sigAlg: PATCH_SIG_ALG,
    type: "patch",
    id: arg("id", "patch-" + new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "")),
    op,
    feature,
    ts: now,
    exp: now + ttl,
  };
  const canonical = canonicalPatchV2(frame);
  const sig = nodeSign(null, Buffer.from(canonical, "utf8"), loadPrivateKey(keyPath));
  if (sig.length !== PATCH_ED25519_SIGNATURE_BYTES) fail("signer produced " + sig.length + " bytes, expected 64");
  const wire = Object.assign({}, frame, { sig: sig.toString("base64") });
  const check = verifyPatchV2Frame(wire, { now, knownFeatures: ids.length > 0 ? ids : [feature] });
  if (!check.ok) fail("signed a frame the shipped structural verifier refuses: " + check.reason);
  process.stdout.write(
    [
      "canonical (the exact bytes that were signed):",
      "  " + canonical,
      "",
      "frame (one /ws text message, no transport of its own):",
      JSON.stringify(wire),
      "",
      ttl > 120000
        ? "WARNING: ttl " + ttl + "ms exceeds the 120000ms replay window the client enforces - the frame will be refused as expired."
        : "note: the client refuses a frame older than 120000ms, so broadcast promptly.",
      "",
    ].join("\n")
  );
}

function doVerify() {
  const framePath = arg("verify");
  const pin = arg("pin");
  if (!framePath) fail("--verify <frame.json> is required");
  if (!pin) fail("--pin <base64-public-key> is required");
  const parsedPin = parsePinnedPublicKey(pin);
  if (!parsedPin.ok) fail("pin refused: " + parsedPin.reason + " (44 chars of standard base64, 32 raw bytes)");
  let frame;
  try {
    frame = JSON.parse(readFileSync(framePath, "utf8"));
  } catch (e) {
    fail("cannot read the frame: " + e.message);
  }
  const structural = verifyPatchV2Frame(frame, { knownFeatures: knownFeatures() });
  if (!structural.ok) fail("structure refused: " + structural.reason);
  const canonical = canonicalPatchV2(frame);
  const pub = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(parsedPin.b64, "base64")]),
    format: "der",
    type: "spki",
  });
  const ok = nodeVerify(null, Buffer.from(canonical, "utf8"), pub, Buffer.from(frame.sig, "base64"));
  process.stdout.write(
    [
      "canonical: " + canonical,
      "pin: " + parsedPin.b64 + "  (" + pinFingerprint(parsedPin.b64) + "…)",
      ok ? "VERIFY: PASS - this frame would apply on a build pinned to this key" : "VERIFY: FAIL - signature does not match this pin",
      // The honest caveat, measured on the machine that wrote this file: node:crypto's
      // verify is correct on Node 22 while node's WEBCRYPTO verify is not (it returns
      // false for RFC 8032's own vector). A browser must be checked in the browser.
      "note: verified with node:crypto, not WebCrypto - confirm in the operator's browser before trusting a rollout.",
      "",
    ].join("\n")
  );
  if (!ok) process.exit(2);
}

function doCanonical() {
  const framePath = arg("canonical");
  if (!framePath) fail("--canonical <frame.json> is required");
  let frame;
  try {
    frame = JSON.parse(readFileSync(framePath, "utf8"));
  } catch (e) {
    fail("cannot read the frame: " + e.message);
  }
  process.stdout.write(canonicalPatchV2(frame) + "\n");
}

if (has("genkey")) doGenkey();
else if (has("key")) doSign();
else if (has("verify")) doVerify();
else if (has("canonical")) doCanonical();
else {
  process.stdout.write(
    [
      "F110b patch signer (operator, off-box). No dependency but node:crypto.",
      "",
      "  --genkey <path.pem>            generate an Ed25519 keypair, print the public pin",
      "  --key <pem> --feature <id> --op toggle-off|toggle-on [--id <id>] [--ttl <ms>]",
      "                                 sign one v2 frame and print it",
      "  --verify <frame.json> --pin <b64>",
      "                                 check a frame against a pin (exit 2 on FAIL)",
      "  --canonical <frame.json>       print the exact bytes the signature covers",
      "",
      "There is no --broadcast: this repo has no patch emitter. See docs/F110B-SIGNING.md.",
      "",
    ].join("\n")
  );
}
