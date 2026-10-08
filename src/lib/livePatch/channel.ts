// [F110 §2/§3/§5] channel.ts - the browser half of the Live Patch Protocol.
//
// One entry point that the socket calls (`ingestPatchFrame`), one that Settings calls
// (`primeAudit`, `patchAuditRows`, `subscribeLivePatch`, `rollbackLivePatches`).
// Everything DECISION-shaped lives in patchCore.js and is obeyed here, so the Node gate
// proves the same table the browser runs.
//
// ORDER OF OPERATIONS IS SECURITY, and F110-i pins it (in this order):
//   1. is it one of ours?            (no work for progress frames)
//   2. is the channel armed?         (prod default-off: no verify, no write, no database)
//   3. structure + clocks            (a malformed or stale frame never reaches crypto)
//   4. signature                     (HMAC-SHA256 over the canonical string)
//   5. dedupe                        (a re-delivered id is a `duplicate`, not a re-apply)
//   6. apply + audit                 (and only then)
// Reversing 3/4 would let anyone on the socket make this tab do crypto work for frames
// that were never signed; reversing 2/6 would let a disarmed dashboard grow a log.
//
// NO CODE EXECUTION. There is no `import()`, no `eval`, no `new Function` here, and no
// `window.fetch =` wrapper: a patch can move a value in an allowlisted map, nothing else.
// F110b's component swap is the follow-up and must bring an origin-of-signer story.
import { getDashToken } from "@/lib/dashToken";
import { FEATURE_IDS } from "@/lib/featureRegistry";
import { readFeatureToggles, setFeatureToggle } from "@/lib/featureToggles";
import {
  PATCH_AUDIT_MAX_ROWS,
  PATCH_CHANNEL_URL,
  PATCH_MAC_DOMAIN,
  PATCH_MAC_KEY_MIN,
  PATCH_SCHEMA_VERSION,
  appliedPatchIds,
  buildRollbackRow,
  canonicalPatch,
  decidePatch,
  isPatchFrame,
  rollbackPlan,
  trimAuditRows,
  type PatchAuditRow,
} from "./patchCore";
import { appendAuditRow, clearAudit, listAudit } from "./audit";
import { isLivePatchArmed, notifyLivePatch, requestPatchReload } from "./state";

export interface PatchIngestResult {
  verdict: string;
  reason: string;
  row: PatchAuditRow | null;
  durable: boolean;
}

export interface MacResult {
  ok: boolean;
  reason: string;
  value?: string;
}

/** The MAC provider seam (same convention as F107's setShotRasterizer / setExportDownload). */
export type MacProvider = (canonical: string, secret: string) => Promise<MacResult>;

const hex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, "0");
  return out;
};

/** WebCrypto HMAC-SHA256, hex. Total: a missing subtle answers {ok:false}, never throws. */
async function webCryptoMac(canonical: string, secret: string): Promise<MacResult> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return { ok: false, reason: "crypto-unavailable" };
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(canonical));
    return { ok: true, reason: "", value: hex(new Uint8Array(sig)) };
  } catch {
    return { ok: false, reason: "crypto-failed" };
  }
}

let macProvider: MacProvider | null = null;

/** Inject a MAC implementation (tests, or a future non-WebCrypto host). Null restores the shipped one. */
export function setPatchMacProvider(fn: MacProvider | null): void {
  macProvider = typeof fn === "function" ? fn : null;
}

export function isDefaultMacProviderActive(): boolean {
  return macProvider === null;
}

async function computePatchMac(canonical: string, secret: string): Promise<MacResult> {
  if (macProvider) {
    try {
      return await macProvider(canonical, secret);
    } catch {
      return { ok: false, reason: "provider-failed" };
    }
  }
  return webCryptoMac(canonical, secret);
}

/** Sign a patch (the operator/dev fixture side - the same canonical bytes the verifier rebuilds). */
export async function signPatchFrame(frame: Record<string, unknown>): Promise<MacResult> {
  const secret = getDashToken();
  if (String(secret || "").length < PATCH_MAC_KEY_MIN) return { ok: false, reason: "no-channel-key" };
  const canonical = canonicalPatch(frame as never);
  const mac = await computePatchMac(canonical, secret);
  if (!mac.ok || !mac.value) return { ok: false, reason: mac.reason };
  return { ok: true, reason: "", value: JSON.stringify(Object.assign({}, frame, { v: PATCH_SCHEMA_VERSION, sig: mac.value })) };
}

/** Which transport does a patch ride? Exported so the gate's literal pin has one source. */
export function patchChannelUrl(): string {
  return PATCH_CHANNEL_URL;
}

export function patchMacDomain(): string {
  return PATCH_MAC_DOMAIN;
}

// ---------------------------------------------------------------------------
// [F110 §4] The live view: the module array the panel renders. IndexedDB is the
// durable copy; this is the primed, in-order, bounded runtime copy - one source of
// truth per render, no async race between a fresh append and a re-read.
// ---------------------------------------------------------------------------
let rows: PatchAuditRow[] = [];
let primed = false;
let appliedIds: string[] = [];
/**
 * The read generation. A prime's `listAudit()` is async, so it can resolve AFTER a
 * rollback, a `forgetAuditLog()`, or a page-load reset has already moved the view - and
 * an unguarded continuation then writes a snapshot of the PAST over the present. Both
 * symptoms showed up in the DOM gate: a bounded log rendering as empty, and a cleared
 * log resurrecting. Every path that invalidates the durable view bumps this.
 */
let primeToken = 0;

/**
 * Load the durable log ONCE per page load, then the in-memory view is authoritative.
 *
 * Why not "re-read on every change": the write path is `remember()` -> `notify` ->
 * `await appendAuditRow()`, so a re-read triggered by that notify could see the log
 * WITHOUT the row that is already in the live view, and the panel would flicker a
 * patch out of existence. Reading durable state once, at mount, and appending in step
 * with it, is the same ordering choice F107's session list makes.
 */
export async function primeAudit(): Promise<void> {
  if (primed) return;
  primed = true;
  const token = ++primeToken;
  const res = await listAudit();
  if (token !== primeToken) return; // superseded while it was in flight: the view moved on
  if (res.ok && Array.isArray(res.value)) {
    // Merge, never replace: this read started before the first frames of this page load
    // were written, so the durable list can LAG the live one. Replacing here is how a
    // panel mount could erase a row the operator was already shown (found by the DOM
    // gate, which then rendered a "Roll back 0" button over an applied patch).
    const seen = new Set<string>();
    const merged: PatchAuditRow[] = [];
    for (const r of res.value.concat(rows)) {
      const key = (r.kind || "") + "|" + (r.id || "") + "|" + (r.verdict || "") + "|" + (r.seenAt || "");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
    rows = trimAuditRows(merged, PATCH_AUDIT_MAX_ROWS);
    appliedIds = appliedPatchIds(rows);
    if (rows.length > 0) notifyLivePatch();
  }
}

/** The audit rows, newest-last. */
export function patchAuditRows(): PatchAuditRow[] {
  return rows.slice();
}

/**
 * How many SECTIONS a rollback would restore right now - i.e. the pending plan, not the
 * historical count. Labeling the button with "applied patches ever seen" was the first
 * version and it lied after a rollback (the DOM gate caught it: the button stayed enabled
 * over an empty plan). `rollbackPlan` is the single definition of "what a rollback does",
 * so the label and the action cannot drift apart.
 */
export function patchPendingRollbackCount(): number {
  return rollbackPlan(rows).length;
}

function remember(row: PatchAuditRow, verdict: string): void {
  rows = trimAuditRows(rows.concat([row]), PATCH_AUDIT_MAX_ROWS);
  if (verdict === "applied" && row.id && appliedIds.indexOf(row.id) < 0) appliedIds.push(row.id);
}

/**
 * [F110 §2/§3] THE INGEST PATH. Called by useDashboardPolling's onmessage with the raw
 * frame text, and by nothing else. Never throws - a diagnostic path that can break the
 * socket is worse than no diagnostic path (the F94/F101 lesson, kept).
 */
export async function ingestPatchFrame(raw: unknown): Promise<PatchIngestResult> {
  const quiet = (verdict: string, reason: string): PatchIngestResult => ({ verdict, reason, row: null, durable: false });
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return quiet("ignored-not-patch", "bad-json");
    }
  }
  if (!isPatchFrame(parsed)) return quiet("ignored-not-patch", "not-a-patch-frame");
  // 2. prod default-off. Nothing is verified, written or opened until the operator arms it.
  if (!isLivePatchArmed()) return quiet("ignored-disarmed", "channel-disarmed");
  const now = Date.now();
  const secret = getDashToken();
  const frame = parsed as Record<string, unknown>;
  let macHex: string | undefined;
  // 3+4. the core checks structure before it is given a MAC to compare (see decidePatch).
  if (String(secret || "").length >= PATCH_MAC_KEY_MIN) {
    const mac = await computePatchMac(canonicalPatch(frame as never), String(secret));
    if (mac.ok && mac.value) macHex = mac.value;
  }
  const decision = decidePatch({
    frame,
    now,
    knownFeatures: FEATURE_IDS as readonly string[],
    secretLength: String(secret || "").length,
    macHex,
    appliedIds,
    prev: readFeatureToggles()[String(frame.feature)] === "off" ? "off" : "on",
  });
  // 5/6. apply only the accepted ones, through the toggle surface the app already has.
  if (decision.verdict === "applied" && decision.msg) {
    setFeatureToggle(decision.msg.feature as never, decision.msg.op === "toggle-off");
  }
  remember(decision.row, decision.verdict);
  notifyLivePatch();
  const durable = await appendAuditRow(decision.row);
  return { verdict: decision.verdict, reason: decision.reason, row: decision.row, durable: durable.ok };
}

/**
 * [F110 §5] ROLL BACK. Inverts exactly what patches did (via each row's recorded
 * `prev`), writes ONE marker row so the log says the rollback happened and so a second
 * click cannot undo the operator's own switches, then asks for a reload through the
 * injectable seam. It never calls clearFeatureToggles(): that would wipe dev toggles
 * the HUD set by hand, which are nobody's patches to remove.
 */
export async function rollbackLivePatches(opts?: { reload?: boolean }): Promise<{ restored: number; durable: boolean }> {
  await primeAudit();
  const plan = rollbackPlan(rows);
  if (plan.length === 0) {
    // Nothing pending: write no marker, request no reload. A second click that appended
    // "rolled-back-0" rows would let the log fill with nothing (and reload the page under
    // the operator's feet) - the button is disabled at this count, and this is the rule
    // that keeps it honest for every OTHER caller.
    return { restored: 0, durable: true };
  }
  for (const step of plan) {
    setFeatureToggle(step.feature as never, step.off);
  }
  const marker = buildRollbackRow(plan.length, { now: Date.now() });
  rows = trimAuditRows(rows.concat([marker]), PATCH_AUDIT_MAX_ROWS);
  appliedIds = appliedPatchIds(rows); // the applied ids AFTER the marker - empty, by design
  notifyLivePatch();
  const durable = await appendAuditRow(marker);
  if (opts && opts.reload === false) return { restored: plan.length, durable: durable.ok };
  requestPatchReload();
  return { restored: plan.length, durable: durable.ok };
}

/** Drop the durable log AND the live view. The operator's own HUD toggles are untouched. */
export async function forgetAuditLog(): Promise<void> {
  primeToken += 1; // no read started before the clear may land after it
  await clearAudit();
  rows = [];
  appliedIds = [];
  // primed STAYS true: this page has read the log, and it is now empty by request.
  primed = true;
}

/** Test-only: forget every module-level buffer and seam. */
export function __resetLivePatchChannelForTests(): void {
  primeToken += 1;
  rows = [];
  appliedIds = [];
  primed = false;
  macProvider = null;
}
