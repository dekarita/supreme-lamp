// [F94 §3.2] OPEN WEB DESKTOP - one opener that can REPORT being blocked.
//
// THE BUG THIS CLOSES (operator report F94 problem 3): both WEB DESKTOP
// buttons called `window.open(url, "_blank", "noopener")` and threw the return
// value away. `window.open()` returns `null` (or throws) when the browser blocks
// the popup - which is exactly what a strict browser does to a second window
// opened from a page the operator reached through a chain of redirects - and the
// click then did LITERALLY NOTHING: no tab, no error, no log. The button looked
// dead, which is what the operator reported.
//
// This module is the single place the WEB DESKTOP URL is opened. It returns a
// structured outcome so the caller can fall back to "here is the URL, copy it"
// instead of silence. It never claims success it did not get.
import { validWebdeskUrl } from "@/lib/domain/native";

export interface OpenOutcome {
  /** A window handle was returned by the browser. */
  opened: boolean;
  /** The browser refused the popup (or threw). The caller MUST show the URL. */
  blocked: boolean;
  /** The URL was not a plain https link, so nothing was attempted. */
  invalid: boolean;
  /** The URL that was (or would have been) opened. */
  url: string;
  /** Machine-readable detail for logs/tests, never user-facing text. */
  reason: string;
}

/**
 * Open the WEB DESKTOP (noVNC) URL in a new window.
 *
 * `features` carries `noopener,noreferrer` (the F41/F84 contract: the new
 * window must not get a handle back on the dashboard, and the dashboard's URL -
 * which carries the `?key=` bearer token - must not leak as a Referer) plus an
 * explicit size so the browser treats it as a real window request rather than
 * a background tab some blockers fold away.
 */
export function openWebDesktop(raw: string): OpenOutcome {
  // [F94 §3.2] NOT isSafeLaunchUrl(): that fence demands https, but the WEB
  // DESKTOP URL is legitimately `http://<CGNAT-tailnet-IP>:7333/vnc.html`
  // (F9n - the noVNC endpoint is served inside the tailnet, so plaintext at
  // that layer is the designed transport). Using the https-only fence here
  // would have refused EVERY real WEB DESKTOP URL - i.e. it would have turned
  // "does nothing" into "refuses, silently". validWebdeskUrl() is the same
  // allowlist the Overview card and the logon banner already trust.
  const url = validWebdeskUrl(raw);
  if (!url) {
    return { opened: false, blocked: false, invalid: true, url, reason: "invalid-url" };
  }
  try {
    const win = window.open(url, "_blank", "noopener,noreferrer,width=1280,height=800");
    // A null handle IS the popup-blocked signal. Treating it as success is the
    // bug this file exists to remove.
    if (!win) return { opened: false, blocked: true, invalid: false, url, reason: "popup-blocked" };
    // Some browsers return a handle for a blocked window; focus() is the only
    // cheap corroboration available, and a failure here is not proof of a block
    // either, so it never downgrades an otherwise-open window.
    try {
      win.focus();
    } catch {
      /* ignore */
    }
    return { opened: true, blocked: false, invalid: false, url, reason: "" };
  } catch {
    return { opened: false, blocked: true, invalid: false, url, reason: "popup-threw" };
  }
}
