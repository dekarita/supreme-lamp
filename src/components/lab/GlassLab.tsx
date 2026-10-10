// [R-GLASS / #213 §9 + #214] The glass lab at `/#/lab/glass`.
//
// NOT A SHOWROOM. Every surface on the stage is the SHIPPED component:
// GlassContainer, Card, the real Settings controls, the real pages. The only
// thing the harness owns is the lever — and the lever writes to the SAME
// persisted preference store the Settings page writes to, so a scenario that
// passes here cannot be passing against a parallel copy of the system.
//
// ISOLATION CONTRACT
//   * No backend scenario is faked here. The pages on the stage talk to the
//     real dashboard API exactly as they do on their own routes; anything
//     synthetic is labelled "Simulated" in the UI.
//   * The ONE thing the harness mutates is the operator's visual-quality
//     preference, and it restores the previous value on unmount — leaving the
//     lab by any route (including the browser back button) leaves no trace.
//   * No write reaches the server: this component performs no fetch of its own.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FlaskConical, RotateCcw } from "lucide-react";
import GlassContainer from "@/components/primitives/GlassContainer";
import { Card } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { Chip } from "@/components/primitives/Chip";
import { VisualQualityCard } from "@/components/domain/VisualQualityCard";
import { useGlassStore, type GlassQuality, type GlassVariant } from "@/stores/prefsStore";
import { CLARITY_STEPS, quantizeClarity } from "@/lib/glass/quality";
import { useVisualQuality } from "@/lib/glass/useVisualQuality";
import { labIndexRoute } from "@/lib/lab/labFlags";

const QUALITIES: GlassQuality[] = ["auto", "opaque", "frosted", "clear"];
const VARIANTS: GlassVariant[] = ["tinted", "clear"];

/** Live count of elements that actually own a backdrop filter. The lab reads
 *  the DOM, so the number is an observation, not a claim. */
function countBackdropSurfaces(): { total: number; sampling: number } {
  if (typeof document === "undefined") return { total: 0, sampling: 0 };
  const glass = Array.from(document.querySelectorAll("[data-glass], .glass-menu, .glass-drawer"));
  let sampling = 0;
  for (const el of glass) {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
    const bf = cs.backdropFilter || cs.webkitBackdropFilter || "none";
    if (bf && bf !== "none") sampling += 1;
  }
  return { total: glass.length, sampling };
}

export default function GlassLab() {
  const { t } = useTranslation();
  const quality = useGlassStore((s) => s.quality);
  const clarity = useGlassStore((s) => s.clarity);
  const variant = useGlassStore((s) => s.variant);
  const setQuality = useGlassStore((s) => s.setQuality);
  const setClarity = useGlassStore((s) => s.setClarity);
  const setVariant = useGlassStore((s) => s.setVariant);
  const { resolved, env } = useVisualQuality();
  const [probe, setProbe] = useState(() => ({ total: 0, sampling: 0 }));

  // Restore-on-leave: the harness borrows the operator's preference and gives
  // it back. Captured once, on mount, before any lever is pulled.
  const restore = useRef<{ quality: GlassQuality; clarity: number; variant: GlassVariant } | null>(null);
  if (restore.current === null) {
    restore.current = { quality, clarity, variant };
  }
  useEffect(() => {
    const snap = restore.current;
    return () => {
      if (!snap) return;
      const s = useGlassStore.getState();
      s.setQuality(snap.quality);
      s.setClarity(snap.clarity);
      s.setVariant(snap.variant);
    };
  }, []);

  // Re-measure after every paint-affecting change (and once the stage mounts).
  useEffect(() => {
    const id = window.setTimeout(() => setProbe(countBackdropSurfaces()), 120);
    return () => window.clearTimeout(id);
  }, [resolved, clarity, variant]);

  const step = quantizeClarity(clarity);
  const budgetNote = useMemo(() => {
    if (probe.sampling <= 1) return { tone: "success" as const, text: "within budget (<= 1)" };
    if (probe.sampling === 2) return { tone: "success" as const, text: "within budget (overlay open: <= 2)" };
    return { tone: "danger" as const, text: "OVER BUDGET (" + probe.sampling + " sampling surfaces)" };
  }, [probe.sampling]);

  return (
    <div data-testid="glass-lab" id="f106.lab.glass" className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={labIndexRoute()} data-testid="glass-lab-back" className="inline-flex items-center gap-1 text-xs text-tertiary hover:text-primary">
          <ArrowLeft className="size-3.5" aria-hidden />
          {t("featureLab.back")}
        </Link>
        <FlaskConical className="size-4 text-accent" aria-hidden />
        <h1 className="text-base font-semibold text-primary">{t("glass.labTitle")}</h1>
        <Chip tone="warning">{t("glass.labSimulated")}</Chip>
      </div>
      <p className="mt-1 max-w-3xl text-[11px] text-tertiary">{t("glass.labIntro")}</p>

      <Card title={t("glass.title")} className="mt-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="glass-lab-quality">
            <span className="text-xs font-medium w-28">{t("glass.quality.label")}</span>
            {QUALITIES.map((q) => (
              <Button
                key={q}
                size="sm"
                variant={quality === q ? "primary" : "outline"}
                aria-pressed={quality === q}
                data-testid={"glass-lab-quality-" + q}
                onClick={() => setQuality(q)}
              >
                {t("glass.quality." + q)}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="glass-lab-variant">
            <span className="text-xs font-medium w-28">{t("glass.variant.label")}</span>
            {VARIANTS.map((v) => (
              <Button
                key={v}
                size="sm"
                variant={variant === v ? "primary" : "outline"}
                aria-pressed={variant === v}
                data-testid={"glass-lab-variant-" + v}
                onClick={() => setVariant(v)}
              >
                {t("glass.variant." + v)}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="glass-lab-clarity">
            <label htmlFor="glass-lab-clarity-input" className="text-xs font-medium w-28">
              {t("glass.clarity.label")}
            </label>
            <input
              id="glass-lab-clarity-input"
              data-testid="glass-lab-clarity-input"
              type="range"
              min={0}
              max={4}
              step={1}
              value={CLARITY_STEPS.indexOf(step as (typeof CLARITY_STEPS)[number])}
              onChange={(e) => {
                const i = Number(e.target.value);
                setClarity(CLARITY_STEPS[i] ?? 0.75);
              }}
              className="h-11 w-full max-w-xs accent-[color:var(--color-accent)]"
            />
            <span className="font-mono text-xs text-secondary" data-testid="glass-lab-clarity-value" data-clarity={step}>
              {Math.round(step * 100)}%
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<RotateCcw className="size-3.5" />}
              data-testid="glass-lab-reset"
              onClick={() => {
                setQuality("auto");
                setClarity(0.75);
                setVariant("tinted");
              }}
            >
              {t("featureLab.clearLedger")}
            </Button>
            <Chip tone={budgetNote.tone} mono data-testid="glass-lab-budget">
              {probe.sampling} / {probe.total} · {budgetNote.text}
            </Chip>
            <span className="font-mono text-[11px] text-tertiary" data-testid="glass-lab-state">
              requested={quality} resolved={resolved} variant={variant} clarity={step}
            </span>
            {env.supports === false ? (
              <Chip tone="warning" data-testid="glass-lab-unsupported">
                {t("glass.unsupportedNotice")}
              </Chip>
            ) : null}
          </div>
        </div>
      </Card>

      {/* The stage: the SAME production components, side by side, so a quality
          change is judged on identical content. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <GlassContainer surface="backdrop" variant="tinted" radius="overlay" data-testid="glass-lab-sample-backdrop" className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-tertiary">surface = backdrop (samples)</p>
          <p className="mt-2 text-sm text-primary">
            {t("glass.labIntro")}
          </p>
        </GlassContainer>
        <GlassContainer surface="nested" variant="tinted" radius="overlay" data-testid="glass-lab-sample-nested" className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-tertiary">surface = nested (paint-only)</p>
          <p className="mt-2 text-sm text-primary">
            {t("glass.labIntro")}
          </p>
        </GlassContainer>
      </div>

      {/* The real Settings control, mounted as the operator sees it. */}
      <section data-testid="glass-lab-stage" className="mt-4">
        <VisualQualityCard />
      </section>
    </div>
  );
}
