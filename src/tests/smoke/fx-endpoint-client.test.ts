/**
 * F45 S3 — endpoint client contract, served entirely by the offline MSW server.
 * No live gofile call, no live runner call, no network fallback: an
 * unconfigured URL must fail closed (Explorer §11.1).
 *
 * Proves the parts of §5 that matter before S4 builds the server:
 *   - dash token in a header only, never in the URL
 *   - CSRF required on POST, idempotency key on /op
 *   - 401/403/413/415 fail fast at exactly one attempt
 *   - transient failures retry with backoff, honouring Retry-After
 *   - the F44 host message reaches the caller COMPLETE (no truncation)
 *   - a v1 index is rejected, not half-rendered (§12.5)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import indexV1 from '@/components/explorer/data/fixtures/index-v1.json';
import defaultHost from '@/components/explorer/data/default-gofile-host.json';
import { migrateV1toV2 } from '@/components/explorer/data/migrations/v1_to_v2';
import { createFxApi, FX_PATHS, type FxOpName, type FxOpRequest, type GofileHostId } from '@/components/explorer/api/endpoints';
import { createFxClient, CSRF_TOKEN_HEADER, DASH_TOKEN_HEADER, IDEMPOTENCY_HEADER } from '@/components/explorer/api/fxClient';
import { FxError } from '@/components/explorer/api/errors';
import { BACKOFF_FLOOR_MS } from '@/components/explorer/api/retryPolicy';

// The parent setup stubs fetch; restore it BEFORE MSW installs its interceptors.
vi.unstubAllGlobals();

const BASE = location.origin;
const TOKEN = 'dash-token-0123456789abcdef';
const CSRF = 'csrf-0123456789abcdef';
const LONG_HOST_MESSAGE = 'Host refusal detail. ' + 'The complete message must stay visible without ellipsis. '.repeat(40);

interface Seen {
  url: string;
  method: string;
  dash: string | null;
  csrf: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

let seen: Seen[] = [];
let sleeps: number[] = [];

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen = [];
  sleeps = [];
});
afterAll(() => server.close());

const record = (request: Request): Seen => {
  const entry: Seen = {
    url: request.url,
    method: request.method,
    dash: request.headers.get(DASH_TOKEN_HEADER),
    csrf: request.headers.get(CSRF_TOKEN_HEADER),
    idempotencyKey: request.headers.get(IDEMPOTENCY_HEADER),
    body: null,
  };
  seen.push(entry);
  return entry;
};

/** Serves a scripted sequence of responses for one path, then repeats the last. */
const script = (path: string, steps: Array<{ status?: number; json?: unknown; text?: string; headers?: Record<string, string>; networkError?: boolean }>) => {
  let call = 0;
  return http.all(`${BASE}${path}`, async ({ request }) => {
    const entry = record(request);
    if (request.method === 'POST') entry.body = await request.clone().json().catch(() => null);
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    if (step.networkError) return HttpResponse.error();
    if (step.text !== undefined) return new HttpResponse(step.text, { status: step.status ?? 200, headers: { 'content-type': 'text/plain', ...step.headers } });
    return HttpResponse.json(step.json ?? {}, { status: step.status ?? 200, headers: step.headers });
  });
};

const calls = (path: string) => seen.filter((entry) => entry.url.startsWith(`${BASE}${path}`));

function makeApi(options: { csrfToken?: string; random?: () => number } = {}) {
  const client = createFxClient({
    dashToken: TOKEN,
    csrfToken: options.csrfToken === undefined ? CSRF : options.csrfToken,
    baseUrl: BASE,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: options.random ?? (() => 0),
      now: () => Date.parse('2026-09-28T00:00:00.000Z'),
    },
  });
  return { client, api: createFxApi(client, () => Date.parse('2026-09-28T00:00:00.000Z')) };
}

const fileEntry = (over: Record<string, unknown> = {}) => ({
  id: 'file-1',
  root: 'Downloads',
  path: '/report.pdf',
  size: 2048,
  mtime: '2026-09-27T10:00:00.000Z',
  mime: 'application/pdf',
  checksum: null,
  tags: ['q3'],
  pinned: false,
  trashed: false,
  trashedAt: null,
  recentsTs: null,
  upload: { phase: null, status: 'idle', retries: 0, lastError: null, bytesSent: 0 },
  gofile: { code: null, fileId: null, directUrl: null, status: 'none', uploadedAt: null, expiryTs: null, downloads: 0, remoteSize: null },
  ...over,
});

const indexV2 = {
  schemaVersion: 2,
  generatedAt: '2026-09-28T00:00:00.000Z',
  runnerId: 'fx-lab',
  roots: [{ root: 'Downloads', scannedAt: '2026-09-28T00:00:00.000Z', totalBytes: 2048, fileCount: 1, quotaBytes: null }],
  files: [fileEntry()],
  gofileHosts: [defaultHost],
};

describe('F45 S3 transport security', () => {
  it('sends the dash token as a header and never in the URL', async () => {
    server.use(script(FX_PATHS.list, [{ json: indexV2 }]));
    const { api } = makeApi();
    await api.listIndex({ root: 'Downloads' });
    expect(calls(FX_PATHS.list)).toHaveLength(1);
    const [request] = calls(FX_PATHS.list);
    expect(request.dash).toBe(TOKEN);
    expect(request.url).not.toContain(TOKEN);
    expect(request.url).not.toMatch(/[?&](key|token)=/i);
    expect(request.url).toBe(`${BASE}/api/fx/list?root=Downloads`);
  });

  it('refuses to build a client without a dash token (no request at all)', () => {
    expect(() => createFxClient({ dashToken: '', baseUrl: BASE })).toThrow(FxError);
    expect(seen).toHaveLength(0);
  });

  it('refuses a POST without a CSRF token (no request at all)', async () => {
    server.use(script(FX_PATHS.op, [{ json: { applied: [], skipped: [] } }]));
    const { api } = makeApi({ csrfToken: '' });
    await expect(api.runOp({ op: 'trash', ids: ['file-1'] })).rejects.toMatchObject({ phase: 'auth', messageKey: 'fx.err.auth' });
    expect(seen).toHaveLength(0);
  });

  it('refuses a cross-origin base (Explorer is same-origin only)', () => {
    expect(() => createFxClient({ dashToken: TOKEN, baseUrl: 'https://evil.example' })).toThrow(/cross-origin base refused/);
    expect(seen).toHaveLength(0);
  });

  it('keeps the default base relative so no origin can leak into a URL', () => {
    const { client } = makeApi();
    expect(client.baseUrl).toBe(BASE);
    const relative = createFxClient({ dashToken: TOKEN, csrfToken: CSRF });
    expect(relative.baseUrl).toBe('');
    expect(relative.href(FX_PATHS.preview, { id: 'a/b c' })).toBe('/api/fx/preview?id=a%2Fb%20c');
  });

  it('sends CSRF on POST and an idempotency key on /op', async () => {
    server.use(script(FX_PATHS.op, [{ json: { applied: ['file-1'], skipped: [] } }]));
    const { api } = makeApi();
    const result = await api.runOp({ op: 'trash', ids: ['file-1'], idempotencyKey: 'op-1' });
    expect(result.applied).toEqual(['file-1']);
    const [request] = calls(FX_PATHS.op);
    expect(request.method).toBe('POST');
    expect(request.csrf).toBe(CSRF);
    expect(request.idempotencyKey).toBe('op-1');
    expect(request.body).toEqual({ op: 'trash', ids: ['file-1'] });
  });

  it('fails closed on an unconfigured URL instead of reaching the network', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(fetch('https://unconfigured.invalid/api/fx/list')).rejects.toThrow();
    } finally {
      output.mockRestore();
    }
  });
});

describe('F45 S3 typed clients', () => {
  it('parses a v2 index and rejects a v1 index (no silent downgrade)', async () => {
    server.use(script(FX_PATHS.list, [{ json: indexV2 }]));
    const { api } = makeApi();
    const index = await api.listIndex();
    expect(index.schemaVersion).toBe(2);
    expect(index.files).toHaveLength(1);
    expect(index.gofileHosts[0]?.id).toBe('gofile');

    server.use(script(FX_PATHS.list, [{ json: indexV1 }]));
    await expect(api.listIndex()).rejects.toMatchObject({ phase: 'parse', messageKey: 'fx.err.parse' });
    await expect(api.listIndex()).rejects.toThrow(/schemaVersion 1 is not 2/);
  });

  it('accepts the S2 migration output for the same archived v1 fixture', async () => {
    server.use(script(FX_PATHS.list, [{ json: migrateV1toV2(indexV1) }]));
    const { api } = makeApi();
    const index = await api.listIndex();
    expect(index.files.map((file) => file.id)).toHaveLength(2);
    expect(index.gofileHosts[0]?.displayName).toBe('gofile.io');
  });

  it('returns typed meta and gofile state', async () => {
    server.use(
      script(FX_PATHS.meta, [{ json: fileEntry() }]),
      script(FX_PATHS.gofileStatus, [
        {
          json: {
            code: 'code-1',
            fileId: 'file-1',
            directUrl: null,
            status: 'processing',
            uploadedAt: null,
            expiryTs: null,
            downloads: 0,
            remoteSize: 2048,
          },
        },
      ]),
    );
    const { api } = makeApi();
    expect((await api.getMeta('file-1')).path).toBe('/report.pdf');
    const status = await api.getGofileStatus('file-1');
    expect(status.status).toBe('processing');
    expect(calls(FX_PATHS.meta)[0]?.url).toBe(`${BASE}/api/fx/meta?id=file-1`);
  });

  it('rejects a direct link on a status that cannot have one', async () => {
    server.use(
      script(FX_PATHS.gofileStatus, [
        { json: { code: null, fileId: null, directUrl: 'https://gofile.test/content/x', status: 'processing', uploadedAt: null, expiryTs: null, downloads: 0, remoteSize: null } },
      ]),
    );
    const { api } = makeApi();
    await expect(api.getGofileStatus('file-1')).rejects.toThrow(/directUrl must be null while status is processing/);
  });

  it('rejects an id-less meta request before sending it', async () => {
    const { api } = makeApi();
    await expect(api.getMeta('')).rejects.toMatchObject({ phase: 'parse' });
    expect(seen).toHaveLength(0);
  });

  it('builds credential-free stream URLs for preview and upload events', () => {
    const { api } = makeApi();
    expect(api.previewUrl('file-1')).toBe(`${BASE}/api/fx/preview?id=file-1`);
    expect(api.uploadEventsUrl()).toBe(`${BASE}/api/fx/upload/events`);
  });

  it('refuses a hard delete and unknown ops/hosts client-side', async () => {
    const { api } = makeApi();
    await expect(api.runOp({ op: 'trash', ids: ['file-1'], hard: true } as unknown as FxOpRequest)).rejects.toThrow(/hard delete is not an Explorer operation/);
    await expect(api.runOp({ op: 'rename' as unknown as FxOpName, ids: ['file-1'] })).rejects.toThrow(/unknown op/);
    await expect(api.runOp({ op: 'trash', ids: [] })).rejects.toThrow(/at least one id/);
    await expect(api.startUpload({ ids: ['file-1'], host: 'mega' as unknown as GofileHostId })).rejects.toThrow(/unknown upload host/);
    expect(seen).toHaveLength(0);
  });

  it('accepts a 202 upload with typed jobs', async () => {
    server.use(script(FX_PATHS.upload, [{ status: 202, json: { jobs: [{ id: 'file-1', uploadJobId: 'job-1' }] } }]));
    const { api } = makeApi();
    const accepted = await api.startUpload({ ids: ['file-1'], host: 'gofile' });
    expect(accepted.jobs).toEqual([{ id: 'file-1', uploadJobId: 'job-1' }]);
    expect(calls(FX_PATHS.upload)[0]?.body).toEqual({ ids: ['file-1'], host: 'gofile' });
  });
});

describe('F45 S3 retry gating over the wire', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [413, 'size'],
    [415, 'type'],
  ] as const)('HTTP %s fails fast at ONE attempt (phase %s)', async (status, phase) => {
    server.use(script(FX_PATHS.list, [{ status, text: LONG_HOST_MESSAGE }]));
    const { api } = makeApi();
    const error = await api.listIndex({ retry: true }).catch((cause: unknown) => cause as FxError);
    expect(error).toBeInstanceOf(FxError);
    expect(error).toMatchObject({ phase, httpStatus: status, retryable: false });
    expect(calls(FX_PATHS.list)).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('keeps the F44 host message complete — no truncation anywhere', async () => {
    server.use(script(FX_PATHS.list, [{ status: 403, text: LONG_HOST_MESSAGE }]));
    const { api } = makeApi();
    const error = (await api.listIndex().catch((cause: unknown) => cause)) as FxError;
    expect(LONG_HOST_MESSAGE.length).toBeGreaterThan(1500);
    expect(error.hostMessage).toBe(LONG_HOST_MESSAGE);
    expect(error.message).toBe(LONG_HOST_MESSAGE);
    expect(error.hostMessage).not.toContain('…');
  });

  it.each([502, 504])('HTTP %s is transient: recovers on the next attempt', async (status) => {
    server.use(script(FX_PATHS.list, [{ status, text: 'gateway sad' }, { json: indexV2 }]));
    const { api } = makeApi();
    const index = await api.listIndex({ retry: true });
    expect(index.schemaVersion).toBe(2);
    expect(calls(FX_PATHS.list)).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
  });

  it('exhausts the transient budget at five attempts with growing backoff', async () => {
    server.use(script(FX_PATHS.list, [{ status: 502, text: 'gateway sad' }]));
    // random() === 1 pins jitter to the top of each band, so growth is visible.
    const { api } = makeApi({ random: () => 1 });
    const error = (await api.listIndex({ retry: true }).catch((cause: unknown) => cause)) as FxError;
    expect(error.httpStatus).toBe(502);
    expect(calls(FX_PATHS.list)).toHaveLength(5);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('collapses to the jitter floor when the RNG returns 0 (full jitter)', async () => {
    server.use(script(FX_PATHS.list, [{ status: 502, text: 'gateway sad' }]));
    const { api } = makeApi({ random: () => 0 });
    await expect(api.listIndex({ retry: true })).rejects.toMatchObject({ httpStatus: 502 });
    expect(calls(FX_PATHS.list)).toHaveLength(5);
    expect(sleeps).toEqual([BACKOFF_FLOOR_MS, BACKOFF_FLOOR_MS, BACKOFF_FLOOR_MS, BACKOFF_FLOOR_MS]);
  });

  it('honours Retry-After as a floor on 429', async () => {
    server.use(script(FX_PATHS.list, [{ status: 429, text: 'slow down', headers: { 'Retry-After': '3' } }, { json: indexV2 }]));
    const { api } = makeApi();
    await api.listIndex({ retry: true });
    expect(calls(FX_PATHS.list)).toHaveLength(2);
    expect(sleeps[0]).toBe(3000);
  });

  it('classifies a transport failure as transient and retries it', async () => {
    server.use(script(FX_PATHS.list, [{ networkError: true }, { json: indexV2 }]));
    const { api } = makeApi();
    const index = await api.listIndex({ retry: true });
    expect(index.files).toHaveLength(1);
    expect(calls(FX_PATHS.list)).toHaveLength(2);
  });

  it('throws the transport error unwrapped when retry is off', async () => {
    server.use(script(FX_PATHS.list, [{ networkError: true }]));
    const { api } = makeApi();
    const error = (await api.listIndex().catch((cause: unknown) => cause)) as FxError;
    expect(error).toMatchObject({ phase: 'dns', httpStatus: null, retryable: true, messageKey: 'fx.err.hostTimeout' });
    expect(calls(FX_PATHS.list)).toHaveLength(1);
  });

  it('does not retry when the caller asked for a single attempt', async () => {
    server.use(script(FX_PATHS.list, [{ status: 502, text: 'gateway sad' }]));
    const { api } = makeApi();
    await expect(api.listIndex()).rejects.toMatchObject({ phase: 'http', retryable: true });
    expect(calls(FX_PATHS.list)).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });
});

describe('F45 S3 redaction', () => {
  it('redacts the dash token if a host echoes it back', async () => {
    server.use(script(FX_PATHS.list, [{ status: 500, text: `rejected because dash-token=${TOKEN} is stale` }]));
    const { api } = makeApi();
    const error = (await api.listIndex().catch((cause: unknown) => cause)) as FxError;
    expect(error.hostMessage).not.toContain(TOKEN);
    expect(error.hostMessage).toContain('***REDACTED***');
    expect(JSON.stringify(error.toJSON())).not.toContain(TOKEN);
    expect(String(error)).not.toContain(TOKEN);
  });
});
