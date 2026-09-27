// [F41 §7.1 smoke 3] Sinhala sample renders with real Sinhala codepoints and
// the html[lang] attribute follows the persisted preference (U+0D80-0DFF
// unicode-range subset must be loadable for these glyphs).
import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import App from "@/App";
import { useLangStore } from "@/stores/prefsStore";

const SINHALA_RE = /[\u0D80-\u0DFF]/;

describe("sinhala support", () => {
  it("sinhalaSample element exists with Sinhala codepoints", () => {
    const { container } = render(<App />);
    const el = container.ownerDocument.getElementById("sinhalaSample");
    expect(el).toBeInTheDocument();
    expect(el?.getAttribute("lang")).toBe("si");
    expect(SINHALA_RE.test(el?.textContent || "")).toBe(true);
  });

  it("toggling the language store flips html[lang] to si", async () => {
    const { container } = render(<App />);
    await act(async () => {
      useLangStore.getState().setLang("si");
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(container.ownerDocument.documentElement.getAttribute("lang")).toBe("si");
    await act(async () => {
      useLangStore.getState().setLang("en");
    });
  });
});
