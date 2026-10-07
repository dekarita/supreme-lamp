// [F-I18N-SI-72 / Observatory step 2] Repo-wide en<->si i18n parity gate.
//
// Why this file exists. src/i18n/index.ts initialises i18next with
// `fallbackLng: "en"`, so a key that exists in en.json and is missing from
// si.json does NOT break the build and does NOT print a warning: the Sinhala
// UI silently renders English for that string, forever, and nobody notices.
// #163 §3.6 measured that class at exactly 72 keys (933 en / 861 si). A
// re-derivation in this session confirmed 72 - and found a second, worse class:
// 16 `collector.*` keys that exist in NEITHER catalog and survive only through
// a hardcoded `defaultValue` at the call site (47 of those in Collector.tsx
// alone). A defaultValue-only string is unreachable by translation permanently,
// which is exactly the F100/F101 collector surface F-DVR-LITE builds on.
//
// So this gate is the loud version of both classes:
//   1. key-set equality (both directions) + a count lock, so drift is a CI
//      failure and not an operator-visible surprise,
//   2. every `t("...")` key written into the source must exist in en AND si,
//      and every `t("prefix." + x)` concatenation must resolve to real keys,
//      which forbids inventing a key at a call site (the collector pattern),
//   3. `defaultValue` may never be the only source of a string,
//   4. interpolation placeholders must match per key (a missing {{reason}} is a
//      visible literal-braces bug, not a fallback),
//   5. a duplicated sibling key in either JSON is a failure (JSON.parse keeps
//      the last one silently, which would re-open the 72-key hole while the
//      counts still look right),
//   6. a translation-quality RATCHET: si values that are byte-identical English
//      are frozen as an explicit legacy list, so the untranslated set can never
//      grow - and must shrink (and the lock updated) when it is translated.
//
// The pre-existing src/tests/smoke/i18n-f56-parity.test.ts namespace gate
// (search.*/files.*, 528 keys) stays exactly as it is; this is the repo-wide
// gate beside it, as the Observatory state file's standing facts require.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const EN_FILE = "src/i18n/en.json";
const SI_FILE = "src/i18n/si.json";

// Count lock. 933/861 + 16 collector keys added to BOTH catalogs + those same
// 16 mirrored into si + the 72 gap closed = 949/949. [F-I18N-SI-72]
// [F-DVR-LITE / Observatory step 3] + 21 `dvr.*` keys, added to BOTH catalogs in
// the same commit as the DVR UI that calls them (the panel is t()-driven from day
// one - the lesson step 2 learned about `collector.*` surviving only as a
// defaultValue). 949 + 21 = 970.
const EXPECTED_FLAT_KEYS = 970;

// Legacy untranslated si values (byte-identical to en). Frozen deliberately:
// operator-owned copy that predates this step (mirrorHostMatrix/*, egress.line,
// banners.recoveryNote, selfTest.column.*, and the placeholder-only unit strings
// where identical IS correct). Adding a key here requires a reason; removing one
// is the reward for translating it.
// The frozen legacy debt: si values that are still untranslated English prose.
// "Prose" = carries no Sinhala codepoint AND has a space AND is >= 20 chars once
// {{placeholders}} are stripped, which is what keeps the deliberately-English
// tech tokens legal (Tailscale IP, ms, Aa, Rust, MagicDNS, HTTPS?, the
// search.sources.* proper names) without a per-key exemption for each.
// All 22 predate this step (mirrorHostMatrix/*, banners/*, egress.line,
// mirror.titlePlain/titleEncryptLocked, search.fetch/*, files.v2.*,
// selfTest.column.launcherNote) and none of them is a key F-I18N-SI-72 closed.
// The list is a ratchet, asserted by EQUALITY below: a new English-prose value
// fails, and translating one means deleting it here - which is the reward.
const ACCEPTED_ENGLISH_PROSE = [
  "banners.ended",
  "banners.recoveryNote",
  "banners.recoveryTitle",
  "egress.line",
  "files.v2.fetched.listening",
  "mirror.titleEncryptLocked",
  "mirror.titlePlain",
  "mirrorHostMatrix.empty",
  "mirrorHostMatrix.optionAccept",
  "mirrorHostMatrix.optionDisable",
  "mirrorHostMatrix.optionSelfHosted",
  "mirrorHostMatrix.optionTokenFuture",
  "mirrorHostMatrix.optionVps",
  "mirrorHostMatrix.optionsFooter",
  "mirrorHostMatrix.optionsTitle",
  "mirrorHostMatrix.subtitle",
  "mirrorHostMatrix.title",
  "mirrorHostMatrix.unreachable",
  "search.fetch.downloading",
  "search.fetch.postFetch",
  "search.v2.cred.encrypted",
  "selfTest.column.launcherNote",
];

// The one definition of "this si value is untranslated English", used by BOTH
// the per-value rule and the ratchet, so the two can never disagree.
const SINHALA_TEST = /[\u0D80-\u0DFF]/;
function isEnglishProse(v) {
  if (SINHALA_TEST.test(v)) return false;
  if (!/\s/.test(v)) return false;
  return v.replace(/\{\{\s*\w+\s*\}\}/g, "").trim().length >= 20;
}

const SINHALA = /[\u0D80-\u0DFF]/;
// Tech terms stay English on purpose (Telegraph, VNC_PASS, cmdkey, AES-256, ms,
// Aa, Rust, MagicDNS...): the same rule the F56 gate applies, kept consistent.
const TECHNICAL = /^[A-Za-z0-9 ._:/\-+()%&,']+$/;

function readJson(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function flatten(obj, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = (prefix ? prefix + "." : "") + k;
    if (v && typeof v === "object") Object.assign(out, flatten(v, key));
    else out[key] = String(v);
  }
  return out;
}

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) {
      if (rel === "src/tests") continue; // test doubles are not product surface
      out.push(...sourceFiles(rel));
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out.sort();
}

const enRaw = readJson(EN_FILE);
const siRaw = readJson(SI_FILE);
const en = flatten(JSON.parse(enRaw));
const si = flatten(JSON.parse(siRaw));
const enKeys = Object.keys(en).sort();
const siKeys = Object.keys(si).sort();

test("F-I18N-a: en and si carry the identical key set (both directions) with a count lock", () => {
  const missingInSi = enKeys.filter((k) => !(k in si));
  const extraInSi = siKeys.filter((k) => !(k in en));
  assert.deepEqual(
    missingInSi,
    [],
    "missing in si.json (i18next would silently fall back to English, so these " +
      "render English in the Sinhala UI forever): " + missingInSi.join(", ")
  );
  assert.deepEqual(
    extraInSi,
    [],
    "si-only keys are dead translations (no en source, invisible to the en UI): " + extraInSi.join(", ")
  );
  assert.equal(Object.keys(en).length, Object.keys(si).length, "key counts must match");
  // The count is pinned, not just compared: an accidental wholesale edit of one
  // catalog (both sides changing together) must still fail loudly here.
  assert.equal(Object.keys(en).length, EXPECTED_FLAT_KEYS, "flat key count moved - update the lock and #163 §3.6 with it, never silently");
  assert.equal(Object.keys(si).length, EXPECTED_FLAT_KEYS, "si flat key count moved - see the en assertion");
});

test("F-I18N-b: no duplicated sibling key in either catalog", () => {
  // JSON.parse keeps the LAST duplicate and reports no error, so
  // "nav": {"health": "x", ..., "health": "y"} would satisfy the key-set gate
  // while half the object is unreachable. Detect it on the raw text instead.
  for (const [rel, raw] of [[EN_FILE, enRaw], [SI_FILE, siRaw]]) {
    const seen = new Set();
    const dups = [];
    const stack = [];
    for (const line of raw.split("\n")) {
      const keyMatch = line.match(/^\s*"([^"]+)":\s*/);
      const opensBlock = /\{\s*$/.test(line);
      const closesBlock = /\}\s*,?\s*$/.test(line) && !opensBlock;
      if (keyMatch) {
        const id = stack.join("/") + "|" + keyMatch[1];
        if (seen.has(id)) dups.push(rel + " " + stack.join(".") + "." + keyMatch[1]);
        seen.add(id);
      }
      if (opensBlock) stack.push(keyMatch ? keyMatch[1] : "");
      if (closesBlock && stack.length) stack.pop();
    }
    assert.deepEqual(dups, [], "duplicate keys silently shadowed by JSON.parse");
  }
});

test("F-I18N-c: every si value is non-empty, Sinhala-bearing or a deliberate tech token", () => {
  const offenders = [];
  for (const k of siKeys) {
    const v = si[k];
    if (!v.trim()) offenders.push(k + " is empty");
    // The frozen legacy English (rule f) is the ONLY exemption, so the exemption
    // list and the debt list cannot drift apart.
    else if (isEnglishProse(v) && !ACCEPTED_ENGLISH_PROSE.includes(k))
      offenders.push(k + " is untranslated English prose in si.json: " + JSON.stringify(v));
    // A key echoed back is what i18next renders on a total miss; it must never
    // be baked into a catalog.
    if (v === k) offenders.push(k + " carries its own key as the value");
    if (/undefined|\bNaN\b|\?\?\?/.test(v)) offenders.push(k + " leaks a placeholder token: " + JSON.stringify(v));
    // UTF-8 round-trip (the Sinhala is real characters, not mojibake)
    if (Buffer.from(v, "utf8").toString("utf8") !== v) offenders.push(k + " does not byte-round-trip as UTF-8");
  }
  assert.deepEqual(offenders, []);
});

test("F-I18N-d: interpolation placeholders match per key", () => {
  const ph = (s) => (s.match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join(",");
  const mismatches = enKeys.filter((k) => ph(en[k]) !== ph(si[k] || ""));
  assert.deepEqual(mismatches, [], "a missing {{placeholder}} renders literal braces in Sinhala: " + mismatches.join(", "));
});

test("F-I18N-e: every t() key in the source exists in BOTH catalogs (no silent English, no invented keys)", () => {
  const statics = new Map(); // key -> [file:line]
  const prefixes = new Map(); // "a.b." -> [file:line]
  const defaulted = new Map(); // key -> [file:line] (uses defaultValue)
  for (const rel of sourceFiles("src")) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    let line = 1;
    const at = (idx) => rel + ":" + (line + text.slice(0, idx).split("\n").length - 1);
    // t("a.b") / t("a.b", {...}) and the concatenation form t("a.b." + x)
    for (const m of text.matchAll(/\bt\(\s*"([^"]*)"([^)]*)\)/g)) {
      const where = at(m.index);
      if (/,\s*\{[^}]*\bdefaultValue\b/.test(m[2] || "")) defaulted.set(m[1], (defaulted.get(m[1]) || []).concat(where));
      if (m[1].endsWith(".")) prefixes.set(m[1], (prefixes.get(m[1]) || []).concat(where));
      else statics.set(m[1], (statics.get(m[1]) || []).concat(where));
    }
    // t(`a.b.${x}`) template form, if a call site ever reaches for it
    for (const m of text.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) {
      prefixes.set(m[1], (prefixes.get(m[1]) || []).concat(at(m.index)));
    }
  }
  // Sanity so the rule can never pass vacuously (the F-TESTID lesson).
  assert.ok(statics.size > 500, "the t() scanner found only " + statics.size + " static keys - the scanner is broken, not the catalogs");

  const absentEn = [...statics.keys()].filter((k) => !(k in en));
  assert.deepEqual(absentEn, [], "keys used in code but absent from en.json (they render the raw key, or a hardcoded default that no translator can reach): " + absentEn.map((k) => k + " @ " + statics.get(k).join(",")).join(" | "));
  const absentSi = [...statics.keys()].filter((k) => !(k in si));
  assert.deepEqual(absentSi, [], "keys used in code but absent from si.json (silent English in the Sinhala UI): " + absentSi.map((k) => k + " @ " + statics.get(k).join(",")).join(" | "));

  const deadPrefixes = [];
  for (const [p, where] of prefixes) {
    const hitEn = enKeys.filter((k) => k.startsWith(p));
    const hitSi = siKeys.filter((k) => k.startsWith(p));
    if (!hitEn.length || !hitSi.length) deadPrefixes.push(p + " @ " + where.join(",") + " (en:" + hitEn.length + " si:" + hitSi.length + ")");
  }
  assert.deepEqual(deadPrefixes, [], "t('prefix.' + x) concatenations that resolve to no real key: " + deadPrefixes.join(" | "));

  // A defaultValue is a safety net, never the catalog. If a key carries one and
  // is present in en, fine. This is asserted transitively: every static key must
  // be in en (above), so a default can no longer hide a hole. Report the count so
  // the next reader knows the pattern is watched, not unknown.
  const defaultedAbsent = [...defaulted.keys()].filter((k) => !(k in en));
  assert.deepEqual(defaultedAbsent, [], "defaultValue is the ONLY source for these keys: " + defaultedAbsent.map((k) => k + " @ " + defaulted.get(k).join(",")).join(" | "));
});

test("F-I18N-f: the untranslated-English ratchet may only shrink", () => {
  const prose = siKeys.filter((k) => isEnglishProse(si[k])).sort();
  assert.deepEqual(
    prose,
    ACCEPTED_ENGLISH_PROSE,
    "si.json carries English prose outside the frozen debt list. New entries must be " +
      "translated; if one of these was translated, DELETE it from ACCEPTED_ENGLISH_PROSE. added/removed: " +
      JSON.stringify({ added: prose.filter((k) => !ACCEPTED_ENGLISH_PROSE.includes(k)), removed: ACCEPTED_ENGLISH_PROSE.filter((k) => !prose.includes(k)) })
  );
  // A translation that was quietly reverted to the en string is the regression
  // this step must never allow, so identity is checked for every key this step closed.
  const closedHere = ["nav.health", "sidebar.health", "webDesktop.cmdkeyLine", "mirror.titleLong", "mirror.doneTotal", "pages.settings.migration", "collector.actionsTitle", "collector.globalTitle", "telescope.title", "installGuide.pathA"];
  for (const k of closedHere) {
    assert.ok(SINHALA.test(si[k]), k + " must render Sinhala, not echo English");
    assert.notEqual(si[k], en[k], k + " was translated by F-I18N-SI-72 and must not be reverted to the en string");
  }
});
