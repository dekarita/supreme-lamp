// [F106 §9] The route element for `/#/lab` and `/#/lab/:featureId`.
//
// WHY THE FENCE LIVES HERE AND NOT IN App.tsx's fence() HELPER. The helper takes a
// literal FeatureId (`fence("files", <X/>)`) and the F105 gate counts those calls;
// this route's feature is a PARAMETER, so the boundary must be constructed from a
// value. Doing it here keeps App.tsx's 13 literal fences intact while giving the
// lab route the same protection, addressed with the id that was actually asked
// for: `/#/lab/health` degrades into the health boundary card, and the smoke gate
// proves it by making that section throw.
//
// An unknown parameter renders a notice, not a crash and not a redirect: a deep
// link that names a section that no longer exists is exactly the kind of thing an
// operator should be able to READ (it names the id and the count) instead of
// bouncing to Overview and hiding the mistake.
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import FeatureBoundary from "@/components/primitives/FeatureBoundary";
import { FEATURE_IDS, FEATURE_REGISTRY } from "@/lib/featureRegistry";
import type { FeatureId } from "@/lib/featureRegistry";
import FeatureLab from "./FeatureLab";
import LabIndex from "./LabIndex";

function UnknownFeature({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="feature-lab-unknown" role="alert" className="rounded-lg border border-danger/60 bg-surface p-5">
      <h1 className="text-base font-semibold text-primary">{t("featureLab.unknown")}</h1>
      <p className="mt-1 text-sm text-secondary">{t("featureLab.unknownBody", { id, count: FEATURE_IDS.length })}</p>
    </div>
  );
}

export default function LabRoute() {
  const { featureId } = useParams<{ featureId: string }>();
  if (!featureId) return <LabIndex />;
  const id = featureId as FeatureId;
  if (!FEATURE_IDS.includes(id)) return <UnknownFeature id={featureId} />;
  return (
    <FeatureBoundary feature={id}>
      <FeatureLab feature={id} />
    </FeatureBoundary>
  );
}

/** The registry pattern, re-exported for the gate's route assertion (read-only). */
export const LAB_ROUTE_PATTERN = FEATURE_REGISTRY.labRoutePattern;
