// S2 host contract only: S7 will add upload client/row assertions, no fake UI proof.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGofileMockServer } from '@/components/explorer/data/fixtures/gofile-mock-server/server';
import {
  gofileHandlers,
  MOCK_GOFILE_CODE,
  MOCK_GOFILE_DOWNLOAD_PAGE,
  MOCK_GOFILE_LEGACY_UPLOAD_PATH,
  MOCK_GOFILE_ORIGIN,
  MOCK_GOFILE_FLEET_UPLOAD_PATH,
  MOCK_GOFILE_SERVER,
  MOCK_GOFILE_TOKEN,
  MOCK_GOFILE_UPLOAD_ORIGIN,
  MOCK_GOFILE_UPLOAD_PATH,
  MOCK_HOST_MESSAGE,
} from '@/components/explorer/data/fixtures/gofile-mock-server/handlers';

// Parent setup stubs fetch. Restore it BEFORE MSW installs its interceptors.
vi.unstubAllGlobals();
const server = createGofileMockServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const upload = () => fetch(`${MOCK_GOFILE_ORIGIN}${MOCK_GOFILE_LEGACY_UPLOAD_PATH}`, { method: 'POST' });

describe('F45 S2 MSW gofile contract (no real calls)', () => {
  it.each(['success', 'processing', 'expired'] as const)('models %s for upload/status', async (scenario) => {
    server.use(...gofileHandlers([scenario]));
    const response = await upload();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.status).toBe(scenario === 'success' ? 'uploaded' : scenario);
    expect(body.data.directLink).toBe(scenario === 'success' ? `${MOCK_GOFILE_ORIGIN}/content/mock-file` : null);
    const status = await fetch(`${MOCK_GOFILE_ORIGIN}/contents/mock-file`);
    expect((await status.json()).data.status).toBe(body.data.status);
  });
  it.each(['403', '413', '415', '502'] as const)('returns exact HTTP %s and full diagnostic body', async (scenario) => {
    server.use(...gofileHandlers([scenario]));
    const response = await upload();
    expect(response.status).toBe(Number(scenario));
    expect((await response.json()).message).toBe(MOCK_HOST_MESSAGE);
    expect(MOCK_HOST_MESSAGE.length).toBeGreaterThan(1500);
  });
  it('provides a deterministic 502 → success sequence, not client retry logic', async () => {
    server.use(...gofileHandlers(['502', 'success']));
    expect((await upload()).status).toBe(502);
    expect((await upload()).status).toBe(200);
    expect((await upload()).status).toBe(200);
  });
  it('fails closed on unhandled URLs without a real network fallback', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(fetch('https://unconfigured.invalid/fx')).rejects.toThrow();
      expect(output).toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });
});

// [F46 3] the documented flow, pinned: /accounts -> token, /servers -> name,
// multipart upload with the Bearer header, id + downloadPage in the response.
describe('F46 3 documented gofile flow (mock host only)', () => {
  it('mints a guest token via POST /accounts', async () => {
    server.use(...gofileHandlers());
    const response = await fetch(`${MOCK_GOFILE_ORIGIN}/accounts`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.data.token).toBe(MOCK_GOFILE_TOKEN);
    expect(body.data.tier).toBe('guest');
  });

  it('lists upload servers via GET /servers', async () => {
    server.use(...gofileHandlers());
    const response = await fetch(`${MOCK_GOFILE_ORIGIN}/servers`);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.data.servers[0].name).toBe(MOCK_GOFILE_SERVER);
  });

  it('accepts a multipart file with Authorization: Bearer and returns id + downloadPage', async () => {
    server.use(...gofileHandlers(['success']));
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'hello.txt');
    const response = await fetch(`${MOCK_GOFILE_UPLOAD_ORIGIN}${MOCK_GOFILE_UPLOAD_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOCK_GOFILE_TOKEN}` },
      body: form,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.data.id).toBe('mock-file');
    expect(body.data.code).toBe(MOCK_GOFILE_CODE);
    expect(body.data.downloadPage).toBe(MOCK_GOFILE_DOWNLOAD_PAGE);
  });

  it('serves the documented fleet form on the store host too', async () => {
    server.use(...gofileHandlers(['success']));
    const response = await fetch(`${MOCK_GOFILE_ORIGIN}${MOCK_GOFILE_FLEET_UPLOAD_PATH}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect((await response.json()).data.downloadPage).toBe(MOCK_GOFILE_DOWNLOAD_PAGE);
  });

  it('429 is a transient refusal with Retry-After, not a silent success', async () => {
    server.use(...gofileHandlers(['429']));
    const response = await fetch(`${MOCK_GOFILE_UPLOAD_ORIGIN}${MOCK_GOFILE_UPLOAD_PATH}`, { method: 'POST' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    expect((await response.json()).message).toBe(MOCK_HOST_MESSAGE);
  });

  it('tls-reset is a transport rejection, never an HTTP code', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.use(...gofileHandlers(['tls-reset']));
      await expect(fetch(`${MOCK_GOFILE_UPLOAD_ORIGIN}${MOCK_GOFILE_UPLOAD_PATH}`, { method: 'POST' })).rejects.toThrow();
    } finally { output.mockRestore(); }
  });
});
