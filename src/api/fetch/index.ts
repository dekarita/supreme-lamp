// [F56-d §4] Real fetch client POST /api/fetch with traceId, idempotency, provenance-6, own-cred encrypted.
// Replaces F56-c stub. Error envelope 17 codes per F58.

export type FetchOperation = 'start' | 'cancel' | 'retry';

export interface FetchStartRequest {
  operation: 'start';
  requestId: string;
  idempotencyKey: string;
  resultId?: string;
  urlImport?: { url: string };
  adapterId: string;
  sourceSnapshotId: string;
  intent: 'download' | 'preview';
  transport: 'auto' | 'aria2c' | 'torrent';
  mirrorOptIn: boolean;
  provenance?: {
    fileName: string;
    byteSize: number;
    publisher: string;
    sha256: string;
    signatureStatus: string;
    releasePageUrl: string;
  };
  fileName?: string;
  expectedContentLength?: number;
  // Own-cred encrypted (F46 per-run key AES-GCM)
  credUserEnc?: string;
  credPassEnc?: string;
  credKeyB64?: string;
  credKeyIv?: string;
  // Lab fallback plain (never in prod, but test fixture allows)
  credUser?: string;
  credPass?: string;
}

export interface FetchCancelRequest {
  operation: 'cancel';
  requestId: string;
  fetchId: string;
  gid: string;
}

export interface FetchRetryRequest {
  operation: 'retry';
  requestId: string;
  fetchId: string;
  sourceSnapshotId: string; // fresh snapshot required
}

export type FetchRequest = FetchStartRequest | FetchCancelRequest | FetchRetryRequest;

export interface FetchAccepted {
  requestId: string;
  traceId: string;
  fetchId: string;
  gid: string;
  progressRef: string;
  sourceSnapshotId: string;
  cipherSnapshotId?: string;
  expectedContentLength?: number;
  wireLength?: number;
  pipelineStages: string[];
  mirrorOptIn: boolean;
  status: string;
}

export type FetchErrorCode =
  | 'VALIDATION_ERROR'
  | 'HTTPS_ONLY'
  | 'UNKNOWN_SOURCE'
  | 'DOMAIN_NOT_ALLOWLISTED'
  | 'ALLOWLIST_OFF'
  | 'ROBOTS_DISALLOW'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PARSE_FAILED'
  | 'NO_LICENCE_EVIDENCE'
  | 'SNAPSHOT_MISMATCH'
  | 'CONTENT_LENGTH_REQUIRED'
  | 'WIRE_LENGTH_MISMATCH'
  | 'TRANSPORT_UNAVAILABLE'
  | 'SEARCH_CANCELLED'
  | 'FETCH_CANCELLED'
  | 'CLASSIFIER_BLOCKED';

export interface FetchErrorEnvelope {
  requestId: string;
  traceId: string;
  code: FetchErrorCode;
  messageKey: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}

export interface FetchResult {
  ok: boolean;
  data?: FetchAccepted;
  error?: FetchErrorEnvelope;
}

function genId(): string {
  try {
    // Use crypto.randomUUID if available
    // @ts-ignore
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  } catch {}
  return Math.random().toString(36).slice(2, 14);
}

function getDashToken(): string {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('ghrdp-dash-token') : null;
    if (ls) return ls;
  } catch {}
  try {
    // @ts-ignore
    if (typeof window !== 'undefined' && (window as any).__GHRDP_DASH_TOKEN) return (window as any).__GHRDP_DASH_TOKEN as string;
  } catch {}
  return '';
}

export async function requestFetch(req: FetchRequest): Promise<FetchResult> {
  const requestId = (req as any).requestId || genId();
  const traceId = genId();
  const idempotencyKey = (req as any).idempotencyKey || genId();
  const payload = { ...req, requestId, idempotencyKey, traceId } as any;

  const token = getDashToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['X-Dash-Token'] = token;
  // CSRF token if available
  try {
    // @ts-ignore
    const csrf = typeof document !== 'undefined' ? document.querySelector('meta[name=\"csrf-token\"]')?.getAttribute('content') : null;
    if (csrf) headers['X-CSRF-Token'] = csrf;
  } catch {}

  try {
    const res = await fetch('/api/fetch', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }

    if (res.status === 202 || res.status === 200) {
      if (json && json.fetchId && json.gid) {
        return { ok: true, data: json as FetchAccepted };
      }
      // If server returns envelope with fetchId/gid, treat as success
      if (json && (json.fetchId || json.gid)) {
        return { ok: true, data: json as FetchAccepted };
      }
      // Fallback error
      return {
        ok: false,
        error: {
          requestId,
          traceId,
          code: 'VALIDATION_ERROR',
          messageKey: 'search.errors.validation',
          retryable: false,
          details: { httpStatus: res.status, body: text.slice(0, 500) },
        },
      };
    }

    // Error envelope handling - 17 codes
    if (json && json.code) {
      return {
        ok: false,
        error: {
          requestId: json.requestId || requestId,
          traceId: json.traceId || traceId,
          code: json.code as FetchErrorCode,
          messageKey: json.messageKey || 'search.errors.generic',
          retryable: !!json.retryable,
          retryAfterSeconds: json.retryAfterSeconds,
          details: json.details,
        },
      };
    }

    // Map HTTP status to code
    let code: FetchErrorCode = 'VALIDATION_ERROR';
    if (res.status === 403) {
      if (text.includes('ALLOWLIST') || text.includes('allowlist')) code = 'DOMAIN_NOT_ALLOWLISTED';
      else if (text.includes('ROBOTS') || text.includes('robots')) code = 'ROBOTS_DISALLOW';
      else if (text.includes('CLASSIFIER') || text.includes('classifier')) code = 'CLASSIFIER_BLOCKED';
      else code = 'DOMAIN_NOT_ALLOWLISTED';
    } else if (res.status === 429) code = 'RATE_LIMITED';
    else if (res.status === 408 || res.status === 504) code = 'TIMEOUT';
    else if (res.status === 503 || res.status === 502) code = 'TRANSPORT_UNAVAILABLE';
    else if (res.status === 400) code = 'VALIDATION_ERROR';

    return {
      ok: false,
      error: {
        requestId,
        traceId,
        code,
        messageKey: 'search.errors.generic',
        retryable: res.status >= 500,
        details: { httpStatus: res.status, body: text.slice(0, 500) },
      },
    };
  } catch (e: any) {
    return {
      ok: false,
      error: {
        requestId,
        traceId,
        code: 'TRANSPORT_UNAVAILABLE',
        messageKey: 'search.errors.transportUnavailable',
        retryable: true,
        details: { reason: e?.message || String(e) },
      },
    };
  }
}

export async function startFetch(params: Omit<FetchStartRequest, 'operation' | 'requestId' | 'idempotencyKey'> & { requestId?: string }): Promise<FetchResult> {
  return requestFetch({
    operation: 'start',
    requestId: params.requestId || genId(),
    idempotencyKey: genId(),
    ...params,
  } as FetchStartRequest);
}

export async function cancelFetch(fetchId: string, gid: string): Promise<FetchResult> {
  return requestFetch({
    operation: 'cancel',
    requestId: genId(),
    fetchId,
    gid,
  });
}

export async function retryFetch(fetchId: string, sourceSnapshotId: string): Promise<FetchResult> {
  return requestFetch({
    operation: 'retry',
    requestId: genId(),
    fetchId,
    sourceSnapshotId,
  });
}

// Provenance-6 check client-side (mirrors server gate) - disables Fetch button
export function isProvenanceBlocked(fileName: string | undefined, provenance: FetchStartRequest['provenance'] | undefined): { blocked: boolean; missing: string[] } {
  const execExt = ['.exe', '.msi', '.dmg', '.iso', '.zip'];
  if (!fileName) return { blocked: false, missing: [] };
  const lower = fileName.toLowerCase();
  const isExec = execExt.some(ext => lower.endsWith(ext));
  if (!isExec) return { blocked: false, missing: [] };
  const required: (keyof NonNullable<FetchStartRequest['provenance']>)[] = ['fileName', 'byteSize', 'publisher', 'sha256', 'signatureStatus', 'releasePageUrl'];
  const missing: string[] = [];
  if (!provenance) {
    return { blocked: true, missing: required as string[] };
  }
  for (const r of required) {
    const v = (provenance as any)[r];
    if (v === undefined || v === null || v === '') missing.push(r);
  }
  return { blocked: missing.length > 0, missing };
}
