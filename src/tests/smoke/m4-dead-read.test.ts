// [M4 / maintenance] The retired shadow key is never sent, at runtime.
//
// `ghrdp-dash-token` was a dead read in src/api/fetch/index.ts and src/lib/f46.ts (nothing ever
// wrote it). M4 deleted both reads. These tests pin the runtime consequence: a value stored under
// that key is never used as a dash token by the fetch client or by the F46 per-run-key request.
//
// Deliberately NOT pinned here: how the canonical key `ghrdp.dashToken` is routed into those two
// clients. Today they send no token for it, which is a known gap (see the M4 record in
// docs/OBSERVATORY-STATE.md). Changing that is a reviewed decision and must not be locked in by a test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestFetch } from '@/api/fetch/index.ts';
import { encryptOwnCreds } from '@/lib/f46';

const SHADOW = 'M4-SHADOW-TOKEN-MUST-NEVER-BE-SENT';
let seen: Array<{ url: string; token: string | null }> = [];

beforeEach(() => {
  seen = [];
  localStorage.clear();
  localStorage.setItem('ghrdp-dash-token', SHADOW);
  (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    const h = (init && init.headers) || {};
    seen.push({ url: String(url), token: h['X-Dash-Token'] ?? null });
    return new Response(JSON.stringify({ ok: true, fetchId: 'f', gid: 'g' }), { status: 202 });
  });
});

describe('M4: the retired shadow key is never sent', () => {
  it('requestFetch does not send a token stored under ghrdp-dash-token', async () => {
    await requestFetch({
      operation: 'start', requestId: 'r1', idempotencyKey: 'i1', resultId: 'x',
      adapterId: 'arxiv', sourceSnapshotId: 's', intent: 'download', transport: 'aria2c', mirrorOptIn: false,
    } as any);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.token === null)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(SHADOW);
  });

  it('encryptOwnCreds (the /api/config per-run-key request) does not send it either', async () => {
    await encryptOwnCreds('user', 'pass');
    const cfg = seen.filter((x) => x.url.includes('/api/config'));
    expect(cfg.length).toBeGreaterThan(0);
    expect(cfg.every((x) => x.token === null)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(SHADOW);
  });
});
