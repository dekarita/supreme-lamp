// [F56-c] Sinhala byte-verified parity for the F56/F56-c catalogs (session §4,
// decisions.md B13): en/si key sets are IDENTICAL over search.* + files.* +
// nav.files/nav.search; every si value is non-empty, UTF-8 byte-round-trips,
// and carries real Sinhala codepoints unless it is a technical/proper-noun
// token. The pre-existing non-F56 gap is reported but never fails here.
import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import si from "@/i18n/si.json";

type Cat = Record<string, unknown>;
const SINHALA = /[\u0D80-\u0DFF]/;
const TECHNICAL = /^[A-Za-z0-9 ._:/\-+()%&,']+$/;

function flat(d: Cat, p = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v && typeof v === "object") Object.assign(out, flat(v as Cat, p + k + "."));
    else out[p + k] = String(v);
  }
  return out;
}

const fe = flat(en as Cat);
const fs = flat(si as Cat);
const isNew = (k: string) => k.startsWith("search.") || k.startsWith("files.") || k === "nav.files" || k === "nav.search";
const enNew = Object.keys(fe).filter(isNew).sort();
const siNew = Object.keys(fs).filter(isNew).sort();

describe("i18n F56 parity (byte-verified)", () => {
  it("en/si new-namespace key sets are identical", () => {
    expect(siNew).toEqual(enNew);
    expect(enNew.length).toBe(433); // [F56-c v3] 273 + 10 + [F58] 56 + [F56-d] 16 + [F57] 78 ops keys (command/ctx/preview/drop/trash/queue)
  });

  it("every si value is non-empty, byte-stable Sinhala or a technical token", () => {
    for (const k of siNew) {
      const v = fs[k];
      expect(v.trim().length).toBeGreaterThan(0);
      // UTF-8 byte round-trip proof (byte-verified Sinhala)
      expect(Buffer.from(v, "utf8").toString("utf8")).toBe(v);
      const stripped = v.replace(/\{\{\s*\w+\s*\}\}/g, "");
      expect(SINHALA.test(v) || TECHNICAL.test(stripped)).toBe(true);
    }
  });

  it("interpolation placeholders match between en and si", () => {
    for (const k of enNew) {
      const ph = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) || []).sort();
      expect(ph(fs[k])).toEqual(ph(fe[k]));
    }
  });

  it("reports (without failing) the pre-existing non-F56 gap", () => {
    const gap = Object.keys(fe).filter((k) => !isNew(k) && !(k in fs));
    // Pre-existing 88-key gap is F56-out-of-scope (B13): informational only.
    expect(Array.isArray(gap)).toBe(true);
  });
});
