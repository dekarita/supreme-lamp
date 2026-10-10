#!/usr/bin/env node
// [F41 §6.2] Zero-dependency static server for the built v2 bundle (used by
// playwright.config webServer and local verification). Serves ui/dist with
// correct woff2 MIME; no external downloads in CI.
import { createServer } from "node:http";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const ROOT = process.argv[2] || "ui/dist";
const PORT = Number(process.env.PORT || 4173);
// [R-GLASS] Optional API proxy so the BUILT single-file bundle can be previewed
// against the F78 mock backend (tests/e2e/fixtures/mock-backend.mjs) the same
// way `vite dev` serves it. Off unless PROXY_TARGET is set, so the CI static
// contract (zero dependencies, no outbound requests) is unchanged.
const PROXY_TARGET = process.env.PROXY_TARGET || "";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Forward /api/* and /diag to PROXY_TARGET (the F78 mock). Never anything else. */
function proxy(req, res, pathname) {
  return new Promise((resolve) => {
    const target = new URL(PROXY_TARGET);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: pathname,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        up.on("end", resolve);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy error");
      resolve();
    });
    req.pipe(upstream);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (PROXY_TARGET && (rel === "/api" || rel.startsWith("/api/") || rel === "/diag")) {
      return void (await proxy(req, res, rel + (url.search || "")));
    }
    if (rel === "/" || rel === "/index.html") rel = "/index.html";
    const file = join(ROOT, rel);
    const st = await stat(file).catch(() => null);
    const target = st && st.isDirectory() ? join(file, "index.html") : file;
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`serving ${ROOT} on http://0.0.0.0:${PORT}`));
