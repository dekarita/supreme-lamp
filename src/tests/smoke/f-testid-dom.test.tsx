// [F-TESTID / Observatory step 1] The static gate (tests/f-testid-coverage.test.js)
// proves the SOURCE carries data-testid. That is necessary but not sufficient: a
// component may accept the prop and never put it on the node (which is exactly
// what CopyButton/Toggle did before this step — 26 call sites that looked covered
// and rendered nothing addressable). This suite mounts the real UI and asserts the
// ATTRIBUTE EXISTS IN THE DOM for every <button>, including the derived ids
// (tab-<id>, field-reveal-<id>, files-tree-<id>, search-filter-*-<x>).
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";

import Overview from "@/pages/Overview";
import Settings from "@/pages/Settings";
import Connections from "@/pages/Connections";
import Health from "@/pages/Health";
import Sessions from "@/pages/Sessions";
import Mirror from "@/pages/Mirror";
import FileExplorer from "@/pages/FileExplorer";
import { Modal } from "@/components/primitives/Feedback";
import { Tabs } from "@/components/primitives/Collapse";
import { CopyButton, CopyLink } from "@/components/primitives/Copy";
import { Toggle } from "@/components/primitives/Chip";
import { MaskedField } from "@/components/primitives/Data";

// Every <button> in the mounted subtree must be addressable, with a NON-EMPTY id
// (data-testid="" would satisfy a "has the attribute" check and still be useless
// to page.getByTestId()).
function assertAllButtonsAddressable(container: HTMLElement, where: string) {
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(buttons.length, where + ": nothing rendered, the assertion is vacuous").toBeGreaterThan(0);
  const unaddressable = buttons
    .filter((b) => !(b.getAttribute("data-testid") || "").trim())
    .map((b) => (b.getAttribute("id") || b.textContent || "").trim().slice(0, 60) || b.tagName);
  expect(unaddressable, where + ": buttons rendered without a usable data-testid").toEqual([]);
  const ids = buttons.map((b) => (b.getAttribute("data-testid") || "").trim());
  // no undefined/stringified-object leakage
  expect(ids.filter((v) => /undefined|\[object/.test(v)), where + ": derived test id rendered undefined").toEqual([]);
  return { buttons, ids: ids.filter(Boolean) };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("F-TESTID dom: the dashboard renders every button addressable", () => {
  it("Overview (12 composed domain cards: PrimaryActions, Keys, WebDesktop, Connection, Mirror, Log, Diagnostics, Telescope, Beacon, Install, ManualVerify, DiagBundle)", () => {
    const { container } = render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );
    const { ids } = assertAllButtonsAddressable(container, "Overview");
    // the three primary launch actions and the copy-cluster that #163 §2.1
    // listed as untest-id'd must be present, not merely non-empty in aggregate
    for (const id of ["overview-auto-login", "overview-web-desktop", "overview-fix-reconnect", "keys-open-terminal", "overview-log-pause", "overview-download-diag", "mirror-upload-now", "mirror-diagnose", "telemetry-run-diag", "telemetry-run-check"]) {
      expect(ids, `Overview must render ${id}`).toContain(id);
    }
    // every copy affordance in KeysCard renders through the primitive; if the
    // prop were absorbed, this count would be 0.
    expect(ids.filter((v) => v.startsWith("keys-copy-")).length, "KeysCard copy buttons must be addressable").toBeGreaterThanOrEqual(9);
    // drawer rows / masked fields derive ids from data the store only has at
    // runtime, so the derivations are proven on the primitives below instead.
  });

  it("Settings / Connections / Mirror / Sessions render every button addressable; Health renders none at all", () => {
    const settings = render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    const { ids } = assertAllButtonsAddressable(settings.container, "Settings");
    // the scale buttons are a derived family: all three must materialise, in the
    // DOM, from a .map() - the static gate only proves the expression exists.
    expect(["settings-text-scale-comfort", "settings-text-scale-large", "settings-text-scale-a11y"].filter((v) => ids.includes(v))).toHaveLength(3);
    expect(ids).toContain("settings-language-toggle"); // Toggle forwards, it does not absorb
    expect(ids).toContain("settings-theme-dark");
    expect(ids).toContain("settings-theme-light");

    for (const [Page, name] of [[Connections, "Connections"], [Mirror, "Mirror"], [Sessions, "Sessions"]] as const) {
      const { container } = render(
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      );
      assertAllButtonsAddressable(container, name);
    }

    // #163 §2.9: Health is display-only ("No buttons, no forms"). Pinned so that a
    // future button on /health is a deliberate, named act: the static gate would
    // pass an unnamed one only if the id were missing, and F104 would capture it
    // anonymously forever.
    const health = render(
      <MemoryRouter>
        <Health />
      </MemoryRouter>
    );
    // Health has three branches - "Probing…" (!d), health-error, health-page - and
    // every one of them must stay anonymous-button-free, so whatever is on screen,
    // zero unaddressable <button> is the invariant (any button a later step adds
    // must then be named, which the static gate also enforces).
    expect(health.container.textContent, "Health must render one of its three branches").toMatch(/Probing|Self-test unreachable|overall/i);
    expect(health.container.querySelectorAll("button").length, "Health must stay button-free or register its ids").toBe(0);
  });

  it("File Explorer derives one id per tree node (files-tree-<id>)", () => {
    const { container } = render(
      <MemoryRouter>
        <FileExplorer />
      </MemoryRouter>
    );
    const { ids } = assertAllButtonsAddressable(container, "FileExplorer");
    const tree = ids.filter((v) => v.startsWith("files-tree-"));
    expect(tree.length, "ExplorerTree nodes must be individually addressable").toBeGreaterThan(0);
    expect(new Set(tree).size, "tree ids must be unique per node").toBe(tree.length);
  });
});

describe("F-TESTID dom: primitives forward what the call site passes", () => {
  it("Modal names close/secondary/primary (F102 preSteps used to click these by text)", () => {
    // Modal is a portal (createPortal -> document.body), so the RTL container is
    // empty by design: query the real mount root.
    render(<Modal open title="t" description="d" onClose={() => {}} primary={{ label: "go", onClick: () => {} }} secondary={{ label: "no", onClick: () => {} }} />);
    const { ids } = assertAllButtonsAddressable(document.body, "Modal");
    expect(ids).toEqual(expect.arrayContaining(["modal-close", "modal-secondary", "modal-primary"]));
  });

  it("Tabs derive tab-<id>, which is what gives Telemetry tab-logon/-schannel/-launcher for F106", () => {
    const { container } = render(
      <Tabs
        label="l"
        tabs={[
          { id: "logon", label: "A", content: <div>a</div> },
          { id: "schannel", label: "B", content: <div>b</div> },
          { id: "launcher", label: "C", content: <div>c</div> },
        ]}
      />
    );
    const { ids } = assertAllButtonsAddressable(container, "Tabs");
    expect(ids).toEqual(["tab-logon", "tab-schannel", "tab-launcher"]);
  });

  it("CopyButton / CopyLink / Toggle put the caller's id on the DOM node", () => {
    const { container } = render(
      <div>
        <CopyButton value="v" data-testid="probe-copy-button" />
        <Toggle checked={false} onChange={() => {}} label="l" data-testid="probe-toggle" />
      </div>
    );
    assertAllButtonsAddressable(container, "primitives");
    expect(container.querySelector('[data-testid="probe-copy-button"]')?.tagName).toBe("BUTTON");
    expect(container.querySelector('[data-testid="probe-toggle"]')?.getAttribute("role")).toBe("switch");
    const link = render(<CopyLink value="v" data-testid="probe-copy-link" />);
    expect(link.container.querySelector('[data-testid="probe-copy-link"]')?.tagName).toBe("A");
  });

  it("MaskedField derives field-reveal-<id> / field-copy-<id> from the field id", () => {
    const { container } = render(<MaskedField id="credWinPass" value="secret" mask="•••4" labelKey="keys.windowsPassword" />);
    const { ids } = assertAllButtonsAddressable(container, "MaskedField");
    expect(ids).toEqual(expect.arrayContaining(["field-reveal-credWinPass", "field-copy-credWinPass"]));
  });
});
