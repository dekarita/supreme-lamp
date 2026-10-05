// [F91 §D.1] The content-type router that decides HOW each media result is
// played, per the operator's smart-streaming decision:
//
//   audio  -> inline <audio> through /api/stream (bytes travel RDP -> dashboard
//             -> user, so the provider serves the RUNNER's IP)
//   video  -> "Watch in RDP" (a big player over a throttled web relay is a
//             worse experience than the session's own Chrome)
//   live   -> "Watch Live in RDP" (DRM/session-bound sources refuse a proxy
//             outright; the only honest option IS the browser inside RDP)
//   other  -> plain mirror Open (F91 §B: local tab + queue job, no error path)
//
// Pure + exported separately (routeContent/extensionOf) so the node/vitest
// lanes can pin the tables without a DOM.
export type StreamRoute = "audio-inline" | "video-rdp" | "live-rdp" | "generic";

const AUDIO_EXT = ["mp3", "m4a", "flac", "ogg", "wav", "opus"];
const VIDEO_EXT = ["mp4", "mkv", "webm", "mov", "avi"];
// exact-host + registrable-suffix match on the hostname (subdomains of these
// count: live.youtube.com is a live host).
const LIVE_HOSTS = ["tubitv.com", "pluto.tv", "youtube.com", "youtu.be", "vimeo.com", "twitch.tv"];
// extension-less mime fallbacks: a URL without a usable extension is still
// routed by a declared mimeType (adapters set audio/mpeg on librivox rows).
const AUDIO_MIMES = ["audio/"];
const VIDEO_MIMES = ["video/"];

/** Extension of the URL PATH (query/hash stripped, lower-cased, no dot). */
export function extensionOf(raw: string): string {
  let u = String(raw || "").trim();
  if (!u) return "";
  try {
    const parsed = new URL(u);
    u = parsed.pathname;
  } catch {
    u = u.split("?")[0].split("#")[0];
    const slash = u.lastIndexOf("/");
    if (slash >= 0) u = u.slice(slash + 1);
    const q = u.indexOf("?");
    if (q >= 0) u = u.slice(0, q);
  }
  const dot = u.lastIndexOf(".");
  if (dot < 0 || dot === u.length - 1) return "";
  const ext = u.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

function hostnameOf(raw: string): string {
  try {
    return new URL(String(raw || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLiveHost(host: string): boolean {
  if (!host) return false;
  return LIVE_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/** The routing decision for one result. Extension first (cheap, offline),
 *  declared mimeType second, live-host last so a tubitv .mp4 page URL still
 *  routes live when its host is a live source... (a real .mp4 extension is an
 *  actual file, so extension wins; the host rule only fires without one). */
export function routeContent(url: string, mimeType?: string | null): StreamRoute {
  const ext = extensionOf(url);
  const mime = String(mimeType || "").toLowerCase();
  const host = hostnameOf(url);
  if (AUDIO_EXT.includes(ext)) return "audio-inline";
  if (VIDEO_EXT.includes(ext)) return "video-rdp";
  if (isLiveHost(host)) return "live-rdp";
  if (AUDIO_MIMES.some((m) => mime.startsWith(m))) return "audio-inline";
  if (VIDEO_MIMES.some((m) => mime.startsWith(m))) return "video-rdp";
  return "generic";
}

/** Is this URL worth rendering a StreamCard for at all? (generic rows keep
 *  the plain Open button and no extra DOM.) */
export function hasMediaRoute(url: string, mimeType?: string | null): boolean {
  return routeContent(url, mimeType) !== "generic";
}

/** The /api/stream src for an inline <audio>/<video> element. */
export function streamSrc(url: string): string {
  return "/api/stream?url=" + encodeURIComponent(String(url || "").trim());
}

export const STREAM_AUDIO_EXT = AUDIO_EXT;
export const STREAM_VIDEO_EXT = VIDEO_EXT;
export const STREAM_LIVE_HOSTS = LIVE_HOSTS;
