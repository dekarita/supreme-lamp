// [F41 plan §5.5] Mirror page: MirrorCard hoisted full-width + upload history
// table (from /api/progress files) + runner egress note.
import { Database } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, DataTable, type Column } from "@/components/primitives/Data";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { MirrorHostMatrix } from "@/components/domain/MirrorHostMatrix";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { useSessionStore } from "@/stores/sessionStore";

interface HistRow {
  id: number;
  name: string;
  size: string;
  status: string;
  link: string;
}

export default function Mirror() {
  const { t } = useTranslation();
  const mirror = useTelemetryStore((s) => s.mirror);
  const native = useSessionStore((s) => s.native);
  const rows: HistRow[] = (mirror ? mirror.files : []).map((f, i) => ({
    id: i,
    name: f.name,
    size: f.size,
    status: f.status,
    link: f.link,
  }));
  const columns: Column<HistRow>[] = [
    { key: "name", label: "file", render: (r) => <span className="break-all">{r.name}</span>, sortValue: (r) => r.name },
    { key: "size", label: "size", render: (r) => <span className="font-mono text-xs">{r.size}</span>, sortValue: (r) => r.size },
    { key: "status", label: "status", render: (r) => <span>{r.status}</span>, sortValue: (r) => r.status },
    {
      key: "link",
      label: "link",
      render: (r) =>
        r.link ? (
          <a href={r.link} target="_blank" rel="noopener" className="text-accent underline text-xs">
            open
          </a>
        ) : (
          "-"
        ),
    },
  ];

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Database className="size-5 text-accent" aria-hidden />
        <h2 className="text-xl font-semibold">{t("pages.mirrorPage.title")}</h2>
      </div>
      <MirrorCard />
      {/* [F47 §2] the F46 read-only probe matrix, live on the Mirror page. */}
      <MirrorHostMatrix />
      <Card title={t("pages.mirrorPage.history")} className="mb-4">
        <DataTable columns={columns} rows={rows} maxHeight="max-h-[420px]" />
      </Card>
      <Card title={t("pages.mirrorPage.egress")} className="mb-4">
        <p className="text-xs text-secondary">
          {t("mirror.runnerEgress")}: {(native && native.runnerEgressIp) || "..."} · uploads execute on the runner; your PC&apos;s connection is never used (see the
          banner on Overview). Historical bandwidth series are carried in /api/progress speedHistory (last 90 samples).
        </p>
      </Card>
    </div>
  );
}
