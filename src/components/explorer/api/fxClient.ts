/**
 * F45 S3 — Explorer §5 endpoint transport.
 *
 * Security contract (Explorer §5.1 + D4, and the F45 ledger line "Existing
 * lib/api.ts authenticates with a query-string key; parent security is not
 * Explorer's contract — do not copy URL auth into Explorer"):
 *   - The dash token travels in the `X-Dash-Token` header ONLY. A request whose
 *     URL contains the token, or any `key=`/`token=`-style parameter, is refused
 *     before it is sent.
 *   - The two POST endpoints require `X-CSRF-Token` (§5.1 rule 4). Missing CSRF
 *     token => fail closed, no request.
 *   - Same-origin only (§5.1 rule 8, D4): a cross-origin base is refused.
 *   - Nothing here logs, throws or serialises the token.
 *
 * This module is a client only. S4 adds the server routes; S5+ adds UI. Nothing
 * in the production bundle imports it yet.
 */
import { classifyStatus, FxError, parseRetryAfter, redactSecrets } from './errors';
import { backoffDelayMs, canRetryFrom, maxAttempts } from './retryPolicy';

export const FX_API_PREFIX = '/api/fx';
export const DASH_TOKEN_HEADER = 'X-Dash-Token';
export const CSRF_TOKEN_HEADER = 'X-CSRF-Token';
export const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';

export interface FxClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic backoff tests. */
  random?: () => number;
  now?: () => number;
}

export interface FxClientConfig {
  /** Operator dash token. Header-only; never appended to a URL. */
  dashToken: string;
  csrfToken?: string | (() => string | undefined);
  /** Must be same-origin, or '' for a relative URL. CORS is disabled (§5.1/8). */
  baseUrl?: string;
  deps?: FxClientDeps;
}

export interface FxRequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** §5.1 rule 6: at-least-once safety for /op. */
  idempotencyKey?: string;
  /** Transient-phase-only retry per retryPolicy. Default: single attempt. */
  retry?: boolean;
  signal?: AbortSignal;
}

export interface FxClient {
  request<T>(path: string, options?: FxRequestOptions): Promise<T>;
  /** Absolute URL for a GET path — used for stream/SSE endpoints, no fetch. */
  href(path: string, query?: Record<string, string | number | undefined>): string;
  readonly baseUrl: string;
}

const CREDENTIAL_PARAM = /(?:^|[?&])(?:key|token|dash[-_]?token|access[-_]?token|password)=/i;

export function createFxClient(config: FxClientConfig): FxClient {
  const deps = config.deps ?? {};
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const token = config.dashToken;
  const baseUrl = normaliseBase(config.baseUrl ?? '');

  if (!token) {
    throw new FxError({
      phase: 'auth',
      httpStatus: null,
      hostMessage: 'no dash token: refusing to call /api/fx unauthenticated',
      messageKey: 'fx.err.auth',
      retryable: false,
      retryAfterMs: null,
      at: new Date(now()).toISOString(),
    });
  }

  function csrfToken(): string | undefined {
    const value = typeof config.csrfToken === 'function' ? config.csrfToken() : config.csrfToken;
    return value && value.length > 0 ? value : undefined;
  }

  function href(path: string, query?: Record<string, string | number | undefined>): string {
    if (!path.startsWith(FX_API_PREFIX + '/')) {
      throw new Error(`fx: refusing non-Explorer path ${path}`);
    }
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    const url = baseUrl + path + (parts.length > 0 ? `?${parts.join('&')}` : '');
    // Fail closed: a credential may never reach a URL, log or referrer.
    if (CREDENTIAL_PARAM.test(url) || url.includes(token)) {
      throw new FxError({
        phase: 'auth',
        httpStatus: null,
        hostMessage: 'refused: a credential appeared in the request URL',
        messageKey: 'fx.err.auth',
        retryable: false,
        retryAfterMs: null,
        at: new Date(now()).toISOString(),
      });
    }
    return url;
  }

  async function once<T>(path: string, options: FxRequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    if (method === 'POST' && !csrfToken()) {
      throw new FxError({
        phase: 'auth',
        httpStatus: null,
        hostMessage: 'no CSRF token: refusing POST ' + path,
        messageKey: 'fx.err.auth',
        retryable: false,
        retryAfterMs: null,
        at: new Date(now()).toISOString(),
      });
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [DASH_TOKEN_HEADER]: token,
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers[CSRF_TOKEN_HEADER] = csrfToken() ?? '';
      if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await doFetch(href(path, options.query), {
        method,
        headers,
        cache: 'no-store',
        signal: options.signal,
        body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
      });
    } catch (cause) {
      if (isAbort(cause, options.signal)) throw cause;
      // No status line at all: transport failure, transient per §5.2's 504 row.
      throw new FxError({
        phase: 'dns',
        httpStatus: null,
        hostMessage: redactSecrets(`transport failed before any HTTP response: ${describeCause(cause)}`, [token]),
        messageKey: 'fx.err.hostTimeout',
        retryable: true,
        retryAfterMs: null,
        at: new Date(now()).toISOString(),
      });
    }

    if (!response.ok) {
      // F44: read the WHOLE body. No slice(), no substring(), no cap.
      const hostMessage = redactSecrets(await readBodyText(response), [token]);
      const rule = classifyStatus(response.status);
      throw new FxError({
        phase: rule.phase,
        httpStatus: response.status,
        hostMessage,
        messageKey: rule.key,
        retryable: rule.retryable,
        retryAfterMs: parseRetryAfter(response.headers.get('Retry-After'), now()),
        at: new Date(now()).toISOString(),
      });
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new FxError({
        phase: 'parse',
        httpStatus: response.status,
        hostMessage: redactSecrets(`response was not valid JSON: ${describeCause(cause)}`, [token]),
        messageKey: 'fx.err.parse',
        retryable: false,
        retryAfterMs: null,
        at: new Date(now()).toISOString(),
      });
    }
  }

  async function request<T>(path: string, options: FxRequestOptions = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await once<T>(path, options);
      } catch (cause) {
        if (!(cause instanceof FxError)) throw cause;
        if (!options.retry) throw cause;
        if (!canRetryFrom(cause.phase, cause.httpStatus)) throw cause;
        if (attempt >= maxAttempts(cause.phase, cause.httpStatus)) throw cause;
        await sleep(backoffDelayMs(attempt, cause.retryAfterMs, { random: deps.random }));
      }
    }
  }

  return { request, href, baseUrl };
}

/** §5.1(8)/D4: the dashboard is same-origin only; refuse anything else. */
function normaliseBase(baseUrl: string): string {
  if (baseUrl === '') return '';
  let origin: string;
  try {
    origin = new URL(baseUrl, currentOrigin()).origin;
  } catch {
    throw new Error(`fx: unusable base URL ${redactSecrets(baseUrl)}`);
  }
  if (origin !== currentOrigin()) {
    throw new Error(`fx: cross-origin base refused (${origin}); Explorer is same-origin only`);
  }
  return origin;
}

function currentOrigin(): string {
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') return location.origin;
  return 'http://localhost';
}

function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
