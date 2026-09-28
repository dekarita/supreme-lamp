// S2 host contract only: S7 will add upload client/row assertions, no fake UI proof.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGofileMockServer } from '@/components/explorer/data/fixtures/gofile-mock-server/server';
import { gofileHandlers, MOCK_GOFILE_ORIGIN, MOCK_HOST_MESSAGE } from '@/components/explorer/data/fixtures/gofile-mock-server/handlers';

// Parent setup stubs fetch. Restore it BEFORE MSW installs its interceptors.
vi.unstubAllGlobals();
const server = createGofileMockServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const upload = () => fetch(`${MOCK_GOFILE_ORIGIN}/uploadFile`, { method: 'POST' });

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
