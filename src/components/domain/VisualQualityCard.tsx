// [R-GLASS / #213 §8 + #214 §6] The operator's handle on the glass system.
//
// WHY IT IS VISIBLE AND NOT HIDDEN BEHIND A FLAG. #214's "Change visual
// quality" journey lists the control as a first-class setting: the operator
// asked for a Glass Clarity control, and a control nobody can find is not a
// control. It sits directly under Appearance so the three related choices
// (theme, text size, glass) stay together.
import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/primitives/Button";
import { Card } from "@/components/primitives/Data";
import { Chip } from "@/components/primitives/Chip";
import { useGlassStore, type GlassQuality, type GlassVariant } from "@/stores/prefsStore";
import { CLARITY_STEPS, isClarityStep, quantizeClarity } from "@/lib/glass/quality";
import { useVisualQuality } from "@/lib/glass/useVisualQuality";
import { isPerfFallbackActive } from "@/lib/glass/quality";
import { cn } from "@/lib/cn";

const QUALITIES: GlassQuality[] = ["auto", "opaque", "frosted", "clear"];
const VARIANTS: GlassVariant[] = ["tinted", "clear"];

export function VisualQualityCard() {
  const { t } = useTranslation();
  const quality = useGlassStore((s) => s.quality);
  const setQuality = useGlassStore((s) => s.setQuality);
  const clarity = useGlassStore((s) => s.clarity);
  const setClarity = useGlassStore((s) => s.setClarity);
  const variant = useGlassStore((s) => s.variant);
  const setVariant = useGlassStore((s) => s.setVariant);
  const { resolved, env } = useVisualQuality();

  const perfFallback = isPerfFallbackActive();
  const step = quantizeClarity(clarity);
  const pct = Math.round(step * 100);

  return (
    <Card
      id="r-glass.settings.visualQuality"
      title={t("glass.title")}
      icon={<SlidersHorizontal className="size-5 text-accent" aria-hidden />}
      className="mb-4"
      actions={
        <Chip id="r-glass.settings.resolvedChip" tone={resolved === "opaque" ? "neutral" : "success"} mono>
          {resolved}
        </Chip>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-secondary" data-testid="glass-intro">
          {t("glass.intro")}
        </p>

        {/* QUALITY ------------------------------------------------------- */}
        <fieldset className="flex flex-wrap items-center gap-3 border-0 p-0 m-0">
          <legend className="sr-only">{t("glass.quality.label")}</legend>
          <span id="glass-quality-label" className="text-sm font-medium w-40">
            {t("glass.quality.label")}
          </span>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="glass-quality-label">
            {QUALITIES.map((q) => (
              <Button
                key={q}
                size="sm"
                variant={quality === q ? "primary" : "secondary"}
                aria-pressed={quality === q}
                data-testid={"glass-quality-" + q}
                onClick={() => setQuality(q)}
              >
                {t("glass.quality." + q)}
              </Button>
            ))}
          </div>
        </fieldset>
        <p className="-mt-2 text-xs text-tertiary">{t("glass.quality.help")}</p>

        {/* VARIANT (Tinted / Clear) -------------------------------------- */}
        <fieldset className="flex flex-wrap items-center gap-3 border-0 p-0 m-0">
          <legend className="sr-only">{t("glass.variant.label")}</legend>
          <span id="glass-variant-label" className="text-sm font-medium w-40">
            {t("glass.variant.label")}
          </span>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="glass-variant-label">
            {VARIANTS.map((v) => (
              <Button
                key={v}
                size="sm"
                variant={variant === v ? "primary" : "secondary"}
                aria-pressed={variant === v}
                data-testid={"glass-variant-" + v}
                onClick={() => setVariant(v)}
              >
                {t("glass.variant." + v)}
              </Button>
            ))}
          </div>
        </fieldset>
        <p className="-mt-2 text-xs text-tertiary">{t("glass.variant.help")}</p>

        {/* CLARITY -------------------------------------------------------- */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="glass-clarity" className="text-sm font-medium w-40">
              {t("glass.clarity.label")}
            </label>
            <input
              id="glass-clarity"
              data-testid="glass-clarity"
              type="range"
              min={0}
              max={4}
              step={1}
              value={CLARITY_STEPS.indexOf(step as (typeof CLARITY_STEPS)[number])}
              onChange={(e) => setClarity(CLARITY_STEPS[Number(e.target.value)] ?? 0.75)}
              aria-valuetext={t("glass.clarity.value", { percent: pct })}
              className="h-11 w-full max-w-xs accent-[color:var(--color-accent)]"
            />
            <output
              htmlFor="glass-clarity"
              data-testid="glass-clarity-value"
              data-clarity={step}
              className="font-mono text-sm text-secondary min-w-[6rem]"
            >
              {t("glass.clarity.value", { percent: pct })}
            </output>
          </div>
          {/* The steps are visible, not implied: a touch operator needs to see
              where the slider will land before dragging it. */}
          <div className="flex flex-wrap gap-1" aria-hidden>
            {CLARITY_STEPS.map((s) => (
              <span
                key={s}
                data-testid={"glass-clarity-step-" + String(s).replace(".", "_")}
                data-active={s === step ? "1" : "0"}
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10px]",
                  s === step ? "bg-accent/20 text-accent" : "text-tertiary"
                )}
              >
                {Math.round(s * 100)}%
              </span>
            ))}
          </div>
          <p className="text-xs text-tertiary">{t("glass.clarity.help")}</p>
        </div>

        {/* HONEST STATE ---------------------------------------------------- */}
        <div className="flex flex-col gap-1" data-testid="glass-state">
          {env.supports === false ? (
            <p className="text-xs text-warning" data-testid="glass-unsupported">
              {t("glass.unsupportedNotice")}
            </p>
          ) : null}
          {env.reducedTransparency ? (
            <p className="text-xs text-warning" data-testid="glass-reduced-transparency">
              {t("glass.reducedNotice")}
            </p>
          ) : null}
          {perfFallback ? (
            <p className="text-xs text-warning" data-testid="glass-perf-notice">
              {t("glass.perfNotice")}
            </p>
          ) : null}
          <p className="font-mono text-[11px] text-tertiary" data-testid="glass-state-line">
            requested={quality} resolved={resolved} variant={variant} clarity={step}
          </p>
        </div>
      </div>
    </Card>
  );
}

export default VisualQualityCard;

/** Exported for the browser lab: the slider must only ever land on a step. */
export { isClarityStep };
