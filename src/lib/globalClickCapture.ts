// [F104 §3] globalClickCapture.ts - document-level click telemetry.
//
// WHY: F100/F101/F102 record only the buttons whose handlers were hand-wired
// through logButtonAction()/instrumentButton()/KNOWN_BUTTONS. Every OTHER
// Mission Control button (tabs, toggles, diag chips, pagination, modal
// actions...) fires invisibly: the operator's "I clicked X and nothing
// happened" has no row anywhere. This module closes that gap: ONE document
// click listener (capture phase) sees every real user click, describes the
// clicked control, watches what the click DOES on the wire (fetch) and on the
// screen (window.open) for 10 s, and records a collector row - no per-button
// wiring, ever.
//
// INTEROP (read before touching):
//   - F101's installFetchObserver() ALSO wraps window.fetch (permanently, from
//     the Collector mount). This observer therefore restores conditionally:
//     the wrappers go away only while they are still the outermost layer;
//     when something else wrapped on top, ours stay in the chain as pure
//     forwarders (an `active` flag stops the recording). An unconditional
//     restore would silently discard F101's observer - that is the regression
//     this paragraph exists to prevent.
//   - The collector's OWN ui is never captured (see GLOBAL_CLICK_IGNORE):
//     recording "Click now" clicks would feed the store from its own reader
//     and break the F102 row counts the e2e pins assert.
//   - Programmatic clicks (el.click() from the F102 runner, a.click() download
//     links) are NOT user behaviour: `trustCheck` (default on) drops every
//     event whose isTrusted is false. The smoke suite disables it because
//     jsdom cannot mint a trusted event.
//
// PRIVACY: recorded URLs are cut at the first "?" or "#" and capped at 200
// chars - no query string, token, or fragment can reach a row. Bodies and
// headers are never captured here (F101's deep rows already do that, masked).
import type { ButtonAction } from "@/lib/collectorAgent";

/** [F104 §3] the provenance tag every auto-captured row carries. */
export const GLOBAL_CLICK_SOURCE = "global-click-capture";
/** [F104 §3.2] how long one click's fetch/window.open window stays open. */
export const GLOBAL_CLICK_WINDOW_MS = 10_000;
/** [F104 §3.1] same control re-clicked inside this window is one row. */
export const GLOBAL_CLICK_DEDUP_MS = 500;
/** [F104 §3.2] per-row cap so a chatty click cannot blow the quota. */
export const GLOBAL_CLICK_MAX_EXCHANGES = 50;

/**
 * [F104 §3.1] NEVER captured. The collector's own controls (every testid the
 * Collector page renders starts with `collector-`; the "Click now" spans
 * start with `click-now-`) plus structural non-actions (nav links, pager
 * buttons). data-collector-ignore is the escape hatch any surface can hang
 * on a subtree - the Collector page hangs it on its own root.
 */
export const GLOBAL_CLICK_IGNORE = [
  "[data-collector-ignore]",
  "[data-testid^='collector-']",
  "[data-testid^='click-now-']",
  "nav a",
  ".pagination button",
];

/** What counts as a clicked control: real buttons/links first, any testid'd
 *  element second (cards and rows carry testids and ARE the click target). */
const CLICKABLE = "button, a[role='button'], input[type='button'], input[type='submit'], [data-testid]";

/** The operator-readable description of the clicked control. */
export interface ClickDescriptor {
  testId: string;
  label: string;
  text: string;
  tag: string;
  route: string;
  path: string;
}

/** One thing the click did: a fetch round trip or a window.open call. */
export interface ObservedExchange {
  kind: "fetch" | "open";
  url: string;
  method?: string;
  status?: number;
  elapsedMs?: number;
  blocked?: boolean;
  error?: string;
}

export interface GlobalClickRecorder {
  record: (rec: Omit<ButtonAction, "id" | "ts">) => ButtonAction;
  update: (id: string, patch: Partial<ButtonAction>) => void;
}

export interface GlobalClickOptions {
  windowMs?: number;
  dedupMs?: number;
  /** default true: drop events with isTrusted === false (programmatic). */
  trustCheck?: boolean;
}

function stripUrl(raw: string): string {
  const cut = String(raw || "").split(/[?#]/, 1)[0] || "";
  return cut.length > 200 ? cut.slice(0, 200) + "…" : cut;
}

function currentRoute(): string {
  try {
    if (typeof window === "undefined") return "";
    return String(window.location.hash || window.location.pathname || "");
  } catch {
    return "";
  }
}

/** Short stable element path (tag#id.class, max 3 levels) - never text. */
export function describePath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; i < 3 && cur && cur.tagName; i++) {
    let p = cur.tagName.toLowerCase();
    const id = typeof cur.getAttribute === "function" ? cur.getAttribute("id") : null;
    if (id) p += "#" + String(id).slice(0, 40);
    else if (typeof cur.className === "string" && cur.className.trim()) {
      p += "." + cur.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    parts.unshift(p);
    cur = cur.parentElement;
  }
  return parts.join(" > ").slice(0, 160);
}

export function describeClick(el: Element): ClickDescriptor {
  const g = (name: string): string => {
    try {
      return String(el.getAttribute(name) || "");
    } catch {
      return "";
    }
  };
  let text = "";
  try {
    text = String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    text = "";
  }
  return {
    testId: g("data-testid"),
    label: g("aria-label") || g("title") || g("value"),
    text,
    tag: String(el.tagName || "").toLowerCase(),
    route: currentRoute(),
    path: describePath(el),
  };
}

function dedupeKey(d: ClickDescriptor): string {
  return [d.testId, d.label, d.text, d.tag, d.route].join("|");
}

interface PendingCapture {
  id: string;
  exchanges: ObservedExchange[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Install the document-level click listener. Returns an uninstall function
 * (removes the listener AND restores any wrappers this install still owns).
 * Installing twice is a no-op returning the first install's uninstaller.
 */
export function installGlobalClickCapture(recorder: GlobalClickRecorder, opts?: GlobalClickOptions): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;
  if ((installGlobalClickCapture as unknown as { installed?: () => void }).installed) {
    return (installGlobalClickCapture as unknown as { installed: () => void }).installed;
  }
  const windowMs = Math.max(0, opts?.windowMs ?? GLOBAL_CLICK_WINDOW_MS);
  const dedupMs = Math.max(0, opts?.dedupMs ?? GLOBAL_CLICK_DEDUP_MS);
  const trustCheck = opts?.trustCheck !== false;
  const ignoreSel = GLOBAL_CLICK_IGNORE.join(",");
  const pendings = new Set<PendingCapture>();
  let lastKey = "";
  let lastAt = 0;

  const recordExchange = (ex: ObservedExchange): void => {
    for (const p of pendings) {
      if (p.exchanges.length < GLOBAL_CLICK_MAX_EXCHANGES) p.exchanges.push(ex);
    }
  };

  const closeCapture = (p: PendingCapture): void => {
    if (p.timer) {
      try {
        clearTimeout(p.timer);
      } catch {
        /* ignore */
      }
      p.timer = null;
    }
    pendings.delete(p);
    const fetches = p.exchanges.filter((e) => e.kind === "fetch");
    const opens = p.exchanges.filter((e) => e.kind === "open");
    const failed = fetches.filter((f) => (f.status ?? 0) === 0 || (f.status ?? 200) >= 400).length;
    try {
      recorder.update(p.id, {
        result: { capturing: false, fetch: fetches, opened: opens },
        elapsedMs: windowMs,
        verdict: {
          status: failed > 0 ? "warn" : "ok",
          reason:
            "auto-captured click: " + fetches.length + " fetch(es), " + opens.length + " popup(s)" +
            (failed > 0 ? ", " + failed + " failed" : ""),
          suggestedFix: failed > 0 ? "open the row's fetch list and check the failing status" : "",
          relatedIssue: null,
        },
      });
    } catch {
      /* the store must never break the page */
    }
  };

  // [F104 §3.2] one observation window per click: wrap what is THERE (which
  // may already be F101's observer), record for windowMs, restore only while
  // still outermost. `active` stops recording even when the wrappers must
  // stay in the chain because someone else wrapped on top mid-window.
  const openWindow = (p: PendingCapture): void => {
    pendings.add(p);
    let active = true;
    // this window's OWN wrappers: release() touches only these, so two
    // overlapping windows never restore each other's layers.
    const mine: Array<{ kind: "fetch" | "open"; wrapped: unknown; prev: unknown }> = [];
    if (typeof window.fetch === "function") {
      const prevFetch = window.fetch;
      const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const started = Date.now();
        const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request)?.url || "");
        let method = String(init?.method || "").toUpperCase();
        if (!method) {
          try {
            method = typeof input !== "string" && (input as Request)?.method ? String((input as Request).method).toUpperCase() : "GET";
          } catch {
            method = "GET";
          }
        }
        try {
          const res = await (prevFetch as typeof fetch)(input as RequestInfo, init);
          if (active) recordExchange({ kind: "fetch", url: stripUrl(rawUrl), method, status: res.status, elapsedMs: Date.now() - started });
          return res;
        } catch (e) {
          if (active) {
            recordExchange({
              kind: "fetch",
              url: stripUrl(rawUrl),
              method,
              status: 0,
              elapsedMs: Date.now() - started,
              error: String((e as Error)?.message || e).slice(0, 200),
            });
          }
          throw e;
        }
      }) as typeof fetch;
      try {
        window.fetch = wrappedFetch;
        mine.push({ kind: "fetch", wrapped: wrappedFetch, prev: prevFetch });
      } catch {
        /* a frozen window object keeps the unwrapped fetch */
      }
    }
    if (typeof window.open === "function") {
      const prevOpen = window.open;
      const wrappedOpen = ((url?: string | URL | null, target?: string, features?: string): WindowProxy | null => {
        let ret: WindowProxy | null = null;
        let threw = "";
        try {
          ret = (prevOpen as typeof window.open)(url as string, target, features);
        } catch (e) {
          threw = String((e as Error)?.message || e).slice(0, 200);
        }
        if (active) {
          recordExchange({
            kind: "open",
            url: stripUrl(String(url ?? "")),
            blocked: ret === null || ret === undefined,
            ...(threw ? { error: threw } : {}),
          });
        }
        if (threw) throw new Error(threw);
        return ret;
      }) as typeof window.open;
      try {
        window.open = wrappedOpen;
        mine.push({ kind: "open", wrapped: wrappedOpen, prev: prevOpen });
      } catch {
        /* ignore */
      }
    }
    const release = (): void => {
      active = false;
      for (let i = mine.length - 1; i >= 0; i--) {
        const w = mine[i];
        try {
          if (w.kind === "fetch" && window.fetch === w.wrapped) {
            window.fetch = w.prev as typeof fetch;
            mine.splice(i, 1);
          } else if (w.kind === "open" && (window.open as unknown) === w.wrapped) {
            window.open = w.prev as typeof window.open;
            mine.splice(i, 1);
          }
        } catch {
          /* ignore */
        }
      }
    };
    try {
      p.timer = setTimeout(() => {
        release();
        closeCapture(p);
      }, windowMs);
    } catch {
      release();
      closeCapture(p);
    }
    // stash the releaser on the pending so uninstall can run it early
    (p as unknown as { release?: () => void }).release = release;
  };

  const onClick = (ev: Event): void => {
    try {
      if (trustCheck && (ev as MouseEvent).isTrusted === false) return;
      const t = ev.target as Element | null;
      if (!t || typeof (t as Element).closest !== "function") return;
      // the collector's own UI is invisible to the capture (F102 guard)
      if ((t as Element).closest(ignoreSel)) return;
      const el = (t as Element).closest(CLICKABLE);
      if (!el) return;
      const d = describeClick(el);
      const key = dedupeKey(d);
      const at = Date.now();
      if (key === lastKey && at - lastAt < dedupMs) return;
      lastKey = key;
      lastAt = at;
      const name = d.testId || d.label || d.text || d.tag || "click";
      let row: ButtonAction | null = null;
      try {
        row = recorder.record({
          feature: "global",
          action: "click:" + String(name).slice(0, 80),
          params: { testId: d.testId, label: d.label, text: d.text, tag: d.tag, route: d.route, path: d.path },
          result: { capturing: true, fetch: [], opened: [] },
          elapsedMs: 0,
          source: GLOBAL_CLICK_SOURCE,
        });
      } catch {
        return;
      }
      if (!row) return;
      openWindow({ id: row.id, exchanges: [], timer: null });
    } catch {
      /* capture must never break the app */
    }
  };

  const uninstall = (): void => {
    try {
      document.removeEventListener("click", onClick, true);
    } catch {
      /* ignore */
    }
    for (const p of Array.from(pendings)) {
      try {
        ((p as unknown as { release?: () => void }).release || (() => undefined))();
      } catch {
        /* ignore */
      }
      closeCapture(p);
    }
    (installGlobalClickCapture as unknown as { installed?: () => void }).installed = undefined;
  };

  try {
    document.addEventListener("click", onClick, true);
  } catch {
    return () => undefined;
  }
  (installGlobalClickCapture as unknown as { installed?: () => void }).installed = uninstall;
  return uninstall;
}

/** Test-only: forget the singleton so a fresh install can run. */
export function __resetGlobalClickCaptureForTests(): void {
  (installGlobalClickCapture as unknown as { installed?: () => void }).installed = undefined;
}
