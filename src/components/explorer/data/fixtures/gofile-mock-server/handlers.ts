/** MSW host contract fixtures. Not imported by app code; no live host calls.
 * S7 will compose these with the mock Explorer upload worker, not bypass the
 * real retry policy with canned UI rows.
 */
import { http, HttpResponse } from 'msw';
export const MOCK_GOFILE_ORIGIN = 'https://gofile.test';
export type MockGofileScenario = 'success' | 'processing' | 'expired' | '403' | '413' | '415' | '502';
export const MOCK_HOST_MESSAGE = 'Mock host refusal. ' + 'Full diagnostic detail must remain visible without ellipsis. '.repeat(30);

export function gofileHandlers(scenarios: MockGofileScenario[] = ['success']) {
  let attempt = 0;
  const next = () => scenarios[Math.min(attempt++, scenarios.length - 1)] ?? 'success';
  return [
    http.post(`${MOCK_GOFILE_ORIGIN}/uploadFile`, () => {
      const scenario = next();
      if (/^\d+$/.test(scenario)) {
        return HttpResponse.json({ status: 'error', message: MOCK_HOST_MESSAGE }, { status: Number(scenario), headers: scenario === '502' ? { 'Retry-After': '1' } : {} });
      }
      return HttpResponse.json({ status: 'ok', data: {
        fileId: 'mock-file', parentFolder: 'mock-folder', code: 'mock-code', status: scenario === 'success' ? 'uploaded' : scenario,
        directLink: scenario === 'success' ? `${MOCK_GOFILE_ORIGIN}/content/mock-file` : null,
      } });
    }),
    http.get(`${MOCK_GOFILE_ORIGIN}/contents/:id`, () => {
      const scenario = next();
      if (/^\d+$/.test(scenario)) return HttpResponse.json({ status: 'error', message: MOCK_HOST_MESSAGE }, { status: Number(scenario) });
      return HttpResponse.json({ status: 'ok', data: { status: scenario === 'success' ? 'uploaded' : scenario, fileId: 'mock-file', downloads: 0 } });
    }),
  ];
}
