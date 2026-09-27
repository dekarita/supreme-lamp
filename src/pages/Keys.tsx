// [F41 plan §5.4] Keys & Secrets page: full-width keys card + reveal audit
// note (sensitive: gated). Rotation timestamps come from native-status when
// reported.
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/primitives/Data";
import { KeysCard } from "@/components/domain/KeysCard";
import { useSessionStore } from "@/stores/sessionStore";

export default function Keys() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const s = native || {};
  const audit = s.copyAudit || [];
  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <KeyRound className="size-5 text-accent" aria-hidden />
        <h2 className="text-xl font-semibold">{t("nav.keys")}</h2>
      </div>
      <KeysCard />
      <Card title="Reveal audit (last 10)" className="mb-4">
        {Array.isArray(audit) && audit.length ? (
          <ul className="text-xs font-mono text-secondary flex flex-col gap-1">
            {audit.slice(-10).map((e: { ts?: string; action?: string }, i: number) => (
              <li key={i}>
                {String(e.ts || "")} {String(e.action || "")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-tertiary">
            No reveal audit rows are reported by this server build. Copy actions on this page use navigator.clipboard and toast only; no copy events leave the browser
            (F27: secret payloads travel from the authenticated config state to the clipboard, nowhere else).
          </p>
        )}
      </Card>
    </div>
  );
}
