// [F-DVR-LITE / Observatory step 3] The DVR gate: option (d) of #169, pinned in bytes
// AND exercised for real.
//
// Why this file has two halves. The static half pins the wiring (which file does
// what, what must NOT appear in it). The behavioural half imports the shipped ring
// CORE - src/lib/dvr-core.js is plain JS precisely so this job can drive it with no
// DOM and no bundler - and proves the retention window, the entry cap, the bundle
// shape and the paste envelope actually behave as the panel claims.
//
// The three properties this gate exists to defend:
//   1. NOTHING LEAVES THE MACHINE. The DVR files may not contain a network or
//      storage API at all. Option (d) is "no upload": the bundle is copied by the
//      operator and pasted into Arena, and that is the only egress.
//   2. F104 IS EXTENDED, NEVER REPLACED. main.tsx builds the same recorder object it
//      always did and hands `installDvr(recorder)` to `installGlobalClickCapture`; the
//      DVR adds no second click listener and no fork of the capture module.
//   3. THE PAYLOAD IS WHAT THE PANEL SAYS IT IS - the entry counts come from the ring
//      the panel renders, the codec tag travels inside the envelope, and the format
//      is one parseable line.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");

const CORE = read("src/lib/dvr-core.js");
const DVR = read("src/lib/dvr.ts");
const FAB = read("src/components/domain/DvrFab.tsx");
const MAIN = read("src/main.tsx");
const APP = read("src/App.tsx");
const I18N_PARITY = read("tests/f-i18n-parity.test.js");
const CAPTURE = read("src/lib/globalClickCapture.ts");
const EN = JSON.parse(read("src/i18n/en.json"));
const SI = JSON.parse(read("src/i18n/si.json"));

/** Every DVR-authored file: the three below are the whole surface. */
const DVR_FILES = [
  ["src/lib/dvr-core.js", CORE],
  ["src/lib/dvr.ts", DVR],
  ["src/components/domain/DvrFab.tsx", FAB],
];

/** The file's ACTIONS, not its prose: a comment that says "no fetch anywhere" must
 *  not fail a gate that forbids fetch. Block comments go first, then whole-line
 *  comments, then trailing ones - while leaving URLs ("https://...") intact. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line.replace(/(^|[^:])\/\/.*$/, "$1")))
    .join("\n");
}
const CORE_CODE = code(CORE);
const DVR_CODE = code(DVR);
const FAB_CODE = code(FAB);
const MAIN_CODE = code(MAIN);

let corePromise = null;
function core() {
  if (!corePromise) corePromise = import(path.join(ROOT, "src/lib/dvr-core.js"));
  return corePromise;
}

test("F-DVR-a: the ring constants are the ones #168 re-derived (30 s, 200 entries, mcrec v1)", () => {
  assert.ok(CORE.includes('export const DVR_FORMAT = "mcrec"'), "the envelope tag drifted");
  assert.ok(CORE.includes("export const DVR_VERSION = 1"), "the bundle version drifted");
  assert.ok(CORE.includes("export const DVR_WINDOW_MS = 30_000"), "the DVR window is 30 s (NOT F104's 10 s observation window)");
  assert.ok(CORE.includes("export const DVR_MAX_ENTRIES = 200"), "the entry cap is the second eviction direction");
  assert.ok(DVR.includes("createRing({ windowMs: DVR_WINDOW_MS, maxEntries: DVR_MAX_ENTRIES })"), "the singleton must be built from the pinned constants");
});

test("F-DVR-b: the ring drops what is older than the window (behavioural, real import)", async () => {
  const { createRing, DVR_WINDOW_MS } = await core();
  const ring = createRing({ windowMs: DVR_WINDOW_MS, maxEntries: 200 });
  const t0 = 1_000_000;
  ring.push({ kind: "click", id: "a" }, t0);
  ring.push({ kind: "click", id: "b" }, t0 + 20_000);
  // 31 s after the first click: the first is out of the window, the second is not.
  const list = ring.list(t0 + 31_000);
  assert.deepEqual(
    list.map((e) => e.id),
    ["b"],
    "the window must evict by AGE - a stale click in a fresh bundle is a lie about the repro"
  );
  assert.equal(ring.size(t0 + 51_000), 0, "an idle tab must drain to empty, not keep the last click forever");
});

test("F-DVR-c: the ring drops the OLDEST entries when a click storm exceeds the cap (behavioural)", async () => {
  const { createRing } = await core();
  const ring = createRing({ windowMs: 30_000, maxEntries: 200 });
  for (let i = 1; i <= 300; i++) ring.push({ kind: "click", id: "c" + i }, 2_000_000 + i);
  const list = ring.list(2_000_400);
  assert.equal(list.length, 200, "the cap must bind regardless of the time window");
  assert.equal(list[0].id, "c101", "the survivors must be the NEWEST 200");
  assert.equal(list[list.length - 1].id, "c300", "the newest entry is always kept");
  assert.equal(list[0].seq, 101, "sequence numbers are global, so a bundle can be proven to be a suffix");
});

test("F-DVR-d: the bundle is one parseable shape with honest counts (behavioural)", async () => {
  const { createRing, buildBundle, bundleText, ringStats } = await core();
  const ring = createRing({ windowMs: 30_000, maxEntries: 200 });
  ring.push({ kind: "click", id: "x", testId: "overview-auto-login" }, 5_000);
  ring.push({ kind: "route", to: "#/mirror" }, 6_000);
  ring.push({ kind: "settle", id: "x", verdict: "ok" }, 9_000);
  const entries = ring.list(9_500);
  const bundle = buildBundle(
    entries,
    { route: "#/mirror", buildSha: "abc1234", lang: "si", ui: "v2" },
    { now: 9_500, windowMs: 30_000, maxEntries: 200 }
  );
  assert.equal(bundle.format, "mcrec", "format tag missing");
  assert.equal(bundle.version, 1, "version missing");
  assert.equal(bundle.createdAt, new Date(9_500).toISOString(), "createdAt must be the injected clock, never a hidden one");
  assert.deepEqual(bundle.target, { route: "#/mirror", buildSha: "abc1234", lang: "si", ui: "v2" }, "target drifted");
  assert.deepEqual(bundle.counts.byKind, { click: 1, route: 1, settle: 1 }, "per-kind counts drifted");
  assert.equal(bundle.counts.count, 3, "count drifted");
  assert.equal(bundle.counts.spanMs, 4_000, "span drifted");
  assert.equal(bundle.entries.length, 3, "entries must pass through");
  // The target is deliberately NOT a machine fingerprint: exactly these four keys,
  // and nothing about the device, the window, or the locale beyond the language.
  assert.deepEqual(Object.keys(bundle.target).sort(), ["buildSha", "lang", "route", "ui"], "the target keys are a closed set");
  for (const forbidden of ['"userAgent"', '"screen"', '"platform"', '"timezone"', '"deviceId"']) {
    assert.ok(!CORE_CODE.includes(forbidden), "the bundle target must not carry " + forbidden);
  }
  // round-trip: what the writer emits is what a reader gets back
  const parsed = JSON.parse(bundleText(bundle));
  assert.deepEqual(parsed, bundle, "the pasted JSON must parse back to the same object");
  assert.equal(ringStats([]).count, 0, "an empty ring is a valid bundle, not a crash");
});

test("F-DVR-e: the paste envelope round-trips and refuses junk (behavioural)", async () => {
  const { encodeEnvelope, decodeEnvelope, toBase64, fromBase64 } = await core();
  const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 7]);
  const b64 = toBase64(bytes);
  assert.equal(typeof b64, "string");
  assert.deepEqual(Array.from(fromBase64(b64)), Array.from(bytes), "base64 must round-trip arbitrary bytes");
  assert.equal(toBase64(new Uint8Array(0)), "", "empty in, empty out");
  const text = encodeEnvelope("gzip", b64);
  assert.ok(text.startsWith("mcrec1:gzip:"), "the envelope must carry the format AND the codec: " + text.slice(0, 24));
  const back = decodeEnvelope(text);
  assert.ok(back, "a well-formed envelope must decode");
  assert.equal(back.codec, "gzip", "codec must survive the round trip");
  assert.deepEqual(Array.from(back.bytes), Array.from(bytes), "payload must survive the round trip");
  // Falsification: a reader must not crash on a partial paste. A long base64 line
  // WILL be truncated by a chat client at some point, and it must read as "not a
  // bundle", never as an exception inside the reader.
  for (const junk of ["", "not a bundle", "mcrec2:gzip:" + b64, "mcrec1:zstd:" + b64, "mcrec1:gzip:!!!", "mcrec1:gzip"]) {
    assert.equal(decodeEnvelope(junk), null, "malformed input must decode to null: " + JSON.stringify(junk));
  }
  assert.equal(decodeEnvelope(encodeEnvelope("plain", toBase64(bytes))).codec, "plain", "the plain codec must be a first-class citizen (jsdom, older Safari)");
});

test("F-DVR-f: NOTHING LEAVES THE MACHINE - no network, no storage, no upload route in any DVR file", () => {
  const banned = [
    "fetch(",
    "XMLHttpRequest",
    "sendBeacon",
    "WebSocket",
    "EventSource",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "navigator.sendBeacon",
    "diag-upload",
    "f-dvr",
    "ipcRenderer",
  ];
  const offenders = [];
  for (const [name, text] of DVR_FILES) {
    const body = code(text);
    for (const token of banned) {
      if (body.includes(token)) offenders.push(name + " contains " + token);
    }
  }
  assert.deepEqual(offenders, [], "option (d) of #169 is 'no upload at all': " + offenders.join(" | "));
  // The ONLY egress is the operator's clipboard, and it goes through the F27 primitive.
  assert.ok(FAB.includes('import { copyText } from "@/lib/clipboard";'), "the FAB must copy through lib/clipboard");
  assert.ok(FAB.includes("await copyText("), "the FAB must call copyText");
  assert.ok(!FAB.includes("navigator.clipboard"), "never touch the raw clipboard API: lib/clipboard owns the fallback chain");
  // ...and no DVR file may import an API client.
  for (const [name, text] of DVR_FILES) {
    const body = code(text);
    assert.ok(!/from "@\/lib\/api"/.test(body) && !/from "@\/api\//.test(body), name + " must not import an API client");
  }
});

test("F-DVR-g: no DOM content is captured - the mutation observer counts, it does not read", () => {
  for (const forbidden of ["innerHTML", "outerHTML", "textContent", "cloneNode", "querySelector", "getAttribute"]) {
    assert.ok(!DVR_CODE.includes(forbidden), "dvr.ts must not read DOM content (" + forbidden + ") - that is F107's deliberate, separate scope");
  }
  assert.ok(DVR.includes("new MutationObserver("), "the DOM-churn counter must be a real observer");
  assert.ok(DVR.includes("mutations += records.length"), "the observer may only COUNT records");
  assert.ok(DVR.includes("{ childList: true, subtree: true, characterData: true, attributes: true }"), "the observed option set is pinned");
  // The recorder itself must describe only what F104 already described.
  for (const field of ["testId", "label", "tag", "path"]) {
    assert.ok(DVR.includes(field + ": String(params." + field), "the click entry must copy F104's field " + field);
  }
  assert.ok(CORE.includes("The target is intentionally NOT the user agent") || DVR.includes("no DOM content capture"), "the privacy rationale must stay in the source");
});

test("F-DVR-h: F104 is EXTENDED, never replaced - one click listener, one recorder, killable", () => {
  assert.ok(DVR.includes("export function installDvr(inner: GlobalClickRecorder"), "installDvr must DECORATE the injected recorder");
  assert.ok(DVR.includes("inner.record(rec)") && DVR.includes("inner.update(id, patch)"), "the inner recorder must still receive every call verbatim");
  assert.ok(!DVR_CODE.includes('document.addEventListener("click"'), "the DVR must not install a second click listener");
  assert.ok(!DVR_CODE.includes("installGlobalClickCapture"), "dvr.ts must not reach into the capture module");
  assert.ok(!DVR_CODE.includes("GLOBAL_CLICK_IGNORE"), "the DVR must not edit F104's ignore list");
  assert.ok(MAIN.includes("installGlobalClickCapture(installDvr(recorder, { enabled:"), "main.tsx must hand the DECORATED recorder to F104");
  assert.ok(MAIN.includes('import.meta.env.VITE_DVR_ENABLED !== "false"'), "the DVR needs its own kill flag");
  assert.ok(MAIN.includes("installDvrObservers()"), "the route/DOM observers must be installed");
  // The kill flag must actually kill: disabled => the inner recorder is still used.
  assert.ok(DVR.includes("recording = opts?.enabled !== false"), "the enabled flag must default to on");
  assert.ok(DVR.includes("if (!recording) return;"), "a paused DVR must stop growing");
  // The codec tag is DERIVED from whether compression actually happened. A plain
  // payload labelled "gzip" is an envelope that lies to the reader (it would try to
  // gunzip raw JSON) - the worst failure mode this feature has, because it is
  // silent. The DOM gate proves the behaviour; this pin keeps the derivation in the
  // source even if that test is ever refactored.
  assert.ok(DVR.includes('const codec: DvrCodec = gz ? "gzip" : "plain";'), "the codec tag must be derived, never assumed");
  assert.ok(DVR.includes("toBase64(gz || raw)"), "the payload must be the compressed bytes when they exist, the raw bytes otherwise");
  assert.ok(DVR.includes('typeof CompressionStream === "undefined" ? null'), "a host without CompressionStream must take the plain path, not throw");
});

test("F-DVR-i: the panel is chrome in App.tsx and its button is addressable", () => {
  assert.ok(APP.includes('import { DvrFab } from "@/components/domain/DvrFab";'), "App.tsx must import the FAB");
  assert.ok(APP.includes("<DvrFab />"), "App.tsx must mount the FAB");
  assert.ok(APP.includes("<CollectorRunBridge />") && APP.indexOf("<CollectorRunBridge />") < APP.indexOf("<DvrFab />"), "the FAB mounts with the existing chrome (after the F102 bridge)");
  assert.ok(FAB.includes("<Modal"), "the panel must reuse the Modal primitive (focus trap + Escape for free)");
  assert.ok(FAB.includes("useSyncExternalStore(subscribeDvr, dvrSnapshot, dvrSnapshot)"), "the FAB must subscribe to the ring, not poll it");
  const ids = [...FAB.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, "the panel must stay addressable (found " + ids.length + " testids)");
  for (const want of ["dvr-fab", "dvr-fab-count", "dvr-panel", "dvr-privacy", "dvr-preview", "dvr-copied", "dvr-empty", "dvr-record-toggle"]) {
    assert.ok(ids.includes(want), "missing testid " + want);
  }
  assert.equal(new Set(ids).size, ids.length, "duplicate testids make a selector ambiguous");
});

test("F-DVR-j: the FAB is INSIDE the capture (so a DVR click is recorded), and F104's blind spot is untouched", () => {
  // dvr-* is deliberately NOT in GLOBAL_CLICK_IGNORE: clicking the FAB is real user
  // behaviour and must appear in the ring it opens. That is the live-liveness proof.
  for (const prefix of ["collector-", "click-now-"]) {
    assert.ok(CAPTURE.includes("[data-testid^='" + prefix + "']"), "F104's ignore list changed - re-derive this gate, never delete it");
  }
  assert.ok(!CAPTURE.includes("dvr-"), "the DVR must never be added to F104's ignore list");
  for (const prefix of ["dvr-"]) {
    assert.ok(!CAPTURE.includes("'" + prefix + "'"), "the DVR testids must not appear in the capture module");
  }
});

test("F-DVR-k: every dvr.* string exists in BOTH catalogs, with the same placeholders, and the count lock moved with it", () => {
  const dvrKeys = Object.keys(EN.dvr || {}).sort();
  assert.ok(dvrKeys.length >= 20, "the panel is t()-driven; found only " + dvrKeys.length + " keys");
  assert.deepEqual(dvrKeys, Object.keys(SI.dvr || {}).sort(), "si.json must carry the identical dvr key set");
  const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join(",");
  for (const k of dvrKeys) {
    assert.equal(ph(EN.dvr[k]), ph(SI.dvr[k]), "placeholder mismatch for dvr." + k);
    assert.ok(String(SI.dvr[k]).trim().length > 0, "empty si translation for dvr." + k);
  }
  // The parity gate's count lock is a PIN against silent catalog edits. Adding keys
  // without moving the lock must fail HERE, in a file that explains why.
  const flat = (o, p = "") =>
    Object.entries(o).reduce((acc, [k, v]) => Object.assign(acc, v && typeof v === "object" ? flat(v, p + k + ".") : { [p + k]: v }), {});
  const expected = Number((I18N_PARITY.match(/const EXPECTED_FLAT_KEYS = (\d+)/) || [])[1]);
  const enCount = Object.keys(flat(EN)).length;
  const siCount = Object.keys(flat(SI)).length;
  assert.equal(enCount === expected && siCount === expected, true, "EXPECTED_FLAT_KEYS (" + expected + ") must equal the real flat key count (en " + enCount + " / si " + siCount + ")");
  assert.equal(enCount, siCount, "en/si must stay the same size");
  // Every key the panel asks for must exist - the step-2 lesson, applied to the DVR.
  const used = [...FAB.matchAll(/\bt\(\s*"([^"]+)"|t\("([^"]+)"/g)].map((m) => m[1] || m[2]);
  for (const key of used) {
    assert.ok(key in flattenKey(EN), "the FAB calls t(\"" + key + "\") but en.json has no such key");
    assert.ok(key in flattenKey(SI), "the FAB calls t(\"" + key + "\") but si.json has no such key");
  }
});

function flattenKey(obj, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = (prefix ? prefix + "." : "") + k;
    if (v && typeof v === "object") Object.assign(out, flattenKey(v, key), { [key]: true });
    else out[key] = true;
  }
  return out;
}
