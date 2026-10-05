// [F41 §3] Polling - identical cadence to F38 ui.html: config 15s,
// native-status 15s + 10s (F31c live dispatch), progress 3s + ws push,
// /ping 2s, /health 30s. All failures soft (stores keep last known data and
// the conn banner reflects loss).
// [F56-d §3] Search surface reads window.__GHRDP_SEARCH_ENABLED from /diag at boot + polling.
import { useEffect } from "react";
import { announceSearchLane } from "@/lib/search/lane";
import { configUrl, getJson, nativeStatusUrl } from "@/lib/api";
// [F95 §3.4 / R4] the dash token the /ws upgrade needs (and the storage key to
// watch so a token change rebuilds the socket instead of silently failing).
import { DASH_TOKEN_STORAGE_KEY, getDashToken } from "@/lib/dashToken";
import { useSessionStore } from "@/stores/sessionStore";
import { useTelemetryStore } from "@/stores/telemetryStore";
import type { WireState } from "@/lib/domain/connProbe";

export function useDashboardPolling(): void {
  const setConfig = useSessionStore((s) => s.setConfig);
  const setNativeStatus = useSessionStore((s) => s.setNativeStatus);
  const markNativeLost = useSessionStore((s) => s.markNativeLost);
  const setProgress = useTelemetryStore((s) => s.setProgress);
  const setWire = useTelemetryStore((s) => s.setWire);
  const setWsLive = useTelemetryStore((s) => s.setWsLive);
  const setWsAvailable = useTelemetryStore((s) => s.setWsAvailable);

  useEffect(() => {
    let alive = true;
    const timers: number[] = [];

    const pollConfig = async () => {
      const cf = await getJson(configUrl());
      if (alive) setConfig(cf);
    };
    const pollNative = async () => {
      const s = await getJson(nativeStatusUrl());
      if (!alive) return;
      if (s) setNativeStatus(s);
      else markNativeLost();
    };

    const pollDiagForSearch = async () => {
      try {
        // [F56-d §3] /diag echoes the dispatch lane: searchEnabled (boolean) + searchInput
        // (raw SEARCH_INPUT string). Typed here so the boot read stays compile-checked.
        const diag = await getJson<{ searchEnabled?: boolean | string | number; searchInput?: string }>("/diag");
        if (alive && diag) {
          // [F77 §2.3] This write is a DIAGNOSTIC MIRROR ONLY: lane.ts is hardcoded
          // enabled and no UI path reads this property, so a false /diag answer can
          // neither hide the sidebar entry nor redirect /search. (F76 §1.2 had
          // narrowed the write to an explicit answer; that was still one bad /diag
          // away from an invisible Search.) F56-d gate launch-gates.yml:3125 pins
          // the mirror's presence in this file + sessionStore, so it stays.
          if (diag.searchEnabled !== undefined) {
            const enabled = !!(diag.searchEnabled === true || diag.searchEnabled === 'true' || diag.searchEnabled === 1);
            // @ts-ignore
            if (typeof window !== 'undefined') (window as any).__GHRDP_SEARCH_ENABLED = enabled;
            announceSearchLane(); // [F77] no-op (lane.ts); kept for the diag subscribers
          }
          // @ts-ignore
          if (typeof window !== 'undefined') (window as any).__GHRDP_SEARCH_INPUT = diag.searchInput || '';
        }
      } catch {}
    };
    const pollPing = async () => {
      const t0 = performance.now();
      try {
        const r = await fetch("/ping", { cache: "no-store" });
        const d = (await r.json()) as { wire?: WireState };
        const dt = performance.now() - t0;
        if (alive) setWire(d && d.wire ? d.wire : undefined, dt);
      } catch {
        if (alive) setWire(null, null);
      }
    };
    const probeHealth = async () => {
      try {
        const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctl ? window.setTimeout(() => ctl.abort(), 3000) : 0;
        const r = await fetch("/health", { cache: "no-store", signal: ctl?.signal });
        if (timer) window.clearTimeout(timer);
        const j = (await r.json()) as { ok?: boolean; ws?: boolean };
        // [F94 §3.5] /health's `ws` flag means "the server ADVERTISES a /ws
        // endpoint" - it is INFORMATIONAL and must never be written into
        // wsLive (which means "our socket is open"). Writing it there was the
        // deadlock: payloads/ghrdp-server.ps1 hardcodes ws=$false, and
        // connectWs() refused to run unless wsLive was already true, so the
        // socket could never open and the pill read "idle" permanently.
        if (alive) setWsAvailable(!!(j && j.ok === true && j.ws === true));
      } catch {
        if (alive) setWsAvailable(false);
      }
    };

    // [F93 §3.2] EXPLICIT RECONNECT with linear backoff.
    // The F92 report "connection: lost (retrying)" was one failed /api/progress
    // poll away from a red chip with no retry story. Now the progress lane
    // retries on the 1s -> 3s -> 10s -> 30s ladder and only reports the
    // connection as lost once that whole ladder is exhausted; the first
    // success resets it. The 2s /ping cadence dropped to 5s (12/min), so the
    // dashboard stays far below the server's per-route budget.
    const RECONNECT_LADDER = [1000, 3000, 10000, 30000];
    let progressFail = 0;
    let progressTimer = 0;
    const progressLoop = async () => {
      const d = await getJson("/api/progress");
      if (!alive) return;
      if (d) {
        progressFail = 0;
        setProgress(d);
        progressTimer = window.setTimeout(progressLoop, 3000) as unknown as number;
        return;
      }
      if (progressFail < RECONNECT_LADDER.length) {
        const delay = RECONNECT_LADDER[progressFail];
        progressFail += 1;
        progressTimer = window.setTimeout(progressLoop, delay) as unknown as number;
        return;
      }
      // Ladder exhausted: report the loss (the chip turns red here), then keep
      // probing at the slowest step so recovery is automatic, never manual.
      progressFail += 1;
      setProgress(null);
      progressTimer = window.setTimeout(progressLoop, RECONNECT_LADDER[RECONNECT_LADDER.length - 1]) as unknown as number;
    };

    void pollConfig();
    void pollNative();
    void progressLoop();
    void pollDiagForSearch();
    void probeHealth();
    timers.push(window.setInterval(pollConfig, 15000));
    timers.push(window.setInterval(pollNative, 15000));
    timers.push(window.setInterval(pollNative, 10000));
    timers.push(window.setInterval(pollPing, 5000));
    timers.push(window.setInterval(probeHealth, 30000));
    timers.push(window.setInterval(pollDiagForSearch, 15000));

    let ws: WebSocket | null = null;
    let wsRetry = 0;
    let wsAttempt = 0;
    let wsConnecting = false;
    // [F95 §3.4 / R4] THE TOKEN.
    //
    // ROOT CAUSE of the bridge dropping on a Tailscale page: the URL was built
    // as `<proto>//<host>/ws` with NO credential on it. The REST lane has always
    // sent one (src/api/search/index.ts adds `X-Dash-Token` from getKey()), so
    // on any deployment that requires the dash token the /ws upgrade is
    // rejected while /api/progress keeps working - which is precisely the
    // asymmetric symptom the operator saw ("ws: idle" next to live data).
    // A WebSocket cannot set request headers from the browser, so the token
    // travels twice: in the query string AND as the first frame after open
    // (a server that only reads one of the two still authenticates).
    const wsUrl = (): string => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const base = proto + "//" + location.host + "/ws";
      let token = "";
      try {
        token = getDashToken();
      } catch {
        token = "";
      }
      return token ? base + "?key=" + encodeURIComponent(token) : base;
    };
    const connectWs = () => {
      // [F94 §3.5] REMOVED the `&& wsLive` precondition: it made the socket
      // depend on the very flag the socket was supposed to set, so with
      // /health's hardcoded ws=$false the bridge could never come up.
      // Also refuse to pile up a second socket while one is mid-handshake.
      if (!alive || ws || wsConnecting) return;
      try {
        wsConnecting = true;
        ws = new WebSocket(wsUrl());
        ws.onopen = () => {
          wsAttempt = 0;
          wsConnecting = false;
          useTelemetryStore.getState().setWsLive(true);
          // [F95 §3.4 / R4] ladder reset: a successful open means we are not
          // disconnected, however many tries it took to get here.
          useTelemetryStore.getState().setWsDead(false);
          useTelemetryStore.getState().setWsAttempts(0);
          // [F95 §3.4 / R4] backup auth frame. Sent immediately so a server
          // that authenticates on first-message (rather than on the upgrade
          // request) still accepts the socket.
          try {
            const token = getDashToken();
            if (token && ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "hello", key: token }));
            }
          } catch {
            /* a send failure here is not fatal - the URL already carried it */
          }
        };
        ws.onmessage = (evt) => {
          try {
            const data = JSON.parse(evt.data as string);
            setProgress(data);
            // [F56-d] File-arrival event via ws progress mirrorDiag for Fetched-root
            try {
              // If progress contains fetchedFiles or files in Fetched, propagate to FileExplorer
              // @ts-ignore
              if (data && data.fetchedFiles) {
                // @ts-ignore
                if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ghrdp-fetched-arrival', { detail: data.fetchedFiles }));
              }
            } catch {}
          } catch {}
        };
        ws.onclose = () => {
          // [F94 §3.5] `ws` MUST be released here. It never was, so the
          // reconnect interval's `&& !ws` guard was false after the very first
          // close and the bridge could never come back - the pill stayed
          // "idle" for the whole run even on a healthy server.
          ws = null;
          wsConnecting = false;
          useTelemetryStore.getState().setWsLive(false);
          void probeHealth();
          // [F93 §3.2] same ladder as the progress lane (capped at 30s).
          // [F95 §3.4 / R4] the ladder used to retry FOREVER and SILENTLY. Now
          // exhausting it publishes wsDead, which the UI renders as an explicit
          // "disconnected [Reconnect]" instead of a pill that just sits at
          // "idle" with no story behind it.
          wsAttempt += 1;
          useTelemetryStore.getState().setWsAttempts(wsAttempt);
          if (wsAttempt > RECONNECT_LADDER.length) {
            useTelemetryStore.getState().setWsDead(true, "ladder-exhausted");
          }
          const step = RECONNECT_LADDER[Math.min(wsAttempt, RECONNECT_LADDER.length - 1)];
          wsRetry = window.setTimeout(connectWs, step) as unknown as number;
        };
        ws.onerror = () => {
          // A failed handshake also fires onclose in every browser we target,
          // so this only guards against a synchronous throw below.
          wsConnecting = false;
        };
      } catch {
        // The constructor threw (blocked/insecure origin): drop the handle so
        // the ladder below can retry instead of latching on a dead object.
        ws = null;
        wsConnecting = false;
        useTelemetryStore.getState().setWsLive(false);
      }
    };
    /** [F95 §3.4 / R4] drop whatever is in flight so connectWs() runs now. */
    const resetWs = (reason: string) => {
      if (wsRetry) {
        window.clearTimeout(wsRetry);
        wsRetry = 0;
      }
      if (ws) {
        try {
          ws.onclose = null;
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      wsConnecting = false;
      wsAttempt = 0;
      useTelemetryStore.getState().setWsAttempts(0);
      useTelemetryStore.getState().setWsDead(false, reason);
      connectWs();
    };
    // [F95 §3.4 / R4] A token that changes under a live socket leaves the old
    // credential in the URL, so the next reconnect fails for a reason the
    // operator cannot see. Rebuild immediately on either signal:
    //   * a `storage` event - the token was written from ANOTHER tab;
    //   * wsReconnectNonce - the operator pressed the Reconnect button.
    const onStorage = (e: StorageEvent) => {
      if (e.key === DASH_TOKEN_STORAGE_KEY) resetWs("token-changed");
    };
    try {
      window.addEventListener("storage", onStorage);
    } catch {
      /* no storage events in this environment */
    }
    let lastNonce = useTelemetryStore.getState().wsReconnectNonce;
    const nonceWatcher = window.setInterval(() => {
      const n = useTelemetryStore.getState().wsReconnectNonce;
      if (n !== lastNonce) {
        lastNonce = n;
        resetWs("manual-reconnect");
      }
    }, 1000);

    // [F94 §3.5] The starter no longer requires wsLive - it only needs no
    // socket in flight.
    const wsStarter = window.setInterval(() => {
      if (!ws && !wsConnecting) connectWs();
    }, 5000);
    // [F94 §3.5] Bootstrap the bridge on the FIRST tick rather than waiting for
    // a /health answer that the shipped server never sets true. (After the
    // connectWs definition - `const` arrows are not hoisted.)
    connectWs();

    return () => {
      alive = false;
      timers.forEach((t) => window.clearInterval(t));
      window.clearInterval(wsStarter);
      // [F95 §3.4 / R4] the token-change + manual-reconnect watchers.
      window.clearInterval(nonceWatcher);
      try {
        window.removeEventListener("storage", onStorage);
      } catch {
        /* ignore */
      }
      if (progressTimer) window.clearTimeout(progressTimer);
      if (wsRetry) window.clearTimeout(wsRetry);
      if (ws) ws.close();
    };
  }, [setConfig, setNativeStatus, markNativeLost, setProgress, setWire, setWsLive, setWsAvailable]);
}
