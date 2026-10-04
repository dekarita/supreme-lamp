// [F84 §2.1] Vitest-runt coverage for the AddSiteQuick normalisation UX.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { AddSiteQuick, isInsecureHttp, normalizeUrl } from "@/components/search/AddSiteQuick";
import { resetCustomSourcesStore } from "@/stores/customSourcesStore";

function mount() {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <AddSiteQuick open={true} onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => {
  resetCustomSourcesStore();
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sources: [] }) } as unknown as Response),
    ),
  );
});

describe("F84 AddSiteQuick normalisation", () => {
  it("bare domain normalises to https:// on blur with the visible hint", () => {
    mount();
    const url = screen.getByTestId("add-site-url") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "openculture.com" } });
    fireEvent.blur(url);
    expect(url.value).toBe("https://openculture.com");
    expect(screen.getByTestId("add-site-auto-https")).toBeInTheDocument();
  });

  it("explicit http:// is refused with the httpsOnly message, not rewritten", () => {
    mount();
    fireEvent.change(screen.getByTestId("add-site-name"), { target: { value: "Demo" } });
    const url = screen.getByTestId("add-site-url") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "http://example.com" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    expect(url.value).toBe("http://example.com");
    expect(screen.getByTestId("add-site-url-error")).toBeInTheDocument();
    expect(screen.getByTestId("add-site-url-error").textContent).toContain("HTTPS required");
  });

  it("saves the normalised https URL (no scheme-less request ever leaves the modal)", async () => {
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init?: RequestInit) => {
        if (init?.method === "POST") posted.push(String(init.body));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, source: null, sources: [] }),
        } as unknown as Response);
      }),
    );
    mount();
    fireEvent.change(screen.getByTestId("add-site-name"), { target: { value: "Demo" } });
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "openculture.com" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    await Promise.resolve();
    expect(normalizeUrl("openculture.com")).toBe("https://openculture.com");
    expect(posted.length > 0 ? posted[0] : "").toContain("https://openculture.com");
    expect(isInsecureHttp("https://openculture.com")).toBe(false);
  });
});
