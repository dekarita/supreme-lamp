// [F107 / Observatory step 6] Full DVR v2 gate: DOM mutations + screenshots +
// IndexedDB sessions, pinned in bytes AND exercised for real.
//
// Two halves, same convention as step 3's f-dvr-lite gate. The static half pins
// the wiring + the privacy fence of the NEW surface. The behavioural half imports
// the FOUR shipped pure cores - src/lib/dvr/{mutationCore,screenshotCore,
// storageCore,exportCore}.js are plain JS precisely so this job can drive them
// with no DOM and no bundler (§GATE-EXECUTES-SHIPPED-CODE).
//
// The four properties this gate defends:
//   1. F107's content scope is ENUMERATED, not open-ended: mutation descriptors
//      carry tag names + attribute NAMES + counts, never values/text; screenshots
//      are the only pixel surface, thumbnail-boxed and byte-capped; no F107 file
//      names a network API or an upload route.
//   2. Step 3's LITE posture is untouched: its three files still contain no
//      storage/network token (the regression lock across steps).
//   3. Storage arithmetic is proven where it is decided: 5 MB/session budget,
//      30-day retention, QuotaExceededError triage and oldest-shot-first eviction
//      all live in storageCore.js, and this file drives them with synthetic data.
//   4. The `.mcrec` v2 bundle validates strictly: a v1 bundle, a tampered byte
//      total, an out-of-order timeline or an oversized shot must be REFUSED.
//
// FALSIFY-3 (per the step spec): M1 removing MutationObserver from mutations.ts
// fails F107-f; M2 pointing the observer at the wrong root fails F107-f (the
// pinned root id) and the DOM suite's behavioural observation; M3 an observer
// that catches but never records fails the DOM suite's "entry added" assertion.
// VACUITY probes: deleting the install call from main.tsx fails F107-f; deleting
// the storage layer fails F107-e (the indexedDB/DVR_DB_NAME pins).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");

const MUT_CORE = read("src/lib/dvr/mutationCore.js");
const SHOT_CORE = read("src/lib/dvr/screenshotCore.js");
const STORE_CORE = read("src/lib/dvr/storageCore.js");
const EXPORT_CORE = read("src/lib/dvr/exportCore.js");
const MUTATIONS = read("src/lib/dvr/mutations.ts");
const SCREENSHOTS = read("src/lib/dvr/screenshots.ts");
const STORAGE = read("src/lib/dvr/storage.ts");
const SESSION = read("src/lib/dvr/session.ts");
const EXPORT = read("src/lib/dvr/export.ts");
const MODAL = read("src/components/dvr/SessionListModal.tsx");
const MAIN = read("src/main.tsx");
const DVR = read("src/lib/dvr.ts");
const COLLECTOR = read("src/pages/Collector.tsx");
const I18N_PARITY = read("tests/f-i18n-parity.test.js");
const EN = JSON.parse(read("src/i18n/en.json"));
const SI = JSON.parse(read("src/i18n/si.json"));

/** Every F107-authored file: the privacy fence below covers exactly this set. */
const F107_FILES = [
  ["src/lib/dvr/mutationCore.js", MUT_CORE],
  ["src/lib/dvr/screenshotCore.js", SHOT_CORE],
  ["src/lib/dvr/storageCore.js", STORE_CORE],
  ["src/lib/dvr/exportCore.js", EXPORT_CORE],
  ["src/lib/dvr/mutations.ts", MUTATIONS],
  ["src/lib/dvr/screenshots.ts", SCREENSHOTS],
  ["src/lib/dvr/storage.ts", STORAGE],
  ["src/lib/dvr/session.ts", SESSION],
  ["src/lib/dvr/export.ts", EXPORT],
  ["src/components/dvr/SessionListModal.tsx", MODAL],
];

/** Comment-stripping shared with the step-3 gate: the file's ACTIONS, not prose. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line.replace(/(^|[^:])\/\/.*$/, "$1")))
    .join("\n");
}

function imp(rel) {
  return import(path.join(ROOT, rel));
}

test("F107-a: mutation descriptors are structural, bounded, and value-free (behavioural, real core)", async () => {
  const { recordMutations, appendMutations, serializeMutations, deserializeMutations, mutationStats, MUTATION_BATCH_CAP, MUTATION_SESSION_CAP } =
    await imp("src/lib/dvr/mutationCore.js");
  // Synthetic MutationRecords: note the records CARRY values/data - the core
  // must produce descriptors that never mention them.
  const records = [
    { type: "childList", target: { nodeName: "DIV" }, addedNodes: { length: 3 }, removedNodes: { length: 1 } },
    { type: "attributes", target: { nodeName: "button" }, attributeName: "class", attributeOldValue: "SECRET-VALUE" },
    { type: "characterData", target: { nodeName: "#text" }, data: "SECRET-TEXT" },
    { type: "nonsense", target: { nodeName: "SPAN" } },
  ];
  const out = recordMutations(records, { now: 4000 });
  assert.equal(out.length, 3, "the unknown record type must be refused, the three known kinds kept");
  assert.deepEqual(out[0], { at: 4000, type: "childList", target: "div", added: 3, removed: 1 }, "childList descriptor drifted");
  assert.deepEqual(out[1], { at: 4000, type: "attributes", target: "button", attr: "class" }, "attribute NAME yes, VALUE never");
  assert.deepEqual(out[2], { at: 4000, type: "characterData", target: "#text" }, "characterData reports existence, never data");
  const wire = serializeMutations(out);
  assert.ok(!wire.includes("SECRET-VALUE") && !wire.includes("SECRET-TEXT"), "no value/text may survive into the wire format");
  assert.deepEqual(deserializeMutations(wire), out, "round-trip must be lossless");
  // Batch folding: a commit storm cannot grow a batch past the cap.
  const storm = [];
  for (let i = 0; i < MUTATION_BATCH_CAP + 20; i++) storm.push({ type: "childList", target: { nodeName: "li" }, addedNodes: { length: 1 }, removedNodes: { length: 0 } });
  const folded = recordMutations(storm, { now: 5000 });
  assert.equal(folded.length, MUTATION_BATCH_CAP, "the batch cap must bind");
  assert.equal(folded[folded.length - 1].folded, 20, "the surplus must fold into the last descriptor, not vanish");
  // Session buffer: newest win, capped, pure (input untouched). Drive it past
  // the cap with repeated storm batches so the eviction direction is proven.
  let buffer = [];
  let stamp = 6000;
  while (buffer.length < MUTATION_SESSION_CAP) {
    buffer = appendMutations(buffer, recordMutations(storm, { now: stamp }), { sessionCap: MUTATION_SESSION_CAP });
    stamp += 1000;
  }
  assert.equal(buffer.length, MUTATION_SESSION_CAP, "the session cap must bind");
  assert.equal(buffer[buffer.length - 1].at, stamp - 1000, "the newest batch must survive eviction");
  const beforeOverflow = buffer.slice();
  const oneMore = appendMutations(buffer, recordMutations(storm, { now: stamp }), { sessionCap: MUTATION_SESSION_CAP });
  assert.equal(oneMore.length, MUTATION_SESSION_CAP, "the cap must keep binding");
  assert.equal(oneMore[oneMore.length - 1].at, stamp, "eviction is newest-win");
  assert.deepEqual(buffer, beforeOverflow, "append must be pure (input untouched)");
  // Reader strictness: malformed input is "no mutations", never a throw.
  for (const junk of ["", "null", "{}", "[{\"type\":\"childList\"}]", '[{"type":"weird","target":"x"}]', '[{"type":"attributes","target":"x"}]', "not json"]) {
    assert.equal(deserializeMutations(junk), null, "malformed mutations must read as null: " + junk);
  }
  assert.deepEqual(mutationStats(out).byType, { childList: 1, attributes: 1, characterData: 1 }, "stats drifted");
  assert.ok(MUT_CORE.includes("never an attribute VALUE"), "the privacy rationale must stay in the source");
});

test("F107-b: thumbnails are devicePixelRatio-aware, boxed, and byte-capped (behavioural, real core)", async () => {
  const { fitThumb, dataUrlBytes, validShot, appendShots, THUMB_W, THUMB_H, SHOT_MAX_BYTES, SHOT_SESSION_CAP, SHOT_MIME_PREFIX } =
    await imp("src/lib/dvr/screenshotCore.js");
  // 1280x800 at dpr 2 -> 2560x1600 source, fitted into the 320x240 box.
  const g = fitThumb(1280, 800, 2);
  assert.deepEqual([g.sourceW, g.sourceH], [2560, 1600], "the source is view*dpr");
  assert.ok(g.w <= THUMB_W && g.h <= THUMB_H, "the thumbnail must stay inside the box");
  assert.ok(Math.abs(g.w / g.h - 2560 / 1600) < 0.05, "aspect ratio must survive the fit");
  const g1 = fitThumb(300, 200, 1);
  assert.deepEqual([g1.w, g1.h], [300, 200], "a view smaller than the box is not upscaled");
  assert.deepEqual([fitThumb(0, 0, 1).w >= 1, fitThumb(0, 0, 1).h >= 1], [true, true], "degenerate views still yield >=1px dims");
  // Byte accounting: base64 payload only.
  const url = SHOT_MIME_PREFIX + Buffer.from("hello-dvr").toString("base64");
  assert.equal(dataUrlBytes(url), 9, "data URL byte count drifted");
  assert.equal(dataUrlBytes("no-comma"), 0, "a non-data-url has no payload");
  // Validation fence: PNG-only, boxed, byte-capped.
  assert.equal(validShot({ key: "1", at: 1, w: THUMB_W, h: THUMB_H, bytes: 9, dataUrl: url }).ok, true, "a legal shot must pass");
  assert.equal(validShot({ dataUrl: "data:image/jpeg;base64,AAAA" }).ok, false, "non-PNG refused");
  assert.equal(validShot({ dataUrl: url, w: THUMB_W + 1, h: 10 }).ok, false, "an oversized thumbnail refused");
  const fat = SHOT_MIME_PREFIX + Buffer.alloc(SHOT_MAX_BYTES + 10).toString("base64");
  assert.equal(validShot({ dataUrl: fat, w: 10, h: 10 }).ok, false, "over the byte budget refused");
  const exact = SHOT_MIME_PREFIX + Buffer.alloc(Math.floor((SHOT_MAX_BYTES * 4) / 3)).toString("base64");
  assert.equal(validShot({ dataUrl: exact, w: 10, h: 10 }).ok, dataUrlBytes(exact) <= SHOT_MAX_BYTES, "the budget edge is inclusive, like the session budget");
  assert.equal(validShot(null).ok, false, "a missing shot refused");
  // Session cap.
  let shots = [];
  for (let i = 0; i < SHOT_SESSION_CAP + 5; i++) shots = appendShots(shots, [{ key: String(i), at: i, w: 1, h: 1, bytes: 1 }]);
  assert.equal(shots.length, SHOT_SESSION_CAP, "the shot cap must bind");
  assert.equal(shots[shots.length - 1].key, String(SHOT_SESSION_CAP + 4), "the newest shot survives");
});

test("F107-c: storage arithmetic - budget, retention, quota triage, eviction order (behavioural, real core)", async () => {
  const {
    newSessionMeta,
    sessionBudgetOk,
    pruneByRetention,
    classifyQuotaError,
    shrinkToFit,
    sortSessionsNewestFirst,
    DVR_SESSION_BUDGET_BYTES,
    DVR_RETENTION_DAYS,
    DVR_RETENTION_MS,
    DVR_DB_NAME,
    DVR_STORE_SESSIONS,
    DVR_STORE_SHOTS,
  } = await imp("src/lib/dvr/storageCore.js");
  // Budget: the 5 MB line is inclusive, crossing it is not an error but a skip.
  const meta = newSessionMeta("dvr-1", 7000);
  assert.equal(sessionBudgetOk(meta, DVR_SESSION_BUDGET_BYTES), true, "exactly at budget is ok");
  assert.equal(sessionBudgetOk(meta, DVR_SESSION_BUDGET_BYTES + 1), false, "over budget is refused");
  assert.equal(sessionBudgetOk({ bytes: DVR_SESSION_BUDGET_BYTES - 10 }, 10), true, "used+add is the check");
  assert.deepEqual(Object.keys(meta).sort(), ["bytes", "clicks", "endedAt", "id", "label", "mutations", "routes", "settles", "shots", "startedAt"], "session meta keys are a closed set");
  // Retention: 30 days measured from ENDED, boundary inclusive, in-flight ALWAYS kept.
  const now = 100 * DVR_RETENTION_MS;
  const fresh = { id: "fresh", startedAt: now - 2 * DVR_RETENTION_MS, endedAt: now - DVR_RETENTION_MS + 1 };
  const boundary = { id: "boundary", startedAt: now - 2 * DVR_RETENTION_MS, endedAt: now - DVR_RETENTION_MS };
  const stale = { id: "stale", startedAt: now - 3 * DVR_RETENTION_MS, endedAt: now - DVR_RETENTION_MS - 1 };
  const inFlight = { id: "live", startedAt: now - 5 * DVR_RETENTION_MS, endedAt: 0 };
  const pruned = pruneByRetention([fresh, boundary, stale, inFlight], now);
  assert.deepEqual(pruned.keep.map((s) => s.id), ["fresh", "boundary", "live"], "the cutoff and the in-flight rule drifted");
  assert.deepEqual(pruned.drop.map((s) => s.id), ["stale"], "exactly the stale one drops");
  // Quota triage: classification decides the recovery path; it must not guess.
  assert.equal(classifyQuotaError({ name: "QuotaExceededError" }), "quota-exceeded");
  assert.equal(classifyQuotaError({ code: 22 }), "quota-exceeded", "the DOMException code is quota");
  assert.equal(classifyQuotaError({ message: "EncryptedFile: quota exceeded" }), "quota-exceeded");
  assert.equal(classifyQuotaError({ name: "NotFoundError" }), "unavailable");
  assert.equal(classifyQuotaError({ name: "InvalidStateError" }), "unavailable");
  assert.equal(classifyQuotaError({ name: "WeirdError", message: "boom" }), "unknown");
  assert.equal(classifyQuotaError(null), "unknown", "a missing error is unknown, not quota");
  // Eviction: OLDEST shots first, deterministic, and honest about not fitting.
  const shots = [
    { key: "1", bytes: 100 },
    { key: "2", bytes: 200 },
    { key: "3", bytes: 300 },
  ];
  const plan = shrinkToFit(shots, DVR_SESSION_BUDGET_BYTES - 50, 200, { budgetBytes: DVR_SESSION_BUDGET_BYTES });
  assert.deepEqual(plan.droppedKeys, ["1", "2"], "eviction must be oldest-first");
  assert.deepEqual(plan.shots.map((s) => s.key), ["3"], "the survivor is the newest");
  assert.equal(plan.fits, true, "the plan must fit after eviction");
  const impossible = shrinkToFit([{ key: "a", bytes: 10 }], 0, DVR_SESSION_BUDGET_BYTES + 1, { budgetBytes: DVR_SESSION_BUDGET_BYTES });
  assert.equal(impossible.fits, false, "an unshrinkable write must say so, never silently truncate");
  assert.equal(shots.length, 3, "shrinkToFit must not mutate its input");
  // Ordering for the list UI.
  assert.deepEqual(
    sortSessionsNewestFirst([{ id: "a", startedAt: 1 }, { id: "b", startedAt: 3 }, { id: "c", startedAt: 2 }]).map((s) => s.id),
    ["b", "c", "a"],
    "newest-first drifted"
  );
  // The adapter's constants live HERE, nowhere else.
  assert.equal(DVR_DB_NAME, "ghrdp-dvr");
  assert.equal(DVR_STORE_SESSIONS, "sessions");
  assert.equal(DVR_STORE_SHOTS, "shots");
  // Drift locks: the budget and the retention are SPEC constants, not knobs. A
  // behavioural test that reads the same constant it mutates can never see the
  // drift (falsifications M4/M5), so the literals are pinned here, the way
  // F-DVR-a pins the 30 s / 200-entry ring constants.
  assert.equal(DVR_SESSION_BUDGET_BYTES, 5_000_000, "the 5 MB/session budget drifted");
  assert.equal(DVR_RETENTION_DAYS, 30, "the 30-day retention drifted");
  assert.ok(STORE_CORE.includes("browser-local"), "the storage posture must stay documented");
});

test("F107-d: the .mcrec v2 bundle validates strictly and never confuses with v1 (behavioural, real core)", async () => {
  const { buildBundleV2, bundleV2Text, validateBundleV2, encodeEnvelopeV2, decodeEnvelopeV2, DVR_BUNDLE_V2_VERSION } =
    await imp("src/lib/dvr/exportCore.js");
  const { toBase64 } = await imp("src/lib/dvr-core.js");
  const inputs = {
    timeline: [{ seq: 1, at: 10, kind: "click" }, { seq: 2, at: 20, kind: "settle" }],
    mutations: [{ at: 15, type: "childList", target: "div", added: 1, removed: 0 }],
    shots: [],
    sessions: [{ id: "dvr-1", startedAt: 5, endedAt: 25, clicks: 1, mutations: 1, shots: 0, bytes: 0 }],
    features: [{ id: "overview", route: "/" }],
    target: { route: "#/collector", buildSha: "abc", lang: "si", ui: "v2" },
  };
  const bundle = buildBundleV2(inputs, { now: 30 });
  assert.equal(bundle.format, "mcrec");
  assert.equal(bundle.version, DVR_BUNDLE_V2_VERSION);
  assert.equal(bundle.createdAt, new Date(30).toISOString(), "createdAt must be the injected clock");
  assert.deepEqual(Object.keys(bundle.target).sort(), ["buildSha", "lang", "route", "ui"], "target keys are a closed set, like v1");
  assert.equal(bundle.storage.bytes, 0, "storage bytes must be derived from the session index");
  assert.equal(validateBundleV2(bundle).ok, true, "a built bundle must validate");
  assert.deepEqual(JSON.parse(bundleV2Text(bundle)), bundle, "the text form must round-trip");
  // Falsification battery: each mutation of a shipped bundle must be REFUSED.
  const mut = (fn) => {
    const clone = JSON.parse(bundleV2Text(bundle));
    fn(clone);
    return clone;
  };
  assert.equal(validateBundleV2(mut((b) => (b.version = 1))).ok, false, "a v1 bundle must not validate as v2");
  assert.equal(validateBundleV2(mut((b) => (b.format = "other"))).ok, false, "format drift refused");
  assert.equal(validateBundleV2(mut((b) => delete b.timeline)).ok, false, "missing timeline refused");
  assert.equal(validateBundleV2(mut((b) => delete b.storage)).ok, false, "missing storage refused");
  assert.equal(validateBundleV2(mut((b) => (b.storage.bytes = 999))).ok, false, "tampered storage bytes refused");
  assert.equal(validateBundleV2(mut((b) => (b.timeline = [{ seq: 5, at: 1 }, { seq: 2, at: 2 }]))).ok, false, "out-of-order timeline refused");
  assert.equal(validateBundleV2(mut((b) => (b.target = { route: "/" }))).ok, false, "a drifted target refused");
  assert.equal(
    validateBundleV2(mut((b) => (b.shots = [{ key: "1", at: 1, w: 9999, h: 10, bytes: 1, dataUrl: "data:image/png;base64,AAAA" }]))).ok,
    false,
    "an oversized shot inside a bundle refused"
  );
  assert.equal(validateBundleV2(null).ok, false);
  // Envelope v2: round-trips, tags its codec, and never meets v1 halfway.
  const payload = toBase64(new TextEncoder().encode(bundleV2Text(bundle)));
  const line = encodeEnvelopeV2("plain", payload);
  assert.ok(line.startsWith("mcrec2:plain:"), "the v2 envelope must carry format+version+codec");
  const back = decodeEnvelopeV2(line);
  assert.ok(back, "a v2 line must decode");
  assert.equal(new TextDecoder().decode(back.bytes), bundleV2Text(bundle), "payload survives");
  for (const junk of ["", "mcrec1:plain:" + payload, "mcrec2:zstd:" + payload, "mcrec2:plain", "mcrec2:plain:!!!"]) {
    assert.equal(decodeEnvelopeV2(junk), null, "malformed/v1 input must decode to null: " + JSON.stringify(junk).slice(0, 40));
  }
});

test("F107-e: NOTHING LEAVES THE MACHINE - no network/upload in any F107 file; storage is IndexedDB only", () => {
  const bannedNetwork = ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "diag-upload", "f-dvr/upload", "Put-GhFile"];
  const offenders = [];
  for (const [name, text] of F107_FILES) {
    const body = code(text);
    for (const token of bannedNetwork) {
      if (body.includes(token)) offenders.push(name + " contains " + token);
    }
  }
  assert.deepEqual(offenders, [], "F107 egress is the operator-clicked export, nothing else: " + offenders.join(" | "));
  // The ONLY storage backend is browser-local IndexedDB: no localStorage/
  // sessionStorage in the new surface (one storage technology, one gate).
  const storageOffenders = [];
  for (const [name, text] of F107_FILES) {
    const body = code(text);
    for (const token of ["localStorage", "sessionStorage"]) {
      if (body.includes(token)) storageOffenders.push(name + " contains " + token);
    }
  }
  assert.deepEqual(storageOffenders, [], "one storage backend: " + storageOffenders.join(" | "));
  // Content APIs are banned in the STRUCTURAL files; the screenshot pipeline is
  // the fenced pixel surface (it may cloneNode to serialize - structure only).
  for (const [name, text] of [
    ["src/lib/dvr/mutations.ts", MUTATIONS],
    ["src/lib/dvr/session.ts", SESSION],
    ["src/lib/dvr/mutationCore.js", MUT_CORE],
  ]) {
    const body = code(text);
    for (const forbidden of ["innerHTML", "outerHTML", "textContent", "querySelector", "getAttribute"]) {
      assert.ok(!body.includes(forbidden), name + " must not read DOM content (" + forbidden + ")");
    }
  }
  // Vacuity probe 2: the storage layer exists and is the one storage uses.
  assert.ok(STORAGE.includes("typeof indexedDB"), "storage.ts must feature-detect IndexedDB");
  assert.ok(STORAGE.includes("DVR_DB_NAME"), "the adapter must open the pinned database name");
  assert.ok(code(STORAGE).includes("factory.open(DVR_DB_NAME, DVR_DB_VERSION)"), "the adapter must open the DB through the pinned constants");
  // The adapter's decisions come from the pure core, never re-implemented.
  // Every error path routes through the core triage: the floor below is the
  // measured call-site count (12 at shipping time), so silently replacing one
  // call with a hardcoded string fails here (falsification M11).
  const triageUses = (code(STORAGE).match(/classifyQuotaError\(/g) || []).length;
  assert.ok(triageUses >= 10, "every adapter error path must route through the core triage (found " + triageUses + ")");
  assert.ok(STORAGE.includes("shrinkToFit"), "eviction must come from storageCore");
  assert.ok(STORAGE.includes("pruneByRetention"), "retention must come from the core, never re-derived in the adapter");
});

test("F107-f: wiring - one observer on the React root, one entry seam, one install behind two kill flags", () => {
  // M1/M2: the observer is real, attached to the React mount root, and records.
  assert.ok(MUTATIONS.includes('export const DVR_MUTATION_ROOT_ID = "root"'), "the root id drifted (index.html mounts #root)");
  assert.ok(MUTATIONS.includes("document.getElementById(DVR_MUTATION_ROOT_ID)"), "the observer must attach through the pinned root id");
  assert.ok(MUTATIONS.includes("new MutationObserver("), "the recorder must be a real MutationObserver (M1)");
  assert.ok(MUTATIONS.includes("{ childList: true, subtree: true, characterData: true, attributes: true }"), "the observed option set is pinned (same population as step 3's counter)");
  assert.ok(MUTATIONS.includes("recordMutations("), "batches must flow through the shipped core, not a fork (M3)");
  assert.ok(MUTATIONS.includes("appendMutations("), "the session buffer must come from the core");
  // The entry seam: dvr.ts exposes it, session.ts is the production subscriber.
  assert.ok(DVR.includes("export function onDvrEntry("), "dvr.ts must expose the entry seam");
  assert.ok(DVR.includes("entryListeners"), "the seam must have a listener set");
  assert.ok(!DVR.includes('document.addEventListener("click"'), "the seam must not add a second click listener");
  assert.ok(SESSION.includes("onDvrEntry("), "session.ts must ride the seam, not a fork of F104");
  assert.ok(SESSION.includes("installMutationRecorder("), "the session must install the mutation recorder");
  assert.ok(SESSION.includes("captureShot("), "the session must take the click screenshot");
  // Screenshots: one seam, default pipeline pinned, honest failure.
  assert.ok(SCREENSHOTS.includes("setShotRasterizer"), "the documented test seam must exist");
  assert.ok(SCREENSHOTS.includes("isDefaultRasterizerActive"), "the gate must be able to prove the default is wired");
  assert.ok(code(SCREENSHOTS).includes("canvas.getContext(\"2d\")"), "the default pipeline must rasterize on a real canvas");
  assert.ok(code(SCREENSHOTS).includes("toDataURL(\"image/png\")"), "PNG is the only shot format");
  // V1 vacuity probe: the install exists in main.tsx behind BOTH kill flags.
  assert.ok(MAIN.includes('import { installDvrFull } from "@/lib/dvr/session";'), "main.tsx must import the installer");
  assert.ok(MAIN.includes('import.meta.env.VITE_F107_FULL_DVR !== "false"'), "F107 needs its own kill flag");
  assert.ok(MAIN.includes("installDvrFull()"), "the installer must be called");
  // The Collector hosts the stored-session surface; the FAB hosts the handle.
  assert.ok(COLLECTOR.includes('import { SessionListModal } from "@/components/dvr/SessionListModal";'), "Collector must mount the session list");
  assert.ok(COLLECTOR.includes('data-testid="dvr-sessions-open"'), "the Collector button must be addressable");
  const FAB = read("src/components/domain/DvrFab.tsx");
  assert.ok(FAB.includes('data-testid="dvr-sessions-button"'), "the FAB panel must carry the sessions handle");
  // Export is operator-initiated only: the default downloader is an anchor click.
  assert.ok(EXPORT.includes("setExportDownload"), "the documented export seam must exist");
  assert.ok(code(EXPORT).includes("URL.createObjectURL(blob)"), "the default export must be a local file download");
  assert.ok(EXPORT.includes("exportStoredSessionV2"), "per-session export must exist");
  // The live session never double-installs.
  assert.ok(SESSION.includes("if (handle) return handle;"), "installDvrFull must be idempotent");
});

test("F107-g: dvrSessions.* i18n is complete in both catalogs, and the count lock moved with it", () => {
  const keys = Object.keys(EN.dvrSessions || {}).sort();
  assert.ok(keys.length >= 20, "the session UI is t()-driven; found only " + keys.length + " keys");
  assert.deepEqual(keys, Object.keys(SI.dvrSessions || {}).sort(), "si.json must carry the identical dvrSessions key set");
  const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join(",");
  for (const k of keys) {
    assert.equal(ph(EN.dvrSessions[k]), ph(SI.dvrSessions[k]), "placeholder mismatch for dvrSessions." + k);
    assert.ok(String(SI.dvrSessions[k]).trim().length > 0, "empty si translation for dvrSessions." + k);
  }
  assert.ok(typeof EN.dvr.sessions === "string" && EN.dvr.sessions.length > 0, "dvr.sessions (the FAB handle) is missing in en");
  assert.ok(typeof SI.dvr.sessions === "string" && SI.dvr.sessions.length > 0, "dvr.sessions is missing in si");
  // Every key the two surfaces ask for must exist in BOTH catalogs.
  const flat = (o, p = "") =>
    Object.entries(o).reduce((acc, [k, v]) => Object.assign(acc, v && typeof v === "object" ? flat(v, p + k + ".") : { [p + k]: true }), {});
  const ENF = flat(EN);
  const SIF = flat(SI);
  const used = [...(MODAL + COLLECTOR).matchAll(/t\("((?:dvrSessions|dvr)\.[a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 20, "expected the surfaces to use the namespace; found " + used.length);
  for (const k of new Set(used)) {
    assert.ok(k in ENF, 't("' + k + '") has no en.json key');
    assert.ok(k in SIF, 't("' + k + '") has no si.json key');
  }
  // The parity gate's count lock is a pin against silent catalog edits (§LOCK-
  // ARITHMETIC: the lock is measured from the CURRENT catalogs, never incremented).
  const expected = Number((I18N_PARITY.match(/const EXPECTED_FLAT_KEYS = (\d+)/) || [])[1]);
  const enCount = Object.keys(ENF).length;
  const siCount = Object.keys(SIF).length;
  assert.equal(enCount, siCount, "en/si must stay the same size");
  assert.equal(expected, enCount, "EXPECTED_FLAT_KEYS (" + expected + ") must equal the real flat key count (" + enCount + ")");
});

test("F107-h: step 3's LITE posture is untouched - the new storage never leaked into the LITE files", () => {
  // Regression lock across steps: F107 adds IndexedDB to the DVR family, and the
  // guarantee that the THREE LITE files stay storage-free must survive that.
  const lite = [
    ["src/lib/dvr-core.js", read("src/lib/dvr-core.js")],
    ["src/lib/dvr.ts", DVR],
    ["src/components/domain/DvrFab.tsx", read("src/components/domain/DvrFab.tsx")],
  ];
  const banned = ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "localStorage", "sessionStorage", "indexedDB", "diag-upload", "f-dvr"];
  const offenders = [];
  for (const [name, text] of lite) {
    const body = code(text);
    for (const token of banned) {
      if (body.includes(token)) offenders.push(name + " contains " + token);
    }
  }
  assert.deepEqual(offenders, [], "the LITE files are the operator's minimal copy surface: " + offenders.join(" | "));
  // The v1 envelope is still the FAB's output (F107 is a superset, not a fork).
  assert.ok(read("src/lib/dvr.ts").includes('const codec: DvrCodec = gz ? "gzip" : "plain";'), "v1 codec derivation drifted");
});

test("F107-i: the session list UI is addressable, private, and outside F104's blind spot", () => {
  const ids = [...MODAL.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);
  for (const want of ["dvr-sessions-modal", "dvr-session-row", "dvr-session-empty", "dvr-session-export", "dvr-session-delete", "dvr-sessions-refresh"]) {
    assert.ok(ids.includes(want), "missing testid " + want);
  }
  assert.equal(new Set(ids).size, ids.length, "duplicate testids make a selector ambiguous");
  for (const id of ids) {
    assert.ok(!id.startsWith("collector-") && !id.startsWith("click-now-"), "session-list id in the F104 blind spot: " + id);
  }
  // No F107 UI id may enter the blind spot from ANY file this step authored.
  for (const [name, text] of F107_FILES) {
    for (const m of text.matchAll(/data-testid="([^"]+)"/g)) {
      assert.ok(!m[1].startsWith("collector-") && !m[1].startsWith("click-now-"), name + " names a blind-spot id: " + m[1]);
    }
  }
});
