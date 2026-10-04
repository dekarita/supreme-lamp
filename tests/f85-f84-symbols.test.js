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
  const i = SERVER.indexOf("$f84DestDir = Join-Path $env:USERPROFILE 'Desktop\\RDP-Downloads'");
  assert.ok(i > 0, "the download destination is missing");
  const body = SERVER.slice(i, i + 2600);
  assert.match(body, /-replace '\[\^A-Za-z0-9\._-\]', '_'/, "the filename sanitiser is missing (path traversal)");
  assert.match(body, /Trim\('\.'\)/, "leading/trailing dots are not trimmed ('.'/'..' filenames)");
  assert.match(body, /Test-F78SameHost|ToLowerInvariant\(\) -replace '\^www\\\.'/, "the www-tolerant final-host guard is missing");
  assert.match(SERVER, /ok = \$true; path = \$f84Path; bytes = \$f84Bytes/, "the {ok,path,bytes} envelope is missing");
  assert.match(RESULTS, /download: true/, "the UI does not send download=true");
  assert.match(RESULTS, /download\.success/, "the UI does not toast the written path");
});

test("F85-5: launchUrl() has no window.open fallback, and main.tsx installs the detection handle", () => {
  // Comments may NAME the removed API (the F84 rationale does); the CODE must
  // not call it, so strip every //-comment line before the check.
  const launchCode = LAUNCH.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/window\.open/.test(launchCode), "window.open came back into src/lib/launchUrl.ts");
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
