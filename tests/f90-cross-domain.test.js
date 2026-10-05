// [F90 §B/§D] awesome.re cross-domain fix + self-test proof column.
//
// The server is a single PowerShell payload with no test host, so (like every
// other server test in this repo) the assertions are BYTE assertions on
// payloads/ghrdp-server.ps1: the exact tokens that make the behaviour true.
// That is deliberately low-tech - it is what lets a one-line edit in a 7000-line
// payload fail a build instead of failing on the operator's runner.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(
  path.join(__dirname, "..", "payloads", "ghrdp-server.ps1"),
  "utf8",
);
const HINTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "payloads", "data", "f88-site-hints.json"), "utf8"),
);

test("F90-a: awesome.re's hint really is the markdown-section strategy", () => {
  const hint = HINTS["awesome.re"];
  assert.ok(hint, "the awesome.re hint is missing from f88-site-hints.json");
  assert.strictEqual(hint.searchStrategy, "markdown-section");
  // The whole reason a cross-domain read is needed at all: the content lives on
  // a different host than the operator-added site.
  assert.strictEqual(hint.readmeUrl, "https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md");
  assert.strictEqual(hint.redirectTo, "https://github.com/sindresorhus/awesome");
});

test("F90-b: the cross-domain widening is ONE literal host, opt-in per fetch", () => {
  // The literal, and nothing but the literal.
  assert.ok(
    SERVER.includes("$script:F78CrossDomainHost = 'raw.githubusercontent.com'"),
    "the cross-domain host must be the raw.githubusercontent.com literal",
  );
  // Opt-in: no fetch is widened just because the script grew a new host.
  assert.ok(
    SERVER.includes("param([string]$Url, [string]$ExpectedHost, [int]$MaxBytes, [int]$TimeoutSec, [switch]$AllowCrossDomain)"),
    "Invoke-F78SecureFetch must take -AllowCrossDomain as an opt-in switch",
  );
  assert.ok(
    SERVER.includes("if ($AllowCrossDomain -and $f78A -eq $script:F78CrossDomainHost) { return $true }"),
    "the widening must be an exact-equality check against the one literal",
  );
  // The default fence still runs first, so an un-widened fetch is unchanged.
  assert.ok(
    SERVER.includes("$f78HostOk = Test-F78SameHost -Allowed $ExpectedHost -Actual $f78Uri.Host"),
    "the exact-host-minus-www fence must still be evaluated first",
  );
  assert.ok(
    SERVER.includes("if (-not $f78HostOk) { $f78HostOk = Test-F78AllowedHost -ExpectedHost $ExpectedHost -ActualHost $f78Uri.Host -AllowCrossDomain ([bool]$AllowCrossDomain) }"),
    "the cross-domain allowance must be the second, narrower check",
  );
});

test("F90-c: the host check runs on every redirect hop (no cross-domain chain)", () => {
  // Invoke-F78SecureFetch re-validates the host at the top of each hop, so the
  // only off-site host reachable is the literal - a 302 to github.com still 403s.
  const fn = SERVER.slice(
    SERVER.indexOf("function Invoke-F78SecureFetch {"),
    SERVER.indexOf("function Invoke-F86SitemapFetch {"),
  );
  assert.ok(fn.length > 0, "Invoke-F78SecureFetch not found");
  const hops = fn.split("for ($f78Hop = 0; $f78Hop -lt 3; $f78Hop++)")[1] || "";
  const checks = hops.split("Test-F78SameHost -Allowed $ExpectedHost -Actual $f78Uri.Host").length - 1;
  assert.strictEqual(checks, 1, "the host check must sit INSIDE the redirect loop");
  assert.ok(hops.includes("continue"), "a redirect must re-enter the loop, not bypass it");
});

test("F90-d: only the markdown-section strategy opts in", () => {
  const md = SERVER.slice(
    SERVER.indexOf("elseif ($f88Strategy -eq 'markdown-section') {"),
    SERVER.indexOf("elseif ($f88Strategy -eq 'html') {"),
  );
  assert.ok(md.includes("-AllowCrossDomain"), "the markdown-section readme fetch must opt in");
  // ...and no other strategy does.
  const json = SERVER.slice(
    SERVER.indexOf("if ($f88Strategy -eq 'json') {"),
    SERVER.indexOf("elseif ($f88Strategy -eq 'markdown-section') {"),
  );
  assert.ok(!json.includes("AllowCrossDomain"), "the json strategy must not widen the fence");
  const html = SERVER.slice(
    SERVER.indexOf("elseif ($f88Strategy -eq 'html') {"),
    SERVER.indexOf("function Invoke-F88SiteSearch", SERVER.indexOf("elseif ($f88Strategy -eq 'html') {")),
  );
  assert.ok(!html.includes("AllowCrossDomain"), "the html strategy must not widen the fence");
});

test("F90-e: resolved hosts are registered per source, after a PROVEN fetch", () => {
  const md = SERVER.slice(
    SERVER.indexOf("elseif ($f88Strategy -eq 'markdown-section') {"),
    SERVER.indexOf("elseif ($f88Strategy -eq 'html') {"),
  );
  assert.ok(
    md.includes("Register-F88CrossDomainHost -ForHost $HostName -Hosts @([string]$f88Fetch.host, $f88RedirectHost)"),
    "both the README host and the redirectTo host must be registered for the source",
  );
  // Proof-gated: registration happens after the ok check, never before.
  assert.ok(
    md.indexOf("$f88Fetch.ok") < md.indexOf("Register-F88CrossDomainHost"),
    "hosts must only be registered after the fetch succeeded",
  );
  // Scoped: keyed by the source's own hostname, not a global add.
  assert.ok(
    SERVER.includes("Register-F88CrossDomainHost -ForHost $HostName"),
    "registration must be scoped to the requesting source's hostname",
  );
});

test("F90-f: a later /api/lab/inspect on that source accepts the resolved hosts", () => {
  assert.ok(
    SERVER.includes("if (-not $f78HostAllowed -and $f78Host -and $script:F88CrossDomainHosts.ContainsKey($f78Host.ToLowerInvariant())) { $f78HostAllowed = $true }"),
    "/api/lab/inspect must accept hosts this source already proved",
  );
  // The original fence is untouched for every other source.
  assert.ok(
    SERVER.includes("if ($f78Host -and $script:F78AllowHosts.ContainsKey($f78Host)) { $f78HostAllowed = $true }"),
    "the operator-added allow-list must still be the primary gate",
  );
});

test("F90-g: the Lab can name the real source (repo + item count)", () => {
  assert.ok(SERVER.includes("sourceRepo = $(if ($f88Search) { [string]$f88Search.repo } else { '' })"));
  assert.ok(SERVER.includes("sourceItemCount = $(if ($f88Search) { [int]$f88Search.itemCount } else { 0 })"));
  // row 0 of a markdown-section result is the SECTION link, not an item.
  assert.ok(
    SERVER.includes("$f88Out.itemCount = [Math]::Max(0, $f88Rows.Count - 1)"),
    "the item count must exclude the section link row",
  );
});

test("F90-h: the self-test reports awesome.re's Networking item count", () => {
  const route = SERVER.slice(
    SERVER.indexOf("if ($path -eq '/api/f87-selftest' -and $parts.method -eq 'POST')"),
    SERVER.indexOf("function ", SERVER.indexOf("if ($path -eq '/api/f87-selftest' -and $parts.method -eq 'POST')") + 200),
  );
  assert.ok(route.includes("networkingItemCount"), "the self-test row must carry networkingItemCount");
  assert.ok(route.includes("$f87Row.networkingItemCount = [int]$f87Row.searchItems"));
  // It runs the REAL strategy, not a sitemap proxy - that is the whole proof.
  assert.ok(route.includes("Invoke-F88SiteSearch -HostName $f87Site"), "the self-test must run the real per-site search");
  assert.ok(route.includes("searchStrategy"), "the row must name the strategy it ran");
});
