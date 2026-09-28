/** MSW host contract fixtures. Not imported by app code; no live host calls.
 * S7 will compose these with the mock Explorer upload worker, not bypass the
 * real retry policy with canned UI rows.
 *
 * [F46 §3] the handlers pin the DOCUMENTED gofile flow (docs/MIRROR-HOSTS.md
 * §3, fetched 2026-09-28): POST /accounts -> data.token; GET /servers ->
 * data.servers[].name; upload is multipart with the token in the
 * `Authorization: Bearer` header and the current response carrying
 * `id` + `downloadPage` (`fileId` + `directLink` remain as the legacy alias the
 * parser must still accept). Every response keeps the `status` envelope.
 */
import { http, HttpResponse } from 'msw';
export const MOCK_GOFILE_ORIGIN = 'https://gofile.test';
export const MOCK_GOFILE_TOKEN = 'mock-guest-token';
export const MOCK_GOFILE_SERVER = 'store-mock';
export const MOCK_GOFILE_UPLOAD_ORIGIN = 'https://upload.gofile.test';
export const MOCK_GOFILE_UPLOAD_PATH = '/uploadfile';
export const MOCK_GOFILE_FLEET_UPLOAD_PATH = '/contents/uploadfile';
export const MOCK_GOFILE_LEGACY_UPLOAD_PATH = '/uploadFile';
export const MOCK_GOFILE_FILE_ID = 'mock-file';
export const MOCK_GOFILE_CODE = 'mock-code';
export const MOCK_GOFILE_DOWNLOAD_PAGE = `${MOCK_GOFILE_ORIGIN}/d/${MOCK_GOFILE_CODE}`;
/** [F46 §6] the policy matrix the mirror worker must obey, in one fixture:
 * success + fail-fast (403/413/415) + transient (429/500/502) + a transport
 * failure (tls-reset, surfaced as an MSW network error - never an HTTP code).
 */
export type MockGofileScenario =
  | 'success'
  | 'processing'
  | 'expired'
  | '403'
  | '413'
  | '415'
  | '429'
  | '500'
  | '502'
  | 'tls-reset';
export const MOCK_HOST_MESSAGE = 'Mock host refusal. ' + 'Full diagnostic detail must remain visible without ellipsis. '.repeat(30);

export function gofileHandlers(scenarios: MockGofileScenario[] = ['success']) {
  let attempt = 0;
  const next = () => scenarios[Math.min(attempt++, scenarios.length - 1)] ?? 'success';
  const current = () => {
    const scenario = next();
    if (scenario === 'tls-reset') return HttpResponse.error();
    if (/^\d+$/.test(scenario)) return refusal(scenario as MockGofileScenario);
    return HttpResponse.json({ status: 'ok', data: {
      id: MOCK_GOFILE_FILE_ID, parentFolder: 'mock-folder', code: MOCK_GOFILE_CODE,
      downloadPage: MOCK_GOFILE_DOWNLOAD_PAGE, name: 'mock.bin', size: 12,
      md5: 'd41d8cd98f00b204e9800998ecf8427e', mimetype: 'application/octet-stream',
      servers: [MOCK_GOFILE_SERVER],
    } });
  };
  const refusal = (scenario: MockGofileScenario) =>
    HttpResponse.json(
      { status: 'error', code: Number(scenario), message: MOCK_HOST_MESSAGE },
      { status: Number(scenario), headers: scenario === '429' || scenario === '502' ? { 'Retry-After': '1' } : {} },
    );
  return [
    http.post(`${MOCK_GOFILE_ORIGIN}/accounts`, () =>
      HttpResponse.json({ status: 'ok', data: { id: 'mock-account', rootFolder: 'mock-root', tier: 'guest', token: MOCK_GOFILE_TOKEN } }),
    ),
    http.get(`${MOCK_GOFILE_ORIGIN}/servers`, () =>
      HttpResponse.json({ status: 'ok', data: { servers: [{ name: MOCK_GOFILE_SERVER }] } }),
    ),
    // documented reference: POST https://upload.gofile.io/uploadfile
    http.post(`${MOCK_GOFILE_UPLOAD_ORIGIN}${MOCK_GOFILE_UPLOAD_PATH}`, () => current()),
    // documented fleet form: POST https://<server>.gofile.io/contents/uploadfile
    http.post(`${MOCK_GOFILE_ORIGIN}${MOCK_GOFILE_FLEET_UPLOAD_PATH}`, () => current()),
    http.post(`${MOCK_GOFILE_ORIGIN}${MOCK_GOFILE_LEGACY_UPLOAD_PATH}`, () => {
      const scenario = next();
      if (scenario === 'tls-reset') return HttpResponse.error();
      if (/^\d+$/.test(scenario)) return refusal(scenario as MockGofileScenario);
      return HttpResponse.json({ status: 'ok', data: {
        fileId: MOCK_GOFILE_FILE_ID, parentFolder: 'mock-folder', code: MOCK_GOFILE_CODE, status: scenario === 'success' ? 'uploaded' : scenario,
        directLink: scenario === 'success' ? `${MOCK_GOFILE_ORIGIN}/content/${MOCK_GOFILE_FILE_ID}` : null,
      } });
    }),
    http.get(`${MOCK_GOFILE_ORIGIN}/contents/:id`, () => {
      const scenario = next();
      if (scenario === 'tls-reset') return HttpResponse.error();
      if (/^\d+$/.test(scenario)) return refusal(scenario as MockGofileScenario);
      return HttpResponse.json({ status: 'ok', data: { status: scenario === 'success' ? 'uploaded' : scenario, fileId: MOCK_GOFILE_FILE_ID, downloads: 0 } });
    }),
  ];
}
