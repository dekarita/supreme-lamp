// [F41 plan §2 LauncherBeaconViewer] LAUNCHER drawer (id="drawerLauncher"):
// LIVE DISPATCH STATUS (F31c, 5 checks), handler chain, launcher beacon +
// stall verdict (F15), RUN CHECK, RDP LISTENER marks (F17), SERVER CONN LOG
// (F30) with the F37 bind line, launcher-version guard.
import { Check, Download, Server, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Drawer } from "@/components/primitives/Collapse";
import { Button } from "@/components/primitives/Button";
import { CopyButton } from "@/components/primitives/Copy";
import { useSessionStore, selectLiveDispatch, selectBeacon } from "@/stores/sessionStore";
import { rdpListenerMarks, srvConnLogModel, LAUNCHER_LOG } from "@/lib/domain/native";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/cn";

function Mark({ ok, label, fix }: { ok: boolean; label: string; fix?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {ok ? <Check className="size-3.5 text-success" aria-hidden /> : <X className="size-3.5 text-danger" aria-hidden />}
      <span>
        {label}
        {!ok && fix ? " - " + fix : ""}
      </span>
    </span>
  );
}

export function LauncherBeaconViewer() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const listenerOkFlag = useSessionStore((s) => s.listenerOkFlag);
  const beaconInvokedAt = useSessionStore((s) => s.beaconInvokedAt);
  const fireRunCheck = useSessionStore((s) => s.fireRunCheck);
  useNow(1000);

  const s = native || {};
  const rl = s.rdpListener || null;
  const ld = selectLiveDispatch(native);
  const beacon = selectBeacon(native, beaconInvokedAt, Date.now());
  const marks = rdpListenerMarks(rl);
  const cl = srvConnLogModel(s);
  const ageSec = s.rdpListenerAgeSec;
  const chain = Array.isArray(s.handlerChain) ? s.handlerChain : [];
  const audit = s.ticketAudit || {};

  return (
    <Drawer id="drawerLauncher" title={t("launcher.title")} icon={<Server className="size-4 text-tertiary" aria-hidden />}>
      <div className="flex flex-col gap-3">
        <div id="liveDispatchRow" className="flex flex-col items-stretch gap-1.5">
          <span className="text-xs font-semibold text-primary uppercase tracking-wide">{t("launcher.liveDispatch")}</span>
          <span id="liveDispatchSummary" className="text-sm" style={{ color: ld.ok ? "var(--color-success)" : "var(--color-danger)" }}>
            {native
              ? ld.ok
                ? "ALL GREEN - runner reachable, F31 bound, 36870 absent, credential stored, logon success"
                : "FAILING: " + ld.failed[0].detail + " | " + ld.failed[0].fix
              : "waiting for the first /api/native-status sample..."}
          </span>
          <span id="liveDispatchChecks" className="text-xs text-secondary whitespace-pre-wrap font-mono flex flex-col gap-0.5">
            {ld.checks.map((c) => (
              <span key={c.id} className="inline-flex items-start gap-1">
                {c.ok ? <Check className="size-3.5 text-success shrink-0 mt-0.5" aria-hidden /> : <X className="size-3.5 text-danger shrink-0 mt-0.5" aria-hidden />}
                <span>
                  {c.name}: {c.detail}
                  {!c.ok ? " | " + c.fix : ""}
                </span>
              </span>
            ))}
          </span>
          <span id="liveDispatchFix" className="text-xs text-warning" style={ld.ok ? { display: "none" } : undefined}>
            {ld.ok ? "" : ld.fix}
          </span>
          <span
            id="liveDispatchAcl"
            className={cn("items-center gap-2 flex-wrap", ld.failed.some((f) => f.id === "schannel" && (f.detail === "36870 present" || f.detail.indexOf("unreadable") >= 0)) ? "flex" : "hidden")}
          >
            <code id="liveDispatchAclCmd" className="font-mono text-xs bg-sunken border border-default rounded px-2 py-1">
              {`wevtutil qe System /q:"*[System[Provider[@Name='Schannel']]]" /c:10 /f:text | findstr "36870 36871"`}
            </code>
            <CopyButton value={`wevtutil qe System /q:"*[System[Provider[@Name='Schannel']]]" /c:10 /f:text | findstr "36870 36871"`} />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 py-1.5 border-b border-default">
          <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{t("launcher.chain")}</span>
          <span id="handoffChain" className="text-xs text-secondary font-mono break-all">
            {chain.length ? chain.map((e: { ts: string; details: string }) => e.ts + " " + e.details).join(" → ") : "no launcher steps yet"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 py-1.5 border-b border-default">
          <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{t("launcher.beacon")}</span>
          <span id="winBeacon" className={cn("font-mono text-xs", beacon.tone === "bad" ? "text-danger" : "text-secondary")}>
            {beacon.text}
          </span>
          <Button id="btnRunCheck" variant="secondary" size="sm" icon={<ShieldCheck className="size-3.5" aria-hidden />} title="fires ghrdp://check - a MessageBox on this PC proves the launcher exe runs (no server needed)" onClick={fireRunCheck}>
            {t("actions.runCheck")}
          </Button>
          <span className="text-xs text-tertiary">
            {t("launcher.log")}{" "}
            <code id="winBeaconLog" className="font-mono">
              {LAUNCHER_LOG}
            </code>
          </span>
          <CopyButton value={LAUNCHER_LOG} />
        </div>
        <div id="winBeaconStall" className={cn("text-xs text-danger", beacon.stall ? "" : "hidden")}>
          {beacon.stall}
        </div>

        <div id="rdpListenerRow" className="flex flex-col items-stretch gap-1.5">
          <span className="text-xs font-semibold text-primary uppercase tracking-wide">{t("launcher.listener")}</span>
          <span id="rdpListenerLine" className={cn("text-xs flex flex-wrap gap-x-3 gap-y-1", listenerOkFlag ? "text-secondary" : "text-danger")}>
            {marks.length === 0 ? (
              "probe not reported yet - re-dispatch (main.yml step \"RDP listener self-probe (F17)\")"
            ) : (
              marks.map((m, i) => <Mark key={i} ok={m.ok} label={m.label} fix={m.fix} />)
            )}
          </span>
          <span id="rdpListenerAge" className="text-[11px] text-tertiary">
            {typeof ageSec === "number" && !isNaN(ageSec) ? "probe age: " + ageSec + "s" : ""}
          </span>
        </div>

        <div id="srvConnLogRow" className="flex flex-col items-stretch gap-1.5">
          <span className="text-xs font-semibold text-primary uppercase tracking-wide">{t("launcher.connLog")}</span>
          <span id="srvConnLogState" className="text-xs" style={{ color: cl.stateTone === "warn" ? "var(--color-warning)" : cl.stateTone === "ok" ? "" : "var(--color-text-secondary)" }}>
            {cl.state || "collector not reported yet (server 30s tick reads both RDP Operational logs)"}
          </span>
          <span id="srvConnLogLines" className="text-xs text-secondary whitespace-pre-wrap font-mono">
            {cl.lines}
          </span>
          <span id="srvConnLogTls" className="text-xs" style={{ color: cl.tlsTone === "warn" ? "var(--color-warning)" : cl.tlsTone === "bad" ? "var(--color-danger)" : "" }}>
            {cl.tls}
          </span>
          <span id="srvConnLogBind" className="text-xs font-mono break-all" style={{ color: cl.bindTone === "warn" ? "var(--color-warning)" : cl.bindTone === "bad" ? "var(--color-danger)" : "" }}>
            {cl.bind}
          </span>
        </div>

        <div id="nrLauncherOutdatedRow" className={s.launcherOutdated === true ? "flex flex-wrap items-center gap-2 py-1.5" : "hidden"}>
          <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">Launcher</span>
          <span id="nrLauncherOutdated" className="text-xs text-warning">
            launcher outdated - re-run install.cmd once (
            <a href="/dl/ghrdp-handler-kit.zip" className="text-accent underline">
              DOWNLOAD INSTALL KIT
            </a>
            )
          </span>
          <span id="nrLauncherVersions" className="text-[11px] text-tertiary">
            installed: {(s.launcherSeenVersion as string) || "(no beacon yet)"} / current: {(s.launcherVersion as string) || "(unknown)"}
          </span>
        </div>

        <div className="hidden">
          <Download className="size-4" />
          <span>{String((audit.issued as number) || 0)}</span>
        </div>
      </div>
    </Drawer>
  );
}
