// [F41 §7.1 smoke 1] THE 219-ID REGRESSION LOCK - every id in
// src/lib/regression-ids.ts (extracted verbatim from
// tests/f38-ui-glass.test.js BASELINE_IDS) must exist in the shipped v2 DOM.
// This is the mission's hard gate: CI fails if any id goes missing.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import App from "@/App";
import { REGRESSION_IDS } from "@/lib/regression-ids";

describe("F38/F39 regression lock (219 ids)", () => {
  it("renders every frozen id in the v2 DOM (landing route, native-status settled)", async () => {
    const { container } = render(<App />);
    const missing: string[] = [];
    for (const id of REGRESSION_IDS) {
      if (!container.ownerDocument.getElementById(id)) missing.push(id);
    }
    if (missing.length) {
      throw new Error("MISSING " + missing.length + "/" + REGRESSION_IDS.length + " regression ids: " + missing.join(", "));
    }
  });

  it("REGRESSION_IDS has exactly 219 entries", () => {
    expect(REGRESSION_IDS.length).toBe(219);
  });
});
