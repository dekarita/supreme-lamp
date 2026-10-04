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

/** [F86 §D] The per-site sitemap fixtures: 52 URLs each (pages + .mp3/.mp4/.pdf),
 *  the exact corpus the ten-site deep spec asserts (>= 50 URLs per site). */
function f86SitemapRows(site) {
  let xml = "";
  try {
    xml = readFileSync(join(HERE, "f86-sitemaps", site + ".xml"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) out.push(m[1]);
  return out;
}

/** The launch-url calls the F86 spec inspects (tier proof). */
const launchCalls = [];
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
    added.push(row);
    send(res, 200, { ok: true, source: row });
    return;
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
    const f86Deep = Boolean(body && body.sourceUrl) || /^f86/.test(f86Query.trim());
    if (f86Deep) {
      let host = "";
      try {
        host = body.sourceUrl ? new URL(String(body.sourceUrl)).hostname.replace(/^www\./, "") : "";
      } catch {
        host = "";
      }
      if (!host && body.sourceId) {
        const row = sources().find((x) => x.id === body.sourceId);
        host = row ? String(row.hostname).replace(/^www\./, "") : "";
      }
      if (!host) host = "archive.org";
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
    const results = loading || empty || search.cancelled ? [] : f85Results || readJson("f79-results.json").results;
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
  if (path === "/api/version") {
    send(res, 200, {
      ok: true,
      server: "mock",
      sha: "f85mock0000000000000000000000000000000",
      sha7: "f85mock",
      features: { autoHttps: true, wwwTolerance: true, noFallback: true, downloadToRdp: true, launchTiers: true },
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
    });
    return;
  }

  send(res, 404, { code: "NOT_FOUND", messageKey: "search.errors.generic", retryable: false });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[f78-mock] listening on http://127.0.0.1:" + PORT);
});
