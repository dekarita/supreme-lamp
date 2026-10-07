// [F41 plan §4.5/§4.6] Toggle + Chip + StatusDot.
import React from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "ok" | "success" | "warning" | "warn" | "danger" | "bad" | "accent";
type Resolved = "neutral" | "success" | "warning" | "danger" | "accent";
function resolveTone(t: Tone): Resolved {
  if (t === "ok" || t === "success") return "success";
  if (t === "warn" || t === "warning") return "warning";
  if (t === "bad" || t === "danger") return "danger";
  if (t === "accent") return "accent";
  return "neutral";
}

export function StatusDot({ tone = "neutral", className }: { tone?: Tone; className?: string }) {
  const r = resolveTone(tone);
  return (
    <i
      aria-hidden
      className={cn(
        "inline-block size-2 rounded-full shrink-0",
        r === "success" && "bg-success",
        r === "warning" && "bg-warning",
        r === "danger" && "bg-danger",
        r === "accent" && "bg-accent",
        r === "neutral" && "bg-border-strong",
        className
      )}
    />
  );
}

export function Chip({
  tone = "neutral",
  dot,
  mono,
  className,
  children,
  id,
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
  id?: string;
  title?: string;
}) {
  const r = resolveTone(tone);
  return (
    <span
      id={id}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        r === "neutral" && "bg-raised text-secondary",
        r === "success" && "bg-success/10 text-success",
        r === "warning" && "bg-warning/10 text-warning",
        r === "danger" && "bg-danger/10 text-danger",
        r === "accent" && "bg-accent/10 text-accent",
        mono && "font-mono",
        className
      )}
    >
      {dot && <StatusDot tone={tone} />}
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  "data-testid": dataTestId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      data-testid={dataTestId}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-fast",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-accent" : "bg-border-strong"
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow-xs transition-transform duration-fast",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
