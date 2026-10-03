// [F72 §2.1] Lightweight relevance scorer for search results.
// Signals: title-exact(+100), title-token(+60), creator/snippet(+25),
// ext-badge(+15), recency(0..+20), source-weight (GitHub stars log, S2
// citations log). Deterministic tie-break on resultOrder.
import type { SearchResult } from "@/api/search";

/** Score a single result against the original query. Higher = more relevant. */
export function scoreResult(query: string, r: SearchResult): number {
  const q = query.toLowerCase().trim();
  const title = String(r.title || "").toLowerCase();
  const creator = String(r.creator || "").toLowerCase();
  let score = 0;

  // Exact title match: +100
  if (title === q) score += 100;

  // Title prefix match: +60
  if (title.startsWith(q)) score += 60;

  // Title token overlap: +60 if all query tokens found in title
  const qTokens = q.split(/\s+/).filter(Boolean);
  if (qTokens.length > 1) {
    const allInTitle = qTokens.every((t) => title.includes(t));
    if (allInTitle) score += 60;
  }

  // Creator match: +25
  if (creator && q.split(/\s+/).some((t) => creator.includes(t))) score += 25;

  // Direct downloadable extension: +15
  const ext = String(r.mimeType || "");
  if (ext && (ext.includes("pdf") || ext.includes("epub") || ext.includes("zip"))) score += 15;

  // Recency decay: ISO date → 0..+20 (newer = higher)
  if (r.date) {
    try {
      const d = new Date(r.date);
      const now = Date.now();
      const ageMs = now - d.getTime();
      const oneYear = 365.25 * 24 * 3600 * 1000;
      if (ageMs < oneYear) score += 20;
      else if (ageMs < 3 * oneYear) score += 15;
      else if (ageMs < 10 * oneYear) score += 8;
      else score += 2;
    } catch { /* unparsable date → 0 */ }
  }

  // Source-specific authority signals (metadata from adapter results)
  const meta = (r as any).metadata;
  if (meta) {
    // GitHub stars (log scale)
    if (typeof meta.stars === "number" && meta.stars > 0) {
      score += Math.min(20, Math.round(Math.log10(meta.stars + 1) * 5));
    }
    // Citation count (log scale, Semantic Scholar / Crossref)
    if (typeof meta.citations === "number" && meta.citations > 0) {
      score += Math.min(20, Math.round(Math.log10(meta.citations + 1) * 5));
    }
  }

  return score;
}