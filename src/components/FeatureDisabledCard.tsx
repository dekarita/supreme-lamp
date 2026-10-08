// [F109 §4] What a section renders while the Debug HUD has it switched off.
//
// [F110 §3] The copy names BOTH enablers, because F110's patches switch a section off
// through this same map (one source of truth, by design) and a card that blamed only the
// HUD would send the operator to the wrong place to undo it. tests/f110-live-patch.test.js
// F110-i pins the sentence, so a future edit cannot quietly drop the F110 half.
//
// Lives in its own file on purpose: FeatureBoundary.tsx's first
// `data-testid={"…" + feature}` literal is pinned to "feature-boundary-" by F105-k,
// and the boundary must stay free of storage tokens (F105-j) - this card reaches
// storage only through lib/featureToggles. English-only like the rest of the
// developer surface (Settings ▸ "Secret hygiene" is the precedent): the HUD is a
// default-off dev tool, so it moves no i18n count lock.
import { Button } from "@/components/primitives/Button";
import { setFeatureToggle } from "@/lib/featureToggles";
import type { FeatureId } from "@/lib/featureRegistry";

export default function FeatureDisabledCard({ feature, onEnable }: { feature: FeatureId; onEnable: () => void }) {
  return (
    <div
      data-testid={"feature-disabled-" + feature}
      role="status"
      className="rounded-lg border border-warning/60 bg-surface p-5 text-sm text-secondary"
    >
      <p className="font-semibold text-primary">Section &quot;{feature}&quot; is switched off by the Debug HUD (F109) or a live patch (F110).</p>
      <p className="mt-1">This is a dev-time toggle: nothing is broken. Re-enable it here, in the HUD&apos;s Toggles panel (Shift+F12), or with Settings &gt; Live Patch &gt; Roll back (F110).</p>
      <Button
        data-testid={"feature-disabled-" + feature + "-enable"}
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={() => {
          setFeatureToggle(feature, false);
          onEnable();
        }}
      >
        Re-enable section
      </Button>
    </div>
  );
}
