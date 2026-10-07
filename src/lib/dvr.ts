// [F-DVR-LITE §3] dvr.ts - the diagnostic DVR: the last 30 s of what you clicked,
// assembled into ONE paste-able `.mcrec` line. Observatory step 3, option (d) of #169.
//
// WHAT IT IS. F104 already auto-records every real click into the collector store
// ("Global clicks"). This module does not add a second click listener and does not
// touch F104: it DECORATES the recorder F104 already takes by injection
// (`installGlobalClickCapture(recorder)`), so every click and every 10 s settle
// lands in a bounded 30 s ring as well. Extend, never replace - the same rule #168
// derived for the DVR and the reason F104's own tests keep passing unchanged.
//
// WHAT IT DELIBERATELY IS NOT. There is no upload, no endpoint, no token, no
// storage, and no DOM content capture:
//   * option (d) of #169 is "no upload at all": the bundle is built in this tab and
//     only reaches the clipboard when the operator presses Copy (src/lib/clipboard.ts
//     - the same primitive F27/F41 established, which also carries the legacy
//     fallback for browsers that refuse the async clipboard);
//   * `Put-GhFile` / `/api/diag-upload` / `/api/f-dvr/upload` are the remediated
//     class, so the three DVR files are statically forbidden from containing a
//     network or storage API at all (tests/f-dvr-lite.test.js, F-DVR-f);
//   * entries record WHAT was clicked and what the wire answered (F104 already cuts
//     URLs at "?" and "#"); they never capture DOM text, attributes, or form values,
//     which is F107's separate, deliberate scope.
//
// PRIVACY IS THE FEATURE. The panel shows the operator the exact bytes that will be
// copied BEFORE they are copied - a privacy guarantee that only exists because
// nothing leaves the machine by itself.
import {
  DVR_FORMAT,
  DVR_MAX_ENTRIES,
  DVR_VERSION,
  DVR_WINDOW_MS,
  buildBundle,
  bundleText,
  byteLength,
  createRing,
  encodeEnvelope,
  ringStats,
  toBase64,
  type DvrBundle,
  type DvrCounts,
  type DvrCoreEntry,
} from "./dvr-core";
import type { ButtonAction } from "./collectorAgent";
import type { GlobalClickRecorder } from "./globalClickCapture";

/** [F-DVR-LITE §3.1] the codec tags the envelope can carry. */
export type DvrCodec = "gzip" | "plain";

/** Live, cheap state the FAB renders. Kept referentially stable between changes so
 *  `useSyncExternalStore` cannot loop. */
export interface DvrSnapshot {
  count: number;
  settled: number;
  clicks: number;
  routes: number;
  mutations: number;
  spanMs: number;
  route: string;
  recording: boolean;
  lastKind: string;
  lastAt: number;
}

/** What the Copy button hands over, plus everything the panel must show first. */
export interface DvrReport {
  text: string;
  codec: DvrCodec;
  chars: number;
  bytes: number;
  counts: DvrCounts;
  createdAt: string;
  bundle: DvrBundle;
}

const ring = createRing({ windowMs: DVR_WINDOW_MS, maxEntries: DVR_MAX_ENTRIES });

let recording = true;
let mutations = 0;
let lastMutationAt = 0;
let listeners = new Set<() => void>();
// [F107 §3.2] Entry-level subscribers: Full DVR's session recorder rides the SAME
// ring pushes step 3's FAB renders (no second click listener, no fork of F104 -
// the F-DVR-h contract holds). A subscriber sees the stored entry after seq/at.
let entryListeners = new Set<(entry: DvrCoreEntry) => void>();

function currentRoute(): string {
  try {
    if (typeof window === "undefined") return "";
    return String(window.location.hash || window.location.pathname || "");
  } catch {
    return "";
  }
}

function lang(): string {
  try {
    return String((typeof document !== "undefined" && document.documentElement.lang) || "en");
  } catch {
    return "en";
  }
}

function buildSha(): string {
  try {
    return String((import.meta.env.VITE_BUILD_SHA as string | undefined) || "dev");
  } catch {
    return "dev";
  }
}

let snapshot: DvrSnapshot = {
  count: 0,
  settled: 0,
  clicks: 0,
  routes: 0,
  mutations: 0,
  spanMs: 0,
  route: "",
  recording: true,
  lastKind: "",
  lastAt: 0,
};

function recompute(): void {
  const now = Date.now();
  const list = ring.list(now);
  const stats = ringStats(list);
  const last = list.length ? list[list.length - 1] : null;
  snapshot = {
    count: stats.count,
    settled: stats.byKind.settle || 0,
    clicks: stats.byKind.click || 0,
    routes: stats.byKind.route || 0,
    mutations: mutations,
    spanMs: stats.spanMs,
    route: currentRoute(),
    recording: recording,
    lastKind: last ? String(last.kind) : "",
    lastAt: last ? Number(last.at) : 0,
  };
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* a listener must never break the recorder */
    }
  }
}

function push(entry: Omit<DvrCoreEntry, "seq" | "at">): void {
  if (!recording) return;
  try {
    const stored = ring.push({ ...entry, route: currentRoute() }, Date.now());
    recompute();
    // [F107 §3.2] notify after recompute, one listener fault never breaks the rest
    for (const fn of Array.from(entryListeners)) {
      try {
        fn(stored);
      } catch {
        /* a subscriber must never break the recorder */
      }
    }
  } catch {
    /* the DVR must never break a page it is recording */
  }
}

/** The FAB subscribes here; the snapshot object only changes when it changes. */
export function dvrSnapshot(): DvrSnapshot {
  return snapshot;
}

export function subscribeDvr(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** [F107 §3.2] Subscribe to every entry the ring stores (click/settle/route).
 *  The Full DVR session recorder is the production subscriber; the DOM gate uses
 *  the same seam to prove "click observed -> entry added" without a fork. */
export function onDvrEntry(fn: (entry: DvrCoreEntry) => void): () => void {
  entryListeners.add(fn);
  return () => {
    entryListeners.delete(fn);
  };
}

/** Pause/resume. A paused DVR keeps what it has (the panel can still copy it) and
 *  stops growing - the operator's "stop recording the password field" switch. */
export function setDvrRecording(on: boolean): void {
  recording = !!on;
  recompute();
}

export function isDvrRecording(): boolean {
  return recording;
}

/** Forget every entry. `seq` keeps counting, so a later bundle is provably a
 *  suffix of a longer log rather than a fresh (falsifiable) numbering. */
export function clearDvr(): void {
  ring.clear();
  mutations = 0;
  lastMutationAt = 0;
  recompute();
}

/**
 * [F-DVR-LITE §3.2] Decorate the recorder F104 was handed. Returns a recorder of
 * exactly the same shape, so `installGlobalClickCapture` cannot tell the
 * difference - that is what makes this an extension and not a fork.
 */
export function installDvr(inner: GlobalClickRecorder, opts?: { enabled?: boolean }): GlobalClickRecorder {
  recording = opts?.enabled !== false;
  recompute();
  return {
    record(rec: Omit<ButtonAction, "id" | "ts">): ButtonAction {
      const row = inner.record(rec);
      try {
        const params = (rec.params || {}) as Record<string, unknown>;
        push({
          kind: "click",
          id: row ? row.id : "",
          action: String(rec.action || ""),
          feature: String(rec.feature || ""),
          testId: String(params.testId || ""),
          label: String(params.label || ""),
          tag: String(params.tag || ""),
          path: String(params.path || ""),
        });
      } catch {
        /* recording must never break the click that is being recorded */
      }
      return row;
    },
    update(id: string, patch: Partial<ButtonAction>): void {
      inner.update(id, patch);
      try {
        const result = (patch.result || {}) as { fetch?: unknown[]; opened?: unknown[] };
        const fetches = Array.isArray(result.fetch) ? result.fetch : [];
        const opened = Array.isArray(result.opened) ? result.opened : [];
        push({
          kind: "settle",
          id: id,
          verdict: String((patch.verdict && patch.verdict.status) || ""),
          reason: String((patch.verdict && patch.verdict.reason) || ""),
          fetch: fetches.length,
          opened: opened.length,
          failed: fetches.filter((f) => {
            const status = Number((f as { status?: number })?.status ?? 0);
            return status === 0 || status >= 400;
          }).length,
          elapsedMs: Number(patch.elapsedMs || 0),
        });
      } catch {
        /* see above */
      }
    },
  };
}

/**
 * [F-DVR-LITE §3.3] Route + DOM-churn observers. The mutation observer counts
 * batches only - never a node, never text - so the bundle can say "the UI was
 * churning while you clicked" without carrying a single character of the page.
 * Returns an uninstaller (the vitest gate installs and removes it per test).
 */
export function installDvrObservers(): () => void {
  const detach: Array<() => void> = [];
  try {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const onHash = (): void => {
        push({ kind: "route", to: currentRoute() });
      };
      window.addEventListener("hashchange", onHash);
      detach.push(() => window.removeEventListener("hashchange", onHash));
    }
  } catch {
    /* a host without hash events still records clicks */
  }
  try {
    if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.body) {
      const obs = new MutationObserver((records) => {
        mutations += records.length;
        lastMutationAt = Date.now();
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      detach.push(() => obs.disconnect());
    }
  } catch {
    /* jsdom without body, or a locked-down host: clicks alone are still useful */
  }
  return () => {
    for (const fn of detach) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  };
}

interface CompressionCtor {
  new (format: string): CompressionStream;
}

/**
 * [F-DVR-LITE §3.4] gzip when the host has CompressionStream (Chromium, Node 22),
 * plain otherwise (jsdom, older Safari). The codec tag travels in the envelope, so
 * a reader never guesses - and a plain bundle is still a valid `.mcrec`.
 */
async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CS: CompressionCtor | null =
    typeof CompressionStream === "undefined" ? null : (CompressionStream as unknown as CompressionCtor);
  if (!CS) return null;
  try {
    const cs = new CS("gzip");
    const writer = cs.writable.getWriter();
    const readAll = (async (): Promise<Uint8Array> => {
      const reader = cs.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (step.value) {
          chunks.push(step.value);
          total += step.value.length;
        }
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    })();
    // TS's DOM lib wants an ArrayBuffer-backed view; a Uint8Array is one at
    // runtime, and the only reason the cast exists is ArrayBufferLike variance.
    await writer.write(bytes as unknown as BufferSource);
    await writer.close();
    return await readAll;
  } catch {
    return null;
  }
}

/** Build the exact thing the Copy button copies (and the panel previews). */
export async function dvrReport(opts?: { now?: number }): Promise<DvrReport> {
  const now = opts?.now ?? Date.now();
  const entries = ring.list(now);
  const bundle = buildBundle(entries, { route: currentRoute(), buildSha: buildSha(), lang: lang(), ui: "v2" }, {
    now: now,
    windowMs: DVR_WINDOW_MS,
    maxEntries: DVR_MAX_ENTRIES,
  });
  const json = bundleText(bundle);
  const raw = new TextEncoder().encode(json);
  const gz = await gzip(raw);
  const codec: DvrCodec = gz ? "gzip" : "plain";
  const text = encodeEnvelope(codec, toBase64(gz || raw));
  return {
    text: text,
    codec: codec,
    chars: text.length,
    bytes: byteLength(text),
    counts: bundle.counts,
    createdAt: bundle.createdAt,
    bundle: bundle,
  };
}

/** Test-only: forget the singleton ring + observers between mounts. */
export function __resetDvrForTests(): void {
  ring.clear();
  mutations = 0;
  lastMutationAt = 0;
  recording = true;
  listeners = new Set<() => void>();
  entryListeners = new Set<() => void>();
  recompute();
}

/** The format tag the panel prints so the operator knows what they are pasting. */
export const DVR_ENVELOPE_FORMAT = DVR_FORMAT + DVR_VERSION;
/** Visible timestamp of the last captured thing (ms epoch), for the panel. */
export function dvrLastActivityAt(): number {
  return lastMutationAt;
}
