// [F41 plan §2 MirrorCard] Mirror card (id="sec-mirror"): honest progress ring
// (capped 99.9 until done==total), 6-stat grid (v1 mini-grid ids kept),
// active-file bar, speed sparkline, per-root chips, publish status, file
// table, and the four mirror actions (flush/launch/diag/copy-links).
import { Copy, Play, Search, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, EmptyState, ProgressRing } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { StatusDot } from "@/components/primitives/Chip";
import { useToast } from "@/components/primitives/Feedback";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { useSessionStore } from "@/stores/sessionStore";
import { getJson } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { Sparkline } from "./ConnectionCard";
import { cn } from "@/lib/cn";

export function MirrorCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const mirror = useTelemetryStore((s) => s.mirror);
  const speedHistory = useTelemetryStore((s) => s.speedHistory);
  const runDiag = useSessionStore((s) => s.runDiag);
  const native = useSessionStore((s) => s.native);
  const m = mirror;
  // [F46 §4] ENCRYPTION HONESTY: the card claims exactly what the worker
  // reported. "AES-256 encrypted upload" only when a file row carries
  // encrypted=True; a config that asks for AES-256 while this build cannot
  // encrypt says so; the shipped default (encryptMode=none) says plaintext.
  const claimTitle = !m
    ? t("mirror.titleLong")
    : m.encryptedAny
      ? t("mirror.titleLong")
      : m.encryptRequested
        ? t("mirror.titleEncryptLocked")
        : t("mirror.titlePlain");

  async function doFlush() {
    await getJson("/launch");
    const d = await getJson("/flush");
    if (d && (d as { ok?: boolean }).ok) toast.ok("Flush requested - watcher will upload everything");
    else toast.bad("Flush failed - server not reachable");
  }
  async function doLaunch() {
    const d = await getJson("/launch");
    if (d && (d as { ok?: boolean }).ok) toast.ok("Watcher start requested");
    else toast.bad("Launch failed - server not reachable");
  }
  async function copyAllLinks() {
    const d = useTelemetryStore.getState().progress;
    const out: string[] = [];
    if (d) {
      if (d.legacyIndexUrl) out.push("LEGACY RENTRY: " + d.legacyIndexUrl);
      if (d.rentryNewUrl) out.push("NEW RENTRY: " + d.rentryNewUrl);
      if (d.mirrorIndexUrl) out.push("TELEGRAPH: " + d.mirrorIndexUrl);
      const fl = d.files || [];
      for (let i = 0; i < fl.length; i++) if (fl[i].link) out.push(fl[i].name + ": " + fl[i].link);
    }
    if (out.length === 0) {
      toast.warn("No links yet");
      return;
    }
    void copyText(out.join("\n"));
  }

  const tile = "flex flex-col gap-0.5 rounded-md border border-default bg-raised/40 px-3 py-2";

  return (
    <Card id="sec-mirror" title={claimTitle} icon={<Upload className="size-4 text-tertiary" aria-hidden />} className="mb-4">
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-4">
          <ProgressRing fillId="ringFill" gradId="ringGrad" pct={m ? Number(m.pctText.replace("%", "")) : 0} label={t("mirror.progress")} size={80} />
          <div className="flex flex-col gap-1">
            <b id="stOverall" className="font-mono text-xl text-primary">
              {m ? m.pctText : "0%"}
            </b>
            <span className="text-xs text-tertiary">{t("mirror.overall")}</span>
            <b id="aggBar" aria-hidden style={{ position: "absolute", left: -9999, top: -9999 }}>
              {m ? m.pctText : "0%"}
            </b>
            <div className="flex items-center gap-1.5 text-xs">
              <span id="pubDot" className={"inline-block size-2 rounded-full " + (m?.pubDot === "ok" ? "bg-success" : m?.pubDot === "warn" ? "bg-warning" : "bg-border-strong")} aria-hidden />
              <span id="pubTxt" className="text-secondary">{m ? m.pubTxt : "Publish status: unknown"}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1 text-xs text-tertiary font-mono">
          <span>
            {t("mirror.files")} <b id="stDone" className="text-secondary">{m ? m.done : "0/0"}</b>
          </span>
          <span>
            {t("mirror.failed")} <b id="stFailed" className="text-secondary">{m ? m.failed : "0"}</b>
          </span>
          <span>
            {t("mirror.bytes")} <b id="stBytes" className="text-secondary">{m ? m.bytes : "0 B"}</b> <span id="stBytesSub">{m ? m.bytesSub : "of 0 B"}</span>
          </span>
          <span>
            {t("mirror.speed")} <b id="stSpeed" className="text-secondary">{m ? m.speed : "0 B/s"}</b>
          </span>
          <span>
            {t("mirror.scans")} <b id="stScans" className="text-secondary">{m ? m.scans : "0"}</b> <span id="stScansSub">{m ? m.scansSub : "last: -"}</span>
          </span>
          <span>
            {t("mirror.eta")} <b id="stEta" className="text-secondary">{m ? m.eta : "-"}</b>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-4" data-testid="mirror-mini-grid">
        <div className={tile} id="stDoneTile-wrap">
          <span className="text-xs text-tertiary uppercase">{t("mirror.files")}</span>
          <span id="stDoneTile" className="font-mono text-sm text-primary">{m ? m.done : "0/0"}</span>
          <span className="text-xs text-tertiary">{t("mirror.doneTotal")}</span>
        </div>
        <div className={cn(tile, "relative")} id="tileFailed">
          <span className="text-xs text-tertiary uppercase">{t("mirror.failed")}</span>
          <span id="stFailedTile" className="font-mono text-sm text-primary">{m ? m.failed : "0"}</span>
          <span className="text-xs text-tertiary">{t("mirror.afterTries")}</span>
        </div>
        <div className={tile}>
          <span className="text-xs text-tertiary uppercase">{t("mirror.bytes")}</span>
          <span id="stBytesTile" className="font-mono text-sm text-primary">{m ? m.bytes : "0 B"}</span>
          <span id="stBytesSubTile" className="text-xs text-tertiary">{m ? m.bytesSub : "of 0 B"}</span>
        </div>
        <div className={tile}>
          <span className="text-xs text-tertiary uppercase">{t("mirror.speed")}</span>
          <span id="stSpeedTile" className="font-mono text-sm text-primary">{m ? m.speed : "0 B/s"}</span>
          <span className="text-xs text-tertiary">{t("mirror.movingAvg")}</span>
        </div>
        <div className={tile}>
          <span className="text-xs text-tertiary uppercase">{t("mirror.scans")}</span>
          <span id="stScansTile" className="font-mono text-sm text-primary">{m ? m.scans : "0"}</span>
          <span id="stScansSubTile" className="text-xs text-tertiary">{m ? m.scansSub : "last: -"}</span>
        </div>
        <div className={tile}>
          <span className="text-xs text-tertiary uppercase">{t("mirror.eta")}</span>
          <span id="stEtaTile" className="font-mono text-sm text-primary">{m ? m.eta : "-"}</span>
          <span className="text-xs text-tertiary">{t("mirror.timeRemaining")}</span>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-default bg-raised/40 p-3" aria-label={t("mirror.activeFile")}>
        <div className="flex items-center justify-between gap-2">
          <span id="activeName" className="text-sm text-primary truncate">
            {m ? m.activeName : "idle - no active file"}
          </span>
          <span id="activePhase" className="text-xs text-tertiary font-mono">
            {m ? m.activePhase : "-"}
          </span>
        </div>
        <div className="mt-2 h-1.5 rounded bg-sunken overflow-hidden">
          <i id="activeBar" className="block h-full bg-accent transition-[width] duration-med" style={{ width: (m ? m.activePct : 0) + "%" }} />
        </div>
        <div className="flex justify-between text-xs text-tertiary mt-1 font-mono">
          <span id="activeBytes">{m ? m.activeBytes : "0 B / 0 B"}</span>
          <span id="activePct">{m ? m.activePct.toFixed(0) : "0"}%</span>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-tertiary mb-1">
          <span>{t("mirror.speedHistory")}</span>
          <span id="sparkNow" className="font-mono text-secondary">
            {m ? m.speed : "0 B/s"}
          </span>
        </div>
        <Sparkline id="sparkline" samples={speedHistory} width={800} height={112} />
      </div>

      <div id="rootsWrap" className="flex flex-wrap gap-2 mt-3" aria-label={t("mirror.perRoot")}>
        {(m ? m.roots : []).map((r, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded bg-raised border border-default px-2 py-0.5 text-xs text-secondary">
            <span className="text-tertiary">{t("mirror.root")}</span> {r}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mt-4">
        <Button variant="primary" size="sm" icon={<Upload className="size-3.5" aria-hidden />} onClick={() => void doFlush()}>
          {t("actions.uploadNow")}
        </Button>
        <Button variant="secondary" size="sm" icon={<Play className="size-3.5" aria-hidden />} onClick={() => void doLaunch()}>
          {t("actions.startWatcher")}
        </Button>
        <Button variant="secondary" size="sm" icon={<Search className="size-3.5" aria-hidden />} onClick={() => void runDiag()}>
          {t("actions.diagnose")}
        </Button>
        <Button variant="secondary" size="sm" icon={<Copy className="size-3.5" aria-hidden />} onClick={() => void copyAllLinks()}>
          {t("actions.copyAllLinks")}
        </Button>
      </div>

      <div className="mt-4 border border-default rounded-lg overflow-hidden">
        <div className="overflow-auto max-h-[320px]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-raised z-10">
              <tr className="border-b border-default text-left text-secondary">
                <th scope="col" className="px-3 py-2 font-medium">file</th>
                <th scope="col" className="px-3 py-2 font-medium">phase</th>
                <th scope="col" className="px-3 py-2 font-medium min-w-[120px]">progress</th>
                <th scope="col" className="px-3 py-2 font-medium">size</th>
                <th scope="col" className="px-3 py-2 font-medium">status</th>
                <th scope="col" className="px-3 py-2 font-medium">error</th>
                <th scope="col" className="px-3 py-2 font-medium">link</th>
              </tr>
            </thead>
            <tbody id="fileRows">
              {!m || m.files.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-tertiary px-3 py-4">
                    <EmptyState text="no files processed yet" />
                  </td>
                </tr>
              ) : (
                m.files.map((f, i) => (
                  <tr key={i} className={cn("border-b border-default last:border-0", f.expired && "opacity-60")}>
                    <td className="px-3 py-1.5 break-all">{f.name}</td>
                    <td className="px-3 py-1.5 text-tertiary">{f.phase}</td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block w-24 h-1 rounded bg-sunken overflow-hidden align-middle">
                          <i className="block h-full bg-accent" style={{ width: f.pct + "%" }} />
                        </span>
                        <span className="text-xs text-tertiary font-mono">{f.pct.toFixed(0)}%</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{f.size}</td>
                    <td className="px-3 py-1.5">
                      <StatusDot
                        tone={f.status === "done" || f.status === "active" ? "success" : f.status === "failed" || f.status === "expired" ? "danger" : "neutral"}
                      />{" "}
                      <span className="text-xs">{f.status}</span>
                    </td>
                    {/* [F46 §1] NEVER truncated: the complete phase/status/message
                        (and every attempt line behind it) is in the DOM. The
                        summary only collapses it; no slice, no CSS truncation. */}
                    <td className="px-3 py-1.5 text-xs text-danger align-top max-w-[380px]" data-testid="mirror-error-cell">
                      {f.error ? (
                        <details data-testid="mirror-reason">
                          <summary className="cursor-pointer break-words whitespace-normal" data-testid="mirror-reason-summary">
                            {t("mirror.showReason")}
                          </summary>
                          <div
                            className="mt-1 max-w-[380px] whitespace-pre-wrap break-all font-mono text-[11px] text-danger"
                            data-testid="mirror-reason-full"
                          >
                            {f.error}
                          </div>
                          {f.attempts.length > 0 && (
                            <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-secondary" data-testid="mirror-attempts">
                              {f.attempts.map((a) => (
                                <li key={a.n} className="font-mono whitespace-pre-wrap break-all">
                                  {a.line}
                                </li>
                              ))}
                            </ul>
                          )}
                        </details>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {f.expired ? (
                        <span className="text-xs text-tertiary">expired</span>
                      ) : f.link ? (
                        <a href={f.link} target="_blank" rel="noopener" className="text-accent underline text-xs">
                          open
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="text-xs text-tertiary mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {t("mirror.runnerEgress")}: {(native && native.runnerEgressIp) || "..."}
        </span>
        <span className="font-mono" data-testid="mirror-encrypt-honesty">
          {t("mirror.encryptMode")}={m ? m.encryptMode : "none"} · {t("mirror.encryptedRows")}=
          {m && m.encryptedAny ? "yes" : "no"}
          {/* [F47 §3] the algorithm the WORKER reported, never an assumption. */}
          {m && m.encryptedAny ? " · " + t("mirror.encryptAlg") + "=" + (m.encAlg || "AES-256") : ""}
        </span>
      </div>
    </Card>
  );
}
