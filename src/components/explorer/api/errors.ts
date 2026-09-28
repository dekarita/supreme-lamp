/**
 * F45 S3 — Explorer §5.2: HTTP → F44 phase → UI mapping.
 *
 * Rules carried from F44 and re-stated by the F45 ledger ("§8 retry sketch
 * permits too much: §5.2 plus brief require 401/403/413/415 fail-fast and
 * transient-only retries, including full untruncated host messages"):
 *   - 401 / 403 / 413 / 415 are FAIL-FAST. Never retried.
 *   - 429 / 502 / 504 (and any other 5xx) are transient and retryable.
 *   - `hostMessage` is the host's own text, complete. No summary, no ellipsis,
 *     no length cap — that is the whole point of F44.
 *
 * Documented deltas from the plan (both are gaps in §5.2, not relaxations):
 *   - 400 (bad op) and 409 (concurrent scan) have no §5.2 row. Both are
 *     contract failures, so they map to the non-retryable `parse` phase and the
 *     existing `fx.err.parse` key rather than inventing an i18n key before S10.
 *   - §5.2 writes 504's phase as "tcp/tls/dns", which is not one UploadPhase.
 *     An HTTP 504 is mapped to `tcp`; a request that produced NO HTTP response
 *     at all (fetch rejected) is mapped to `dns`. Both are transient, so retry
 *     behaviour is identical — the split is presentational only.
 */
import type { UploadPhase } from '../data/schema';

/** Exactly the `fx.err.*` keys enumerated by Explorer §9. S10 must not add more. */
export type FxErrorKey =
  | 'fx.err.auth'
  | 'fx.err.forbidden'
  | 'fx.err.notFound'
  | 'fx.err.tooLarge'
  | 'fx.err.type'
  | 'fx.err.rateLimit'
  | 'fx.err.hostBadGateway'
  | 'fx.err.hostTimeout'
  | 'fx.err.parse';

export interface FxErrorFields {
  /** F44 phase. Null-safe: `dns` when no HTTP response was received. */
  phase: UploadPhase;
  /** Null when the transport failed before any status line arrived. */
  httpStatus: number | null;
  /** Complete host text; F44 forbids truncation anywhere downstream. */
  hostMessage: string;
  messageKey: FxErrorKey;
  retryable: boolean;
  /** Parsed `Retry-After` in ms, or null when absent/unparsable. */
  retryAfterMs: number | null;
  /** ISO timestamp of classification. */
  at: string;
}

/** Fail-fast statuses: one attempt, no retry, surface the host message. */
export const FAIL_FAST_HTTP: readonly number[] = [401, 403, 413, 415];

interface StatusRule {
  phase: UploadPhase;
  key: FxErrorKey;
  retryable: boolean;
}

/** Explorer §5.2 verbatim, plus the two documented gap rows. */
const STATUS_RULES: Readonly<Record<number, StatusRule>> = {
  400: { phase: 'parse', key: 'fx.err.parse', retryable: false },
  401: { phase: 'auth', key: 'fx.err.auth', retryable: false },
  403: { phase: 'auth', key: 'fx.err.forbidden', retryable: false },
  404: { phase: 'parse', key: 'fx.err.notFound', retryable: false },
  409: { phase: 'parse', key: 'fx.err.parse', retryable: false },
  413: { phase: 'size', key: 'fx.err.tooLarge', retryable: false },
  415: { phase: 'type', key: 'fx.err.type', retryable: false },
  429: { phase: 'http', key: 'fx.err.rateLimit', retryable: true },
  500: { phase: 'parse', key: 'fx.err.parse', retryable: false },
  502: { phase: 'http', key: 'fx.err.hostBadGateway', retryable: true },
  504: { phase: 'tcp', key: 'fx.err.hostTimeout', retryable: true },
};

export function isFailFastStatus(httpStatus: number | null | undefined): boolean {
  return httpStatus != null && FAIL_FAST_HTTP.includes(httpStatus);
}

/** Classify an HTTP status. Unmapped 5xx retry; unmapped 4xx fail fast. */
export function classifyStatus(httpStatus: number): StatusRule {
  const known = STATUS_RULES[httpStatus];
  if (known) return known;
  if (httpStatus >= 500) return { phase: 'http', key: 'fx.err.hostBadGateway', retryable: true };
  return { phase: 'parse', key: 'fx.err.parse', retryable: false };
}

/** `Retry-After`: integer seconds or an HTTP-date. Anything else is ignored. */
export function parseRetryAfter(headerValue: string | null, nowMs: number): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

/** Redacts the dash token and any obvious credential parameter from text. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('***REDACTED***');
  }
  return out.replace(/((?:dash[-_]?token|token|key|authorization)=)[^&\s"']+/gi, '$1***REDACTED***');
}

/** Thrown for every non-2xx response and every transport failure. */
export class FxError extends Error implements FxErrorFields {
  readonly phase: UploadPhase;
  readonly httpStatus: number | null;
  readonly hostMessage: string;
  readonly messageKey: FxErrorKey;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly at: string;

  constructor(fields: FxErrorFields) {
    // F44: the message the operator sees is the host's own text, untruncated.
    super(fields.hostMessage || fields.messageKey);
    this.name = 'FxError';
    this.phase = fields.phase;
    this.httpStatus = fields.httpStatus;
    this.hostMessage = fields.hostMessage;
    this.messageKey = fields.messageKey;
    this.retryable = fields.retryable;
    this.retryAfterMs = fields.retryAfterMs;
    this.at = fields.at;
  }

  /** Never a plain object dump: keeps the token out of any logged error. */
  toJSON(): FxErrorFields {
    return {
      phase: this.phase,
      httpStatus: this.httpStatus,
      hostMessage: this.hostMessage,
      messageKey: this.messageKey,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      at: this.at,
    };
  }
}
