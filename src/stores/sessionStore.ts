// [F41] Session store - /api/config + /api/native-status state (polling writes
// here; components render view models from lib/domain).
// F27 contract preserved: full password values live ONLY in this store's
// state (the v1 closure equivalent) and are never rendered unmasked; the
// masked field shows bullets and the copy action pulls from here.
import { create } from "zustand";
import { announceSearchLane } from "@/lib/search/lane";
import { postRdpToken, launchProto, mintTraceId, fetchPurgeCommand } from "@/lib/api";
import { FQDN_RE, CGNAT_RE, parseTsUtc } from "@/lib/format";
import { ghrdpRdpUrl, ghrdpRecredUrl, beaconModel, authDiscriminator, type AuthDiscriminator } from "@/lib/domain/native";
import { telescopeTimeline, type TelTimeline } from "@/lib/domain/telescope";
import { liveDispatchStatus, type LiveDispatchResult } from "@/lib/domain/liveDispatch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface Secrets {
  credWinPass: string;
  credVncPass: string;
  windowsPassMask?: string;
  vncPassMask?: string;
}

interface AutoLoginState {
  note: string;
  staleRegistration: boolean;
  installNotice: boolean;
  helloSeen: boolean;
}

interface SessionState {
  configLoaded: boolean;
  fqdn: string;
  user: string;
  ip: string;
  mirrorIndexUrl: string;
  secrets: Secrets;
  gatedVncPass: string;
  native: Any | null;
  nativeLost: boolean;
  listenerOkFlag: boolean;
  runnerResolvedIP: string;
  runnerDnsOk: boolean;
  lastTrace: string;
  helloWatchArmed: boolean;
  helloWatchSeen: boolean;
  helloWatchArmedAt: number;
  autoLogin: AutoLoginState;
  recoveryDispatchedAt: number;
  purgeCmd: string;
  beaconInvokedAt: number | null;
  lastHandlerTs: string;
  diagOpen: boolean;
  diagText: string;

  setConfig: (cf: Any) => void;
  setNativeStatus: (s: Any) => void;
  markNativeLost: () => void;
  setAutoLoginNote: (note: string) => void;
  setDiag: (open: boolean, text?: string) => void;
  loadPurgeCmd: () => Promise<void>;
  runDiag: () => Promise<void>;
  fireAutoLogin: () => Promise<void>;
  fireFixReconnect: () => Promise<void>;
  fireRunCheck: () => void;
  fireRunDiag: () => void;
  fireAutoLoginNative: () => Promise<void>;
  armHelloWatch: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  configLoaded: false,
  fqdn: "",
  user: "",
  ip: "",
  mirrorIndexUrl: "",
  secrets: { credWinPass: "", credVncPass: "" },
  gatedVncPass: "",
  native: null,
  nativeLost: false,
  listenerOkFlag: false,
  runnerResolvedIP: "",
  runnerDnsOk: false,
  lastTrace: "",
  helloWatchArmed: false,
  helloWatchSeen: false,
  helloWatchArmedAt: 0,
  autoLogin: { note: "", staleRegistration: false, installNotice: false, helloSeen: false },
  recoveryDispatchedAt: 0,
  purgeCmd: "",
  beaconInvokedAt: null,
  lastHandlerTs: "",
  diagOpen: false,
  diagText: "",

  setConfig: (cf) => {
    if (!cf) return;
    // F52: discard even a legacy server's mirror key before UI state storage.
    cf = { ...cf };
    delete cf.mirrorKey;
    const cr = cf.creds || {};
    const fqdn = cr.fqdn || "";
    const user = cr.user || "";
    const ip = cr.ip || "";
    const secrets: Secrets = {
      credWinPass: cr.windowsPass ? String(cr.windowsPass) : "",
      credVncPass: cr.vncPass ? String(cr.vncPass) : "",
      windowsPassMask: cr.windowsPassMask,
      vncPassMask: cr.vncPassMask,
    };
    set({ configLoaded: true, fqdn, user, ip, secrets, mirrorIndexUrl: String(cf.mirrorIndexUrl || "") });
  },

  setNativeStatus: (s) => {
    if (!s) return;
    const fqdn = String(s.fqdn || "");
    const ip = String(s.runnerResolvedIP || "");
    // [F12-1 §1.4] handler-hello beacon input: a beacon newer than the click
    // proves the exe handler ran.
    let helloSeen = get().helloWatchSeen;
    const lastHandlerTs = s && s.lastHandlerVerb && s.lastHandlerVerb.ts ? String(s.lastHandlerVerb.ts) : "";
    if (lastHandlerTs && get().helloWatchArmed) {
      const hts = parseTsUtc(lastHandlerTs);
      if (!isNaN(hts) && hts >= get().helloWatchArmedAt - 10000) {
        helloSeen = true;
        set({ autoLogin: { ...get().autoLogin, note: "launcher beacon received - mstsc should be opening fullscreen", helloSeen: true } });
      }
    }
    set({
      native: s,
      fqdn: fqdn || get().fqdn,
      ip: s.creds && s.creds.ip ? String(s.creds.ip) : get().ip,
      user: s.creds && s.creds.user ? String(s.creds.user) : get().user,
      runnerResolvedIP: ip,
      runnerDnsOk: CGNAT_RE.test(ip),
      listenerOkFlag: listenerOkOf(s),
      lastHandlerTs,
      helloWatchSeen: helloSeen,
    });
  },

  markNativeLost: () => set({ nativeLost: true }),

  setAutoLoginNote: (note) => set({ autoLogin: { ...get().autoLogin, note } }),

  setDiag: (open, text) => set({ diagOpen: open, diagText: text !== undefined ? text : get().diagText }),

  loadPurgeCmd: async () => {
    if (get().purgeCmd) return;
    const cmd = await fetchPurgeCommand();
    set({ purgeCmd: cmd });
  },

  runDiag: async () => {
    set({ diagOpen: true, diagText: "running /diag..." });
    try {
      const r = await fetch("/diag", { cache: "no-store" });
      const d = r.ok ? await r.json() : null;
      set({ diagText: d ? JSON.stringify(d, null, 2) : "Diagnostics failed - server not reachable." });
      try {
        // [F56-d §3] Search surface reads window.__GHRDP_SEARCH_ENABLED from /diag.
        // [F77 §2.3] Diagnostic mirror only (see useDashboardPolling): the flag no
        // longer moves any UI decision - the Search entry + routes are unconditional.
        if (d && d.searchEnabled !== undefined) {
          const enabled = !!(d.searchEnabled === true || d.searchEnabled === 'true');
          // @ts-ignore
          if (typeof window !== 'undefined') (window as any).__GHRDP_SEARCH_ENABLED = enabled;
          announceSearchLane(); // [F77] no-op (lane.ts); kept for the diag subscribers
        }
        // Also set searchInput echo for SEARCH_INPUT propagation lab
        // @ts-ignore
        if (typeof window !== 'undefined') (window as any).__GHRDP_SEARCH_INPUT = d?.searchInput || '';
      } catch {}
    } catch {
      set({ diagText: "Diagnostics failed - server not reachable." });
    }
  },

  armHelloWatch: () => set({ helloWatchArmed: true, helloWatchSeen: false, helloWatchArmedAt: Date.now() }),

  // [F27 §1.3] WINDOWS AUTO-LOGIN: POST /api/rdp-token -> ghrdp://rdp?server&user[&ip]&t.
  fireAutoLogin: async () => {
    const st = get();
    const fqdn = st.fqdn;
    const user = st.user || "rdpuser";
    if (!FQDN_RE.test(fqdn)) return;
    const ticket = await postRdpToken();
    if (!ticket.ok) {
      st.setAutoLoginNote("ticket-issue failed - check dashboard authorization and direct tailnet access");
      return;
    }
    const trace = mintTraceId("client");
    set({ lastTrace: trace });
    launchProto(ghrdpRdpUrl(fqdn, user, st.runnerResolvedIP) + "&trace=" + encodeURIComponent(trace) + "&t=" + encodeURIComponent(ticket.rid));
    st.setAutoLoginNote("protocol dispatched - mstsc should open fullscreen shortly");
    // [F12-1 §1.4] hello-beacon watch: 20s window, native-status polled every 3s.
    get().armHelloWatch();
    set({ autoLogin: { ...get().autoLogin, staleRegistration: false, installNotice: false } });
  },

  // [F28 §2] FIX & RECONNECT: fresh ticket -> ghrdp://recred?server&user&t.
  fireFixReconnect: async () => {
    const st = get();
    const fqdn = st.fqdn;
    const user = st.user || "rdpuser";
    if (!FQDN_RE.test(fqdn)) return;
    const ticket = await postRdpToken();
    if (!ticket.ok) return;
    const trace = mintTraceId("client");
    set({ lastTrace: trace, recoveryDispatchedAt: Date.now() });
    launchProto(ghrdpRecredUrl(fqdn, user) + "&trace=" + encodeURIComponent(trace) + "&t=" + encodeURIComponent(ticket.rid));
  },

  // [F15 §3] RUN CHECK: ghrdp://check - MessageBox on the operator PC.
  fireRunCheck: () => {
    const fqdn = get().fqdn;
    launchProto("ghrdp://check" + (FQDN_RE.test(fqdn) ? "?server=" + encodeURIComponent(fqdn) : ""));
  },

  // [F37 §3] RUN DIAG: ghrdp://diag read-only client telescope.
  fireRunDiag: () => {
    const st = get();
    const fqdn = st.fqdn;
    const user = st.user || "rdpuser";
    if (!FQDN_RE.test(fqdn)) return;
    const trace = mintTraceId("client");
    let url = "ghrdp://diag?server=" + encodeURIComponent(fqdn) + "&user=" + encodeURIComponent(user);
    if (CGNAT_RE.test(st.runnerResolvedIP)) url += "&ip=" + encodeURIComponent(st.runnerResolvedIP);
    url += "&trace=" + encodeURIComponent(trace);
    set({ lastTrace: trace });
    launchProto(url);
  },

  // VPS-only native flow: dashboard bearer -> rid -> ghrdp:connect?rid=<rid>.
  fireAutoLoginNative: async () => {
    const ticket = await postRdpToken();
    if (!ticket.ok) return;
    launchProto("ghrdp:connect?rid=" + ticket.rid);
  },
}));

function listenerOkOf(s: Any): boolean {
  const rl = s && s.rdpListener;
  if (!rl || typeof rl !== "object") return false;
  const csv = rl.credsspLive === "ok" || (!rl.credsspLive && (!rl.credsspStatus || rl.credsspStatus === "ok" || rl.credsspStatus === "ok-with-cipher-warn"));
  return !!(rl.listening === true && rl.fwRule === true && rl.certOk === true && rl.nla === true && csv);
}

// ---- Derived selectors (recomputed per render, cheap) ----

export function selectTelemetry(s: Any | null): TelTimeline {
  return telescopeTimeline(s, Date.now());
}

export function selectLiveDispatch(s: Any | null): LiveDispatchResult {
  return liveDispatchStatus(s, Date.now());
}

export function selectAuth(s: Any | null): AuthDiscriminator | null {
  if (!s) return null;
  return authDiscriminator(s.rdpListener || null, s);
}

export function selectBeacon(s: Any | null, invokedAt: number | null, nowMs: number) {
  return beaconModel(s && s.lastHandlerVerb ? { verb: s.lastHandlerVerb.verb, details: s.lastHandlerVerb.details, ok: s.lastHandlerVerb.ok, ts: s.lastHandlerVerb.ts } : null, invokedAt, nowMs);
}

export { beaconModel };
