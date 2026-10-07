// [F-TESTID / Observatory step 1] 100% data-testid coverage over every clickable
// in the dashboard. #163 §4 counted 150 button sites with 63 of them untest-id'd;
// F104's global capture, F105's registry, F106's lab harnesses and F107's DVR all
// address elements by test id, so an unnamed button is an invisible button.
// This gate fails on any button that cannot be addressed and proves the shared
// primitives actually FORWARD the id to the DOM node (a prop that is accepted and
// dropped would make every call site look covered while nothing is addressable).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const PRIMITIVES = "src/components/primitives/";
// Tags that put a real <button> (or an equivalent clickable) in the DOM.
const BUTTON_TAGS = ["button", "Button", "IconButton", "CopyButton", "Toggle"];
const TAG_RE = new RegExp("^<(" + BUTTON_TAGS.join("|") + ")\\b");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (rel === "src/tests") continue; // test doubles are not UI surface
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name) && /tsx$/.test(e.name)) {
      out.push({ rel, abs: p });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// Character scanner instead of a bare regex: JSX text and // comments can contain
// the literal string "<button>" (PrimaryActions.tsx does exactly that in a
// comment), and attribute values contain "//" (URLs), so neither a line-based
// grep nor a naive comment strip is safe here.
function tagStarts(src) {
  const hits = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
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
    if (c === "<") {
      const m = TAG_RE.exec(src.slice(i, i + 24));
      if (m) {
        hits.push({ tag: m[1], at: i + 1 });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return hits;
}

// The full opening tag: from the tag name to the ">" that is NOT inside a string
// literal and NOT nested inside a {...} expression (icon={<X/>} must not close it).
function tagExtent(src, from) {
  let j = from, depth = 0, inS = false, q = "";
  while (j < src.length) {
    const c = src[j];
    if (inS) {
      if (c === "\\") { j += 2; continue; } // an escape consumes BOTH chars
      if (c === q) inS = false;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inS = true; q = c; j++; continue; }
    if (c === "{") { depth++; j++; continue; }
    if (c === "}") { depth--; j++; continue; }
    if (c === ">" && depth === 0) return src.slice(from, j + 1);
    j++;
  }
  return src.slice(from);
}

function collect() {
  const sites = [];
  for (const { rel, abs } of walk(SRC)) {
    const src = fs.readFileSync(abs, "utf8").replace(/\r\n?/g, "\n");
    for (const h of tagStarts(src)) {
      const text = tagExtent(src, h.at).replace(/\s+/g, " ");
      sites.push({
        file: rel,
        line: src.slice(0, h.at - 1).split("\n").length,
        tag: h.tag,
        text,
        hasTestId: /(^|[\s{])data-testid\s*[=}]/.test(text),
        spreadsRest: /\{\s*\.\.\.rest\s*\}/.test(text),
      });
    }
  }
  return sites;
}

const SITES = collect();
const isPrimitive = (s) => s.file.startsWith(PRIMITIVES);
// A primitive's own <button> is the forwarding layer: it is covered when it
// carries a data-testid itself or spreads caller props ({...rest}) so the CALL
// SITE can supply one. Anything else must name itself.
const UNCOVERED = SITES.filter((s) => !s.hasTestId && !(isPrimitive(s) && s.spreadsRest));
const describe = (s) => s.file + ":" + s.line + " <" + s.tag + "> " + s.text.slice(0, 120);

test("F-TESTID-a: the scanner sees the whole inventoried clickable population", () => {
  // #163 §4 counted 150 button sites by grep line: 115 raw "<button>" + 19
  // "<Button>" + 3 "<IconButton>". That grep also counted the literal string
  // "<button>" written inside the F94 §3.3 comment in PrimaryActions.tsx, and it
  // under-counted multi-line tags (<Button in mirror/MirrorHostMatrix), so the
  // tag-extent truth is 114 native sites and 30 <Button> sites. The floors below
  // are the proven populations: a scan that silently shrinks (or a button that
  // moves into a file the scanner skips) must fail loudly, not vacuously.
  assert.ok(SITES.length >= 174, "scanner found only " + SITES.length + " button sites - the audit is broken, not clean");
  const native = SITES.filter((s) => s.tag === "button").length;
  assert.ok(native >= 114, "expected the 114 inventoried native <button> sites, found " + native);
  const byTag = {};
  for (const s of SITES) byTag[s.tag] = (byTag[s.tag] || 0) + 1;
  for (const t of BUTTON_TAGS) assert.ok(byTag[t] > 0, "no <" + t + "> site found at all - tag list or scanner drifted");
});

test("F-TESTID-b: 100% of buttons carry data-testid (F104/F105/F106/F107 addressing)", () => {
  assert.deepEqual(UNCOVERED.map(describe), [], "unaddressable buttons: " + UNCOVERED.map(describe).join("\n"));
});

test("F-TESTID-c: test ids are kebab-case and every dynamic id is a real derivation", () => {
  // A primitive may forward a caller-supplied id instead of carrying a literal -
  // that is only honest when the prop is DECLARED (an undeclared prop silently
  // renders nothing and re-opens the gap rule B just closed).
  const FORWARDERS = new Set(
    walk(path.join(SRC, "components", "primitives"))
      .filter(({ abs }) => /"\s*data-testid\s*"\?\s*:\s*string/.test(fs.readFileSync(abs, "utf8")))
      .map((f) => f.rel)
  );
  const offenders = [];
  for (const s of SITES) {
    for (const m of s.text.matchAll(/data-testid="([^"]*)"/g)) {
      if (!/^[a-z0-9][a-z0-9]*(-[a-z0-9]+)*$/.test(m[1])) offenders.push(s.file + ":" + s.line + " -> \"" + m[1] + "\"");
    }
    if (FORWARDERS.has(s.file)) continue;
    for (const d of [...s.text.matchAll(/data-testid=\{([^}]*)\}/g)].map((m) => m[1].trim())) {
      if (!d) { offenders.push(s.file + ":" + s.line + " -> empty expression"); continue; }
      // literal-prefix concatenation, or a member-expression id (c.id / it.id) -
      // both always render a string, unlike a bare optional prop.
      const derived = /["'`][a-z0-9-]+-["'`]\s*\+/.test(d) || /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(d);
      if (!derived) offenders.push(s.file + ":" + s.line + " -> dynamic {" + d + "}");
    }
  }
  assert.ok(FORWARDERS.size >= 2, "Copy.tsx and Chip.tsx must both declare the forwarded data-testid prop");
  assert.deepEqual(offenders, [], "test ids must be kebab-case literals, a \"prefix-\" + derivation, or a member id: " + offenders.join(", "));
});


test("F-TESTID-d: literal test ids are unique across the UI (no copy-paste aliases)", () => {
  const seen = new Map();
  const dupes = [];
  for (const s of SITES) {
    for (const m of s.text.matchAll(/data-testid="([^"]*)"/g)) {
      if (seen.has(m[1])) dupes.push(m[1] + " @ " + s.file + ":" + s.line + " and " + seen.get(m[1]));
      else seen.set(m[1], s.file + ":" + s.line);
    }
  }
  assert.deepEqual(dupes, [], "duplicate literal data-testid values: " + dupes.join("; "));
});

test("F-TESTID-e: the primitives FORWARD the id to the DOM, they do not absorb it", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const copy = read("src/components/primitives/Copy.tsx");
  const chip = read("src/components/primitives/Chip.tsx");
  const data = read("src/components/primitives/Data.tsx");
  const collapse = read("src/components/primitives/Collapse.tsx");
  const btn = read("src/components/primitives/Button.tsx");
  // CopyButton/CopyLink/Toggle accept the attribute and hand it to the node.
  for (const [name, body] of [["CopyButton", copy], ["CopyLink", copy], ["Toggle", chip]]) {
    assert.ok(body.includes('"data-testid"?: string;'), name + " must declare the data-testid prop");
  }
  assert.ok(/export function CopyButton\(\{[\s\S]*?"data-testid": dataTestId,[\s\S]*?\}\) \{/.test(copy), "CopyButton must destructure data-testid");
  assert.ok(copy.includes("data-testid={dataTestId}"), "the primitives must forward data-testid to the DOM node");
  assert.ok(chip.includes("data-testid={dataTestId}"), "Toggle must forward data-testid to its <button>");
  // Button/IconButton reach the DOM through {...rest}; MaskedField/Tabs derive.
  assert.equal((btn.match(/\{\s*\.\.\.rest\s*\}/g) || []).length, 2, "Button + IconButton must keep spreading caller props");
  assert.ok(data.includes('data-testid={"field-reveal-" + id}'), "MaskedField reveal must derive its test id from the field id");
  assert.ok(data.includes("data-testid=\"table-density-comfortable\"") && data.includes("data-testid=\"table-density-compact\""), "DataTable density toggles must be addressable");
  assert.ok(collapse.includes('data-testid={"tab-" + tb.id}'), "Tabs must derive one test id per tab (F106 lab harnesses key off these)");
});

test("F-TESTID-f: no new test id can fall into the F104 capture blind spots", () => {
  // GLOBAL_CLICK_IGNORE drops [data-testid^='collector-'] and [data-testid^='click-now-']
  // so the Collector never records its own UI. Naming an ordinary button that way
  // would delete it from the DVR silently - the one regression this step could
  // cause. Only the Collector page and the capture module may use those prefixes.
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const IGNORED_PREFIXES = ["collector-", "click-now-"];
  const offenders = [];
  for (const s of SITES) {
    if (s.file === "src/pages/Collector.tsx" || s.file === "src/lib/globalClickCapture.ts") continue;
    for (const m of s.text.matchAll(/data-testid="([^"]*)"/g)) {
      if (IGNORED_PREFIXES.some((p) => m[1].startsWith(p))) offenders.push(s.file + ":" + s.line + " -> " + m[1]);
    }
  }
  assert.deepEqual(offenders, [], "buttons named into the capture ignore-list: " + offenders.join(", "));
  const CAP = read("src/lib/globalClickCapture.ts");
  assert.ok(CAP.includes("[data-testid^='collector-']"), "if the ignore-list changes, this gate must be re-derived, not deleted");
});
