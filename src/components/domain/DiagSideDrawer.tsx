// [F41] Side drawer for /diag output (ids: drawer, drawerScrim, diagBox -
// F38 parity), Escape closes (WCAG 2.1.2 no keyboard trap).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/primitives/Button";
import { CopyButton } from "@/components/primitives/Copy";
import { RefreshCw, X } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { cn } from "@/lib/cn";

export function DiagSideDrawer() {
  const { t } = useTranslation();
  const open = useSessionStore((s) => s.diagOpen);
  const text = useSessionStore((s) => s.diagText);
  const setDiag = useSessionStore((s) => s.setDiag);
  const runDiag = useSessionStore((s) => s.runDiag);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDiag(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setDiag]);

  return (
    <>
      <div id="drawerScrim" className={cn("fixed inset-0 z-40 bg-black/40", open ? "" : "hidden")} onClick={() => setDiag(false)} aria-hidden />
      <aside
        id="drawer"
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-surface border-l border-default shadow-md flex flex-col transition-transform duration-med",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <header className="flex items-center gap-2 px-4 h-12 border-b border-default">
          <h3 className="text-sm font-semibold text-primary">{t("diagnostics.drawerTitle")}</h3>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void runDiag()}>
              {t("actions.refresh")}
            </Button>
            <CopyButton value={text} label="copy diag" />
            <IconButton icon={<X className="size-4" />} label={t("actions.close")} onClick={() => setDiag(false)} />
          </div>
        </header>
        <div className="flex-1 overflow-auto p-4">
          <pre id="diagBox" className="font-mono text-xs text-text-mono whitespace-pre-wrap break-all bg-sunken border border-default rounded-md p-3">
            {text || t("diagnostics.refreshHint")}
          </pre>
        </div>
      </aside>
    </>
  );
}
