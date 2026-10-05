// [F41] Toast store - role="status" for info, role="alert" for danger
// (WCAG 4.1.3), max 3 stacked, 4s duration.
import { create } from "zustand";
import { registerToasts, type ToastKind } from "@/lib/clipboard";

/** [F91 §C.2] A toast may carry ONE inline action button ("Open in RDP File
 *  Explorer" on a download success). It stays a plain string toast for every
 *  existing caller - the action is additive and optional. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
  action?: ToastAction;
}
interface ToastState {
  toasts: ToastItem[];
  push: (msg: string, kind?: ToastKind, action?: ToastAction) => void;
  dismiss: (id: number) => void;
}
let nextId = 1;
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (msg, kind = "", action) => {
    const id = nextId++;
    // an actionable toast lives 8 s, not 4 - the operator needs time to read
    // the path and click it (dismiss() still runs at 8s; the target folder
    // stays open on the runner either way).
    const stack = [...get().toasts, { id, msg, kind, ...(action ? { action } : {}) }].slice(-3);
    set({ toasts: stack });
    window.setTimeout(() => get().dismiss(id), action ? 8000 : 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

registerToasts((msg, kind) => useToastStore.getState().push(msg, kind));
