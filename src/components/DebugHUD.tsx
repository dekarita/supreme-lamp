// [F109 / Observatory step 8] DebugHUD - Shift+F12 overlay with five panels.
//
// MOUNTED AS CHROME, BESIDE DvrFab IN App.tsx - outside every FeatureBoundary and
// outside AppShell, so the HUD still opens when a section (or the shell layout)
// has crashed: the moment it is most needed. It portals to document.body.
//
// FENCED FROM ITSELF. Each panel sits in its own HudPanelBoundary, and the whole
// overlay in one more: a crashing panel shows one line + Retry, never a blank app.
// NOT FeatureBoundary: that fence registers its id in the F105 mount ledger, which
// is exactly what the Features panel READS - wrapping HUD panels in it would make
// the HUD report sections as mounted that are not.
//
// INVISIBLE TO THE RECORDERS. The root carries `data-collector-ignore`, F104's
// documented escape hatch, so HUD clicks never land in the Collector store or the
// DVR ring (pressing "Clear" must not leave a "clicked Clear" entry behind).
//
// DEFAULT-OFF. Renders null until Settings ▸ Debug HUD is on AND Shift+F12 opened it.
import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/primitives/Button";
import { Toggle } from "@/components/primitives/Chip";
import { FEATURES, mountedFeatureIds, type FeatureId } from "@/lib/featureRegistry";
import { sanitizeBoundaryMessage } from "@/lib/featureBoundary";
import { HUD_PANEL_IDS, HUD_SHORTCUT, buildHudSummary, featureCardState, type HudPanelId } from "@/lib/debugHudCore";
import {
  clearHudBuffers,
  enableObservers,
  hudLastErrors,
  hudNetRows,
  hudVersion,
  hudWsFrames,
  installHudShortcut,
  isHudEnabled,
  isHudOpen,
  networkObserverActive,
  setHudOpen,
  subscribeHud,
} from "@/lib/debugHud";
import { clearFeatureToggles, readFeatureToggles, setFeatureToggle, subscribeFeatureToggles } from "@/lib/featureToggles";
import { clearDvr, isDvrRecording, setDvrRecording } from "@/lib/dvr";
import { dvrFullHandle, installDvrFull } from "@/lib/dvr/session";
import { exportDvrV2 } from "@/lib/dvr/export";
import { copyText } from "@/lib/clipboard";
import { useTelemetryStore } from "@/stores/telemetryStore";

const PANEL_LABEL: Record<HudPanelId, string> = {
  features: "Features",
  network: "Network",
  websocket: "WebSocket",
  toggles: "Toggles",
  actions: "Actions",
};

/** [F109 §3] One fence per panel (and one around the overlay). No ledger, no row. */
class HudPanelBoundary extends React.Component<{ id: string; children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: sanitizeBoundaryMessage(error) };
  }
  render() {
    if (this.state.error !== null) {
      return (
        <div data-testid={"debug-hud-panel-error-" + this.props.id} role="alert" className="p-2 text-xs text-danger">
          HUD panel "{this.props.id}" crashed: {this.state.error}{" "}
          <Button data-testid={"debug-hud-panel-retry-" + this.props.id} size="sm" variant="secondary" onClick={() => this.setState({ error: null })}>
            Retry panel
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function useHudVersion(): number {
  return useSyncExternalStore(subscribeHud, hudVersion, hudVersion);
}

function useToggles() {
  const [map, setMap] = useState(() => readFeatureToggles());
  useEffect(() => subscribeFeatureToggles(() => setMap(readFeatureToggles())), []);
  return map;
}

function FeaturesPanel() {
  const { t } = useTranslation();
  useHudVersion();
  const location = useLocation();
  const toggles = useToggles();
  const mounted = new Set<string>(mountedFeatureIds());
  const errors = hudLastErrors();
  // re-read the mount ledger after the route commits (boundaries mount in effects)
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => bump((n) => n + 1), 0);
    return () => clearTimeout(id);
  }, [location.pathname]);
  return (
    <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {FEATURES.map((f) => {
        const err = errors.get(f.id);
        const state = featureCardState({ mounted: mounted.has(f.id), disabled: toggles[f.id] === "off", lastError: err ? err.message : null });
        return (
          <li key={f.id} data-testid={"debug-hud-feature-" + f.id} data-state={state} className="rounded border border-default p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-primary">{t(f.navKey)}</span>
              <span className="font-mono">{state}</span>
            </div>
            <div className="text-tertiary">
              {f.id} · {f.route} · boundary {mounted.has(f.id) ? "mounted" : "not mounted"}
            </div>
            {err ? <div className="mt-1 break-all text-danger">last error ×{err.count}: {err.message}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function NetworkPanel() {
  useHudVersion();
  const rows = hudNetRows().slice(-50).reverse();
  return (
    <div className="text-xs">
      <p className="mb-1 text-tertiary">
        Passive resource timing (fetch/XHR/beacon) - query strings stripped. {networkObserverActive() ? "" : "Resource timing is unavailable in this browser."}
      </p>
      {rows.length === 0 ? (
        <p data-testid="debug-hud-net-empty">No requests observed yet.</p>
      ) : (
        <ul data-testid="debug-hud-net-list" className="font-mono">
          {rows.map((r, i) => (
            <li key={r.ts + ":" + i} data-testid="debug-hud-net-row" className={r.status != null && (r.status === 0 || r.status >= 400) ? "text-danger" : ""}>
              {r.kind} {r.url} → {r.status == null ? "?" : r.status} · {r.ms} ms
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WebSocketPanel() {
  useHudVersion();
  const wsLive = useTelemetryStore((s) => s.wsLive);
  const wsAttempts = useTelemetryStore((s) => s.wsAttempts);
  const wsDead = useTelemetryStore((s) => s.wsDead);
  const frames = hudWsFrames().slice(-50).reverse();
  return (
    <div className="text-xs">
      <p data-testid="debug-hud-ws-state" className="mb-1">
        socket: {wsLive ? "live" : wsDead ? "dead" : "down"} · reconnect attempts {wsAttempts} · frames are described (type + bytes), never stored
      </p>
      {frames.length === 0 ? (
        <p data-testid="debug-hud-ws-empty">No frames since the HUD was enabled.</p>
      ) : (
        <ul data-testid="debug-hud-ws-list" className="font-mono">
          {frames.map((f, i) => (
            <li key={f.ts + ":" + i} data-testid="debug-hud-ws-row">
              {f.dir === "in" ? "⇣" : f.dir === "out" ? "⇡" : "•"} {f.type} · {f.bytes} B
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TogglesPanel() {
  const toggles = useToggles();
  return (
    <div className="text-xs">
      <p className="mb-2 text-tertiary">
        Dev-only. A switched-off section renders a placeholder from its next mount (next route change). Turning the HUD off in Settings re-enables every section.
      </p>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-2 rounded border border-default px-2 py-1">
            <span>{f.id}</span>
            <Toggle
              data-testid={"debug-hud-toggle-" + f.id}
              checked={toggles[f.id] !== "off"}
              label={"enable " + f.id}
              onChange={(on) => setFeatureToggle(f.id as FeatureId, !on)}
            />
          </li>
        ))}
      </ul>
      <Button data-testid="debug-hud-toggles-reset" className="mt-2" size="sm" variant="secondary" onClick={() => clearFeatureToggles()}>
        Re-enable all
      </Button>
    </div>
  );
}

const FULL_DVR_BUILD_ALLOWED = import.meta.env.VITE_DVR_ENABLED !== "false" && import.meta.env.VITE_F107_FULL_DVR !== "false";

function ActionsPanel() {
  const { t } = useTranslation();
  const location = useLocation();
  const toggles = useToggles();
  const [, bump] = useState(0);
  const [note, setNote] = useState("");
  const recording = isDvrRecording();
  const full = dvrFullHandle() !== null;
  const share = useCallback(async () => {
    const errors = hudLastErrors();
    const mounted = new Set<string>(mountedFeatureIds());
    const text = buildHudSummary({
      when: new Date().toISOString(),
      route: location.pathname,
      features: FEATURES.map((f) => {
        const e = errors.get(f.id);
        return { id: f.id, state: featureCardState({ mounted: mounted.has(f.id), disabled: toggles[f.id] === "off", lastError: e ? e.message : null }), lastError: e ? e.message : null };
      }),
      network: hudNetRows(),
      ws: { live: useTelemetryStore.getState().wsLive, attempts: useTelemetryStore.getState().wsAttempts, frames: hudWsFrames() },
      togglesOff: Object.keys(toggles).filter((k) => toggles[k] === "off"),
      dvrRecording: isDvrRecording(),
      fullDvr: dvrFullHandle() !== null,
    });
    const ok = await copyText(text, "HUD summary");
    setNote(ok ? "Summary copied - paste it into the next Arena session." : "Copy failed - clipboard unavailable.");
  }, [location.pathname, toggles]);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="debug-hud-action-record"
          size="sm"
          variant="secondary"
          onClick={() => {
            setDvrRecording(!recording);
            bump((n) => n + 1);
          }}
        >
          {recording ? "Pause DVR ring" : "Resume DVR ring"}
        </Button>
        <Button
          data-testid="debug-hud-action-full"
          size="sm"
          variant="secondary"
          disabled={!full && !FULL_DVR_BUILD_ALLOWED}
          title={!full && !FULL_DVR_BUILD_ALLOWED ? "disabled by build flag (VITE_DVR_ENABLED / VITE_F107_FULL_DVR)" : undefined}
          onClick={() => {
            const h = dvrFullHandle();
            if (h) h.uninstall();
            else if (FULL_DVR_BUILD_ALLOWED) installDvrFull();
            bump((n) => n + 1);
          }}
        >
          {full ? t("dvr.fullStop") : t("dvr.fullStart")}
        </Button>
        <Button
          data-testid="debug-hud-action-export"
          size="sm"
          variant="secondary"
          disabled={!full}
          onClick={async () => {
            const r = await exportDvrV2();
            setNote(r.ok ? "Exported " + r.filename : "Export failed: " + r.reason);
          }}
        >
          Export .mcrec v2
        </Button>
        <Button data-testid="debug-hud-action-share" size="sm" variant="primary" onClick={() => void share()}>
          Share with AI
        </Button>
        <Button
          data-testid="debug-hud-action-clear"
          size="sm"
          variant="secondary"
          onClick={() => {
            clearDvr();
            clearHudBuffers();
            setNote("DVR ring and HUD buffers cleared.");
          }}
        >
          Clear
        </Button>
      </div>
      <p data-testid="debug-hud-full-warning" className="text-tertiary">{t("dvr.fullWarning")}</p>
      {note ? <p data-testid="debug-hud-action-note">{note}</p> : null}
    </div>
  );
}

const PANELS: Record<HudPanelId, () => JSX.Element> = {
  features: FeaturesPanel,
  network: NetworkPanel,
  websocket: WebSocketPanel,
  toggles: TogglesPanel,
  actions: ActionsPanel,
};

function HudOverlay() {
  const [active, setActive] = useState<HudPanelId>("features");
  useEffect(() => {
    enableObservers();
  }, []);
  const Panel = PANELS[active];
  return (
    <div
      data-testid="debug-hud"
      data-collector-ignore=""
      role="dialog"
      aria-label="Debug HUD"
      className="fixed bottom-3 right-3 z-[9999] flex max-h-[70vh] w-[min(720px,calc(100vw-1.5rem))] flex-col rounded-lg border border-strong bg-surface shadow-lg"
    >
      <div className="flex items-center justify-between gap-2 border-b border-default px-3 py-2">
        <span className="text-sm font-semibold text-primary">Debug HUD · F109 · {HUD_SHORTCUT}</span>
        <Button data-testid="debug-hud-close" size="sm" variant="secondary" onClick={() => setHudOpen(false)}>
          Close
        </Button>
      </div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-default px-3 py-1">
        {HUD_PANEL_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active === id}
            data-testid={"debug-hud-tab-" + id}
            onClick={() => setActive(id)}
            className={"rounded px-2 py-1 text-xs " + (active === id ? "bg-accent text-white" : "text-secondary")}
          >
            {PANEL_LABEL[id]}
          </button>
        ))}
      </div>
      <div data-testid={"debug-hud-panel-" + active} role="tabpanel" className="overflow-auto p-3">
        <HudPanelBoundary key={active} id={active}>
          <Panel />
        </HudPanelBoundary>
      </div>
    </div>
  );
}

/** [F109] The chrome mount. Installs the shortcut; renders only while enabled + open. */
export default function DebugHUD() {
  useHudVersion();
  useEffect(() => installHudShortcut(), []);
  if (!isHudEnabled() || !isHudOpen() || typeof document === "undefined") return null;
  return createPortal(
    <HudPanelBoundary id="overlay">
      <HudOverlay />
    </HudPanelBoundary>,
    document.body,
  );
}

/** Exported for the DOM gate only (it proves a crashing panel is fenced). */
export { HudPanelBoundary };
