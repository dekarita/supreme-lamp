// [F81 §4.2/Q1=B] launchUrl(): POST /api/launch-url with the validated URL.
// The server route sanitises the URL (https only, no userinfo, <=2048) and
// schedules a one-shot Interactive task running `cmd /c start "" "<url>"`
// for the active console user. If the server route returns a non-2xx
// response (or the network call fails) the function falls back to opening
// the URL in a new browser tab via window.open(), so a partial deploy
// never strands a click.
import { getKey } from "@/lib/api";

const SAFE_SCHEME = /^https:\/\//i;
const MAX_LEN = 2048;

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

export async function launchUrl(raw: string): Promise<{ ok: boolean; fallback: boolean; code?: string }> {
  const url = String(raw || "").trim();
  if (!isSafeLaunchUrl(url)) return { ok: false, fallback: false };
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
    if (r.ok) return { ok: true, fallback: false };
    // 4xx/5xx: server refused. Surface fallback to a new tab so the operator
    // is never stuck on a non-functional link.
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch { }
    return { ok: false, fallback: true, code: String(r.status) };
  } catch {
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch { }
    return { ok: false, fallback: true, code: "transport" };
  }
}