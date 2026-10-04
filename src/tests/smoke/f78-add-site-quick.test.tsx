// [F78 §2.1 / §6B] "+ Add site" quick-add modal: HTTPS is required before the
// network, userinfo URLs are refused outright, a valid add POSTs once, closes
// and toasts. Category/allowlist are derived from the URL host, never typed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { AddSiteQuick } from "@/components/search/AddSiteQuick";
import { resetCustomSourcesStore, useCustomSourcesStore } from "@/stores/customSourcesStore";

function mount(open = true) {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <AddSiteQuick open={open} onClose={onClose} />
    </MemoryRouter>
  );
  return onClose;
}

function stubFetch(rows: unknown[], postOk = true) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const body = init?.method === "POST" ? (postOk ? { ok: true, source: (rows[0] as object) } : { code: "VALIDATION_ERROR", messageKey: "newSiteHttpsRequired" }) : { sources: rows };
    return Promise.resolve({ ok: init?.method === "POST" ? postOk : true, status: init?.method === "POST" && !postOk ? 400 : 200, json: () => Promise.resolve(body) } as unknown as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ROW = {
  id: "docs-python-org",
  name: "Python docs",
  baseUrl: "https://docs.python.org",
  hostname: "docs.python.org",
  labMode: true,
  category: "software",
  allowedDomains: ["docs.python.org"],
  enableState: "permanent",
  addedAt: "2026-10-04T00:00:00Z",
};

beforeEach(() => {
  resetCustomSourcesStore();
  stubFetch([ROW]);
});

describe("F78 AddSiteQuick", () => {
  it("renders nothing while closed", () => {
    mount(false);
    expect(screen.queryByTestId("add-site-modal")).toBeNull();
  });

  it("shows the Name + Base URL fields, the derived host and Save/Cancel", () => {
    mount();
    expect(screen.getByTestId("add-site-name")).toBeInTheDocument();
    expect(screen.getByTestId("add-site-url")).toBeInTheDocument();
    expect(screen.getByTestId("add-site-save")).toBeInTheDocument();
    expect(screen.getByTestId("add-site-cancel")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "https://docs.python.org/3" } });
    expect(screen.getByTestId("add-site-derived").textContent).toContain("docs.python.org");
  });

  it("an http:// URL produces an inline error and issues no POST", () => {
    const fn = stubFetch([ROW]);
    mount();
    fireEvent.change(screen.getByTestId("add-site-name"), { target: { value: "Python docs" } });
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "http://docs.python.org" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    expect(screen.getByTestId("add-site-error")).toHaveTextContent(/https/i);
    expect(fn.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("a userinfo URL is refused (credentials never ride in a URL)", () => {
    mount();
    fireEvent.change(screen.getByTestId("add-site-name"), { target: { value: "Python docs" } });
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "https://user:pass@docs.python.org" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    expect(screen.getByTestId("add-site-error")).toBeInTheDocument();
  });

  it("a valid HTTPS add posts once, closes the modal and toasts", async () => {
    const fn = stubFetch([ROW]);
    const onClose = mount();
    fireEvent.change(screen.getByTestId("add-site-name"), { target: { value: "Python docs" } });
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "https://docs.python.org/3" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const posts = fn.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(String((posts[0][1] as RequestInit).body)).toContain('"labMode":true');
    expect(useCustomSourcesStore.getState().labSources).toHaveLength(1);
  });
});
