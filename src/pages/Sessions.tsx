// [F41 plan §5.2] Sessions page: active runner card, 4624/4625 event table,
// ticket audit StatCards. No regression ids duplicated here (canonical ids
// live on the Overview; plan §9.2 maps each id exactly once).
import { Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, StatCard } from "@/components/primitives/Data";
import { LogonEventsTable } from "@/components/domain/LogPanel";
import { useSessionStore } from "@/stores/sessionStore";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { fmtHMS, pad2 } from "@/lib/format";
import { elapsedSeconds } from "@/stores/telemetryStore";
import { useNow } from "@/lib/useNow";

export default function Sessions() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const fqdn = useSessionStore((s) => s.fqdn);
  const ip = useSessionStore((s) => s.ip);
  const runStartedAtMs = useTelemetryStore((s) => s.runStartedAtMs);
  const serverNow = useTelemetryStore((s) => s.serverNow);
  useNow(1000);

  const s = native || {};
  const audit = s.ticketAudit || {};
  const rl = s.rdpListener || {};
  const ae = rl.authEvents || {};
  const now = serverNow();
  const el = elapsedSeconds(runStartedAtMs, now);
  const startedText = runStartedAtMs ? new Date(runStartedAtMs).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "not reported yet";

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Clock className="size-5 text-accent" aria-hidden />
        <h2 className="text-xl font-semibold">{t("pages.sessions.title")}</h2>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard label="4624 accepted" value={ae.count4624 != null ? Number(ae.count4624) : 0} mono testId="audit-4624" />
        <StatCard label="4625 rejected" value={ae.count4625 != null ? Number(ae.count4625) : 0} mono tone={Number(ae.count4625) > 0 ? "warn" : undefined} testId="audit-4625" />
        <StatCard label={t("pages.sessions.ticketAudit") + " · issued"} value={Number(audit.issued) || 0} mono />
        <StatCard label="redeemed / rejected" value={(Number(audit.redeemed) || 0) + " / " + (Number(audit.rejected) || 0)} mono />
      </div>

      <Card title={t("pages.sessions.activeRunner")} className="mb-4">
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div>
            <dt className="text-xs text-tertiary uppercase">FQDN</dt>
            <dd className="font-mono text-text-mono break-all">{fqdn || "not reported yet"}</dd>
          </div>
          <div>
            <dt className="text-xs text-tertiary uppercase">Runner IP</dt>
            <dd className="font-mono text-text-mono">{ip || "--"}</dd>
          </div>
          <div>
            <dt className="text-xs text-tertiary uppercase">Uptime</dt>
            <dd className="font-mono text-text-mono">{el == null ? "--:--:--" : fmtHMS(el)}</dd>
          </div>
          <div>
            <dt className="text-xs text-tertiary uppercase">Started</dt>
            <dd className="font-mono text-text-mono">{startedText}</dd>
          </div>
        </dl>
        <p className="text-xs text-tertiary mt-2">
          clock {pad2(new Date(now).getHours())}:{pad2(new Date(now).getMinutes())}:{pad2(new Date(now).getSeconds())} (server-synced)
        </p>
      </Card>

      <LogonEventsTable maxHeight="max-h-[560px]" />
    </div>
  );
}
