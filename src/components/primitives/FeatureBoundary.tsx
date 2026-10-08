// [F105 §2] FeatureBoundary - one crash fence per feature, 11 in total.
//
// WHAT IT PREVENTS. React unmounts the WHOLE tree when a render throws and no
// boundary catches it (that is exactly what the step-2 DOM gate found on
// /#/telemetry: `BeaconJsonlViewer` dereferenced a null `handlerChain` and the
// entire Mission Control went blank, chrome included). A boundary turns that
// into one section showing a card the operator can act on: Retry, Reload, or
// Copy the error into the next Arena session.
//
// THREE RULES IT IS BUILT AROUND:
//   1. ZERO DOM DELTA WHEN HEALTHY. A healthy boundary returns `children`
//      directly - no wrapper element, no attribute, nothing for a layout or a
//      regression-id test to notice. (Proven in the F105 smoke gate by
//      comparing innerHTML with and without the wrapper.)
//   2. THE FACT IT IS ALIVE IS STILL OBSERVABLE. The boundary registers its
//      feature id in the registry's mount ledger on mount (and de-registers on
//      unmount), so a test can prove all 11 are mounted on their 11 routes
//      without adding anything to the DOM, and F109's HUD can read the same
//      ledger to say which sections are alive right now.
//   3. THE FAILURE IS REPORTED, NEVER UPLOADED. It publishes a window event
//      (see lib/featureBoundary.ts) and offers a clipboard copy. It performs no
//      fetch, no storage write and no new endpoint - the F-DVR-LITE/#169 lesson
//      applied to the diagnostic channel, enforced by a static rule in
//      tests/f105-feature-registry.test.js.
import React from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Button } from "@/components/primitives/Button";
import { CopyButton } from "@/components/primitives/Copy";
import { featureById, registerMountedFeature, type FeatureId } from "@/lib/featureRegistry";
import {
  emitFeatureBoundaryError,
  sanitizeBoundaryMessage,
  sanitizeBoundaryRoute,
  type FeatureBoundaryErrorDetail,
} from "@/lib/featureBoundary";
// [F109 §4] Debug HUD dev toggles. Read ONCE per mount (and on a feature change),
// so a toggle takes effect at the next route change. The read goes through
// lib/featureToggles - this file stays free of storage tokens (F105-j) - and is
// always false unless Settings ▸ Debug HUD is on (prod-safe default-off).
import { isFeatureToggledOff } from "@/lib/featureToggles";
import FeatureDisabledCard from "@/components/FeatureDisabledCard";

export interface FeatureBoundaryProps {
  feature: FeatureId;
  children: React.ReactNode;
}

interface FeatureBoundaryState {
  error: string | null;
  count: number;
  /** [F109 §4] switched off by the Debug HUD at mount time. */
  disabled: boolean;
}

/** The card the operator sees instead of a blank screen. */
function BoundaryFallback({
  feature,
  message,
  count,
  ts,
  onRetry,
}: {
  feature: FeatureId;
  message: string;
  count: number;
  ts: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const section = t(featureById(feature).navKey);
  const route = sanitizeBoundaryRoute(typeof window === "undefined" ? "/" : window.location.hash || window.location.pathname);
  const detail: FeatureBoundaryErrorDetail = {
    feature,
    section,
    message,
    route,
    count: Math.max(1, count),
    ts,
  };
  return (
    <div
      // The literal prefix is repeated from featureRegistry's
      // FEATURE_BOUNDARY_TESTID_PREFIX on purpose: tests/f-testid-coverage.test.js
      // rule c accepts only `"prefix-" + expr` / a member id as a derivation, and
      // a helper CALL reads as an unnamed dynamic id there. The Node gate
      // (F105-k) asserts these literals are byte-equal to the registry constant,
      // so the copy cannot drift.
      data-testid={"feature-boundary-" + feature}
      role="alert"
      aria-live="assertive"
      className="rounded-lg border border-danger/60 bg-surface p-5"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-primary">{t("boundary.title", { section })}</h2>
          <p className="mt-1 text-sm text-secondary">{t("boundary.body", { section })}</p>
          <p className="mt-2 font-mono text-xs text-text-mono break-all">
            {t("boundary.errorLabel")} {message}
          </p>
          <p className="mt-1 text-[11px] text-tertiary">
            {t("boundary.count", { count: Math.max(1, count), route })}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          data-testid={"feature-boundary-" + feature + "-retry"}
          variant="primary"
          size="sm"
          // Re-mount the section's subtree. The boundary stays installed, so a
          // deterministic crash lands right back here with count+1 instead of
          // taking the app down.
          onClick={onRetry}
        >
          {t("boundary.retry")}
        </Button>
        <Button
          data-testid={"feature-boundary-" + feature + "-reload"}
          variant="secondary"
          size="sm"
          onClick={() => {
            try {
              window.location.reload();
            } catch {
              /* jsdom and file:// contexts have no reload */
            }
          }}
        >
          {t("boundary.reload")}
        </Button>
        <CopyButton
          data-testid={"feature-boundary-" + feature + "-copy"}
          label={t("boundary.copy")}
          value={() => JSON.stringify(detail)}
        />
        <span className="text-[11px] text-tertiary">{t("boundary.hint")}</span>
      </div>
    </div>
  );
}

/**
 * [F105 §2.2] The fence. Wrap exactly one feature's route element with it.
 *
 * NOTE on i18n: the fallback renders through a function component so it uses
 * the normal `useTranslation()` path (a class cannot) - switch the language
 * while a section is crashed and the card follows, like every other surface.
 */
export default class FeatureBoundary extends React.Component<FeatureBoundaryProps, FeatureBoundaryState> {
  state: FeatureBoundaryState = { error: null, count: 0, disabled: isFeatureToggledOff(this.props.feature) };
  private unregister: (() => void) | null = null;
  private caughtAt = "";

  static getDerivedStateFromError(error: unknown): Partial<FeatureBoundaryState> {
    return { error: sanitizeBoundaryMessage(error) };
  }

  componentDidCatch(error: unknown, _info: React.ErrorInfo): void {
    this.caughtAt = new Date().toISOString();
    this.setState((s) => ({ count: s.count + 1 }));
    emitFeatureBoundaryError({
      feature: this.props.feature,
      // A class cannot call useTranslation(); the i18n instance carries the
      // current language, which is all a crash report needs.
      section: String(i18n.t(featureById(this.props.feature).navKey)),
      message: sanitizeBoundaryMessage(error),
      route: sanitizeBoundaryRoute(typeof window === "undefined" ? "/" : window.location.hash || window.location.pathname),
      count: this.state.count + 1,
      ts: this.caughtAt,
    });
  }

  componentDidMount(): void {
    this.unregister = registerMountedFeature(this.props.feature);
  }

  componentDidUpdate(prev: FeatureBoundaryProps): void {
    if (prev.feature !== this.props.feature) {
      if (this.unregister) this.unregister();
      this.unregister = registerMountedFeature(this.props.feature);
      const disabled = isFeatureToggledOff(this.props.feature);
      if (disabled !== this.state.disabled) this.setState({ disabled });
    }
  }

  componentWillUnmount(): void {
    if (this.unregister) this.unregister();
    this.unregister = null;
  }

  /** Clear the caught error so the subtree mounts again. */
  retry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <BoundaryFallback
          feature={this.props.feature}
          message={this.state.error}
          count={this.state.count}
          ts={this.caughtAt}
          onRetry={this.retry}
        />
      );
    }
    if (this.state.disabled) {
      return <FeatureDisabledCard feature={this.props.feature} onEnable={() => this.setState({ disabled: false })} />;
    }
    return this.props.children;
  }
}
