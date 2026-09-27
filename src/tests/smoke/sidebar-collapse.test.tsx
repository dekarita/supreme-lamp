// [F41 §7.1 smoke 6] Sidebar collapse persists (ghrdp:sidebarCollapsed) and
// the shell reflects the state (data-testid=sidebar-collapse).
import { describe, expect, it } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import App from "@/App";
import { useSidebarStore } from "@/stores/prefsStore";

describe("sidebar collapse", () => {
  it("toggle persists and rehydrates", async () => {
    const { container } = render(<App />);
    const btn = container.ownerDocument.querySelector('[data-testid="sidebar-collapse"]') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      fireEvent.click(btn as HTMLButtonElement);
    });
    expect(useSidebarStore.getState().collapsed).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem("ghrdp:sidebarCollapsed") || "{}") as { state?: { collapsed?: boolean } };
    expect(stored.state?.collapsed).toBe(true);
  });
});
