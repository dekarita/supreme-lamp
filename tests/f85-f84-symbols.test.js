// [F85 §0.E/§3] The F84 live-verify and the /api/version contract, pinned in
// bytes. `node --test tests/*.test.js` runs this in the launch-gates lane.
//
// Two jobs:
//   1. PROVE the five F84 symbols are in the shipped files (the §0.E check,
//      runnable on every future commit instead of once by hand).
//   2. PROVE /api/version answers from the SAME bytes: the four feature flags
//      are only honest while the code they advertise is really there, so this
//      file refuses to let the flags outlive the symbols.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SERVER = readFileSync("payloads/ghrdp-server.ps1", "utf8");
const ADD_SITE = readFileSync("src/components/search/AddSiteQuick.tsx", "utf8");
const LAUNCH = readFileSync("src/lib/launchUrl.ts", "utf8");
const MAIN = readFileSync("src/main.tsx", "utf8");
const RESULTS = readFileSync("src/pages/search/ResultsGrid.tsx", "utf8");
const BANNER = readFileSync("src/components/search/F85DiagnosticBanner.tsx", "utf8");

test("F85-1: normalizeUrl() gives a bare domain https:// and never rewrites an explicit http://", () => {
  const fn = ADD_SITE.slice(ADD_SITE.indexOf("export function normalizeUrl"), ADD_SITE.indexOf("/** True when the operator explicitly typed"));
  assert.match(fn, /return "https:\/\/" \+ trimmed\.replace\(\/\^\\\/\+\/, ""\)/, "the auto-https prepend is missing");
  assert.match(fn, /test\(trimmed\)\) return trimmed/, "an explicit scheme must be preserved (http:// is refused visibly, never rewritten)");
});

test("F85-2: Test-F78SameHost strips ^www. on BOTH sides (www-tolerance)", () => {
  const i = SERVER.indexOf("function Test-F78SameHost");
  assert.ok(i > 0, "Test-F78SameHost is missing from payloads/ghrdp-server.ps1");
  const body = SERVER.slice(i, i + 700);
  assert.match(body, /-replace '\^www\\\.', ''/, "the www-strip is missing");
  assert.match(body, /\$a -eq \$b/, "the compare must stay exact-host-minus-www (no suffix/wildcard matching)");
  // All three fences still call it.
  const callers = SERVER.split("Test-F78SameHost -Allowed").length - 1;
  assert.ok(callers >= 4, "the same-host fence is not applied on every path (expected >= 4 call sites, got " + callers + ")");
});

test("F85-3: the probe-answered host is stored AND allowlisted", () => {
  assert.match(SERVER, /canonicalHostname = \$f78CanonicalHost/, "the canonical host is not stored on the row");
  assert.match(SERVER, /if \(\$f78CanonicalHost -and \$f78CanonicalHost -ne \$f78Host\) \{ \$script:F78AllowHosts\[\$f78CanonicalHost\] = \$true \}/, "the canonical host is not added to the save-time allowlist");
  // F85 §2: the client must also CARRY it, or the operator cannot see it.
  const LAB = readFileSync("src/api/lab/index.ts", "utf8");
  assert.match(LAB, /canonicalHostname\?: string/, "CustomSourceRow lost the canonical hostname");
  assert.match(readFileSync("src/components/search/CustomSitesRow.tsx", "utf8"), /your-site-canonical-/, "the card does not render the canonical host");
});

test("F85-4: /api/fetch?download=true writes to Desktop\\RDP-Downloads with a sanitised name", () => {
  const i = SERVER.indexOf("function Invoke-F88DownloadToRdp");
  assert.ok(i > 0, "the F88 shared download helper is missing");
  const body = SERVER.slice(i, i + 6000);
  assert.match(body, /-replace '\[\^A-Za-z0-9\._-\]', '_'/, "the filename sanitiser is missing (path traversal)");
  assert.match(body, /Trim\('\.'\)/, "leading/trailing dots are not trimmed ('.'/'..' filenames)");
  assert.match(body, /Test-F78SameHost|ToLowerInvariant\(\) -replace '\^www\\\.'/, "the www-tolerant final-host guard is missing");
  assert.match(SERVER, /path = \[string\]\$f88Dl\.path; bytes = \[int64\]\$f88Dl\.bytes/, "the {ok,path,bytes} envelope is missing");
  assert.match(SERVER, /DOWNLOAD_VERIFY_FAILED/, "[F88 §C.1] the verification-failure code is missing");
  assert.match(RESULTS, /download: true/, "the UI does not send download=true");
  assert.match(RESULTS, /download\.success/, "the UI does not toast the written path");
});

test("F85-5: launchUrl() keeps its no-window.open-fallback contract; mirror mode is a SEPARATE, local-first call site [F91]", () => {
  // Comments may NAME the removed API (the F84 rationale does); the CODE must
  // not call it, so strip every //-comment line before the check.
  const launchCode = LAUNCH.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  // [F90 §C.2] Mode A calls window.open on purpose; [F91 §B.1] openMirrored
  // calls it on purpose TOO - mirror mode's local half is the DESIGN, not a
  // fallback (operator decision F91-2). The F85 invariant was never "never
  // call window.open" - it is "launchUrl() must never let a FAILED server call
  // silently open the operator's local browser". So the count is now exactly
  // TWO call sites, and the structural guard is scoped INSIDE launchUrl():
  const calls = launchCode.match(/window\.open\(/g) || [];
  assert.strictEqual(calls.length, 2, "launchUrl.ts must have exactly two window.open call sites (F90 Mode A + F91 openMirrored)");

  const launchBody = launchCode.slice(launchCode.indexOf("export async function launchUrl("), launchCode.indexOf("async function launchUrlViaServer"));
  assert.ok(launchBody.length > 200, "the launchUrl() body could not be extracted");
  const serverCall = launchBody.indexOf("await launchUrlViaServer(url)");
  assert.ok(serverCall > 0, "the server ladder call is missing");
  const before = launchBody.slice(0, serverCall);
  const after = launchBody.slice(serverCall);
  assert.ok(/window\.open\(/.test(before), "Mode A's window.open must run BEFORE the server call");
  // <- the actual F84/F85 guard, unchanged: no window.open anywhere in
  // launchUrl() after the ladder. Mirror mode CANNOT be reached from here.
  assert.ok(!/window\.open/.test(after), "window.open came back AFTER the server call - that is the silent fallback");
  assert.ok(!/openMirrored/.test(launchBody), "launchUrl() must not call openMirrored - the ladder's failure contract stays its own");

  const modeA = before.slice(before.indexOf('if (mode === "web-desktop") {'));
  assert.ok(/window\.open\(/.test(modeA), "Mode A's window.open is not inside its mode guard");
  assert.ok(/if \(win\) return/.test(modeA), "a blocked popup must fall through to the ladder, not report success");

  const modeB = after.slice(after.indexOf('mode === "tailscale-local"'));
  assert.ok(!/window\.open/.test(modeB), "tailscale-local must never open a window - it asks the operator instead");

  // [F91] mirror mode: local open FIRST, queue POST after, and NO other
  // window.open in the module.
  const mirrorBody = launchCode.slice(launchCode.indexOf("export async function openMirrored("));
  assert.ok(mirrorBody.length > 200, "openMirrored() is missing");
  const mirrorOpen = mirrorBody.indexOf("window.open(");
  // openMirrored delegates the queue write to queueLauncherJob() (shared with
  // the explorer/download jobs); the ORDER that matters is local-open first.
  const mirrorQueue = mirrorBody.indexOf('queueLauncherJob(url, "navigate")');
  assert.ok(mirrorOpen > 0 && mirrorQueue > mirrorOpen, "mirror mode must open locally BEFORE queueing to the launcher");
  assert.ok(launchCode.includes('fetch("/api/launcher/queue"'), "the launcher queue POST is missing");
  assert.ok(launchCode.includes("export async function queueLauncherJob("), "queueLauncherJob() is not exported");
  assert.strictEqual((mirrorBody.match(/window\.open\(/g) || []).length, 1, "mirror mode must have exactly one window.open");
  assert.ok(/noopener/.test(mirrorBody.slice(mirrorOpen, mirrorOpen + 120)), "the mirror popup must keep the noopener features");

  assert.match(LAUNCH, /export function installLaunchUrlHandle/, "the feature-detection installer is missing");
  assert.match(MAIN, /installLaunchUrlHandle\(\);/, "src/main.tsx does not install the handle");
});

test("F85-6: /api/version advertises exactly the four F84 features plus a sha", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/version')");
  assert.ok(i > 0, "/api/version route is missing");
  const block = SERVER.slice(i, SERVER.indexOf("if ($path -eq '/api/ping')", i));
  for (const key of ["autoHttps", "wwwTolerance", "noFallback", "downloadToRdp"]) {
    assert.match(block, new RegExp(key + " = \\$true"), key + " is not advertised");
  }
  assert.match(block, /\$f85Sha7 = \$f85Sha/, "the sha7 derivation is missing");
  assert.match(block, /Substring\(0, 7\)/, "sha7 is not truncated to 7 characters");
  // The route must be reachable BEFORE the file-serving fallbacks, and must not
  // leak anything credential-shaped.
  assert.ok(i < SERVER.indexOf("if (($path -eq '/') -or ($path -eq '/index.html'))"), "/api/version is shadowed by a later route");
  assert.ok(!/rdpPass|mirrorKey|dashToken/i.test(block), "/api/version must not touch secrets");
});

test("F85-7: the banner renders only under ?diag=1 and asks the server for the features", () => {
  assert.match(BANNER, /params\.get\("diag"\) === "1"/, "the diag gate is missing");
  assert.match(BANNER, /apiBase\(\) \+ "\/api\/version"/, "the banner does not probe /api/version");
  assert.match(BANNER, /typeof \(window as unknown as \{ launchUrl\?: unknown \}\)\.launchUrl === "function"/, "the no-fallback mark is not a real bundle probe");
});

test("F85-8: the results row keeps its DOM node across focus/selection (no swallowed click)", () => {
  // [F85 §2] The F85 e2e caught a REAL bug: clicking "Download to RDP" focused
  // the button -> the row's onFocus() set activeRowIndex -> the Row useCallback
  // (react-window's children) got a NEW identity -> React unmounted + remounted
  // every row -> the pressed node was gone before mouseup -> the browser fired
  // NO click event and the first click on ANY row button was silently lost.
  // Guard the two halves of the fix: in-Row subscriptions (stable identity) and
  // the onFocus guard (only the row itself may claim the active row).
  assert.match(RESULTS, /const rowActive = useSearchStore\(\(s\) => s\.activeRowIndex\)/, "the row must subscribe to activeRowIndex itself");
  assert.match(RESULTS, /const selected = useSearchStore\(\(s\) => s\.selectedIds\.includes\(r\.resultId\)\)/, "the row must subscribe to its own selection");
  assert.match(RESULTS, /const fetchRec = useSearchStore\(\(s\) => s\.fetches\[r\.resultId\]\)/, "the row must subscribe to its own fetch record");
  assert.match(RESULTS, /onFocus=\{\(e\) => \{\s*if \(e\.target === e\.currentTarget\) setActiveRow\(index\);\s*\}\}/, "the bubbled-focus guard is missing");
  const deps = RESULTS.slice(RESULTS.indexOf("    [rows, adapters,"), RESULTS.indexOf("    [rows, adapters,") + 200);
  for (const volatile of ["activeRowIndex", "selectedIds", "fetches"]) {
    assert.ok(!new RegExp("(^|[\\[,\\s])" + volatile + "(\\s*[\\],])").test(deps.split("]")[0] + "]"), "the Row useCallback must not close over " + volatile + " (that identity change remounts every row mid-click)");
  }
});

test("F85-9: the e2e mock advertises DELETE in CORS, or the confirm-delete can never pass", () => {
  const MOCK = readFileSync("tests/e2e/fixtures/mock-backend.mjs", "utf8");
  const allow = /"Access-Control-Allow-Methods":\s*"([^"]+)"/.exec(MOCK);
  assert.ok(allow, "the mock lost its CORS methods header");
  assert.match(allow[1], /DELETE/, "DELETE missing from Access-Control-Allow-Methods: the browser preflight fails and the request is never sent");
  assert.match(MOCK, /path\.startsWith\("\/api\/f58\/sources\/"\) && req\.method === "DELETE"/, "the mock lost its DELETE route");
});
