// [F56-c v2] URL import + own-credential modal (§2): an https:// query switches
// the page into import mode, and a login-required source opens the
// own-credential modal (user + password) whose notice states the F46 per-run
// key rule. Everything is UI-only: nothing is submitted, no credential is
// persisted anywhere, and the password is wiped both on close and on submit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { useSearchStore, DEFAULT_MAX_SIZE_BYTES } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { useToastStore } from "@/stores/toastStore";

beforeEach(() => {
  useSearchStore.setState({
    rawQuery: "",
    normalizedQuery: "",
    inputKind: "empty",
    phase: "idle",
    searchId: "",
    results: {},
    resultOrder: [],
    adapters: {},
    categories: [],
    licenceTags: [],
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    sort: "relevance",
    lastErrorCode: "",
  });
  useSearchUiStore.setState({
    view: "landing",
    animating: false,
    advancedOpen: false,
    importMode: false,
    recentQueries: [],
    labStartedAt: 0,
    credModalOpen: false,
    cred: { host: "", user: "", password: "" },
    credError: "",
  });
  useToastStore.setState({ toasts: [] });
  window.localStorage.clear();
  window.sessionStorage.clear();
  // The dispatch itself is out of scope here - never let a cell reach the network.
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) })));
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/search"]}>
      <Search />
    </MemoryRouter>
  );
}

describe("F56-c v2 URL import + own credentials", () => {
  it("detects an HTTPS URL, enters import mode and offers the own-credential path", async () => {
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "https://example.org/dataset.zip" } });
    expect(document.getElementById("f56.search.urlImport")?.textContent).toContain("HTTPS URL detected");
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    expect(screen.getByTestId("url-import-banner")).toBeInTheDocument();
    expect(useSearchUiStore.getState().importMode).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("import-own-credential"));
    });
    const modal = screen.getByTestId("own-credential-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId("cred-host").textContent).toContain("example.org");
    expect(screen.getByTestId("cred-notice").textContent).toBe("F46 per-run key, never persisted, session-end wipe.");
    expect((screen.getByTestId("cred-password") as HTMLInputElement).type).toBe("password");
  });

  it("validates both fields, then stubs the submit and wipes the password", async () => {
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "https://example.org/dataset.zip" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("import-own-credential"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cred-submit"));
    });
    expect(screen.getByTestId("cred-error").textContent).toBe("Enter a username.");
    await act(async () => {
      fireEvent.change(screen.getByTestId("cred-user"), { target: { value: "operator" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cred-submit"));
    });
    expect(screen.getByTestId("cred-error").textContent).toBe("Enter a password.");

    await act(async () => {
      fireEvent.change(screen.getByTestId("cred-password"), { target: { value: "hunter2" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cred-submit"));
    });
    // stub answer, and the typed password is gone from memory immediately
    expect(useToastStore.getState().toasts.map((t) => t.msg).join(" ")).toContain("stub");
    expect(useSearchUiStore.getState().cred.password).toBe("");
    expect((screen.getByTestId("cred-password") as HTMLInputElement).value).toBe("");
    // nothing was written to any storage
    expect(JSON.stringify(window.localStorage)).not.toContain("hunter2");
    expect(JSON.stringify(window.sessionStorage)).not.toContain("hunter2");
  });

  it("Escape closes the modal and wipes both credential fields", async () => {
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "https://example.org/x" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("import-own-credential"));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("cred-user"), { target: { value: "operator" } });
      fireEvent.change(screen.getByTestId("cred-password"), { target: { value: "topsecret" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("own-credential-modal")).toBeNull();
    expect(useSearchUiStore.getState().cred).toEqual({ host: "", user: "", password: "" });
    expect(JSON.stringify(window.localStorage)).not.toContain("topsecret");
  });
});
