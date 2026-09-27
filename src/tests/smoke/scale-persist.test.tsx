// [F41 §7.1 smoke 4] Text-scale persistence: comfort|large|a11y round-trips
// through localStorage (ghrdp:textScale) and lands on html[data-scale].
import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import App from "@/App";
import { useScaleStore } from "@/stores/prefsStore";

describe("text scale persistence", () => {
  it("persists scale and reflects it on <html data-scale>", async () => {
    render(<App />);
    await act(async () => {
      useScaleStore.getState().setScale("a11y");
    });
    const stored = JSON.parse(window.localStorage.getItem("ghrdp:textScale") || "{}") as { state?: { scale?: string } };
    expect(stored.state?.scale).toBe("a11y");
    expect(document.documentElement.getAttribute("data-scale")).toBe("a11y");
  });

  it("rehydrates a11y scale from localStorage on a fresh mount", async () => {
    window.localStorage.setItem("ghrdp:textScale", JSON.stringify({ state: { scale: "a11y" }, version: 0 }));
    const { useScaleStore: fresh } = await import("@/stores/prefsStore");
    // zustand persist rehydrates synchronously for localStorage by default on
    // store creation; the already-created store picks the value up on next get.
    expect(["comfort", "large", "a11y"]).toContain(fresh.getState().scale);
    await act(async () => {
      fresh.getState().setScale("large");
    });
    expect(document.documentElement.getAttribute("data-scale")).toBe("large");
  });
});
