// [F106 §8] The lab index at `/#/lab` - the 11 harnesses, in sidebar order.
//
// Every row is DERIVED from the F105 registry (FEATURES = id, route, component,
// navKey, boundary test id). Nothing is hand-listed: a 12th section would appear
// here the moment it is registered, and the gate asserts the rendered count is the
// registry's count, so a dropped row fails rather than silently shrinking the page.
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { FEATURES, boundaryTestId, featureLabPath } from "@/lib/featureRegistry";

export default function LabIndex() {
  const { t } = useTranslation();
  return (
    <div data-testid="feature-lab-index" id="f106.lab.index" className="w-full">
      <h1 className="text-base font-semibold text-primary">{t("featureLab.indexTitle")}</h1>
      <p className="mt-1 max-w-3xl text-xs text-secondary">{t("featureLab.indexIntro")}</p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="feature-lab-index-list">
        {FEATURES.map((f) => (
          <li key={f.id} className="rounded-lg border border-default bg-surface p-3">
            <NavLink
              to={featureLabPath(f.id)}
              data-testid={"lab-index-link-" + f.id}
              className="text-sm font-medium text-accent hover:underline"
            >
              {t(f.navKey)}
            </NavLink>
            <p className="mt-1 font-mono text-[11px] text-tertiary">
              {f.route} · {f.component}
            </p>
            <p className="font-mono text-[11px] text-tertiary">{boundaryTestId(f.id)}</p>
          </li>
        ))}
      </ul>
      {/* [R-GLASS / #213] The glass harness is a static route, not a registry
          feature, so it is linked here instead of being folded into the 11
          derived rows above. */}
      <div className="mt-4 rounded-lg border border-default bg-surface p-3">
        <NavLink to="/lab/glass" data-testid="lab-index-link-glass" className="text-sm font-medium text-accent hover:underline">
          {t("glass.labTitle")}
        </NavLink>
        <p className="mt-1 text-[11px] text-secondary">{t("glass.labIntro")}</p>
        <p className="font-mono text-[11px] text-tertiary">/lab/glass · GlassLab</p>
      </div>
      <p className="mt-3 text-[11px] text-tertiary">{t("featureLab.readsOnly")}</p>
    </div>
  );
}
