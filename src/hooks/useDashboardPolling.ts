// [F41 §3] Polling - identical cadence to F38 ui.html: config 15s,
// native-status 15s + 10s (F31c live dispatch), progress 3s + ws push,
// /ping 2s, /health 30s. All failures soft (stores keep last known data and
// the conn banner reflects loss).
import { useEffect } from "react";
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
    const pollProgress = async () => {
      const d = await getJson("/api/progress");
      if (alive) setProgress(d);
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
        if (alive) setWsLive(!!(j && j.ok === true && j.ws === true));
      } catch {
        if (alive) setWsLive(false);
      }
    };

    void pollConfig();
    void pollNative();
    void pollProgress();
    void probeHealth();
    timers.push(window.setInterval(pollConfig, 15000));
    timers.push(window.setInterval(pollNative, 15000));
    timers.push(window.setInterval(pollNative, 10000)); // F31c live dispatch cadence
    timers.push(window.setInterval(pollProgress, 3000));
    timers.push(window.setInterval(pollPing, 2000));
    timers.push(window.setInterval(probeHealth, 30000));

    // Rust ws bridge push (first progress render connects, v1 contract).
    let ws: WebSocket | null = null;
    let wsRetry = 0;
    const connectWs = () => {
      if (!alive || !useTelemetryStore.getState().wsLive) return;
      try {
        ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
        ws.onopen = () => useTelemetryStore.getState().setWsLive(true);
        ws.onmessage = (evt) => {
          try {
            setProgress(JSON.parse(evt.data as string));
          } catch {
            /* ignore */
          }
        };
        ws.onclose = () => {
          void probeHealth();
          wsRetry = window.setTimeout(connectWs, 2000) as unknown as number;
        };
        ws.onerror = () => {};
      } catch {
        /* ignore */
      }
    };
    const wsStarter = window.setInterval(() => {
      if (useTelemetryStore.getState().wsLive && !ws) connectWs();
    }, 5000);

    return () => {
      alive = false;
      timers.forEach((t) => window.clearInterval(t));
      window.clearInterval(wsStarter);
      if (wsRetry) window.clearTimeout(wsRetry);
      if (ws) ws.close();
    };
  }, [setConfig, setNativeStatus, markNativeLost, setProgress, setWire, setWsLive]);
}
