// [F104 §3] Global click capture - runtime proof against the real installer.
//
// F100/F101/F102 record only hand-wired buttons. These tests drive
// installGlobalClickCapture() against real DOM elements + stubbed transport
// and assert: every real click is described (testid/label/text/tag/route),
// the collector's own UI is invisible (the F102 feedback guard), dedupe +
// trust behave, fetch/window.open are observed per 10 s window with timing,
// and the wrappers restore without disturbing an outer (F101) layer.
// jsdom cannot mint a trusted event, so trustCheck:false stands in for the
// browser's real clicks everywhere except the trust test itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GLOBAL_CLICK_DEDUP_MS,
  GLOBAL_CLICK_MAX_EXCHANGES,
  GLOBAL_CLICK_SOURCE,
  GLOBAL_CLICK_WINDOW_MS,
  __resetGlobalClickCaptureForTests,
  describeClick,
  describePath,
  installGlobalClickCapture,
  type GlobalClickRecorder,
  type ObservedExchange,
} from "@/lib/globalClickCapture";
import type { ButtonAction } from "@/lib/collectorAgent";

interface StubRecorder extends GlobalClickRecorder {
  rows: ButtonAction[];
}

function stubRecorder(): StubRecorder {
  const rows: ButtonAction[] = [];
  let seq = 0;
  return {
    rows,
    record: (rec) => {
      const row: ButtonAction = { id: "g" + ++seq, ts: new Date().toISOString(), ...rec };
      rows.push(row);
      return row;
    },
    update: (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
  };
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function button(html: string): HTMLButtonElement {
  document.body.innerHTML = html;
  return document.body.querySelector("button") as HTMLButtonElement;
}

const realFetch = window.fetch;
const realOpen = window.open;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  window.location.hash = "";
});

afterEach(() => {
  try {
    if (uninstall) uninstall();
  } catch {
    /* ignore */
  }
  uninstall = null;
  __resetGlobalClickCaptureForTests();
  window.fetch = realFetch;
  window.open = realOpen;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function paramsOf(row: ButtonAction): Record<string, string> {
  return (row.params || {}) as Record<string, string>;
}

function resultOf(row: ButtonAction): { capturing?: boolean; fetch?: ObservedExchange[]; opened?: ObservedExchange[] } {
  return (row.result || {}) as { capturing?: boolean; fetch?: ObservedExchange[]; opened?: ObservedExchange[] };
}

describe("F104 descriptor: what the click hit", () => {
  it("records testId/label/text/tag/route/path + the source tag", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    window.location.hash = "#/search";
    const el = button('<button data-testid="add-site-button" aria-label="Add site">Add site</button>');
    click(el);
    expect(rec.rows).toHaveLength(1);
    const row = rec.rows[0];
    expect(row.source).toBe(GLOBAL_CLICK_SOURCE);
    expect(row.feature).toBe("global");
    expect(row.action).toBe("click:add-site-button");
    expect(paramsOf(row)).toMatchObject({ testId: "add-site-button", label: "Add site", text: "Add site", tag: "button", route: "#/search" });
    expect(paramsOf(row).path).toContain("button");
    expect(resultOf(row).capturing).toBe(true);
  });

  it("matches a[role=button] and input[type=submit]", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    // [WP-13 / MC-P8] the `value` attribute is NEVER read as a label: React 18
    // reflects a controlled input's typed value into it, so a password field's
    // value would otherwise become the row's label. A submit input with no
    // aria-label/title therefore records an EMPTY label — this pin is the
    // falsifier for restoring `|| g("value")` in describeClick.
    document.body.innerHTML = '<a role="button" data-testid="card-open-rdp">Open</a><input type="submit" value="Save"/>';
    click(document.body.querySelector("a") as Element);
    click(document.body.querySelector("input") as Element);
    expect(rec.rows).toHaveLength(2);
    expect(rec.rows[0].action).toBe("click:card-open-rdp");
    expect(paramsOf(rec.rows[1])).toMatchObject({ tag: "input", label: "" });
  });

  it("matches any testid'd element (cards and rows are click targets)", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    document.body.innerHTML = '<div data-testid="search-card-1"><span>inside</span></div>';
    click(document.body.querySelector("span") as Element);
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0].action).toBe("click:search-card-1");
  });

  it("names the action testId -> label -> text -> tag", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30, dedupMs: 0 });
    document.body.innerHTML =
      '<button aria-label="L">x</button><button>Words here</button><button></button>';
    const btns = Array.from(document.body.querySelectorAll("button"));
    btns.forEach(click);
    expect(rec.rows.map((r) => r.action)).toEqual(["click:L", "click:Words here", "click:button"]);
  });

  it("ignores clicks with no clickable ancestor", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    document.body.innerHTML = "<div><p>plain text</p></div>";
    click(document.body.querySelector("p") as Element);
    click(document.body);
    expect(rec.rows).toHaveLength(0);
  });
});

describe("F104 ignore list: the collector never feeds itself", () => {
  it("ignores the [data-collector-ignore] subtree", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    document.body.innerHTML = '<div data-testid="collector-page" data-collector-ignore><button data-testid="other">x</button></div>';
    click(document.body.querySelector("button") as Element);
    expect(rec.rows).toHaveLength(0);
  });

  it("ignores [data-testid^=collector-] controls", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    const el = button('<button data-testid="collector-refresh">Refresh</button>');
    click(el);
    expect(rec.rows).toHaveLength(0);
  });

  it("ignores [data-testid^=click-now-] spans (even when the hit lands on the inner button)", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    document.body.innerHTML = '<span data-testid="click-now-add-site-open"><button data-testid="collector-click-now-add-site-open">Click now</button></span>';
    click(document.body.querySelector("button") as Element);
    expect(rec.rows).toHaveLength(0);
  });

  it("ignores nav links", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    document.body.innerHTML = '<nav><a data-testid="nav-search" href="#/search">Search</a></nav>';
    click(document.body.querySelector("a") as Element);
    expect(rec.rows).toHaveLength(0);
  });

  it("ignores pager buttons", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    document.body.innerHTML = '<div class="pagination"><button data-testid="page-next">Next</button></div>';
    click(document.body.querySelector("button") as Element);
    expect(rec.rows).toHaveLength(0);
  });
});

describe("F104 trust + dedupe", () => {
  it("drops untrusted (programmatic) clicks by default, records them with trustCheck:false", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { windowMs: 30 });
    const el = button('<button data-testid="t">x</button>');
    click(el); // jsdom events are always untrusted, like el.click()
    expect(rec.rows).toHaveLength(0);
    if (uninstall) uninstall();
    __resetGlobalClickCaptureForTests();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30 });
    click(el);
    expect(rec.rows).toHaveLength(1);
  });

  it("dedupes the same control inside 500 ms", () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30, dedupMs: GLOBAL_CLICK_DEDUP_MS });
    const el = button('<button data-testid="t">x</button>');
    click(el);
    click(el);
    click(el);
    expect(rec.rows).toHaveLength(1);
  });

  it("records distinct controls, and the same control after the dedupe window", async () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 30, dedupMs: 20 });
    document.body.innerHTML = '<button data-testid="a">a</button><button data-testid="b">b</button>';
    const [a, b] = Array.from(document.body.querySelectorAll("button"));
    click(a);
    click(b);
    expect(rec.rows).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 40));
    click(a);
    expect(rec.rows).toHaveLength(3);
  });
});

describe("F104 observer: what the click did", () => {
  it("records fetch method/status/elapsed and still returns the response", async () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 60 });
    const seen: string[] = [];
    window.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { status: 200, ok: true } as Response;
    }) as typeof fetch;
    const el = button('<button data-testid="t">x</button>');
    click(el);
    const res = await window.fetch("/api/launcher/queue", { method: "POST" });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["/api/launcher/queue"]);
    await new Promise((r) => setTimeout(r, 120));
    const fetches = resultOf(rec.rows[0]).fetch || [];
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ kind: "fetch", url: "/api/launcher/queue", method: "POST", status: 200 });
    expect(typeof fetches[0].elapsedMs).toBe("number");
  });

  it("records a failed fetch with status 0 + error, and the rejection propagates", async () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 60 });
    window.fetch = (async () => {
      throw new Error("net down");
    }) as typeof fetch;
    const el = button('<button data-testid="t">x</button>');
    click(el);
    await expect(window.fetch("/api/x")).rejects.toThrow("net down");
    await new Promise((r) => setTimeout(r, 120));
    const fetches = resultOf(rec.rows[0]).fetch || [];
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ kind: "fetch", status: 0 });
    expect(fetches[0].error).toContain("net down");
  });

  it("records window.open with blocked=false and passes the handle through", async () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 60 });
    const handle = { closed: false } as unknown as WindowProxy;
    window.open = (() => handle) as typeof window.open;
    const el = button('<button data-testid="t">x</button>');
    click(el);
    expect(window.open("https://example.com/", "_blank")).toBe(handle);
    await new Promise((r) => setTimeout(r, 120));
    const opens = resultOf(rec.rows[0]).opened || [];
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ kind: "open", url: "https://example.com/", blocked: false });
  });

  it("records a blocked popup (null handle) with blocked=true", async () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 60 });
    window.open = (() => null) as unknown as typeof window.open;
    const el = button('<button data-testid="t">x</button>');
    click(el);
    expect(window.open("https://example.com/", "_blank")).toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    const opens = resultOf(rec.rows[0]).opened || [];
    expect(opens).toHaveLength(1);
    expect(opens[0].blocked).toBe(true);
  });

  it("strips query strings + fragments and caps exchange growth", async () => {
    const rec = stubRecorder();
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 60 });
    window.fetch = (async () => ({ status: 200, ok: true }) as Response) as typeof fetch;
    const el = button('<button data-testid="t">x</button>');
    click(el);
    await window.fetch("/api/x?token=secret&pw=hunter2#frag");
    for (let i = 0; i < GLOBAL_CLICK_MAX_EXCHANGES + 10; i++) {
      await window.fetch("/api/filler/" + i);
    }
    await new Promise((r) => setTimeout(r, 120));
    const fetches = resultOf(rec.rows[0]).fetch || [];
    expect(fetches[0].url).toBe("/api/x");
    expect(fetches.length).toBeLessThanOrEqual(GLOBAL_CLICK_MAX_EXCHANGES);
  });
});

describe("F104 window close + restore", () => {
  it("closes the row with counts + verdict, and restores an outer (F101) fetch layer", async () => {
    const rec = stubRecorder();
    // the F101 observer was here first: ours must wrap AND restore it exactly
    const f101 = (async () => ({ status: 200, ok: true }) as Response) as typeof fetch;
    window.fetch = f101;
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 60 });
    expect(window.fetch).toBe(f101);
    const el = button('<button data-testid="t">x</button>');
    click(el);
    expect(window.fetch).not.toBe(f101);
    await window.fetch("/api/a");
    await new Promise((r) => setTimeout(r, 120));
    expect(window.fetch).toBe(f101);
    const row = rec.rows[0];
    expect(resultOf(row).capturing).toBe(false);
    expect(row.elapsedMs).toBe(60);
    expect(row.verdict).toMatchObject({ status: "ok" });
    expect(row.verdict?.reason).toContain("1 fetch(es)");
  });

  it("uninstall removes the listener, closes pendings, and restores both wrappers", async () => {
    const rec = stubRecorder();
    const openStub = (() => null) as unknown as typeof window.open;
    window.open = openStub;
    uninstall = installGlobalClickCapture(rec, { trustCheck: false, windowMs: 10_000 });
    expect(window.open).toBe(openStub);
    const el = button('<button data-testid="t">x</button>');
    click(el);
    expect(window.open).not.toBe(openStub);
    expect(rec.rows).toHaveLength(1);
    if (uninstall) uninstall();
    uninstall = null;
    expect(window.open).toBe(openStub);
    expect(window.fetch).toBe(realFetch);
    expect(resultOf(rec.rows[0]).capturing).toBe(false);
    // the listener is gone: further clicks record nothing
    click(el);
    expect(rec.rows).toHaveLength(1);
    expect(GLOBAL_CLICK_WINDOW_MS).toBe(10_000);
    expect(describePath(el)).toContain("button");
    expect(describeClick(el).testId).toBe("t");
  });
});
