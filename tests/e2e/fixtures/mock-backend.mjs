// [F78 §E.2] Mock dashboard backend for the E2E-UI lane. Plain node:http, zero
// dependencies (express is NOT and will not become a dependency of this repo),
// bound to 127.0.0.1:7331 - the port src/lib/api.ts apiBase() targets whenever
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

function sources() {
  return [...readJson("sources.json").sources, ...added];
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

  if (path === "/api/search" && req.method === "POST") {
    const body = await readBody(req);
    send(res, 200, { searchId: "e2e-search-1", status: "running", requestId: body?.requestId || "" });
    return;
  }

  if (path === "/api/search/status") {
    send(res, 200, { searchId: "e2e-search-1", status: "complete", phase: "complete", totalItems: 0, rows: [], adapters: [] });
    return;
  }

  if (path === "/api/search/cancel") {
    send(res, 200, { searchId: "e2e-search-1", status: "cancelled" });
    return;
  }

  send(res, 404, { code: "NOT_FOUND", messageKey: "search.errors.generic", retryable: false });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[f78-mock] listening on http://127.0.0.1:" + PORT);
});
