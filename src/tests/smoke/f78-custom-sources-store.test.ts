// [F78 §1.2 / §6B] The custom-sources store: it loads the F58 registry view,
// keeps ONLY the Lab Mode subset, derives hostname from baseUrl (never trusts a
// payload value), defaults labMode to true, and refuses an invalid quick-add
// BEFORE any network call. A failed load hides the row instead of throwing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCustomSourcesStore, useCustomSourcesStore } from "@/stores/customSourcesStore";
import { validateNewSite, NEW_SITE_NAME_MAX } from "@/api/lab";
import F58 from "@/search/custom-source-core";

const ROW_LAB = {
  id: "docs-python-org",
  name: "Python docs",
  baseUrl: "https://docs.python.org/3/",
  labMode: true,
  category: "software",
  allowedDomains: ["docs.python.org"],
  enableState: "permanent",
  addedAt: "2026-10-04T00:00:00Z",
};
const ROW_PUBLIC = { ...ROW_LAB, id: "example-com", baseUrl: "https://example.com", labMode: false };

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handler(String(url), init)) } as unknown as Response)
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  resetCustomSourcesStore();
});

describe("F78 custom-sources store", () => {
  it("keeps the Lab Mode subset only and derives hostname from baseUrl", async () => {
    stubFetch(() => ({ sources: [{ ...ROW_LAB, hostname: "WRONG.example" }, ROW_PUBLIC] }));
    await useCustomSourcesStore.getState().refresh();
    const rows = useCustomSourcesStore.getState().labSources;
    expect(rows.map((r) => r.id)).toEqual(["docs-python-org"]);
    // Derived, never trusted: the payload's bogus hostname is discarded.
    expect(rows[0].hostname).toBe("docs.python.org");
    expect(rows[0].labMode).toBe(true);
  });

  it("defaults labMode to true when the payload omits it (F58 rule reuse)", () => {
    expect(F58.normalizeExtension({ addedAt: ROW_LAB.addedAt, source: "a".repeat(16), enableState: "permanent" }).labMode).toBe(true);
    expect(F58.normalizeExtension({ labMode: false }).labMode).toBe(false);
    expect(F58.withHostname("https://docs.python.org/3/", {}).hostname).toBe("docs.python.org");
  });

  it("refuses http:// and userinfo URLs before any network call", () => {
    expect(validateNewSite("Python", "http://docs.python.org")).toBe("https-required");
    expect(validateNewSite("Python", "https://user:pass@docs.python.org")).toBe("auth-not-allowed");
    expect(validateNewSite("", "https://docs.python.org")).toBe("name-required");
    expect(validateNewSite("x".repeat(NEW_SITE_NAME_MAX + 1), "https://docs.python.org")).toBe("name-too-long");
    expect(validateNewSite("Python", "https://docs.python.org")).toBeNull();
  });

  it("addSite POSTs labMode:true then reloads the list", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      if (init?.method === "POST") return { ok: true, source: { ...ROW_LAB, id: "docs-python-org" } };
      return { sources: [ROW_LAB] };
    });
    const out = await useCustomSourcesStore.getState().addSite("Python docs", "https://docs.python.org/3");
    expect(out.ok).toBe(true);
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toContain("/api/f58/sources");
    expect(String(post?.init?.body)).toContain('"labMode":true');
    expect(String((post?.init?.headers as Record<string, string>)?.["X-Dash-Token"] ?? "")).not.toContain("key=");
    expect(useCustomSourcesStore.getState().labSources).toHaveLength(1);
  });

  it("a failed load hides the row (no throw, empty list)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await useCustomSourcesStore.getState().refresh();
    expect(useCustomSourcesStore.getState().labSources).toEqual([]);
    expect(useCustomSourcesStore.getState().error).toBeTruthy();
  });

  it("an invalid add never reaches the network", async () => {
    const fn = stubFetch(() => ({ sources: [] }));
    const out = await useCustomSourcesStore.getState().addSite("Python docs", "http://docs.python.org");
    expect(out.ok).toBe(false);
    expect(out.error).toBe("https-required");
    expect(fn).not.toHaveBeenCalled();
  });
});
