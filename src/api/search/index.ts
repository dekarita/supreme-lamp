// [F56-c] Typed client for the frozen F56 search API (docs/f56/backend.json,
// Plan §F). Three endpoints only: POST /api/search, GET /api/search/status,
// POST /api/search/cancel. Nothing here fetches content bytes - Fetch/Preview
// belong to POST /api/fetch in F56-d and must not appear in this phase.
// Auth mirrors the F49 pattern: X-Dash-Token header only (never a URL key).
// F56-b owns the server side of these routes; this client is the F56-c wiring.
import { apiBase, getKey } from "@/lib/api";

export type Scope = "federated" | "own-storage";
export type SortKey = "relevance" | "size" | "date";
export type Category =
  | "books"
  | "audio"
  | "scholarly"
  | "education"
  | "media"
  | "software"
  | "music"
  | "video"
  | "own-storage"
  | "purchase";
export type LicenceTag = "public-domain" | "open-access" | "creative-commons" | "purchase" | "own-storage";
export type SearchPhase = "idle" | "queued" | "running" | "partial" | "complete" | "empty" | "failed" | "cancelled";
export type AdapterStatusValue =
  | "idle"
  | "queued"
  | "running"
  | "complete"
  | "empty"
  | "rate-limited"
  | "blocked-robots"
  | "timed-out"
  | "failed"
  | "cancelled";

export interface AdapterState {
  adapterId: string;
  nameKey: string;
  status: AdapterStatusValue;
  resultCount: number;
  cursor?: string | null;
  retryAfter?: string | null;
  lastErrorCode?: string | null;
  requestGeneration?: number;
  contributingPartialResults?: boolean;
  cancellationState?: string | null;
}

export interface SearchResult {
  resultId: string;
  adapterId: string;
  nameKey: string;
  category: Category;
  title: string;
  creator?: string | null;
  snippet?: string | null;
  sizeBytes?: number | null;
  contentLength?: number | null;
  licenceTag: LicenceTag;
  licenceEvidence?: string | null;
  sourceSnapshotId: string;
  sourceUrl: string;
  previewUrl?: string | null;
  purchaseUrl?: string | null;
  transportHint?: string | null;
  mimeType?: string | null;
  date?: string | null;
  availability?: string | null;
}

export interface SearchCreateRequest {
  requestId: string;
  query: string;
  scope: Scope;
  categories?: Category[];
  licenceTags?: LicenceTag[];
  maxSizeBytes?: number;
  sort: SortKey;
  limit: number;
  cursor?: string;
  adapterIds?: string[];
}

export interface SearchCreateAccepted {
  requestId: string;
  searchId: string;
  phase: SearchPhase;
  acceptedAdapterIds: string[];
  statusRef: string;
  queryGeneration: number;
  adapterStatuses: AdapterState[];
}

export interface SearchStatus {
  searchId: string;
  phase: SearchPhase;
  queryGeneration: number;
  adapterStatuses: AdapterState[];
  results: SearchResult[];
  cursor?: string | null;
  hasMore: boolean;
  serverTs: string;
  cancellationState?: string | null;
}

export interface SearchCancelRequest {
  requestId: string;
  searchId: string;
  reason: string;
}

export interface SearchCancelResult {
  searchId: string;
  cancellationState: string;
  adapterCancellations?: Record<string, string>;
  idempotency?: string;
}

export interface ErrorEnvelope {
  requestId: string;
  traceId: string;
  code: string;
  messageKey: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope };

export function newRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function envelopeFor(requestId: string, code: string, messageKey: string, retryable: boolean, retryAfterSeconds?: number): ErrorEnvelope {
  return { requestId, traceId: "", code, messageKey, retryable, retryAfterSeconds };
}

/**
 * [F95 §3.5 / R5] THE SPECIFIC MESSAGE FOR A STATUS CODE.
 *
 * ROOT CAUSE of "Something went wrong. Retry" for everything: the non-2xx arm
 * fell back to `search.errors.generic` whenever the SERVER did not supply a
 * messageKey - which it does not for 401 or 404 - and the `catch` arm used the
 * generic key for every thrown fetch. So an expired session, a rate limit and
 * a dead connection all rendered as one sentence and the operator could not
 * tell which action to take.
 *
 * This table is consulted ONLY as a fallback: a messageKey the server DID send
 * still wins, because it knows more about its own failure than a status code
 * does. `search.errors.generic` is now reserved for genuinely unknown errors.
 */
export function statusMessageKey(status: number): { code: string; messageKey: string; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "UNAUTHENTICATED", messageKey: "search.errors.sessionExpired", retryable: false };
  if (status === 404) return { code: "NOT_FOUND", messageKey: "search.errors.notFound", retryable: false };
  if (status === 400 || status === 422) return { code: "VALIDATION_ERROR", messageKey: "search.errors.validation", retryable: false };
  if (status === 413) return { code: "PAYLOAD_TOO_LARGE", messageKey: "search.errors.payloadTooLarge", retryable: false };
  if (status === 429) return { code: "RATE_LIMITED", messageKey: "search.errors.rateLimitedGeneric", retryable: true };
  if (status >= 500 && status <= 599) return { code: "SERVER_ERROR", messageKey: "search.errors.serverError", retryable: true };
  return { code: "INTERNAL_ERROR", messageKey: "search.errors.generic", retryable: false };
}

/**
 * [F95 §3.5 / R5] A thrown fetch is NOT "something went wrong": it means the
 * request never reached the server, i.e. the connection is gone. The dashboard
 * already knows this state independently (the F95 WS reconnect ladder publishes
 * `wsDead`), so name it and point at the Reconnect control instead of asking
 * the operator to retry an action that cannot succeed.
 */
export function transportErrorKey(): { code: string; messageKey: string } {
  return { code: "TRANSPORT_UNAVAILABLE", messageKey: "search.errors.connectionLost" };
}

async function callApi<T>(path: string, requestId: string, init: RequestInit): Promise<ApiResult<T>> {
  const key = getKey();
  try {
    const r = await fetch(apiBase() + path, {
      cache: "no-store",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "X-Dash-Token": key } : {}),
        ...(init.headers || {}),
      },
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    if (r.ok) return { ok: true, data: body as T };
    const env = (body || {}) as Partial<ErrorEnvelope>;
    // [F95 §3.5 / R5] status-specific fallback; an explicit server messageKey
    // still wins over it.
    const cls = statusMessageKey(r.status);
    return {
      ok: false,
      error: envelopeFor(
        String(env.requestId || requestId),
        String(env.code || cls.code),
        String(env.messageKey || cls.messageKey),
        typeof env.retryable === "boolean" ? env.retryable : cls.retryable,
        typeof env.retryAfterSeconds === "number" ? env.retryAfterSeconds : undefined
      ),
    };
  } catch {
    // [F95 §3.5 / R5] was INTERNAL_ERROR + generic for every thrown fetch.
    const cls = transportErrorKey();
    return { ok: false, error: envelopeFor(requestId, cls.code, cls.messageKey, true) };
  }
}

export function createSearch(req: SearchCreateRequest): Promise<ApiResult<SearchCreateAccepted>> {
  return callApi<SearchCreateAccepted>("/api/search", req.requestId, { method: "POST", body: JSON.stringify(req) });
}

export function getSearchStatus(searchId: string, cursor?: string, limit?: number): Promise<ApiResult<SearchStatus>> {
  const params = new URLSearchParams({ searchId });
  if (cursor) params.set("cursor", cursor);
  if (limit != null) params.set("limit", String(limit));
  return callApi<SearchStatus>("/api/search/status?" + params.toString(), searchId, { method: "GET" });
}

export function cancelSearch(req: SearchCancelRequest): Promise<ApiResult<SearchCancelResult>> {
  return callApi<SearchCancelResult>("/api/search/cancel", req.requestId, { method: "POST", body: JSON.stringify(req) });
}

// [F70 §3.1] Deep add-time probe outcome (POST /api/search/probe). The body is
// the F58 SourceDescriptor; the server runs robots.txt + HEAD + a sample
// query + the parse-contract schema match and recommends approve|warn.
export interface ProbeOutcome {
  reachable: boolean;
  robotsOk: boolean;
  schemaMatch: boolean;
  recommendation: "approve" | "warn";
  sampleResultCount?: number;
  sampleItem?: unknown;
  httpStatus?: number;
  contentType?: string | null;
  contentLength?: number | null;
  reason?: string | null;
  disallowRule?: string | null;
  missingFields?: string[];
  sampleResponse?: string | null;
}

export function probeSource(descriptor: unknown): Promise<ApiResult<ProbeOutcome>> {
  return callApi<ProbeOutcome>("/api/search/probe", newRequestId(), { method: "POST", body: JSON.stringify(descriptor) });
}
