// [F92 §4.2] Shared fixture for the per-site specs. The SITES table mirrors
// $Script:F92Endpoints in payloads/ghrdp-server.ps1 - query and expectation
// are the SAME known-good values the F92 self-test probes, so a nightly HAR
// drift here and a red /#/health row are the same event seen from two sides.
// tubitv & pluto are browser-rendered: they carry no CI probe (amber rows by
// design) but DO record live HARs nightly.
import { test as base, expect } from "@playwright/test";
import { existsSync } from "node:fs";

export type SiteDef = {
  host: string;
  /** path+query for the live probe, relative to https://host */
  searchPath: string | null;
  /** absolute override (awesome reads a raw README, no search query) */
  url?: string;
  expect: RegExp;
  /** health-row id: search:<key> in the F92 selftest */
  key: string;
  /** expected status in the mock/selftest envelope */
  status: "pass" | "warn";
};

export const SITES: Record<string, SiteDef> = {
  openculture:      { host: "www.openculture.com",   searchPath: "/?s=Walter+Kaufmann",                                        expect: /walter_kaufmanns_lectures\.html/, key: "search:openculture",      status: "pass" },
  archive:          { host: "archive.org",           searchPath: "/search?query=title%3A%22A+Matter+of+Life+and+Death%22",    expect: /matteroflife/i,                   key: "search:archive",            status: "pass" },
  openverse:        { host: "api.openverse.org",     searchPath: "/v1/images/?q=Saturn%27s+Rings+in+Ultraviolet+Light",       expect: /Saturn/,                          key: "search:openverse",          status: "pass" },
  awesome:          { host: "raw.githubusercontent.com", searchPath: null, url: "https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md", expect: /PCAPTools|Network/i, key: "search:awesome", status: "pass" },
  gutenberg:        { host: "gutendex.com",          searchPath: "/books/?search=sherlock+holmes",                             expect: /Sherlock/,                        key: "search:gutenberg",          status: "pass" },
  standardebooks:   { host: "standardebooks.org",    searchPath: "/ebooks?query=dickens",                                      expect: /dickens/i,                        key: "search:standardebooks",     status: "pass" },
  librivox:         { host: "librivox.org",          searchPath: "/api/feed/audiobooks/?title=pride+and+prejudice&format=json", expect: /Pride/,                         key: "search:librivox",           status: "pass" },
  openlibrary:      { host: "openlibrary.org",       searchPath: "/search.json?q=the+lord+of+the+rings",                       expect: /Lord of the Rings/i,              key: "search:openlibrary",        status: "pass" },
  freemusicarchive: { host: "freemusicarchive.org",  searchPath: "/search/?quicksearch=moonlight",                             expect: /moonlight/i,                      key: "search:freemusicarchive",   status: "pass" },
  tubitv:           { host: "tubitv.com",            searchPath: "/search/office",                                             expect: /.*/,                              key: "search:tubitv",             status: "warn" },
  pluto:            { host: "pluto.tv",              searchPath: "/en/search/details?query=office",                            expect: /.*/,                              key: "search:pluto",              status: "warn" },
};

export const UPDATE_HAR = !!process.env.UPDATE_HAR;

/**
 * [F92 §4.4] HAR replay with the missing-fixture guard: routeFromHAR in
 * update mode records; in replay mode it only intercepts when the fixture is
 * committed. Playwright silently ignores a missing HAR with update:false -
 * that would make a replay run hit the LIVE network by accident, so we assert
 * the file exists instead and the spec fails LOUD (fixture contract).
 */
export async function harRoute(page: import("@playwright/test").Page, site: SiteDef) {
  const file = `tests/e2e/fixtures/${site.key.replace("search:", "")}.har`;
  if (UPDATE_HAR) {
    await page.routeFromHAR(file, { update: true, url: `**/${site.host}/**` });
    return;
  }
  if (existsSync(file)) {
    await page.routeFromHAR(file, { update: false, url: `**/${site.host}/**` });
  }
}

export const liveProbeUrl = (site: SiteDef): string =>
  site.url ?? `https://${site.host}${site.searchPath ?? "/"}`;

export { base as test, expect };
