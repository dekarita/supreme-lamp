// [F56-c v2] Fetch stub - the ONE seam F56-d replaces.
//
// The real transfer is POST /api/fetch (aria2c / qBittorrent lanes + the F46
// encrypted tail); F56-d owns the backend and the request shape, so this
// module is deliberately inert: it performs NO network call, takes no URL and
// no byte budget, and returns a typed "not implemented" outcome that the card
// renders as the localized "coming in F56-d" toast. The frozen F56-c gate
// refuses the endpoint literal in executable src/ code (comments and tests may
// name it), and this stub keeps that refusal intact - it is the honest
// placeholder, not a hidden call site.
export const FETCH_STUB_CODE = "F56D_NOT_IMPLEMENTED";

export interface FetchStubOutcome {
  ok: false;
  code: typeof FETCH_STUB_CODE;
  /** Visible, localized message key - rendered as the toast body. */
  messageKey: string;
  /** Proof for the tests + the gate: this stub never touched the network. */
  networkCalls: 0;
}

export interface FetchStubSubject {
  resultId: string;
  sourceUrl?: string | null;
}

/** Returns the stub outcome. Never async, never fetches, never throws - a
 *  result without a validated https:// sourceUrl is still a stub outcome
 *  (F56-d does the allowlist + snapshot + content-length work). */
export function requestFetchStub(subject: FetchStubSubject): FetchStubOutcome {
  void subject;
  return {
    ok: false,
    code: FETCH_STUB_CODE,
    messageKey: "search.v2.toast.fetchStub",
    networkCalls: 0,
  };
}
