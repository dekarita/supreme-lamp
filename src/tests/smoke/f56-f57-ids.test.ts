// [F56-c] Additive F56/F57 id locks (session §4/§5): the frozen 219 stays
// one-directional and untouched; f56.search.* + f57.explorer.* are additive
// namespaces that can never collide with it (or with each other).
import { describe, expect, it } from "vitest";
import { REGRESSION_IDS } from "@/lib/regression-ids";
import { F56_SEARCH_IDS, F56_SEARCH_STATIC, F56_SEARCH_TEMPLATES } from "@/pages/search/ids";
import { F57_EXPLORER_IDS, F57_EXPLORER_STATIC, F57_EXPLORER_TEMPLATES } from "@/pages/file-explorer/ids";

const ALL_NEW = [...F56_SEARCH_IDS, ...F57_EXPLORER_IDS];

describe("f56/f57 id locks", () => {
  it("F56 inventory is the frozen Plan §I list (71 entries)", () => {
    expect(F56_SEARCH_IDS.length).toBe(71);
    expect(F56_SEARCH_STATIC.length + F56_SEARCH_TEMPLATES.length).toBe(71);
    expect(F57_EXPLORER_IDS.length).toBe(21);
    expect(F57_EXPLORER_STATIC.length + F57_EXPLORER_TEMPLATES.length).toBe(21);
  });

  it("every id is namespaced and unique across the new locks", () => {
    for (const id of ALL_NEW) {
      expect(id).toMatch(/^f5[67]\.(search|explorer)\.[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/);
    }
    expect(new Set(ALL_NEW).size).toBe(ALL_NEW.length);
  });

  it("cannot collide with the frozen 219 (one-directional lock)", () => {
    expect(REGRESSION_IDS.length).toBe(219);
    const parent = new Set(REGRESSION_IDS.map((p) => p.replace(/^[#.]/, "")));
    for (const id of ALL_NEW) {
      expect(parent.has(id)).toBe(false);
      expect(parent.has(id.replace(/\./g, "-"))).toBe(false);
    }
    // the frozen lock keeps no f56./f57. entry - additive ids live only here
    for (const id of REGRESSION_IDS) {
      expect(id.startsWith("f56.")).toBe(false);
      expect(id.startsWith("f57.")).toBe(false);
    }
  });

  it("templates cover every repeated-instance root used in code", () => {
    for (const t of F57_EXPLORER_TEMPLATES) {
      expect(F57_EXPLORER_IDS as readonly string[]).toContain(t);
    }
  });
});
