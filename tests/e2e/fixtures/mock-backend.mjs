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

/** Added at runtime by POST /api/f58/sources so the "add then card appears"
 *  flow is observable without mutating the fixture file on disk. */
const added = [];
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
  return [...new Map([...readJson("sources.json").sources, ...added].map((s) => [s.id, s])).values()];
}

function labInspect() {
  return readJson("lab-inspect.json");
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Dash-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    const fixture = labInspect();
    if (!body || !body.sourceId) {
      send(res, 400, { code: "VALIDATION_ERROR", messageKey: "search.errors.validation", retryable: false });
      return;
    }
    if (url.searchParams.get("rateLimited") === "1") {
      send(res, 429, { code: "RATE_LIMITED", messageKey: "lab.rateLimited", retryable: true, retryAfterSeconds: 42 });
      return;
    }
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
    const results = loading || empty || search.cancelled ? [] : readJson("f79-results.json").results;
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

  send(res, 404, { code: "NOT_FOUND", messageKey: "search.errors.generic", retryable: false });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[f78-mock] listening on http://127.0.0.1:" + PORT);
});
