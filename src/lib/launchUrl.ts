// [F81 §4.2/Q1=B] launchUrl(): POST /api/launch-url with the validated URL.
// The server route sanitises the URL (https only, no userinfo, <=2048) and
// schedules a one-shot Interactive task running `cmd /c start "" "<url>"`
// for the active console user.
//
// [F84 §2.3] NO SILENT FALLBACK. The previous contract returned
// `{ok:false, fallback:true}` after calling window.open(url, "_blank") - a
// partial deploy (or a 500 / a dropped connection) silently opened the link in
// the operator's LOCAL browser instead of the RDP session, which is exactly the
// failure this feature exists to prevent. The contract is now
// `Promise<{ok, reason?, code?}>` with NO window.open: every failure surfaces a
// visible reason key the caller renders in a toast (with a Retry affordance).
// `reason` is an i18n key, never an English literal.
import { getKey } from "@/lib/api";

const SAFE_SCHEME = /^https:\/\//i;
const MAX_LEN = 2048;

export interface LaunchOutcome {
  ok: boolean;
  /** i18n key for the visible failure message (never an English literal). */
  reason?: string;
  /** Server code or a transport marker, for logs/tests only. */
  code?: string;
}

export function isSafeLaunchUrl(raw: string): boolean {
  const url = String(raw || "").trim();
  if (!url || url.length > MAX_LEN) return false;
  if (!SAFE_SCHEME.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    return true;
  } catch {
    return false;
  }
}

/** Server codes -> i18n keys (F84 §2.3). Anything unknown is the generic
 *  launch failure, so a new server code can never render an empty toast. */
function reasonForCode(code: string): string {
  if (code === "NO_ACTIVE_SESSION") return "search.launchUrl.noSession";
  if (code === "RATE_LIMITED") return "search.launchUrl.rateLimited";
  return "search.launchUrl.failed";
}

export async function launchUrl(raw: string): Promise<LaunchOutcome> {
  const url = String(raw || "").trim();
  if (!isSafeLaunchUrl(url)) return { ok: false, reason: "search.launchUrl.failed", code: "VALIDATION_ERROR" };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = getKey();
  if (key) headers["X-Dash-Token"] = key;
  try {
    const r = await fetch("/api/launch-url", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({ url }),
    });
    if (r.ok) return { ok: true };
    const body = (await r.json().catch(() => null)) as { code?: string; messageKey?: string } | null;
    const code = String(body?.code || String(r.status));
    return { ok: false, reason: reasonForCode(code), code };
  } catch {
    // No window.open. A dropped connection is a visible failure, not a
    // silent switch to the operator's local browser.
    return { ok: false, reason: "search.launchUrl.failed", code: "transport" };
  }
}
