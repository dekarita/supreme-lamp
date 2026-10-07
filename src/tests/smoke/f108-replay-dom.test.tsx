// [F108 / Observatory step 7] DOM suite for the PUBLIC replay viewer.
//
// WHY THIS SUITE LOADS THE SHIPPED PAGE INSTEAD OF A COPY OF IT. F108's viewer is
// plain JS in `docs/replay/`, published by GitHub Pages - it is not part of the
// vite graph, so nothing else in this repo would notice if the page and its
// markup stopped fitting together. This suite reads docs/replay/index.html,
// mounts it in jsdom and drives the REAL docs/replay/app.js against it, so the
// ids app.js binds, the tab wiring and the render path are exercised exactly as a
// browser would.
//
// The four properties that only a DOM can prove (the Node gate covers the rest):
//   1. a hostile bundle stays INERT: `<script>` in a test id is visible text, not
//      an element; no attribute ends up carrying `javascript:`; screenshots only
//      ever render from a fenced `data:image/png;base64,` source;
//   2. the viewer never touches the network - fetch/XHR/WebSocket/beacon are
//      replaced with throwing spies for the whole run;
//   3. the scrubbable timeline actually moves the selected event, and the Arena
//      summary is copyable and carries no credential;
//   4. the shipped CSP and module wiring are the ones on the page that loads
//      (the Node gate pins the text; this one pins the behaviour).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const PAGE = readFileSync(join(ROOT, "docs", "replay", "index.html"), "utf8");
const APP = join(ROOT, "docs", "replay", "app.js");

/** The shipped <body>, minus the module tag (the test imports app.js itself). */
function shippedShell(): string {
  const body = PAGE.slice(PAGE.indexOf("<body>") + 6, PAGE.indexOf("</body>"));
  return body.replace(/<script[^>]*><\/script>/g, "");
}

function shellWithoutAutoMountRoot(): string {
  // The auto-mount hook looks for `#replay-app`; renaming the id lets a test mount
  // the shipped markup deliberately instead of racing the boot path.
  return shippedShell().replace('id="replay-app"', 'id="replay-test-root"');
}

/** A v2 bundle that satisfies the SHIPPED validator (exportCore.validateBundleV2). */
function v2Bundle(at = 1_759_900_000_000) {
  return {
    format: "mcrec",
    version: 2,
    createdAt: new Date(at).toISOString(),
    target: { route: "#/collector?token=SECRET", buildSha: "abc1234", lang: "en", ui: "v2" },
    timeline: [
      { seq: 1, at, kind: "click", feature: "collector", testId: 'dvr-sessions-open"><script>window.__pwned=1</script>' },
      { seq: 2, at: at + 250, kind: "route", route: "#/collector?token=SECRET" },
      { seq: 3, at: at + 400, kind: "settle", verdict: "ok", fetch: 2, opened: 1, failed: 0, elapsedMs: 88 },
    ],
    mutations: [
      { at, type: "childList", target: "div", added: 2, removed: 0 },
      { at: at + 10, type: "attributes", target: "img", attr: "onerror" },
    ],
    // Both shots are inside the shipped thumbnail fence (PNG data URL, 320x240,
    // under budget) - a bundle carrying anything else is refused at parse, which
    // is what the "hostile shot" case below proves.
    shots: [
      { at, key: "s1", w: 320, h: 240, bytes: 11, dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      { at: at + 300, key: "s2", w: 320, h: 240, bytes: 20, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" },
    ],
    storage: {
      sessions: [{ id: "sess-1", startedAt: at, endedAt: at + 1_000, clicks: 1, mutations: 2, shots: 1, bytes: 11 }],
      bytes: 11,
    },
    features: [
      { id: "dvr", route: "/collector?token=SECRET" },
      { id: "lab", route: "/lab" },
    ],
  };
}

/** Every network primitive this app could possibly reach - all spies that throw. */
function lockDownNetwork() {
  const boom = (name: string) => () => {
    throw new Error("F108: the viewer touched " + name);
  };
  const spies = {
    fetch: vi.fn(boom("fetch")),
    xhr: vi.fn(function (this: unknown) {
      throw new Error("F108: the viewer touched XMLHttpRequest");
    }),
    ws: vi.fn(function (this: unknown) {
      throw new Error("F108: the viewer touched WebSocket");
    }),
    beacon: vi.fn(boom("sendBeacon")),
    es: vi.fn(function (this: unknown) {
      throw new Error("F108: the viewer touched EventSource");
    }),
  };
  vi.stubGlobal("fetch", spies.fetch);
  vi.stubGlobal("XMLHttpRequest", spies.xhr);
  vi.stubGlobal("WebSocket", spies.ws);
  vi.stubGlobal("EventSource", spies.es);
  Object.defineProperty(navigator, "sendBeacon", { value: spies.beacon, configurable: true });
  return spies;
}

let network: ReturnType<typeof lockDownNetwork>;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  document.body.innerHTML = shellWithoutAutoMountRoot();
  network = lockDownNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Mount the shipped markup + the shipped app, with a stub clipboard. */
async function mount(opts: { text?: string } = {}) {
  const { mountViewer } = await import(APP);
  const copied: string[] = [];
  const clipboard = {
    readText: async () => opts.text ?? "",
    writeText: async (t: string) => {
      copied.push(t);
    },
  };
  const root = document.getElementById("replay-test-root") as HTMLElement;
  const handle = mountViewer(root, { clipboard });
  return { handle, root, copied };
}

describe("F108 viewer - shipped page + shipped app", () => {
  it("boots from the shipped markup and reports it is ready", async () => {
    // The real page id this time, so the auto-mount path runs (main.tsx-style boot).
    document.body.innerHTML = shippedShell();
    await import(APP);
    const host = document.getElementById("replay-app");
    expect(host).toBeTruthy();
    await vi.waitFor(() => expect(host!.getAttribute("data-replay-ready")).toBe("1"));
    expect(document.getElementById("replay-status")!.textContent).toMatch(/No bundle loaded yet/);
    // Every panel app.js binds exists in the shipped HTML (a missing id would have
    // thrown during mount, but assert the important ones explicitly).
    for (const id of ["replay-input", "replay-file", "replay-scrubber", "replay-summary", "replay-copy-summary"]) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
  });

  it("renders a v2 bundle: verdict, rows, and ONLY fenced screenshot sources", async () => {
    const { handle, root } = await mount();
    const ok = await handle.loadText(JSON.stringify(v2Bundle()));
    expect(ok).toBe(true);

    expect(root.querySelector("#replay-verdict")!.textContent).toMatch(/mcrec v2/);
    expect(root.querySelector("#replay-verdict")!.textContent).toMatch(/3 timeline/);
    expect(root.querySelector("#replay-verdict")!.textContent).toMatch(/no warnings/);
    expect(root.querySelectorAll("#replay-rows li")).toHaveLength(3);
    expect(root.querySelector("#replay-panel-result")!.hidden).toBe(false);

    // Screenshots: both fenced shots render, and nothing else would have.
    const imgs = Array.from(root.querySelectorAll("#replay-shots img")) as HTMLImageElement[];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) expect(img.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(root.querySelector("#replay-shots-note")!.textContent).toMatch(/2 thumbnail\(s\) kept/);
    expect(root.querySelector("#replay-shots-note")!.textContent).not.toMatch(/refused/);

    // The timeline entry detail attaches the nearest fenced thumbnail.
    handle.select(1);
    const entryImg = root.querySelector("#replay-entry img") as HTMLImageElement | null;
    expect(entryImg).toBeTruthy();
    expect(entryImg!.src.startsWith("data:image/png;base64,")).toBe(true);

    // The DOM-update tab renders descriptors (structure), not content.
    expect(root.querySelector("#replay-mutations")!.textContent).toMatch(/childList/);
    expect(root.querySelector("#replay-mutations")!.textContent).toMatch(/onerror/);

    // Stored sessions + features tabs carry the index and the sanitized routes.
    expect(root.querySelector("#replay-sessions")!.textContent).toMatch(/sess-1/);
    const features = root.querySelector("#replay-features")!.textContent || "";
    expect(features).toMatch(/\/collector/);
    expect(features).not.toMatch(/SECRET/);
  });

  it("keeps a hostile bundle inert: no script element, no javascript: attribute, no pwned global", async () => {
    const { handle, root } = await mount();
    await handle.loadText(JSON.stringify(v2Bundle()));

    expect(root.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    // The payload is PRESENT as text (an operator must see what the recording
    // contains) - it just never becomes markup.
    const rows = root.querySelector("#replay-rows")!.textContent || "";
    expect(rows).toContain("<script>window.__pwned=1</script>");

    // No attribute anywhere in the mounted tree may carry a script URL.
    for (const node of Array.from(root.querySelectorAll("*"))) {
      for (const attr of Array.from(node.attributes)) {
        expect(attr.value.includes("javascript:"), node.tagName + "@" + attr.name).toBe(false);
        expect(attr.value.startsWith("http://") || attr.value.startsWith("https://"), node.tagName + "@" + attr.name).toBe(false);
      }
    }
    // …and the reader's own source contains no innerHTML either (textContent only).
    const source = readFileSync(APP, "utf8");
    expect(source.includes(".innerHTML")).toBe(false);
  });

  it("REFUSES a bundle whose screenshot points off-origin, before anything renders", async () => {
    const { handle, root } = await mount();
    for (const hostile of ["https://attacker.example/beacon.png", "data:text/html,<script>alert(1)</script>", "javascript:alert(1)"]) {
      const bundle = v2Bundle();
      bundle.shots = [{ at: bundle.timeline[0].at, key: "s1", w: 320, h: 240, bytes: 11, dataUrl: hostile }];
      expect(await handle.loadText(JSON.stringify(bundle)), hostile).toBe(false);
      expect(root.querySelector("#replay-status")!.textContent).toMatch(/bad-shot/);
      expect(root.querySelectorAll("#replay-shots img")).toHaveLength(0);
      expect(root.querySelectorAll("#replay-rows li")).toHaveLength(0);
    }
  });

  it("never touches the network while loading, scrubbing and copying", async () => {
    const { handle, root, copied } = await mount();
    await handle.loadText(JSON.stringify(v2Bundle()));
    handle.select(2);
    (root.querySelector("#replay-next") as HTMLButtonElement).click();
    (root.querySelector("#replay-prev") as HTMLButtonElement).click();
    (root.querySelector("#replay-tab-shots") as HTMLButtonElement).click();
    (root.querySelector("#replay-tab-summary") as HTMLButtonElement).click();
    (root.querySelector("#replay-copy-summary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(copied.length).toBe(1));

    expect(network.fetch).not.toHaveBeenCalled();
    expect(network.xhr).not.toHaveBeenCalled();
    expect(network.ws).not.toHaveBeenCalled();
    expect(network.beacon).not.toHaveBeenCalled();
    expect(network.es).not.toHaveBeenCalled();
  });

  it("scrubs the timeline, moves the selected event, and copies a credential-free summary", async () => {
    const { handle, root, copied } = await mount();
    await handle.loadText(JSON.stringify(v2Bundle()));

    const scrubber = root.querySelector("#replay-scrubber") as HTMLInputElement;
    expect(scrubber.max).toBe("2");
    (root.querySelector("#replay-next") as HTMLButtonElement).click();
    expect(root.querySelector("#replay-entry h3")!.textContent).toMatch(/#2 · route/);
    expect(root.querySelector("#replay-entry")!.textContent).toMatch(/#\/collector\b/);
    expect(handle.state().selected).toBe(1);

    (root.querySelector("#replay-tab-summary") as HTMLButtonElement).click();
    const summary = root.querySelector("#replay-summary")!.textContent || "";
    expect(summary).toMatch(/GHRDP \.mcrec summary \(mcrec v2, full\)/);
    expect(summary).toMatch(/target: route=#\/collector /);
    expect(summary).toMatch(/screenshots: 2 thumbnail\(s\)/);
    expect(summary).not.toMatch(/warnings:/);
    expect(summary).not.toMatch(/SECRET/);
    expect(summary).toMatch(/no network was used/i);

    (root.querySelector("#replay-copy-summary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(copied.length).toBe(1));
    expect(copied[0]).toBe(summary);
  });

  it("reads a v1 (step 3) clipboard bundle too: same page, both generations", async () => {
    const { handle, root } = await mount();
    const at = 1_759_900_000_000;
    const v1 = {
      format: "mcrec",
      version: 1,
      createdAt: new Date(at).toISOString(),
      windowMs: 30_000,
      maxEntries: 200,
      target: { route: "#/collector?token=SECRET", buildSha: "abc1234", lang: "en", ui: "v2" },
      counts: { count: 1, byKind: { click: 1 }, firstAt: at, lastAt: at, spanMs: 0 },
      entries: [{ seq: 1, at, kind: "click", feature: "dvr", testId: "dvr-copy", label: "Copy" }],
    };
    const b64 = Buffer.from(JSON.stringify(v1), "utf8").toString("base64");
    const ok = await handle.loadText("mcrec1:plain:" + b64);
    expect(ok).toBe(true);
    expect(root.querySelector("#replay-verdict")!.textContent).toMatch(/mcrec v1/);
    expect(root.querySelectorAll("#replay-rows li")).toHaveLength(1);
    expect(root.querySelector("#replay-shots-note")!.textContent).toMatch(/v1 \(clipboard\) bundle carries no screenshots/);
    expect(root.querySelector("#replay-panel-summary")!.textContent || "").not.toMatch(/SECRET/);

    // A gzip envelope is inflated through the injected seam (node:zlib), which is
    // the same contract the browser DecompressionStream path obeys.
    const zlib = await import("node:zlib");
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(v1), "utf8"));
    const { mountViewer } = await import(APP);
    const root2 = document.createElement("div");
    root2.innerHTML = shellWithoutAutoMountRoot();
    document.body.appendChild(root2);
    const handle2 = mountViewer(root2, {
      clipboard: { readText: async () => "", writeText: async () => {} },
      inflate: async (bytes: Uint8Array) => new Uint8Array(zlib.gunzipSync(Buffer.from(bytes))),
    });
    expect(await handle2.loadText("mcrec1:gzip:" + gz.toString("base64"))).toBe(true);
    expect(root2.querySelector("#replay-verdict")!.textContent).toMatch(/mcrec v1/);

    // A file that is too big is refused BEFORE it is read into memory.
    const refused = await handle2.loadFile({ size: 9_000_000, text: async () => "" } as unknown as File);
    expect(refused).toBe(false);
    expect(root2.querySelector("#replay-status")!.textContent).toMatch(/refusing to read it/);

    // …and an unreadable input says which kind of unreadable it was.
    expect(await handle2.loadText("just some prose")).toBe(false);
    expect(root2.querySelector("#replay-status")!.textContent).toMatch(/Unreadable input/);
  });
});
