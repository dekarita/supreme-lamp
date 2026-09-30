// [F58 §4] Vitest: presets + PROVENANCE-6 + the redirect fence + the card row.
//  * the four add-time presets and their PINNED per-host allowlists
//    (github.com + the *.githubusercontent.com expansion + objects.githubusercontent.com);
//  * requireAllowlisted=true on every preset, and cross-domain follow blocked;
//  * PROVENANCE-6: all six present = Fetch enabled, any missing = Fetch disabled
//    with the exact field list, unverified/unsigned = Fetch disabled;
//  * the provenance row rendered ABOVE the Fetch button on a custom-source card,
//    with the button itself disabled (external roster rows stay untouched).
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { useSearchStore, DEFAULT_MAX_SIZE_BYTES } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { useToastStore } from "@/stores/toastStore";
import F58 from "@/search/custom-source-core";
import { customSources, evaluateResultProvenance, type SourceExtension } from "@/search/custom-source-store";
import { applyPreset, isAllowlistPinned, listPresets, PRESET_IDS } from "@/search/source-presets";

type Any = any;

const EXT: SourceExtension = { addedAt: "2026-09-30T00:00:00Z", source: "ab".repeat(32), enableState: "permanent" };
const FULL6 = {
  fileName: "acme-tool.exe",
  byteSize: 4823400,
  publisher: "Acme Corp",
  sha256: "a".repeat(64),
  signatureStatus: "verified",
  releasePageUrl: "https://github.com/acme/tool/releases/tag/v2.1.0",
};
const LABELS: Record<string, string> = {
  fileName: "filename",
  byteSize: "byte size",
  publisher: "publisher",
  sha256: "sha256",
  signatureStatus: "signature status",
  releasePageUrl: "release-page URL",
};

function githubDescriptor(): any {
  return F58.instantiate("code-hosting/github", { addedAt: EXT.addedAt, source: EXT.source }).draft as Any;
}

beforeEach(() => {
  customSources.reset();
});

describe("f58 presets", () => {
  it("ships exactly the four code-hosting presets, each schema-valid", () => {
    expect(PRESET_IDS).toEqual(["code-hosting/github", "code-hosting/gitlab", "code-hosting/bitbucket", "code-hosting/sourceforge"]);
    expect(listPresets().length).toBe(4);
    for (const id of PRESET_IDS) {
      const applied = applyPreset(id, { operatorId: "op-1" });
      expect(applied.ok, id + ": " + applied.errors.join("; ")).toBe(true);
      expect(applied.summary?.requireAllowlisted).toBe(true);
      expect(applied.extension?.source).toMatch(/^[a-f0-9]{64}$/);
      expect(applied.extension?.enableState).toBe("permanent");
      expect(isAllowlistPinned(id)).toBe(true);
    }
    expect(applyPreset("code-hosting/not-a-preset", {}).ok).toBe(false);
  });

  it("the GitHub preset applies the pinned allowlist, wildcard expanded", () => {
    const applied = applyPreset("code-hosting/github", { operatorId: "op-1" });
    const list = applied.summary?.allowedDomains || [];
    expect(list).toContain("github.com");
    expect(list).toContain("api.github.com");
    expect(list).toContain("objects.githubusercontent.com");
    expect(list).toContain("raw.githubusercontent.com");
    expect(list.filter((d) => d.endsWith(".githubusercontent.com")).length).toBeGreaterThanOrEqual(2);
    expect(list.some((d) => d.includes("*"))).toBe(false); // the freeze rejects wildcards
    expect(new Set(list).size).toBe(list.length);
    // deterministic: instantiating twice returns the same pinned list
    expect(applyPreset("code-hosting/github", { operatorId: "op-1" }).summary?.allowedDomains).toEqual(list);
  });

  it("every preset carries the hard rate limits and the allowlisted redirect policy", () => {
    for (const id of PRESET_IDS) {
      const d = F58.instantiate(id, { addedAt: EXT.addedAt, source: EXT.source }).draft as Any;
      expect(d.rateLimit.concurrency, id).toBe(1);
      expect(d.rateLimit.requestsPerMinute, id).toBe(60);
      expect(d.timeout.request, id).toBe(30);
      expect(d.timeout.connect, id).toBeLessThanOrEqual(10);
      expect(d.redirectPolicy.requireAllowlisted, id).toBe(true);
      expect(d.redirectPolicy.requireHttps, id).toBe(true);
      expect(d.downloadContract.contentLengthRequired, id).toBe(true);
      expect(d.robotsCheck.onDisallow, id).toBe("deny");
      expect(String(d.baseUrl).startsWith("https://"), id).toBe(true);
    }
  });

  it("cross-domain follow is blocked (off-allowlist fixture, http, IP literal, suffix spoof)", () => {
    const d = githubDescriptor();
    expect(F58.redirectAllowed(d, "https://objects.githubusercontent.com/releases/tool.exe").ok).toBe(true);
    expect(F58.redirectAllowed(d, "https://github.com/a/tool.zip").ok).toBe(true);
    const off = F58.redirectAllowed(d, "https://mirror-of-github.test/tool.exe");
    expect(off.ok).toBe(false);
    expect(off.reason).toBe("redirect-off-allowlist: mirror-of-github.test");
    expect(F58.redirectAllowed(d, "http://github.com/tool.exe").reason).toContain("redirect-not-https");
    expect(F58.redirectAllowed(d, "https://100.64.9.9/tool.exe").reason).toContain("redirect-target-ip-literal");
    expect(F58.redirectAllowed(d, "https://github.com.evil.test/tool.exe").reason).toContain("redirect-off-allowlist");
    expect(F58.redirectAllowed(d, "").reason).toBe("redirect-target-missing");
  });

  it("a greedy source is clamped to the hard limits on the way into the store", () => {
    const greedy = { ...githubDescriptor(), rateLimit: { requestsPerMinute: 100000, burst: 50, concurrency: 16, retryAfter: "ignore", backoff: "none" }, timeout: { connect: 900, request: 3600 } };
    const created = customSources.create(greedy as Any, EXT);
    expect(created.ok).toBe(true);
    const entry = customSources.get("code-hosting-github");
    expect(entry?.descriptor.rateLimit.concurrency).toBe(1);
    expect(entry?.descriptor.rateLimit.requestsPerMinute).toBe(60);
    expect(entry?.descriptor.timeout.request).toBe(30);
    expect(entry?.probeError).toContain("rate-limit-clamped");
  });
});

describe("f58 PROVENANCE-6", () => {
  it("all six present + a verifiable signature = Fetch enabled", () => {
    const v = F58.evaluateProvenance("acme-tool.exe", FULL6);
    expect(v.applies).toBe(true);
    expect(v.fetchEnabled).toBe(true);
    expect(v.reason).toBe(null);
  });

  for (const field of F58.PROVENANCE_FIELDS) {
    it("missing " + field + " = Fetch DISABLED naming it", () => {
      const rec = { ...FULL6 } as Any;
      delete rec[field];
      const v = F58.evaluateProvenance("acme-tool.exe", rec);
      expect(v.fetchEnabled).toBe(false);
      expect(v.missing).toEqual([field]);
      expect(v.reason).toBe("provenance-incomplete: " + LABELS[field]);
    });
  }

  it("an empty value counts as missing, and every executable extension is covered", () => {
    const v = F58.evaluateProvenance("Setup.MSI", { ...FULL6, publisher: "  ", signatureStatus: "" });
    expect(v.missing).toEqual(["publisher", "signatureStatus"]);
    expect(v.reason).toContain("provenance-incomplete:");
    for (const ext of F58.EXEC_EXTENSIONS) {
      expect(F58.evaluateProvenance("payload" + ext, {}).fetchEnabled).toBe(false);
    }
    expect(F58.isExecutableName("notes.txt")).toBe(false);
    expect(F58.evaluateProvenance("novel.epub", {}).applies).toBe(false);
  });

  it("unsigned / unverified = Fetch DISABLED with signature-unverifiable", () => {
    for (const sig of ["unsigned", "unverified"]) {
      const v = F58.evaluateProvenance("acme-tool.exe", { ...FULL6, signatureStatus: sig });
      expect(v.fetchEnabled).toBe(false);
      expect(v.missing).toEqual([]);
      expect(v.reason).toBe("signature-unverifiable: " + sig);
    }
    const unknown = F58.evaluateProvenance("disk.iso", { ...FULL6, fileName: "disk.iso", signatureStatus: "maybe-signed" });
    expect(unknown.fetchEnabled).toBe(false);
    expect(unknown.reason).toContain("signature-unverifiable");
  });

  it("a disabled fetch is stamped on the source status row (canonical surface)", () => {
    customSources.create(githubDescriptor(), EXT);
    const v = customSources.provenanceFor("code-hosting-github", "tool.zip", { ...FULL6, sha256: "" });
    expect(v.fetchEnabled).toBe(false);
    expect(v.reason).toContain("provenance-incomplete: sha256");
    expect(customSources.get("code-hosting-github")?.status.fetchDisabledReason).toBe(v.reason);
    const fixed = customSources.provenanceFor("code-hosting-github", "tool.zip", FULL6);
    expect(fixed.fetchEnabled).toBe(true);
    expect(customSources.get("code-hosting-github")?.status.fetchDisabledReason).toBe(null);
  });
});

describe("f58 provenance row on the result card", () => {
  const RESULT = {
    resultId: "r1",
    adapterId: "code-hosting-github",
    nameKey: "search.registry.preset.github",
    category: "software",
    title: "acme-tool.exe",
    creator: "Acme Corp",
    sizeBytes: 4823400,
    licenceTag: "open-access",
    sourceSnapshotId: "snap-1",
    sourceUrl: "https://github.com/acme/tool/releases/download/v2.1.0/acme-tool.exe",
  };

  function mountResults() {
    useSearchStore.setState({ phase: "complete", results: { r1: RESULT }, resultOrder: ["r1"], adapters: {}, categories: [], licenceTags: [], maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, sort: "relevance", fetches: {} } as Any);
    useSearchUiStore.setState({ view: "results", animating: false } as Any);
    return render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    );
  }

  it("an external-roster row keeps the card exactly as F56-c shipped it", () => {
    const r = mountResults();
    // the adapter is NOT in the custom registry: no provenance row, no refusal
    expect(r.container.querySelector('[data-testid="card-provenance"]')).toBe(null);
    const fetch = screen.getByTestId("card-fetch") as HTMLButtonElement;
    expect(fetch.disabled).toBe(false);
    expect(evaluateResultProvenance(customSources, RESULT as Any).custom).toBe(false);
    r.unmount();
  });

  it("a custom-source row renders the provenance row above a DISABLED Fetch", async () => {
    customSources.create(githubDescriptor(), EXT);
    const r = mountResults();
    const row = await waitFor(() => screen.getByTestId("card-provenance"));
    expect(row.textContent).toContain("Fetch disabled");
    expect(row.textContent).toContain("provenance-incomplete:");
    expect(row.getAttribute("data-fetch-enabled")).toBe("false");
    const fetch = screen.getByTestId("card-fetch") as HTMLButtonElement;
    expect(fetch.disabled).toBe(true);
    expect(fetch.title).toContain("provenance-incomplete:");
    const actions = r.container.querySelector('[id^="f56.search.resultActions."]') as HTMLElement;
    expect(actions).not.toBe(null);
    // the provenance row precedes the action row (i.e. it sits ABOVE Fetch)
    expect((row.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    // even a synthetic click on the disabled control records NOTHING (the handler
    // is guarded, not just the button state): no fetch row, no toast.
    fireEvent.click(fetch);
    expect(Object.keys(useSearchStore.getState().fetches).length).toBe(0);
    expect(useToastStore.getState().toasts.length).toBe(0);
    r.unmount();
  });

  it("complete provenance enables the Fetch button again", async () => {
    customSources.create(githubDescriptor(), EXT);
    customSources.recordProvenance("r1", FULL6);
    const r = mountResults();
    const row = await waitFor(() => screen.getByTestId("card-provenance"));
    expect(row.textContent).toBe("provenance complete");
    expect((screen.getByTestId("card-fetch") as HTMLButtonElement).disabled).toBe(false);
    r.unmount();
  });
});
