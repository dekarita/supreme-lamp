// [F41 plan §2 ConnectionCard] Connection card (id="sec-conn"): Tailscale IP +
// copy, RDP username, mstsc command, connectivity row (rtt/badge/fps/jit +
// spark canvas), UDP advisory, Rust ws row, primary/fallback links.
import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/primitives/Data";
import { Chip } from "@/components/primitives/Chip";
import { CopyButton } from "@/components/primitives/Copy";
import { useSessionStore } from "@/stores/sessionStore";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { CGNAT_RE } from "@/lib/format";
import { c2ViaText, connBadge, rttTone } from "@/lib/domain/connProbe";
// [R-METRICS / #211] One number per producer, each labelled. `jitMedian`
// returned 0 for a single sample, which rendered as "measured and perfectly
// stable"; jitterFromSamples returns null until there are two samples.
import { jitterFromSamples, rttPair, usableSampleCount } from "@/lib/domain/metrics";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/cn";

export function Sparkline({
  samples,
  width = 220,
  height = 34,
  id,
}: {
  samples: number[];
  width?: number;
  height?: number;
  id?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = width;
    const cssH = height;
    cv.width = Math.floor(cssW * dpr);
    cv.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const pts = samples.filter((s) => typeof s === "number" && !isNaN(s));
    if (!pts.length) {
      ctx.fillStyle = "var(--color-text-tertiary)";
      ctx.font = "11px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("no samples yet", cssW / 2, cssH / 2);
      return;
    }
    const mx = Math.max.apply(null, pts.concat([50]));
    ctx.strokeStyle = "#0ea5e9";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = (i * cssW) / Math.max(pts.length - 1, 1);
      const y = cssH - (pts[i] / mx) * (cssH - 6) - 3;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [samples, width, height]);
  return <canvas ref={ref} id={id} width={width} height={height} style={{ width, height }} aria-hidden />;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5 border-b border-default last:border-0">
      <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{k}</span>
      <div className="flex flex-wrap items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

export function ConnectionCard() {
  const { t } = useTranslation();
  const fqdn = useSessionStore((s) => s.fqdn);
  const ip = useSessionStore((s) => s.ip);
  const user = useSessionStore((s) => s.user);
  const native = useSessionStore((s) => s.native);
  const wire = useTelemetryStore((s) => s.wire);
  const rttSamples = useTelemetryStore((s) => s.rttSamples);
  const httpRtt = useTelemetryStore((s) => s.httpRtt);
  const rttAtMs = useTelemetryStore((s) => s.rttAtMs);
  useNow(1000);

  const mstsc = "mstsc /v:" + (fqdn || ip || "__IP__");
  // [R-METRICS / #211] Two DIFFERENT measurements used to share one slot
  // (`connRtt`): the Tailscale wire RTT when present, otherwise the browser's
  // HTTP round trip. They are now separate, each with its own label, and the
  // fallback case says which producer it came from.
  const RTT_MAX_AGE_MS = 30000;
  const pair = rttPair({
    httpRtt,
    wireRtt: wire && wire.rtt != null ? wire.rtt : null,
    atMs: rttAtMs,
    maxAgeMs: RTT_MAX_AGE_MS,
  });
  const showRtt = pair.preferred.value;
  const showRttSource = pair.preferred.source;
  const badge = connBadge(wire);
  const jitSamples = usableSampleCount(rttSamples);
  const jit = jitterFromSamples(rttSamples);
  const tone = rttTone(showRtt == null ? null : Math.round(showRtt));
  // [R-METRICS] FPS is NOT published by either transport (the web-desktop
  // surface carries its own frame counter, not this card). "not exposed" is the
  // honest string; a numeric placeholder would invent a measurement.
  const fpsText = t("connection.metric.notExposed");
  const jitText = jit == null ? t("connection.metric.insufficient") : jit + " ms";
  // The server's own Tailscale jitter is a DIFFERENT producer from the
  // browser-sample jitter above, so it keeps its own unavailable string.
  const jitTextTailscale = wire && wire.jit != null ? wire.jit + " ms" : t("connection.metric.notExposed");

  const s = native || {};
  const pingPath = s.pingPath || "";
  const pingMs = s.pingMs;
  const c2 = c2ViaText(wire && { via: wire.via, direct: wire.direct });
  const relayAdv = pingPath === "relay";
  const primaryHref = ip && CGNAT_RE.test(ip) ? "http://" + ip + ":7332/" : "http://127.0.0.1:7332/";
  const fallbackHref = ip && CGNAT_RE.test(ip) ? "http://" + ip + ":7331/" : "http://127.0.0.1:7331/";

  return (
    <Card id="sec-conn" title={t("connection.title")} className="mb-4">
      <Row k={t("connection.tailscaleIp")}>
        <span id="credIp" className="font-mono text-sm text-text-mono">
          {ip || "__IP__"}
        </span>
        <CopyButton value={ip} label={t("connection.tailscaleIp")} data-testid="connections-copy-ip" />
      </Row>
      <Row k={t("connection.username")}>
        <Chip id="credUser" mono tone="accent">
          {user || "__USER__"}
        </Chip>
        <CopyButton value={user} label={t("connection.username")} data-testid="connections-copy-user" />
      </Row>
      <Row k={t("connection.mstsc")}>
        <span id="mstscVal" className="font-mono text-sm text-text-mono break-all">
          {mstsc}
        </span>
        <CopyButton value={mstsc} label={t("connection.mstsc")} data-testid="connections-copy-mstsc-line" />
      </Row>
      <Row k={t("connection.connectivity")}>
        <span
          id="connRtt"
          data-testid="conn-rtt"
          data-source={showRttSource}
          data-stale={pair.preferred.stale ? "1" : "0"}
          title={
            showRttSource === "tailscale-wire"
              ? t("connection.metric.tailscale")
              : showRttSource === "browser-http"
                ? t("connection.metric.http")
                : t("connection.remainingBasis.unknown")
          }
          className="font-mono text-sm"
          style={{ color: tone === "ok" ? "var(--color-success)" : tone === "warn" ? "var(--color-warning)" : tone === "bad" ? "var(--color-danger)" : "var(--color-text-tertiary)" }}
        >
          {showRtt == null ? "-- ms" : Math.round(showRtt) + " ms"}
        </span>
        <span id="connRttSource" data-testid="conn-rtt-source" className="text-[10px] uppercase text-tertiary">
          {showRttSource === "tailscale-wire"
            ? t("connection.metric.tailscale")
            : showRttSource === "browser-http"
              ? t("connection.metric.http")
              : "--"}
        </span>
        <span id="connBadge" className={cn("text-xs font-medium", badge.tone === "ok" ? "text-success" : "text-warning")}>
          path: {badge.text}
        </span>
        <span id="connFps" data-testid="conn-fps" data-exposed="0" title={t("connection.metric.notExposed")} className="text-xs text-tertiary font-mono">
          fps {fpsText}
        </span>
        <span
          id="connJit"
          data-testid="conn-jit"
          data-samples={String(jitSamples)}
          data-measured={jit == null ? "0" : "1"}
          title={jit == null ? t("connection.metric.insufficient") : t("connection.metric.http")}
          className="text-xs text-tertiary font-mono"
        >
          jit {jitText}
        </span>
        <Sparkline id="connSpark" samples={rttSamples} width={220} height={34} />
      </Row>
      <div id="connUdpAdv" className={cn("py-1.5 border-b border-default", relayAdv ? "" : "hidden")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{t("connection.latency")}</span>
          <span id="connUdpAdvText" className="text-xs text-warning">
            direct WireGuard not established - check client firewall UDP 41641
          </span>
        </div>
      </div>
      <Row k={t("connection.rust")}>
        <span
          id="c2Srv"
          data-testid="c2-srv"
          data-source="native-probe"
          title={t("connection.metric.probe")}
          className={cn("text-xs font-mono", pingPath === "direct" ? "text-success" : pingPath ? "text-warning" : "text-tertiary")}
        >
          srv {pingMs != null && pingMs !== "" ? pingMs + " ms " : "-- "} {pingPath || "unknown"}
        </span>
        <span id="c2Via" className={cn("text-xs font-mono", c2.tone === "ok" ? "text-success" : c2.tone === "warn" ? "text-warning" : "text-tertiary")}>
          {c2.text}
        </span>
        <span id="c2Fps" data-testid="c2-fps" data-exposed="0" title={t("connection.metric.notExposed")} className="text-xs text-tertiary font-mono">
          fps {fpsText}
        </span>
        <span
          id="c2Jit"
          data-testid="c2-jit"
          data-measured={wire && wire.jit != null ? "1" : "0"}
          title={t("connection.metric.tailscale")}
          className="text-xs text-tertiary font-mono"
        >
          jit {jitTextTailscale}
        </span>
        <span
          id="c2Rtt"
          data-testid="c2-rtt"
          data-source="tailscale-wire"
          className="text-xs text-tertiary font-mono"
        >
          rtt {wire && wire.rtt != null ? Math.round(wire.rtt) + " ms" : t("connection.metric.notExposed")}
        </span>
        <Sparkline id="c2Spark" samples={(wire && wire.hist) || []} width={120} height={24} />
      </Row>
      <p className="text-xs text-tertiary mt-2">
        {t("connection.primary")}:{" "}
        <a id="primaryLink" href={primaryHref} className="text-accent underline break-all">
          {primaryHref}
        </a>{" "}
        | {t("connection.fallback")}:{" "}
        <a id="fallbackLink" href={fallbackHref} className="text-accent underline break-all">
          {fallbackHref}
        </a>
      </p>
    </Card>
  );
}
