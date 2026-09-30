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
    return {
      ok: false,
      error: envelopeFor(
        String(env.requestId || requestId),
        String(env.code || (r.status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR")),
        String(env.messageKey || "search.errors.generic"),
        Boolean(env.retryable),
        typeof env.retryAfterSeconds === "number" ? env.retryAfterSeconds : undefined
      ),
    };
  } catch {
    return { ok: false, error: envelopeFor(requestId, "INTERNAL_ERROR", "search.errors.generic", true) };
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
