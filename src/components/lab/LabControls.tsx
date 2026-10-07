// [F106 §6] The mock controls panel - the operator's handle on the fake backend.
//
// Every row is an OBSERVED request the mounted section really made (the ledger),
// and the four buttons force what the NEXT one of those becomes. That ordering is
// the design: the lab can only fake a path the section has already asked for, so
// the panel is a record of real behaviour plus a lever on it, never a hand-kept
// list of endpoints that can drift away from the app (the F105 registry owns
// endpoints; this panel owns observations).
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { CopyButton } from "@/components/primitives/Copy";
import { LAB_MOCK_HEADER, LAB_SCENARIOS, ledgerSummary, pathSlug } from "@/lib/lab/labCore";
import type { LabLedgerRow, LabScenarioId } from "@/lib/lab/labCore";
import { cn } from "@/lib/cn";

export interface LabControlsProps {
  ledger: LabLedgerRow[];
  scenarios: Record<string, LabScenarioId>;
  enabled: boolean;
  reportValue: () => string;
  onScenario: (path: string, scenario: LabScenarioId) => void;
  onToggle: (on: boolean) => void;
  onClear: () => void;
}

export function LabControls({ ledger, scenarios, enabled, reportValue, onScenario, onToggle, onClear }: LabControlsProps) {
  const { t } = useTranslation();
  const summary = ledgerSummary(ledger);
  return (
    <section
      data-testid="feature-lab-controls"
      className="mt-4 rounded-lg border border-default bg-surface p-4"
      aria-label={t("featureLab.mockTitle")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-primary">{t("featureLab.mockTitle")}</h2>
        <Button
          data-testid="lab-mock-toggle"
          size="sm"
          variant={enabled ? "primary" : "outline"}
          aria-pressed={enabled}
          onClick={() => onToggle(!enabled)}
        >
          {enabled ? t("featureLab.mockOn") : t("featureLab.mockOff")}
        </Button>
        <span className="text-[11px] text-tertiary">{t("featureLab.readsOnly")}</span>
        <span className="ml-auto font-mono text-[11px] text-tertiary" data-testid="lab-ledger-summary">
          {summary.paths} / {summary.requests}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-tertiary">
        {t("featureLab.mockHint", { header: LAB_MOCK_HEADER })}
      </p>

      {ledger.length === 0 ? (
        <p className="mt-3 font-mono text-xs text-tertiary" data-testid="lab-ledger-empty">
          {t("featureLab.noRequests")}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {ledger.map((row) => (
            <li
              key={row.method + " " + row.path}
              data-testid={"lab-ledger-row-" + pathSlug(row.path)}
              className="flex flex-wrap items-center gap-2 rounded border border-default px-2 py-1.5"
            >
              <span className="font-mono text-[11px] text-secondary">
                {row.method} {row.path}
              </span>
              <span className="font-mono text-[11px] text-tertiary">×{row.count}</span>
              {row.kind !== "passthrough" ? (
                <span className="rounded bg-warning/15 px-1 text-[10px] font-medium text-warning">
                  {t("featureLab.mockBadge", { scenario: row.scenario })}
                </span>
              ) : null}
              <span className="ml-auto flex flex-wrap items-center gap-1">
                {LAB_SCENARIOS.map((id) => (
                  <Button
                    key={id}
                    data-testid={"lab-scenario-" + pathSlug(row.path) + "-" + id}
                    size="sm"
                    variant={scenarios[row.path] === id ? "primary" : "outline"}
                    aria-pressed={scenarios[row.path] === id}
                    onClick={() => onScenario(row.path, id)}
                  >
                    {t("featureLab.scenario." + id)}
                  </Button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CopyButton data-testid="lab-copy-report" label={t("featureLab.copyReport")} value={reportValue} />
        <Button data-testid="lab-clear-ledger" size="sm" variant="secondary" icon={<X className="size-3.5" />} onClick={onClear}>
          {t("featureLab.clearLedger")}
        </Button>
        <span className={cn("text-[11px]", enabled ? "text-tertiary" : "text-warning")}>
          {enabled ? t("featureLab.mockHintRead") : t("featureLab.mocksOff")}
        </span>
      </div>
    </section>
  );
}
