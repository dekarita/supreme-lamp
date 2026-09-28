// S2 host contract only: S7 will add upload client/row assertions, no fake UI proof.
// [F48 §3] TOKEN-LESS MIRROR LAB: the upload request is inspected for auth
// headers (none may exist), the guest happy path parses id + downloadPage,
// 401/403 fail fast as exactly ONE attempt with a labeled chip + rendered
// operator options, and 429/500/502 stay policy-retryable. No real calls.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@/i18n';
import { createGofileMockServer } from '@/components/explorer/data/fixtures/gofile-mock-server/server';
import {
  gofileHandlers,
  MOCK_GOFILE_CODE,
  MOCK_GOFILE_DOWNLOAD_PAGE,
  MOCK_GOFILE_LEGACY_UPLOAD_PATH,
  MOCK_GOFILE_ORIGIN,
  MOCK_GOFILE_FLEET_UPLOAD_PATH,
  MOCK_GOFILE_SERVER,
  MOCK_GOFILE_UPLOAD_ORIGIN,
  MOCK_GOFILE_UPLOAD_PATH,
  MOCK_HOST_MESSAGE,
} from '@/components/explorer/data/fixtures/gofile-mock-server/handlers';
import { canRetryFrom, maxAttempts } from '@/components/explorer/api/retryPolicy';
import { MirrorHostMatrix } from '@/components/domain/MirrorHostMatrix';
import { MirrorCard } from '@/components/domain/MirrorCard';
import { useTelemetryStore } from '@/stores/telemetryStore';

// Parent setup stubs fetch. Restore it BEFORE MSW installs its interceptors.
vi.unstubAllGlobals();
const server = createGofileMockServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const upload = () => fetch(`${MOCK_GOFILE_ORIGIN}${MOCK_GOFILE_LEGACY_UPLOAD_PATH}`, { method: 'POST' });

// [F48 §3] request inspection: every request the mock host receives is kept so
// tests can prove NO auth header (Authorization / X-Gofile-Token / Cookie)
// was ever attached to a host-bound upload.
const seenRequests: Request[] = [];
server.events.on('request:start', ({ request }) => {
  seenRequests.push(request);
});
function lastHostRequest(): Request {
  const req = seenRequests[seenRequests.length - 1];
  expect(req, 'the mock host must have received a request').toBeTruthy();
  return req as Request;
}
function expectNoAuthHeaders(req: Request) {
  expect(req.headers.get('authorization')).toBeNull();
  expect(req.headers.get('x-gofile-token')).toBeNull();
  expect(req.headers.get('cookie')).toBeNull();
}

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

// [F48 §3] the token-less guest flow, pinned: /servers -> name, anonymous
// multipart upload (request inspection proves NO auth header), id +
// downloadPage in the response, fail-fast auth, transient-only retries.
describe('F48 token-less guest flow (mock host only)', () => {
  it('lists upload servers via GET /servers (the probe endpoint)', async () => {
    server.use(...gofileHandlers());
    const response = await fetch(`${MOCK_GOFILE_ORIGIN}/servers`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.data.servers[0].name).toBe(MOCK_GOFILE_SERVER);
    expectNoAuthHeaders(lastHostRequest());
  });

  it('guest happy path: anonymous multipart upload parses id + downloadPage (NO auth headers)', async () => {
    server.use(...gofileHandlers(['success']));
    seenRequests.length = 0;
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'hello.txt');
    const response = await fetch(`${MOCK_GOFILE_UPLOAD_ORIGIN}${MOCK_GOFILE_UPLOAD_PATH}`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.data.id).toBe('mock-file');
    expect(body.data.code).toBe(MOCK_GOFILE_CODE);
    expect(body.data.downloadPage).toBe(MOCK_GOFILE_DOWNLOAD_PAGE);
    expectNoAuthHeaders(lastHostRequest());
  });

  it('serves the documented fleet form on the store host too (no auth headers)', async () => {
    server.use(...gofileHandlers(['success']));
    const response = await fetch(`${MOCK_GOFILE_ORIGIN}${MOCK_GOFILE_FLEET_UPLOAD_PATH}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect((await response.json()).data.downloadPage).toBe(MOCK_GOFILE_DOWNLOAD_PAGE);
    expectNoAuthHeaders(lastHostRequest());
  });

  it.each(['401', '403'] as const)(
    'HTTP %s => exactly 1 attempt (fail-fast auth) + labeled chip + rendered operator options',
    async (scenario) => {
      server.use(...gofileHandlers([scenario, 'success']));
      seenRequests.length = 0;
      const response = await upload();
      expect(response.status).toBe(Number(scenario));
      expectNoAuthHeaders(lastHostRequest());
      // the policy says: auth is terminal - ONE attempt, never a retry loop.
      expect(canRetryFrom('auth', Number(scenario))).toBe(false);
      expect(maxAttempts('auth', Number(scenario))).toBe(1);
      // the labeled reason + the operator options are what the UI renders.
      const reason = 'host requires account token; token-less mode unsupported (authMode=requires-account). Operator options: (1) disable mirror (mirror_enable=false); (2) self-hosted operator target; (3) token mode - a separate future decision, out of scope here.';
      useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
      useTelemetryStore.getState().setProgress({
        mirror: true,
        encryptMode: 'none',
        agg: { total: 1, done: 0, failed: 1, bytesDone: 0, bytesTotal: 4, speedBps: 0 },
        telemetry: { scans: 1, lastScan: '2026-09-28T13:00:00Z', roots: ['Downloads'] },
        active: { name: '', phase: 'idle', pct: 0, bytesDone: 0, bytesTotal: 0 },
        files: [
          {
            name: 'f48-probe.txt',
            phase: 'failed',
            pct: 0,
            size: 4,
            status: 'failed',
            link: '',
            encrypted: 'False',
            host: 'gofile',
            error: `phase=auth status=${scenario} msg=${reason}`,
            attempts: [],
          },
        ],
        mirrorDiag: {
          attempts: [],
          terminalFiles: [],
          hosts: [{ id: 'gofile', enabled: true, apiRoot: 'https://api.gofile.io' }],
          encryptMode: 'none',
          encAlg: '',
          authMode: 'requires-account',
        },
      } as never);
      render(<MirrorCard />);
      await waitFor(() => expect(screen.getByTestId('mirror-reason-full')).toBeTruthy());
      expect(screen.getByTestId('mirror-reason-full').textContent).toContain(
        'host requires account token; token-less mode unsupported',
      );
      expect(screen.getByTestId('mirror-reason-full').textContent).toContain('Operator options');
      expect(screen.getByTestId('mirror-reason-full').textContent).toContain('disable mirror');
      // the labeled chip (status cell) never claims success
      expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
      // and the host matrix renders the options block for the blocked row
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          mirrorHosts: [
            { host: 'gofile', status: scenario, note: `token-less guest probe refused (authMode=requires-account); runner egress rejected (${scenario})` },
          ],
          mirrorAttempts: [],
        }),
      })) as never;
      try {
        render(<MirrorHostMatrix />);
        await waitFor(() => expect(screen.getByTestId('mirror-host-operator-options')).toBeTruthy());
        expect(screen.getByTestId('mirror-host-status').textContent).toBe(scenario);
        expect(screen.getByTestId('mirror-host-operator-options').textContent).toContain('docs/MIRROR-HOSTS.md');
      } finally {
        globalThis.fetch = originalFetch;
        useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
      }
    },
  );

  it.each(['429', '500', '502'] as const)('HTTP %s stays policy-retryable (transient http phase)', (scenario) => {
    const status = Number(scenario);
    expect(canRetryFrom('http', status)).toBe(true);
    expect(maxAttempts('http', status)).toBe(5);
  });

  it('429 is a transient refusal with Retry-After, not a silent success', async () => {
    server.use(...gofileHandlers(['429']));
    const response = await fetch(`${MOCK_GOFILE_UPLOAD_ORIGIN}${MOCK_GOFILE_UPLOAD_PATH}`, { method: 'POST' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    expect((await response.json()).message).toBe(MOCK_HOST_MESSAGE);
    expectNoAuthHeaders(lastHostRequest());
  });

  it('tls-reset is a transport rejection, never an HTTP code', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.use(...gofileHandlers(['tls-reset']));
      await expect(fetch(`${MOCK_GOFILE_UPLOAD_ORIGIN}${MOCK_GOFILE_UPLOAD_PATH}`, { method: 'POST' })).rejects.toThrow();
    } finally { output.mockRestore(); }
  });
});
