// [F41 plan §4.13-§4.15] Tooltip (hover/focus, Escape-dismissible),
// Modal (confirm dialog with focus trap + Escape), Toasts (status/alert roles).
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// [R-GLASS / #213 §6] Portaled overlays are their own backdrop layer. One
// sampling surface while an overlay is open - the second slot of the budget.
import GlassContainer from "./GlassContainer";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "@/stores/toastStore";
import { cn } from "@/lib/cn";

export function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span role="tooltip" className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 whitespace-pre-wrap max-w-xs text-xs bg-sunken text-primary border border-default rounded px-2 py-1 shadow-md">
          {text}
        </span>
      )}
    </span>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  primary,
  secondary,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  onClose: () => void;
  primary?: { label: string; onClick: () => void; variant?: "primary" | "danger" };
  secondary?: { label: string; onClick: () => void };
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useRef("modal-" + Math.random().toString(36).slice(2)).current;
  const descId = useRef("modal-desc-" + Math.random().toString(36).slice(2)).current;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const focusables = panel?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    focusables?.[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && panel) {
        const list = Array.from(panel.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter((el) => !el.hasAttribute("disabled"));
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      {/* [R-GLASS] A portal is its own backdrop layer: the panel MAY sample,
          and everything inside it is forced paint-only by the scope. */}
      <GlassContainer
        ref={panelRef}
        surface="backdrop"
        variant="tinted"
        radius="overlay"
        escapeScope
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="relative max-w-md w-full p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-primary">
            {title}
          </h2>
          <button type="button" data-testid="modal-close" onClick={onClose} aria-label="Close" className="text-tertiary hover:text-primary focus-visible:ring-2 focus-visible:ring-accent rounded">
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {description && (
          <div id={descId} className="mt-2 text-sm text-secondary">
            {description}
          </div>
        )}
        {(primary || secondary) && (
          <div className="mt-4 flex justify-end gap-2">
            {secondary && (
              <button
                type="button"
                data-testid="modal-secondary"
                onClick={secondary.onClick}
                className="min-h-[44px] px-3 py-2 text-sm rounded-md border border-default bg-surface text-primary hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent"
              >
                {secondary.label}
              </button>
            )}
            {primary && (
              <button
                type="button"
                data-testid="modal-primary"
                onClick={primary.onClick}
                className={cn(
                  "min-h-[44px] px-3 py-2 text-sm rounded-md font-medium text-white focus-visible:ring-2 focus-visible:ring-accent",
                  primary.variant === "danger" ? "bg-danger hover:bg-danger-hover" : "bg-accent hover:bg-accent-hover"
                )}
              >
                {primary.label}
              </button>
            )}
          </div>
        )}
      </GlassContainer>
    </div>,
    document.body
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToastStore();
  return (
    // [#214 §8] The old fixed offset sat UNDER the new phone primary bar. The
    // toasts now clear it (and the safe area) instead of being hidden behind it.
    <div
      id="toasts"
      className="fixed right-3 z-50 flex flex-col gap-2 max-lg:bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] lg:bottom-10"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "bad" ? "alert" : "status"}
          className={cn(
            "px-3 py-2 rounded-md text-sm shadow-md border cursor-pointer bg-surface",
            t.kind === "ok" && "border-success/40 text-success",
            t.kind === "warn" && "border-warning/40 text-warning",
            t.kind === "bad" && "border-danger/40 text-danger",
            !t.kind && "border-default text-primary"
          )}
          onClick={() => dismiss(t.id)}
        >
          {t.msg}
          {t.action ? (
            <button
              type="button"
              data-testid="toast-action"
              className="ml-2 underline underline-offset-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
              onClick={(e) => {
                e.stopPropagation();
                t.action?.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function useToast() {
  const push = useToastStore((s) => s.push);
  const { t } = useTranslation();
  return {
    ok: (m?: string) => push(m || t("copy.copied"), "ok"),
    warn: (m: string) => push(m, "warn"),
    bad: (m: string) => push(m, "bad"),
  };
}
