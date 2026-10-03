// [F56-c v2] Shared search presentation tokens + guards. The licence palette
// and enum→i18n key mapping were exported from CommandBar (F56-c); they now
// live here so the v2 subtree (cards, advanced panel, preview) can share them
// without importing a component. CommandBar re-exports both names, so existing
// call sites keep working byte-for-byte.
import type { LicenceTag, SearchResult } from "@/api/search";
import { extensionOf } from "@/lib/explorer/preview";

export function camel(v: string): string {
  return v.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Plan §C licence palette: muted tokens (tokens.css), never neon green. */
export function licenceStyle(tag: LicenceTag): string {
  switch (tag) {
    case "public-domain":
      return "text-[color:var(--search-licence-public-fg)] bg-[color:var(--search-licence-public-bg)]";
    case "open-access":
      return "text-[color:var(--search-licence-open-fg)] bg-[color:var(--search-licence-open-bg)]";
    case "creative-commons":
      return "text-[color:var(--search-licence-cc-fg)] bg-[color:var(--search-licence-cc-bg)]";
    case "purchase":
      return "text-[color:var(--search-licence-purchase-fg)] bg-[color:var(--search-licence-purchase-bg)]";
    case "unknown":
      return "text-tertiary bg-raised";
    default:
      return "text-[color:var(--search-licence-own-fg)] bg-[color:var(--search-licence-own-bg)]";
  }
}

/** The only URL form the UI ever surfaces or links: absolute https://. Anything
 *  else (http, protocol-relative, javascript:, data:, relative) is withheld -
 *  the locked rules forbid an unvalidated download/purchase URL reaching the
 *  client, and F56-c has no allowlist to validate against. */
export function validatedHttpsUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  const v = String(raw).trim();
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(v)) return "";
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".") ? u.toString() : "";
  } catch {
    return "";
  }
}

/** Honest byte count for a card ("actual bytes"): grouped integer bytes plus
 *  the binary unit form the rest of the UI uses. Never a rounded-up label. */
export function formatActualBytes(n: number): string {
  const grouped = n.toLocaleString("en-US");
  if (n < 1024) return grouped + " B";
  if (n < 1024 * 1024) return grouped + " B (" + Math.round((n / 1024) * 10) / 10 + " KiB)";
  if (n < 1024 * 1024 * 1024) return grouped + " B (" + Math.round((n / (1024 * 1024)) * 10) / 10 + " MiB)";
  return grouped + " B (" + Math.round((n / (1024 * 1024 * 1024)) * 10) / 10 + " GiB)";
}

/** [F69 §2.2, F71 §B#5 / F72.1] Common MIME -> display extension. Unknown
 *  MIMEs fall through to the URL/title basename so nothing is invented. */
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "application/zip": "zip",
  "application/x-iso9660-image": "iso",
  "application/x-bittorrent": "torrent",
  "application/vnd.rar": "rar",
  "application/x-rar-compressed": "rar",
  "application/x-7z-compressed": "7z",
  "application/vnd.debian.binary-package": "deb",
  "application/x-rpm": "rpm",
  "application/vnd.android.package-archive": "apk",
  "application/x-apple-diskimage": "dmg",
  "application/x-raw-disk-image": "img",
  "application/x-subrip": "srt",
  "text/x-ssa": "ass",
  "application/x-ass": "ass",
  "text/vtt": "vtt",
  "application/wasm": "wasm",
  "application/x-msdownload": "exe",
  "application/x-msi": "msi",
  "application/gzip": "tar.gz",
  "application/x-gzip": "tar.gz",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "text/csv": "csv",
  "text/x-python": "py",
  "application/javascript": "js",
  "text/javascript": "js",
  "application/typescript": "ts",
  "text/typescript": "ts",
  "text/x-go": "go",
  "text/x-rust": "rs",
  "text/x-java-source": "java",
  "text/x-c": "c",
  "text/x-c++src": "cpp",
  "text/x-chdr": "h",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Lowercase file extension for a result card badge (without the dot), or
 *  null when nothing honest can be derived. Order: declared mimeType, then the
 *  https URL path basename, then the title. Landing-page URLs
 *  (…/ebooks/1342, …/abs/2606.01342) yield null rather than a guess. */
export function fileExtension(r: Pick<SearchResult, "mimeType" | "sourceUrl" | "title">): string | null {
  const mime = String(r.mimeType || "").toLowerCase().split(";")[0].trim();
  if (mime && MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  const url = validatedHttpsUrl(r.sourceUrl);
  if (url) {
    try {
      const base = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      const ext = extensionOf(base);
      if (ext && ext.length <= 8 && /[a-z]/.test(ext)) return ext;
    } catch {
      /* fall through to the title */
    }
  }
  const ext = extensionOf(String(r.title || "").trim());
  return ext && ext.length <= 8 && /[a-z]/.test(ext) ? ext : null;
}
