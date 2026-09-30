// [F56-d §4] Fetch stub now wraps real client but keeps toast fallback for offline/tests.
// Real transfer is POST /api/fetch (aria2c lane + F46 encrypted tail). This module
// is the compat shim: requestFetchStub still returns a stub outcome for legacy callers,
// while requestFetch (real) is re-exported for new UI.

export const FETCH_STUB_CODE = "F56D_NOT_IMPLEMENTED";

export interface FetchStubOutcome {
  ok: false;
  code: typeof FETCH_STUB_CODE;
  messageKey: string;
  networkCalls: 0;
}

export interface FetchStubSubject {
  resultId: string;
  sourceUrl?: string | null;
}

export function requestFetchStub(subject: FetchStubSubject): FetchStubOutcome {
  void subject;
  return {
    ok: false,
    code: FETCH_STUB_CODE,
    messageKey: "search.v2.toast.fetchStub",
    networkCalls: 0,
  };
}

// Real client re-export for F56-d
export { requestFetch, startFetch, cancelFetch, retryFetch, isProvenanceBlocked } from '../api/fetch/index.ts';
export type { FetchRequest, FetchAccepted, FetchErrorEnvelope } from '../api/fetch/index.ts';

// Wrapper that tries real fetch, falls back to stub toast on network failure
export async function requestFetchWithFallback(subject: FetchStubSubject & { adapterId?: string; sourceSnapshotId?: string; provenance?: any }): Promise<{ ok: boolean; code?: string; messageKey?: string; data?: any; error?: any }> {
  try {
    const { requestFetch: realFetch } = await import('../api/fetch/index.ts');
    const res = await realFetch({
      operation: 'start',
      requestId: Math.random().toString(36).slice(2, 12),
      idempotencyKey: Math.random().toString(36).slice(2, 12),
      resultId: subject.resultId,
      adapterId: subject.adapterId || 'custom',
      sourceSnapshotId: subject.sourceSnapshotId || 'snap-' + Date.now(),
      intent: 'download',
      transport: 'aria2c',
      mirrorOptIn: false,
      provenance: subject.provenance,
    } as any);
    if (res.ok) return { ok: true, data: res.data };
    return { ok: false, code: res.error?.code, messageKey: res.error?.messageKey, error: res.error };
  } catch {
    return requestFetchStub(subject);
  }
}
