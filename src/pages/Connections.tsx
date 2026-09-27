// [F41 plan §5.3] Connections page: the connection card re-used (canonical
// regression ids stay on the Overview - this page renders the same data via
// its own detail rows), plus diagnostics drawer open by default and mstsc
// quick actions (copy + .rdp download via the existing /rdp endpoint).
import { useTranslation } from "react-i18next";
import { Card } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { CopyButton } from "@/components/primitives/Copy";
import { ConnectionCard } from "@/components/domain/ConnectionCard";
import { DiagnosticsDrawer } from "@/components/domain/DiagnosticsDrawer";
import { useSessionStore } from "@/stores/sessionStore";
import { Chip } from "@/components/primitives/Chip";

export default function Connections() {
  const { t } = useTranslation();
  const fqdn = useSessionStore((s) => s.fqdn);
  const ip = useSessionStore((s) => s.ip);
  const user = useSessionStore((s) => s.user);
  const mstsc = "mstsc /v:" + (fqdn || ip || "<host>");

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-xl font-semibold">{t("pages.connections.title")}</h2>
        <Chip tone={fqdn ? "success" : "warning"} dot>
          {fqdn || "fqdn pending"}
        </Chip>
      </div>

      <Card title="Quick actions" className="mb-4">
        <div className="flex flex-wrap gap-2">
          <CopyButton value={mstsc} label="mstsc command" size="md" />
          <Button variant="secondary" size="sm" onClick={() => window.open(ip ? "http://" + ip + ":7331/rdp" : "/rdp", "_blank", "noopener")}>
            {t("actions.download")} .rdp
          </Button>
        </div>
        <p className="text-xs text-tertiary mt-2">user: {user || "--"} · the .rdp carries no credentials (prompt for credentials:i:1)</p>
      </Card>

      <ConnectionCard />
      <DiagnosticsDrawer />
    </div>
  );
}
