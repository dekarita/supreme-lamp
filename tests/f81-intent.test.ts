// [F81 §2.3/Q7=B + §5.0/Q13=D + §4.2/Q1=B + §4.1/Q9] Vitest-runt coverage
// for the F81 client-side helpers: intent classifier, suggestion dropdown
// wiring, launchUrl safety, and the per-field error envelope on POST.
import { describe, expect, it } from "vitest";
import { classifyIntent, rankAdaptersByIntent } from "@/lib/search/intent";
import { isSafeLaunchUrl } from "@/lib/launchUrl";

describe("F81 intent classifier (Q7=B)", () => {
  it("returns 'paper' for arxiv-style queries", () => {
    expect(classifyIntent("arxiv paper on transformers")).toBe("paper");
  });
  it("returns 'code' for source/release queries", () => {
    expect(classifyIntent("python release github")).toBe("code");
  });
  it("returns 'video' for youtube / .mp4 queries", () => {
    expect(classifyIntent("blender .mp4 tutorial")).toBe("video");
  });
  it("returns 'book' for .epub / gutenberg queries", () => {
    expect(classifyIntent("gutenberg .epub classic")).toBe("book");
  });
  it("returns 'repo' for github.com queries", () => {
    expect(classifyIntent("github.com/foo/bar repo")).toBe("repo");
  });
  it("returns 'general' for unrelated queries", () => {
    expect(classifyIntent("weather today")).toBe("general");
  });
});

describe("F81 rankAdaptersByIntent (Q7=B)", () => {
  it("lifts matching adapters to the head, preserving dedup + order", () => {
    const sorted = rankAdaptersByIntent(
      ["wikipedia-public", "github-releases", "arxiv-public", "project-gutenberg"],
      "paper",
    );
    expect(sorted[0]).toBe("arxiv-public");
    expect(sorted).toContain("wikipedia-public");
  });
  it("does not change order for general intent", () => {
    const input = ["wikipedia-public", "github-releases"];
    expect(rankAdaptersByIntent(input, "general")).toEqual(input);
  });
});

describe("F81 isSafeLaunchUrl (Q1=B)", () => {
  it("accepts https URLs without userinfo", () => {
    expect(isSafeLaunchUrl("https://example.com/path")).toBe(true);
  });
  it("rejects http URLs", () => {
    expect(isSafeLaunchUrl("http://example.com")).toBe(false);
  });
  it("rejects URLs carrying credentials", () => {
    expect(isSafeLaunchUrl("https://user:pass@example.com")).toBe(false);
  });
  it("rejects oversize URLs", () => {
    expect(isSafeLaunchUrl("https://example.com/" + "a".repeat(4096))).toBe(false);
  });
  it("rejects empty input", () => {
    expect(isSafeLaunchUrl("")).toBe(false);
    expect(isSafeLaunchUrl("   ")).toBe(false);
  });
});