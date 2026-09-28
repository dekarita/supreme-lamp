/**
 * F45 S4 — the SERVER must agree with the FROZEN S3 client.
 *
 * S4 ships the other half of §5: `payloads/ghrdp-server.ps1` now answers the
 * endpoints the S3 transport calls. This suite is the contract between the two
 * halves, asserted from the TS side with the client's own exported constants
 * (paths, ops, schema version, fail-fast set, phase/status vocabularies, retry
 * budget, MIME map) rather than with a second copy of them.
 *
 * It is deliberately a SOURCE contract: the executed proof (real request cycles
 * through the shipped handler) is tests/f45-s4-fx-server.ps1 on the Windows
 * lane, and the cheap source tripwire is tests/f45-s4-fx-routes.test.js. Here we
 * check the pairing the other two cannot: a client constant that the server
 * does not honour would leave the Explorer with an endpoint nobody answers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import mimeMap from '@/components/explorer/data/fixtures/preview-mime-map.json';
import { INDEX_SCHEMA_VERSION } from '@/components/explorer/data/schema';
import { FAIL_FAST_HTTP } from '@/components/explorer/api/errors';
import { CSRF_TOKEN_HEADER, DASH_TOKEN_HEADER, IDEMPOTENCY_HEADER, createFxClient } from '@/components/explorer/api/fxClient';
import { FX_OPS, FX_PATHS, createFxApi } from '@/components/explorer/api/endpoints';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, MAX_TRANSIENT_ATTEMPTS, RETRY_AFTER_CAP_MS, TRANSIENT_PHASES } from '@/components/explorer/api/retryPolicy';

const server = readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const BEGIN = '# [F45 S4 fx-core-begin]';
const END = '# [F45 S4 fx-core-end]';
const core = server.slice(server.indexOf(BEGIN), server.indexOf(END));

/** Parses `$script:Name = @( 'a', 'b' )` (single or multi line) out of the core. */
function psArray(name: string): string[] {
  const at = core.indexOf(`$script:${name} = @(`);
  expect(at, `the server no longer declares $script:${name}`).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = core.indexOf('(', at); i < core.length; i += 1) {
    const c = core[i];
    if (c === "'") {
      i = core.indexOf("'", i + 1);
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = core.slice(at, end);
  const quoted = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (quoted.length > 0) return quoted;
  return [...body.matchAll(/(?<![\w$])(\d+)(?![\w])/g)].map((m) => m[1]);
}

function psScalar(name: string): string {
  const m = core.match(new RegExp(`\\$script:${name} = (\\d+|'[^']*')`));
  expect(m, `the server no longer declares $script:${name}`).not.toBeNull();
  return m![1].replace(/'/g, '');
}

const implementedPaths = Object.values(FX_PATHS).filter((path) => path !== FX_PATHS.uploadEvents);

describe('F45 S4 server ↔ client contract', () => {
  it('routes exactly the endpoints the client calls, and nothing else', () => {
    const routed = [...core.matchAll(/path = '(\/api\/fx[^']*)'/g)].map((m) => m[1]);
    for (const path of implementedPaths) {
      expect(routed, `the server does not route ${path}`).toContain(path);
    }
    // /upload/events is the S8 SSE endpoint: the URL builder exists, the route
    // must NOT exist yet (adding one without an SSE handler would be a lie).
    expect(routed).not.toContain(FX_PATHS.uploadEvents);
    expect(routed).toHaveLength(implementedPaths.length);
  });

  it('serves every op the client can send', () => {
    expect(psArray('FxOps')).toEqual([...FX_OPS]);
  });

  it('emits the frozen schema version on every index answer', () => {
    expect(Number(psScalar('FxSchemaVersion'))).toBe(INDEX_SCHEMA_VERSION);
    expect(core).toContain("'schemaVersion' -Value $script:FxSchemaVersion");
  });

  it('agrees on the fail-fast statuses and the retry budget', () => {
    expect(psArray('FxFailFastStatus').map(Number)).toEqual([...FAIL_FAST_HTTP]);
    expect(psArray('FxTransientPhases')).toEqual([...TRANSIENT_PHASES]);
    expect(Number(psScalar('FxMaxAttempts'))).toBe(MAX_TRANSIENT_ATTEMPTS);
    expect(Number(psScalar('FxBackoffBaseMs'))).toBe(BACKOFF_BASE_MS);
    expect(Number(psScalar('FxBackoffCapMs'))).toBe(BACKOFF_CAP_MS);
    expect(core).toContain(`if ($clamped -gt ${RETRY_AFTER_CAP_MS})`);
  });

  it('speaks the client header names', () => {
    expect(core.toLowerCase()).toContain(DASH_TOKEN_HEADER.toLowerCase());
    expect(core.toLowerCase()).toContain(CSRF_TOKEN_HEADER.toLowerCase());
    expect(server.toLowerCase()).toContain(IDEMPOTENCY_HEADER.toLowerCase());
    expect(core).toContain('Get-FxIdempotentHit');
    expect(core).toContain('Save-FxIdempotentResult');
    expect(core).toContain('X-Idempotent-Replay: 1');
    // the dash token is read from the header, never required in a URL
    expect(core).toContain("$Headers['x-dash-token']");
  });

  it('shares the renderable MIME vocabulary with the S2 map', () => {
    expect([...psArray('FxPreviewMimeAllow')].sort()).toEqual(mimeMap.map((entry) => entry.mime).sort());
  });

  it('lets the S3 client build URLs the shipped router accepts', () => {
    const client = createFxClient({ dashToken: 'dash-token-0123456789abcdef', csrfToken: 'x'.repeat(32) });
    const fx = createFxApi(client);
    // previewUrl must be a real route, with no credential in the query
    const preview = new URL(fx.previewUrl('some-file-id'), 'http://localhost');
    expect(preview.pathname).toBe(FX_PATHS.preview);
    expect([...preview.searchParams.keys()]).toEqual(['id']);
    expect(preview.searchParams.get('id')).toBe('some-file-id');
    expect(preview.search).not.toMatch(/key=|token=/i);
    // and the router must name it
    expect(core).toContain(`'${preview.pathname}'`);
    // the SSE builder exists but is documented as S8, not routed yet
    const events = new URL(fx.uploadEventsUrl(), 'http://localhost');
    expect(events.pathname).toBe(FX_PATHS.uploadEvents);
    expect(core).not.toContain(`'${FX_PATHS.uploadEvents}'`);
  });

  it('keeps the directUrl invariant the client validates', () => {
    // GofileState.directUrl is null unless status === 'uploaded' (§4). The
    // server must not be able to violate it, in the router or in migration.
    expect(core).toContain("if ($status -eq 'uploaded') { $directUrl = Get-FxSafeDirectUrl");
    expect(core).toContain("ConvertTo-FxGofileState");
  });

  it('answers with the F44 phase envelope the client maps to an error key', () => {
    // Every non-2xx the Explorer can produce must carry a phase, otherwise the
    // FxError the UI renders would be keyed off a status with no phase row.
    const envelope = core.slice(core.indexOf('function New-FxErrorResponse'), core.indexOf('function Invoke-FxRoute'));
    for (const field of ['ok', 'phase', 'error']) {
      expect(envelope).toContain(field);
    }
    for (const code of [400, 401, 403, 404, 405, 413, 415, 416, 500, 502, 504]) {
      // error envelopes use `Code NNN`; the preview path sets `code = NNN`
      expect(core, `no route answers ${code}`).toMatch(new RegExp(`(Code|code =) ${code}\\b`));
    }
  });
});
