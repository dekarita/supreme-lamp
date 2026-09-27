// [F41] Toast store - role="status" for info, role="alert" for danger
// (WCAG 4.1.3), max 3 stacked, 4s duration.
import { create } from "zustand";
import { registerToasts, type ToastKind } from "@/lib/clipboard";

export interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}
interface ToastState {
  toasts: ToastItem[];
  push: (msg: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
}
let nextId = 1;
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (msg, kind = "") => {
    const id = nextId++;
    const stack = [...get().toasts, { id, msg, kind }].slice(-3);
    set({ toasts: stack });
    window.setTimeout(() => get().dismiss(id), 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

registerToasts((msg, kind) => useToastStore.getState().push(msg, kind));
