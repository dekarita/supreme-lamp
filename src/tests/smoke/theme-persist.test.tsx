// [F41 §7.1 smoke 5] Theme persistence: dark|light round-trips through
// localStorage (ghrdp:theme) and lands on html[data-theme].
import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import App from "@/App";
import { useThemeStore } from "@/stores/prefsStore";

describe("theme persistence", () => {
  it("persists theme and reflects it on <html data-theme>", async () => {
    render(<App />);
    await act(async () => {
      useThemeStore.getState().setTheme("light");
    });
    const stored = JSON.parse(window.localStorage.getItem("ghrdp:theme") || "{}") as { state?: { theme?: string } };
    expect(stored.state?.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await act(async () => {
      useThemeStore.getState().setTheme("dark");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
