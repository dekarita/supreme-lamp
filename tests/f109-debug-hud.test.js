// [F109 / Observatory step 8] Debug HUD - the Node gate.
//
// Auto-run by launch-gates.yml's `node --test tests/*.test.js` (no workflow edit).
// It EXECUTES the shipped pure core (src/lib/debugHudCore.js) and pins the wiring
// that jsdom cannot see cheaply. The DOM half is src/tests/smoke/f109-debug-hud.test.tsx.
//
// FALSIFY-3 (each applied, run, reverted; the rule that caught it is named):
//   M1 HUD_SHORTCUT / isHudShortcut accepts Ctrl+Shift+F12 (drop the ctrlKey check) -> F109-b
//   M2 isToggledOff ignores `enabled` (a stale toggle bites with the HUD off)       -> F109-c
//   M3 wsFrameDescriptor keeps the raw frame (adds `raw` to the descriptor)         -> F109-d
//   M4 stripUrl stops cutting at "?"                                                -> F109-d
//   M5 debugHud.ts wraps window.fetch for the Network panel                         -> F109-e
//   M6 DebugHUD mounted INSIDE <Routes>/AppShell instead of as chrome                -> F109-f
//   M7 the hello-frame tap passes the JSON (with the dash token) instead of "hello" -> F109-g
//   M8 revert the lab-generation fix in mockBackend.ts                              -> F109-h (+ DOM gate)
//   M9 restore F111's `(?::[^=]+)?` const annotation                                -> F109-i
//   M10 per-feature dynamic toggle keys (`HUD_TOGGLES_KEY + ":" + id`)              -> F109-f
// VACUITY probes: every static scan first asserts it can SEE the thing it scans for
// (the comment stripper keeps code, the file list is non-empty, the positive control
// matches), so a scan that silently reads nothing fails instead of passing.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
const importCore = () => import(path.join(ROOT, "src/lib/debugHudCore.js"));
const importInventory = () => import(path.join(ROOT, "src/lib/ci/inventoryCore.js"));

/** Strip // and /* *\/ comments (string-aware) so prose can never satisfy a code pin. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] || "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const F109_FILES = [
  "src/lib/debugHudCore.js",
  "src/lib/debugHud.ts",
  "src/lib/featureToggles.ts",
  "src/components/DebugHUD.tsx",
  "src/components/FeatureDisabledCard.tsx",
];

test("F109-a: the spec constants are pinned as LITERALS (a behaviour test that reads them is blind to drift)", async () => {
  const c = await importCore();
  assert.equal(c.HUD_ENABLED_KEY, "f109:enabled");
  assert.equal(c.HUD_TOGGLES_KEY, "f109:toggles");
  assert.equal(c.HUD_SHORTCUT, "Shift+F12");
  assert.deepEqual(c.HUD_PANEL_IDS, ["features", "network", "websocket", "toggles", "actions"]);
  assert.equal(c.HUD_RING_MAX, 100);
  assert.equal(c.HUD_URL_MAX, 200);
  assert.equal(c.HUD_SUMMARY_MAX, 4000);
  assert.deepEqual(c.HUD_NET_INITIATORS, ["fetch", "xmlhttprequest", "beacon"]);
  // the .d.ts mirrors the literals (a type that widens to `string` would let a typo compile)
  const dts = read("src/lib/debugHudCore.d.ts");
  assert.match(dts, /HUD_ENABLED_KEY: "f109:enabled";/);
  assert.match(dts, /HUD_TOGGLES_KEY: "f109:toggles";/);
  assert.match(dts, /HUD_SHORTCUT: "Shift\+F12";/);
});

test("F109-b: Shift+F12 and nothing else opens the HUD", async () => {
  const { isHudShortcut } = await importCore();
  const ev = (o) => Object.assign({ key: "F12", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, repeat: false }, o);
  assert.equal(isHudShortcut(ev({})), true, "Shift+F12");
  assert.equal(isHudShortcut(ev({ shiftKey: false })), false, "bare F12 belongs to the browser's devtools");
  assert.equal(isHudShortcut(ev({ ctrlKey: true })), false, "Ctrl+Shift+F12 stays with the browser (M1)");
  assert.equal(isHudShortcut(ev({ altKey: true })), false);
  assert.equal(isHudShortcut(ev({ metaKey: true })), false);
  assert.equal(isHudShortcut(ev({ repeat: true })), false, "auto-repeat must not flicker the overlay");
  assert.equal(isHudShortcut(ev({ key: "F11" })), false);
  assert.equal(isHudShortcut(ev({ key: "f12" })), false, "KeyboardEvent.key for the function key is exactly 'F12'");
  assert.equal(isHudShortcut(null), false);
  assert.equal(isHudShortcut(undefined), false);
});

test("F109-c: toggles are strict, immutable, known-ids-only - and bite ONLY while the HUD is enabled", async () => {
  const c = await importCore();
  const ids = ["overview", "health", "settings"];
  assert.equal(c.parseEnabled("true"), true);
  for (const v of ["TRUE", "1", "yes", "", null, undefined, "true "]) assert.equal(c.parseEnabled(v), false, "enabled must be exactly 'true', got " + JSON.stringify(v));
  assert.deepEqual(c.parseToggles('{"health":"off","bogus":"off","settings":"on"}', ids), { health: "off" }, "unknown ids and non-'off' values are dropped");
  for (const junk of ["not json", "[]", "null", "42", "", null]) assert.deepEqual(c.parseToggles(junk, ids), {});
  const a = {};
  const b = c.setToggle(a, "health", true);
  assert.deepEqual(a, {}, "setToggle must not mutate its input");
  assert.deepEqual(b, { health: "off" });
  assert.deepEqual(c.setToggle(b, "health", false), {});
  assert.equal(c.serializeToggles({ settings: "off", health: "off" }), '{"health":"off","settings":"off"}', "stable, sorted");
  assert.equal(c.serializeToggles({}), "", "nothing off = no value (the adapter then REMOVES the key)");
  // the default-off safety rule (M2): a toggle left in storage is inert while the HUD is off
  assert.equal(c.isToggledOff({ health: "off" }, "health", true), true);
  assert.equal(c.isToggledOff({ health: "off" }, "health", false), false);
  assert.equal(c.isToggledOff({ health: "off" }, "health", "true"), false, "only the boolean true counts");
  assert.equal(c.isToggledOff({ health: "off" }, "settings", true), false);
  assert.equal(c.featureCardState({ mounted: true }), "healthy");
  assert.equal(c.featureCardState({ mounted: false }), "idle");
  assert.equal(c.featureCardState({ mounted: true, lastError: "boom" }), "crashed");
  assert.equal(c.featureCardState({ mounted: true, lastError: "boom", disabled: true }), "disabled", "the operator's choice wins");
});

test("F109-d: privacy - no query string, no WS payload and no credential can leave through the HUD", async () => {
  const c = await importCore();
  const TOKEN = "s3cr3t-dash-token-abcdef123456";
  assert.equal(c.stripUrl("/api/x?key=" + TOKEN), "/api/x", "M4");
  assert.equal(c.stripUrl("wss://h/ws?key=" + TOKEN + "#frag"), "wss://h/ws");
  assert.equal(c.stripUrl("x".repeat(300)).length, 201, "200 chars + ellipsis");
  // a hostile frame: the dash token in the hello body, a token-looking type
  const hello = c.wsFrameDescriptor("in", JSON.stringify({ type: "hello", key: TOKEN }), 5);
  assert.deepEqual(hello, { dir: "in", type: "hello", bytes: JSON.stringify({ type: "hello", key: TOKEN }).length, ts: 5 });
  assert.ok(!JSON.stringify(hello).includes(TOKEN), "a descriptor never carries the payload (M3)");
  assert.deepEqual(Object.keys(hello).sort(), ["bytes", "dir", "ts", "type"], "exactly four fields, no room for a payload");
  assert.equal(c.wsFrameDescriptor("in", JSON.stringify({ type: "x".repeat(40) }), 0).type, "(json)", "a type tag must look like an identifier");
  assert.equal(c.wsFrameDescriptor("in", "<<" + TOKEN + ">>", 0).type, "(text)");
  assert.equal(c.wsFrameDescriptor("out", "pong", 0).type, "pong");
  assert.equal(c.wsFrameDescriptor("close", 1006, 0).type, "close:1006");
  assert.equal(c.wsFrameDescriptor("open", TOKEN, 0).type, "open");
  // resource rows are stripped, and non-network initiators are not rows at all
  const row = c.resourceToNetRow({ name: "https://h/api/progress?key=" + TOKEN, initiatorType: "fetch", duration: 12.6, responseStatus: 503, transferSize: 99 }, 7);
  assert.deepEqual(row, { ts: 7, kind: "fetch", url: "https://h/api/progress", ms: 13, status: 503, bytes: 99 });
  assert.equal(c.resourceToNetRow({ name: "/logo.png", initiatorType: "img", duration: 1 }, 0), null);
  assert.equal(c.resourceToNetRow({ name: "/x", initiatorType: "fetch", duration: 1 }, 0).status, null, "no responseStatus = unknown, not 0");
  // the share text: built from sanitised state, then redacted again, then capped
  const summary = c.buildHudSummary({
    when: "2026-10-08T00:00:00Z",
    route: "/settings?key=" + TOKEN,
    features: [{ id: "health", state: "crashed", lastError: "boom token=" + TOKEN }, { id: "settings", state: "healthy" }],
    network: [{ ts: 1, kind: "fetch", url: "/api/a?key=" + TOKEN, ms: 3, status: 500, bytes: 0 }],
    ws: { live: false, attempts: 3, frames: [hello] },
    togglesOff: ["mirror"],
    dvrRecording: true,
    fullDvr: false,
  });
  assert.ok(!summary.includes(TOKEN), "the share text must never contain the token");
  assert.match(summary, /health: crashed/);
  assert.match(summary, /\/api\/a -> 500/);
  assert.match(summary, /dev toggles off: mirror/);
  assert.equal(c.redactSecrets("Authorization=abc&key=zzz password=hunter2"), "Authorization=[redacted]&key=[redacted] password=[redacted]");
  assert.equal(c.redactSecrets("ghp_" + "a".repeat(36)), "[redacted-gh-token]");
  const huge = c.buildHudSummary({ features: Array.from({ length: 400 }, (_, i) => ({ id: "f" + i, state: "crashed", lastError: "e".repeat(150) })) });
  assert.ok(huge.length <= 4000 + "\n…(truncated)".length, "the share text is capped");
  const ring = [];
  for (let i = 0; i < 150; i++) c.pushRing(ring, i, c.HUD_RING_MAX);
  assert.equal(ring.length, 100);
  assert.equal(ring[0], 50, "oldest entries fall off first");
});

test("F109-e: the HUD observes and never wraps - no F109 file touches window.fetch or opens a network channel", () => {
  let scanned = 0;
  for (const rel of F109_FILES) {
    const raw = read(rel);
    const code = stripComments(raw);
    assert.ok(code.length > 200 && code.length < raw.length, rel + ": the comment stripper must keep code and drop prose (vacuity)");
    scanned += 1;
    for (const banned of ["window.fetch =", "window.fetch=", "globalThis.fetch", "fetch(", "XMLHttpRequest", "new WebSocket", "sendBeacon", "dangerouslySetInnerHTML", "innerHTML", "eval("]) {
      assert.ok(!code.includes(banned), rel + " contains banned token " + JSON.stringify(banned) + " (M5)");
    }
  }
  assert.equal(scanned, F109_FILES.length);
  // positive control: the scan really does see the passive observer it relies on
  assert.match(stripComments(read("src/lib/debugHud.ts")), /observe\(\{ type: "resource", buffered: true \}\)/);
  // and storage is touched ONLY by the two adapters that own a key
  const storageUsers = F109_FILES.filter((rel) => /localStorage/.test(stripComments(read(rel))));
  assert.deepEqual(storageUsers.sort(), ["src/lib/debugHud.ts", "src/lib/featureToggles.ts"]);
});

test("F109-f: wiring - chrome mount outside every fence, recorder-invisible root, boundary reads toggles without storage tokens", () => {
  const app = stripComments(read("src/App.tsx"));
  assert.ok(app.includes('import DebugHUD from "@/components/DebugHUD"'));
  const routesEnd = app.indexOf("</Routes>");
  const hud = app.indexOf("<DebugHUD />");
  assert.ok(routesEnd > 0 && hud > routesEnd, "the HUD must be mounted AFTER </Routes> - chrome, not a route (M6)");
  assert.ok(hud < app.indexOf("</HashRouter>"), "inside the router (it reads the location), outside the routes");
  assert.equal(app.split("<DebugHUD />").length - 1, 1, "mounted exactly once");
  assert.ok(!stripComments(read("src/components/layout/AppShell.tsx")).includes("DebugHUD"), "not inside AppShell: a crashed shell must not take the HUD with it");
  const hudSrc = read("src/components/DebugHUD.tsx");
  assert.match(hudSrc, /data-testid="debug-hud"\s+data-collector-ignore=""/, "the root carries F104's escape hatch");
  assert.ok(hudSrc.includes("createPortal("), "the overlay portals to document.body");
  assert.ok(!/<FeatureBoundary/.test(stripComments(hudSrc)), "HUD panels must not register in the F105 mount ledger the HUD reads");
  for (const id of ["features", "network", "websocket", "toggles", "actions"]) {
    assert.ok(hudSrc.includes(id + ":"), "panel " + id + " must be wired in PANELS/PANEL_LABEL");
  }
  // FeatureBoundary: toggles read via featureToggles, F105-j's banned token still absent
  const fb = read("src/components/primitives/FeatureBoundary.tsx");
  assert.ok(fb.includes('import { isFeatureToggledOff } from "@/lib/featureToggles"'));
  assert.equal((stripComments(fb).match(/isFeatureToggledOff\(this\.props\.feature\)/g) || []).length, 2, "read at mount + on a feature change, nowhere else");
  assert.ok(!fb.includes("localStorage"), "F105-j: the boundary stays storage-token-free");
  assert.ok(!fb.includes('"feature-disabled-"'), "the disabled card's ids live in FeatureDisabledCard.tsx (F105-k reads the FIRST literal here)");
  // one literal toggles key (M10): F111 cannot derive a `prefix + id` family
  const toggles = stripComments(read("src/lib/featureToggles.ts"));
  assert.ok(/localStorage\.getItem\(HUD_TOGGLES_KEY\)/.test(toggles));
  assert.ok(!/HUD_TOGGLES_KEY\s*\+|`[^`]*\$\{[^}]*\}[^`]*`\s*\)/.test(toggles), "no dynamic storage key in featureToggles.ts");
  for (const rel of F109_FILES) {
    const code = stripComments(read(rel));
    for (const m of code.matchAll(/localStorage\.(getItem|setItem|removeItem)\(\s*([^,)]+)/g)) {
      assert.match(m[2].trim(), /^HUD_(ENABLED|TOGGLES)_KEY$/, rel + ": every storage call takes one of the two declared key constants, got " + m[2]);
    }
  }
  // Settings writes through the lib, never the key itself
  const settings = stripComments(read("src/pages/Settings.tsx"));
  assert.ok(settings.includes("setHudEnabled(v)") && !settings.includes("f109:enabled"));
  assert.ok(settings.includes('data-testid="settings-debug-hud-toggle"'));
});

test("F109-g: the WebSocket tap describes frames and never hands the dash token to the HUD", () => {
  const src = stripComments(read("src/hooks/useDashboardPolling.ts"));
  const calls = [...src.matchAll(/recordWsFrame\(([^)]*\))?[^)]*\)/g)].map((m) => m[0]);
  assert.equal(calls.length, 5, "open + in + close + our two outgoing frames, got " + JSON.stringify(calls));
  assert.ok(src.includes('recordWsFrame("open")'));
  assert.ok(src.includes('recordWsFrame("in", evt.data)'));
  assert.ok(src.includes('recordWsFrame("out", "hello")'), "our hello frame is passed as a bare type tag (M7)");
  assert.ok(src.includes('recordWsFrame("out", "pong")'));
  for (const c of calls.filter((x) => x.includes('"out"'))) {
    assert.ok(!/token|key|JSON\.stringify/.test(c), "an outgoing tap must not carry the frame body: " + c);
  }
  const hello = src.indexOf('ws.send(JSON.stringify({ type: "hello", key: token }));');
  assert.ok(hello > 0, "positive control: the hello frame still exists where the tap expects it");
  assert.ok(src.indexOf('recordWsFrame("out", "hello")') > hello, "the tap follows the real send");
  // the tap is inert while the HUD is off (prod default-off)
  assert.match(stripComments(read("src/lib/debugHud.ts")), /export function recordWsFrame\([^)]*\): void \{\n\s+if \(!isHudEnabled\(\)\) return;/);
});

test("F109-h: lab-discovered prod bug stays fixed - a retired lab wrapper forwards, it never mocks", () => {
  const mock = read("src/lib/lab/mockBackend.ts");
  const code = stripComments(mock);
  assert.ok(code.includes("if (!gen.live) return bound(input, init);"), "the generation guard must sit first in labFetch (M8)");
  assert.ok(code.indexOf("if (!gen.live) return bound(input, init);") < code.indexOf("resolveMock(state.scenarios"), "guard BEFORE the scenario lookup");
  assert.ok(code.includes("generation.live = false;"), "uninstall must retire the generation whether or not it can unwrap");
  // the four F106 literals tests/f106-lab-routes.test.js pins are untouched
  for (const lit of ["window.fetch = originalFetch", "window.fetch === patchedFetch", "if (installs === 1) {", "patchedFetch = wrapper"]) {
    assert.ok(mock.includes(lit), "F106 pin moved: " + lit);
  }
});

test("F109-i: the two F111 gate bugs this step surfaced stay fixed", async () => {
  const inv = await importInventory();
  // (1) key-chord titles do not invent a feature id
  assert.deepEqual(inv.extractFeatureIds("F109: Debug HUD overlay (F12+Shift) with 5 panels, prod-safe default-off"), ["F109"]);
  assert.deepEqual(inv.extractFeatureIds("Shift+F12 / Shift-F12 / Ctrl+F12"), []);
  assert.deepEqual(inv.extractFeatureIds("F105 + F106"), ["F105", "F106"], "spaced plus still lists two ids");
  // (2) a .d.ts `declare const X: "lit";` cannot steal the next `=` in its file (M9)
  const consts = inv.collectStringConsts([
    { path: "x.d.ts", text: 'export declare const KEY_A: "f109:enabled";\nexport type Panel = "features" | "network";\n' },
    { path: "x.js", text: 'export const KEY_A = "f109:enabled";\nexport const KEY_B: string = "b-value";\n' },
  ]);
  assert.equal(consts.get("KEY_A").value, "f109:enabled", "the declaration-only line must not resolve to 'features'");
  assert.equal(consts.get("KEY_A").path, "x.js");
  assert.equal(consts.get("KEY_B").value, "b-value", "annotated initialisers still resolve");
  // and the real tree resolves both F109 keys to themselves
  const ledger = JSON.parse(read("src/lib/ci/stepLedger.json"));
  const f109 = ledger.entries.find((e) => e.featureIds.includes("F109"));
  assert.equal(f109.status, "open");
  assert.equal(f109.branch, "arena/33e36146-supreme-lamp");
  assert.deepEqual(inv.extractFeatureIds(f109.title), ["F109"], "the ledger title extracts exactly its declared id");
  for (const n of [176, 177]) {
    assert.equal(ledger.entries.find((e) => e.number === n).status, "merged", "#" + n + " merged on 2026-10-08 (API-verified)");
  }
});

test("F109-j: minimal footprint - zero dependencies, zero i18n keys, and handoff #11's three orphan keys reused", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(Object.keys(pkg.dependencies).length, 8, "no runtime dependency added");
  assert.equal(Object.keys(pkg.devDependencies).length, 21, "no dev dependency added");
  assert.ok(!("tinykeys" in pkg.dependencies) && !("tinykeys" in pkg.devDependencies), "the spec's tinykeys is not a dependency; the HUD carries its own matcher");
  const lock = read("tests/f-i18n-parity.test.js").match(/const EXPECTED_FLAT_KEYS = (\d+)/);
  assert.ok(lock, "positive control: the count lock is still declared");
  assert.equal(Number(lock[1]), 1030, "F109 moves no i18n count lock");
  const hud = read("src/components/DebugHUD.tsx");
  for (const k of ["dvr.fullStart", "dvr.fullStop", "dvr.fullWarning"]) {
    assert.ok(hud.includes('t("' + k + '")'), "handoff #11: the runtime full-capture switch reuses " + k);
  }
  assert.match(hud, /FULL_DVR_BUILD_ALLOWED = import\.meta\.env\.VITE_DVR_ENABLED !== "false" && import\.meta\.env\.VITE_F107_FULL_DVR !== "false"/, "a runtime switch must never override the build kill flags");
});
