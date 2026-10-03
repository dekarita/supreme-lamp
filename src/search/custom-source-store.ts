// [F58 §1] Runtime store for OPERATOR-ADDED custom sources.
//
// What this file is: the in-memory registry + the persistence contract. The
// descriptors live on the runner at ~/.ghrdp/sources/*.json, encrypted at rest
// with the F46 per-run key, and are pulled at startup from the Tailscale
// operator store (env TS_SOURCES_URL, auth via the F49 GHRDP_ secret pattern).
// The crypto + the file ops are the runner's (payloads/ghrdp-sources.ps1, proven
// by tests/f58-source-store.ps1); THIS module never touches a filesystem and
// never sees a key: it consumes an injected, already-decrypted blob and writes
// back through an injected backend that reports the sha256 it stored.
//
// Invariants enforced here (all re-checked by the Vitest cells):
//   * a descriptor = the frozen F56 16 required fields + the 3 F58 additions,
//     validated by src/search/custom-source-core.js (single source of the rules);
//   * CRUD writes persist and are read back: sha256 mismatch REVERTS the write;
//   * startup decrypt failure REFUSES startup (no plaintext fallthrough, ever);
//   * startup fetch failure falls back to the last-known cached copy READ-ONLY
//     until the next successful pull;
//   * hard rate limits (1 concurrent / 60 rpm / 30s) and the per-search fan-out
//     cap of 8 are enforced at runtime, not just declared;
//   * parseContract is pinned from the add-time probe after operator confirmation:
//     no runtime discovery is possible afterwards.
import F58 from "./custom-source-core";
import type { ProvenanceRecord, SourceDescriptor, SourceExtension } from "./custom-source-core";

export type { ProvenanceRecord, SourceDescriptor, SourceExtension } from "./custom-source-core";
export { F58 };

export const STORE_PATH_LITERAL = "~/.ghrdp/sources";
export const ENV_SOURCES_URL = "TS_SOURCES_URL";
export const HARD = F58.HARD;
export const FAN_OUT_CAP = F58.FAN_OUT_CAP;
export const PROVENANCE_FIELDS = F58.PROVENANCE_FIELDS;
export const SOURCE_CATEGORIES = F58.SOURCE_CATEGORIES;
export const SCHEMA_SHA256_PINNED = "c33601d94e55bab77cf940918c2949430ba5db19faf3314049f6dedb882336c8";

export interface SourceStatus {
  reachable: boolean | null;
  robotsOk: boolean | null;
  rateLimitedHits: number;
  lastError: string | null;
  lastActiveAt: string | null;
  fetchDisabledReason: string | null;
}

export interface SourceEntry {
  descriptor: SourceDescriptor;
  f58: SourceExtension;
  status: SourceStatus;
  parseContractPinned: boolean;
  probeError: string | null;
  updatedAt: string;
}

export interface PersistOutcome {
  ok: boolean;
  sha256: string;
  reason: string | null;
  bytes: number;
}

/** Runner-side seam. `readBack` MUST return exactly what was stored (the store
 *  compares digests); `write` is where the F46 at-rest encryption happens. */
export interface SourceStoreBackend {
  write(json: string): Promise<{ sha256: string } | never>;
  readBack(): Promise<string | null>;
}

export interface StartupDeps {
  /** Blob pull (Tailscale operator store). Injected: no URL is read from code. */
  fetchBlob?: () => Promise<string | null>;
  /** F46 per-run-key decrypt. Must return null/false on ANY failure. */
  decrypt: (cipher: string) => Promise<string | null>;
  /** Last-known local cached copy (already-decrypted blob text is NEVER cached). */
  readCachedCipher?: () => Promise<string | null>;
  backend?: SourceStoreBackend;
  now?: () => Date;
}

export type StartupMode = "live" | "cache-read-only" | "refused";

export interface StartupOutcome {
  mode: StartupMode;
  readOnly: boolean;
  count: number;
  reason: string | null;
  ids: string[];
}

// ---------------------------------------------------------------------------
// digest (integrity check for the round-trip verify; the at-rest cipher is the
// runner's F46 layer, never this function)
// ---------------------------------------------------------------------------
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const withPad = new Uint8Array((((len + 9) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bits >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bits / 4294967296), false);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    for (let i = 0; i < 8; i++) H[i] = (H[i] + [a, b, c, d, e, f, g, h][i]) >>> 0;
  }
  return H.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** Canonical JSON: stable key order, so two writers agree on one digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------
function emptyStatus(): SourceStatus {
  return { reachable: null, robotsOk: null, rateLimitedHits: 0, lastError: null, lastActiveAt: null, fetchDisabledReason: null };
}

export interface CreateStoreOptions {
  backend?: SourceStoreBackend;
  now?: () => Date;
}

export interface CustomSourceStore {
  entries(): SourceEntry[];
  get(id: string): SourceEntry | null;
  validate(descriptor: unknown, extension: unknown): { ok: boolean; errors: string[] };
  create(descriptor: SourceDescriptor, extension: SourceExtension): { ok: boolean; errors: string[]; entry: SourceEntry | null };
  update(id: string, patch: Partial<SourceDescriptor>): { ok: boolean; errors: string[] };
  pause(id: string): { ok: boolean; reason?: string };
  resume(id: string): { ok: boolean; reason?: string };
  remove(id: string, confirm: { name: string; lastActiveAt: string | null }): { ok: boolean; reason?: string };
  setStatus(id: string, patch: Partial<SourceStatus>): void;
  pinParseContract(id: string, contract: SourceDescriptor["parseContract"]): { ok: boolean; reason?: string };
  proposeRuntimeParse(id: string): { ok: boolean; reason: string };
  loadBlob(json: string, opts?: { readOnly?: boolean }): { ok: boolean; count: number; rejected: { id: string; errors: string[] }[] };
  serialize(): string;
  persist(): Promise<PersistOutcome>;
  setReadOnly(v: boolean): void;
  isReadOnly(): boolean;
  subscribe(fn: () => void): () => void;
  reset(): void;
  planForSearch(): { cap: number; selected: string[]; dropped: string[] };
  provenanceFor(id: string, fileName: string, rec: ProvenanceRecord | null): { fetchEnabled: boolean; reason: string | null; applies: boolean; missing: string[] };
  isCustomSource(id: string): boolean;
  recordProvenance(resultId: string, rec: ProvenanceRecord): void;
  provenanceRecordFor(resultId: string): ProvenanceRecord | null;
}

export function createCustomSourceStore(opts: CreateStoreOptions = {}): CustomSourceStore {
  const now = opts.now || (() => new Date());
  let map = new Map<string, SourceEntry>();
  let readOnly = false;
  let lastPersisted: string | null = null;
  // §3 per-result PROVENANCE-6 bag. F56-d fills it from the release payload; a
  // row it never filled is exactly the fail-closed case the gate proves.
  const provenance = new Map<string, ProvenanceRecord>();
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((fn) => { try { fn(); } catch { /* a listener may not break the store */ } });

  const key = (d: { id?: unknown }) => String(d && d.id ? d.id : "");

  const store: CustomSourceStore = {
    entries: () => [...map.values()].sort((a, b) => key(a.descriptor).localeCompare(key(b.descriptor))),
    get: (id) => map.get(id) || null,
    validate: (descriptor, extension) => {
      const r = F58.validate(descriptor, extension);
      return { ok: r.ok, errors: r.errors };
    },
    create: (descriptor, extension) => {
      if (readOnly) return { ok: false, errors: ["store-read-only: reconnect to the operator store before writing"], entry: null };
      const id = key(descriptor);
      if (map.has(id)) return { ok: false, errors: ["duplicate adapter id: " + id], entry: null };
      // §3 the hard defaults are applied, not merely checked: an operator cannot
      // add a source that fans out faster than the registry allows.
      const enforced = F58.enforceRateLimit(descriptor);
      const v = F58.validate(enforced.value, extension);
      if (!v.ok) return { ok: false, errors: v.errors, entry: null };
      const entry: SourceEntry = {
        descriptor: enforced.value,
        f58: extension,
        status: emptyStatus(),
        parseContractPinned: false,
        probeError: enforced.violations.length ? "rate-limit-clamped: " + enforced.violations.join("; ") : null,
        updatedAt: now().toISOString(),
      };
      map.set(id, entry);
      emit();
      return { ok: true, errors: [], entry };
    },
    update: (id, patch) => {
      if (readOnly) return { ok: false, errors: ["store-read-only: reconnect to the operator store before writing"] };
      const cur = map.get(id);
      if (!cur) return { ok: false, errors: ["unknown source id: " + id] };
      const next = { ...cur.descriptor, ...patch, id };
      const enforced = F58.enforceRateLimit(next);
      const v = F58.validate(enforced.value, cur.f58);
      if (!v.ok) return { ok: false, errors: v.errors };
      map.set(id, { ...cur, descriptor: enforced.value, updatedAt: now().toISOString(), probeError: enforced.violations.length ? "rate-limit-clamped: " + enforced.violations.join("; ") : cur.probeError });
      emit();
      return { ok: true, errors: [] };
    },
    pause: (id) => {
      const cur = map.get(id);
      if (!cur) return { ok: false, reason: "unknown source id: " + id };
      if (readOnly) return { ok: false, reason: "store-read-only: reconnect to the operator store before writing" };
      map.set(id, { ...cur, f58: { ...cur.f58, enableState: "paused" }, updatedAt: now().toISOString() });
      emit();
      return { ok: true };
    },
    resume: (id) => {
      const cur = map.get(id);
      if (!cur) return { ok: false, reason: "unknown source id: " + id };
      if (readOnly) return { ok: false, reason: "store-read-only: reconnect to the operator store before writing" };
      map.set(id, { ...cur, f58: { ...cur.f58, enableState: "permanent" }, updatedAt: now().toISOString() });
      emit();
      return { ok: true };
    },
    remove: (id, confirm) => {
      const cur = map.get(id);
      if (!cur) return { ok: false, reason: "unknown source id: " + id };
      if (readOnly) return { ok: false, reason: "store-read-only: reconnect to the operator store before writing" };
      // §2 the confirmation modal must name the source and echo the last-active
      // timestamp: a remove with a mismatched confirmation is refused.
      if (!confirm || String(confirm.name) !== String(cur.descriptor.nameKey) + "|" + String(cur.descriptor.baseUrl)) {
        return { ok: false, reason: "remove-confirmation-mismatch" };
      }
      if (String(confirm.lastActiveAt || "") !== String(cur.status.lastActiveAt || "")) {
        return { ok: false, reason: "remove-confirmation-stale" };
      }
      map.delete(id);
      emit();
      return { ok: true };
    },
    setStatus: (id, patch) => {
      const cur = map.get(id);
      if (!cur) return;
      const status: SourceStatus = { ...cur.status, ...patch };
      if (patch.lastActiveAt === undefined && (patch.reachable !== undefined || patch.robotsOk !== undefined)) status.lastActiveAt = now().toISOString();
      map.set(id, { ...cur, status, updatedAt: now().toISOString() });
      emit();
    },
    pinParseContract: (id, contract) => {
      const cur = map.get(id);
      if (!cur) return { ok: false, reason: "unknown source id: " + id };
      if (readOnly) return { ok: false, reason: "store-read-only: reconnect to the operator store before writing" };
      const next = { ...cur.descriptor, parseContract: contract };
      const v = F58.validate(next, cur.f58);
      if (!v.ok) return { ok: false, reason: "invalid parse contract: " + v.coreErrors[0] };
      map.set(id, { ...cur, descriptor: next, parseContractPinned: true, updatedAt: now().toISOString() });
      emit();
      return { ok: true };
    },
    // §2 no runtime discovery after the pin: the only legal mutation path is the
    // operator confirming an add-time probe result (pinParseContract above).
    proposeRuntimeParse: (id) => (map.has(id) ? { ok: false, reason: "runtime-discovery-refused: parseContract is pinned at add-time for " + id } : { ok: false, reason: "unknown source id: " + id }),
    loadBlob: (json, loadOpts) => {
      const rejected: { id: string; errors: string[] }[] = [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { ok: false, count: 0, rejected: [{ id: "(blob)", errors: ["operator-blob-unparseable"] }] };
      }
      const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { sources?: unknown[] }).sources || [] : [];
      const next = new Map<string, SourceEntry>();
      for (const raw of list) {
        const item = raw as { descriptor?: SourceDescriptor; f58?: SourceExtension; status?: Partial<SourceStatus> };
        const d = item && item.descriptor;
        const x = item && item.f58;
        if (!d || !x) { rejected.push({ id: key((d || {}) as SourceDescriptor), errors: ["blob row missing descriptor or f58 extension"] }); continue; }
        const v = F58.validate(d, x);
        if (!v.ok) { rejected.push({ id: key(d), errors: v.errors }); continue; }
        next.set(key(d), { descriptor: d, f58: x, status: { ...emptyStatus(), ...(item.status || {}) }, parseContractPinned: true, probeError: null, updatedAt: now().toISOString() });
      }
      map = next;
      readOnly = Boolean(loadOpts && loadOpts.readOnly);
      lastPersisted = store.serialize();
      emit();
      return { ok: rejected.length === 0, count: map.size, rejected };
    },
    serialize: () => canonicalJson({ store: "ghrdp-custom-sources", count: map.size, sources: [...map.values()] }),
    persist: async () => {
      const json = store.serialize();
      const digest = sha256Hex(json);
      if (!opts.backend) return { ok: false, sha256: digest, reason: "no store backend wired (F56-d runner path)", bytes: json.length };
      try {
        const written = await opts.backend.write(json);
        const back = await opts.backend.readBack();
        if (back == null) return { ok: false, sha256: digest, reason: "persist-verify: read-back missing", bytes: json.length };
        const backDigest = sha256Hex(back);
        if (backDigest !== digest || written.sha256 !== digest) {
          if (lastPersisted != null) {
            // Revert to the last known-good persisted state: a half-written
            // registry is worse than a stale one.
            store.loadBlob(lastPersisted, { readOnly });
          }
          return { ok: false, sha256: digest, reason: "persist-verify: sha256 round-trip mismatch (" + backDigest.slice(0, 12) + " != " + digest.slice(0, 12) + ")", bytes: json.length };
        }
        lastPersisted = json;
        return { ok: true, sha256: digest, reason: null, bytes: json.length };
      } catch (err) {
        return { ok: false, sha256: digest, reason: "persist-failed: " + (err instanceof Error ? err.message : String(err)), bytes: json.length };
      }
    },
    setReadOnly: (v) => { readOnly = v; emit(); },
    isReadOnly: () => readOnly,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    reset: () => { map = new Map(); lastPersisted = null; readOnly = false; emit(); },
    planForSearch: () => F58.planFanOut(store.entries()) as { cap: number; selected: string[]; dropped: string[] },
    provenanceFor: (id, fileName, rec) => {
      const cur = map.get(id);
      const verdict = F58.evaluateProvenance(fileName, rec);
      if (cur && !verdict.fetchEnabled && verdict.reason) store.setStatus(id, { fetchDisabledReason: verdict.reason });
      if (cur && verdict.fetchEnabled && cur.status.fetchDisabledReason && verdict.applies) store.setStatus(id, { fetchDisabledReason: null });
      return { fetchEnabled: verdict.fetchEnabled, reason: verdict.reason, applies: verdict.applies, missing: verdict.missing };
    },
    isCustomSource: (id) => map.has(id),
    recordProvenance: (resultId, rec) => {
      provenance.set(resultId, rec);
    },
    provenanceRecordFor: (resultId) => provenance.get(resultId) || null,
  };
  return store;
}

/** The registry the UI surfaces share: Settings and the AdvancedPanel inline card
 *  both read/write THIS instance, so there is exactly one store (§2). */
export const customSources = createCustomSourceStore();

// ---------------------------------------------------------------------------
// §1 startup wiring
// ---------------------------------------------------------------------------
export async function bootstrapCustomSources(deps: StartupDeps, store: CustomSourceStore = customSources): Promise<StartupOutcome> {
  const refuse = (reason: string): StartupOutcome => {
    store.reset();
    return { mode: "refused", readOnly: true, count: 0, reason, ids: [] };
  };
  let cipher: string | null = null;
  let fromCache = false;
  try {
    cipher = deps.fetchBlob ? await deps.fetchBlob() : null;
  } catch {
    cipher = null;
  }
  if (cipher == null) {
    // fetch fail -> last-known local cached copy, read-only until reconnect.
    try {
      cipher = deps.readCachedCipher ? await deps.readCachedCipher() : null;
    } catch {
      cipher = null;
    }
    fromCache = cipher != null;
    if (!fromCache) return { mode: "live", readOnly: false, count: 0, reason: "operator-store-unreachable: no cached blob, registry starts empty", ids: [] };
  }
  const blob: string | null = cipher;
  if (blob == null) return { mode: "live", readOnly: false, count: 0, reason: "operator-store-unreachable: no cached blob, registry starts empty", ids: [] };
  let plain: string | null = null;
  try {
    plain = await deps.decrypt(blob);
  } catch {
    plain = null;
  }
  if (plain == null) {
    // decrypt fail = REFUSE startup. No plaintext fallthrough: the cached copy is
    // not retried, nothing is written anywhere in the clear.
    return refuse(fromCache ? "decrypt-failed:cached-copy (startup refused)" : "decrypt-failed (startup refused, cached copy not retried)");
  }
  const res = store.loadBlob(plain, { readOnly: fromCache });
  const ids = store.entries().map((e) => String(e.descriptor.id));
  if (!res.ok && res.rejected.length) {
    return { mode: fromCache ? "cache-read-only" : "live", readOnly: fromCache, count: res.count, reason: "blob-rows-rejected: " + res.rejected.map((r) => r.id).join(","), ids };
  }
  return { mode: fromCache ? "cache-read-only" : "live", readOnly: fromCache, count: res.count, reason: null, ids };
}

/** Only used when the operator exported TS_SOURCES_URL into the bundle env; with
 *  it unset the module performs ZERO network calls (offline-safe single file). */
export function operatorStoreUrlFromEnv(env: Record<string, string | undefined> = {}): string | null {
  const raw = env[ENV_SOURCES_URL] || (typeof import.meta !== "undefined" && import.meta.env ? (import.meta.env.VITE_TS_SOURCES_URL as string | undefined) : undefined);
  if (!raw) return null;
  const host = F58.hostOf(raw);
  if (!host) return null; // https only; no plaintext blob from an http origin
  return raw;
}

// ---------------------------------------------------------------------------
// §2 add-time probe cycle + §3 runtime limits
// ---------------------------------------------------------------------------
export interface ProbeResult {
  reachable: boolean;
  robotsOk: boolean;
  suggestedParseContract: SourceDescriptor["parseContract"] | null;
  error: string | null;
  /** [F70 §3.2] deep-probe verdict from POST /api/search/probe; "approve" is
   *  required to save without the explicit operator override. */
  recommendation?: "approve" | "warn" | null;
}

export async function runAddTimeProbe(
  descriptor: SourceDescriptor,
  probe: (d: SourceDescriptor) => Promise<Partial<ProbeResult>>,
  fetchRobots?: (url: string) => Promise<string | null>
): Promise<ProbeResult> {
  void fetchRobots;
  let partial: Partial<ProbeResult> = {};
  try {
    partial = await probe(descriptor);
  } catch (err) {
    partial = { error: "probe-failed: " + (err instanceof Error ? err.message : String(err)) };
  }
  const suggested = partial.suggestedParseContract || null;
  return {
    reachable: partial.reachable === true,
    robotsOk: partial.robotsOk === true,
    suggestedParseContract: suggested,
    error: partial.error || null,
    recommendation: partial.recommendation === "approve" ? "approve" : partial.recommendation === "warn" ? "warn" : null,
  };
}

export function autoSuggestParseContract(sampleKeys: string[]): SourceDescriptor["parseContract"] {
  const fieldMappings: Record<string, string> = {};
  for (const k of sampleKeys) {
    if (["name", "title", "label"].includes(k)) fieldMappings.title = k;
    else if (["url", "html_url", "link"].includes(k)) fieldMappings.sourceUrl = k;
    else if (["updated_at", "published", "date"].includes(k)) fieldMappings.date = k;
  }
  if (!Object.keys(fieldMappings).length) fieldMappings.title = sampleKeys[0] || "name";
  return { format: "json", resultSelector: "$." + (sampleKeys.length ? "items[*]" : ""), fieldMappings, pagination: "cursor:query.cursor" };
}

/** §3 the ONLY runtime limiter: 1 concurrent, 60 rpm, 30s per request. No source
 *  may widen it (HARD.overridable === false). */
export interface SourceThrottle {
  tryAcquire(id: string, atMs?: number): { ok: boolean; reason: string | null };
  release(id: string): void;
  inFlight(id: string): number;
  requestDeadlineMs(): number;
  stats(id: string): { concurrency: number; requestsPerMinute: number; window: number[] };
}

export function createSourceThrottle(limits: { concurrency?: number; requestsPerMinute?: number } = {}): SourceThrottle {
  const conc = Math.min(HARD.concurrency, limits.concurrency || HARD.concurrency);
  const rpm = Math.min(HARD.requestsPerMinute, limits.requestsPerMinute || HARD.requestsPerMinute);
  const flight = new Map<string, number>();
  const hits = new Map<string, number[]>();
  return {
    tryAcquire: (id, atMs) => {
      const t = atMs == null ? Date.now() : atMs;
      const used = (flight.get(id) || 0) >= conc;
      if (used) return { ok: false, reason: "rate-limit-concurrency: " + conc + " in flight (hard cap, no override)" };
      const recent = (hits.get(id) || []).filter((x) => t - x < 60_000);
      if (recent.length >= rpm) return { ok: false, reason: "rate-limit-rpm: " + rpm + " requests/minute (hard cap, no override)" };
      recent.push(t);
      hits.set(id, recent);
      flight.set(id, (flight.get(id) || 0) + 1);
      return { ok: true, reason: null };
    },
    release: (id) => { flight.set(id, Math.max(0, (flight.get(id) || 1) - 1)); },
    inFlight: (id) => flight.get(id) || 0,
    requestDeadlineMs: () => HARD.requestTimeoutSec * 1000,
    stats: (id) => ({ concurrency: conc, requestsPerMinute: rpm, window: hits.get(id) || [] }),
  };
}

// ---------------------------------------------------------------------------
// §3 result-level PROVENANCE-6 verdict (pure: the card renders this, it writes
// nothing, so a re-render can never loop the store).
// ---------------------------------------------------------------------------
export interface ResultLike {
  resultId: string;
  adapterId: string;
  title: string;
  sourceUrl?: string | null;
  sizeBytes?: number | null;
  contentLength?: number | null;
  creator?: string | null;
  releasePageUrl?: string | null;
  artifactSha256?: string | null;
  artifactSignatureStatus?: string | null;
  artifactPublisher?: string | null;
  artifactFileName?: string | null;
}

/** Artifact name = URL basename when the URL parses, else the title. */
export function artifactFileName(r: ResultLike): string {
  const fromUrl = F58.hostOf(String(r.sourceUrl || "")) ? String(r.sourceUrl).split("?")[0].split("#")[0].split("/").pop() || "" : "";
  const name = String(r.artifactFileName || fromUrl || r.title || "").trim();
  return name;
}

/** Maps whatever the result row carries onto the six PROVENANCE-6 slots. Missing
 *  slot = missing field: the row says so, it never guesses. */
export function provenanceRecordFromResult(r: ResultLike): ProvenanceRecord {
  const fileName = artifactFileName(r);
  return {
    fileName: fileName || null,
    byteSize: typeof r.sizeBytes === "number" ? r.sizeBytes : typeof r.contentLength === "number" ? r.contentLength : null,
    publisher: r.artifactPublisher || r.creator || null,
    sha256: r.artifactSha256 || null,
    signatureStatus: r.artifactSignatureStatus || null,
    releasePageUrl: r.releasePageUrl || null,
  };
}

export function evaluateResultProvenance(
  store: CustomSourceStore,
  r: ResultLike,
  override?: ProvenanceRecord | null
): { custom: boolean; applies: boolean; fetchEnabled: boolean; missing: string[]; reason: string | null } {
  const custom = store.isCustomSource(r.adapterId);
  const rec = override || store.provenanceRecordFor(r.resultId) || provenanceRecordFromResult(r);
  const verdict = F58.evaluateProvenance(artifactFileName(r), rec);
  return { custom, applies: verdict.applies, fetchEnabled: verdict.fetchEnabled, missing: verdict.missing, reason: verdict.reason };
}
