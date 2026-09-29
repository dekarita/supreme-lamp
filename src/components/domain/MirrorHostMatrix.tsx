// [F47 §2] MIRROR HOST MATRIX. The F46 read-only probe rows {host,status,note}
// are already produced by Invoke-F46HostProbe and served by /diag
// (mirrorHosts) - before F47 they were only visible in the raw Diagnose drawer
// and the CI artifact, so the operator could not see gofile reachability from
// the runner egress without opening an artifact. This card renders the SAME
// rows on the Mirror page, live, with a refresh.
//
// A 403/401/"blocked from egress" row is a documented POLICY dead-end, not a
// puzzle: the card renders the two honest operator options from
// docs/MIRROR-HOSTS.md (operator-owned VPS egress, or accept the mirror as
// unavailable). No evasion is offered, suggested or performed here.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Radar, RefreshCw } from "lucide-react";
import { Card, EmptyState } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { mirrorBytes } from "@/lib/domain/mirrorBytes";
import { StatusDot } from "@/components/primitives/Chip";

export interface ProbeRow {
  host: string;
  status: string;
  note: string;
  maxFileBytes?: string | null;
  maxProvenBytes?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asRows(v: any): ProbeRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => ({
    host: String((r && r.host) ?? "-"),
    status: String((r && r.status !== null && r.status !== undefined && r.status !== "" ? r.status : "-")),
    note: String((r && r.note) ?? ""),
    maxFileBytes: r?.maxFileBytes == null ? null : String(r.maxFileBytes),
    maxProvenBytes: r?.maxProvenBytes == null ? null : String(r.maxProvenBytes),
  }));
}

// Blocked-from-egress = an egress/policy level rejection (403/401) or a note
// that says the runner egress was rejected. Both mean "operator decision",
// never "try harder from this runner".
export function isBlockedRow(r: ProbeRow): boolean {
  const s = r.status.trim();
  if (s === "403" || s === "401") return true;
  return /runner egress rejected|blocked-from-egress|policy\/endpoint level rejection/i.test(r.note);
}

export function MirrorHostMatrix() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ProbeRow[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const r = await fetch("/diag", { cache: "no-store" });
      const d = r.ok ? await r.json() : null;
      if (!d) {
        setRows([]);
        setNote(t("mirrorHostMatrix.unreachable"));
        return;
      }
      setRows(asRows(d.mirrorHosts));
      setNote("");
    } catch {
      setRows([]);
      setNote(t("mirrorHostMatrix.unreachable"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = rows || [];
  const blocked = list.filter(isBlockedRow);
  const smallCaps = list.filter((r) => mirrorBytes(r.maxFileBytes) > 0n && mirrorBytes(r.maxFileBytes) < 100000000000n);
  const allBlocked = list.length > 0 && blocked.length === list.length;

  return (
    <Card
      id="sec-mirror-hosts"
      title={t("mirrorHostMatrix.title")}
      icon={<Radar className="size-4 text-tertiary" aria-hidden />}
      className="mb-4"
    >
      <p className="text-xs text-tertiary mb-2">{t("mirrorHostMatrix.subtitle")}</p>
      <div className="flex items-center gap-2 mb-2">
        <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void refresh()} disabled={busy}>
          {busy ? t("mirrorHostMatrix.refreshing") : t("actions.refresh")}
        </Button>
        <span className="text-xs text-tertiary" data-testid="mirror-host-matrix-count">
          {rows === null ? t("mirrorHostMatrix.loading") : list.length + " " + t("mirrorHostMatrix.rows")}
        </span>
      </div>
      {rows === null ? (
        <EmptyState text={t("mirrorHostMatrix.loading")} />
      ) : list.length === 0 ? (
        <EmptyState text={note || t("mirrorHostMatrix.empty")} />
      ) : (
        <div className="border border-default rounded-lg overflow-hidden" data-testid="mirror-host-matrix">
          <table className="w-full text-sm">
            <thead className="bg-raised">
              <tr className="border-b border-default text-left text-secondary">
                <th scope="col" className="px-3 py-2 font-medium">host</th>
                <th scope="col" className="px-3 py-2 font-medium">status</th>
                <th scope="col" className="px-3 py-2 font-medium">note</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i} className="border-b border-default last:border-0" data-testid="mirror-host-row">
                  <td className="px-3 py-1.5 font-mono text-xs">{r.host}</td>
                  <td className="px-3 py-1.5">
                    <StatusDot tone={r.status === "200" ? "success" : isBlockedRow(r) ? "danger" : "neutral"} />{" "}
                    <span className="font-mono text-xs" data-testid="mirror-host-status">{r.status}</span>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-secondary break-words" data-testid="mirror-host-note">{r.note}
                    <div className="font-mono mt-1" data-testid="mirror-cap-reality">advertised cap bytes={r.maxFileBytes ?? "unknown"} · upload-proven bytes={r.maxProvenBytes ?? "unknown"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {smallCaps.length > 0 && (
        <div role="alert" data-testid="mirror-cap-stop" className="mt-3 rounded-md border border-warning/40 p-3 text-xs text-secondary">
          STOP: guest cap is below 100 GB ({smallCaps.map((r) => r.maxFileBytes).join(", ")} bytes). Operator options: self-hosted target for this size class | accept the cap. No identity changes or account credentials.
        </div>
      )}
      {allBlocked && (
        <div
          className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-secondary"
          data-testid="mirror-host-operator-options"
        >
          <b className="text-primary">{t("mirrorHostMatrix.optionsTitle")}</b>
          <ul className="mt-1 list-disc pl-4 flex flex-col gap-1">
            <li>{t("mirrorHostMatrix.optionVps")}</li>
            <li>{t("mirrorHostMatrix.optionAccept")}</li>
            {/* [F48 §2] options for a "host requires account token" refusal. */}
            <li>{t("mirrorHostMatrix.optionDisable")}</li>
            <li>{t("mirrorHostMatrix.optionSelfHosted")}</li>
            <li>{t("mirrorHostMatrix.optionTokenFuture")}</li>
          </ul>
          <p className="mt-1 text-tertiary">{t("mirrorHostMatrix.optionsFooter")}</p>
        </div>
      )}
    </Card>
  );
}
