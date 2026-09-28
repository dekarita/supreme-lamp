/**
 * F45 S3 — Explorer §8.2 retry policy, table-driven over EVERY phase × HTTP
 * combination. The expected columns are derived from the plan text (§5.2 +
 * §8.2 as corrected by the F45 ledger), not from the implementation, so a
 * change to retryPolicy.ts cannot silently re-define its own contract.
 */
import { describe, expect, it } from 'vitest';
import type { UploadPhase, UploadState } from '@/components/explorer/data/schema';
import {
  attemptsRemaining,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FLOOR_MS,
  backoffDelayMs,
  canRetry,
  canRetryFrom,
  MAX_TRANSIENT_ATTEMPTS,
  maxAttempts,
  RETRY_AFTER_CAP_MS,
  shouldRetryNow,
  TRANSIENT_PHASES,
} from '@/components/explorer/api/retryPolicy';
import { classifyStatus, FAIL_FAST_HTTP, parseRetryAfter } from '@/components/explorer/api/errors';

const PHASES: UploadPhase[] = ['dns', 'tcp', 'tls', 'encrypt', 'size', 'type', 'auth', 'http', 'parse'];
const STATUSES: (number | undefined)[] = [undefined, 400, 401, 403, 404, 409, 413, 415, 418, 429, 500, 502, 503, 504];

// --- expectations transcribed from the plan, independent of the code ---------
const SPEC_FAIL_FAST = new Set([401, 403, 413, 415]); // §5.2 + ledger
const SPEC_TRANSIENT = new Set<UploadPhase>(['dns', 'tcp', 'tls', 'http']); // §8.2
const specCanRetry = (phase: UploadPhase, status?: number) =>
  !(status !== undefined && SPEC_FAIL_FAST.has(status)) && SPEC_TRANSIENT.has(phase);
const specMaxAttempts = (phase: UploadPhase, status?: number) =>
  status !== undefined && SPEC_FAIL_FAST.has(status) ? 1 : SPEC_TRANSIENT.has(phase) ? 5 : 1;

const CASES = PHASES.flatMap((phase) => STATUSES.map((status) => ({ phase, status })));

const failed = (phase: UploadPhase, httpStatus?: number, retries = 0): UploadState => ({
  phase,
  status: 'failed',
  retries,
  lastError: { phase, ...(httpStatus === undefined ? {} : { httpStatus }), hostMessage: 'host said no', at: '2026-09-28T00:00:00.000Z' },
  bytesSent: 0,
});

describe('F45 S3 retry policy — full phase × HTTP matrix', () => {
  it('covers every combination (9 phases × 14 statuses = 126)', () => {
    expect(CASES).toHaveLength(PHASES.length * STATUSES.length);
    expect(CASES).toHaveLength(126);
  });

  it.each(CASES)('canRetryFrom($phase, $status)', ({ phase, status }) => {
    expect(canRetryFrom(phase, status)).toBe(specCanRetry(phase, status));
  });

  it.each(CASES)('maxAttempts($phase, $status)', ({ phase, status }) => {
    expect(maxAttempts(phase, status)).toBe(specMaxAttempts(phase, status));
  });

  it.each(CASES)('canRetry(state) matches the §8.2 sketch for $phase/$status', ({ phase, status }) => {
    expect(canRetry(failed(phase, status))).toBe(specCanRetry(phase, status));
  });

  it('pins the fail-fast set required by §5.2 and the ledger (401 included)', () => {
    expect([...FAIL_FAST_HTTP].sort((a, b) => a - b)).toEqual([401, 403, 413, 415]);
    for (const status of [401, 403, 413, 415]) {
      for (const phase of PHASES) {
        expect(canRetryFrom(phase, status), `${phase}/${status} must fail fast`).toBe(false);
        expect(maxAttempts(phase, status), `${phase}/${status} gets one attempt`).toBe(1);
      }
    }
  });

  it('never retries a non-transient phase, whatever the status', () => {
    for (const phase of ['encrypt', 'size', 'type', 'auth', 'parse'] as UploadPhase[]) {
      for (const status of STATUSES) {
        expect(canRetryFrom(phase, status), `${phase}/${status}`).toBe(false);
        expect(maxAttempts(phase, status), `${phase}/${status}`).toBe(1);
      }
    }
  });

  it('retries only transient phases on transient statuses', () => {
    for (const phase of ['dns', 'tcp', 'tls', 'http'] as UploadPhase[]) {
      for (const status of [429, 502, 503, 504, undefined]) {
        expect(canRetryFrom(phase, status), `${phase}/${status}`).toBe(true);
        expect(maxAttempts(phase, status), `${phase}/${status}`).toBe(MAX_TRANSIENT_ATTEMPTS);
      }
    }
    expect([...TRANSIENT_PHASES]).toEqual(['dns', 'tcp', 'tls', 'http']);
  });
});

describe('F45 S3 retry policy — attempt budget', () => {
  it('does not retry a state that has not failed', () => {
    expect(canRetry({ phase: 'http', status: 'uploading', retries: 0, lastError: null, bytesSent: 10 })).toBe(false);
    expect(canRetry({ phase: null, status: 'idle', retries: 0, lastError: null, bytesSent: 0 })).toBe(false);
    // failed but with no recorded error: nothing to classify, so no retry.
    expect(canRetry({ phase: 'http', status: 'failed', retries: 0, lastError: null, bytesSent: 0 })).toBe(false);
  });

  it('stops after the transient budget is spent', () => {
    expect(shouldRetryNow(failed('tcp', 504, 0))).toBe(true);
    expect(shouldRetryNow(failed('tcp', 504, 3))).toBe(true);
    expect(shouldRetryNow(failed('tcp', 504, 4))).toBe(false); // 5 attempts used
    expect(attemptsRemaining(failed('tcp', 504, 0))).toBe(4);
    expect(attemptsRemaining(failed('tcp', 504, 4))).toBe(0);
    expect(shouldRetryNow(failed('size', 413, 0))).toBe(false);
    expect(attemptsRemaining(failed('size', 413, 0))).toBe(0);
  });
});

describe('F45 S3 retry policy — jittered backoff', () => {
  it('stays inside [floor, cap] for every attempt and jitter value', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      for (const random of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = backoffDelayMs(attempt, null, { random: () => random });
        expect(delay).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
        expect(delay).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      }
    }
  });

  it('grows exponentially from the base and saturates at the cap', () => {
    const at = (attempt: number) => backoffDelayMs(attempt, null, { random: () => 1 });
    expect(at(0)).toBe(BACKOFF_BASE_MS);
    expect(at(1)).toBe(BACKOFF_BASE_MS * 2);
    expect(at(2)).toBe(BACKOFF_BASE_MS * 4);
    expect(at(4)).toBe(BACKOFF_CAP_MS);
    expect(at(9)).toBe(BACKOFF_CAP_MS);
  });

  it('treats Retry-After as a floor and caps an absurd value', () => {
    expect(backoffDelayMs(0, 3000, { random: () => 0 })).toBe(3000);
    expect(backoffDelayMs(5, 3000, { random: () => 1 })).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(0, RETRY_AFTER_CAP_MS + 60000, { random: () => 0 })).toBe(RETRY_AFTER_CAP_MS);
    expect(backoffDelayMs(0, -5, { random: () => 0 })).toBe(BACKOFF_FLOOR_MS);
  });

  it('survives a broken RNG without producing NaN or a negative delay', () => {
    for (const bad of [NaN, Infinity, -1, 2]) {
      const delay = backoffDelayMs(1, null, { random: () => bad });
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
      expect(delay).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    }
  });
});

describe('F45 S3 error classification — §5.2 rows', () => {
  const rows: Array<[number, UploadPhase, boolean]> = [
    [400, 'parse', false],
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'parse', false],
    [409, 'parse', false],
    [413, 'size', false],
    [415, 'type', false],
    [429, 'http', true],
    [500, 'parse', false],
    [502, 'http', true],
    [504, 'tcp', true],
  ];
  it.each(rows)('HTTP %s -> phase %s, retryable %s', (status, phase, retryable) => {
    const rule = classifyStatus(status);
    expect(rule.phase).toBe(phase);
    expect(rule.retryable).toBe(retryable);
    expect(canRetryFrom(rule.phase, status)).toBe(retryable);
  });

  it('retries unmapped 5xx and fails fast on unmapped 4xx', () => {
    expect(classifyStatus(503)).toEqual({ phase: 'http', key: 'fx.err.hostBadGateway', retryable: true });
    expect(classifyStatus(418)).toEqual({ phase: 'parse', key: 'fx.err.parse', retryable: false });
  });

  it('parses Retry-After in seconds and as an HTTP-date', () => {
    const now = Date.parse('2026-09-28T00:00:00.000Z');
    expect(parseRetryAfter('1', now)).toBe(1000);
    expect(parseRetryAfter('120', now)).toBe(120000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now)).toBeGreaterThan(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0);
  });
});
