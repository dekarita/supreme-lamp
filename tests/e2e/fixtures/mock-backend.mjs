// [F78 §E.2] Mock dashboard backend for the E2E-UI lane. Plain node:http, zero
// dependencies (express is NOT and will not become a dependency of this repo),
// bound to 0.0.0.0:7331 - the port src/lib/api.ts apiBase() targets whenever
// the page is not served from 7331/7332/https.
//
// Every response body comes from tests/e2e/fixtures/*.json so a spec can change
// the UI state it exercises without touching this file. Nothing here is a
// credential surface: the dash token is never checked, echoed or logged.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.F78_MOCK_PORT || 7331);

const readJson = (name) => JSON.parse(readFileSync(join(HERE, name), "utf8"));

/** [F87 §B.1/B.3] The eleven operator domains, read from the SAME fixture the
 *  F85 spec loops (f85-sites.json `sites`), so the mock's allowlist cannot
 *  drift from the list the operator types by hand. */
const F87_SITES = readJson("f85-sites.json").sites.map((s) => String(s).toLowerCase());

/** [F87 §B.1] hostname -> operator site. Lowercase, "www." stripped, exact match
 *  against the eleven; "" when the host is not one of them. */
function f87SiteOfHost(hostname) {
  const h = String(hostname || "").trim().toLowerCase().replace(/^www\./, "");
  return F87_SITES.includes(h) ? h : "";
}

/** [F87 §B.3] hostname -> fixture file: dots become dashes, so the file name
 *  equals the source id the UI routes on (/#/search/lab/<openculture-com>). */
const f87FixtureName = (hostname) => String(hostname).replace(/\./g, "-") + ".xml";

/** [F87 §B.1] source id -> operator site (the reverse of the id derivation the
 *  POST /api/f58/sources route applies: "pluto-tv" -> "pluto.tv"). Lets the deep
 *  lane answer for a site even when the stored row is not resolvable. */
function f87SiteOfId(sourceId) {
  const id = String(sourceId || "").trim().toLowerCase();
  return F87_SITES.find((s) => s.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === id) || "";
}

/** [F86 §D + F87 §B.4] The per-site sitemap fixtures: 60 REAL-shaped URLs each
 *  (the site's own path grammar: archive.org/details/..., gutenberg.org/ebooks/...,
 *  plus a few same-host .pdf/.mp3/.mp4 rows), the corpus the ten-site deep spec
 *  asserts (>= 50 URLs per site). Looked up by HOSTNAME (dots -> dashes). */
function f86SitemapRows(hostname) {
  let xml = "";
  try {
    xml = readFileSync(join(HERE, "f86-sitemaps", f87FixtureName(hostname)), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) out.push(m[1]);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [R-GLASS] The explorer's synthetic index, read lazily and cached. */
let fxIndexCache = null;
function fxIndex() {
  if (fxIndexCache) return fxIndexCache;
  try {
    fxIndexCache = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "src/components/explorer/data/fixtures/5000-files.json"), "utf8"));
  } catch {
    fxIndexCache = { schemaVersion: 2, generatedAt: new Date().toISOString(), runnerId: "mock", roots: [], files: [], gofileHosts: [] };
  }
  return fxIndexCache;
}

/** The launch-url calls the F86 spec inspects (tier proof). */
const launchCalls = [];
// [F91] every /api/launcher/queue job ever accepted, in order. The mirror-mode
// spec asserts the RDP half of a click lands here; navigate jobs ALSO record a
// launchCall so the F86/F88 specs' launch-readback keeps proving "the RDP side
// was asked" through the new transport.
const f91Jobs = [];
let f91JobSeq = 1;
/** [F87 §C.1] token -> last self-test run (ms), for the 1/min mirror. */
const selfTestRuns = new Map();
/** Added at runtime by POST /api/f58/sources so the "add then card appears"
 *  flow is observable without mutating the fixture file on disk. */
const added = [];
/** [F85 §4] Ids the spec deleted through the UI: a pre-seeded row must STAY
 *  deleted for the rest of the run, exactly like the server's persisted store. */
const deleted = new Set();
// [F79 D3] Derive mock defaults from the server, not a second hardcoded pack.
const serverSource = readFileSync(new URL("../../../payloads/ghrdp-server.ps1", import.meta.url), "utf8");
const defaultLiteral = serverSource.match(/\$script:DefaultFanOutAdapterIds\s*=\s*@\(([^)]*)\)/);
if (!defaultLiteral) throw new Error("F79 default fan-out source is missing");
const defaultAdapters = [...defaultLiteral[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const searches = new Map();
const searchRequests = [];
const canonicalAdapter = (id) => id === "arxiv" ? "arxiv-public" : id === "wikisource" ? "wikipedia-public" : id;
const nameKey = (id) => "search.sources." + id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const adapterRows = (ids, status, results = []) => ids.map((adapterId) => ({
  adapterId, nameKey: nameKey(adapterId), status,
  resultCount: results.filter((r) => r.adapterId === adapterId).length,
}));

function sources() {
  // Source ids are unique in production; a quick-add must not duplicate DOM ids.
  // [F85 §4] The pre-seeded set is the FIN10 operator fixture UNIONed with the
  // F78 servers, so the existing F78/F81 specs keep their rows while the F85
  // spec can assert one card per real site.
  const seeded = [...readJson("sources.json").sources, ...readJson("f85-sites.json").sources];
  return [...new Map([...seeded, ...added].map((s) => [s.id, s])).values()].filter((s) => !deleted.has(s.id));
}

/** [F85 §4] The fixture also lists the operator's bare domains verbatim, so a
 *  spec can loop the SAME names the operator will type by hand. */
function f85Sites() {
  return readJson("f85-sites.json").sites;
}

/** [F85 §4] Bare-domain normalisation mirroring the shipped client contract
 *  (src/components/search/AddSiteQuick.tsx normalizeUrl): an explicit scheme is
 *  preserved, anything else gains https://. An explicit http:// is NOT
 *  rewritten - it is refused, exactly like the server. */
function normalizeUrl(input) {
  const t = String(input || "").trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return "https://" + t.replace(/^\/+/, "");
}

/** [F85 §4] The Lab inspect response answers from the www.<host> form of the
 *  requested source. That is the real-world shape F84's www-tolerant same-host
 *  fence exists for: a bare-stored site whose server redirects to www must not
 *  surface lab.hostnameMismatch. Asserting the LINKS outside to the F78 fixture
 *  keeps the F78 match-count assertions byte-identical. */
function labInspect(sourceId) {
  const fixture = readJson("lab-inspect.json");
  const row = sources().find((s) => s.id === sourceId);
  const bare = (row && row.hostname) || fixture.hostname;
  const host = bare.startsWith("www.") ? bare : "www." + bare;
  // A real inspect returns the REQUESTED site's own links (the shipped server
  // drops off-host hrefs before answering). Keep the F78 fixture's texts and
  // path basenames - the F78 match/count assertions depend on both - and move
  // every href onto this site's www host so the response is host-coherent.
  const links = fixture.links.map((l) => {
    let base = l.href;
    try {
      base = new URL(l.href).pathname.split("/").filter(Boolean).pop() || "index.html";
    } catch {
      base = "index.html";
    }
    return { text: l.text, href: "https://" + host + "/" + base };
  });
  return { ...fixture, hostname: host, links };
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Dash-Token",
    // [F85 §2] DELETE must be advertised or the browser never sends it: the
    // page runs on :5173 and this mock on :7331, so the F81 confirm-delete
    // (DELETE is NOT a CORS-simple method) is always preflighted. With the old
    // "GET, POST, OPTIONS" the preflight failed, the request never left the
    // browser and the card stayed - the app reported the transport error. The
    // shipped server serves the UI same-origin and needs no CORS at all.
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  if (path === "/diag") {
    send(res, 200, { ok: true, searchEnabled: true, uiV2Default: true, ...readJson("diag.json") });
    return;
  }

  if (path.startsWith("/api/f58/sources/") && req.method === "DELETE") {
    // [F85 §4] Mirrors the shipped route: delete exactly one row, 404 on an
    // unknown id. The F85 spec's per-site flow (add -> delete -> gone) needs a
    // real handler, not a page.route stub.
    const id = decodeURIComponent(path.slice("/api/f58/sources/".length));
    const known = sources().some((s) => s.id === id);
    if (!known) {
      // [F91 §A.3] launcher queue: validation mirrors Test-F91QueueJob (mode set,
  // https-only navigate, explorer takes a Windows folder path ONLY), then the
  // job is accepted "as drained". The selftest noop mode is accepted too.
  if (path === "/api/launcher/queue" && req.method === "POST") {
    const body = await readBody(req);
    const mode = String(body?.mode || "").toLowerCase();
    const target = String(body?.url || "").trim();
    const MODES = ["navigate", "download", "explorer", "noop"];
    const okMode = MODES.includes(mode);
    const okTarget =
      mode === "explorer" ? /^[A-Za-z]:\\[^<>:"|?*]*$/.test(target)
      : (mode === "download" || mode === "noop") ? (target === "" || target.startsWith("https://"))
      : target.startsWith("https://") && !/[?&]#[^#]*$/.test(target) && target.length <= 2048 && !target.includes("@");
    if (!okMode || !okTarget) {
      send(res, 400, { code: "VALIDATION_ERROR", reason: !okMode ? "mode" : "url" });
      return;
    }
    const jobId = "f91-job-" + f91JobSeq++;
    f91Jobs.push({ id: jobId, url: target, mode, name: String(body?.name || ""), at: new Date().toISOString() });
    if (mode === "navigate") launchCalls.push({ url: target, at: new Date().toISOString() });
    send(res, 200, { ok: true, queuedAt: new Date().toISOString(), jobId });
    return;
  }
  if (path === "/api/launcher/health" && req.method === "GET") {
    send(res, 200, { ok: true, serviceRunning: true, heartbeatAge: 2000, heartbeatAt: new Date().toISOString(), queueDepth: 0, queueDir: "C:\\ProgramData\\ghrdp\\launcher-queue", log: ["<mock> startup launcher-service"], logPath: "C:\\ProgramData\\ghrdp\\launcher.log", taskExists: true, taskState: "Running", activeUser: "runner", scriptPresent: true });
    return;
  }
  if (path === "/__f91/jobs") {
    send(res, 200, { jobs: f91Jobs });
    return;
  }
  // [F91 §D.2] stream relay: exact-host allowlist (the eleven + added custom
  // hosts), then a 2 KB audio/ogg stub so the inline <audio> element has real
  // bytes; HEAD answers headers only. Off-allowlist -> 403 like the server.
  if (path === "/api/stream" && (req.method === "GET" || req.method === "HEAD")) {
    let host = "";
    try {
      const u = new URL(url.searchParams.get("url") || "");
      if (u.protocol !== "https:" || u.username) throw new Error("bad");
      host = u.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      send(res, 400, { code: "VALIDATION_ERROR" });
      return;
    }
    const known = new Set([...F87_SITES.map((x) => x.replace(/^www\./, "")), "example.com", "127.0.0.1", "localhost"]);
    if (!known.has(host)) {
      send(res, 403, { code: "HOSTNAME_MISMATCH", messageKey: "lab.hostnameMismatch" });
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": "2048" });
    res.end(Buffer.alloc(2048, 7));
    return;
  }

  send(res, 404, { code: "NOT_FOUND", messageKey: "search.errors.generic", retryable: false });
      return;
    }
    deleted.add(id);
    const idx = added.findIndex((s) => s.id === id);
    if (idx >= 0) added.splice(idx, 1);
    send(res, 200, { ok: true, deletedId: id });
    return;
  }

  if (path === "/api/f58/sources" && req.method === "GET") {
    send(res, 200, { sources: sources(), count: sources().length });
    return;
  }

  if (path === "/api/f58/sources" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || typeof body.name !== "string" || typeof body.baseUrl !== "string") {
      send(res, 400, { code: "VALIDATION_ERROR", messageKey: "newSiteNameRequired", retryable: false });
      return;
    }
    // [F85 §4] Normalise FIRST (bare domain -> https://<site>), then refuse an
    // explicit http:// with 400 - the operator-visible contract F84 shipped.
    body.baseUrl = normalizeUrl(body.baseUrl);
    if (!body.baseUrl.startsWith("https://") || body.baseUrl.includes("@")) {
      // The mock mirrors the shipped refusal ORDER: https first, then userinfo.
      const messageKey = body.baseUrl.startsWith("https://") ? "newSiteAuthNotAllowed" : "newSiteHttpsRequired";
      send(res, 400, { code: "VALIDATION_ERROR", messageKey, retryable: false });
      return;
    }
    let hostname = "";
    try {
      hostname = new URL(body.baseUrl).hostname;
    } catch {
      hostname = "";
    }
    if (!hostname) {
      send(res, 400, { code: "VALIDATION_ERROR", messageKey: "newSiteHttpsRequired", retryable: false });
      return;
    }
    const row = {
      id: hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      name: body.name,
      baseUrl: body.baseUrl.replace(/\/+$/, ""),
      hostname,
      // [F85 §4] The bare-stored site answered from www.<host>: the save-time
      // probe target the server stores and allowlists alongside the typed host.
      canonicalHostname: "www." + hostname,
      labMode: true,
      category: "software",
      allowedDomains: [hostname],
      enableState: "permanent",
      addedAt: new Date().toISOString(),
    };
    // [F87 §A/§B.1 ROOT CAUSE] Re-adding a site the operator deleted earlier
    // must make it LIVE again - exactly what the shipped server does (its store
    // has no tombstones). The F85 spec deletes all eleven sites through the UI
    // and the F86 spec re-adds them afterwards (one worker, files run in
    // alphabetical order); with a permanent tombstone the re-added row was
    // filtered out of GET /api/f58/sources, the Lab page rendered "not found",
    // never POSTed /api/lab/inspect, and the ten-site spec timed out at
    // page.waitForResponse (openculture.com / pluto.tv / freemusicarchive.org
    // on the CI run; all eleven locally).
    deleted.delete(row.id);
    added.push(row);
    send(res, 200, { ok: true, source: row });
    return;
  }

  /** [F88 §A] The four operator cases, keyed by the query the spec types.
   *  Returns the FULL F88 inspect payload (sourceDisplay/sourceSets/tookMs)
   *  or null so every other query keeps its F78/F86 lane untouched. */
  function f88InspectPayload(q) {
    const norm = q.replace(/^f88\s+/, "").trim().toLowerCase();
    const set = (label, strategy, count, links) => ({ key: strategy === "html" ? "search-endpoint" : "search-endpoint", label, strategy, count, links });
    const landing = (host, slug, text, matches) => ({ text, href: "https://" + host + "/" + slug, matches });
    if (norm === "free online philosophy courses") {
      const search = set("HTML search endpoint", "html", 42, [
        { text: "Free Online Philosophy Courses", href: "https://www.openculture.com/freeonlinecourses", matches: true },
        { text: "Walter Kaufmann's Lectures on Nietzsche", href: "https://www.openculture.com/2011/04/walter_kaufmanns_lectures.html", matches: true },
        landing("www.openculture.com", "philosophy", "Philosophy", false),
        landing("www.openculture.com", "category/philosophy", "Philosophy category", false),
        { text: "platos-republic-lecture.mp3", href: "https://www.openculture.com/audio/platos-republic-lecture.mp3", matches: false },
      ]);
      const sitemap = set("Sitemap XML", "sitemap", 500, [landing("openculture.com", "about", "About", false), landing("openculture.com", "category/philosophy", "category/philosophy", false)]);
      return { hostname: "www.openculture.com", title: "Open Culture", fetchedAt: new Date().toISOString(), linkCount: 42, matchCount: 2, source: "search-endpoint", sourceUrls: 42, sourceDisplay: "HTML search endpoint", sourceStrategy: "html", tookMs: 1200, sourceSets: [search, sitemap], links: search.links, adapterStatus: { phase: "search-endpoint", sourceLabel: "search-endpoint" } };
    }
    if (norm === "a matter of life and death") {
      const ids = ["matter-of-life-and-death-1946", "matter-of-life-and-death-blu", "a-matter-of-life-and-death", "matter-life-death-1946-re", "matter-life-death-interview", "matter-life-death-score", "matter-life-death-1951", "matter-life-death-uk", "death-life-matter-doc", "matter-life-death-restored"];
      const search = set("JSON search endpoint", "json", 120, [
        ...ids.map((id) => ({ text: id, href: "https://archive.org/details/" + id, matches: true })),
        { text: "MatterOfLifeAndDeath.mp4", href: "https://archive.org/download/matter-of-life-and-death-1946/MatterOfLifeAndDeath.mp4", matches: false },
      ]);
      const sitemap = set("Sitemap XML", "sitemap", 900, [landing("archive.org", "about", "About", false)]);
      return { hostname: "archive.org", title: "Internet Archive", fetchedAt: new Date().toISOString(), linkCount: 120, matchCount: 10, source: "search-endpoint", sourceUrls: 120, sourceDisplay: "JSON search endpoint", sourceStrategy: "json", tookMs: 840, sourceSets: [search, sitemap], links: search.links, adapterStatus: { phase: "search-endpoint", sourceLabel: "search-endpoint" } };
    }
    if (norm === "saturn's rings in ultraviolet light") {
      const n = Array.from({ length: 12 }, (_, i) => ({
        text: "saturn-ring-uv-" + (i + 1) + ".jpg",
        href: "https://images-assets.nasa.gov/image/PIA" + (12000 + i) + "/PIA" + (12000 + i) + "~medium.jpg",
        matches: true,
      }));
      const search = set("JSON search endpoint", "json", 21, n);
      const home = set("Homepage fallback", "sitemap", 60, [landing("openverse.org", "images", "Images", false)]);
      return { hostname: "openverse.org", title: "Openverse", fetchedAt: new Date().toISOString(), linkCount: 21, matchCount: 12, source: "search-endpoint", sourceUrls: 21, sourceDisplay: "JSON search endpoint", sourceStrategy: "json", tookMs: 620, sourceSets: [search, home], links: search.links, adapterStatus: { phase: "search-endpoint", sourceLabel: "search-endpoint" } };
    }
    if (norm === "networking") {
      const items = [
        ["Software-Defined Networking", "https://github.com/sindresorhus/awesome/tree/main#software-defined-networking"],
        ["PCAPTools", "https://github.com/caesar0301/awesome-pcaptools"],
        ["Real-Time Communications", "https://github.com/sindresorhus/awesome/tree/main#real-time-communications"],
        ["SNMP", "https://github.com/sindresorhus/awesome/tree/main#snmp"],
        ["Scapy", "https://github.com/secdev/scapy"],
        ["Cilium", "https://github.com/cilium/cilium"],
        ["Networking resources", "https://github.com/sindresorhus/awesome/tree/main#networking"],
        ["Nmap", "https://nmap.org/"],
        ["Wireshark", "https://www.wireshark.org/"],
        ["CoreDNS", "https://github.com/coredns/coredns"],
      ];
      const search = set("GitHub README section - Networking", "markdown-section", 34, items.map(([text, href]) => ({ text, href, matches: true })));
      const home = set("Homepage fallback", "sitemap", 10, [landing("awesome.re", "", "awesome", false)]);
      return { hostname: "awesome.re", title: "awesome", fetchedAt: new Date().toISOString(), linkCount: 34, matchCount: 10, source: "search-endpoint", sourceUrls: 34, sourceDisplay: "GitHub README section - Networking", sourceStrategy: "markdown-section", tookMs: 410, sourceSets: [search, home], links: search.links, adapterStatus: { phase: "search-endpoint", sourceLabel: "search-endpoint" } };
    }
    return null;
  }

  if (path === "/api/lab/inspect" && req.method === "POST") {
    const body = await readBody(req);
    // [F86 §B.2/§D] RESULT-VIEW + DEEP lanes. A body.sourceUrl (the result id
    // route) or a query that starts with "f86" selects the deep lane: the
    // response is the site's OWN 52-URL fixture (pages + .mp3/.mp4/.pdf), which
    // is what "Lab finds >= 50 URLs" means for the ten-site spec. Every other
    // request keeps the F78/F85 shape byte-for-byte, so those suites cannot
    // drift because of this branch.
    const f86Query = String(body?.query || "");
    // [F88 §A] the four operator cases answer with the search-endpoint shape.
    const f88 = f88InspectPayload(f86Query);
    if (f88) {
      await sleep(100);
      send(res, 200, f88);
      return;
    }
    const f86Deep = Boolean(body && body.sourceUrl) || /^f86/.test(f86Query.trim());
    if (f86Deep) {
      // [F87 §B.1] Resolve the SITE from the hostname of body.sourceUrl first
      // (lowercase, "www." stripped, matched against the eleven), then from the
      // stored row's hostname, then from the id itself ("pluto-tv" -> pluto.tv).
      // The lane never 404s: an unknown host answers the archive.org corpus,
      // so the deep inspector always has >= 60 rows to render.
      let host = "";
      try {
        host = body.sourceUrl ? f87SiteOfHost(new URL(String(body.sourceUrl)).hostname) : "";
      } catch {
        host = "";
      }
      if (!host && body.sourceId) {
        const row = sources().find((x) => x.id === body.sourceId);
        host = row ? f87SiteOfHost(String(row.hostname)) : "";
        if (!host) host = f87SiteOfId(body.sourceId);
      }
      if (!host) host = "archive.org";
      // [F87 §B.1] 100 ms of real latency: the UI must show its loading state
      // and settle from server data, never from a same-tick response.
      await sleep(100);
      const urls = f86SitemapRows(host);
      const q = f86Query.replace(/^f86[^ ]*/, "").trim().toLowerCase();
      const links = urls.map((href) => ({ href, text: href.split("/").pop() || href, matches: Boolean(q) && href.toLowerCase().includes(q) }));
      if (links.length >= 50) {
        send(res, 200, {
          hostname: "www." + host,
          title: host + " deep index",
          links,
          fetchedAt: new Date().toISOString(),
          linkCount: links.length,
          matchCount: links.filter((l) => l.matches).length,
          source: "sitemap.xml",
          sourceUrls: links.length,
          adapterStatus: { phase: "sitemap-ok", sourceLabel: "sitemap.xml" },
        });
        return;
      }
    }
    if (!body || !body.sourceId) {
      send(res, 400, { code: "VALIDATION_ERROR", messageKey: "search.errors.validation", retryable: false });
      return;
    }
    if (url.searchParams.get("rateLimited") === "1") {
      send(res, 429, { code: "RATE_LIMITED", messageKey: "lab.rateLimited", retryable: true, retryAfterSeconds: 42 });
      return;
    }
    const fixture = labInspect(String(body.sourceId));
    const query = String(body.query || "").trim().toLowerCase();
    const links = fixture.links.map((l) => ({
      text: l.text,
      href: l.href,
      matches: Boolean(query) && (l.text.toLowerCase().includes(query) || l.href.toLowerCase().includes(query)),
    }));
    send(res, 200, {
      hostname: fixture.hostname,
      title: fixture.title,
      links,
      fetchedAt: new Date().toISOString(),
      linkCount: links.length,
      matchCount: links.filter((l) => l.matches).length,
    });
    return;
  }

  // [F79] Test-only request log: proves the automatic wire contract and fan-out.
  if (path === "/__f79/search-requests") {
    send(res, 200, { requests: searchRequests });
    return;
  }

  // [F92 §6] GET /api/f92-selftest - the exact application/health+json the
  // production route emits (payloads/ghrdp-server.ps1, Invoke-F92Selftest):
  // checks keyed search:<site> + the four system rows, arrays per the IETF
  // draft, 9 pass + 2 warn (tubitv/pluto are browser-required by design).
  // The mock mirrors the envelope so /#/health and VersionGate run against
  // the real shape in e2e, and assert-selftest.js can parse the same JSON.
  if (path === "/api/f92-selftest" && req.method === "GET") {
    const nowIso = new Date().toISOString();
    const mk = (status, observedValue, output) => [
      { componentType: "component", status, observedValue, observedUnit: "results", time: nowIso, ...(output ? { output } : {}) },
    ];
    const checks = {};
    for (const s of [
      "archive", "awesome", "freemusicarchive", "gutenberg", "librivox",
      "openculture", "openlibrary", "openverse", "standardebooks",
    ]) {
      checks["search:" + s] = mk("pass", 5, undefined);
    }
    checks["search:tubitv"] = mk("warn", 0, "Site tubitv is JS-rendered; verified by nightly Playwright, not CI. See /#/health.");
    checks["search:pluto"] = mk("warn", 0, "Site pluto is JS-rendered; verified by nightly Playwright, not CI. See /#/health.");
    checks["launcher:status"] = [{ componentType: "system", status: "pass", observedValue: "Running", time: nowIso }];
    checks["download:writable"] = [{ componentType: "datastore", status: "pass", observedValue: 0, observedUnit: "bytes", time: nowIso }];
    checks["streaming:proxy"] = [{ componentType: "component", status: "pass", observedValue: "launcher-heartbeat", time: nowIso }];
    checks["version:match"] = [{ componentType: "system", status: "pass", observedValue: { backend: "mockbackend000000000000000000000000000000", frontend: url.searchParams.get("frontendSha") || "dev" }, time: nowIso }];
    res.setHeader("Content-Type", "application/health+json");
    res.setHeader("Cache-Control", "max-age=10");
    res.setHeader("X-Correlation-ID", "mock-f92");
    send(res, 200, {
      status: "warn",
      version: "1",
      releaseId: "mockbackend000000000000000000000000000000",
      serviceId: "dekarita-supreme-lamp",
      description: "F92 self-test; see /#/health",
      notes: ["correlation-id: mock-f92"],
      checks,
      links: { about: "/#/health" },
    });
    return;
  }

  if (path === "/api/search" && req.method === "POST") {
    const body = await readBody(req);
    const requestedAdapterIds = Array.isArray(body?.adapterIds) ? body.adapterIds : [];
    const adapterIds = requestedAdapterIds.length
      ? [...new Set(requestedAdapterIds.map(canonicalAdapter))] : [...defaultAdapters];
    const query = String(body?.query || "");
    const searchId = "e2e-search-" + (searches.size + 1);
    searches.set(searchId, { query, adapterIds, cancelled: false });
    searchRequests.push({ searchId, requestId: body?.requestId || "", query, requestedAdapterIds, adapterIds });
    send(res, 202, {
      searchId, phase: "running", requestId: body?.requestId || "",
      acceptedAdapterIds: adapterIds, queryGeneration: 1,
      statusRef: "/api/search/status?searchId=" + searchId,
      adapterStatuses: adapterRows(adapterIds, "running"),
    });
    return;
  }

  if (path === "/api/search/status") {
    const searchId = url.searchParams.get("searchId");
    const search = searches.get(searchId);
    if (!search) {
      // [F91 §A.3] launcher queue: validation mirrors Test-F91QueueJob (mode set,
  // https-only navigate, explorer takes a Windows folder path ONLY), then the
  // job is accepted "as drained". The selftest noop mode is accepted too.
  if (path === "/api/launcher/queue" && req.method === "POST") {
    const body = await readBody(req);
    const mode = String(body?.mode || "").toLowerCase();
    const target = String(body?.url || "").trim();
    const MODES = ["navigate", "download", "explorer", "noop"];
    const okMode = MODES.includes(mode);
    const okTarget =
      mode === "explorer" ? /^[A-Za-z]:\\[^<>:"|?*]*$/.test(target)
      : (mode === "download" || mode === "noop") ? (target === "" || target.startsWith("https://"))
      : target.startsWith("https://") && !/[?&]#[^#]*$/.test(target) && target.length <= 2048 && !target.includes("@");
    if (!okMode || !okTarget) {
      send(res, 400, { code: "VALIDATION_ERROR", reason: !okMode ? "mode" : "url" });
      return;
    }
    const jobId = "f91-job-" + f91JobSeq++;
    f91Jobs.push({ id: jobId, url: target, mode, name: String(body?.name || ""), at: new Date().toISOString() });
    if (mode === "navigate") launchCalls.push({ url: target, at: new Date().toISOString() });
    send(res, 200, { ok: true, queuedAt: new Date().toISOString(), jobId });
    return;
  }
  if (path === "/api/launcher/health" && req.method === "GET") {
    send(res, 200, { ok: true, serviceRunning: true, heartbeatAge: 2000, heartbeatAt: new Date().toISOString(), queueDepth: 0, queueDir: "C:\\ProgramData\\ghrdp\\launcher-queue", log: ["<mock> startup launcher-service"], logPath: "C:\\ProgramData\\ghrdp\\launcher.log", taskExists: true, taskState: "Running", activeUser: "runner", scriptPresent: true });
    return;
  }
  if (path === "/__f91/jobs") {
    send(res, 200, { jobs: f91Jobs });
    return;
  }
  // [F91 §D.2] stream relay: exact-host allowlist (the eleven + added custom
  // hosts), then a 2 KB audio/ogg stub so the inline <audio> element has real
  // bytes; HEAD answers headers only. Off-allowlist -> 403 like the server.
  if (path === "/api/stream" && (req.method === "GET" || req.method === "HEAD")) {
    let host = "";
    try {
      const u = new URL(url.searchParams.get("url") || "");
      if (u.protocol !== "https:" || u.username) throw new Error("bad");
      host = u.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      send(res, 400, { code: "VALIDATION_ERROR" });
      return;
    }
    const known = new Set([...F87_SITES.map((x) => x.replace(/^www\./, "")), "example.com", "127.0.0.1", "localhost"]);
    if (!known.has(host)) {
      send(res, 403, { code: "HOSTNAME_MISMATCH", messageKey: "lab.hostnameMismatch" });
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": "2048" });
    res.end(Buffer.alloc(2048, 7));
    return;
  }

  send(res, 404, { code: "NOT_FOUND", messageKey: "search.errors.generic", retryable: false });
      return;
    }
    const loading = search.query === "f79-loading";
    const empty = search.query === "xyz";
    // [F85 §4] "f85 <site>" returns a file-ish row ON that site's host, which is
    // the only way to reach the F84 "Download to RDP" button end to end (the F79
    // fixture rows are landing pages on purpose - they keep the single Open
    // action). Nothing else in the lane changes.
    const f85Match = /^f8[56]\s+(\S+)$/.exec(search.query.trim());
    const f85Results = f85Match
      ? [{
          resultId: "f85-file-1",
          // One of the mock's canonical fan-out adapters, so the row carries a
          // real adapter status + translated source badge (a made-up adapter id
          // would render a raw i18n key in the card).
          adapterId: "internet-archive",
          nameKey: "search.sources.internetArchive",
          category: "software",
          title: f85Match[1] + " public media bundle",
          creator: "Operator fixture",
          snippet: "A file-ish result on the stored site: the F84 download path.",
          sizeBytes: 12345,
          licenceTag: "open-access",
          sourceSnapshotId: "f85-snapshot-1",
          sourceUrl: "https://" + f85Match[1] + "/media/sample.pdf",
          date: "2026-10-04",
        }]
      : null;
    // [F102] The Collector's probe query (COLLECTOR_PROBE_QUERY in
    // src/lib/collectorAgent.ts) gets one direct .mp4 row on top of the F79
    // rows - the shape a real "public domain film" search returns. That row
    // carries every result-card button the Collector clicks for real: Fetch,
    // Open in RDP, Download to RDP (file-ish), Watch in RDP (video), Preview
    // and Open in Lab.
    const f102Results = search.query.trim().toLowerCase() === "public domain film"
      ? [{
          resultId: "f102-film-1",
          adapterId: "internet-archive",
          nameKey: "search.sources.internetArchive",
          category: "software",
          title: "Public domain film reel (F102 probe)",
          creator: "Operator fixture",
          snippet: "A direct .mp4 file: download-to-RDP and watch-in-RDP both apply.",
          sizeBytes: 4096000,
          licenceTag: "open-access",
          sourceSnapshotId: "f102-snapshot-1",
          sourceUrl: "https://archive.org/download/f102-probe/film.mp4",
          date: "2026-10-06",
        }, ...readJson("f79-results.json").results]
      : null;
    const results = loading || empty || search.cancelled ? [] : f85Results || f102Results || readJson("f79-results.json").results;
    const phase = search.cancelled ? "cancelled" : loading ? "running" : "complete";
    send(res, 200, {
      searchId, phase, queryGeneration: 1, results,
      adapterStatuses: adapterRows(search.adapterIds, loading ? "running" : "complete", results),
      cursor: "", hasMore: false, serverTs: new Date().toISOString(),
    });
    return;
  }

  if (path === "/api/search/cancel") {
    const body = await readBody(req);
    const search = searches.get(body?.searchId);
    if (search) search.cancelled = true;
    send(res, 200, { searchId: body?.searchId, cancellationState: "cancelled" });
    return;
  }

  // [F85 §3] The diagnostic-banner contract, mirroring the shipped
  // payloads/ghrdp-server.ps1 /api/version route (features object + sha7).
  // [R-GLASS / #213 §10] Explorer reads. The 5000-row file list the benchmark
  // and the preview need comes from the repo's OWN synthetic fixture
  // (src/components/explorer/data/fixtures/5000-files.json, schemaVersion 2) -
  // it is labelled synthetic in the UI and it is never a real runner index.
  // Only READS are answered here; /api/fx/op is deliberately left unhandled so
  // a write against the mock fails loudly instead of being fabricated.
  if (path === "/api/fx/list" && req.method === "GET") {
    const idx = fxIndex();
    const root = url.searchParams.get("root");
    send(res, 200, root ? { ...idx, files: idx.files.filter((f) => f.root === root) } : idx);
    return;
  }
  if (path === "/api/fx/meta" && req.method === "GET") {
    const id = url.searchParams.get("id") || "";
    const found = fxIndex().files.find((f) => f.id === id) || null;
    send(res, found ? 200 : 404, found || { error: "not found" });
    return;
  }
  if (path === "/api/fx/gofile/status" && req.method === "GET") {
    send(res, 200, { code: null, fileId: null, directUrl: null, status: "none", uploadedAt: null, expiryTs: null, downloads: 0, remoteSize: null });
    return;
  }

  if (path === "/api/version") {
    send(res, 200, {
      ok: true,
      server: "mock",
      sha: "f85mock0000000000000000000000000000000",
      sha7: "f85mock",
      features: { autoHttps: true, wwwTolerance: true, noFallback: true, downloadToRdp: true, launchTiers: true, selfTest: true, mirrorLauncher: true, streamProxy: true },
    });
    return;
  }

  // [F86 §A/§D] launch-url: the ten-site spec clicks a Lab row and asserts that
  // the request really happened and that a TIER came back (the F86 contract:
  // the response carries the rung that did the work). The mock answers tier 1
  // and records every call so the spec can read them back.
  if (path === "/api/launch-url" && req.method === "POST") {
    const body = await readBody(req);
    const target = String(body?.url || "");
    if (!target.startsWith("https://")) {
      send(res, 400, { code: "VALIDATION_ERROR", messageKey: "newSiteHttpsRequired", retryable: false });
      return;
    }
    launchCalls.push({ url: target, at: new Date().toISOString() });
    send(res, 200, { ok: true, launched: true, tier: 1, tierDetail: "direct-spawn", browser: "msedge", pid: 4242, user: "runner" });
    return;
  }

  // [F86 §A.3] The diagnostic banner's launch probe.
  if (path === "/api/launch-url/diag" && req.method === "GET") {
    const last = launchCalls[launchCalls.length - 1] || null;
    send(res, 200, {
      ok: true,
      activeTier: 1,
      lastLaunchAt: last ? last.at : "",
      lastResult: last ? "ok" : "",
      lastTier: last ? 1 : 0,
      lastDetail: last ? "direct-spawn" : "",
      chromePath: "",
      msedgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      firefoxPath: "",
      interactiveSessionDetected: true,
      sessionId: 1,
      activeUser: "runner",
      pipeReady: true,
      pipeName: "ghrdp-browser-opener-f86",
      logPath: "C:\\Users\\runner\\.ghrdp\\launch-url.log",
      errorHistory: [],
      history: [],
    });
    return;
  }

  // [F87 §C.1] The self-test lane: the SAME envelope the shipped route answers
  // ({ok, ranAt, total, passed, results[]}), one row per requested site, the
  // sitemap count read from the site's own fixture, tier 1 for every launch.
  // Subset validation and the 1/min rate limit are mirrored so the panel's
  // error states are reachable end to end.
  if (path === "/api/f87-selftest" && req.method === "POST") {
    const body = await readBody(req);
    const requested = Array.isArray(body?.sites) ? body.sites.map((s) => String(s).trim().toLowerCase().replace(/^www\./, "")) : [];
    const rejected = requested.filter((s) => !F87_SITES.includes(s));
    if (!requested.length || rejected.length) {
      send(res, 400, { code: "VALIDATION_ERROR", messageKey: "selfTest.invalidSites", rejected, allowed: F87_SITES });
      return;
    }
    const tok = String(req.headers["x-dash-token"] || "");
    const now = Date.now();
    if (selfTestRuns.has(tok) && now - selfTestRuns.get(tok) < 60_000 && url.searchParams.get("noRateLimit") !== "1") {
      send(res, 429, { code: "RATE_LIMITED", messageKey: "selfTest.rateLimited", retryAfterSeconds: Math.ceil((60_000 - (now - selfTestRuns.get(tok))) / 1000) });
      return;
    }
    selfTestRuns.set(tok, now);
    await sleep(150);
    const results = [...new Set(requested)].map((site) => {
      const urls = f86SitemapRows(site);
      launchCalls.push({ url: "https://" + site + "/", at: new Date().toISOString() });
      const audioN = urls.filter((u) => /\.(mp3|m4a|flac|ogg|wav|opus)(\?|$)/i.test(u)).length;
      return {
        site, probeOk: true, sitemapUrls: urls.length, sitemapMode: "urlset", launchTier: 1, launchOk: true, launchDetail: "direct-spawn",
        pdfFound: urls.some((u) => /\.pdf(\?|$)/i.test(u)), downloadDirOk: true, downloadDir: "C:\\Users\\runner\\Desktop\\RDP-Downloads", errors: [],
        // [F91 §E.1] the extended columns, mirrored from the shipped route.
        searchStrategy: site === "awesome.re" ? "markdown-section" : "probe", searchOk: true, searchItems: 12,
        networkingItemCount: site === "awesome.re" ? 96 : 0,
        launcherQueueOk: true, launcherQueueNote: "consumed",
        downloadOk: true, downloadPath: "C:\\Users\\runner\\Desktop\\RDP-Downloads\\robots.txt", downloadBytes: 128,
        streamProxyOk: true, streamProxyStatus: 200,
        audioRows: audioN,
      };
    });
    send(res, 200, {
      ok: true, ranAt: new Date().toISOString(), total: results.length, passed: results.length, results,
      launcherServiceRunning: true, taskSchedulerHealth: true,
      launcher: { serviceRunning: true, heartbeatAge: 2000, queueDepth: 0, taskExists: true, activeUser: "runner" },
    });
    return;
  }

  if (path === "/__f86/launch-calls") {
    send(res, 200, { calls: launchCalls });
    return;
  }

  // [F85 §4] Download-to-RDP: the shipped server writes the bytes to
  // %USERPROFILE%\Desktop\RDP-Downloads and answers {ok, path, bytes}. The mock
  // answers the same envelope so the F85 spec can assert the button, the
  // request flag and the success toast end to end.
  if (path === "/api/fetch" && req.method === "POST" && url.searchParams.get("download") === "true") {
    const body = await readBody(req);
    const url0 = String(body?.urlImport?.url || "");
    const fileName = (url0.split("/").pop() || "mock.bin").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+|\.+$/g, "") || "mock.bin";
    send(res, 200, {
      ok: true,
      path: "C:\\Users\\runner\\Desktop\\RDP-Downloads\\" + fileName,
      bytes: 12345,
      verified: true,
      writeTime: new Date().toISOString(),
    });
    return;
  }

  // [F91 §A.3] launcher queue: validation mirrors Test-F91QueueJob (mode set,
  // https-only navigate, explorer takes a Windows folder path ONLY), then the
  // job is accepted "as drained". The selftest noop mode is accepted too.
  if (path === "/api/launcher/queue" && req.method === "POST") {
    const body = await readBody(req);
    const mode = String(body?.mode || "").toLowerCase();
    const target = String(body?.url || "").trim();
    const MODES = ["navigate", "download", "explorer", "noop"];
    const okMode = MODES.includes(mode);
    const okTarget =
      mode === "explorer" ? /^[A-Za-z]:\\[^<>:"|?*]*$/.test(target)
      : (mode === "download" || mode === "noop") ? (target === "" || target.startsWith("https://"))
      : target.startsWith("https://") && !/[?&]#[^#]*$/.test(target) && target.length <= 2048 && !target.includes("@");
    if (!okMode || !okTarget) {
      send(res, 400, { code: "VALIDATION_ERROR", reason: !okMode ? "mode" : "url" });
      return;
    }
    const jobId = "f91-job-" + f91JobSeq++;
    f91Jobs.push({ id: jobId, url: target, mode, name: String(body?.name || ""), at: new Date().toISOString() });
    if (mode === "navigate") launchCalls.push({ url: target, at: new Date().toISOString() });
    send(res, 200, { ok: true, queuedAt: new Date().toISOString(), jobId });
    return;
  }
  if (path === "/api/launcher/health" && req.method === "GET") {
    send(res, 200, { ok: true, serviceRunning: true, heartbeatAge: 2000, heartbeatAt: new Date().toISOString(), queueDepth: 0, queueDir: "C:\\ProgramData\\ghrdp\\launcher-queue", log: ["<mock> startup launcher-service"], logPath: "C:\\ProgramData\\ghrdp\\launcher.log", taskExists: true, taskState: "Running", activeUser: "runner", scriptPresent: true });
    return;
  }
  if (path === "/__f91/jobs") {
    send(res, 200, { jobs: f91Jobs });
    return;
  }
  // [F91 §D.2] stream relay: exact-host allowlist (the eleven + added custom
  // hosts), then a 2 KB audio/ogg stub so the inline <audio> element has real
  // bytes; HEAD answers headers only. Off-allowlist -> 403 like the server.
  if (path === "/api/stream" && (req.method === "GET" || req.method === "HEAD")) {
    let host = "";
    try {
      const u = new URL(url.searchParams.get("url") || "");
      if (u.protocol !== "https:" || u.username) throw new Error("bad");
      host = u.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      send(res, 400, { code: "VALIDATION_ERROR" });
      return;
    }
    const known = new Set([...F87_SITES.map((x) => x.replace(/^www\./, "")), "example.com", "127.0.0.1", "localhost"]);
    if (!known.has(host)) {
      send(res, 403, { code: "HOSTNAME_MISMATCH", messageKey: "lab.hostnameMismatch" });
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": "2048" });
    res.end(Buffer.alloc(2048, 7));
    return;
  }

  send(res, 404, { code: "NOT_FOUND", messageKey: "search.errors.generic", retryable: false });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[f78-mock] listening on http://127.0.0.1:" + PORT);
});
