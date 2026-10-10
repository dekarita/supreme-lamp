// [R-UX / #214 §4] Overlay accessibility behaviour: Escape to close, focus
// trap, and focus restoration.
//
// WHY THIS EXISTS INSTEAD OF A DEPENDENCY. #214 §3 inspected radix-ui/primitives
// (MIT) and recorded the decision REFERENCE_ONLY: adopting the whole library in
// the same change as the visual rework conflicts with the single-file bundle
// budget and would restyle every primitive. The ONE behaviour radix does better
// than the in-repo overlays is focus management, so that behaviour is adapted
// here — ~60 lines, no new package.
//
// Applied to: the mobile navigation drawer, the command palette, the confirm
// dialog and the preview dialog.
import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface OverlayA11yOptions {
  open: boolean;
  onClose: () => void;
  /** Container to trap focus inside. Defaults to the returned ref. */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Move focus into the overlay on open (default true). */
  autoFocus?: boolean;
}

/**
 * Returns a ref to attach to the overlay's root element.
 */
export function useOverlayA11y({ open, onClose, containerRef, autoFocus = true }: OverlayA11yOptions) {
  const localRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // The caller passes an inline arrow (`() => setOpen(false)`), so a dependency
  // on its IDENTITY would tear the trap down and rebuild it - and restore focus
  // - on every unrelated re-render. Kept in a ref instead.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const node0 = (containerRef?.current ?? localRef.current) as HTMLElement | null;
    restoreRef.current = (document.activeElement as HTMLElement) || null;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const node = (containerRef?.current ?? localRef.current) as HTMLElement | null;
      if (!node) return;
      const all = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      // Prefer genuinely focusable items, but fall back to the unfiltered list:
      // jsdom reports offsetParent null and getClientRects() empty for
      // everything, and an environment quirk must not silently disable the trap.
      const visible = all.filter((n) => n.offsetParent !== null || n.getClientRects().length > 0);
      const list = visible.length > 0 ? visible : all;
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);

    // Focus synchronously: the effect runs after commit, so the node exists.
    // (An earlier rAF version lost the race against the cleanup on every
    // re-render, which left focus outside the overlay.)
    if (autoFocus && node0) {
      const all = Array.from(node0.querySelectorAll<HTMLElement>(FOCUSABLE));
      const target = all[0] || node0;
      if (target === node0 && !node0.hasAttribute("tabindex")) node0.setAttribute("tabindex", "-1");
      target.focus?.();
    }

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const back = restoreRef.current;
      if (back && typeof back.focus === "function" && document.contains(back)) back.focus();
    };
  }, [open, containerRef, autoFocus]);

  return localRef;
}

export default useOverlayA11y;
