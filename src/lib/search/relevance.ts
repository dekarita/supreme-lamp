// [F71 §D#3 / F73.1] Small deterministic scorer; provider data is a hint, not a trust decision.
import type { SearchResult } from "@/api/search";
import { fileExtension } from "@/pages/search/tokens";

// One stable anchor per page session keeps relevance comparisons deterministic
// while still giving recently published items a bounded freshness boost.
const SCORE_REFERENCE_TIME_MS = Date.now();

function metadataNumber(result: SearchResult, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(result.metadata?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function scoreResult(query: string, result: SearchResult): number {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const title = String(result.title || "").toLocaleLowerCase();
  const creator = String(result.creator || "").toLocaleLowerCase();
  const snippet = String(result.snippet || "").toLocaleLowerCase();
  let score = 0;

  if (normalizedQuery && title === normalizedQuery) score += 100;
  else if (normalizedQuery) {
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    if (title.startsWith(normalizedQuery) || (tokens.length > 0 && tokens.every((token) => title.includes(token)))) score += 60;
  }
  if (normalizedQuery && (creator.includes(normalizedQuery) || snippet.includes(normalizedQuery))) score += 25;
  if (fileExtension(result)) score += 15;

  const published = result.date ? Date.parse(String(result.date)) : Number.NaN;
  if (Number.isFinite(published)) {
    const ageDays = Math.max(0, (SCORE_REFERENCE_TIME_MS - published) / 86_400_000);
    score += Math.max(0, 20 * (1 - ageDays / (365 * 5)));
  }

  const stars = metadataNumber(result, "stars", "stargazers_count");
  const citations = metadataNumber(result, "citationCount", "citationCountByYear", "citations");
  score += Math.min(10, Math.log10(stars + 1) * 3);
  score += Math.min(10, Math.log10(citations + 1) * 3);
  return score;
}
