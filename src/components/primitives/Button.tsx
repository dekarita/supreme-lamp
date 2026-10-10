// [F41 plan §4.1/§4.2] Button + IconButton - enterprise tokens, no glass.
import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "outline" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

const sizeClasses: Record<Size, string> = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-3 py-2 text-sm",
  lg: "px-4 py-2.5 text-sm",
};

const iconSizes: Record<Size, string> = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-4",
};

const variantClasses: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-hover",
  secondary: "bg-surface text-primary border border-default hover:bg-raised active:bg-raised",
  outline: "border border-accent text-accent bg-transparent hover:bg-accent/10 active:bg-accent/20",
  danger: "bg-danger text-danger-fg hover:bg-danger-hover active:bg-danger-hover",
  ghost: "text-primary bg-transparent hover:bg-raised active:bg-raised",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  ariaLabel?: string;
}

export function Button({
  variant = "md" as unknown as Variant,
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ariaLabel,
  ...rest
}: ButtonProps & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-2 rounded-md font-medium transition-colors duration-fast",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        sizeClasses[size],
        variantClasses[variant] || variantClasses.secondary,
        className
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      {...rest}
    >
      {loading ? <Loader2 className={cn("animate-spin", iconSizes[size])} aria-hidden /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({
  icon,
  label,
  size = "md",
  className,
  ...rest
}: Omit<ButtonProps, "children" | "ariaLabel"> & { icon: React.ReactNode; label: string }) {
  // a11y: aria-label REQUIRED on icon-only buttons (plan §4.2 lint contract).
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-colors duration-fast",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" ? "size-7" : size === "lg" ? "size-10" : "size-8",
        "text-secondary hover:bg-raised hover:text-primary",
        className
      )}
      {...rest}
    >
      <span className={cn("inline-flex", size === "sm" ? "size-3.5" : "size-4")} aria-hidden>
        {icon}
      </span>
    </button>
  );
}
