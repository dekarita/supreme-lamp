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
  /** [F87 §D.2] The F86 ladder rung that did the work (1-3), from the 200
   *  body, so a result card can say "opened via tier N" without the banner. */
  tier?: number;
  /** [F87 §D.2] The rung's detail string (e.g. "direct-spawn"). */
  tierDetail?: string;
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

// [F85 §3] Feature-DETECTION handle. The diagnostic banner must be able to
// prove the no-fallback contract is in the RUNNING bundle (`typeof
// window.launchUrl === "function"`) instead of believing a server flag: a
// stale ui-dist zip would otherwise print a checkmark for code it does not
// contain. This exports nothing new to the operator - it is the same function
// the result cards call - and it is installed once from src/main.tsx.
export function installLaunchUrlHandle(): void {
  try {
    if (typeof window === "undefined") return;
    (window as unknown as { launchUrl?: typeof launchUrl }).launchUrl = launchUrl;
  } catch {
    // A locked-down window object is not a reason to break the app; the banner
    // simply reports the check as missing.
  }
}

// [F88 §B.4] The visible failure line: the rung that failed + the reason +
// a 1-click pointer to the diag panel (/#/search?diag=1). No tier in the
// outcome (validation/transport) falls back to the F84 reason + retry line.
export function launchFailureToast(
  out: LaunchOutcome,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (typeof out.tier === "number" && out.tier >= 0) {
    return t("search.launchUrl.failedTier", { tier: out.tier, reason: t(out.reason || "search.launchUrl.failed") });
  }
  return t(out.reason || "search.launchUrl.failed") + " — " + t("search.launchUrl.retry");
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
    // [F87 §B/§D.2] ALWAYS consume the body. The F86 200 carries {tier,
    // tierDetail}; and an unread fetch body keeps the request "loading" in
    // Chromium, which is exactly what left the ten-site spec's response read
    // hanging. A malformed body is still a successful launch.
    let body: { code?: string; messageKey?: string; tier?: number; tierDetail?: string; reason?: string } | null = null;
    try {
      body = (await r.json()) as { code?: string; messageKey?: string; tier?: number; tierDetail?: string } | null;
    } catch {
      body = null;
    }
    if (r.ok) {
      const out: LaunchOutcome = { ok: true };
      if (typeof body?.tier === "number" && body.tier > 0) out.tier = body.tier;
      if (typeof body?.tierDetail === "string" && body.tierDetail) out.tierDetail = body.tierDetail;
      return out;
    }
    const code = String(body?.code || String(r.status));
    // [F88 §B.4] the 500/503 bodies carry `tier` (the last rung that tried) -
    // surface it so the toast can name the failed rung.
    const out: LaunchOutcome = { ok: false, reason: reasonForCode(code), code };
    if (typeof body?.tier === "number" && body.tier >= 0 && out.tier === undefined) out.tier = body.tier;
    return out;
  } catch {
    // No window.open. A dropped connection is a visible failure, not a
    // silent switch to the operator's local browser.
    return { ok: false, reason: "search.launchUrl.failed", code: "transport" };
  }
}
