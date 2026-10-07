// F107 full capture is OPT-IN. The F-DVR-LITE ring and clipboard path stay
// independent: denied storage/quota/rasterization never breaks F104 or v1.
import { appendBounded, safeRoute, type FullEntry, type FullSession } from "./full-core";
import { observeMutations } from "./mutations";
import { captureThumbnail } from "./screenshots";
import { saveSession, getSession, listSessions } from "./storage";
import registry from "../feature-registry.json";

const TAB_KEY = "ghrdp-dvr-v2-session";
let session: FullSession | null = null;
let enabled = false;
let detach: (() => void) | null = null;
let pending: Promise<void> = Promise.resolve();
let generation = 0;
let starting: Promise<void> | null = null;
let error = "";
const listeners = new Set<() => void>();
export const fullDvrState = () => ({ enabled, error, id: session?.id || "" });
export const subscribeFullDvr = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function notify() { for (const fn of listeners) fn(); }
function fail(e: unknown) {
  error = (e instanceof DOMException && e.name === "QuotaExceededError")
    ? "Device storage quota reached. Full capture stopped; existing sessions remain available."
    : "Local DVR storage failed; full capture stopped. Existing clipboard DVR still works.";
  stopFullDvr();
}
function append(entry: FullEntry) {
  if (!enabled || !session) return;
  const outcome = appendBounded(session, entry);
  if (!outcome.accepted) { error = "Frame exceeds 5 MB; skipped."; notify(); return; }
  session = { ...outcome.session, updatedAt: Date.now() };
  const captured = session;
  // Serialize writes; a slower earlier transaction may NEVER replace a newer one.
  pending = pending.then(() => saveSession(captured)).catch(fail);
}

export function startFullDvr(): Promise<void> {
  if (enabled) return Promise.resolve();
  if (starting) return starting;
  starting = beginFullDvr().finally(() => { starting = null; });
  return starting;
}
async function beginFullDvr(): Promise<void> {
  const startGeneration = generation;
  error = "";
  try {
    const root = document.getElementById("root");
    if (!root) throw new Error("root unavailable");
    await pending; // never reload an older snapshot over queued click writes
    await listSessions(); // apply 30-day retention on entry
    const savedId = sessionStorage.getItem(TAB_KEY);
    session = (savedId && await getSession(savedId)) || null;
    if (!session) {
      session = {
        id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(),
        target: { route: safeRoute(window.location.hash || window.location.pathname), lang: document.documentElement.lang || "en", ui: "v2" },
        features: registry.features.map(f => f.id), timeline: [],
      };
      await saveSession(session); // fail closed: never say "recording" without durable storage
      sessionStorage.setItem(TAB_KEY, session.id);
    }
    if (generation !== startGeneration) return; // stopped while opening storage
    enabled = true;
    generation++;
    detach = observeMutations(root, diff => append({ kind: "mutation", at: Date.now(), diff }));
    notify();
  } catch (e) { fail(e); }
}
export function stopFullDvr(): void {
  enabled = false;
  generation++;
  detach?.();
  detach = null;
  notify();
}
export function recordFullClick(entry: FullEntry): void {
  if (!enabled) return;
  append(entry);
  const root = document.getElementById("root");
  if (!root) return;
  const clickGeneration = generation;
  const clickSession = session?.id;
  // A post-click frame includes React's result of this click, not the pre-click DOM.
  setTimeout(() => {
    if (!enabled || generation !== clickGeneration || session?.id !== clickSession) return;
    void captureThumbnail(root).then((image) => {
      if (enabled && generation === clickGeneration && session?.id === clickSession && image)
        append({ kind: "screenshot", at: Date.now(), clickAt: entry.at, image });
    }).catch(() => { error = "Screenshot unavailable; timeline continues."; notify(); });
  }, 0);
}
export function recordFullSettle(entry: FullEntry): void { append(entry); }
export async function forgetFullSession(id: string): Promise<void> {
  if (session?.id !== id) return;
  stopFullDvr();
  session = null;
  sessionStorage.removeItem(TAB_KEY);
  notify();
  await pending; // deletion must follow all queued puts; otherwise they resurrect it
}
export async function currentFullSession(): Promise<FullSession | null> {
  await pending;
  return session;
}
export function __resetFullDvrForTests(): void {
  stopFullDvr(); session = null; error = ""; pending = Promise.resolve();
  try { sessionStorage.removeItem(TAB_KEY); } catch { /* jsdom teardown */ }
}
