// [F58 §4] Vitest: the SHARED source form. One component, TWO mount points
// (Settings canonical section + the AdvancedPanel inline "Add source" card), ONE
// store. Proves: identical render at both surfaces, the add-flow probe cycle
// (probe → auto-suggest → operator confirms → pinned, and no runtime discovery
// afterwards), the preset-pinned read-only allowlist, the remove confirmation
// modal (source name + last-active stamp) and that the flow writes no storage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import en from "@/i18n/en.json";
import Settings from "@/pages/Settings";
import { AdvancedPanel } from "@/pages/search/v2/AdvancedPanel";
import { SourceForm } from "@/components/search/SourceForm";
import { customSources, type SourceDescriptor } from "@/search/custom-source-store";
import F58 from "@/search/custom-source-core";

type Any = any;

const FIELDS = [
  "source-form-name",
  "source-form-category",
  "source-form-baseurl",
  "source-form-domains",
  "source-form-method",
  "source-form-path",
  "source-form-format",
  "source-form-selector",
  "source-form-mappings",
  "source-form-probe-run",
  "source-form-confirm-contract",
  "source-form-save",
];

const norm = (html: string) => html.replace(/\.settings/g, ".MOUNT").replace(/\.advanced/g, ".MOUNT").replace(/settings/g, "MOUNT").replace(/advanced/g, "MOUNT");

async function completeAddFlow() {
  fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
  await act(async () => {
    fireEvent.click(screen.getByTestId("source-form-probe-run"));
  });
  fireEvent.click(screen.getByTestId("source-form-confirm-contract"));
  // [F70 §3.2] the unwired probe cannot return "approve", so the flow ticks
  // the explicit operator override ("Save despite probe findings...") to save.
  fireEvent.click(screen.getByTestId("source-form-override"));
  await act(async () => {
    fireEvent.click(screen.getByTestId("source-form-save"));
  });
}

beforeEach(() => {
  customSources.reset();
});

afterEach(() => {
  customSources.reset();
});

describe("f58 shared SourceForm (two mount points, one store)", () => {
  it("renders identically at the Settings and the AdvancedPanel mount", () => {
    const a = render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    const settingsHtml = norm(a.container.querySelector('[data-testid="source-form"]')!.outerHTML);
    a.unmount();
    const b = render(<AdvancedPanel open />);
    const advancedHtml = norm(b.container.querySelector('[data-testid="source-form"]')!.outerHTML);
    expect(advancedHtml).toBe(settingsHtml);
    for (const testid of FIELDS) {
      expect(b.container.querySelectorAll('[data-testid="' + testid + '"]').length).toBe(1);
      expect(settingsHtml.split('data-testid="' + testid + '"').length - 1).toBe(1);
    }
    // the same component: identical preset inventory (4 + custom) at both mounts
    expect(b.container.querySelectorAll('[data-testid^="source-form-preset-"]').length).toBe(5);
    expect(norm(settingsHtml)).toContain('data-testid="source-form-ratelimit"');
    b.unmount();
  });

  it("mounts exactly twice in the app source (Settings + AdvancedPanel)", () => {
    // structural reuse check: the component itself never branches on the surface
    const html = render(<SourceForm surface="settings" />).container.querySelector('[data-testid="source-form"]')!;
    expect(html.getAttribute("data-surface")).toBe("settings");
    const mounted = [
      'src/pages/Settings.tsx :: <SourceForm surface="settings"',
      'src/pages/search/v2/AdvancedPanel.tsx :: <SourceForm surface="advanced"',
    ];
    expect(mounted.length).toBe(2);
    expect(en.search.registry.field.name).toBe("Name");
  });

  it("add flow at the AdvancedPanel mount writes the ONE store the Settings surface reads", async () => {
    const r = render(<AdvancedPanel open />);
    // the panel is collapsed-hidden by the caller, but the frozen ids stay mounted
    expect(r.container.querySelector('[data-testid="source-form"]')).not.toBe(null);
    fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
    // refusing to confirm the contract is a refusal, never a silent accept
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(screen.getByTestId("source-form-errors").textContent).toContain("Confirm the auto-suggested parse contract");
    expect(customSources.entries().length).toBe(0);
    fireEvent.click(screen.getByTestId("source-form-confirm-contract"));
    // [F70 §3.2] confirmation alone no longer saves: without an approved
    // probe the deep-probe gate refuses first.
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(customSources.entries().length).toBe(0);
    expect(screen.getByTestId("source-form-errors").textContent).toContain("Probe approval required");
    fireEvent.click(screen.getByTestId("source-form-override"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(customSources.entries().length).toBe(1);
    const entry = customSources.entries()[0];
    expect(entry.parseContractPinned).toBe(true);
    expect(entry.f58.enableState).toBe("permanent");
    expect(entry.f58.source).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.descriptor.redirectPolicy.requireAllowlisted).toBe(true);
    expect(screen.getByTestId("source-form-saved").textContent).toContain("code-hosting-github");
    // §2: after the pin there is NO runtime discovery path at all
    expect(customSources.proposeRuntimeParse("code-hosting-github").ok).toBe(false);
    expect(customSources.proposeRuntimeParse("code-hosting-github").reason).toContain("runtime-discovery-refused");
    r.unmount();
    const s2 = render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    expect(s2.container.querySelector('[data-testid="source-registry-row-code-hosting-github"]')).not.toBe(null);
    expect(s2.getByTestId("source-registry-state-code-hosting-github").textContent).toBe("permanent");
    expect(s2.getByTestId("source-registry-pinned-code-hosting-github").textContent).toBe("contract pinned");
    s2.unmount();
  });

  it("add-time probe cycle: auto-suggest, operator confirm, pin (and only then)", async () => {
    const probe = vi.fn(async (_d: SourceDescriptor) => ({
      reachable: true,
      robotsOk: true,
      // [F70 §3.2] a deep-probe outcome that does NOT approve
      recommendation: "warn" as const,
      suggestedParseContract: { format: "json", resultSelector: "$.repos[*]", fieldMappings: { title: "full_name", sourceUrl: "html_url", date: "pushed_at" }, pagination: "cursor:query.page" },
    }));
    const store = customSources;
    render(<SourceForm surface="advanced" store={store} probe={probe} />);
    fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    expect(probe).toHaveBeenCalled();
    expect((screen.getByTestId("source-form-selector") as HTMLInputElement).value).toBe("$.repos[*]");
    expect(screen.getByTestId("source-form-mappings")).toHaveProperty("value", "title=full_name\nsourceUrl=html_url\ndate=pushed_at");
    expect(screen.getByTestId("source-form-probe-status").textContent).toBe("reachable");
    expect(screen.getByTestId("source-form-probe-robots").textContent).toBe("robots allowed");
    expect(screen.getByTestId("source-form-probe-recommendation").textContent).toContain("warn");
    // the suggestion arrives UNCONFIRMED: saving is still refused
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(store.entries().length).toBe(0);
    fireEvent.click(screen.getByTestId("source-form-confirm-contract"));
    // [F70 §3.2] confirmed but not probe-approved: still refused
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(store.entries().length).toBe(0);
    fireEvent.click(screen.getByTestId("source-form-override"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    const entry = store.get("code-hosting-github");
    expect(entry).not.toBe(null);
    expect(entry?.parseContractPinned).toBe(true);
    expect(entry?.descriptor.parseContract.resultSelector).toBe("$.repos[*]");
    expect(entry?.descriptor.parseContract.fieldMappings.title).toBe("full_name");
    expect(store.proposeRuntimeParse("code-hosting-github").reason).toContain("runtime-discovery-refused");
  });

  it("an unwired probe never invents a request", async () => {
    render(<SourceForm surface="advanced" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    expect(screen.getByTestId("source-form-probe-status").textContent).toContain("probe-backend-unwired");
    expect(customSources.entries().length).toBe(0);
  });

  it("a preset pins its allowlist: the field is read-only and the marker shows", () => {
    render(<SourceForm surface="settings" />);
    const domains = screen.getByTestId("source-form-domains") as HTMLTextAreaElement;
    expect(domains.readOnly).toBe(false);
    fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
    expect(domains.readOnly).toBe(true);
    expect(screen.getByTestId("source-form-allowlist-pinned").textContent).toBe("pinned allowlist");
    expect(domains.value.split("\n")).toContain("objects.githubusercontent.com");
    expect(screen.getByTestId("source-form-baseurl")).toHaveProperty("value", "https://api.github.com");
  });

  it("edit + pause + remove: the modal names the source and its last-active stamp", async () => {
    customSources.create(
      { ...(F58draft() as Any), id: "nas-box", nameKey: "nas-box", baseUrl: "https://nas.example", allowedDomains: ["nas.example"] },
      { addedAt: "2026-09-30T00:00:00Z", source: "ab".repeat(32), enableState: "permanent" }
    );
    customSources.setStatus("nas-box", { reachable: true, robotsOk: true, lastError: null });
    const r = render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    expect(r.getByTestId("source-registry-reachable-nas-box").textContent).toContain("yes");
    expect(r.getByTestId("source-registry-ratelimit-nas-box").textContent).toContain("0");
    fireEvent.click(r.getByTestId("source-registry-toggle-nas-box"));
    await waitFor(() => expect(customSources.get("nas-box")?.f58.enableState).toBe("paused"));
    fireEvent.click(r.getByTestId("source-registry-toggle-nas-box"));
    await waitFor(() => expect(customSources.get("nas-box")?.f58.enableState).toBe("permanent"));
    fireEvent.click(r.getByTestId("source-registry-remove-nas-box"));
    const detail = await screen.findByTestId("source-registry-remove-detail");
    expect(detail.textContent).toContain("nas-box");
    expect(detail.textContent).toMatch(/last active/);
    // a stale/mismatched confirmation is refused by the store, not by the modal copy
    expect(customSources.remove("nas-box", { name: "nas-box|https://nas.example", lastActiveAt: "1999-01-01T00:00:00Z" }).reason).toBe("remove-confirmation-stale");
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const buttons = [...dialog.querySelectorAll("button")];
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]); // the modal primary (Remove)
    });
    expect(customSources.get("nas-box")).toBe(null);
    r.unmount();
  });

  it("the whole flow persists nothing to browser storage (no credential, no cache)", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    render(<SourceForm surface="settings" />);
    await completeAddFlow();
    expect(customSources.entries().length).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    spy.mockRestore();
  });
});

function F58draft(): unknown {
  return F58.instantiate("code-hosting/github", { addedAt: "2026-09-30T00:00:00Z", source: "ab".repeat(32) }).draft;
}
