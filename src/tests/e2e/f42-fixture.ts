// [F42 §5 / F43] Routing fixture for the playwright cases. It mirrors the
// SHIPPED server contract one-for-one (payloads/ghrdp-server.ps1):
//   §1  every literal '?' after the FIRST one is normalised to '&' BEFORE the
//       split on '&' (then each pair is url-decoded)
//   §2  wantV2 with ui-v2.html absent => v1 PLUS the red uiV2MissingBanner
//       (HTTP 200), never a silent v1
//   §3  [F43] DEFAULT is v2 (UiV2Default=true); ?ui=v1 pins classic
// Kept as a helper (not *.spec.ts) so playwright does not collect it as a test.
import { createServer as createHttpServer, type Server } from "node:http";
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

// [F43] DEFAULT is v2. Mirrors ghrdp-server.ps1:
//   wantV2 = UiV2Default -or (uiSel -eq 'v2'); if uiSel -eq 'v1' { wantV2 = false }
export const UiV2Default = true;

export function selectUi(dir: string, query: Record<string, string>, defaultV2: boolean = UiV2Default) {
  const v2 = join(dir, "ui-v2.html");
  const uiSel = query.ui || "";
  let wantV2 = defaultV2 || uiSel === "v2";
  if (uiSel === "v1") wantV2 = false;
  if (wantV2 && existsSync(v2)) return { file: v2, missingV2: false };
  return { file: join(dir, "ui.html"), missingV2: wantV2 };
}

// [F45-S2-RESUME §1.1] DETERMINISTIC TEARDOWN.
//
// Root cause of the CI flake (launch-gates 36377955417 step "F41 v2 e2e",
// f42-ui-routing.spec.ts:53 "(c)" -> "Test timeout of 60000ms exceeded", and
// the identical shape earlier in 36347561362 at f43-default-v2.spec.ts:61 "(d)"):
//
//   Both tests start a v1-only fixture INSIDE the test body and await
//   `closeV1()` in a `finally` while their own page is still alive. The v1
//   payload polls `/api/progress` every 3000ms (payloads/ui.html:1114), so at
//   the instant `close()` runs the browser's keep-alive connection is often
//   still carrying a request. `server.close()` only reaps sockets that are
//   IDLE at that moment (node >= 19 behaviour); every other socket has to be
//   hung up by the browser first. The promise therefore never settles and the
//   test burns its whole 60s budget inside `finally` - reported as a test
//   timeout with no failing assertion. Whether it reproduces depends purely on
//   where the 3s poll happens to land, which is why the SAME commit passed the
//   pull_request run (36377980668) and failed the push run.
//
//   Measured against this file (node 22.22.3): all-idle -> close() settles in
//   1ms; one in-flight request -> close() never settles (8s watchdog).
//
// `closeIdleConnections()` / `closeAllConnections()` (node >= 18.2) settle it
// unconditionally; the watchdog keeps a future socket race from ever eating the
// test budget again. No assertion, selector or served byte is changed.
async function closeFixture(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  server.close(); // stop accepting new connections
  server.closeIdleConnections?.(); // reap idle keep-alive sockets
  server.closeAllConnections?.(); // destroy any socket still mid-request
  const watchdog = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000) as unknown as { unref?: () => void };
    timer.unref?.(); // a settled close must not hold the playwright worker open
  });
  await Promise.race([closed, watchdog]);
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
    close: () => closeFixture(server),
  };
}
