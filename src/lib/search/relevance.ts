// [F81 §2.1/Q5=D] BM25 token scoring + stop-word filter + 3-char minimum +
// source-trust weight + recency. Replaces the F80 substring/prefix scorer,
// whose prefix rule (e.g. `title.startsWith("hi")` matches `highcharts`,
// `highlightjs`, …) was the source of the `hi`-noise operator reported.
// Field weights: title=3, snippet=1, creator=1 (matches the brief).
// BM25 params (k1=1.5, b=0.75) are the standard reference values; they are
// tunable via the constants below but were not changed in F81.
import type { SearchResult } from "@/api/search";

const STOPWORDS = new Set<string>([
  // English stop-words (small, curated for the search surface)
  "the","a","an","and","or","in","on","at","to","of","for","is","hi","hey",
  "you","your","yours","i","me","my","mine","we","our","ours","they","them",
  "their","theirs","this","that","these","those","it","its","be","been","being",
  "as","by","from","with","but","not","no","yes","do","does","did","have",
  "has","had","will","would","should","could","can","may","might","must",
  "about","up","off","over","under","into","out","than","then","so","if",
  "what","which","who","whom","whose","when","where","why","how",
  // Sinhala equivalents (transliterated) - operator-facing search terms
  // for documents in Sinhala frequently include these particles; treating
  // them as stop-words prevents irrelevant matches on every query.
  "mehe","ekka","eken","ekai","eka","meka","meken","mema","mage","mata",
  "tama","tawa","tawak","tawaa","nam","namuth","nisa","nisaa","puluvan",
  "da","dakinaa","ane","ani","gahan","gahala","venna","enne","ennage",
]);

export const MIN_QUERY_TOKEN_LEN = 3;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const t = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const parts = t.split(/\s+/).filter(Boolean);
  return parts.filter((p) => p.length >= MIN_QUERY_TOKEN_LEN && !STOPWORDS.has(p));
}

/** Field-weighted BM25 over a single document's three fields. Returns 0 when
 *  no token matches anything. The IDF term uses the result corpus' document
 *  frequency (`df`) and total (`N`) so the score stays calibrated across
 *  different searches. */
function bm25Score(
  toks: string[],
  fields: { title: string; snippet: string; creator: string },
  weights: { title: number; snippet: number; creator: number },
  df: Record<string, number>,
  N: number,
): number {
  if (!toks.length || N <= 0) return 0;
  const k1 = 1.5;
  const b = 0.75;
  const docs: { text: string; weight: number; len: number }[] = [
    { text: (fields.title || "").toLowerCase(), weight: weights.title, len: tokenize(fields.title).length || 1 },
    { text: (fields.snippet || "").toLowerCase(), weight: weights.snippet, len: tokenize(fields.snippet).length || 1 },
    { text: (fields.creator || "").toLowerCase(), weight: weights.creator, len: tokenize(fields.creator).length || 1 },
  ];
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / docs.length || 1;
  let s = 0;
  for (const tok of toks) {
    const n = df[tok] || 0;
    // Smoothed IDF: clamped to 0 when the term saturates the corpus.
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    for (const d of docs) {
      const t = d.text;
      if (!t) continue;
      const tf = (t.match(new RegExp("\\b" + tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g")) || []).length;
      if (!tf) continue;
      const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (d.len / avgdl)));
      s += d.weight * idf * norm;
    }
  }
  return s;
}

/** Score a single result against the original query. Higher = more relevant.
 *  Operator's chosen hybrid: BM25 across title/snippet/creator + a
 *  source-trust bonus (metadata.stars / metadata.citations, both log-scaled
 *  and capped) + a recency bonus (unchanged from F80). When the query has no
 *  qualifying tokens (stop-word-only or < MIN_QUERY_TOKEN_LEN chars) the
 *  trust+recency terms apply but the BM25 term is zero — the result is still
 *  ranked, just not text-relevant. */
export function scoreResult(query: string, r: SearchResult, corpus?: SearchResult[]): number {
  const toks = tokenize(query);
  const meta = (r as any).metadata;
  let corpusN = 0;
  const df: Record<string, number> = {};
  if (corpus && corpus.length) {
    corpusN = corpus.length;
    for (const other of corpus) {
      const seen = new Set<string>();
      const ot = tokenize((other.title || "") + " " + (other.snippet || "") + " " + (other.creator || ""));
      for (const o of ot) seen.add(o);
      for (const o of seen) df[o] = (df[o] || 0) + 1;
    }
  }
  const bm = bm25Score(
    toks,
    { title: r.title || "", snippet: r.snippet || "", creator: r.creator || "" },
    { title: 3, snippet: 1, creator: 1 },
    df,
    corpusN || 1,
  );
  let score = bm * 10; // rescale BM25 into the previous 0-150 range
  // Recency decay (kept identical to F80).
  if (r.date) {
    try {
      const d = new Date(r.date);
      const ageMs = Date.now() - d.getTime();
      const oneYear = 365.25 * 24 * 3600 * 1000;
      if (ageMs < oneYear) score += 20;
      else if (ageMs < 3 * oneYear) score += 15;
      else if (ageMs < 10 * oneYear) score += 8;
      else score += 2;
    } catch { /* unparsable date */ }
  }
  // Source-trust: stars (GitHub) and citations (scholarly) log-scaled + capped.
  if (meta) {
    if (typeof meta.stars === "number" && meta.stars > 0) {
      score += Math.min(20, Math.round(Math.log10(meta.stars + 1) * 5));
    }
    if (typeof meta.citations === "number" && meta.citations > 0) {
      score += Math.min(20, Math.round(Math.log10(meta.citations + 1) * 5));
    }
  }
  // Direct downloadable extension bonus (kept from F80)
  const ext = String(r.mimeType || "");
  if (ext && (ext.includes("pdf") || ext.includes("epub") || ext.includes("zip"))) score += 5;
  return score;
}