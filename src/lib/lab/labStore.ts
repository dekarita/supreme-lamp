// [F106 §2] The lab's observable state: which scenarios are forced, what the
// mounted section has asked for, and whether the interceptor is on.
//
// WHY A STORE AND NOT useState: the interceptor (src/lib/lab/mockBackend.ts)
// patches window.fetch OUTSIDE React's tree and must read/write the same state
// the panel renders. A zustand store is the pattern the rest of this app already
// uses for exactly that (toastStore, searchUiStore, prefsStore) and it keeps the
// merge rule in ONE place - mergeLedgerRow() in the pure core, which the Node
// gate executes directly.
//
// NOTHING HERE PERSISTS. No localStorage, no sessionStorage, no URL. A lab
// session is a debugging session: when the tab closes, the forced scenarios must
// not survive into the operator's next visit to the dashboard (a scenario left
// behind would make a real page lie, which is the one failure mode this whole
// step must not introduce).
import { create } from "zustand";
import { LAB_MAX_LEDGER, mergeLedgerRow } from "./labCore";
import type { LabLedgerRow, LabScenarioId } from "./labCore";

export interface LabState {
  /** Interceptor installed? Off = the section talks to the real backend only. */
  enabled: boolean;
  /** Forced scenario per observed path. Empty by default: observe, then force. */
  scenarios: Record<string, LabScenarioId>;
  ledger: LabLedgerRow[];
  setEnabled: (on: boolean) => void;
  setScenario: (path: string, scenario: LabScenarioId) => void;
  clearScenarios: () => void;
  record: (row: { method?: string; path?: string; kind?: string; scenario?: string }) => void;
  clearLedger: () => void;
}

export const useLabStore = create<LabState>((set, get) => ({
  enabled: true,
  scenarios: {},
  ledger: [],
  setEnabled: (on) => set({ enabled: !!on }),
  setScenario: (path, scenario) => set({ scenarios: { ...get().scenarios, [path]: scenario } }),
  clearScenarios: () => set({ scenarios: {} }),
  record: (row) => set({ ledger: mergeLedgerRow(get().ledger, row, LAB_MAX_LEDGER) }),
  clearLedger: () => set({ ledger: [] }),
}));

/** Test-only: forget the whole lab session (scenarios + ledger + enabled). */
export function __resetLabStoreForTests(): void {
  useLabStore.setState({ enabled: true, scenarios: {}, ledger: [] });
}
