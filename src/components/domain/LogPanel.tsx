// [F41 plan §2 LogPanel + §5.2] Live log panel (id="sec-log": logBox +
// pause/resume) and the structured 4624/4625 + Schannel tables built from the
// existing /api/native-status fields (authEvents, connLog, telescope).
import React, { useMemo, useRef } from "react";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, DataTable, EmptyState, type Column } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { CopyButton } from "@/components/primitives/Copy";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { useSessionStore } from "@/stores/sessionStore";
import { asList } from "@/lib/domain/telescope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function LogPanel() {
  const { t } = useTranslation();
  const lines = useTelemetryStore((s) => s.logLines);
  const paused = useTelemetryStore((s) => s.logPaused);
  const setPaused = useTelemetryStore((s) => s.setLogPaused);
  const boxRef = useRef<HTMLPreElement>(null);

  // auto-scroll unless paused (v1 contract)
  React.useEffect(() => {
    const el = boxRef.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  return (
    <Card id="sec-log" title={t("logs.liveLog")} icon={<FileText className="size-4 text-tertiary" aria-hidden />} className="mb-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs text-tertiary">{lines.length ? lines.length + " lines" : "waiting for the watcher..."}</span>
        <div className="flex gap-1">
          <CopyButton value={() => lines.join("\n")} label="copy log" data-testid="overview-log-copy" />
          <Button id="logPauseBtn" variant={paused ? "outline" : "secondary"} size="sm" onClick={() => setPaused(!paused)} data-testid="overview-log-pause">
            {paused ? t("actions.resumeLog") : t("actions.pauseLog")}
          </Button>
        </div>
      </div>
      <pre
        id="logBox"
        ref={boxRef}
        tabIndex={0}
        className="bg-sunken border border-default rounded-md p-3 font-mono text-xs leading-snug text-text-mono overflow-auto max-h-[320px] whitespace-pre-wrap"
      >
        {lines.join("\n")}
      </pre>
    </Card>
  );
}

export interface LogonEventRow {
  id: string;
  eventId: string;
  logonType: string;
  timeUtc: string;
  sub: string;
  desc: string;
}

export function useLogonEvents(): LogonEventRow[] {
  const native = useSessionStore((s) => s.native);
  return useMemo(() => {
    const rl = (native && native.rdpListener) || {};
    const ae = rl.authEvents || null;
    if (!ae) return [];
    const evs = asList(ae.events && ae.events.length ? ae.events : ae.items || []);
    const rows: LogonEventRow[] = evs.map((e: Any, i: number) => ({
      id: String(e.eventId || e.id || i),
      eventId: String(e.id || e.eventId || ""),
      logonType: String(e.logonType || e.LogonType || e.type || ""),
      timeUtc: String(e.timeUtc || e.ts || ""),
      sub: String(e.sub || e.SubStatus || ""),
      desc: String(e.desc || e.message || ""),
    }));
    if (!rows.length && (ae.count4624 != null || ae.count4625 != null)) {
      rows.push({
        id: "summary",
        eventId: "summary",
        logonType: "",
        timeUtc: String(ae.last4624At || ae.last4625At || ""),
        sub: String(ae.sub || ae.lastSubStatus || ""),
        desc: "4624=" + (ae.count4624 ?? 0) + " 4625=" + (ae.count4625 ?? 0) + (ae.verdict ? " verdict=" + ae.verdict : ""),
      });
    }
    return rows;
  }, [native]);
}

export function LogonEventsTable({ maxHeight }: { maxHeight?: string }) {
  const { t } = useTranslation();
  const rows = useLogonEvents();
  const columns: Column<LogonEventRow>[] = [
    { key: "eventId", label: "event", render: (r) => <span className="font-mono">{r.eventId}</span>, sortValue: (r) => r.eventId },
    {
      key: "result",
      label: "result",
      render: (r) => (
        <span className={r.eventId === "4624" ? "text-success" : r.eventId === "4625" ? "text-danger" : ""}>
          {r.eventId === "4624" ? "success" : r.eventId === "4625" ? "failed" : r.eventId}
        </span>
      ),
      sortValue: (r) => r.eventId,
    },
    { key: "logonType", label: "logon type", render: (r) => <span className="font-mono">{r.logonType || "-"}</span>, sortValue: (r) => r.logonType },
    { key: "timeUtc", label: "time (UTC)", render: (r) => <span className="font-mono text-xs">{r.timeUtc || "-"}</span>, sortValue: (r) => r.timeUtc },
    { key: "sub", label: "sub-status", render: (r) => <span className="font-mono text-xs">{r.sub || "-"}</span>, sortValue: (r) => r.sub },
    { key: "desc", label: "detail", render: (r) => <span className="text-xs text-secondary break-all">{r.desc || "-"}</span> },
  ];
  return (
    <div>
      {rows.map((r) => (
        <span key={"class-" + r.id} className={r.eventId === "4625" ? "event-4625-row" : "event-4624-row"} />
      ))}
      <DataTable columns={columns} rows={rows} maxHeight={maxHeight} filterKeys={(r) => [r.eventId, r.logonType, r.timeUtc, r.sub, r.desc].join(" ")} emptyText={t("table.empty")} />
    </div>
  );
}

export interface SchannelRow {
  id: string;
  timeUtc: string;
  provider: string;
  reason: string;
  level: string;
  desc: string;
}

export function useSchannelEvents(): SchannelRow[] {
  const native = useSessionStore((s) => s.native);
  return useMemo(() => {
    const rl = (native && native.rdpListener) || {};
    const cl = rl.connLog || (native && native.connLog) || null;
    if (!cl) return [];
    const items = asList(cl.items && cl.items.length ? cl.items : cl.newest);
    return items.map((e: Any, i: number) => ({
      id: String(i),
      timeUtc: String(e.timeUtc || ""),
      provider: String(e.provider || ""),
      reason: String(e.reason || ""),
      level: String(e.level || ""),
      desc: String(e.desc || ""),
    }));
  }, [native]);
}

export function SchannelTable({ maxHeight }: { maxHeight?: string }) {
  const rows = useSchannelEvents();
  const columns: Column<SchannelRow>[] = [
    { key: "timeUtc", label: "time (UTC)", render: (r) => <span className="font-mono text-xs">{r.timeUtc.replace("T", " ").replace(/\..*/, "")}</span>, sortValue: (r) => r.timeUtc },
    { key: "id", label: "event ID", render: (r) => <span className="font-mono">{r.desc ? r.desc.split(" ")[0] : "-"}</span> },
    { key: "provider", label: "provider", render: (r) => <span className="text-xs">{r.provider}</span> },
    { key: "reason", label: "reason", render: (r) => <span className="text-xs">{r.reason}</span> },
    { key: "level", label: "level", render: (r) => <span className="text-xs font-mono">{r.level || "-"}</span> },
    { key: "desc", label: "detail", render: (r) => <span className="text-xs text-secondary break-all">{r.desc}</span> },
  ];
  return (
    <div>
      {rows.length > 0 && <span className="schannel-event-row" hidden />}
      <DataTable columns={columns} rows={rows} maxHeight={maxHeight} filterKeys={(r) => [r.timeUtc, r.provider, r.reason, r.desc].join(" ")} emptyText="no Schannel/RdpCoreTS events in window" />
    </div>
  );
}

export function BeaconJsonlViewer() {
  const native = useSessionStore((s) => s.native);
  // [F105 §2.5 / step-2 handoff] `Array.isArray((native && native.handlerChain) || [])`
  // was ALWAYS true - the `|| []` made the guard vacuous - so with an empty
  // store (native === null) the true branch dereferenced `native.handlerChain`
  // and the Telemetry page threw on mount, taking the whole tree down with it
  // (React unmounts everything when nothing catches). The check now tests the
  // value it dereferences, and keeps the original contract exactly: an array
  // passes through, anything else (null, object, string, undefined) is [].
  const chain: Any[] = Array.isArray((native as Any)?.handlerChain) ? ((native as Any).handlerChain as Any[]) : [];
  const beacons = asList(native && native.launcher && native.launcher.beacons);
  const lines: string[] = [];
  chain.forEach((e) => lines.push(JSON.stringify({ src: "chain", ts: e.ts, details: e.details })));
  beacons.forEach((b) => lines.push(JSON.stringify(typeof b === "object" ? { src: "beacon", ...b } : { src: "beacon", details: String(b) })));
  if (!lines.length) return <EmptyState text="no launcher chain / beacon rows yet - click WINDOWS AUTO-LOGIN" />;
  return (
    <div className="bg-sunken border border-default rounded-md p-3 font-mono text-xs text-text-mono overflow-auto max-h-[480px]">
      {lines.map((l, i) => (
        <div key={i} className="beacon-jsonl-row whitespace-pre-wrap break-all py-0.5 border-b border-default/40 last:border-0">
          {l}
        </div>
      ))}
    </div>
  );
}
