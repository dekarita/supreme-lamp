// [F81 §2.1/Q5=D + §2.2/Q6] Vitest-runt scorer + token gate. Asserts the
// BM25 + stop-words + 3-char min scorer from src/lib/search/relevance.ts.
// Specifically targets the F80 failure modes the operator reported:
//   * query "hi" returns ZERO BM25 score (stop-word) — only the
//     source-trust + recency terms contribute, which is much smaller than
//     the F80 prefix-match +60 the operator complained about;
//   * a multi-token query scores title matches higher than snippet matches
//     (field weight 3:1);
//   * the F80 prefix-bonus explosion on "highcharts" / "highlightjs" is
//     gone.
import { describe, expect, it } from "vitest";
import { scoreResult, tokenize, MIN_QUERY_TOKEN_LEN } from "@/lib/search/relevance";
import type { SearchResult } from "@/api/search";

function r(over: Partial<SearchResult>): SearchResult {
  return {
    resultId: over.resultId ?? "x",
    title: over.title ?? "",
    creator: over.creator ?? "",
    snippet: over.snippet ?? "",
    category: over.category ?? "books",
    licenceTag: over.licenceTag ?? "publicDomain",
    sourceUrl: over.sourceUrl ?? "",
    mimeType: over.mimeType ?? "",
    sizeBytes: over.sizeBytes ?? null,
    date: over.date ?? null,
    nameKey: over.nameKey ?? "x",
    adapterId: over.adapterId ?? "x",
  };
}

describe("F81 relevance (BM25 hybrid, Q5=D)", () => {
  it("tokenize() drops stop-words and tokens shorter than MIN_QUERY_TOKEN_LEN", () => {
    expect(MIN_QUERY_TOKEN_LEN).toBe(3);
    expect(tokenize("hi there, this is a test")).toEqual(["test"]);
    expect(tokenize("the AND or on at to of for")).toEqual([]);
    expect(tokenize("Python 3.12 release")).toEqual(["python", "release"]);
  });

  it("query 'hi' (stop-word) yields no BM25 contribution", () => {
    const highcharts = r({ title: "highcharts docs", snippet: "chart library", resultId: "a" });
    const py = r({ title: "Python tutorial", snippet: "beginners", resultId: "b" });
    const corpus = [highcharts, py];
    const sHigh = scoreResult("hi", highcharts, corpus);
    const sPy = scoreResult("hi", py, corpus);
    // Both rows get only trust + recency, no BM25 contribution.
    // They must NOT receive the F80 prefix-bonus explosion on `title.startsWith("hi")`.
    expect(sHigh).toBe(sPy);
    expect(sHigh).toBeLessThan(20); // way below the F80 +60 prefix bonus
  });

  it("title match scores higher than snippet-only match (field weight 3:1)", () => {
    const titleHit = r({ title: "Python tutorial", snippet: "programming guide", resultId: "t" });
    const snippetHit = r({ title: "Programming guide", snippet: "Python tutorial", resultId: "s" });
    const corpus = [titleHit, snippetHit];
    const sTitle = scoreResult("python", titleHit, corpus);
    const sSnippet = scoreResult("python", snippetHit, corpus);
    expect(sTitle).toBeGreaterThan(sSnippet);
  });

  it("trust bonus is log-scaled + capped at 20 (GitHub stars)", () => {
    const a = r({ resultId: "a", title: "Python" });
    const b = r({ resultId: "b", title: "Python", metadata: { stars: 100000 } as any });
    const corpus = [a, b];
    expect(scoreResult("python", b, corpus)).toBeGreaterThan(scoreResult("python", a, corpus));
    const cap = r({ resultId: "c", title: "Python", metadata: { stars: 1e9 } as any });
    expect(scoreResult("python", cap, corpus)).toBeLessThanOrEqual(scoreResult("python", b, corpus) + 0.0001);
  });

  it("recency bonus decays (newer > older)", () => {
    const fresh = r({ resultId: "f", title: "Python", date: new Date().toISOString() });
    const old = r({ resultId: "o", title: "Python", date: "1990-01-01T00:00:00Z" });
    const corpus = [fresh, old];
    expect(scoreResult("python", fresh, corpus)).toBeGreaterThan(scoreResult("python", old, corpus));
  });

  it("tokenize strips punctuation + collapses whitespace", () => {
    expect(tokenize("Hello, world! How's it going?")).toEqual(["hello", "world", "hows", "going"]);
  });
});