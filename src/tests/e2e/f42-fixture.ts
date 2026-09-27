// [F42 §5] Routing fixture for the playwright cases. It mirrors the SHIPPED
// server contract one-for-one (payloads/ghrdp-server.ps1):
//   §1  every literal '?' after the FIRST one is normalised to '&' BEFORE the
//       split on '&' (then each pair is url-decoded)
//   §2  ui=v2 (or the F43 v2 default) with ui-v2.html absent => v1 PLUS the
//       red uiV2MissingBanner (HTTP 200), never a silent v1
//   §3  [F43] no ui param => v2; ui=v1 => v1
// Kept as a helper (not *.spec.ts) so playwright does not collect it as a test.
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const F42_BANNER_TEXT =
  "ui-v2.html not staged in this run - main.yml stage step failed; re-dispatch or check CI";

// §1 - same three lines as Get-RequestParts in ghrdp-server.ps1.
export function parseQuery(target: string): Record<string, string> {
  const out: Record<string, string> = {};
  const qAt = target.indexOf("?");
  if (qAt < 0) return out;
  const qNorm = target.slice(qAt + 1).replace(/\?/g, "&");
  for (const kv of qNorm.split("&")) {
    const eq = kv.indexOf("=");
    if (eq > 0) {
      out[decodeURIComponent(kv.slice(0, eq)).toLowerCase()] = decodeURIComponent(kv.slice(eq + 1));
    }
  }
  return out;
}

export function selectUi(dir: string, query: Record<string, string>) {
  const v2 = join(dir, "ui-v2.html");
  // [F43] same order as payloads/ghrdp-server.ps1 ($script:UiV2Default = $true):
  // ui=v1 -> v1; ui=v2 -> v2; no param -> v2; wanted v2 but file missing -> banner.
  const uiV2Default = true;
  let wantV2 = uiV2Default || query.ui === "v2";
  if (query.ui === "v1") wantV2 = false;
  if (wantV2 && existsSync(v2)) return { file: v2, missingV2: false };
  return { file: join(dir, "ui.html"), missingV2: wantV2 };
}

export async function startFixture(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    const target = req.url || "/";
    const path = target.split("?")[0];
    if (path !== "/" && path !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const { file, missingV2 } = selectUi(dir, parseQuery(target));
    let html = readFileSync(file, "utf8").replace("__IP__", "100.64.0.7").replace("__TELEGRAPH__", "");
    if (missingV2) {
      const banner = `<div id="uiV2MissingBanner" role="alert" style="background:#7f1d1d;color:#fff;padding:8px">${F42_BANNER_TEXT}</div>`;
      html = html.replace(/<body[^>]*>/i, (m) => m + banner);
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
