// [F90 §C.2] The "where will this link actually open?" choice.
//
// WHY: `window.open()` opens a tab in WHICHEVER browser is running the
// dashboard. Viewed through WEB DESKTOP that browser is the RDP session's
// Chrome - correct. Viewed directly over Tailscale it is the operator's own
// laptop Chrome - the exact silent failure this whole launch feature exists to
// prevent, because the link looks like it worked and lands on the wrong
// machine.
//
// So when the mode is `tailscale-local` and the server's ladder cannot reach a
// desktop, `launchUrl()` refuses to guess and opens THIS modal instead: the
// operator picks, explicitly, and the URL is never opened implicitly.
import { create } from "zustand";

export interface LaunchChoiceState {
  /** The URL awaiting an explicit operator decision; null = modal closed. */
  pendingUrl: string | null;
  /** Server-side reason the ladder failed (i18n key), shown above the buttons. */
  reason: string | null;
  open: (url: string, reason?: string | null) => void;
  close: () => void;
}

export const useLaunchChoiceStore = create<LaunchChoiceState>((set) => ({
  pendingUrl: null,
  reason: null,
  open: (url, reason = null) => set({ pendingUrl: url, reason }),
  close: () => set({ pendingUrl: null, reason: null }),
}));
