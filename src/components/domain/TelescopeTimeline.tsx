// [F41 plan §2 TelescopeTimeline] ONE TIMELINE (F37 §3): client beacon stages +
// runner telescope + logon, sorted by stage order; death point + one targeted
// fix; per-click trace. RUN DIAG fires ghrdp://diag (read-only).
import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Drawer } from "@/components/primitives/Collapse";
import { Button } from "@/components/primitives/Button";
import { useSessionStore } from "@/stores/sessionStore";
import { selectTelemetry } from "@/stores/sessionStore";
import { telescopeSegmentText } from "@/lib/domain/telescope";
import { FQDN_RE } from "@/lib/format";

export function TelescopeTimeline() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const lastTrace = useSessionStore((s) => s.lastTrace);
  const fireRunDiag = useSessionStore((s) => s.fireRunDiag);
  const fqdn = useSessionStore((s) => s.fqdn);
  const tl = selectTelemetry(native);

  return (
    <Drawer id="drawerTelescope" title={t("telescope.title")} icon={<Activity className="size-4 text-tertiary" aria-hidden />}>
      <div id="telescopeRow" className="flex flex-col items-stretch gap-1.5">
        <span
          id="telescopeSummary"
          className="text-sm"
          style={{ color: tl.ok ? "var(--color-success)" : "var(--color-danger)" }}
        >
          {tl.ok
            ? "ALL GREEN - every observed segment on the path is ok (trace " + (tl.trace || "runner") + ")"
            : "DEATH POINT: " + tl.deathPoint + " - " + tl.fix}
        </span>
        <span id="telescopeSegments" className="text-xs text-secondary whitespace-pre-wrap font-mono">
          {tl.segments.map(telescopeSegmentText).join("\n")}
        </span>
        <span
          id="telescopeDeath"
          className="text-xs"
          style={{ color: tl.ok ? "" : "var(--color-warning)" }}
        >
          {tl.ok
            ? "first red segment: none - client stages (dns/tcp/tls/cred) and runner stages (listener/schannel/logon) all ok"
            : "first red segment: " + tl.deathPoint + " | one targeted fix: " + tl.fix}
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            data-testid="telemetry-run-diag"
            id="btnRunDiag"
            variant="secondary"
            size="sm"
            icon={<Activity className="size-3.5" aria-hidden />}
            title="fires ghrdp://diag - read-only client telescope: dns/tcp/tls/cred stages, no store, no mstsc, no credential prompt"
            onClick={() => {
              if (!FQDN_RE.test(fqdn)) return;
              fireRunDiag();
            }}
          >
            {t("actions.runDiag")}
          </Button>
          <span id="telescopeTrace" className="text-[11px] text-tertiary">
            {lastTrace
              ? "diag dispatched with trace " + lastTrace + " - each stage beacons into the timeline above"
              : native && native.telescopeClient && native.telescopeClient.newestTrace
                ? "last click trace: " + native.telescopeClient.newestTrace + " (client beacons carry it)"
                : "no click trace yet"}
          </span>
        </div>
      </div>
    </Drawer>
  );
}
