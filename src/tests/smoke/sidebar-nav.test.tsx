// [F56-c] Sidebar + routes + keyboard + palette prefill (session §4).
// 9 entries in locked order; the original 7 keep their to=/key=/icon= exactly.
// Alt+E opens File Explorer, Alt+F opens Search; Ctrl+K palette prefills
// /search WITHOUT submitting (Plan §D).
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "@/App";
import { useSearchStore } from "@/stores/searchStore";

const ORDER = ["/", "/sessions", "/connections", "/keys", "/files", "/mirror", "/search", "/telemetry", "/settings"];

describe("sidebar navigation (F56-c)", () => {
  it("renders 9 entries in the locked order with the two new routes wired", () => {
    const { container } = render(<App />);
    const nav = container.querySelector('[data-testid="sidebar"] nav');
    expect(nav).not.toBeNull();
    const links = Array.from(nav?.querySelectorAll("a") || []);
    expect(links.length).toBe(9);
    const hrefs = links.map((a) => (a.getAttribute("href") || "").replace(/^#/, ""));
    expect(hrefs).toEqual(ORDER);
    expect(document.getElementById("f57.explorer.nav")).not.toBeNull();
    expect(document.getElementById("f56.search.nav")).not.toBeNull();
  });

  it("routes /files and /search to their pages", async () => {
    const { container } = render(<App />);
    const links = Array.from(container.querySelectorAll('[data-testid="sidebar"] nav a'));
    fireEvent.click(links[4]);
    expect(screen.getByTestId("file-explorer-page")).toBeInTheDocument();
    fireEvent.click(links[6]);
    expect(screen.getByTestId("search-page")).toBeInTheDocument();
  });

  it("Alt+E opens File Explorer and Alt+F opens Search", async () => {
    render(<App />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "e", altKey: true });
    });
    expect(screen.getByTestId("file-explorer-page")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", altKey: true });
    });
    expect(screen.getByTestId("search-page")).toBeInTheDocument();
  });

  it("Ctrl+K palette prefills /search without submitting the query", async () => {
    useSearchStore.setState({ phase: "idle" });
    render(<App />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    const palette = screen.getByTestId("command-palette");
    expect(palette).toBeInTheDocument();
    expect(palette.id).toBe("f56.search.paletteCommand");
    await act(async () => {
      fireEvent.change(screen.getByTestId("palette-input"), { target: { value: "gutenberg" } });
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter" });
    });
    expect(screen.getByTestId("search-page")).toBeInTheDocument();
    const input = document.getElementById("f56.search.query") as HTMLInputElement | null;
    expect(input?.value).toBe("gutenberg");
    // prefill only: nothing was dispatched
    const st = useSearchStore.getState();
    expect(st.lastSubmittedQuery).toBe("");
    expect(st.phase).toBe("idle");
  });
});
