// [F41 §3] Polling - identical cadence to F38 ui.html: config 15s,
// native-status 15s + 10s (F31c live dispatch), progress 3s + ws push,
// /ping 2s, /health 30s. All failures soft (stores keep last known data and
// the conn banner reflects loss).
// [F56-d §3] Search surface reads window.__GHRDP_SEARCH_ENABLED from /diag at boot + polling.
import { useEffect } from "react";
import { announceSearchLane } from "@/lib/search/lane";
import { configUrl, getJson, nativeStatusUrl } from "@/lib/api";
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
    const connectWs = () => {
      // [F94 §3.5] REMOVED the `&& wsLive` precondition: it made the socket
      // depend on the very flag the socket was supposed to set, so with
      // /health's hardcoded ws=$false the bridge could never come up.
      // Also refuse to pile up a second socket while one is mid-handshake.
      if (!alive || ws || wsConnecting) return;
      try {
        wsConnecting = true;
        ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
        ws.onopen = () => {
          wsAttempt = 0;
          wsConnecting = false;
          useTelemetryStore.getState().setWsLive(true);
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
          const step = RECONNECT_LADDER[Math.min(wsAttempt, RECONNECT_LADDER.length - 1)];
          wsAttempt += 1;
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
      if (progressTimer) window.clearTimeout(progressTimer);
      if (wsRetry) window.clearTimeout(wsRetry);
      if (ws) ws.close();
    };
  }, [setConfig, setNativeStatus, markNativeLost, setProgress, setWire, setWsLive, setWsAvailable]);
}
