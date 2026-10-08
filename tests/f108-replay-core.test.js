// [F108 / Observatory step 7] Public Replay Viewer gate - the published reader,
// pinned in bytes AND executed.
//
// WHAT STEP 7 SHIPS. `docs/replay/` is a static page published by GitHub Pages
// from `docs/`: it takes a `.mcrec` bundle (step 3's `mcrec1:` clipboard line,
// step 6's `mcrec2:` / file export), and replays the timeline, the DOM-update
// descriptors, the fenced screenshots, the session index and the feature
// snapshot - then prints the text summary an operator pastes into Arena.
//
// WHICH IS WHY THIS GATE IS WRITTEN THE WAY IT IS. The page is built from files
// that are NOT the ones `pnpm run build` compiles (docs/ is outside the vite
// root), so "the tests cover the viewer" would be a lie if they imported
// src/replay/replayCore.js. They import the PUBLISHED artifact -
// docs/replay/vendor/replay/replayCore.js - and F108-a pins that the published
// artifact is byte-identical to the shipped source. A gate that passes while the
// published file drifts is worse than no gate, so the byte comparison is itself
// falsified (F108-a3) against a tampered copy.
//
// FALSIFY-3 (per the step spec):
//   M1 Stop stripping the query string at display time (routeOf -> identity):
//      F108-e fails on `#/collector?token=SECRET`.
//   M2 Let safeImageSrc return whatever the bundle carries: F108-e2 fails on a
//      remote URL and on `data:text/html`, and the jsdom suite's
//      `img[src^="data:image/png"]` assertion fails for the same fixture.
//   M3 Break the vendored copy (edit docs/replay/vendor/… by hand): F108-a fails
//      with the pair's name - the failure names the file to regenerate.
// VACUITY probes:
//   V1 Delete docs/replay/index.html -> F108-a and F108-g fail (no page, no CSP).
//   V2 Re-implement the reader inside app.js instead of importing the core ->
//      F108-g4 fails (the import pin), which is the "second parser" this repo
//      paid for once already (MH-d).
//   V3 Delete the v1 branch of parseBundle -> F108-b2 fails (step 3 regressions).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readNorm = (p) => read(p).replace(/\r\n?/g, "\n");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/** The ESM-syntax pure cores are loaded by dynamic import (house pattern). */
const mod = (rel) => import(path.join(ROOT, rel));
/** THE PUBLISHED READER - not the source. See the header. */
const publishedCore = () => mod("docs/replay/vendor/replay/replayCore.js");

/** src -> published pairs, duplicated from scripts/sync-replay-vendor.mjs. */
const VENDOR_PAIRS = [
  ["src/lib/dvr-core.js", "docs/replay/vendor/lib/dvr-core.js"],
  ["src/lib/dvr/exportCore.js", "docs/replay/vendor/lib/dvr/exportCore.js"],
  ["src/lib/dvr/screenshotCore.js", "docs/replay/vendor/lib/dvr/screenshotCore.js"],
  ["src/lib/dvr/routeCore.js", "docs/replay/vendor/lib/dvr/routeCore.js"],
  ["src/replay/replayCore.js", "docs/replay/vendor/replay/replayCore.js"],
];

/** The files a browser fetches for the viewer: these must be offline-complete. */
const PUBLISHED = ["docs/replay/index.html", "docs/replay/app.js", "docs/replay/style.css"];
const PUBLISHED_JS = ["docs/replay/app.js", "docs/replay/vendor/replay/replayCore.js"];

/** A v1 bundle built by the SHIPPED step-3 producer. */
async function v1Fixture(now) {
  const { buildBundle, toBase64, encodeEnvelope } = await mod("src/lib/dvr-core.js");
  const at = now || 1_759_900_000_000;
  const bundle = buildBundle(
    [
      { seq: 1, at: at, kind: "click", id: "c1", action: "open", feature: "dvr", testId: "dvr-sessions-button", label: "Sessions", tag: "button", path: "/collector" },
      { seq: 2, at: at + 900, kind: "settle", id: "c1", verdict: "ok", reason: "fetch-observed", fetch: 1, opened: 0, failed: 0, elapsedMs: 120 },
      { seq: 3, at: at + 1_500, kind: "route", to: "#/collector?token=SECRET" },
    ],
    { route: "#/collector?token=SECRET", buildSha: "abc1234", lang: "en", ui: "v2" },
    { now: at }
  );
  const line = encodeEnvelope("plain", toBase64(new TextEncoder().encode(JSON.stringify(bundle))));
  return { bundle, line, at };
}

/** A v2 bundle built by the SHIPPED step-6 producer. */
async function v2Fixture(now) {
  const { buildBundleV2, bundleV2Text, encodeEnvelopeV2 } = await mod("src/lib/dvr/exportCore.js");
  const { toBase64 } = await mod("src/lib/dvr-core.js");
  const at = now || 1_759_900_000_000;
  const bundle = buildBundleV2(
    {
      timeline: [
        { seq: 1, at: at, kind: "click", feature: "collector", testId: "dvr-sessions-open", tag: "button" },
        { seq: 2, at: at + 250, kind: "route", to: "#/collector?token=SECRET", route: "#/collector?token=SECRET" },
        { seq: 3, at: at + 400, kind: "settle", verdict: "ok", fetch: 2, opened: 1, failed: 0, elapsedMs: 88 },
      ],
      mutations: [
        { at: at, type: "childList", target: "div", added: 2, removed: 0 },
        { at: at + 100, type: "attributes", target: "button", attr: "aria-busy" },
        { at: at + 120, type: "characterData", target: "#text" },
      ],
      shots: [
        { at: at, key: "s1", w: 320, h: 240, bytes: 11, dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      ],
      sessions: [
        { id: "sess-1", startedAt: at, endedAt: at + 1_000, clicks: 1, mutations: 3, shots: 1, bytes: 11, reasons: [] },
      ],
      features: [
        { id: "dvr", route: "/collector?token=SECRET" },
        { id: "lab", route: "/lab" },
      ],
      target: { route: "#/collector?token=SECRET", buildSha: "abc1234", lang: "en", ui: "v2" },
    },
    { now: at }
  );
  return {
    bundle,
    json: bundleV2Text(bundle),
    line: encodeEnvelopeV2("plain", toBase64(new TextEncoder().encode(bundleV2Text(bundle)))),
    at,
  };
}

/** The byte comparison used by F108-a, factored so it can be falsified. */
function vendorDrift(root) {
  const out = [];
  for (const [from, to] of VENDOR_PAIRS) {
    const a = fs.readFileSync(path.join(root, from), "utf8").replace(/\r\n?/g, "\n");
    let b = null;
    try {
      b = fs.readFileSync(path.join(root, to), "utf8").replace(/\r\n?/g, "\n");
    } catch {
      out.push(to + " (missing)");
      continue;
    }
    if (a !== b) out.push(to);
  }
  return out;
}

test("F108-a: the PUBLISHED reader is a byte-identical copy of the shipped cores (and the comparator itself is falsified)", () => {
  for (const [from, to] of VENDOR_PAIRS) {
    assert.ok(exists(from), from + " must exist - the published copy has a source");
    assert.ok(exists(to), to + " must exist - run `node scripts/sync-replay-vendor.mjs`");
    assert.equal(readNorm(to), readNorm(from), to + " has drifted from " + from + " - run `node scripts/sync-replay-vendor.mjs` (never hand-edit a vendored file)");
  }
  assert.deepEqual(vendorDrift(ROOT), [], "the published tree must be in sync with src/");

  // Falsification: the comparator must FAIL on a tampered copy, otherwise the
  // assertion above is vacuous. Copy the two files involved into a scratch tree,
  // change one byte in the published copy, and require the same code to notice.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "f108-"));
  try {
    for (const [from, to] of VENDOR_PAIRS) {
      fs.mkdirSync(path.dirname(path.join(scratch, from)), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(scratch, to)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, from), path.join(scratch, from));
      fs.copyFileSync(path.join(ROOT, to), path.join(scratch, to));
    }
    fs.writeFileSync(
      path.join(scratch, VENDOR_PAIRS[0][1]),
      fs.readFileSync(path.join(scratch, VENDOR_PAIRS[0][1]), "utf8").replace("num", "nvm")
    );
    const drift = vendorDrift(scratch);
    assert.deepEqual(drift, [VENDOR_PAIRS[0][1]], "a one-token edit in the published copy must be reported as drift");
    // …and a MISSING copy is drift too (the page would 404 its own reader).
    fs.rmSync(path.join(scratch, VENDOR_PAIRS[1][1]));
    assert.ok(vendorDrift(scratch).includes(VENDOR_PAIRS[1][1] + " (missing)"));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("F108-b: the published reader reads BOTH envelope generations the recorders write", async () => {
  const core = await publishedCore();
  const v1 = await v1Fixture();
  const v2 = await v2Fixture();

  // b1 - step 3's clipboard line (`mcrec1:plain:`), the DVR FAB's Copy output.
  const c1 = core.classifyInput(v1.line);
  assert.equal(c1.kind, "v1-envelope", "a mcrec1 line must be recognised as step 3's clipboard envelope");
  const p1 = core.parseBundle(c1.jsonText);
  assert.equal(p1.ok, true, "the v1 bundle the shipped producer emits must parse: " + p1.reason);
  assert.equal(p1.version, 1);
  const verdict1 = core.verdict(p1.bundle);
  assert.equal(verdict1.counts.timeline, 3);
  assert.equal(verdict1.stats.byKind.click, 1);
  assert.equal(verdict1.stats.byKind.settle, 1);
  assert.equal(verdict1.stats.byKind.route, 1);

  // b2 - step 6's export: BOTH shapes the same feature writes (`mcrec2:` line and
  // the raw-JSON `.mcrec` file the downloader saves).
  const c2 = core.classifyInput(v2.line);
  assert.equal(c2.kind, "v2-envelope");
  const p2 = core.parseBundle(c2.jsonText);
  assert.equal(p2.ok, true, "the v2 bundle the shipped producer emits must parse: " + p2.reason);
  assert.equal(p2.version, 2);

  const fileShape = core.classifyInput(v2.json);
  assert.equal(fileShape.kind, "json-text", "an exported .mcrec file IS the bundle JSON - the reader must accept it without an envelope");
  const p3 = core.parseBundle(fileShape.jsonText);
  assert.equal(p3.ok, true, "the file shape must parse exactly like the line shape");
  assert.deepEqual(p3.bundle, p2.bundle, "line and file must decode to the SAME bundle");

  const v2verdict = core.verdict(p2.bundle);
  assert.deepEqual(v2verdict.counts, {
    timeline: 3,
    mutations: 3,
    shots: 1,
    sessions: 1,
    features: 2,
    refusedShots: 0,
    bytes: 11,
  });

  // b3 - cross-version confusion is impossible: a v1 line never parses as v2 and
  // vice versa (the two decoders carry different tags on purpose).
  assert.equal(core.parseBundle(JSON.stringify(v1.bundle)).version, 1);
  const asV2 = core.parseBundle(JSON.stringify({ format: "mcrec", version: 2, timeline: [] }));
  assert.equal(asV2.ok, false, "a hand-made {version:2} object missing the v2 shape must be REFUSED");
  const asV1 = core.parseBundle(JSON.stringify({ format: "mcrec", version: 1, target: {} }));
  assert.equal(asV1.ok, false, "a v1 bundle without `entries` must be REFUSED (not rendered as empty)");
});

test("F108-c: input classification is enumerated, and every failure names itself", async () => {
  const core = await publishedCore();
  assert.deepEqual(
    core.REPLAY_INPUT_KINDS,
    ["empty", "too-large", "v1-envelope", "v2-envelope", "json-text", "unrecognised"],
    "literal pin: the reader's input kinds"
  );
  assert.equal(core.classifyInput("").kind, "empty");
  assert.equal(core.classifyInput("   \n\t ").kind, "empty");
  assert.equal(core.classifyInput("hello world").kind, "unrecognised");
  assert.equal(core.classifyInput("{}").kind, "json-text");
  assert.equal(core.classifyInput('  {"format":"mcrec","version":2}  ').kind, "json-text", "leading whitespace must not change the verdict");
  assert.equal(core.classifyInput("mcrec1:brotli:AAAA").kind, "unrecognised", "an unknown codec is not a bundle");
  assert.equal(core.classifyInput("mcrec1:plain:not-base64!!").kind, "unrecognised");
  assert.equal(core.classifyInput("mcrec3:plain:AAAA").kind, "unrecognised", "a future version tag is refused, not guessed");

  // A gzip envelope (what the real recorder writes when CompressionStream is
  // available) comes back as BYTES: inflating is the caller's job on purpose, so
  // this core stays platform-free. The bytes must round-trip through zlib.
  const zlib = require("node:zlib");
  const payload = JSON.stringify({ hello: "mcrec" });
  const gz = zlib.gzipSync(Buffer.from(payload, "utf8"));
  const b64 = Buffer.from(gz).toString("base64");
  const line = "mcrec1:gzip:" + b64;
  const cls = core.classifyInput(line);
  assert.equal(cls.kind, "v1-envelope");
  assert.equal(cls.codec, "gzip");
  assert.equal(cls.jsonText, null, "gzip payloads are not text until the caller inflates them");
  assert.equal(zlib.gunzipSync(Buffer.from(cls.bytes)).toString("utf8"), payload);

  // Size ceiling: a paste larger than the reader's ceiling is refused BEFORE any
  // JSON.parse (the bundle cap is a literal pin).
  assert.equal(core.REPLAY_MAX_CHARS, 8_000_000);
  const huge = core.classifyInput("{" + "x".repeat(core.REPLAY_MAX_CHARS + 1));
  assert.equal(huge.kind, "too-large");
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /^input-exceeds-\d+-chars$/, "the refusal must be quotable in the UI");
});

test("F108-d: a bundle the recorder would refuse is refused here too (one validator, two callers)", async () => {
  const core = await publishedCore();
  const v2 = await v2Fixture();

  // d1 - a tampered storage total (the arithmetic the writer checks) must not
  // render: validateBundleV2 is the SAME function the exporter runs pre-download.
  const tampered = JSON.parse(v2.json);
  tampered.storage.bytes = 999;
  const r1 = core.parseBundle(JSON.stringify(tampered));
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "storage-bytes-drift");

  // d2 - an out-of-order timeline is refused (a scrubber over an unordered log
  // would replay the bug backwards).
  const unordered = JSON.parse(v2.json);
  unordered.timeline = [unordered.timeline[2], unordered.timeline[0], unordered.timeline[1]];
  assert.equal(core.parseBundle(JSON.stringify(unordered)).reason, "timeline-out-of-order");

  // d3 - a shot outside the thumbnail fence is refused AT PARSE (it is part of
  // the v2 contract), not silently rendered.
  const oversize = JSON.parse(v2.json);
  oversize.shots = [{ at: v2.at, w: 1280, h: 1024, bytes: 11, dataUrl: "data:image/png;base64,iVBORw0KGgo=" }];
  assert.match(core.parseBundle(JSON.stringify(oversize)).reason, /^bad-shot:/);

  // d4 - wrong format tag / unsupported version / broken JSON: each names itself.
  assert.equal(core.parseBundle(JSON.stringify({ format: "not-mcrec", version: 2 })).reason, "bad-format");
  assert.equal(core.parseBundle(JSON.stringify({ format: "mcrec", version: 7 })).reason, "unsupported-version");
  assert.equal(core.parseBundle("{oops").ok, false);
  assert.match(core.parseBundle("{oops").reason, /^not-json:/);
  assert.equal(core.parseBundle("[]").reason, "not-an-object", "a JSON array is not a bundle");
  assert.equal(core.parseBundle("").reason, "empty-json");
});

test("F108-e: hostile bundles render as inert text and NEVER as a URL, a tag or a fetch", async () => {
  const core = await publishedCore();
  const v2 = await v2Fixture();

  // e1 - the reader's own route sanitizer, at DISPLAY time (defence in depth: the
  // recorder strips `?token=` and a hand-edited bundle must not re-open it).
  assert.equal(core.routeOf("#/collector?token=SECRET"), "#/collector");
  assert.equal(core.routeOf("/keys?token=A&b=2"), "/keys");
  assert.equal(core.routeOf(null), "");
  const hostileRoute = JSON.parse(v2.json);
  hostileRoute.target.route = "#/collector?token=SECRET";
  hostileRoute.features = [{ id: "dvr", route: "/collector?token=SECRET" }];
  const parsedHostile = core.parseBundle(JSON.stringify(hostileRoute));
  assert.equal(parsedHostile.ok, true);
  const summary = core.summarize(parsedHostile.bundle);
  assert.ok(!summary.includes("SECRET"), "the Arena summary must not carry a credential the route sanitizer removed");
  assert.ok(summary.includes("#/collector"), "…while still telling the operator which route it was");
  assert.ok(!JSON.stringify(core.featureRows(parsedHostile.bundle)).includes("SECRET"));

  // e2 - the ONLY image source the reader yields is a fenced PNG data URL.
  const ok = core.safeImageSrc({ dataUrl: "data:image/png;base64,iVBORw0KGgo=", w: 320, h: 240, bytes: 11 });
  assert.equal(ok, "data:image/png;base64,iVBORw0KGgo=");
  for (const bad of [
    { dataUrl: "https://attacker.example/x.png", w: 320, h: 240 },
    { dataUrl: "http://attacker.example/x.png", w: 320, h: 240 },
    { dataUrl: "data:text/html,<script>alert(1)</script>", w: 320, h: 240 },
    { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=", w: 320, h: 240 },
    { dataUrl: "javascript:alert(1)", w: 320, h: 240 },
    { dataUrl: "data:image/png;base64,iVBORw0KGgo=", w: 1280, h: 1024 },
    { dataUrl: "data:image/png;base64,", w: 320, h: 240 },
    { dataUrl: 42, w: 320, h: 240 },
    null,
  ]) {
    assert.equal(core.safeImageSrc(bad), "", "refused: " + JSON.stringify(bad && bad.dataUrl));
  }

  // e3 - safeText bounds and de-fangs every field a bundle can carry: no control
  // characters (a terminal escape in a test id is a real-world payload), and a
  // hard length cap so one field cannot become the page.
  assert.equal(core.SAFE_TEXT_MAX, 240);
  assert.equal(core.safeText("a\u0000b\u001bc\u009fd"), "a b c d");
  assert.equal(core.safeText("x".repeat(500)).length, core.SAFE_TEXT_MAX + 1, "240 characters plus the ellipsis");
  assert.equal(core.safeText(undefined), "");
  assert.equal(core.safeText(null), "");
  assert.equal(core.safeText(12), "12");
  assert.equal(core.safeText({ a: 1 }), '{"a":1}');
  // Angle brackets survive AS TEXT on purpose: the DOM suite proves they cannot
  // become markup (no innerHTML anywhere in the published app).
  assert.equal(core.safeText('<script>alert(1)</script>'), "<script>alert(1)</script>");

  // e4 - the timeline rows a hostile bundle produces are still bounded, ordered
  // structs with sanitized routes (the DOM layer renders exactly these fields).
  const rows = core.timelineRows(parsedHostile.bundle);
  assert.equal(rows.rows.length, 3);
  assert.deepEqual(Object.keys(rows.rows[0]).sort(), ["at", "detail", "index", "kind", "route", "seq"]);
  assert.equal(core.MAX_RENDERED_ROWS, 500);
  const many = core.timelineRows({ version: 2, timeline: new Array(600).fill(0).map((_, i) => ({ seq: i + 1, at: 1 + i, kind: "click" })) });
  assert.equal(many.rows.length, 500);
  assert.equal(many.truncated, 100);

  // e5 - screenshot attachment is bounded by distance, so a screenshot cannot be
  // shown next to an unrelated event.
  assert.equal(core.SHOT_ATTACH_MS, 3_000);
  const shot = core.attachShot(parsedHostile.bundle, v2.at + 2_000);
  assert.ok(shot, "a shot within the window attaches");
  assert.equal(core.attachShot(parsedHostile.bundle, v2.at + 60_000), null, "a far-away event gets no screenshot");
});

test("F108-f: PRIVACY fence - the published page cannot reach the network or build markup", () => {
  const NETWORK = [
    [/\bfetch\s*\(/, "fetch("],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bnew\s+WebSocket\b/, "new WebSocket"],
    [/\bsendBeacon\b/, "sendBeacon"],
    [/\bEventSource\b/, "EventSource"],
    [/\bnavigator\.serviceWorker\b/, "serviceWorker"],
    [/\bimportScripts\s*\(/, "importScripts("],
  ];
  const MARKUP = [
    [/\.innerHTML\b/, ".innerHTML"],
    [/\.outerHTML\b/, ".outerHTML"],
    [/\binsertAdjacentHTML\s*\(/, "insertAdjacentHTML("],
    [/\bdocument\.write\s*\(/, "document.write("],
    [/(?<![\w.$])eval\s*\(/, "eval("],
    [/\bnew\s+Function\s*\(/, "new Function("],
    [/\bcreateContextualFragment\b/, "createContextualFragment"],
  ];
  for (const rel of PUBLISHED_JS) {
    const text = read(rel);
    for (const [re, label] of NETWORK) {
      assert.ok(!re.test(text), rel + " must not contain " + label + " - the replay viewer is an offline tool (F108 §privacy)");
    }
    for (const [re, label] of MARKUP) {
      assert.ok(!re.test(text), rel + " must not contain " + label + " - bundle text is rendered with textContent only (F108 §1)");
    }
  }
  // The CSS and the HTML must not pull anything either, and not one published
  // file may name a remote origin.
  for (const rel of PUBLISHED) {
    const text = read(rel);
    assert.ok(!/@import\s+url\s*\(/i.test(text), rel + " must not @import a remote stylesheet");
    assert.ok(!/https?:\/\//.test(text), rel + " must not reference an absolute http(s) URL - the page is offline-complete");
    assert.ok(!/url\s*\(\s*['"]?https?:/i.test(text), rel + " must not load a remote url()");
  }
  // The reader is imported, not re-implemented (V2 vacuity probe): app.js must
  // name the vendored core, and must not redeclare its entry points.
  const app = read("docs/replay/app.js");
  assert.ok(app.includes('from "./vendor/replay/replayCore.js"'), "app.js must import the vendored reader core");
  for (const fn of ["classifyInput", "parseBundle", "summarize", "safeImageSrc"]) {
    assert.ok(app.includes("core." + fn), "app.js must call core." + fn + " (one reader, no second parser)");
  }
});

test("F108-g: the published page is CSP-locked, script-src 'self', and wired to its reader", () => {
  const html = read("docs/replay/index.html");
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ]) {
    assert.ok(html.includes(directive), "the CSP must carry `" + directive + "`");
  }
  assert.ok(/<meta\s+http-equiv="Content-Security-Policy"/.test(html), "the CSP must be a meta tag on the page itself, not an assumption about a server");
  assert.ok(html.includes('<meta name="referrer" content="no-referrer" />'), "no referrer leak when the operator opens a recording");

  // No inline script, no inline handler: everything the page runs is a same-origin
  // file, which is what makes `script-src 'self'` mean something.
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/gi, "")), "no inline <script> may exist on the page");
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<meta[^>]*>/gi, "")), "no inline on*= handler may exist on the page");
  assert.ok(html.includes('<script type="module" src="./app.js"></script>'), "the page must load app.js as a same-origin module");

  // Wire pins: every element the app addresses must exist in the shipped markup,
  // otherwise `mountViewer` half-binds and the page silently does nothing.
  const app = read("docs/replay/app.js");
  const ids = Array.from(app.matchAll(/q\("([a-z0-9-]+)"\)/g)).map((m) => m[1]);
  assert.ok(ids.length >= 15, "the app must address the shipped panels (found " + ids.length + " ids)");
  for (const id of new Set(ids)) {
    assert.ok(html.includes('id="' + id + '"'), 'index.html must carry id="' + id + '" for app.js to bind');
  }
  for (const testid of ["replay-tab-timeline", "replay-tab-shots", "replay-tab-dom", "replay-tab-storage", "replay-tab-features", "replay-tab-summary"]) {
    assert.ok(html.includes('data-testid="' + testid + '"'), "the tab bar must expose " + testid);
  }

  // The published tree must be self-describing for the operator.
  assert.ok(exists("docs/REPLAY.md"), "docs/REPLAY.md must ship with the viewer");
  assert.ok(read("docs/REPLAY.md").includes("replay/index.html"), "…and must say where the viewer lives");
  assert.ok(exists("docs/.nojekyll"), "docs/.nojekyll must stay: it is what makes docs/replay/ serve as static files");
});

test("F108-h: publishing stays a DELIBERATE act - at most one deploys Pages, and it is not on push", () => {
  const dir = path.join(ROOT, ".github/workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const deployers = [];
  for (const f of files) {
    const text = read(path.join(".github/workflows", f));
    const usesPagesAction = /uses:\s*actions\/(deploy-pages|upload-pages-artifact|configure-pages)/.test(text);
    // NOTE: the match is on the official actions, not on the string "gh-pages":
    // main.yml legitimately writes `C:\ghrdp\gh-pages-token.txt` for the runner's
    // own publisher, and a filename is not a deployment.
    if (usesPagesAction) deployers.push([f, text, usesPagesAction]);
  }
  // Nothing anywhere may push a gh-pages BRANCH any more (the branch-folder
  // source is what GitHub's own publisher used; two publishers, two sites).
  for (const f of files) {
    const text = read(path.join(".github/workflows", f));
    assert.ok(!/git\s+push[^\n]*gh-pages/.test(text), f + " must not push a gh-pages branch (F108: one publisher)");
  }
  assert.deepEqual(
    deployers.map((d) => d[0]),
    ["replay-viewer.yml"],
    "exactly one workflow may deploy Pages (F108). Adding a second deployer is how two publishers end up fighting over one site."
  );
  const [, text, usesPagesAction] = deployers[0];
  assert.ok(usesPagesAction, "replay-viewer.yml must use the official Pages actions");
  assert.ok(/\bworkflow_dispatch\s*:/.test(text), "the deployer must also be hand-runnable (the operator's one click)");
  assert.ok(!/^\s*pull_request\s*:/m.test(text), "the deployer must not run on pull requests");
  // The push trigger is allowed ONLY fenced to the viewer's own paths. An unfenced
  // deployer (or a `docs/**` filter) would re-publish the site on every watchdog
  // commit - main gets one every ~80 s - and that is how a docs tree starts
  // serving whatever the last heartbeat happened to write.
  const pushBlock = text.slice(text.indexOf("\n  push:"));
  assert.ok(pushBlock.length > 0, "the push trigger must be present (the merge of this PR is what makes the viewer public)");
  const pushSection = pushBlock.slice(0, 700);
  assert.match(pushSection, /branches:\s*\[\s*main\s*\]/, "the push trigger must be fenced to main");
  assert.match(pushSection, /paths:/, "the push trigger must carry a `paths:` filter, never `paths-ignore` on a heartbeat file");
  assert.ok(!/paths-ignore/.test(pushSection), "a paths-ignore filter would still fire on every other docs/ commit");
  for (const tooBroad of ['"docs/**"', 'docs/**', "docs/status.json", '"**"']) {
    assert.ok(!pushSection.includes(tooBroad), "the push filter must not include " + tooBroad + " (that is the watchdog heartbeat path)");
  }
  assert.ok(pushSection.includes('"docs/replay/**"'), "the push filter must cover the viewer's own directory");
  assert.ok(/permissions:[\s\S]*pages:\s*write/.test(text), "deploy-pages needs pages: write");
  assert.ok(/id-token:\s*write/.test(text), "deploy-pages needs id-token: write (OIDC)");
  assert.ok(/environment:\s*github-pages/.test(text), "the job must target the github-pages environment");
  assert.ok(text.includes("docs/replay/index.html"), "the deployer must assert the viewer is present before it publishes anything");
});

test("F108-j: the shipped synthetic sample replays, is fenced, and carries no real data", async () => {
  const text = read("docs/replay/sample.mcrec");
  assert.ok(text.length > 500 && text.length < 65_536, "the sample must be small enough to commit without thinking about it");
  const core = await publishedCore();
  const cls = core.classifyInput(text);
  assert.equal(cls.kind, "json-text", "the sample ships as the exported-file shape, like F107's Export writes");
  const parsed = core.parseBundle(cls.jsonText);
  assert.equal(parsed.ok, true, "the sample must satisfy the SHIPPED validator: " + parsed.reason);
  const v = core.verdict(parsed.bundle);
  assert.ok(v.counts.timeline >= 3, "the sample must have a timeline worth scrubbing");
  assert.ok(v.counts.shots >= 1 && v.counts.shots <= 3);
  assert.equal(v.counts.refusedShots, 0);
  assert.deepEqual(v.warnings, [], "the sample is the first thing an operator opens - it must not open on a warning");
  for (const shot of parsed.bundle.shots) {
    assert.ok(core.safeImageSrc(shot).startsWith("data:image/png;base64,"), "every sample shot must pass the fence");
  }
  // It must be obviously synthetic and must not carry anything that looks like a
  // credential (the route sentinel is there on purpose: it proves the sanitizer).
  assert.ok(!/\b(ghp_|github_pat_|ghs_|gho_)\w+/.test(text), "no token-shaped string may ship in the sample");
  assert.ok(!/\bsk-[A-Za-z0-9]{16,}/.test(text));
  assert.ok(text.includes("SECRET-should-never-render"), "the deliberate route sentinel is what proves sanitization end to end");
  const summary = core.summarize(parsed.bundle);
  assert.ok(!summary.includes("SECRET-should-never-render"), "…and it must be gone by the time the summary is printed");
  assert.ok(summary.includes("no network was used"));
});

test("F108-i: zero new dependencies, and step 3 / step 6 exports are untouched", async () => {
  const pkg = JSON.parse(read("package.json"));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const banned of ["dompurify", "html2canvas", "jszip", "pako", "jsdom-global"]) {
    assert.ok(!names.includes(banned), "F108 ships no runtime dependency (rejected: " + banned + ")");
  }
  // The published viewer is hand-written JS + JSON parsing that already exists in
  // the repo; a dependency here would also have to be published under docs/.
  assert.equal(pkg.dependencies.html2canvas, undefined, "the retired F107 rasterizer must stay retired (MH-a)");

  // NON-REGRESS: the two producers this reader consumes still behave exactly as
  // their own gates describe, so "the viewer handles both formats" cannot rot
  // while this file is green.
  const v1 = await v1Fixture();
  const v2 = await v2Fixture();
  const dvrCore = await mod("src/lib/dvr-core.js");
  const exportCore = await mod("src/lib/dvr/exportCore.js");
  assert.equal(v1.line.startsWith("mcrec1:plain:"), true, "step 3's clipboard envelope tag is unchanged");
  assert.equal(exportCore.DVR_V2_ENVELOPE, "mcrec2", "step 6's file envelope tag is unchanged");
  assert.equal(dvrCore.DVR_FORMAT, "mcrec");
  assert.equal(dvrCore.DVR_VERSION, 1);
  assert.equal(exportCore.validateBundleV2(v2.bundle).ok, true, "the v2 fixture must satisfy the shipped validator, not this test's idea of it");
  assert.equal(dvrCore.ringStats(v1.bundle.entries).count, 3);
});
