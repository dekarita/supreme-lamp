// [F41 plan §5.6] Telemetry page: telescope timeline full-height, launcher
// beacon chain (JSONL) with the logon + Schannel tables.
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/primitives/Data";
import { Tabs } from "@/components/primitives/Collapse";
import { TelescopeTimeline } from "@/components/domain/TelescopeTimeline";
import { LauncherBeaconViewer } from "@/components/domain/LauncherBeaconViewer";
import { LogonEventsTable, SchannelTable, BeaconJsonlViewer } from "@/components/domain/LogPanel";

export default function Telemetry() {
  const { t } = useTranslation();
  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Zap className="size-5 text-accent" aria-hidden />
        <h2 className="text-xl font-semibold">{t("pages.telemetryPage.title")}</h2>
      </div>

      <Card title={t("telescope.title")} className="mb-4">
        <TelescopeTimeline />
      </Card>

      <Tabs
        label={t("logs.title")}
        tabs={[
          { id: "logon", label: t("logs.logonEvents"), content: <LogonEventsTable maxHeight="max-h-[480px]" /> },
          { id: "schannel", label: t("logs.schannel"), content: <SchannelTable maxHeight="max-h-[480px]" /> },
          { id: "launcher", label: t("logs.launcher"), content: <BeaconJsonlViewer /> },
        ]}
      />

      <div className="mt-4">
        <LauncherBeaconViewer />
      </div>
    </div>
  );
}
