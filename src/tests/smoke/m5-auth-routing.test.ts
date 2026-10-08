// [M5 / maintenance] AUTH ROUTING - the runtime half of the proof.
//
// M4 found the bug behind the `ghrdp-dash-token` dead read: `requestFetch` sent NO
// `X-Dash-Token`, and POST /api/fetch requires one (payloads/ghrdp-server.ps1 answers 401
// `dash token required`), so the search download and the own-credential submit could not
// authenticate. M4 pinned that behaviour with a test and left the routing decision to the
// operator. The operator approved the fix (M5), so THIS file pins the new behaviour, and
// M4's pin (`tests/m4-dead-read-cleanup.test.js` M4-D5) was flipped deliberately in the same
// commit - see the M5 record in docs/OBSERVATORY-STATE.md.
//
// What is pinned here, per source of truth:
//   1. a stored canonical token (`ghrdp.dashToken`) IS sent        <- the fix
//   2. nothing stored                                  -> no header (the old guard shape)
//   3. the M4-retired shadow key                       -> still never sent
//   4. the M5-retired `window.__GHRDP_DASH_TOKEN`      -> ignored (it is set here ON PURPOSE)
//   5. `?key=` is a source too, and a good load is banked          <- the resolver's §3.1 rule
//   6. the token never appears in a URL or a request body
//   7. `startFetch` (the search-download path) inherits the header from `requestFetch`
//
// The F101 recorder's masking of this header name is proved separately and already:
// `src/tests/smoke/f101-collector-depth.test.tsx` asserts the recorded value is
// `present(len=10,sha=<8 hex>)` and never the token itself.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestFetch, startFetch } from '@/api/fetch/index.ts';

const STORAGE_KEY = 'ghrdp.dashToken';
const CANONICAL = 'M5-CANONICAL-TOKEN-0123456789abcdef';
const FROM_URL = 'M5-TOKEN-FROM-THE-QUERY-STRING';
const SHADOW = 'M5-SHADOW-TOKEN-MUST-NEVER-BE-SENT';
const OVERRIDE = 'M5-RETIRED-WINDOW-OVERRIDE';

const START = {
  operation: 'start',
  requestId: 'r1',
  idempotencyKey: 'i1',
  resultId: 'x',
  adapterId: 'arxiv',
  sourceSnapshotId: 's',
  intent: 'download',
  transport: 'aria2c',
  mirrorOptIn: false,
} as any;

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let seen: Seen[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  seen = [];
  localStorage.clear();
  try {
    delete (window as any).__GHRDP_DASH_TOKEN;
  } catch {
    /* ignore */
  }
  realFetch = globalThis.fetch;
  // Save/restore, never vi.unstubAllGlobals(): that would also remove setup.ts's offline
  // fetch + FakeWebSocket for every later test in the run (step 8's recorded trap).
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    const headers: Record<string, string> = {};
    const raw = (init && init.headers) || {};
    for (const k of Object.keys(raw)) headers[k] = String(raw[k]);
    seen.push({
      url: String(url),
      method: String((init && init.method) || 'GET').toUpperCase(),
      headers,
      body: String((init && init.body) || ''),
    });
    return new Response(JSON.stringify({ ok: true, fetchId: 'f', gid: 'g' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  localStorage.clear();
  try {
    delete (window as any).__GHRDP_DASH_TOKEN;
  } catch {
    /* ignore */
  }
  try {
    window.history.replaceState({}, '', '/');
  } catch {
    /* ignore */
  }
});

describe('M5: the fetch client authenticates with the canonical dash token', () => {
  it('sends the stored canonical token as X-Dash-Token [the fix]', async () => {
    localStorage.setItem(STORAGE_KEY, CANONICAL);
    await requestFetch(START);
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe('/api/fetch');
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers['X-Dash-Token']).toBe(CANONICAL);
    // non-regression: the request shape is otherwise unchanged
    expect(seen[0].headers['Content-Type']).toBe('application/json');
  });

  it('sends no header at all when no token exists anywhere (the old guard shape)', async () => {
    await requestFetch(START);
    expect(seen.length).toBe(1);
    expect('X-Dash-Token' in seen[0].headers).toBe(false);
  });

  it('still never sends the M4-retired shadow key', async () => {
    localStorage.setItem('ghrdp-dash-token', SHADOW);
    await requestFetch(START);
    expect('X-Dash-Token' in seen[0].headers).toBe(false);
    expect(JSON.stringify(seen)).not.toContain(SHADOW);
  });

  it('ignores the M5-retired window override', async () => {
    (window as any).__GHRDP_DASH_TOKEN = OVERRIDE;
    await requestFetch(START);
    expect('X-Dash-Token' in seen[0].headers).toBe(false);
    expect(JSON.stringify(seen)).not.toContain(OVERRIDE);
  });

  it('accepts ?key= as a source and banks it for later loads (the resolver §3.1 rule)', async () => {
    window.history.replaceState({}, '', '/?key=' + FROM_URL);
    await requestFetch(START);
    expect(seen[0].headers['X-Dash-Token']).toBe(FROM_URL);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(FROM_URL);
  });

  it('never places the token in a URL or a request body', async () => {
    localStorage.setItem(STORAGE_KEY, CANONICAL);
    await requestFetch(START);
    await requestFetch({ operation: 'cancel', requestId: 'r2', fetchId: 'f', gid: 'g' } as any);
    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.url).not.toContain(CANONICAL);
      expect(s.body).not.toContain(CANONICAL);
    }
  });

  it('startFetch (the search-download path) inherits the authenticated call', async () => {
    localStorage.setItem(STORAGE_KEY, CANONICAL);
    await startFetch({ resultId: 'r9', adapterId: 'arxiv', sourceSnapshotId: 's', intent: 'download', transport: 'aria2c', mirrorOptIn: false } as any);
    expect(seen.length).toBe(1);
    expect(seen[0].headers['X-Dash-Token']).toBe(CANONICAL);
  });
});
