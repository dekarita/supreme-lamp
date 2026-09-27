// [F41 §7.1 smoke 2] Bottom bar clock/elapsed tick: the values must re-render
// from the 1s useNow tick, not just mount once (F11-3 live-clock contract).
import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import App from "@/App";

describe("bottom bar time rows", () => {
  it("clock and elapsed update after a 1s tick", async () => {
    const { container } = render(<App />);
    const clock = container.ownerDocument.getElementById("bottomClock") as HTMLElement;
    const elapsed = container.ownerDocument.getElementById("timerElapsed") as HTMLElement;
    expect(clock).toBeInTheDocument();
    expect(elapsed).toBeInTheDocument();
    const t0 = clock.textContent;
    expect(t0).toMatch(/^\d{2}:\d{2}/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    const t1 = clock.textContent as string;
    const e1 = elapsed.textContent as string;
    expect(t1).not.toBe(t0);
    // Elapsed shows -- until first /api/progress lands; after tick it must be
    // either still placeholder or a valid HMS value (never blank).
    expect(e1 === "--:--:--" || /^\d{2}:\d{2}:\d{2}$/.test(e1)).toBe(true);
    expect(e1).not.toBe("");
  });
});
