// [F106 §7] FeatureLab - one section, mounted alone, with the mock lever beside it.
//
// THE SHAPE OF THE PAGE. A header that says WHICH section this is and how to get
// back to the real route, the controls panel (LabControls), and then the section
// itself - the shipped component, mounted bare, so what the operator sees here is
// what the real route renders.
//
// THE FENCE. App.tsx resolves the route parameter and wraps this page in
// <FeatureBoundary feature={id}> (the same fence the real route uses, addressed
// with the *lab's* feature id). So a crash in the harness degrades exactly like a
// crash on the real route: a card with Retry / Reload / Copy, the rest of Mission
// Control alive, and one Collector row. The smoke gate proves that by making a
// section throw (see src/tests/smoke/f106-lab-isolation.test.tsx).
//
// THE INTERCEPTOR'S LIFETIME IS THIS COMPONENT'S LIFETIME. installLabFetchMock()
// runs in an effect and its uninstaller runs on unmount, so leaving the lab -
// by any route, including an unmount React performs for its own reasons - restores
// the original window.fetch. Nothing global outlives the page.
import { useEffect, useMemo } from "react";
import { Link, NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { boundaryTestId, featureById, mountedFeatureIds } from "@/lib/featureRegistry";
import { LAB_SECTIONS } from "./labSections";
import { LabControls } from "./LabControls";
import { installLabFetchMock } from "@/lib/lab/mockBackend";
import { useLabStore } from "@/lib/lab/labStore";
import { labReport } from "@/lib/lab/labCore";
import { labIndexRoute } from "@/lib/lab/labFlags";
import type { FeatureId } from "@/lib/featureRegistry";

export interface FeatureLabProps {
  feature: FeatureId;
}

export default function FeatureLab({ feature }: FeatureLabProps) {
  const { t } = useTranslation();
  const desc = featureById(feature);
  const enabled = useLabStore((s) => s.enabled);
  const scenarios = useLabStore((s) => s.scenarios);
  const ledger = useLabStore((s) => s.ledger);
  const setScenario = useLabStore((s) => s.setScenario);
  const setEnabled = useLabStore((s) => s.setEnabled);
  const clearLedger = useLabStore((s) => s.clearLedger);
  const Section = LAB_SECTIONS[feature];

  useEffect(() => {
    if (!enabled) return undefined;
    return installLabFetchMock();
  }, [enabled]);

  const report = useMemo(
    () => () =>
      JSON.stringify(
        labReport({
          ts: new Date().toISOString(),
          feature,
          route: realRoute(feature),
          build: __BUILD_SHA__,
          enabled,
          scenarios,
          ledger,
          mounted: mountedFeatureIds(),
        }),
        null,
        1
      ),
    [feature, enabled, scenarios, ledger]
  );

  return (
    <div data-testid={"feature-lab-" + feature} id={"f106.lab." + feature} className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={labIndexRoute()}
          data-testid="lab-back"
          className="inline-flex items-center gap-1 text-xs text-tertiary hover:text-primary"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {t("featureLab.back")}
        </Link>
        <h1 className="text-base font-semibold text-primary">{t(desc.navKey)}</h1>
        <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-secondary">{desc.id}</span>
        <NavLink
          to={desc.route}
          data-testid="lab-open-real"
          className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          {t("featureLab.openReal")}
          <ExternalLink className="size-3.5" aria-hidden />
        </NavLink>
      </div>
      <p className="mt-1 text-[11px] text-tertiary">
        {t("featureLab.meta", {
          route: desc.route,
          component: desc.component,
          fence: boundaryTestId(feature),
        })}
      </p>

      <LabControls
        ledger={ledger}
        scenarios={scenarios}
        enabled={enabled}
        reportValue={report}
        onScenario={setScenario}
        onToggle={setEnabled}
        onClear={clearLedger}
      />

      <section data-testid="feature-lab-stage" className="mt-4">
        <Section />
      </section>
    </div>
  );
}

/** The feature's REAL route (what "Open the real route" goes to). Named apart from
 *  featureLabPath(), which is the lab's own path - the two must not be confused. */
function realRoute(id: FeatureId): string {
  return featureById(id).route;
}
